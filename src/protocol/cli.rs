use std::{fmt::Write as _, path::PathBuf, sync::Arc, time::Instant};

use anyhow::{Context, Result};
use clap::{Args, ValueEnum};

use crate::{
    cancel::CancelToken,
    engine::{Engine, EvaluationRequest},
    local::repository_fact_cache,
    model::{
        Assessment, AssessmentStatus, CacheMetadata, Comparison, Coverage, CoverageGap,
        CoverageStatus, ProviderMetadata, Scope, Timing,
    },
    path::RepoPath,
    policy::{ConfigView, PolicySnapshot, Workflow},
    source::git::{GitCapture, GitRepository, GitScope},
};

/// Provider set selected for the private local ASP host.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, ValueEnum)]
pub enum CheckProvider {
    /// Every applicable bundled provider; inapplicable profiles are reported as skipped.
    All,
    /// Built-in parsing and deterministic source checks; never executes repository code.
    Fast,
    /// Cargo Check in private scratch; requires trusted code or an external sandbox.
    RustNative,
    /// Locked, offline project-local TypeScript checking in private scratch.
    NodeNative,
    /// Host Pyright or mypy with the selected Python interpreter in private scratch.
    PythonNative,
}

/// Comparison selected for the private local ASP host.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, ValueEnum)]
pub enum CheckComparison {
    /// Report diagnostics introduced since the exact baseline.
    Introduced,
    /// Report every diagnostic in the selected current provider workspace.
    All,
}

impl CheckComparison {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Introduced => "introduced",
            Self::All => "all",
        }
    }
}

impl CheckProvider {
    pub(crate) const fn profile(self) -> Option<super::asp::ProviderProfile> {
        match self {
            Self::All => None,
            Self::Fast => Some(super::asp::ProviderProfile::Fast),
            Self::RustNative => Some(super::asp::ProviderProfile::RustNative),
            Self::NodeNative => Some(super::asp::ProviderProfile::NodeNative),
            Self::PythonNative => Some(super::asp::ProviderProfile::PythonNative),
        }
    }
}

/// Select a local Git view, output format, and optional ASP providers.
///
/// With no selection flag, Check compares supported worktree changes with HEAD.
/// File paths are literal repository-relative paths; no glob syntax is supported.
#[derive(Clone, Debug, Default, Args)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Clap requires independent fields for the mutually constrained command-line flags"
)]
pub struct CheckArgs {
    /// Git repository or a directory inside it (default: current directory).
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,
    /// Check worktree changes against HEAD, including non-ignored untracked source (the default).
    #[arg(long, conflicts_with_all = ["committed", "staged", "tree", "all", "files"])]
    pub changed: bool,
    /// Check the staged index against HEAD; ignore unstaged and untracked worktree changes.
    #[arg(long, conflicts_with_all = ["committed", "changed", "tree", "files"])]
    pub staged: bool,
    /// Check the complete selected view, including existing findings; combine with --staged or --tree.
    #[arg(long, conflicts_with_all = ["committed", "changed", "files"])]
    pub all: bool,
    /// Check the committed HEAD tree without index or worktree overlays.
    #[arg(long, conflicts_with_all = ["changed", "staged", "tree", "all", "files", "base"])]
    pub committed: bool,
    /// Check comma-separated literal paths relative to the repository root; no globs.
    #[arg(long, value_delimiter = ',', conflicts_with_all = ["committed", "changed", "staged", "tree", "all"])]
    pub files: Vec<String>,
    /// Compare changed or staged content against this Git ref.
    #[arg(long, value_name = "REF", conflicts_with = "all")]
    pub base: Option<String>,
    /// Check an immutable committed tree, optionally against --base.
    #[arg(long, value_name = "REF", conflicts_with_all = ["committed", "changed", "staged", "files"])]
    pub tree: Option<String>,
    /// Print the structured assessment as JSON, including coverage and evidence.
    #[arg(long)]
    pub json: bool,
    /// Report findings without returning a blocking exit status.
    #[arg(long)]
    pub advisory: bool,
    /// Also run Cargo Check through the unsandboxed local ASP host. Requires explicit consent.
    #[arg(
        long,
        conflicts_with_all = ["files", "providers"]
    )]
    pub native: bool,
    /// Run an explicit comma-separated provider set through the private local ASP host.
    #[arg(
        long,
        value_enum,
        value_delimiter = ',',
        value_name = "PROVIDER",
        conflicts_with = "files"
    )]
    pub providers: Vec<CheckProvider>,
    /// Confirm that selected native tools may run repository code with host access.
    #[arg(long)]
    pub allow_unsandboxed_native: bool,
    /// Select introduced or all diagnostics in the selected provider view.
    #[arg(long, value_enum, value_name = "MODE", conflicts_with = "files")]
    pub comparison: Option<CheckComparison>,
    /// Focus each provider on comma-separated subfolders while retaining required project context.
    #[arg(
        long,
        value_delimiter = ',',
        value_name = "PATH",
        conflicts_with = "files"
    )]
    pub roots: Vec<String>,
    /// Apply this workflow's settings to the explicitly selected source view.
    #[arg(long, value_enum)]
    pub workflow: Option<Workflow>,
}

