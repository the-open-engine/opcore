use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    io::Write as _,
    path::PathBuf,
    sync::Arc,
    time::Instant,
};

use anyhow::Result;
use clap::Args;

use crate::{
    cache::{FactCache, MemoryFactCache},
    cancel::CancelToken,
    documentation::{
        DOCUMENTATION_REGISTRY_PATH, DocumentationRegistry, parse_optional_documentation_registry,
    },
    limits::{MAX_ASSESSMENT_BYTES, MAX_AUXILIARY_PATHS, MAX_SENSE_FINDINGS},
    local::repository_fact_cache,
    model::ProviderMetadata,
    path::RepoPath,
    policy::{ConfigView, CoveragePolicy, PolicySnapshot, Workflow},
    source::git::{GitAuxiliaryCapture, GitRepository, GitWorkspaceCapture, is_go_module_file},
};

use super::{
    GoModuleViews, SenseEngine, SenseOptions, SenseRequest,
    documentation::{
        DocumentationInputs, DocumentationPolicy, evaluate as evaluate_documentation,
        needs_evaluation as documentation_needs_evaluation, referenced_documents,
    },
    engine::effective_policy,
    hypothesis::Hypothesis,
    model::{
        DedupCoverage, DocumentationCoverage, DocumentationRegistryState, DuplicateKind,
        GraphViewSummary, ResolutionCoverage, ResolutionGapKind, SenseIssue, SenseObservations,
        SenseReport, SenseStatus, SenseTiming,
    },
};

/// Select the exact dependency comparison and how to handle findings and coverage.
///
/// The default compares HEAD with the current worktree. Hypothetical requests use
/// `schemaVersion: 1` and a `changes` array of literal `write` or `delete` operations;
/// a write also requires its exact UTF-8 `content`. No candidate files are written.
#[derive(Clone, Debug, Args)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Clap represents these independent command-line switches as booleans"
)]
pub struct SenseArgs {
    /// Git repository or a directory inside it (default: current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,
    /// Print the structured dependency report, findings, and coverage as JSON.
    #[arg(long)]
    pub json: bool,
    /// Report findings without blocking. Incomplete or partial coverage still blocks.
    #[arg(long)]
    pub advisory: bool,
    /// Accept explicitly reported partial dependency coverage with a successful exit status.
    #[arg(long)]
    pub allow_partial: bool,
    /// Accept explicit `node:` built-in boundaries, but no other partial coverage.
    #[arg(long)]
    pub allow_node_builtins: bool,
    /// Compare the complete HEAD tree with the complete stage-0 index, ignoring worktree bytes.
    #[arg(long, conflicts_with = "hypothetical")]
    pub staged: bool,
    /// Apply a strict in-memory change request to the current worktree (`-` reads stdin).
    #[arg(long, value_name = "FILE", conflicts_with = "staged")]
    pub hypothetical: Option<PathBuf>,
    /// Apply this workflow's shared settings and exclusions.
    #[arg(long, value_enum)]
    pub workflow: Option<Workflow>,
    /// Read source, configuration and documents from an immutable Git target.
    #[arg(long, value_name = "REF", conflicts_with_all = ["staged", "hypothetical"])]
    pub tree: Option<String>,
    /// Compare the target tree with this base tree (required for CI regression checks).
    #[arg(long, value_name = "REF", requires = "tree")]
    pub base: Option<String>,
}

#[derive(Clone, Copy)]
enum SenseInput<'a> {
    Tree {
        target: &'a str,
        base: Option<&'a str>,
    },
    Worktree,
    Staged,
    Hypothetical,
}

impl SenseArgs {
    fn input(&self) -> SenseInput<'_> {
        if let Some(target) = self.tree.as_deref() {
            SenseInput::Tree {
                target,
                base: self.base.as_deref(),
            }
        } else if self.hypothetical.is_some() {
            SenseInput::Hypothetical
        } else if self.staged {
            SenseInput::Staged
        } else {
            SenseInput::Worktree
        }
    }
}

/// Evaluates the selected exact local dependency view and renders its report.
///
/// # Errors
///
/// Returns an error for invalid input, unstable capture, incomplete blocking coverage, findings,
/// or output failure.
pub async fn run(args: SenseArgs) -> Result<()> {
    let command_started = Instant::now();
    let hypothesis = match args.hypothetical.as_deref().map(Hypothesis::read) {
        Some(Ok(hypothesis)) => Some(hypothesis),
        Some(Err(error)) => {
            let reason = format!("load hypothetical Sense request: {error:#}");
            emit_failure(&args, "hypothesis_invalid", reason.clone(), command_started)?;
            anyhow::bail!(reason);
        }
        None => None,
    };
    let repository = match GitRepository::discover(&args.repo) {
        Ok(repository) => repository,
        Err(error) => {
            emit_failure(
                &args,
                "repository_discovery_failed",
                format!("discover Git repository: {error}"),
                command_started,
            )?;
            return Err(anyhow::Error::new(error).context("discover Git repository"));
        }
    };
    let engine = SenseEngine::with_cache(repository_fact_cache(&repository));
    let output = stable_report(
        &args,
        &repository,
        &engine,
        SenseAttempt {
            hypothesis: hypothesis.as_ref(),
            policy: None,
        },
        command_started,
    )
    .await?;
    emit_prepared(&output.rendered)?;
    enforce_selected_report(&output, &args)
}

fn enforce_selected_report(output: &StableSenseOutput, args: &SenseArgs) -> Result<()> {
    enforce_report(
        &output.report,
        args.advisory,
        args.allow_partial || output.coverage.allow_partial,
        args.allow_node_builtins || output.coverage.allow_node_builtins,
    )
}

