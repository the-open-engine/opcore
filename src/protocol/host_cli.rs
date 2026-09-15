//! Explicit local composition of the bundled ASP check providers.

use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fmt::Write as _,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    limits::MAX_ASSESSMENT_BYTES,
    path::RepoPath,
    policy::{ConfigView, PolicySnapshot, TargetPolicy},
    protocol::{
        asp::ProviderProfile,
        cli::{CheckArgs, CheckComparison, CheckProvider},
        host::{self, HostRequest, HostWorkspace, ProviderCommand},
    },
    source::{
        git::{
            GitNativeCapture, GitRepository, NativeCaptureFilter, NativeCaptureKind,
            NativePathState,
        },
        has_extension,
    },
};

mod inspection;
mod selection;

pub(crate) use inspection::inspect_native_projects;

use selection::{
    excluded_report, is_tsconfig_name, path_has_prefix, project_capture_roots, project_context,
    relative_root, selected_profiles, selected_roots, validate_native_exclusions,
    workspace_mapping,
};

#[cfg(test)]
use selection::rebase_path;

const FAST_WALLCLOCK_MS: u64 = 30_000;
const PYTHON_WALLCLOCK_MS: u64 = 120_000;
const COMPILE_WALLCLOCK_MS: u64 = 300_000;
const MAX_HUMAN_DIAGNOSTICS: usize = 50;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Decision {
    Allow,
    Deny,
    Indeterminate,
}

impl Decision {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Indeterminate => "indeterminate",
        }
    }
}

struct HostSelection {
    profiles: Vec<ProviderProfile>,
    skip_inapplicable: bool,
    roots: Vec<WorkspaceRoot>,
    excluded_roots: Vec<WorkspaceRoot>,
    comparison: CheckComparison,
}

#[derive(Clone)]
struct WorkspaceRoot {
    label: String,
    prefix: Option<RepoPath>,
}

struct ProviderRun {
    root: String,
    context: String,
    profile: ProviderProfile,
    assessment: Option<Value>,
    failure: Option<String>,
    skipped: Option<String>,
}

struct ProviderRunRequest {
    root: String,
    context: String,
    workspace: HostWorkspace,
    params: Value,
    candidate_root: PathBuf,
    context_root: Option<RepoPath>,
    project_root: Option<RepoPath>,
}

struct PreparedRoot {
    label: String,
    context: String,
    workspace: HostWorkspace,
    params: Value,
    changeset_digest: String,
    candidate_paths: BTreeSet<RepoPath>,
    context_root: Option<RepoPath>,
    project_root: Option<RepoPath>,
}

struct HostReport {
    decision: Decision,
    changeset_digest: String,
    root_digests: Vec<(String, String, String, String)>,
    capture_valid_as_of: String,
    policy_digest: String,
    comparison: CheckComparison,
    runs: Vec<ProviderRun>,
}

/// One provider evaluation with retained source captures for a composed workflow.
pub(crate) struct HostEvaluation {
    pub(crate) report: Value,
    pub(crate) passed: bool,
    pub(crate) human: String,
    captures: Vec<HostCapture>,
    targets: TargetPolicy,
    view: ConfigView,
}

struct HostCapture {
    source: GitNativeCapture,
    selection: HostSelection,
    plan: NativeCapturePlan,
}