impl CheckArgs {
    pub(crate) fn config_view(&self) -> ConfigView {
        if let Some(tree) = &self.tree {
            ConfigView::Tree(tree.clone())
        } else if self.committed {
            ConfigView::Tree("HEAD".into())
        } else if self.staged {
            ConfigView::Index
        } else {
            ConfigView::Worktree
        }
    }
}

/// Evaluates the selected immutable local Git view and renders its assessment.
///
/// # Errors
///
/// Returns an error for invalid scope input, repository capture/freshness failure, incomplete
/// blocking results, findings, or output failure.
pub async fn run(args: CheckArgs) -> Result<()> {
    let repository = match GitRepository::discover(&args.repo) {
        Ok(repository) => repository,
        Err(error) => {
            let started = Instant::now();
            let reason = format!("discover Git repository: {error}");
            render_capture_error(args.json, reason.clone(), started)?;
            return Err(anyhow::Error::new(error).context("discover Git repository"));
        }
    };
    run_in_repository(args, repository).await
}

pub(crate) async fn run_in_repository(args: CheckArgs, repository: GitRepository) -> Result<()> {
    if args.native
        || !args.providers.is_empty()
        || !args.roots.is_empty()
        || args.comparison.is_some()
        || args.allow_unsandboxed_native
    {
        return super::host_cli::run(args, repository).await;
    }
    let explicit = explicit_paths(&args.files)?;
    let git_scope = git_scope(&args, &explicit);
    let engine = Engine::with_cache(repository_fact_cache(&repository));
    let (assessment, rendered) =
        stable_assessment(&args, &repository, git_scope, &explicit, &engine).await?;
    println!("{}", rendered.trim_end());
    enforce_status(assessment.status, args.advisory)
}

fn explicit_paths(paths: &[String]) -> Result<Vec<RepoPath>> {
    paths
        .iter()
        .map(|path| RepoPath::from_protocol(path).map_err(anyhow::Error::from))
        .collect::<Result<_>>()
        .context("validate explicit path")
}

fn git_scope(args: &CheckArgs, explicit: &[RepoPath]) -> GitScope {
    if args.tree.is_some() {
        GitScope::Tree
    } else if args.committed {
        GitScope::Committed
    } else if args.staged && args.all {
        GitScope::StagedAll
    } else if args.staged {
        GitScope::Staged
    } else if args.all {
        GitScope::All
    } else if !explicit.is_empty() {
        GitScope::Explicit
    } else {
        GitScope::Changed
    }
}

async fn stable_assessment(
    args: &CheckArgs,
    repository: &GitRepository,
    git_scope: GitScope,
    explicit: &[RepoPath],
    engine: &Engine,
) -> Result<(Assessment, String)> {
    let selection = GitSelection {
        scope: git_scope,
        explicit,
        base_ref: args.base.as_deref().filter(|_| !args.all),
        tree_ref: args.tree.as_deref(),
    };
    for attempt in 0..2 {
        let capture_started = Instant::now();
        let policy = capture_policy(args, repository, capture_started)?;
        let selected = repository.with_targets(&policy.policy.targets);
        let capture = capture_source(&selected, selection, args.json, capture_started)?;
        let mut assessment = evaluate_capture(args, engine, &capture, &policy).await?;
        mark_empty_selection(&mut assessment, args);
        let rendered = render_assessment(&assessment, &policy, args.json)?;
        let stale_reason = freshness_error(&selected, &capture, selection)
            .or_else(|| policy_freshness_error(&policy));
        if let Some(error) = stale_reason {
            if attempt == 0 {
                continue;
            }
            render_capture_error(args.json, error.clone(), capture_started)?;
            anyhow::bail!(error);
        }
        return Ok((assessment, rendered));
    }
    anyhow::bail!("bounded evaluation loop completed without an assessment")
}