/// Assesses one selected view using the workflow's already-resolved configuration.
pub(crate) async fn assess(
    args: &SenseArgs,
    repository: &GitRepository,
    policy: &PolicySnapshot,
) -> Result<SenseReport> {
    let started = Instant::now();
    let engine = SenseEngine::with_cache(repository_fact_cache(repository));
    let mut quiet = args.clone();
    quiet.json = false;
    let hypothesis = args
        .hypothetical
        .as_deref()
        .map(Hypothesis::read)
        .transpose()?;
    stable_report(
        &quiet,
        repository,
        &engine,
        SenseAttempt {
            hypothesis: hypothesis.as_ref(),
            policy: Some(policy),
        },
        started,
    )
    .await
    .map(|output| output.report)
}

struct StableSenseOutput {
    coverage: CoveragePolicy,
    report: SenseReport,
    rendered: String,
}

#[derive(Clone, Copy)]
struct SenseAttempt<'a> {
    hypothesis: Option<&'a Hypothesis>,
    policy: Option<&'a PolicySnapshot>,
}

fn select_hypothesis(
    hypothesis: Option<&Hypothesis>,
    policy: &PolicySnapshot,
) -> Result<Option<Hypothesis>> {
    hypothesis
        .map(|hypothesis| {
            hypothesis.validate_configuration(policy)?;
            Ok(hypothesis.selected(&policy.policy.targets))
        })
        .transpose()
}

fn validated_hypothesis(
    args: &SenseArgs,
    hypothesis: Option<&Hypothesis>,
    policy: &PolicySnapshot,
    started: Instant,
) -> Result<Option<Hypothesis>> {
    match select_hypothesis(hypothesis, policy) {
        Ok(hypothesis) => Ok(hypothesis),
        Err(error) => {
            emit_failure(args, "hypothesis_invalid", format!("{error:#}"), started)?;
            Err(error)
        }
    }
}

async fn stable_report(
    args: &SenseArgs,
    repository: &GitRepository,
    engine: &SenseEngine,
    input: SenseAttempt<'_>,
    command_started: Instant,
) -> Result<StableSenseOutput> {
    for attempt in 0..2 {
        let (output, freshness) =
            prepare_attempt(args, repository, engine, input, command_started).await?;
        let Some((code, reason)) = freshness else {
            return Ok(output);
        };
        if attempt == 0 {
            continue;
        }
        emit_failure(args, code, reason.clone(), command_started)?;
        anyhow::bail!(reason);
    }
    anyhow::bail!("bounded workspace evaluation loop completed without a report")
}

