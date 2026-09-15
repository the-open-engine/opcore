//! Provider roots, captured project context, and literal target selection.

use super::{
    BTreeSet, CheckArgs, CheckProvider, Context, Decision, GitNativeCapture, HostReport,
    HostSelection, PolicySnapshot, ProviderProfile, RepoPath, Result, TargetPolicy, WorkspaceRoot,
    skipped_run,
};

impl HostSelection {
    pub(super) fn for_profile(
        &self,
        profile: ProviderProfile,
        args: &CheckArgs,
        policy: &PolicySnapshot,
    ) -> Result<Self> {
        let configured = match profile {
            ProviderProfile::Fast => None,
            ProviderProfile::RustNative => Some(&policy.policy.providers.rust_native.roots),
            ProviderProfile::NodeNative => Some(&policy.policy.providers.node_native.roots),
            ProviderProfile::PythonNative => Some(&policy.policy.providers.python_native.roots),
        };
        let roots = if args.roots.is_empty() {
            configured.map_or_else(
                || Ok(self.roots.clone()),
                |roots| {
                    anyhow::ensure!(
                        !roots.is_empty(),
                        "{} roots is empty; select a project root or remove the provider from this workflow",
                        profile.provider_id()
                    );
                    selected_roots(roots)
                },
            )?
        } else {
            self.roots.clone()
        };
        let (excluded_roots, roots) = roots.into_iter().partition(|root: &WorkspaceRoot| {
            root.prefix.as_ref().is_some_and(|prefix| {
                policy
                    .policy
                    .targets
                    .exclude
                    .iter()
                    .any(|excluded| path_has_prefix(prefix.as_bytes(), excluded.as_bytes()))
            })
        });
        Ok(Self {
            profiles: vec![profile],
            roots,
            excluded_roots,
            skip_inapplicable: self.skip_inapplicable,
            comparison: self.comparison,
        })
    }
}

pub(super) fn excluded_report(
    policy: &PolicySnapshot,
    selection: &HostSelection,
    profile: ProviderProfile,
) -> HostReport {
    HostReport {
        decision: Decision::Indeterminate,
        changeset_digest: String::new(),
        root_digests: Vec::new(),
        capture_valid_as_of: String::new(),
        policy_digest: policy.digest.clone(),
        comparison: selection.comparison,
        runs: selection
            .excluded_roots
            .iter()
            .map(|root| {
                skipped_run(
                    root.label.clone(),
                    root.label.clone(),
                    profile,
                    "excluded by targets.exclude",
                )
            })
            .collect(),
    }
}

pub(super) fn validate_native_exclusions(
    paths: &BTreeSet<RepoPath>,
    selection: &HostSelection,
    targets: &TargetPolicy,
) -> Result<()> {
    if !selection.profiles.iter().any(|profile| profile.is_native()) {
        return Ok(());
    }
    for excluded in &targets.exclude {
        let affected = paths.iter().find(|path| {
            path_has_prefix(path.as_bytes(), excluded.as_bytes())
                && selection
                    .roots
                    .iter()
                    .any(|root| path_in_workspace_root(path, root))
        });
        anyhow::ensure!(
            affected.is_none(),
            concat!(
                "native project contains excluded input {}; the compiler requires its complete project context. ",
                "Select separate projects with providers.<name>.roots or configure the compiler's own source selection"
            ),
            affected.map_or_else(String::new, ToString::to_string)
        );
    }
    Ok(())
}

pub(super) fn selected_profiles(args: &CheckArgs) -> Result<(Vec<ProviderProfile>, bool)> {
    if args.native {
        return Ok((
            vec![ProviderProfile::Fast, ProviderProfile::RustNative],
            true,
        ));
    }
    if args.providers.is_empty() {
        return Ok((vec![ProviderProfile::Fast], false));
    }
    let all = args.providers.contains(&CheckProvider::All);
    anyhow::ensure!(
        !all || args.providers.len() == 1,
        "--providers all cannot be combined with another provider"
    );
    if all {
        return Ok((ProviderProfile::ALL.to_vec(), true));
    }
    let mut profiles = Vec::new();
    for selection in &args.providers {
        let profile = selection
            .profile()
            .context("provider selection unexpectedly omitted its profile")?;
        if !profiles.contains(&profile) {
            profiles.push(profile);
        }
    }
    Ok((profiles, false))
}