fn capture_policy(
    args: &CheckArgs,
    repository: &GitRepository,
    started: Instant,
) -> Result<PolicySnapshot> {
    match PolicySnapshot::capture(repository, args.config_view(), args.workflow) {
        Ok(policy) => Ok(policy),
        Err(error) => {
            let reason = format!("load repository policy: {error:#}");
            render_capture_error(args.json, reason.clone(), started)?;
            anyhow::bail!(reason);
        }
    }
}

pub(crate) async fn assess_with_policy(
    args: &CheckArgs,
    repository: &GitRepository,
    policy: &PolicySnapshot,
) -> Result<Assessment> {
    let explicit = explicit_paths(&args.files)?;
    let selection = GitSelection {
        scope: git_scope(args, &explicit),
        explicit: &explicit,
        base_ref: args.base.as_deref().filter(|_| !args.all),
        tree_ref: args.tree.as_deref(),
    };
    let selected = repository.with_targets(&policy.policy.targets);
    let capture = capture_source(&selected, selection, false, Instant::now())?;
    let engine = Engine::with_cache(repository_fact_cache(&selected));
    let mut assessment = evaluate_capture(args, &engine, &capture, policy).await?;
    if let Some(reason) = freshness_error(&selected, &capture, selection) {
        anyhow::bail!(reason);
    }
    mark_empty_selection(&mut assessment, args);
    Ok(assessment)
}

#[derive(Clone, Copy)]
struct GitSelection<'a> {
    scope: GitScope,
    explicit: &'a [RepoPath],
    base_ref: Option<&'a str>,
    tree_ref: Option<&'a str>,
}

fn capture_source(
    repository: &GitRepository,
    selection: GitSelection<'_>,
    json: bool,
    started: Instant,
) -> Result<GitCapture> {
    match repository.capture_from(
        selection.scope,
        selection.explicit,
        selection.base_ref,
        selection.tree_ref,
    ) {
        Ok(capture) => Ok(capture),
        Err(error) => {
            render_capture_error(json, error.to_string(), started)?;
            Err(anyhow::Error::new(error).context("capture immutable Git source view"))
        }
    }
}

async fn evaluate_capture(
    args: &CheckArgs,
    engine: &Engine,
    capture: &GitCapture,
    policy: &PolicySnapshot,
) -> Result<Assessment> {
    let all = args.all || args.committed || (args.tree.is_some() && args.base.is_none());
    engine
        .evaluate(
            EvaluationRequest {
                before: Some(Arc::clone(&capture.before)),
                after: Arc::clone(&capture.after),
                scope: if all {
                    Scope::Workspace
                } else {
                    Scope::Changeset
                },
                comparison: if all {
                    Comparison::All
                } else {
                    Comparison::Introduced
                },
                paths: capture.paths.clone(),
                limits: policy.policy.verify,
                valid_as_of: policy.bind_valid_as_of(&capture.valid_as_of),
                public_fingerprint_comparison: false,
            },
            CancelToken::new(),
        )
        .await
}

fn policy_freshness_error(policy: &PolicySnapshot) -> Option<String> {
    match policy.is_current() {
        Ok(true) => None,
        Ok(false) => Some("repository policy changed before the assessment was returned".into()),
        Err(error) => Some(format!("could not revalidate repository policy: {error:#}")),
    }
}

fn freshness_error(
    repository: &GitRepository,
    capture: &GitCapture,
    selection: GitSelection<'_>,
) -> Option<String> {
    match repository.is_current_from(
        capture,
        selection.scope,
        selection.explicit,
        selection.base_ref,
        selection.tree_ref,
    ) {
        Ok(true) => None,
        Ok(false) => Some("Git source view changed before the assessment could be returned".into()),
        Err(error) => Some(format!("could not revalidate Git source view: {error}")),
    }
}

fn render_capture_error(json: bool, reason: String, started: Instant) -> Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string(&capture_error_assessment(reason, started))?
        );
    }
    Ok(())
}