async fn prepare_attempt(
    args: &SenseArgs,
    repository: &GitRepository,
    engine: &SenseEngine,
    input: SenseAttempt<'_>,
    command_started: Instant,
) -> Result<(StableSenseOutput, Option<(&'static str, String)>)> {
    let policy = input.policy.map_or_else(
        || load_policy(args, repository, command_started),
        |policy| Ok(policy.clone()),
    )?;
    let selected = repository.with_targets(&policy.policy.targets);
    let repository = &selected;
    let selected_hypothesis =
        validated_hypothesis(args, input.hypothesis, &policy, command_started)?;
    let hypothesis = selected_hypothesis.as_ref();
    let capture_started = Instant::now();
    let capture = capture_workspace(args, repository, hypothesis, command_started)?;
    let go_modules = capture_go_modules(args, repository, &capture, hypothesis, command_started)?;
    let capture_us = elapsed_us(capture_started);
    let mut report = evaluate_capture(engine, &capture, &go_modules, &policy).await?;
    report
        .effective_policy
        .excluded_paths
        .clone_from(&policy.policy.targets.exclude);
    report.timing.capture_us = capture_us;
    let documentation_started = Instant::now();
    let documentation = apply_documentation(repository, &mut report, args.input(), hypothesis);
    report.timing.documentation_us = elapsed_us(documentation_started);
    let rendered = prepare_output(&mut report, args.json, command_started)?;
    let freshness = freshness_error(repository, &capture, &go_modules, &documentation, &policy);
    Ok((
        StableSenseOutput {
            coverage: policy.policy.coverage,
            report,
            rendered,
        },
        freshness,
    ))
}

#[derive(Default)]
struct GoModuleCapture {
    exact: Option<GitAuxiliaryCapture>,
    views: GoModuleViews,
    changed_files: usize,
}

fn capture_go_modules(
    args: &SenseArgs,
    repository: &GitRepository,
    workspace: &GitWorkspaceCapture,
    hypothesis: Option<&Hypothesis>,
    command_started: Instant,
) -> Result<GoModuleCapture> {
    if !workspace
        .before
        .files()
        .chain(workspace.after.files())
        .any(|file| file.language == crate::model::Language::Go)
    {
        return Ok(GoModuleCapture::default());
    }
    let paths = workspace
        .paths
        .iter()
        .filter(|path| is_go_module_file(path))
        .cloned()
        .collect::<BTreeSet<_>>();
    if paths.is_empty() {
        return Ok(GoModuleCapture::default());
    }
    match capture_auxiliary(repository, &paths, args.input(), hypothesis) {
        Ok(exact) => Ok(module_views(exact)),
        Err(error) => {
            let reason = format!("capture exact Go module files: {error}");
            emit_failure(
                args,
                "go_module_capture_failed",
                reason.clone(),
                command_started,
            )?;
            anyhow::bail!(reason)
        }
    }
}

fn module_views(exact: GitAuxiliaryCapture) -> GoModuleCapture {
    let mut views = GoModuleViews::default();
    let mut changed_files = 0usize;
    for (path, state) in &exact.paths {
        if let Some(blob) = &state.before {
            views.before.insert(path.clone(), Arc::clone(&blob.bytes));
        }
        if let Some(blob) = &state.after {
            views.after.insert(path.clone(), Arc::clone(&blob.bytes));
        }
        changed_files = changed_files.saturating_add(usize::from(state.content_changed()));
    }
    GoModuleCapture {
        exact: Some(exact),
        views,
        changed_files,
    }
}

fn load_policy(
    args: &SenseArgs,
    repository: &GitRepository,
    command_started: Instant,
) -> Result<PolicySnapshot> {
    let view = match args.input() {
        SenseInput::Staged => ConfigView::Index,
        SenseInput::Tree { target, .. } => ConfigView::Tree(target.to_owned()),
        SenseInput::Worktree | SenseInput::Hypothetical => ConfigView::Worktree,
    };
    match PolicySnapshot::capture(repository, view, args.workflow) {
        Ok(policy) => Ok(policy),
        Err(error) => {
            let reason = format!("load repository policy: {error:#}");
            emit_failure(args, "policy_invalid", reason.clone(), command_started)?;
            anyhow::bail!(reason)
        }
    }
}

fn capture_workspace(
    args: &SenseArgs,
    repository: &GitRepository,
    hypothesis: Option<&Hypothesis>,
    command_started: Instant,
) -> Result<GitWorkspaceCapture> {
    let capture = match args.input() {
        SenseInput::Worktree => repository.capture_workspace(),
        SenseInput::Staged => repository.capture_staged_workspace(),
        SenseInput::Tree { target, base } => repository.capture_tree_workspace(target, base),
        SenseInput::Hypothetical => hypothesis.map_or_else(
            || {
                Err(crate::source::SourceError::Invalid(
                    "missing hypothetical Sense request".into(),
                ))
            },
            |hypothesis| {
                repository.capture_workspace().and_then(|capture| {
                    capture.apply_hypothetical(&hypothesis.overlays, &hypothesis.digest)
                })
            },
        ),
    };
    match capture {
        Ok(capture) => Ok(capture),
        Err(error) => {
            emit_failure(
                args,
                "capture_failed",
                format!("capture exact Git workspace: {error}"),
                command_started,
            )?;
            Err(anyhow::Error::new(error).context("capture exact Git workspace"))
        }
    }
}

fn freshness_error(
    repository: &GitRepository,
    capture: &GitWorkspaceCapture,
    go_modules: &GoModuleCapture,
    documentation: &DocumentationCaptures,
    policy: &PolicySnapshot,
) -> Option<(&'static str, String)> {
    source_freshness_error(repository, capture)
        .or_else(|| go_module_freshness_error(repository, go_modules))
        .or_else(|| documentation_freshness_error(repository, documentation))
        .or_else(|| sense_policy_freshness_error(policy))
}

fn go_module_freshness_error(
    repository: &GitRepository,
    modules: &GoModuleCapture,
) -> Option<(&'static str, String)> {
    let capture = modules.exact.as_ref()?;
    match repository.is_auxiliary_current(capture) {
        Ok(true) => None,
        Ok(false) => Some((
            "go_module_changed",
            "Go module metadata changed before the sense report could be returned".into(),
        )),
        Err(error) => Some((
            "go_module_revalidation_failed",
            format!("could not revalidate Go module metadata: {error}"),
        )),
    }
}

fn source_freshness_error(
    repository: &GitRepository,
    capture: &GitWorkspaceCapture,
) -> Option<(&'static str, String)> {
    match repository.is_workspace_current(capture) {
        Ok(true) => None,
        Ok(false) => Some((
            "source_changed",
            "Git workspace changed before the sense report could be returned".into(),
        )),
        Err(error) => Some((
            "source_revalidation_failed",
            format!("could not revalidate Git workspace: {error}"),
        )),
    }
}

fn documentation_freshness_error(
    repository: &GitRepository,
    documentation: &DocumentationCaptures,
) -> Option<(&'static str, String)> {
    for (capture, changed_code, failed_code, label) in [
        (
            documentation.registry.as_ref(),
            "documentation_registry_changed",
            "documentation_registry_revalidation_failed",
            "documentation registry",
        ),
        (
            documentation.documents.as_ref(),
            "documentation_files_changed",
            "documentation_files_revalidation_failed",
            "documentation files",
        ),
    ] {
        let Some(capture) = capture else {
            continue;
        };
        match repository.is_auxiliary_current(capture) {
            Ok(true) => {}
            Ok(false) => {
                return Some((
                    changed_code,
                    format!("{label} changed before the sense report could be returned"),
                ));
            }
            Err(error) => {
                return Some((
                    failed_code,
                    format!("could not revalidate {label}: {error}"),
                ));
            }
        }
    }
    None
}

fn sense_policy_freshness_error(policy: &PolicySnapshot) -> Option<(&'static str, String)> {
    match policy.is_current() {
        Ok(true) => None,
        Ok(false) => Some((
            "policy_changed",
            "repository policy changed before the sense report was returned".into(),
        )),
        Err(error) => Some((
            "policy_revalidation_failed",
            format!("could not revalidate repository policy: {error:#}"),
        )),
    }
}

async fn evaluate_capture(
    engine: &SenseEngine,
    capture: &GitWorkspaceCapture,
    go_modules: &GoModuleCapture,
    policy: &PolicySnapshot,
) -> Result<SenseReport> {
    engine
        .evaluate(
            SenseRequest {
                before: Arc::clone(&capture.before),
                after: Arc::clone(&capture.after),
                changed_paths: capture.changed_paths.clone(),
                before_unsupported_files: capture.before_unsupported_files,
                after_unsupported_files: capture.after_unsupported_files,
                unsupported_changed_files: capture.unsupported_changed_files,
                dependency_metadata_changed_files: go_modules.changed_files,
                go_modules: go_modules.views.clone(),
                valid_as_of: policy.bind_valid_as_of(&module_valid_as_of(capture, go_modules)),
                options: policy.policy.sense_options(),
            },
            CancelToken::new(),
        )
        .await
}

fn module_valid_as_of(capture: &GitWorkspaceCapture, modules: &GoModuleCapture) -> String {
    serde_json::json!({
        "kind": "git-sense-input",
        "source": capture.valid_as_of,
        "goModules": modules.exact.as_ref().map(|exact| &exact.valid_as_of),
    })
    .to_string()
}

#[derive(Default)]
struct DocumentationCaptures {
    registry: Option<GitAuxiliaryCapture>,
    documents: Option<GitAuxiliaryCapture>,
}

struct DocumentationEvaluation {
    captures: DocumentationCaptures,
    after_registry: Option<DocumentationRegistry>,
    policy: DocumentationPolicy,
}

enum DocumentationRegistryCapture {
    Ready(DocumentationEvaluation),
    Terminal(DocumentationCaptures),
}

fn apply_documentation(
    repository: &GitRepository,
    report: &mut SenseReport,
    input: SenseInput<'_>,
    hypothesis: Option<&Hypothesis>,
) -> DocumentationCaptures {
    if report.observations.truncated {
        mark_incomplete(
            report,
            "documentation_input_truncated",
            "documentation policy was not evaluated because important-node observations were bounded"
                .into(),
        );
        return DocumentationCaptures::default();
    }
    let policy = DocumentationPolicy {
        important_fan_in: report.effective_policy.important_fan_in,
        important_exports: report.effective_policy.max_module_exports,
    };
    if !documentation_needs_evaluation(&report.observations.important_nodes, policy) {
        return DocumentationCaptures::default();
    }

    report.documentation_coverage.evaluated = true;
    let evaluation =
        match capture_documentation_registry(repository, report, input, hypothesis, policy) {
            DocumentationRegistryCapture::Ready(evaluation) => evaluation,
            DocumentationRegistryCapture::Terminal(captures) => return captures,
        };
    evaluate_documentation_files(repository, report, input, hypothesis, evaluation)
}

fn capture_documentation_registry(
    repository: &GitRepository,
    report: &mut SenseReport,
    input: SenseInput<'_>,
    hypothesis: Option<&Hypothesis>,
    policy: DocumentationPolicy,
) -> DocumentationRegistryCapture {
    let registry_path = match RepoPath::from_protocol(DOCUMENTATION_REGISTRY_PATH) {
        Ok(path) => path,
        Err(error) => {
            mark_incomplete(
                report,
                "documentation_registry_path_invalid",
                format!("documentation registry path is invalid: {error}"),
            );
            return DocumentationRegistryCapture::Terminal(DocumentationCaptures::default());
        }
    };
    let registry_paths = BTreeSet::from([registry_path.clone()]);
    let registry_capture = match capture_auxiliary(repository, &registry_paths, input, hypothesis) {
        Ok(capture) => capture,
        Err(error) => {
            report.documentation_coverage.before_registry = DocumentationRegistryState::Unavailable;
            report.documentation_coverage.after_registry = DocumentationRegistryState::Unavailable;
            mark_incomplete(
                report,
                "documentation_registry_capture_failed",
                format!("could not capture exact documentation registry: {error}"),
            );
            return DocumentationRegistryCapture::Terminal(DocumentationCaptures::default());
        }
    };
    let Some(registry_state) = registry_capture.paths.get(&registry_path) else {
        mark_incomplete(
            report,
            "documentation_registry_capture_missing",
            "exact documentation capture omitted the requested registry path".into(),
        );
        return DocumentationRegistryCapture::Terminal(DocumentationCaptures {
            registry: Some(registry_capture),
            documents: None,
        });
    };
    let before_bytes = registry_state
        .before
        .as_ref()
        .map(|blob| blob.bytes.as_ref());
    let after_bytes = registry_state
        .after
        .as_ref()
        .map(|blob| blob.bytes.as_ref());
    let (before_state, before_registry, before_error) = parse_registry(before_bytes);
    let (after_state, after_registry, after_error) = parse_registry(after_bytes);
    report.documentation_coverage.before_registry = before_state;
    report.documentation_coverage.after_registry = after_state;
    report.documentation_coverage.before_bindings = before_registry
        .as_ref()
        .map_or(0, |registry| registry.bindings.len());
    report.documentation_coverage.after_bindings = after_registry
        .as_ref()
        .map_or(0, |registry| registry.bindings.len());
    let captures = DocumentationCaptures {
        registry: Some(registry_capture),
        documents: None,
    };
    if let Some(error) = before_error.or(after_error) {
        mark_incomplete(
            report,
            "documentation_registry_invalid",
            format!("documentation registry is invalid in a required view: {error}"),
        );
        bind_documentation_freshness(report, &captures);
        return DocumentationRegistryCapture::Terminal(captures);
    }
    DocumentationRegistryCapture::Ready(DocumentationEvaluation {
        captures,
        after_registry,
        policy,
    })
}

fn evaluate_documentation_files(
    repository: &GitRepository,
    report: &mut SenseReport,
    input: SenseInput<'_>,
    hypothesis: Option<&Hypothesis>,
    mut evaluation: DocumentationEvaluation,
) -> DocumentationCaptures {
    let document_paths = referenced_documents(
        &report.observations.important_nodes,
        evaluation.after_registry.as_ref(),
        evaluation.policy,
    );
    report.documentation_coverage.documents_requested = document_paths.len();
    if document_paths.len() > MAX_AUXILIARY_PATHS {
        mark_incomplete(
            report,
            "documentation_paths_truncated",
            format!(
                "{} required documentation paths exceed limit {MAX_AUXILIARY_PATHS}",
                document_paths.len()
            ),
        );
        bind_documentation_freshness(report, &evaluation.captures);
        return evaluation.captures;
    }
    if !document_paths.is_empty() {
        match capture_auxiliary(repository, &document_paths, input, hypothesis) {
            Ok(capture) => evaluation.captures.documents = Some(capture),
            Err(error) => {
                mark_incomplete(
                    report,
                    "documentation_files_capture_failed",
                    format!("could not capture exact documentation files: {error}"),
                );
                bind_documentation_freshness(report, &evaluation.captures);
                return evaluation.captures;
            }
        }
    }
    let empty_documents = BTreeMap::new();
    let documents = evaluation
        .captures
        .documents
        .as_ref()
        .map_or(&empty_documents, |capture| &capture.paths);
    let finding_limit = MAX_SENSE_FINDINGS.saturating_sub(
        report
            .introduced_cycles
            .len()
            .saturating_add(report.introduced_duplicates.len())
            .saturating_add(report.interface_findings.len()),
    );
    let result = evaluate_documentation(DocumentationInputs {
        nodes: &report.observations.important_nodes,
        after_registry: evaluation.after_registry.as_ref(),
        documents,
        policy: evaluation.policy,
        finding_limit,
    });
    report.documentation_coverage.documents_requested = result.documents_requested;
    report.documentation_coverage.before_documents = result.before_documents;
    report.documentation_coverage.after_documents = result.after_documents;
    report.documentation_coverage.changed_documents = result.changed_documents;
    report.documentation_coverage.public_surface_candidates = result.public_surface_candidates;
    report.documentation_coverage.authoritative_public_surfaces =
        result.authoritative_public_surfaces;
    report.documentation_coverage.unavailable_public_surfaces = result.unavailable_public_surfaces;
    report.documentation_requirements = result.requirements;
    if result.findings_truncated {
        report.findings_truncated = true;
        mark_incomplete(
            report,
            "findings_truncated",
            "sense findings exceeded the report bound".into(),
        );
    } else if !report.documentation_requirements.is_empty() && report.status == SenseStatus::Clean {
        report.status = SenseStatus::Findings;
    }
    if !result.coverage_issues.is_empty() {
        report.issues.extend(result.coverage_issues);
        if report.status != SenseStatus::Incomplete {
            report.status = SenseStatus::Partial;
        }
    }
    bind_documentation_freshness(report, &evaluation.captures);
    evaluation.captures
}

fn capture_auxiliary(
    repository: &GitRepository,
    paths: &BTreeSet<RepoPath>,
    input: SenseInput<'_>,
    hypothesis: Option<&Hypothesis>,
) -> Result<GitAuxiliaryCapture, crate::source::SourceError> {
    match input {
        SenseInput::Worktree => repository.capture_auxiliary(paths),
        SenseInput::Staged => repository.capture_staged_auxiliary(paths),
        SenseInput::Tree { target, base } => repository.capture_tree_auxiliary(paths, target, base),
        SenseInput::Hypothetical => hypothesis.map_or_else(
            || {
                Err(crate::source::SourceError::Invalid(
                    "missing hypothetical Sense request".into(),
                ))
            },
            |hypothesis| {
                repository.capture_auxiliary(paths).and_then(|capture| {
                    capture.apply_hypothetical(&hypothesis.overlays, &hypothesis.digest)
                })
            },
        ),
    }
}

fn parse_registry(
    bytes: Option<&[u8]>,
) -> (
    DocumentationRegistryState,
    Option<DocumentationRegistry>,
    Option<String>,
) {
    match parse_optional_documentation_registry(bytes) {
        Ok(Some(registry)) => (DocumentationRegistryState::Valid, Some(registry), None),
        Ok(None) => (DocumentationRegistryState::Missing, None, None),
        Err(error) => (
            DocumentationRegistryState::Invalid,
            None,
            Some(error.to_string()),
        ),
    }
}

fn bind_documentation_freshness(report: &mut SenseReport, captures: &DocumentationCaptures) {
    let Some(registry) = &captures.registry else {
        return;
    };
    report.valid_as_of = serde_json::json!({
        "kind": "git-sense",
        "source": report.valid_as_of.clone(),
        "registry": registry.valid_as_of,
        "documents": captures.documents.as_ref().map(|capture| &capture.valid_as_of),
    })
    .to_string();
}

fn mark_incomplete(report: &mut SenseReport, code: &str, message: String) {
    report.status = SenseStatus::Incomplete;
    if !report.issues.iter().any(|issue| issue.code == code) {
        report.issues.push(SenseIssue::new(code, message));
    }
}

fn prepare_output(
    report: &mut SenseReport,
    json: bool,
    command_started: Instant,
) -> Result<String> {
    let render_started = Instant::now();
    let mut replaced_oversize_report = false;
    loop {
        report.timing.render_us = elapsed_us(render_started);
        report.timing.total_us = elapsed_us(command_started);
        let rendered = render_output(report, json)?;
        if rendered.len() <= MAX_ASSESSMENT_BYTES {
            return Ok(rendered);
        }
        mark_output_truncated(report);
        if shrink_report(report) {
            continue;
        }
        if replaced_oversize_report {
            anyhow::bail!("compact sense failure cannot fit the output byte bound");
        }
        *report = incomplete_report(
            "output_too_large",
            "sense evidence could not fit the output byte bound".into(),
            command_started,
        );
        replaced_oversize_report = true;
    }
}

fn shrink_report(report: &mut SenseReport) -> bool {
    let details_shrunk = shrink_cycle_details(report);
    let details_shrunk = shrink_impact_samples(report) || details_shrunk;
    let details_shrunk = shrink_duplicate_occurrences(report) || details_shrunk;
    if details_shrunk || shrink_observations(&mut report.observations) {
        return true;
    }
    shrink_findings(report)
}

fn shrink_cycle_details(report: &mut SenseReport) -> bool {
    let mut shrunk = false;
    for cycle in &mut report.introduced_cycles {
        shrunk |= !cycle.members.is_empty() || !cycle.witness.is_empty();
        cycle.members_truncated |= !cycle.members.is_empty();
        cycle.members.clear();
        cycle.witness_truncated |= !cycle.witness.is_empty();
        cycle.witness.clear();
    }
    shrunk
}

fn shrink_impact_samples(report: &mut SenseReport) -> bool {
    let mut shrunk = false;
    for impact in &mut report.observations.impact {
        shrunk |= !impact.sample.is_empty();
        impact.sample_truncated |= !impact.sample.is_empty();
        impact.sample.clear();
    }
    shrunk
}

fn shrink_duplicate_occurrences(report: &mut SenseReport) -> bool {
    let mut shrunk = false;
    for duplicate in &mut report.introduced_duplicates {
        shrunk |= duplicate.occurrences.len() > 1;
        duplicate.occurrences_truncated |= duplicate.occurrences.len() > 1;
        duplicate.occurrences.truncate(1);
    }
    shrunk
}

fn shrink_findings(report: &mut SenseReport) -> bool {
    if truncate_half(&mut report.interface_findings)
        || truncate_half(&mut report.documentation_requirements)
        || truncate_half(&mut report.introduced_cycles)
        || truncate_half(&mut report.introduced_duplicates)
    {
        report.findings_truncated = true;
        return true;
    }
    false
}

fn truncate_half<T>(items: &mut Vec<T>) -> bool {
    if items.len() <= 1 {
        return false;
    }
    items.truncate(items.len() / 2);
    true
}

fn shrink_observations(observations: &mut SenseObservations) -> bool {
    let lengths = [
        observations.dependency_deltas.len(),
        observations.impact.len(),
        observations.high_impact_changes.len(),
        observations.interfaces.len(),
        observations.important_nodes.len(),
    ];
    let Some((index, &length)) = lengths.iter().enumerate().max_by_key(|(_, length)| *length)
    else {
        return false;
    };
    if length == 0 {
        return false;
    }
    let keep = length / 2;
    match index {
        0 => observations.dependency_deltas.truncate(keep),
        1 => observations.impact.truncate(keep),
        2 => observations.high_impact_changes.truncate(keep),
        3 => observations.interfaces.truncate(keep),
        4 => observations.important_nodes.truncate(keep),
        _ => return false,
    }
    observations.truncated = true;
    true
}

fn mark_output_truncated(report: &mut SenseReport) {
    report.status = SenseStatus::Incomplete;
    report.observations.truncated = true;
    if !report
        .issues
        .iter()
        .any(|issue| issue.code == "output_truncated")
    {
        report.issues.push(SenseIssue::new(
            "output_truncated",
            "sense evidence exceeded the output byte bound",
        ));
    }
}

pub(crate) fn render_output(report: &SenseReport, json: bool) -> Result<String> {
    if json {
        let mut output = serde_json::to_string(report)?;
        output.push('\n');
        Ok(output)
    } else {
        Ok(human_output(report))
    }
}

fn emit_prepared(output: &str) -> Result<()> {
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    stdout.write_all(output.as_bytes())?;
    stdout.flush()?;
    Ok(())
}

fn human_output(report: &SenseReport) -> String {
    let mut output = String::new();
    let milliseconds = report.timing.total_us / 1_000;
    let fractional_ms = report.timing.total_us % 1_000;
    let _ = writeln!(
        output,
        concat!(
            "opcore sense: {:?} ({} cycles, {} duplicates, ",
            "{} interface findings, {} documentation requirements, {} changed, ",
            "{} files, {} runtime edges, {} structural edges, {}.{:03} ms)"
        ),
        report.status,
        report.introduced_cycles.len(),
        report.introduced_duplicates.len(),
        report.interface_findings.len(),
        report.documentation_requirements.len(),
        report.changed_files,
        report.after.files,
        report.after.runtime_edges,
        report.after.structural_edges,
        milliseconds,
        fractional_ms,
    );
    append_cycles(&mut output, report);
    for finding in &report.interface_findings {
        let target = finding
            .target
            .as_ref()
            .map_or_else(String::new, |target| format!(" toward {target}"));
        let _ = writeln!(
            output,
            "interface: {} has {} {} (was {}; limit {}){}",
            finding.path, finding.after, finding.metric, finding.before, finding.limit, target,
        );
    }
    for requirement in &report.documentation_requirements {
        let document = requirement
            .document
            .as_ref()
            .map_or_else(String::new, |document| format!(" ({document})"));
        let _ = writeln!(
            output,
            "documentation: {}: {}{} [{}]",
            requirement.path,
            documentation_message(&requirement.code),
            document,
            requirement.code,
        );
    }
    if report.documentation_coverage.public_surface_candidates > 0 {
        let _ = writeln!(
            output,
            "documentation public-surface coverage: {}/{} bound important changed Python sources authoritative; {} unavailable",
            report.documentation_coverage.authoritative_public_surfaces,
            report.documentation_coverage.public_surface_candidates,
            report.documentation_coverage.unavailable_public_surfaces,
        );
    }
    for item in &report.observations.high_impact_changes {
        let _ = writeln!(
            output,
            "impact: {} has {} confirmed direct dependents",
            item.path, item.confirmed_direct_dependents
        );
    }
    append_duplicates(&mut output, report);
    for issue in &report.issues {
        let _ = writeln!(output, "{}: {}", issue.code, issue.message);
        if !issue.paths.is_empty() {
            let paths = issue
                .paths
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            let suffix = if issue.paths_truncated {
                " (sample truncated)"
            } else {
                ""
            };
            let _ = writeln!(output, "  affected: {paths}{suffix}");
        }
        if let Some(next_step) = &issue.next_step {
            let _ = writeln!(output, "  next: {next_step}");
        }
    }
    append_coverage(&mut output, report);
    output
}

fn append_cycles(output: &mut String, report: &SenseReport) {
    for cycle in &report.introduced_cycles {
        let _ = writeln!(
            output,
            "cycle: {} -> {} ({} files)",
            cycle.trigger.from, cycle.trigger.to, cycle.member_count
        );
        if !cycle.witness.is_empty() {
            let witness = cycle
                .witness
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(" -> ");
            let suffix = if cycle.witness_truncated {
                " (truncated)"
            } else {
                ""
            };
            let _ = writeln!(output, "  witness: {witness}{suffix}");
        }
    }
}

fn append_duplicates(output: &mut String, report: &SenseReport) {
    for duplicate in &report.introduced_duplicates {
        let kind = match duplicate.kind {
            DuplicateKind::IdenticalFile => "identical file",
            DuplicateKind::CallableBody => "callable body",
            DuplicateKind::TokenRegion => "token region",
        };
        let location = duplicate.occurrences.first().map_or_else(
            || "unknown".into(),
            |occurrence| occurrence.path.to_string(),
        );
        let _ = writeln!(
            output,
            "duplicate {kind}: {location} ({} occurrences, was {})",
            duplicate.after_count, duplicate.before_count
        );
        for occurrence in duplicate.occurrences.iter().take(4) {
            let changed = if occurrence.changed { "; changed" } else { "" };
            if let Some(range) = occurrence.range {
                let _ = writeln!(
                    output,
                    "  at {}:{}{changed}",
                    occurrence.path, range.start.line
                );
            } else {
                let _ = writeln!(output, "  at {}{changed}", occurrence.path);
            }
        }
        if duplicate.occurrences_truncated || duplicate.occurrences.len() > 4 {
            let _ = writeln!(output, "  more occurrences are available in --json output");
        }
    }
}

fn documentation_message(code: &str) -> &'static str {
    match code {
        "sense.documentation.missing_binding" => {
            "add this source to .opcore.json documentation.bindings"
        }
        "sense.documentation.missing_document" => "the registered document is missing",
        "sense.documentation.document_not_updated" => {
            "update the registered document with this source change"
        }
        "sense.documentation.stale_binding" => "update or remove the old documentation binding",
        _ => "documentation ownership needs attention",
    }
}

