//! Local composition of the built-in checks over one selected Git view.

use std::{collections::BTreeSet, ops::Deref, path::PathBuf};

use anyhow::{Context, Result, ensure};
use clap::Args;
use serde_json::{Value, json};

use crate::{
    limits::MAX_ASSESSMENT_BYTES,
    model::Assessment,
    path::RepoPath,
    policy::{ConfigView, NativeProvider, POLICY_PATH, PolicySnapshot, Workflow},
    protocol::{
        cli::{self, CheckArgs, CheckComparison, CheckProvider},
        host_cli::{self, HostEvaluation},
    },
    sense::{
        cli as sense_cli,
        model::{SenseReport, SenseStatus},
    },
    source::git::GitRepository,
};

/// Run the built-in checks with repository and workflow settings.
#[derive(Clone, Debug, Args)]
pub struct RunArgs {
    /// Post-edit checks worktree changes; pre-commit checks the full index; CI checks a commit.
    #[arg(value_enum)]
    pub workflow: Workflow,
    /// Repository directory; nested paths resolve to the Git worktree root.
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,
    /// CI target commit or tree (default: HEAD); never reads worktree overlays.
    #[arg(long, value_name = "REF")]
    pub tree: Option<String>,
    /// CI baseline for Sense and introduced Verify/native findings; supply the intended commit.
    #[arg(long, value_name = "REF")]
    pub base: Option<String>,
    /// Emit one structured report containing every selected check.
    #[arg(long)]
    pub json: bool,
    /// Authorize selected native tools to execute trusted repository code with host access.
    #[arg(long)]
    pub allow_unsandboxed_native: bool,
}

impl RunArgs {
    pub(crate) fn view(&self) -> ConfigView {
        match self.workflow {
            Workflow::PostEdit => ConfigView::Worktree,
            Workflow::PreCommit => ConfigView::Index,
            Workflow::Ci => ConfigView::Tree(self.tree.clone().unwrap_or_else(|| "HEAD".into())),
        }
    }
}

struct RunRequest<'a> {
    args: &'a RunArgs,
    comparison: Option<CheckComparison>,
}

impl Deref for RunRequest<'_> {
    type Target = RunArgs;

    fn deref(&self) -> &Self::Target {
        self.args
    }
}

impl RunRequest<'_> {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.workflow != Workflow::PostEdit || self.comparison.is_none(),
            "--comparison applies only to the pre-commit and ci workflows"
        );
        if self.workflow == Workflow::Ci {
            ensure!(
                self.base.is_some(),
                "CI Sense requires --base <commit>; fetch and supply the intended comparison base"
            );
        } else {
            ensure!(
                self.base.is_none() && self.tree.is_none(),
                "--base and --tree apply only to the ci workflow"
            );
        }
        Ok(())
    }

    const fn comparison(&self) -> CheckComparison {
        match self.args.workflow {
            Workflow::PostEdit => CheckComparison::Introduced,
            Workflow::PreCommit | Workflow::Ci => match self.comparison {
                Some(comparison) => comparison,
                None => CheckComparison::All,
            },
        }
    }
}

pub(crate) struct WorkflowEvaluation {
    pub(crate) verify: Assessment,
    pub(crate) sense: SenseReport,
    pub(crate) native: Option<HostEvaluation>,
    pub(crate) configuration: PolicySnapshot,
    rendered: String,
}

impl WorkflowEvaluation {
    pub(crate) fn enforce(&self) -> Result<()> {
        cli::enforce_status(self.verify.status, false)?;
        let coverage = &self.configuration.policy.coverage;
        let sense_result = sense_cli::enforce_report(
            &self.sense,
            false,
            coverage.allow_partial,
            coverage.allow_node_builtins,
        );
        if self.sense.status == SenseStatus::Partial && sense_result.is_err() {
            let workflow = self
                .configuration
                .workflow
                .context("workflow settings are unavailable")?;
            anyhow::bail!(
                "Sense requirements were not satisfied; rerun the same command with --json and inspect .opcore.json workflows.{}.coverage. Findings still require repair",
                workflow.as_str()
            );
        }
        sense_result?;
        ensure!(
            self.native.as_ref().is_none_or(|result| result.passed),
            "required native checks did not pass; inspect the provider diagnostics and coverage"
        );
        Ok(())
    }