fn render_assessment(
    assessment: &Assessment,
    policy: &PolicySnapshot,
    json: bool,
) -> Result<String> {
    if json {
        let mut value = serde_json::to_value(assessment)?;
        value
            .as_object_mut()
            .context("assessment JSON must be an object")?
            .insert("configuration".into(), policy.report_configuration());
        Ok(serde_json::to_string(&value)?)
    } else {
        Ok(render_human(assessment))
    }
}

pub(crate) fn enforce_status(status: AssessmentStatus, advisory: bool) -> Result<()> {
    match status {
        AssessmentStatus::Findings if !advisory => {
            anyhow::bail!("verification requires intervention")
        }
        AssessmentStatus::Error | AssessmentStatus::Cancelled | AssessmentStatus::Incomplete => {
            anyhow::bail!("evaluation did not complete")
        }
        AssessmentStatus::Clean
        | AssessmentStatus::Findings
        | AssessmentStatus::NotChecked
        | AssessmentStatus::Unsupported => Ok(()),
    }
}

fn mark_empty_selection(assessment: &mut Assessment, args: &CheckArgs) {
    if assessment.coverage.files_considered != 0 {
        return;
    }
    let (status, coverage_status, reason) = if args.all
        || args.committed
        || (args.tree.is_some() && args.base.is_none())
    {
        (
            AssessmentStatus::NotChecked,
            CoverageStatus::NotChecked,
            "No supported source files were found in the selected project view.",
        )
    } else if !args.files.is_empty() {
        (
            AssessmentStatus::NotChecked,
            CoverageStatus::NotChecked,
            "None of the explicit paths selected a supported regular source file.",
        )
    } else {
        (
            AssessmentStatus::NotChecked,
            CoverageStatus::NotChecked,
            "No supported source changes were selected. Run `opcore check --repo . --all` to check the whole project.",
        )
    };
    assessment.status = status;
    assessment.coverage.gaps.push(CoverageGap {
        path: RepoPath::request_marker(),
        status: coverage_status,
        language: None,
        reason: Some(reason.into()),
    });
}

pub(crate) fn render_human(assessment: &Assessment) -> String {
    let mut output = String::new();
    if assessment.coverage.files_considered == 0 {
        output.push_str("opcore: Nothing checked (0 supported files)\n");
        for item in &assessment.coverage.gaps {
            if let Some(reason) = &item.reason {
                let _ = writeln!(output, "next: {reason}");
            }
        }
        return output;
    }
    let _ = writeln!(
        output,
        "opcore: {:?} ({} diagnostics, {}/{} files covered, {} coverage warnings, {} ms)",
        assessment.status,
        assessment.diagnostics.len(),
        assessment.coverage.files_covered,
        assessment.coverage.files_considered,
        assessment
            .coverage
            .gaps
            .iter()
            .filter(|item| item.status == CoverageStatus::Unsupported)
            .count(),
        assessment.timing.duration_ms
    );
    for diagnostic in &assessment.diagnostics {
        let line = diagnostic.range.map_or(0, |range| range.start.line);
        let _ = writeln!(
            output,
            "{}:{line}: {}: {}",
            diagnostic.path, diagnostic.rule_id, diagnostic.message
        );
    }
    for item in &assessment.coverage.gaps {
        if item.status == CoverageStatus::Unsupported {
            let _ = writeln!(
                output,
                "{}: warning: unsupported coverage: {}",
                item.path,
                item.reason.as_deref().unwrap_or("no reason")
            );
        } else {
            let _ = writeln!(
                output,
                "{}: {:?}: {}",
                item.path,
                item.status,
                item.reason.as_deref().unwrap_or("no reason")
            );
        }
    }
    output
}

fn capture_error_assessment(reason: String, started: Instant) -> Assessment {
    let path = RepoPath::request_marker();
    Assessment {
        status: AssessmentStatus::Incomplete,
        diagnostics: Vec::new(),
        coverage: Coverage {
            files_considered: 1,
            files_covered: 0,
            gaps: vec![CoverageGap {
                path,
                status: CoverageStatus::Incomplete,
                language: None,
                reason: Some(reason),
            }],
        },
        valid_as_of: "unavailable".into(),
        provider: ProviderMetadata::default(),
        timing: Timing {
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            ..Timing::default()
        },
        cache: CacheMetadata {
            state: "unavailable".into(),
            ..CacheMetadata::default()
        },
    }
}