fn append_coverage(output: &mut String, report: &SenseReport) {
    if report.status != SenseStatus::Partial {
        return;
    }
    append_resolution_coverage(output, "after", &report.after);
    if report.before.coverage != report.after.coverage {
        append_resolution_coverage(output, "before", &report.before);
    }
    append_interface_coverage(output, &report.after.interface_coverage);
    append_dedup_coverage(output, &report.dedup_coverage.after);
    if report.changed_files == 0 {
        let _ = writeln!(
            output,
            "baseline coverage remains partial, but no source changes were compared; no acknowledgment is required"
        );
    } else if partial_only_for_node_builtins(report) {
        let _ = writeln!(
            output,
            concat!(
                "Node built-in implementations were not checked; inspect --json or rerun with ",
                "--allow-node-builtins to acknowledge only these boundaries"
            )
        );
    } else {
        let _ = writeln!(
            output,
            "partial coverage is not a full pass; inspect --json or rerun with --allow-partial after reviewing these limits"
        );
    }
}

fn append_resolution_coverage(output: &mut String, label: &str, view: &GraphViewSummary) {
    let coverage = &view.coverage;
    let _ = writeln!(
        output,
        concat!(
            "coverage {}: {}/{} dependency files complete; {} unsupported, ",
            "{} parser failures, {} truncated"
        ),
        label,
        coverage.complete_files,
        coverage.files,
        coverage.unsupported_files,
        coverage.parser_failed_files,
        coverage.truncated_files,
    );
    let _ = writeln!(
        output,
        concat!(
            "  references: {} node built-ins, {} external total, {} ambiguous, {} unresolved, ",
            "{} dynamic, {} configuration errors"
        ),
        coverage.node_builtin_references,
        coverage.external_references,
        coverage.ambiguous_references,
        coverage.unresolved_references,
        coverage.unsupported_dynamic_references,
        coverage.configuration_errors,
    );
    for gap in &view.resolution_gaps {
        let _ = writeln!(
            output,
            "  {}: {} imports {:?}",
            resolution_gap_label(gap.kind),
            gap.path,
            gap.specifier
        );
    }
    if view.resolution_gaps_truncated {
        let _ = writeln!(
            output,
            "  more resolution gaps are available than this bounded sample"
        );
    }
}

