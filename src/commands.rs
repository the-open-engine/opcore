//! Repository workflows and read-only operational commands.

pub(crate) mod workflows;

use std::{
    env,
    path::{Path, PathBuf},
};

use anyhow::{Context as _, Result};
use clap::Args;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    hooks::{self, Agent},
    policy::{
        ConfigView, NativeProvider, POLICY_PATH, POLICY_SCHEMA_VERSION, PolicySnapshot, Workflow,
    },
    protocol::{asp::build_digest, host_cli},
    source::git::GitRepository,
};

/// Repository selection and structured output for read-only operational commands.
#[derive(Clone, Debug, Args)]
pub struct RepositoryArgs {
    /// Repository directory; nested directories resolve to their Git worktree root.
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,
    /// Emit the stable machine-readable JSON report.
    #[arg(long)]
    pub json: bool,
    /// Inspect effective settings for this workflow; defaults to its usual Git view.
    #[arg(long, value_enum)]
    pub workflow: Option<Workflow>,
    /// Inspect staged configuration rather than worktree settings.
    #[arg(long, conflicts_with = "tree")]
    pub staged: bool,
    /// Inspect configuration from this immutable commit or tree.
    #[arg(long, value_name = "REF")]
    pub tree: Option<String>,
}

impl RepositoryArgs {
    fn config_view(&self) -> ConfigView {
        if self.staged {
            ConfigView::Index
        } else if let Some(tree) = &self.tree {
            ConfigView::Tree(tree.clone())
        } else {
            match self.workflow {
                Some(Workflow::PreCommit) => ConfigView::Index,
                Some(Workflow::Ci) => ConfigView::Tree("HEAD".into()),
                _ => ConfigView::Worktree,
            }
        }
    }
}

/// Prints read-only repository and policy status.
///
/// # Errors
///
/// Returns an error when the repository or policy cannot be read or the report cannot be encoded.
pub fn status(args: &RepositoryArgs) -> Result<()> {
    let repository = GitRepository::discover(&args.repo).context("discover Git repository")?;
    let policy = PolicySnapshot::capture(&repository, args.config_view(), args.workflow)
        .context("load selected repository configuration")?;
    let report = json!({
        "schema": "opcore.status.v2",
        "status": "fast_check_ready",
        "version": env!("CARGO_PKG_VERSION"),
        "buildFingerprint": build_digest(),
        "repository": {
            "root": repository.root(),
            "commonDir": repository.common_dir(),
            "repositoryId": repository.repository_id().hex(),
        },
        "policy": {
            "path": POLICY_PATH,
            "state": policy.state,
            "digest": policy.digest,
            "effective": policy.policy,
            "view": policy.view,
            "workflow": policy.workflow,
            "origins": policy.origins,
        },
        "runtime": {
            "persistentFacts": "content_only",
            "persistentGraph": false,
            "daemon": false,
        },
        "rules": {
            "verify": VERIFY_RULES.len(),
            "native": NATIVE_RULES.len(),
            "sense": SENSE_RULES.len(),
        },
    });
    if args.json {
        println!("{}", serde_json::to_string(&report)?);
    } else {
        println!(
            "configuration: {POLICY_PATH} ({:?}; {:?})",
            policy.state, policy.view
        );
        if let Some(workflow) = policy.workflow {
            println!("workflow: {}", workflow.as_str());
        }
        let native = policy
            .policy
            .native
            .iter()
            .map(|provider| provider.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "native providers: {}",
            if native.is_empty() { "none" } else { &native }
        );
        let effective = serde_json::to_value(&policy.policy)?;
        for (field, origin) in &policy.origins {
            if origin != "default" {
                println!(
                    "{field}: {} ({origin})",
                    effective.pointer(field).unwrap_or(&Value::Null)
                );
            }
        }
        println!("Use --json for all effective values and their origins.");
    }
    Ok(())
}

/// Prints read-only runtime diagnostics.
///
/// # Errors
///
/// Returns an error when any diagnostic is unhealthy or the report cannot be encoded.
pub fn doctor(args: &RepositoryArgs) -> Result<()> {
    let mut checks = Vec::new();
    let repository = check_repository(args, &mut checks);
    let policy = check_policy(args, repository.as_ref(), &mut checks);
    check_binary(&mut checks);
    check_native_tools(&mut checks);
    require_native_tools(policy.as_ref(), &mut checks);
    check_native_projects(repository.as_ref(), policy.as_ref(), &mut checks);
    check_agent_hooks(&mut checks);
    finish_doctor(args, &checks)
}