impl HostEvaluation {
    pub(crate) fn is_current(&self, repository: &GitRepository) -> Result<bool> {
        let selected = repository.with_targets(&self.targets);
        for capture in &self.captures {
            if !selected.is_native_current(&capture.source)? {
                return Ok(false);
            }
            if !capture.plan.filter.is_fast_only()
                && capture.plan
                    != native_capture_plan(
                        &selected,
                        &self.view,
                        &capture.selection,
                        &self.targets,
                    )?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

pub(super) async fn run(args: CheckArgs, repository: GitRepository) -> Result<()> {
    let evaluation = match stable_report(&args, &repository).await {
        Ok(evaluation) => evaluation,
        Err(error) => {
            emit_host_error(args.json, "evaluation_failed", &error)?;
            return Err(error);
        }
    };
    if args.json {
        println!("{}", serde_json::to_string(&evaluation.report)?);
    } else {
        print!("{}", evaluation.human);
    }
    let decision = match evaluation.report["decision"].as_str() {
        Some("allow") => Decision::Allow,
        Some("deny") => Decision::Deny,
        _ => Decision::Indeterminate,
    };
    enforce(decision, args.advisory)
}

fn emit_host_error(json_output: bool, code: &str, error: &anyhow::Error) -> Result<()> {
    if !json_output {
        return Ok(());
    }
    let rendered = serde_json::to_string(&json!({
        "schema": "opcore.host-check-error.v1",
        "decision": "indeterminate",
        "code": code,
        "message": format!("{error:#}"),
    }))?;
    anyhow::ensure!(
        rendered.len() <= MAX_ASSESSMENT_BYTES,
        "host error report exceeds {MAX_ASSESSMENT_BYTES} bytes"
    );
    println!("{rendered}");
    Ok(())
}

async fn stable_report(args: &CheckArgs, repository: &GitRepository) -> Result<HostEvaluation> {
    for _ in 0..2 {
        let policy = PolicySnapshot::capture(repository, args.config_view(), args.workflow)
            .context("load repository configuration for provider check")?;
        let evaluation = evaluate(args, repository, &policy).await?;
        if evaluation.is_current(repository)? && policy.is_current()? {
            return Ok(evaluation);
        }
    }
    anyhow::bail!("Git source or configuration changed before the provider result was returned")
}

#[derive(Eq, PartialEq)]
struct NativeCapturePlan {
    roots: Vec<RepoPath>,
    filter: NativeCaptureFilter,
}

/// Evaluates selected providers silently with a caller-owned resolved configuration.
pub(crate) async fn evaluate(
    args: &CheckArgs,
    repository: &GitRepository,
    policy: &PolicySnapshot,
) -> Result<HostEvaluation> {
    let selection = HostSelection::from_args(args)?;
    let mut reports = Vec::new();
    let mut captures = Vec::new();
    for profile in &selection.profiles {
        let selected = selection.for_profile(*profile, args, policy)?;
        if selected.roots.is_empty() {
            reports.push(excluded_report(policy, &selected, *profile));
            continue;
        }
        let source = repository.with_targets(&policy.policy.targets);
        let plan = native_capture_plan(&source, &policy.view, &selected, &policy.policy.targets)?;
        let capture = source
            .capture_native_from(&policy.view, args.base.as_deref(), &plan.roots, plan.filter)
            .context("capture immutable provider Git view")?;
        reports.push(evaluate_capture(&capture, policy, repository.root(), &selected).await);
        captures.push(HostCapture {
            source: capture,
            selection: selected,
            plan,
        });
    }
    let report = merge_reports(reports, &selection, &policy.policy.targets);
    let mut value = report_value(&report);
    value["configuration"] = json!({
        "view": policy.view,
        "workflow": policy.workflow,
        "effective": policy.policy,
    });
    anyhow::ensure!(
        serde_json::to_vec(&value)?.len() <= MAX_ASSESSMENT_BYTES,
        "combined provider report exceeds {MAX_ASSESSMENT_BYTES} bytes"
    );
    Ok(HostEvaluation {
        passed: report.decision == Decision::Allow,
        human: render_human(&report),
        report: value,
        captures,
        targets: policy.policy.targets.clone(),
        view: policy.view.clone(),
    })
}

fn merge_reports(
    reports: Vec<HostReport>,
    selection: &HostSelection,
    targets: &TargetPolicy,
) -> HostReport {
    let mut combined = HostReport {
        decision: Decision::Indeterminate,
        changeset_digest: String::new(),
        root_digests: Vec::new(),
        capture_valid_as_of: String::new(),
        policy_digest: String::new(),
        comparison: selection.comparison,
        runs: Vec::new(),
    };
    let mut freshness = Vec::new();
    for report in reports {
        combined.policy_digest = report.policy_digest;
        combined.root_digests.extend(report.root_digests);
        combined.runs.extend(report.runs);
        freshness.push(report.capture_valid_as_of);
    }
    combined.root_digests.sort_by_key(|(root, _, provider, _)| {
        (root.clone(), provider_position(selection, provider))
    });
    combined.runs.sort_by_key(|run| {
        (
            run.root.clone(),
            provider_position(selection, run.profile.provider_id()),
        )
    });
    combined.capture_valid_as_of =
        json!({ "providers": freshness, "targets": targets }).to_string();
    combined.changeset_digest = combined_digest(&combined.root_digests);
    combined.decision = compose_decision(&combined.runs);
    combined
}

fn provider_position(selection: &HostSelection, provider: &str) -> usize {
    selection
        .profiles
        .iter()
        .position(|profile| profile.provider_id() == provider)
        .unwrap_or(usize::MAX)
}

fn native_capture_plan(
    repository: &GitRepository,
    view: &ConfigView,
    selection: &HostSelection,
    targets: &TargetPolicy,
) -> Result<NativeCapturePlan> {
    let roots = capture_roots(selection);
    let base_filter = capture_filter(selection);
    let candidate_paths = repository
        .native_candidate_paths_from(view, &roots, base_filter)
        .context("discover provider Git workspace paths")?;
    if !selection.skip_inapplicable || selection.profiles.contains(&ProviderProfile::Fast) {
        validate_selected_roots(&candidate_paths, selection)?;
    }
    validate_native_exclusions(&candidate_paths, selection, targets)?;
    let rust_applicable = selection.profiles.contains(&ProviderProfile::RustNative)
        && rust_applicable_to_any_root(&candidate_paths, &selection.roots);
    let plan = if rust_applicable {
        NativeCapturePlan {
            roots: Vec::new(),
            filter: base_filter,
        }
    } else {
        NativeCapturePlan {
            roots: project_capture_roots(&candidate_paths, selection),
            filter: base_filter,
        }
    };
    Ok(plan)
}

fn capture_roots(selection: &HostSelection) -> Vec<RepoPath> {
    selection
        .roots
        .iter()
        .filter_map(|root| root.prefix.clone())
        .collect()
}

fn capture_filter(selection: &HostSelection) -> NativeCaptureFilter {
    selection
        .profiles
        .iter()
        .fold(NativeCaptureFilter::empty(), |filter, profile| {
            let kind = match profile {
                ProviderProfile::Fast => NativeCaptureKind::Fast,
                ProviderProfile::RustNative => NativeCaptureKind::Rust,
                ProviderProfile::NodeNative => NativeCaptureKind::Node,
                ProviderProfile::PythonNative => NativeCaptureKind::Python,
            };
            filter.with(kind)
        })
}

fn rust_applicable_to_any_root(paths: &BTreeSet<RepoPath>, roots: &[WorkspaceRoot]) -> bool {
    roots.iter().any(|root| {
        paths.iter().any(|path| {
            if let Some(prefix) = &root.prefix {
                path.as_bytes() == [prefix.as_bytes(), b"/Cargo.toml"].concat()
            } else {
                path.as_bytes() == b"Cargo.toml"
            }
        })
    })
}

impl HostSelection {
    fn from_args(args: &CheckArgs) -> Result<Self> {
        let (profiles, skip_inapplicable) = selected_profiles(args)?;
        let native_selected = profiles
            .iter()
            .any(|profile| *profile != ProviderProfile::Fast);
        anyhow::ensure!(
            !native_selected || args.allow_unsandboxed_native,
            concat!(
                "native checks may execute repository-controlled code with access to host files, ",
                "credentials, and network; rerun with --allow-unsandboxed-native only for a trusted repository"
            )
        );
        anyhow::ensure!(
            native_selected || !args.allow_unsandboxed_native,
            "--allow-unsandboxed-native requires a native provider"
        );
        Ok(Self {
            profiles,
            skip_inapplicable,
            roots: selected_roots(&args.roots)?,
            excluded_roots: Vec::new(),
            comparison: args.comparison.unwrap_or_else(|| {
                if args.all || args.committed || (args.tree.is_some() && args.base.is_none()) {
                    CheckComparison::All
                } else {
                    CheckComparison::Introduced
                }
            }),
        })
    }
}

fn validate_selected_roots(
    candidate_paths: &BTreeSet<RepoPath>,
    selection: &HostSelection,
) -> Result<()> {
    for root in &selection.roots {
        let Some(prefix) = &root.prefix else {
            continue;
        };
        anyhow::ensure!(
            candidate_paths
                .iter()
                .any(|path| path_has_prefix(path.as_bytes(), prefix.as_bytes())),
            "selected root {} contains no files supported by the selected providers",
            root.label
        );
    }
    Ok(())
}

async fn evaluate_capture(
    capture: &GitNativeCapture,
    policy: &PolicySnapshot,
    candidate_root: &std::path::Path,
    selection: &HostSelection,
) -> HostReport {
    let mut runs = selection
        .excluded_roots
        .iter()
        .flat_map(|root| {
            selection.profiles.iter().map(|profile| {
                skipped_run(
                    root.label.clone(),
                    root.label.clone(),
                    *profile,
                    "excluded by targets.exclude",
                )
            })
        })
        .collect::<Vec<_>>();
    let mut root_digests = Vec::new();
    for root in &selection.roots {
        for profile in &selection.profiles {
            let prepared = match host_input(capture, root, *profile, selection.comparison, policy) {
                Ok(prepared) => prepared,
                Err(error) => {
                    runs.push(failed_run(
                        root.label.clone(),
                        root.label.clone(),
                        *profile,
                        error.to_string(),
                    ));
                    continue;
                }
            };
            root_digests.push((
                prepared.label.clone(),
                prepared.context.clone(),
                profile.provider_id().to_owned(),
                prepared.changeset_digest.clone(),
            ));
            run_prepared(&mut runs, prepared, candidate_root, selection, *profile).await;
        }
    }
    let changeset_digest = combined_digest(&root_digests);
    HostReport {
        decision: compose_decision(&runs),
        changeset_digest,
        root_digests,
        capture_valid_as_of: capture.valid_as_of.clone(),
        policy_digest: policy.digest.clone(),
        comparison: selection.comparison,
        runs,
    }
}

async fn run_prepared(
    runs: &mut Vec<ProviderRun>,
    prepared: PreparedRoot,
    candidate_root: &std::path::Path,
    selection: &HostSelection,
    profile: ProviderProfile,
) {
    if selection.skip_inapplicable
        && let Some(reason) = inapplicable_reason(
            profile,
            &prepared.candidate_paths,
            prepared.project_root.as_ref(),
        )
    {
        runs.push(skipped_run(
            prepared.label,
            prepared.context,
            profile,
            reason,
        ));
        return;
    }
    runs.push(
        run_provider(
            profile,
            ProviderRunRequest {
                root: prepared.label,
                context: prepared.context,
                workspace: prepared.workspace,
                params: prepared.params,
                candidate_root: candidate_root.to_path_buf(),
                context_root: prepared.context_root,
                project_root: prepared.project_root,
            },
        )
        .await,
    );
}

fn host_input(
    capture: &GitNativeCapture,
    root: &WorkspaceRoot,
    profile: ProviderProfile,
    comparison: CheckComparison,
    policy: &PolicySnapshot,
) -> Result<PreparedRoot> {
    let context = project_context(capture, root, profile);
    let project_root = (profile == ProviderProfile::RustNative)
        .then(|| relative_root(root, &context))
        .flatten();
    let baseline = json!({ "rev": capture.baseline_rev });
    let mut workspace = HostWorkspace::new(baseline.clone())?;
    let mapping = workspace_mapping(capture, root, &context, profile)?;
    let candidate_paths = populate_workspace(capture, &mapping, &mut workspace)?;
    let changes = root_changes(capture, &mapping, &mut workspace)?;
    let changeset = json!({ "baseline": baseline, "changes": changes });
    let changeset_digest = json_digest(&changeset)?;
    let params = json!({
        "changeset": changeset,
        "scope": "workspace",
        "comparison": comparison.as_str(),
        "configuration": if profile == ProviderProfile::Fast {
            json!({"verify": policy.policy.verify})
        } else {
            json!({})
        }
    });
    Ok(PreparedRoot {
        label: root.label.clone(),
        context: context.label,
        workspace,
        params,
        changeset_digest,
        candidate_paths,
        context_root: context.prefix,
        project_root,
    })
}

fn populate_workspace(
    capture: &GitNativeCapture,
    mapping: &std::collections::BTreeMap<RepoPath, RepoPath>,
    workspace: &mut HostWorkspace,
) -> Result<BTreeSet<RepoPath>> {
    let mut candidate_paths = BTreeSet::new();
    for (original, path) in mapping {
        let state = capture
            .paths
            .get(original)
            .with_context(|| format!("missing captured state for {original}"))?;
        if let Some(blob) = &state.before {
            let id = workspace.add_baseline_file(path.clone(), Arc::clone(&blob.bytes))?;
            anyhow::ensure!(
                id == blob.blob_id,
                "captured baseline blob identity changed"
            );
        }
        if state.after.is_some() {
            candidate_paths.insert(path.clone());
        }
    }
    Ok(candidate_paths)
}

fn root_changes(
    capture: &GitNativeCapture,
    mapping: &std::collections::BTreeMap<RepoPath, RepoPath>,
    workspace: &mut HostWorkspace,
) -> Result<Vec<Value>> {
    let mut changes = Vec::new();
    for path in &capture.changed_paths {
        let Some(rebased) = mapping.get(path) else {
            continue;
        };
        let state = capture
            .paths
            .get(path)
            .with_context(|| format!("missing captured state for {path}"))?;
        changes.push(change_value(rebased, state, workspace)?);
    }
    Ok(changes)
}

fn change_value(
    path: &RepoPath,
    state: &NativePathState,
    workspace: &mut HostWorkspace,
) -> Result<Value> {
    match (&state.before, &state.after) {
        (None, Some(after)) => {
            let id = workspace.add_candidate_blob(Arc::clone(&after.bytes))?;
            Ok(json!({ "path": path, "kind": "create", "after": id }))
        }
        (Some(before), None) => {
            Ok(json!({ "path": path, "kind": "delete", "before": before.blob_id }))
        }
        (Some(before), Some(after)) => {
            let id = workspace.add_candidate_blob(Arc::clone(&after.bytes))?;
            Ok(json!({
                "path": path,
                "kind": "modify",
                "before": before.blob_id,
                "after": id
            }))
        }
        (None, None) => anyhow::bail!("changed path {path} has neither before nor after content"),
    }
}

async fn run_provider(profile: ProviderProfile, request: ProviderRunRequest) -> ProviderRun {
    let ProviderRunRequest {
        root,
        context,
        workspace,
        params,
        candidate_root,
        context_root,
        project_root,
    } = request;
    let result = tokio::task::spawn_blocking(move || {
        let command = provider_command(
            profile,
            project_root.as_ref(),
            &candidate_root,
            context_root.as_ref(),
        )?;
        let request = HostRequest::new(workspace, params)?
            .with_wallclock_ms(provider_wallclock(profile))?
            .with_candidate_root(&candidate_root)?;
        host::evaluate(&command, &request)
    })
    .await;
    match result {
        Ok(Ok(assessment)) => ProviderRun {
            root,
            context,
            profile,
            assessment: Some(assessment),
            failure: None,
            skipped: None,
        },
        Ok(Err(error)) => failed_run(
            root,
            context,
            profile,
            format!("provider failed: {error:#}"),
        ),
        Err(error) => failed_run(
            root,
            context,
            profile,
            format!("provider worker failed: {error}"),
        ),
    }
}

fn provider_command(
    profile: ProviderProfile,
    project_root: Option<&RepoPath>,
    candidate_root: &Path,
    context_root: Option<&RepoPath>,
) -> Result<ProviderCommand> {
    let command = ProviderCommand::current_scoped(profile, project_root)?;
    if profile == ProviderProfile::PythonNative
        && let Some((interpreter, source)) = project_python_override(candidate_root, context_root)
    {
        return Ok(command
            .with_environment("OPCORE_PYTHON", interpreter.into_os_string())
            .with_environment("OPCORE_PYTHON_SOURCE", source));
    }
    Ok(command)
}

fn project_python_override(
    candidate_root: &Path,
    context_root: Option<&RepoPath>,
) -> Option<(PathBuf, &'static str)> {
    if let Some(interpreter) = env::var_os("OPCORE_PYTHON") {
        return Some((PathBuf::from(interpreter), "explicit"));
    }
    let project_root = context_root.map_or_else(
        || candidate_root.to_path_buf(),
        |context| candidate_root.join(context.to_path_buf()),
    );
    let dot_venv = python_venv_interpreter(&project_root.join(".venv"));
    if dot_venv.is_file() {
        return Some((dot_venv, "project-dot-venv"));
    }
    active_project_python(&project_root).map(|active| (active, "active-project-venv"))
}

fn active_project_python(project_root: &Path) -> Option<PathBuf> {
    let environment = PathBuf::from(env::var_os("VIRTUAL_ENV")?);
    if !environment.is_absolute() {
        return None;
    }
    let project_root = project_root.canonicalize().ok()?;
    let environment = environment.canonicalize().ok()?;
    if !environment.starts_with(&project_root) {
        return None;
    }
    let interpreter = python_venv_interpreter(&environment);
    interpreter.is_file().then_some(interpreter)
}

fn python_venv_interpreter(environment: &Path) -> PathBuf {
    if cfg!(windows) {
        environment.join("Scripts/python.exe")
    } else {
        environment.join("bin/python")
    }
}

fn inapplicable_reason(
    profile: ProviderProfile,
    candidate_paths: &BTreeSet<RepoPath>,
    project_root: Option<&RepoPath>,
) -> Option<&'static str> {
    match profile {
        ProviderProfile::RustNative
            if !candidate_paths.iter().any(|path| {
                project_root.map_or_else(
                    || path.as_bytes() == b"Cargo.toml",
                    |root| path.as_bytes() == [root.as_bytes(), b"/Cargo.toml"].concat().as_slice(),
                )
            }) =>
        {
            Some("no root Cargo.toml")
        }
        ProviderProfile::NodeNative if !node_applicable(candidate_paths) => {
            Some("no root locked npm TypeScript project")
        }
        ProviderProfile::PythonNative if !candidate_paths.iter().any(is_python) => {
            Some("no Python source")
        }
        _ => None,
    }
}

fn node_applicable(paths: &BTreeSet<RepoPath>) -> bool {
    has_exact(paths, b"package.json")
        && (has_exact(paths, b"package-lock.json") || has_exact(paths, b"npm-shrinkwrap.json"))
        && paths.iter().any(|path| {
            path.as_bytes()
                .rsplit(|byte| *byte == b'/')
                .next()
                .is_some_and(is_tsconfig_name)
        })
}

fn has_exact(paths: &BTreeSet<RepoPath>, expected: &[u8]) -> bool {
    paths.iter().any(|path| path.as_bytes() == expected)
}

fn is_python(path: &RepoPath) -> bool {
    has_extension(path.as_bytes(), b".py") || has_extension(path.as_bytes(), b".pyi")
}

const fn provider_wallclock(profile: ProviderProfile) -> u64 {
    match profile {
        ProviderProfile::Fast => FAST_WALLCLOCK_MS,
        ProviderProfile::PythonNative => PYTHON_WALLCLOCK_MS,
        ProviderProfile::RustNative | ProviderProfile::NodeNative => COMPILE_WALLCLOCK_MS,
    }
}

fn compose_decision(runs: &[ProviderRun]) -> Decision {
    let evaluated = runs
        .iter()
        .filter(|run| run.skipped.is_none())
        .collect::<Vec<_>>();
    if evaluated.is_empty()
        || evaluated.iter().any(|run| run.failure.is_some())
        || evaluated
            .iter()
            .any(|run| assessment_status(run) != Some("complete"))
        || evaluated.iter().any(|run| assessment_checked_nothing(run))
    {
        return Decision::Indeterminate;
    }
    if evaluated.iter().any(|run| assessment_has_diagnostics(run)) {
        Decision::Deny
    } else {
        Decision::Allow
    }
}

fn assessment_checked_nothing(run: &ProviderRun) -> bool {
    let Some(assessment) = &run.assessment else {
        return true;
    };
    let fast_files = assessment
        .pointer("/evidence/0/data/filesRead")
        .and_then(Value::as_u64);
    let native_files = assessment
        .pointer("/evidence/0/data/candidate/selectedSourceFiles")
        .and_then(Value::as_u64);
    fast_files.or(native_files) == Some(0)
}

fn assessment_status(run: &ProviderRun) -> Option<&str> {
    run.assessment
        .as_ref()?
        .get("status")
        .and_then(Value::as_str)
}

fn assessment_has_diagnostics(run: &ProviderRun) -> bool {
    run.assessment
        .as_ref()
        .and_then(|assessment| assessment.get("diagnostics"))
        .and_then(Value::as_array)
        .is_some_and(|diagnostics| !diagnostics.is_empty())
}

fn failed_run(
    root: String,
    context: String,
    profile: ProviderProfile,
    failure: String,
) -> ProviderRun {
    ProviderRun {
        root,
        context,
        profile,
        assessment: None,
        failure: Some(failure),
        skipped: None,
    }
}

fn skipped_run(
    root: String,
    context: String,
    profile: ProviderProfile,
    reason: &str,
) -> ProviderRun {
    ProviderRun {
        root,
        context,
        profile,
        assessment: None,
        failure: None,
        skipped: Some(reason.to_owned()),
    }
}

fn report_value(report: &HostReport) -> Value {
    let providers = report.runs.iter().map(provider_json).collect::<Vec<_>>();
    let roots = report
        .root_digests
        .iter()
        .map(|(root, context, provider, digest)| {
            json!({
                "root": root,
                "context": context,
                "provider": provider,
                "changesetDigest": digest
            })
        })
        .collect::<Vec<_>>();
    json!({
        "schema": "opcore.host-check.v3",
        "decision": report.decision.as_str(),
        "callSite": "interactive",
        "changesetDigest": report.changeset_digest,
        "workspaces": roots,
        "validAsOf": report.capture_valid_as_of,
        "policyDigest": report.policy_digest,
        "comparison": report.comparison.as_str(),
        "assurance": {
            "mode": "advisory",
            "detail": concat!(
                "provider inputs are content-addressed and native scratch is revalidated; ",
                "OS sandbox enforcement is not included"
            )
        },
        "providers": providers
    })
}

fn provider_json(run: &ProviderRun) -> Value {
    json!({
        "root": run.root,
        "context": run.context,
        "id": run.profile.provider_id(),
        "name": user_provider_name(run.profile),
        "assessment": run.assessment,
        "failure": run.failure,
        "skipped": run.skipped
    })
}

fn render_human(report: &HostReport) -> String {
    let mut output = format!(
        "opcore host: {} ({} comparison; advisory execution boundary)\n",
        report.decision.as_str(),
        report.comparison.as_str()
    );
    for run in &report.runs {
        append_run(&mut output, run);
    }
    output
}

fn append_run(output: &mut String, run: &ProviderRun) {
    let name = user_provider_name(run.profile);
    let label = format!("{} [{name}]", run.root);
    if let Some(reason) = &run.skipped {
        let _ = writeln!(output, "{label}: skipped ({reason})");
        return;
    }
    if let Some(failure) = &run.failure {
        let _ = writeln!(output, "{label}: unavailable: {failure}");
        return;
    }
    let Some(assessment) = &run.assessment else {
        return;
    };
    let status = assessment
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("invalid");
    let diagnostics = assessment
        .get("diagnostics")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let elapsed_ms = assessment
        .pointer("/timing/elapsedMs")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let _ = writeln!(
        output,
        "{label}: {status} ({diagnostics} diagnostics, {elapsed_ms} ms)"
    );
    append_diagnostics(output, assessment, &run.context);
    if status != "complete"
        && let Some(detail) = assessment
            .pointer("/coverage/degraded/0/detail")
            .and_then(Value::as_str)
    {
        let _ = writeln!(output, "  detail: {detail}");
    }
}

fn append_diagnostics(output: &mut String, assessment: &Value, context: &str) {
    let Some(diagnostics) = assessment.get("diagnostics").and_then(Value::as_array) else {
        return;
    };
    if diagnostics.len() > MAX_HUMAN_DIAGNOSTICS {
        append_diagnostic_summary(output, diagnostics);
    }
    let mut locations = BTreeSet::new();
    let mut shown = 0_usize;
    for diagnostic in diagnostics {
        if diagnostics.len() > MAX_HUMAN_DIAGNOSTICS
            && !locations.insert(diagnostic_location_key(diagnostic))
        {
            continue;
        }
        append_diagnostic(output, diagnostic, context);
        shown = shown.saturating_add(1);
        if shown == MAX_HUMAN_DIAGNOSTICS {
            break;
        }
    }
    if shown < diagnostics.len() {
        let _ = writeln!(
            output,
            "  showing {shown} representative locations; --json retains all {} diagnostics",
            diagnostics.len()
        );
    }
}

fn append_diagnostic(output: &mut String, diagnostic: &Value, context: &str) {
    let path = diagnostic
        .pointer("/location/path")
        .and_then(Value::as_str)
        .unwrap_or("_request");
    let line = diagnostic
        .pointer("/location/range/start/line")
        .and_then(Value::as_u64)
        .map_or(0, |line| line.saturating_add(1));
    let code = diagnostic
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = diagnostic
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("diagnostic");
    let path = if context == "." {
        path.to_owned()
    } else {
        format!("{context}/{path}")
    };
    let _ = writeln!(output, "{path}:{line}: {code}: {message}");
    if let Some(help) = diagnostic.get("help").and_then(Value::as_str) {
        let _ = writeln!(output, "  help: {help}");
    }
}

fn append_diagnostic_summary(output: &mut String, diagnostics: &[Value]) {
    let mut files = BTreeSet::new();
    let mut locations = BTreeSet::new();
    let mut rules = BTreeMap::<String, usize>::new();
    let mut hotspots = BTreeMap::<String, usize>::new();
    for diagnostic in diagnostics {
        let path = diagnostic
            .pointer("/location/path")
            .and_then(Value::as_str)
            .unwrap_or("_request")
            .to_owned();
        let code = diagnostic
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        files.insert(path.clone());
        locations.insert(diagnostic_location_key(diagnostic));
        *rules.entry(code).or_default() += 1;
        *hotspots.entry(path).or_default() += 1;
    }
    let _ = writeln!(
        output,
        "  summary: {} diagnostics at {} rule locations across {} files",
        diagnostics.len(),
        locations.len(),
        files.len()
    );
    append_ranked_counts(output, "rules", rules);
    append_ranked_counts(output, "hotspots", hotspots);
}

fn append_ranked_counts(output: &mut String, label: &str, counts: BTreeMap<String, usize>) {
    let mut ranked = counts.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|(left_name, left_count), (right_name, right_count)| {
        right_count
            .cmp(left_count)
            .then_with(|| left_name.cmp(right_name))
    });
    let summary = ranked
        .into_iter()
        .take(3)
        .map(|(name, count)| format!("{name}={count}"))
        .collect::<Vec<_>>()
        .join(", ");
    let _ = writeln!(output, "  top {label}: {summary}");
}

fn diagnostic_location_key(diagnostic: &Value) -> (String, String, u64, u64) {
    (
        diagnostic
            .pointer("/location/path")
            .and_then(Value::as_str)
            .unwrap_or("_request")
            .to_owned(),
        diagnostic
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned(),
        diagnostic
            .pointer("/location/range/start/line")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        diagnostic
            .pointer("/location/range/start/char")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    )
}

const fn user_provider_name(profile: ProviderProfile) -> &'static str {
    match profile {
        ProviderProfile::Fast => "Fast checks",
        ProviderProfile::RustNative => "Rust compile",
        ProviderProfile::NodeNative => "Node typecheck",
        ProviderProfile::PythonNative => "Python typecheck",
    }
}

