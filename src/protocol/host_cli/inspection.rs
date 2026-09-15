//! Read-only native setup checks; source and compiler execution stay outside doctor.

use std::{collections::BTreeSet, path::Path};

use anyhow::{Context, Result, ensure};

use crate::{
    limits::MAX_FILES,
    path::RepoPath,
    policy::{ConfigView, NativeProvider, PolicySnapshot},
    source::git::GitRepository,
};

use super::{
    CheckArgs, CheckComparison, HostSelection, ProviderProfile, WorkspaceRoot, is_python,
    native_capture_plan, selected_roots,
    selection::{context_filename, has_context_file, is_tsconfig_name, project_context_from_paths},
};

pub(crate) fn inspect_native_projects(
    repository: &GitRepository,
    policy: &PolicySnapshot,
) -> Vec<(NativeProvider, Result<String>)> {
    policy
        .policy
        .native
        .iter()
        .map(|provider| {
            let profile = match provider {
                NativeProvider::RustNative => ProviderProfile::RustNative,
                NativeProvider::NodeNative => ProviderProfile::NodeNative,
                NativeProvider::PythonNative => ProviderProfile::PythonNative,
            };
            (*provider, inspect_project(repository, policy, profile))
        })
        .collect()
}

fn inspect_project(
    repository: &GitRepository,
    policy: &PolicySnapshot,
    profile: ProviderProfile,
) -> Result<String> {
    let initial = HostSelection {
        profiles: vec![profile],
        roots: selected_roots(&[])?,
        excluded_roots: Vec::new(),
        skip_inapplicable: false,
        comparison: CheckComparison::All,
    };
    let selected = initial.for_profile(profile, &CheckArgs::default(), policy)?;
    ensure!(
        !selected.roots.is_empty(),
        "all configured project roots are excluded"
    );
    let plan = native_capture_plan(repository, &policy.view, &selected, &policy.policy.targets)?;
    let paths = repository.native_candidate_paths_from(&policy.view, &plan.roots, plan.filter)?;
    ensure!(
        paths.len() <= MAX_FILES,
        "native project exceeds {MAX_FILES} captured input paths"
    );
    let mut controls = BTreeSet::new();
    let mut interpreters = Vec::new();
    for root in &selected.roots {
        controls.extend(required_controls(&paths, root, profile)?);
        if profile == ProviderProfile::PythonNative {
            let context = project_context_from_paths(&paths, root, profile);
            interpreters.push(inspect_python_interpreter(repository.root(), &context)?);
        }
    }
    inspect_controls(repository, &policy.view, &controls)?;
    ensure!(
        policy.is_current()?,
        "configuration changed during project inspection; rerun doctor"
    );
    Ok(project_summary(&selected.roots, &interpreters))
}

fn project_summary(roots: &[WorkspaceRoot], interpreters: &[String]) -> String {
    let roots = roots
        .iter()
        .map(|root| root.label.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let environment = if interpreters.is_empty() {
        String::new()
    } else {
        format!("; Python interpreters: {}", interpreters.join(", "))
    };
    format!(
        "project inputs present for {roots}{environment}; setup inspection only, run the workflow to verify dependencies and checker configuration"
    )
}

fn inspect_python_interpreter(repository_root: &Path, context: &WorkspaceRoot) -> Result<String> {
    let selected = super::project_python_override(repository_root, context.prefix.as_ref());
    let selected = match selected {
        Some(selected) => Some(selected),
        None => crate::protocol::native::python_runtime_selection().map_err(anyhow::Error::msg)?,
    };
    let (path, source) = selected.with_context(|| {
        format!(
            "{} requires a Python interpreter; select OPCORE_PYTHON, a project .venv, or Python on PATH",
            context.label
        )
    })?;
    let metadata = path
        .metadata()
        .with_context(|| format!("inspect Python interpreter {}", path.display()))?;
    ensure!(
        path.is_absolute() && metadata.is_file(),
        "selected Python interpreter must be an absolute regular file: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        ensure!(
            metadata.permissions().mode() & 0o111 != 0,
            "selected Python interpreter is not executable: {}",
            path.display()
        );
    }
    Ok(format!("{}={} ({source})", context.label, path.display()))
}

fn required_controls(
    paths: &BTreeSet<RepoPath>,
    root: &WorkspaceRoot,
    profile: ProviderProfile,
) -> Result<BTreeSet<RepoPath>> {
    let context = project_context_from_paths(paths, root, profile);
    let controls = match profile {
        ProviderProfile::RustNative => {
            ensure!(
                has_context_file(paths, root, b"Cargo.toml"),
                "{} requires Cargo.toml",
                root.label
            );
            paths
                .iter()
                .filter(|path| context_filename(path, root) == Some(b"Cargo.toml"))
                .cloned()
                .collect()
        }
        ProviderProfile::NodeNative => node_controls(paths, &context)?,
        ProviderProfile::PythonNative => {
            ensure!(
                paths.iter().any(|path| {
                    is_python(path) && super::selection::path_in_workspace_root(path, &context)
                }),
                "{} contains no Python source",
                root.label
            );
            paths
                .iter()
                .filter(|path| {
                    context_filename(path, &context)
                        .is_some_and(|name| super::selection::provider_context_file(profile, name))
                })
                .cloned()
                .collect()
        }
        ProviderProfile::Fast => anyhow::bail!("Fast has no native project prerequisites"),
    };
    Ok(controls)
}

fn node_controls(
    paths: &BTreeSet<RepoPath>,
    context: &WorkspaceRoot,
) -> Result<BTreeSet<RepoPath>> {
    for (present, required) in [
        (
            has_context_file(paths, context, b"package.json"),
            "package.json",
        ),
        (
            has_context_file(paths, context, b"package-lock.json")
                || has_context_file(paths, context, b"npm-shrinkwrap.json"),
            "an npm lockfile",
        ),
        (
            paths
                .iter()
                .any(|path| context_filename(path, context).is_some_and(is_tsconfig_name)),
            "tsconfig.json or tsconfig.*.json",
        ),
    ] {
        ensure!(
            present,
            "{} requires {required} for node-native",
            context.label
        );
    }
    Ok(paths
        .iter()
        .filter(|path| {
            context_filename(path, context).is_some_and(|name| {
                super::selection::provider_context_file(ProviderProfile::NodeNative, name)
            })
        })
        .cloned()
        .collect())
}

fn inspect_controls(
    repository: &GitRepository,
    view: &ConfigView,
    paths: &BTreeSet<RepoPath>,
) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let capture = match view {
        ConfigView::Worktree => repository.capture_auxiliary(paths)?,
        ConfigView::Index => repository.capture_staged_auxiliary(paths)?,
        ConfigView::Tree(reference) => repository.capture_tree_auxiliary(paths, reference, None)?,
    };
    for path in paths {
        capture
            .paths
            .get(path)
            .and_then(|state| state.after.as_ref())
            .with_context(|| {
                format!("required project control file {path} is missing or is not a regular file")
            })?;
    }
    ensure!(
        repository.is_auxiliary_current(&capture)?,
        "project controls changed during inspection; rerun doctor"
    );
    Ok(())
}