fn check_agent_hooks(checks: &mut Vec<DoctorCheck>) {
    for (agent, id) in [(Agent::Codex, "codex_hook"), (Agent::Claude, "claude_hook")] {
        match hooks::diagnose(agent) {
            Ok(Some(detail)) => checks.push(DoctorCheck::pass(id, detail)),
            Ok(None) => checks.push(DoctorCheck::skip(
                id,
                "no installed hook; CLI-only checks remain available",
            )),
            Err(error) => checks.push(DoctorCheck::fail(id, format!("{error:#}"))),
        }
    }
}

fn check_repository(args: &RepositoryArgs, checks: &mut Vec<DoctorCheck>) -> Option<GitRepository> {
    match GitRepository::discover(&args.repo) {
        Ok(repository) => {
            checks.push(DoctorCheck::pass(
                "git_repository",
                "Git repository discovered",
            ));
            Some(repository)
        }
        Err(error) => {
            checks.push(DoctorCheck::fail("git_repository", error.to_string()));
            None
        }
    }
}

fn check_policy(
    args: &RepositoryArgs,
    repository: Option<&GitRepository>,
    checks: &mut Vec<DoctorCheck>,
) -> Option<PolicySnapshot> {
    if let Some(repository) = repository {
        match PolicySnapshot::capture(repository, args.config_view(), args.workflow) {
            Ok(policy) => {
                checks.push(DoctorCheck::pass(
                    "policy",
                    format!(
                        "{:?} configuration ({:?}) {}",
                        policy.state, policy.view, policy.digest
                    ),
                ));
                return Some(policy);
            }
            Err(error) => checks.push(DoctorCheck::fail("policy", format!("{error:#}"))),
        }
    } else {
        checks.push(DoctorCheck::skip("policy", "repository unavailable"));
    }
    None
}

fn require_native_tools(policy: Option<&PolicySnapshot>, checks: &mut [DoctorCheck]) {
    let Some(policy) = policy else { return };
    for provider in &policy.policy.native {
        let required: &[&str] = match provider {
            NativeProvider::RustNative => &["rust_native_tool", "rust_native_runtime"],
            NativeProvider::NodeNative => &["node_native_tool", "node_native_runtime"],
            NativeProvider::PythonNative => &["python_native_checker"],
        };
        for check in checks
            .iter_mut()
            .filter(|check| required.contains(&check.id))
        {
            if check.status == "skip" {
                check.status = "fail";
                check.detail = format!(
                    "required {} prerequisite unavailable: {}. Install the tool and rerun doctor with the same --workflow",
                    provider.as_str(),
                    check.detail
                );
            }
        }
    }
}

fn check_native_projects(
    repository: Option<&GitRepository>,
    policy: Option<&PolicySnapshot>,
    checks: &mut Vec<DoctorCheck>,
) {
    let (Some(repository), Some(policy)) = (repository, policy) else {
        return;
    };
    for (provider, result) in host_cli::inspect_native_projects(repository, policy) {
        let id = match provider {
            NativeProvider::RustNative => "rust_native_project",
            NativeProvider::NodeNative => "node_native_project",
            NativeProvider::PythonNative => "python_native_project",
        };
        checks.push(match result {
            Ok(detail) => DoctorCheck::pass(id, detail),
            Err(error) => DoctorCheck::fail(id, format!("{error:#}")),
        });
    }
}

fn check_binary(checks: &mut Vec<DoctorCheck>) {
    match std::env::current_exe().and_then(|path| path.metadata().map(|metadata| (path, metadata)))
    {
        Ok((path, metadata)) if metadata.is_file() => checks.push(DoctorCheck::pass(
            "binary",
            format!("{} ({})", path.display(), env!("CARGO_PKG_VERSION")),
        )),
        Ok((path, _)) => checks.push(DoctorCheck::fail(
            "binary",
            format!("{} is not a regular file", path.display()),
        )),
        Err(error) => checks.push(DoctorCheck::fail("binary", error.to_string())),
    }
}

fn check_native_tools(checks: &mut Vec<DoctorCheck>) {
    check_optional_tool(checks, "rust_native_tool", "OPCORE_CARGO", &["cargo"]);
    check_path_tools(checks, "rust_native_runtime", &["rustc"]);
    check_optional_tool(checks, "node_native_tool", "OPCORE_NPM", &["npm"]);
    check_path_tools(checks, "node_native_runtime", &["node"]);
    check_python_checker(checks);
    check_optional_tool(
        checks,
        "python_native_interpreter",
        "OPCORE_PYTHON",
        &["python3", "python"],
    );
}

fn check_optional_tool(
    checks: &mut Vec<DoctorCheck>,
    id: &'static str,
    variable: &str,
    path_names: &[&str],
) {
    if check_configured_tool(checks, id, variable) {
        return;
    }
    check_path_tools(checks, id, path_names);
}