pub(super) fn selected_roots(values: &[String]) -> Result<Vec<WorkspaceRoot>> {
    if values.is_empty() {
        return Ok(vec![WorkspaceRoot {
            label: ".".into(),
            prefix: None,
        }]);
    }
    let mut roots = Vec::new();
    for value in values {
        let normalized = value.trim_end_matches('/');
        let root = if normalized == "." {
            WorkspaceRoot {
                label: ".".into(),
                prefix: None,
            }
        } else {
            let prefix = RepoPath::from_protocol(normalized)
                .with_context(|| format!("validate selected root {value}"))?;
            WorkspaceRoot {
                label: prefix.to_string(),
                prefix: Some(prefix),
            }
        };
        anyhow::ensure!(
            !roots.iter().any(|existing| roots_overlap(existing, &root)),
            "selected roots overlap at {}",
            root.label
        );
        roots.push(root);
    }
    Ok(roots)
}

pub(super) fn roots_overlap(left: &WorkspaceRoot, right: &WorkspaceRoot) -> bool {
    match (&left.prefix, &right.prefix) {
        (None, _) | (_, None) => true,
        (Some(left), Some(right)) => {
            path_has_prefix(left.as_bytes(), right.as_bytes())
                || path_has_prefix(right.as_bytes(), left.as_bytes())
        }
    }
}

pub(super) fn rebase_path(path: &RepoPath, root: &WorkspaceRoot) -> Option<RepoPath> {
    let Some(prefix) = &root.prefix else {
        return Some(path.clone());
    };
    let suffix = path.as_bytes().strip_prefix(prefix.as_bytes())?;
    let suffix = suffix.strip_prefix(b"/")?;
    RepoPath::new(suffix.to_vec()).ok()
}

pub(super) fn project_context(
    capture: &GitNativeCapture,
    root: &WorkspaceRoot,
    profile: ProviderProfile,
) -> WorkspaceRoot {
    project_context_from_paths(&capture.paths.keys().cloned().collect(), root, profile)
}

pub(super) fn project_context_from_paths(
    paths: &BTreeSet<RepoPath>,
    root: &WorkspaceRoot,
    profile: ProviderProfile,
) -> WorkspaceRoot {
    match profile {
        ProviderProfile::NodeNative => ancestor_roots(root)
            .into_iter()
            .find(|candidate| node_context(paths, candidate))
            .unwrap_or_else(|| root.clone()),
        ProviderProfile::PythonNative => ancestor_roots(root)
            .into_iter()
            .find(|candidate| python_context(paths, candidate))
            .unwrap_or_else(|| root.clone()),
        ProviderProfile::RustNative => WorkspaceRoot {
            label: ".".into(),
            prefix: None,
        },
        ProviderProfile::Fast => root.clone(),
    }
}

pub(super) fn project_capture_roots(
    paths: &BTreeSet<RepoPath>,
    selection: &HostSelection,
) -> Vec<RepoPath> {
    let mut roots = Vec::new();
    for profile in &selection.profiles {
        for root in &selection.roots {
            let context = if *profile == ProviderProfile::RustNative {
                root.clone()
            } else {
                project_context_from_paths(paths, root, *profile)
            };
            let Some(prefix) = context.prefix else {
                return Vec::new();
            };
            roots.push(prefix);
        }
    }
    roots.sort();
    roots.dedup();
    let mut minimal: Vec<RepoPath> = Vec::new();
    for root in roots {
        if minimal
            .iter()
            .all(|parent| !path_has_prefix(root.as_bytes(), parent.as_bytes()))
        {
            minimal.push(root);
        }
    }
    minimal
}

pub(super) fn ancestor_roots(root: &WorkspaceRoot) -> Vec<WorkspaceRoot> {
    let Some(prefix) = &root.prefix else {
        return vec![root.clone()];
    };
    let mut candidates = Vec::new();
    let mut current = prefix.as_bytes();
    loop {
        candidates.push(WorkspaceRoot {
            label: String::from_utf8_lossy(current).into_owned(),
            prefix: RepoPath::new(current.to_vec()).ok(),
        });
        let Some(index) = current.iter().rposition(|byte| *byte == b'/') else {
            break;
        };
        current = &current[..index];
    }
    candidates.push(WorkspaceRoot {
        label: ".".into(),
        prefix: None,
    });
    candidates
}