const fn resolution_gap_label(kind: ResolutionGapKind) -> &'static str {
    match kind {
        ResolutionGapKind::NodeBuiltin => "node built-in",
        ResolutionGapKind::External => "external reference",
        ResolutionGapKind::Ambiguous => "ambiguous reference",
        ResolutionGapKind::Unresolved => "unresolved reference",
        ResolutionGapKind::UnsupportedDynamic => "unsupported dynamic reference",
    }
}

fn append_interface_coverage(output: &mut String, coverage: &super::model::InterfaceCoverage) {
    let _ = writeln!(
        output,
        concat!(
            "interface coverage: {}/{} files complete; {} partial, {} unsupported, ",
            "{} parser failures, {} truncated"
        ),
        coverage.complete_files,
        coverage.files,
        coverage.partial_files,
        coverage.unsupported_files,
        coverage.parser_failed_files,
        coverage.truncated_files,
    );
}

fn append_dedup_coverage(output: &mut String, coverage: &super::model::FingerprintCoverage) {
    let _ = writeln!(
        output,
        concat!(
            "duplication coverage: {}/{} files complete; {} unsupported, ",
            "{} parser failures, {} truncated"
        ),
        coverage.complete_files,
        coverage.files,
        coverage.unsupported_files,
        coverage.parser_failed_files,
        coverage.truncated_files,
    );
}