fn check_python_checker(checks: &mut Vec<DoctorCheck>) {
    if check_configured_tool(checks, "python_native_checker", "OPCORE_PYRIGHT") {
        return;
    }
    if let Some(path) = command_in_path("pyright") {
        checks.push(DoctorCheck::pass(
            "python_native_checker",
            format!("found {}", path.display()),
        ));
        return;
    }
    if check_configured_tool(checks, "python_native_checker", "OPCORE_MYPY") {
        return;
    }
    check_path_tools(checks, "python_native_checker", &["mypy"]);
}

fn check_configured_tool(checks: &mut Vec<DoctorCheck>, id: &'static str, variable: &str) -> bool {
    if let Some(value) = env::var_os(variable) {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            checks.push(DoctorCheck::fail(
                id,
                format!("{variable} must name an absolute executable path"),
            ));
        } else if executable_file(&path) {
            checks.push(DoctorCheck::pass(
                id,
                format!("{variable}={}", path.display()),
            ));
        } else {
            checks.push(DoctorCheck::fail(
                id,
                format!(
                    "{variable} does not name an executable regular file: {}",
                    path.display()
                ),
            ));
        }
        return true;
    }
    false
}

fn check_path_tools(checks: &mut Vec<DoctorCheck>, id: &'static str, path_names: &[&str]) {
    if let Some(path) = path_names.iter().find_map(|name| command_in_path(name)) {
        checks.push(DoctorCheck::pass(id, format!("found {}", path.display())));
    } else {
        checks.push(DoctorCheck::skip(
            id,
            format!(
                "optional native tool not found; checked {}",
                path_names.join(", ")
            ),
        ));
    }
}