fn combined_digest(roots: &[(String, String, String, String)]) -> String {
    json_digest(&json!(roots)).unwrap_or_else(|_| "sha256:unavailable".into())
}

fn json_digest(value: &Value) -> Result<String> {
    let bytes = serde_json::to_vec(value)?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn enforce(decision: Decision, advisory: bool) -> Result<()> {
    match decision {
        Decision::Allow => Ok(()),
        Decision::Deny if advisory => Ok(()),
        Decision::Deny => anyhow::bail!("host check found required intervention"),
        Decision::Indeterminate => anyhow::bail!("host check did not complete"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advisory_mode_does_not_hide_incomplete_provider_coverage() {
        assert!(enforce(Decision::Allow, true).is_ok());
        assert!(enforce(Decision::Deny, true).is_ok());
        assert!(enforce(Decision::Indeterminate, true).is_err());
    }

    #[test]
    fn root_selection_rejects_overlap() {
        assert!(selected_roots(&["apps".into(), "apps/web".into()]).is_err());
        assert!(selected_roots(&[".".into(), "apps".into()]).is_err());
    }

    #[test]
    fn selected_root_must_contain_supported_provider_input() {
        let selection = HostSelection {
            profiles: vec![ProviderProfile::Fast],
            skip_inapplicable: false,
            roots: selected_roots(&["apps/web".into()]).unwrap(),
            excluded_roots: Vec::new(),
            comparison: CheckComparison::Introduced,
        };
        let paths = BTreeSet::from([RepoPath::from_protocol("apps/api/main.ts").unwrap()]);
        assert!(validate_selected_roots(&paths, &selection).is_err());
    }

    #[test]
    fn new_ancestor_project_context_invalidates_an_otherwise_current_capture() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(root)
                .status()
                .unwrap()
                .success()
        );
        std::fs::create_dir_all(root.join("service/src")).unwrap();
        std::fs::write(root.join("service/src/app.py"), "answer = 42\n").unwrap();
        std::fs::write(root.join("service/shared.py"), "answer = 42\n").unwrap();
        let repository = GitRepository::discover(root).unwrap();
        let selection = HostSelection {
            profiles: vec![ProviderProfile::PythonNative],
            skip_inapplicable: false,
            roots: selected_roots(&["service/src".into()]).unwrap(),
            excluded_roots: Vec::new(),
            comparison: CheckComparison::All,
        };
        let view = ConfigView::Worktree;
        let targets = TargetPolicy::default();
        let plan = native_capture_plan(&repository, &view, &selection, &targets).unwrap();

        // A control file appears after context discovery, before source capture.
        std::fs::write(root.join("service/pyproject.toml"), "").unwrap();
        let source = repository
            .capture_native_from(&view, None, &plan.roots, plan.filter)
            .unwrap();
        assert!(repository.is_native_current(&source).unwrap());
        assert!(
            !source
                .paths
                .contains_key(&RepoPath::from_protocol("service/shared.py").unwrap())
        );
        let evaluation = HostEvaluation {
            report: Value::Null,
            passed: true,
            human: String::new(),
            captures: vec![HostCapture {
                source,
                selection,
                plan,
            }],
            targets,
            view,
        };
        assert!(!evaluation.is_current(&repository).unwrap());
    }

    #[test]
    fn rebased_paths_are_workspace_relative() {
        let root = selected_roots(&["apps/web".into()])
            .expect("root")
            .pop()
            .expect("one root");
        let path = RepoPath::from_protocol("apps/web/src/main.ts").expect("path");
        assert_eq!(
            rebase_path(&path, &root).and_then(|path| path.as_utf8().map(str::to_owned)),
            Some("src/main.ts".into())
        );
    }

    #[test]
    fn large_human_diagnostic_sets_are_summarized_by_location() {
        let diagnostics = (0..60)
            .map(|index| {
                json!({
                    "code": "opcore-python-native/type-check/reportArgumentType",
                    "message": format!("argument mismatch {index}"),
                    "location": {
                        "path": "tests/test_runner.py",
                        "range": {
                            "start": { "line": index % 2, "char": 4 },
                            "end": { "line": index % 2, "char": 8 }
                        }
                    }
                })
            })
            .collect::<Vec<_>>();
        let assessment = json!({ "diagnostics": diagnostics });
        let mut output = String::new();

        append_diagnostics(&mut output, &assessment, ".");

        assert!(output.contains("60 diagnostics at 2 rule locations across 1 files"));
        assert!(output.contains("reportArgumentType=60"));
        assert!(output.contains("showing 2 representative locations"));
        assert_eq!(output.matches("tests/test_runner.py:").count(), 2);
    }
}