    fn report(&self, args: &RunRequest<'_>) -> Value {
        json!({
            "schema": "opcore.workflow.v1",
            "workflow": args.workflow,
            "comparison": args.comparison().as_str(),
            "status": if self.enforce().is_ok() { "accepted" } else { "requires_attention" },
            "configuration": self.configuration.report_configuration(),
            "verify": self.verify,
            "sense": self.sense,
            "native": self.native.as_ref().map(|result| &result.report),
        })
    }

    fn render(&self, args: &RunRequest<'_>) -> Result<String> {
        if args.json {
            return bounded_json(&self.report(args));
        }
        let mut output = format!("opcore workflow: {}\n", args.workflow.as_str());
        output.push_str(&cli::render_human(&self.verify));
        output.push_str(&sense_cli::render_output(&self.sense, false)?);
        if let Some(native) = &self.native {
            output.push_str(&native.human);
        }
        ensure!(
            output.len() <= MAX_ASSESSMENT_BYTES,
            "workflow report exceeds the output byte limit"
        );
        Ok(output)
    }
}

/// Executes a workflow and prints its combined result.
///
/// # Errors
///
/// Returns an error for invalid configuration, stale or unavailable coverage, or required findings.
pub async fn run(args: RunArgs) -> Result<()> {
    run_request(&RunRequest {
        args: &args,
        comparison: None,
    })
    .await
}

/// Executes a workflow with an explicit Verify/native comparison and prints its combined result.
///
/// # Errors
///
/// Returns an error for invalid configuration, stale or unavailable coverage, or required findings.
pub async fn run_with_comparison(args: RunArgs, comparison: CheckComparison) -> Result<()> {
    run_request(&RunRequest {
        args: &args,
        comparison: Some(comparison),
    })
    .await
}

async fn run_request(args: &RunRequest<'_>) -> Result<()> {
    let outcome = run_inner(args).await;
    match outcome {
        Ok(result) => {
            println!("{}", result.rendered.trim_end());
            result.enforce()
        }
        Err(error) => {
            if args.json {
                let report = json!({
                    "schema": "opcore.workflow.v1",
                    "workflow": args.workflow,
                    "comparison": args.comparison().as_str(),
                    "status": "incomplete",
                    "error": format!("{error:#}"),
                });
                println!("{}", bounded_json(&report)?);
            }
            Err(error)
        }
    }
}

async fn run_inner(args: &RunRequest<'_>) -> Result<WorkflowEvaluation> {
    args.validate()?;
    let repository = GitRepository::discover(&args.repo).context("discover workflow repository")?;
    evaluate_request(args, &repository).await
}

pub(crate) async fn evaluate(
    args: &RunArgs,
    repository: &GitRepository,
) -> Result<WorkflowEvaluation> {
    let request = RunRequest {
        args,
        comparison: None,
    };
    evaluate_request(&request, repository).await
}

async fn evaluate_request(
    args: &RunRequest<'_>,
    repository: &GitRepository,
) -> Result<WorkflowEvaluation> {
    for attempt in 0..2 {
        let configuration = PolicySnapshot::capture(repository, args.view(), Some(args.workflow))?;
        configuration.require_bundled_runner()?;
        ensure!(
            configuration.policy.native.is_empty() || args.allow_unsandboxed_native,
            "this workflow requires native checks; run in a trusted environment and pass --allow-unsandboxed-native"
        );
        let selected = repository.with_targets(&configuration.policy.targets);
        let auxiliary = auxiliary_paths(&configuration)?;
        let before =
            selected.observation_with_auxiliary(&args.view(), args.base.as_deref(), &auxiliary)?;
        let mut result = evaluate_once(args, repository, configuration).await?;
        // Render before freshness validation so expensive serialization cannot hide a stale view.
        result.rendered = result.render(args)?;
        if is_current(args, repository, &before, &result)? {
            return Ok(result);
        }
        ensure!(
            attempt == 0,
            "source or configuration changed during the workflow; rerun the same command"
        );
    }
    anyhow::bail!("workflow freshness retry exhausted")
}