pub(crate) fn enforce_report(
    report: &SenseReport,
    advisory: bool,
    allow_partial: bool,
    allow_node_builtins: bool,
) -> Result<()> {
    if report.status == SenseStatus::Incomplete {
        anyhow::bail!("sense did not complete");
    }
    if partial_coverage_blocks(report, allow_partial, allow_node_builtins) {
        if partial_only_for_node_builtins(report) {
            anyhow::bail!(concat!(
                "sense coverage is partial because Node built-in implementations were not ",
                "checked; inspect the report and pass --allow-node-builtins to acknowledge only ",
                "these boundaries"
            ));
        }
        anyhow::bail!(concat!(
            "sense coverage is partial; inspect the report and pass --allow-partial only ",
            "if the stated gaps are acceptable"
        ));
    }
    if !advisory && has_sense_findings(report) {
        anyhow::bail!("sense requires intervention");
    }
    Ok(())
}

fn partial_coverage_blocks(
    report: &SenseReport,
    allow_partial: bool,
    allow_node_builtins: bool,
) -> bool {
    report.status == SenseStatus::Partial
        && report.changed_files > 0
        && !allow_partial
        && !(allow_node_builtins && partial_only_for_node_builtins(report))
}

fn has_sense_findings(report: &SenseReport) -> bool {
    !report.introduced_cycles.is_empty()
        || !report.introduced_duplicates.is_empty()
        || !report.interface_findings.is_empty()
        || !report.documentation_requirements.is_empty()
}