fn command_in_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|path| executable_file(path))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn finish_doctor(args: &RepositoryArgs, checks: &[DoctorCheck]) -> Result<()> {
    let healthy = checks.iter().all(|check| check.status != "fail");
    let report = json!({
        "schema": "opcore.doctor.v2",
        "status": if healthy { "fast_check_ready" } else { "needs_attention" },
        "scope": "fast_check_native_tool_and_hook_setup",
        "workflow": args.workflow,
        "sourceEvaluated": false,
        "buildFingerprint": build_digest(),
        "checks": checks,
    });
    if args.json {
        println!("{}", serde_json::to_string(&report)?);
    } else {
        println!(
            "{}",
            if healthy {
                "fast checks ready"
            } else {
                "setup needs attention"
            }
        );
        for check in checks {
            println!("{}: {}: {}", check.status, check.id, check.detail);
        }
    }
    if healthy {
        Ok(())
    } else {
        anyhow::bail!("doctor found an unhealthy configuration")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCheck {
    id: &'static str,
    status: &'static str,
    detail: String,
}

impl DoctorCheck {
    fn pass(id: &'static str, detail: impl Into<String>) -> Self {
        Self {
            id,
            status: "pass",
            detail: detail.into(),
        }
    }

    fn fail(id: &'static str, detail: impl Into<String>) -> Self {
        Self {
            id,
            status: "fail",
            detail: detail.into(),
        }
    }

    fn skip(id: &'static str, detail: impl Into<String>) -> Self {
        Self {
            id,
            status: "skip",
            detail: detail.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleDescriptor {
    id: &'static str,
    family: &'static str,
    languages: &'static [&'static str],
    intervention: &'static str,
    configurable_limit: Option<&'static str>,
}

const SUPPORTED: &[&str] = &[
    "javascript",
    "typescript",
    "python",
    "rust",
    "go",
    "hcl",
    "shell",
    "protobuf",
];
const CALLABLE: &[&str] = &["javascript", "typescript", "python", "rust", "go"];
const NODE: &[&str] = &["javascript", "typescript"];
const RUNTIME: &[&str] = &["javascript", "typescript", "python", "go"];
const EDGE_SELECTORS: &[&str] = &["javascript", "typescript", "python"];
const SHAPES: &[&str] = &["javascript", "typescript", "go"];
const STRUCTURAL: &[&str] = &["javascript", "typescript", "python", "rust", "go"];
const PYTHON: &[&str] = &["python"];
const RUST: &[&str] = &["rust"];
const HCL: &[&str] = &["hcl"];
const SHELL: &[&str] = &["shell"];
const GO: &[&str] = &["go"];
const PROTOBUF: &[&str] = &["protobuf"];

const VERIFY_RULES: &[RuleDescriptor] = &[
    rule(
        "hygiene.max-file-lines",
        "verify",
        SUPPORTED,
        "finding",
        Some("verify.maxFileLines"),
    ),
    rule(
        "hygiene.max-line-bytes",
        "verify",
        SUPPORTED,
        "finding",
        Some("verify.maxLineBytes"),
    ),
    rule(
        "complexity.max-function-lines",
        "verify",
        CALLABLE,
        "finding",
        Some("verify.maxFunctionLines"),
    ),
    rule(
        "complexity.max-parameters",
        "verify",
        CALLABLE,
        "finding",
        Some("verify.maxParameters"),
    ),
    rule(
        "complexity.max-nesting",
        "verify",
        CALLABLE,
        "finding",
        Some("verify.maxNesting"),
    ),
    rule(
        "complexity.max-cyclomatic-complexity",
        "verify",
        CALLABLE,
        "finding",
        Some("verify.maxCyclomaticComplexity"),
    ),
    rule("node.syntax", "verify", NODE, "finding", None),
    rule("python.syntax", "verify", PYTHON, "finding", None),
    rule("rust.syntax", "verify", RUST, "finding", None),
    rule("hcl.syntax", "verify", HCL, "finding", None),
    rule("shell.syntax", "verify", SHELL, "finding", None),
    rule("go.syntax", "verify", GO, "finding", None),
    rule("protobuf.syntax", "verify", PROTOBUF, "finding", None),
];

const NATIVE_RULES: &[RuleDescriptor] = &[
    rule(
        "opcore-rust-native/cargo-check",
        "native",
        RUST,
        "finding",
        None,
    ),
    rule(
        "opcore-node-native/typescript-check",
        "native",
        NODE,
        "finding",
        None,
    ),
    rule(
        "opcore-python-native/type-check",
        "native",
        PYTHON,
        "finding",
        None,
    ),
];

const SENSE_RULES: &[RuleDescriptor] = &[
    rule(
        "sense.runtime_cycle",
        "sense",
        RUNTIME,
        "introduced_only",
        None,
    ),
    rule(
        "sense.duplication.identical_file",
        "sense",
        SUPPORTED,
        "introduced_only",
        Some("sense.minimumIdenticalBytes"),
    ),
    rule(
        "sense.duplication.callable_body",
        "sense",
        CALLABLE,
        "introduced_only",
        None,
    ),
    rule(
        "sense.duplication.token_region",
        "sense",
        SUPPORTED,
        "introduced_only",
        None,
    ),
    rule(
        "sense.interface.dependency_targets",
        "sense",
        STRUCTURAL,
        "introduced_only",
        Some("sense.maxDependencyTargets"),
    ),
    rule(
        "sense.interface.edge_selectors",
        "sense",
        EDGE_SELECTORS,
        "introduced_only",
        Some("sense.maxEdgeSelectors"),
    ),
    rule(
        "sense.interface.module_exports",
        "sense",
        RUNTIME,
        "introduced_only",
        Some("sense.maxModuleExports"),
    ),
    rule(
        "sense.interface.shape_members",
        "sense",
        SHAPES,
        "introduced_only",
        Some("sense.maxShapeMembers"),
    ),
    rule(
        "sense.documentation.missing_binding",
        "sense",
        STRUCTURAL,
        "introduced_only",
        Some("sense.importantFanIn"),
    ),
    rule(
        "sense.documentation.missing_document",
        "sense",
        STRUCTURAL,
        "introduced_only",
        Some("sense.importantFanIn"),
    ),
    rule(
        "sense.documentation.document_not_updated",
        "sense",
        STRUCTURAL,
        "introduced_only",
        Some("sense.importantFanIn"),
    ),
    rule(
        "sense.documentation.stale_binding",
        "sense",
        STRUCTURAL,
        "introduced_only",
        Some("sense.importantFanIn"),
    ),
];

const fn rule(
    id: &'static str,
    family: &'static str,
    languages: &'static [&'static str],
    intervention: &'static str,
    configurable_limit: Option<&'static str>,
) -> RuleDescriptor {
    RuleDescriptor {
        id,
        family,
        languages,
        intervention,
        configurable_limit,
    }
}

#[must_use]
pub fn rule_manifest() -> Value {
    json!({
        "schema": "opcore.rules.v1",
        "version": env!("CARGO_PKG_VERSION"),
        "policy": {
            "path": POLICY_PATH,
            "schemaVersion": POLICY_SCHEMA_VERSION,
            "maxBytes": crate::policy::MAX_POLICY_BYTES,
            "defaults": crate::policy::Policy::default(),
        },
        "verify": VERIFY_RULES,
        "native": NATIVE_RULES,
        "sense": SENSE_RULES,
    })
}

/// Prints the built-in rule and policy manifest.
///
/// # Errors
///
/// Returns an error when the manifest cannot be encoded or written.
pub fn rules() -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&rule_manifest())?);
    Ok(())
}

/// Prints the strict repository configuration JSON Schema without reading a repository.
///
/// # Errors
///
/// Returns an error when the schema cannot be encoded or written.
pub fn configuration_schema() -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&crate::policy::schema())?
    );
    Ok(())
}