fn is_current(
    args: &RunRequest<'_>,
    repository: &GitRepository,
    before: &str,
    result: &WorkflowEvaluation,
) -> Result<bool> {
    let selected = repository.with_targets(&result.configuration.policy.targets);
    let auxiliary = auxiliary_paths(&result.configuration)?;
    let native_current = result
        .native
        .as_ref()
        .map(|native| native.is_current(repository))
        .transpose()?
        .unwrap_or(true);
    Ok(before
        == selected.observation_with_auxiliary(&args.view(), args.base.as_deref(), &auxiliary)?
        && result.configuration.is_current()?
        && native_current)
}

fn auxiliary_paths(configuration: &PolicySnapshot) -> Result<BTreeSet<RepoPath>> {
    let mut paths = configuration
        .policy
        .documentation
        .bindings
        .iter()
        .map(|binding| binding.document.clone())
        .collect::<BTreeSet<_>>();
    paths.insert(RepoPath::from_protocol(POLICY_PATH)?);
    Ok(paths)
}

async fn evaluate_once(
    args: &RunRequest<'_>,
    repository: &GitRepository,
    configuration: PolicySnapshot,
) -> Result<WorkflowEvaluation> {
    let mut check = check_args(args);
    let verify = cli::assess_with_policy(&check, repository, &configuration)
        .await
        .context("Verify could not complete")?;
    let sense = sense_cli::assess(&sense_args(args), repository, &configuration)
        .await
        .context("Sense could not complete")?;
    let native = if configuration.policy.native.is_empty() {
        None
    } else {
        check.providers = configuration
            .policy
            .native
            .iter()
            .map(|provider| match provider {
                NativeProvider::RustNative => CheckProvider::RustNative,
                NativeProvider::NodeNative => CheckProvider::NodeNative,
                NativeProvider::PythonNative => CheckProvider::PythonNative,
            })
            .collect();
        Some(host_cli::evaluate(&check, repository, &configuration).await?)
    };
    Ok(WorkflowEvaluation {
        verify,
        sense,
        native,
        configuration,
        rendered: String::new(),
    })
}

fn check_args(args: &RunRequest<'_>) -> CheckArgs {
    let comparison = args.comparison();
    CheckArgs {
        repo: args.repo.clone(),
        changed: args.workflow == Workflow::PostEdit,
        staged: args.workflow == Workflow::PreCommit,
        all: args.workflow != Workflow::PostEdit && comparison == CheckComparison::All,
        base: (comparison == CheckComparison::Introduced)
            .then(|| args.base.clone())
            .flatten(),
        tree: match args.view() {
            ConfigView::Tree(tree) => Some(tree),
            _ => None,
        },
        comparison: Some(comparison),
        workflow: Some(args.workflow),
        allow_unsandboxed_native: args.allow_unsandboxed_native,
        ..CheckArgs::default()
    }
}

fn sense_args(args: &RunRequest<'_>) -> sense_cli::SenseArgs {
    sense_cli::SenseArgs {
        repo: args.repo.clone(),
        json: false,
        advisory: false,
        allow_partial: false,
        allow_node_builtins: false,
        staged: args.workflow == Workflow::PreCommit,
        hypothetical: None,
        workflow: Some(args.workflow),
        tree: match args.view() {
            ConfigView::Tree(tree) => Some(tree),
            _ => None,
        },
        base: args.base.clone(),
    }
}

fn bounded_json(value: &Value) -> Result<String> {
    let output = serde_json::to_string(value)?;
    ensure!(
        output.len() <= MAX_ASSESSMENT_BYTES,
        "workflow report exceeds the output byte limit"
    );
    Ok(output)
}