fn partial_only_for_node_builtins(report: &SenseReport) -> bool {
    let views = [&report.before, &report.after];
    let builtins = views
        .iter()
        .map(|view| view.coverage.node_builtin_references)
        .sum::<usize>();
    builtins > 0
        && views.iter().all(|view| {
            !has_non_builtin_resolution_gap(&view.coverage)
                && !has_interface_gap(&view.interface_coverage)
        })
        && !report.observations.impact_truncated
        && !has_partial_dedup_gap(report)
}

fn has_non_builtin_resolution_gap(coverage: &ResolutionCoverage) -> bool {
    coverage.unsupported_files > 0
        || coverage.parser_failed_files > 0
        || coverage.external_references > coverage.node_builtin_references
        || coverage.ambiguous_references > 0
        || coverage.unresolved_references > 0
        || coverage.unsupported_dynamic_references > 0
}

fn has_interface_gap(coverage: &super::model::InterfaceCoverage) -> bool {
    coverage.partial_files > 0
        || coverage.unsupported_files > 0
        || coverage.parser_failed_files > 0
        || coverage.partial_public_surfaces > 0
        || coverage.unsupported_public_surfaces > 0
}

fn has_partial_dedup_gap(report: &SenseReport) -> bool {
    report.dedup_coverage.before.unsupported_files > 0
        || report.dedup_coverage.after.unsupported_files > 0
        || report.dedup_coverage.before.parser_failed_files > 0
        || report.dedup_coverage.after.parser_failed_files > 0
}