pub(super) fn node_context(paths: &BTreeSet<RepoPath>, root: &WorkspaceRoot) -> bool {
    has_context_file(paths, root, b"package.json")
        && (has_context_file(paths, root, b"package-lock.json")
            || has_context_file(paths, root, b"npm-shrinkwrap.json"))
        && paths
            .iter()
            .any(|path| context_filename(path, root).is_some_and(is_tsconfig_name))
}

pub(super) fn python_context(paths: &BTreeSet<RepoPath>, root: &WorkspaceRoot) -> bool {
    [
        b"pyproject.toml".as_slice(),
        b"pyrightconfig.json",
        b"mypy.ini",
        b"setup.cfg",
        b"tox.ini",
    ]
    .iter()
    .any(|name| has_context_file(paths, root, name))
}

pub(super) fn has_context_file(
    paths: &BTreeSet<RepoPath>,
    root: &WorkspaceRoot,
    name: &[u8],
) -> bool {
    paths
        .iter()
        .any(|path| context_filename(path, root) == Some(name))
}

pub(super) fn context_filename<'a>(path: &'a RepoPath, root: &WorkspaceRoot) -> Option<&'a [u8]> {
    let bytes = path.as_bytes();
    match &root.prefix {
        Some(prefix) => bytes
            .strip_prefix(prefix.as_bytes())?
            .strip_prefix(b"/")
            .filter(|suffix| !suffix.contains(&b'/')),
        None => (!bytes.contains(&b'/')).then_some(bytes),
    }
}

pub(super) fn is_tsconfig_name(name: &[u8]) -> bool {
    name == b"tsconfig.json" || (name.starts_with(b"tsconfig.") && name.ends_with(b".json"))
}

pub(super) fn workspace_mapping(
    capture: &GitNativeCapture,
    focus: &WorkspaceRoot,
    context: &WorkspaceRoot,
    profile: ProviderProfile,
) -> Result<std::collections::BTreeMap<RepoPath, RepoPath>> {
    let mut mapping = std::collections::BTreeMap::new();
    let mut destinations = BTreeSet::new();
    for path in capture.paths.keys() {
        let include = (profile.is_native() && path_in_workspace_root(path, context))
            || path_in_workspace_root(path, focus)
            || context_filename(path, context)
                .is_some_and(|name| provider_context_file(profile, name));
        if !include {
            continue;
        }
        let destination = rebase_path(path, context)
            .with_context(|| format!("map {path} into project context {}", context.label))?;
        anyhow::ensure!(
            destinations.insert(destination.clone()),
            "project context maps multiple files onto {destination}"
        );
        mapping.insert(path.clone(), destination);
    }
    Ok(mapping)
}

pub(super) fn relative_root(root: &WorkspaceRoot, context: &WorkspaceRoot) -> Option<RepoPath> {
    match (&root.prefix, &context.prefix) {
        (Some(root), None) => Some(root.clone()),
        (Some(root), Some(context)) if root != context => root
            .as_bytes()
            .strip_prefix(context.as_bytes())?
            .strip_prefix(b"/")
            .and_then(|path| RepoPath::new(path.to_vec()).ok()),
        _ => None,
    }
}

pub(super) fn path_in_workspace_root(path: &RepoPath, root: &WorkspaceRoot) -> bool {
    root.prefix
        .as_ref()
        .is_none_or(|prefix| path_has_prefix(path.as_bytes(), prefix.as_bytes()))
}

pub(super) fn provider_context_file(profile: ProviderProfile, name: &[u8]) -> bool {
    match profile {
        ProviderProfile::NodeNative => {
            matches!(
                name,
                b"package.json" | b"package-lock.json" | b"npm-shrinkwrap.json" | b".npmrc"
            ) || is_tsconfig_name(name)
        }
        ProviderProfile::PythonNative => matches!(
            name,
            b"pyproject.toml" | b"pyrightconfig.json" | b"mypy.ini" | b"setup.cfg" | b"tox.ini"
        ),
        ProviderProfile::Fast | ProviderProfile::RustNative => false,
    }
}

pub(super) fn path_has_prefix(path: &[u8], prefix: &[u8]) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with(b"/"))
}