fn emit_failure(args: &SenseArgs, code: &str, message: String, started: Instant) -> Result<()> {
    if args.json {
        let mut report = incomplete_report(code, message, started);
        let rendered = prepare_output(&mut report, true, started)?;
        emit_prepared(&rendered)?;
    }
    Ok(())
}

fn incomplete_report(code: &str, message: String, started: Instant) -> SenseReport {
    let empty_view = || GraphViewSummary {
        view_id: "unavailable".into(),
        files: 0,
        runtime_edges: 0,
        type_only_edges: 0,
        structural_edges: 0,
        coverage: ResolutionCoverage::default(),
        resolution_gaps: Vec::new(),
        resolution_gaps_truncated: false,
        interface_edges: 0,
        interface_coverage: super::model::InterfaceCoverage::default(),
    };
    SenseReport {
        status: SenseStatus::Incomplete,
        issues: vec![SenseIssue::new(code, message)],
        introduced_cycles: Vec::new(),
        introduced_duplicates: Vec::new(),
        interface_findings: Vec::new(),
        documentation_requirements: Vec::new(),
        findings_truncated: false,
        dedup_coverage: DedupCoverage::default(),
        documentation_coverage: DocumentationCoverage::default(),
        observations: SenseObservations::default(),
        effective_policy: effective_policy(&SenseOptions::default()),
        before: empty_view(),
        after: empty_view(),
        changed_files: 0,
        valid_as_of: "unavailable".into(),
        provider: ProviderMetadata::default(),
        timing: SenseTiming {
            total_us: elapsed_us(started),
            ..SenseTiming::default()
        },
        cache: MemoryFactCache::new().metadata(),
    }
}

fn elapsed_us(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        path::RepoPath,
        sense::model::{DependencyEdge, EdgeKind, IntroducedCycle},
    };

    #[test]
    fn final_json_bytes_are_bounded_after_timings_are_populated() {
        let mut report = incomplete_report("test", "test".into(), Instant::now());
        report.status = SenseStatus::Findings;
        report.issues.clear();
        let path = RepoPath::new(vec![0xff; 4_096]).unwrap();
        for _ in 0..32 {
            report.introduced_cycles.push(IntroducedCycle {
                member_count: 10,
                members: vec![path.clone(); 10],
                members_truncated: false,
                trigger: DependencyEdge {
                    from: path.clone(),
                    to: path.clone(),
                    kind: EdgeKind::Runtime,
                },
                witness: vec![path.clone(); 10],
                witness_truncated: false,
            });
        }

        let started = Instant::now();
        let rendered = prepare_output(&mut report, true, started).unwrap();
        assert_eq!(report.status, SenseStatus::Incomplete);
        assert!(rendered.len() <= MAX_ASSESSMENT_BYTES);
        let emitted: serde_json::Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(emitted["timing"]["totalUs"], report.timing.total_us);
        assert_eq!(emitted["timing"]["renderUs"], report.timing.render_us);
        assert!(report.introduced_cycles[0].members.is_empty());
    }

    #[test]
    fn irreducible_oversize_is_a_bounded_structured_failure() {
        for json in [false, true] {
            let started = Instant::now();
            let mut report =
                incomplete_report("oversize", "x".repeat(MAX_ASSESSMENT_BYTES + 1), started);
            let rendered = prepare_output(&mut report, json, started).unwrap();

            assert!(rendered.len() <= MAX_ASSESSMENT_BYTES);
            assert_eq!(report.status, SenseStatus::Incomplete);
            assert_eq!(report.issues.len(), 1);
            assert_eq!(report.issues[0].code, "output_too_large");
            if json {
                let emitted: SenseReport = serde_json::from_str(&rendered).unwrap();
                assert_eq!(emitted.status, SenseStatus::Incomplete);
                assert_eq!(emitted.issues[0].code, "output_too_large");
                assert_eq!(emitted.timing.total_us, report.timing.total_us);
                assert_eq!(emitted.timing.render_us, report.timing.render_us);
            } else {
                assert!(rendered.contains("output_too_large"));
            }
        }
    }
}
