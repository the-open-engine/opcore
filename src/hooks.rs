//! Opt-in, owned agent-hook wiring and the post-write gate adapter.

use std::{
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{fs::OpenOptionsExt, fs::PermissionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use clap::{Args, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{
    commands::workflows::{self, RunArgs},
    json::parse_unique_json,
    model::{Assessment, AssessmentStatus},
    policy::Workflow,
    sense::model::{DuplicateKind, SenseReport, SenseStatus},
    source::{SourceError, git::GitRepository},
};

mod diagnostics;

pub(crate) use diagnostics::diagnose;

const MAX_HOOK_INPUT_BYTES: usize = 64 * 1024;
const MAX_AGENT_CONFIG_BYTES: usize = 1024 * 1024;
const RECEIPT_SCHEMA: &str = "opcore.hook-install.v1";
const COMMAND_MARKER: &str = "opcore agent-gate";
const MAX_HOOK_FEEDBACK_BYTES: usize = 8 * 1024;
const MAX_HOOK_FEEDBACK_ITEMS: usize = 8;
const WORKTREE_VERDICT_FEEDBACK: &str = concat!(
    "Opcore checks all selected uncommitted worktree changes against HEAD, not only the call ",
    "that triggered this hook. The triggering PostToolUse call already executed; Codex may ",
    "replace its result with this feedback. Matched calls will keep receiving the same feedback ",
    "while this intervention remains unresolved. Committing changes only changes the comparison ",
    "baseline; it does not resolve the reported issues."
);

/// Agent whose global hook configuration is managed by the installer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    /// Codex user-level hooks.
    Codex,
    /// Claude Code user-level hooks.
    Claude,
}

impl Agent {
    const fn matcher(self) -> &'static str {
        match self {
            Self::Codex => "apply_patch|Edit|Write|Bash|mcp__.*",
            Self::Claude => "Edit|MultiEdit|Write|Bash|mcp__.*",
        }
    }
}

/// Installer arguments for one receipt-owned global post-tool hook.
#[derive(Clone, Debug, Args)]
pub struct ConfigureHookArgs {
    /// Agent whose configuration receives the hook.
    #[arg(long, value_enum)]
    pub agent: Agent,
    /// Absolute agent configuration file path.
    #[arg(long)]
    pub config: PathBuf,
    /// Absolute installed executable path embedded in the hook.
    #[arg(long)]
    pub binary: PathBuf,
    /// Absolute path to the hook ownership receipt.
    #[arg(long)]
    pub receipt: PathBuf,
    /// Remove only the exact receipt-owned hook entries.
    #[arg(long)]
    pub remove: bool,
    /// Validate hook enrollment without writing configuration or receipts.
    #[arg(long, conflicts_with = "remove")]
    pub check: bool,
}

/// Returns true when the hook process must exit with the conventional blocking code 2.
pub async fn agent_gate() -> bool {
    let repo = hook_repository();
    let repository = match GitRepository::discover(&repo) {
        Ok(repository) => repository,
        Err(SourceError::NotRepository) => return false,
        Err(error) => {
            eprintln!(
                "{}",
                truncate_feedback(format!(
                    "Opcore could not discover the Git worktree: {error}. {}",
                    "Run `opcore doctor --repo .` to diagnose setup."
                ))
            );
            return true;
        }
    };
    let args = RunArgs {
        workflow: Workflow::PostEdit,
        repo,
        base: None,
        tree: None,
        json: false,
        allow_unsandboxed_native: false,
    };
    let result = match workflows::evaluate(&args, &repository).await {
        Ok(result) => result,
        Err(error) => {
            let message = format!(
                concat!(
                    "Opcore post-edit checks could not complete: {:#}. ",
                    "Run `opcore run post-edit --repo . --json` for full evidence."
                ),
                error,
            );
            eprintln!("{}", truncate_feedback(message));
            return true;
        }
    };
    if !matches!(
        result.verify.status,
        AssessmentStatus::Clean | AssessmentStatus::NotChecked
    ) {
        eprintln!("{}", assessment_feedback(&result.verify));
        return true;
    }
    let requires_intervention = result.enforce().is_err();
    let feedback_blocks = sense_gate_feedback(&result.sense, requires_intervention);
    feedback_blocks || requires_intervention
}

fn sense_gate_feedback(report: &SenseReport, requires_intervention: bool) -> bool {
    let findings = sense_finding_count(report);
    if findings > 0 {
        eprintln!("{}", sense_findings_feedback(report, findings));
    } else if report.status == SenseStatus::Partial {
        eprintln!(
            "{}",
            if requires_intervention {
                "Post-edit requires complete Project Sense coverage. Run `opcore run post-edit --repo . --json` to review the gaps and coverage settings."
            } else {
                sense_partial_hint()
            }
        );
    }
    if report.status == SenseStatus::Incomplete {
        eprintln!(
            "Opcore Project Sense could not complete. Run `opcore run post-edit --repo . --json` for full evidence."
        );
        return true;
    }
    findings > 0
}

fn sense_finding_count(report: &SenseReport) -> usize {
    report
        .introduced_cycles
        .len()
        .saturating_add(report.introduced_duplicates.len())
        .saturating_add(report.interface_findings.len())
        .saturating_add(report.documentation_requirements.len())
}

fn sense_findings_feedback(report: &SenseReport, findings: usize) -> String {
    let mut feedback =
        format!("Opcore Project Sense requires intervention: {findings} finding(s).");
    append_worktree_verdict_feedback(&mut feedback);
    let mut shown = append_cycle_feedback(&mut feedback, report, MAX_HOOK_FEEDBACK_ITEMS);
    shown += append_duplicate_feedback(
        &mut feedback,
        report,
        MAX_HOOK_FEEDBACK_ITEMS.saturating_sub(shown),
    );
    shown += append_interface_feedback(
        &mut feedback,
        report,
        MAX_HOOK_FEEDBACK_ITEMS.saturating_sub(shown),
    );
    shown += append_documentation_feedback(
        &mut feedback,
        report,
        MAX_HOOK_FEEDBACK_ITEMS.saturating_sub(shown),
    );
    if findings > shown {
        feedback.push_str("\nAdditional findings omitted.");
    }
    if report.status == SenseStatus::Partial {
        let _ = write!(feedback, "\n{}", sense_partial_hint());
    } else {
        feedback.push_str("\nRun `opcore run post-edit --repo . --json` for full evidence.");
    }
    truncate_feedback(feedback)
}

fn append_cycle_feedback(feedback: &mut String, report: &SenseReport, limit: usize) -> usize {
    for cycle in report.introduced_cycles.iter().take(limit) {
        let _ = write!(
            feedback,
            "\n{}: sense.runtime_cycle: introduced runtime cycle through {} ({} files)",
            cycle.trigger.from, cycle.trigger.to, cycle.member_count,
        );
    }
    report.introduced_cycles.len().min(limit)
}

fn append_duplicate_feedback(feedback: &mut String, report: &SenseReport, limit: usize) -> usize {
    let mut shown = 0usize;
    for duplicate in report.introduced_duplicates.iter().take(limit) {
        let (rule, kind) = match duplicate.kind {
            DuplicateKind::IdenticalFile => ("sense.duplication.identical_file", "identical file"),
            DuplicateKind::CallableBody => ("sense.duplication.callable_body", "callable body"),
            DuplicateKind::TokenRegion => ("sense.duplication.token_region", "token region"),
        };
        let Some(occurrence) = duplicate.occurrences.first() else {
            continue;
        };
        let line = occurrence.range.map_or(0, |range| range.start.line);
        let _ = write!(
            feedback,
            "\n{}:{line}: {rule}: duplicate {kind} ({} occurrences, was {})",
            occurrence.path, duplicate.after_count, duplicate.before_count,
        );
        shown += 1;
    }
    shown
}

fn append_interface_feedback(feedback: &mut String, report: &SenseReport, limit: usize) -> usize {
    for finding in report.interface_findings.iter().take(limit) {
        let _ = write!(
            feedback,
            "\n{}: {}: {} is {} (was {}; limit {})",
            finding.path,
            finding.code,
            finding.metric,
            finding.after,
            finding.before,
            finding.limit,
        );
    }
    report.interface_findings.len().min(limit)
}

fn append_documentation_feedback(
    feedback: &mut String,
    report: &SenseReport,
    limit: usize,
) -> usize {
    for requirement in report.documentation_requirements.iter().take(limit) {
        let _ = write!(
            feedback,
            "\n{}: {}: documentation needs attention",
            requirement.path, requirement.code,
        );
    }
    report.documentation_requirements.len().min(limit)
}

fn sense_partial_hint() -> &'static str {
    "Project Sense coverage is partial. Run `opcore run post-edit --repo . --json` for details."
}

fn assessment_feedback(assessment: &Assessment) -> String {
    let mut feedback = format!(
        "Opcore Verify requires intervention: {} diagnostic(s); {}/{} files covered.",
        assessment.diagnostics.len(),
        assessment.coverage.files_covered,
        assessment.coverage.files_considered,
    );
    append_worktree_verdict_feedback(&mut feedback);
    let mut shown = 0usize;
    for diagnostic in assessment.diagnostics.iter().take(MAX_HOOK_FEEDBACK_ITEMS) {
        let line = diagnostic.range.map_or(0, |range| range.start.line);
        let _ = write!(
            feedback,
            "\n{}:{line}: {}: {}",
            diagnostic.path, diagnostic.rule_id, diagnostic.message,
        );
        shown += 1;
    }
    for gap in assessment
        .coverage
        .gaps
        .iter()
        .take(MAX_HOOK_FEEDBACK_ITEMS.saturating_sub(shown))
    {
        let _ = write!(
            feedback,
            "\n{}: coverage {:?}: {}",
            gap.path,
            gap.status,
            gap.reason.as_deref().unwrap_or("no reason"),
        );
        shown += 1;
    }
    if assessment.diagnostics.len() + assessment.coverage.gaps.len() > shown {
        feedback.push_str("\nAdditional evidence omitted.");
    }
    feedback.push_str("\nRun `opcore run post-edit --repo . --json` for full evidence.");
    truncate_feedback(feedback)
}

fn append_worktree_verdict_feedback(feedback: &mut String) {
    let _ = write!(feedback, "\n{WORKTREE_VERDICT_FEEDBACK}");
}

fn truncate_feedback(mut feedback: String) -> String {
    if feedback.len() <= MAX_HOOK_FEEDBACK_BYTES {
        return feedback;
    }
    let mut end = MAX_HOOK_FEEDBACK_BYTES.saturating_sub(4);
    while !feedback.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    feedback.truncate(end);
    feedback.push_str(" ...");
    feedback
}

fn hook_repository() -> PathBuf {
    let mut bytes = Vec::new();
    if std::io::stdin()
        .take((MAX_HOOK_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > MAX_HOOK_INPUT_BYTES
    {
        return PathBuf::from(".");
    }
    parse_unique_json(&bytes)
        .ok()
        .and_then(|value| value.get("cwd")?.as_str().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Adds or removes the single installer-owned hook entry.
///
/// # Errors
///
/// Returns an error for unsafe paths, malformed configuration, ownership conflicts, or failed
/// filesystem operations.
pub fn configure(args: &ConfigureHookArgs) -> Result<()> {
    ensure!(
        args.config.is_absolute(),
        "hook config path must be absolute"
    );
    ensure!(args.binary.is_absolute(), "binary path must be absolute");
    ensure!(args.receipt.is_absolute(), "receipt path must be absolute");
    if args.check {
        preflight(args)
    } else if args.remove {
        uninstall(args)
    } else {
        install(args)
    }
}

fn preflight(args: &ConfigureHookArgs) -> Result<()> {
    let (mut config, exists) = read_config(&args.config)?;
    let receipt = read_receipt(&args.receipt)?;
    let (_, owned) = prior_install_state(receipt.as_ref(), args, exists)?;
    remove_owned_hooks(&mut config, &owned);
    add_hook(&mut config, &installed_hook(args)?)
}

fn install(args: &ConfigureHookArgs) -> Result<()> {
    ensure!(
        args.binary.is_file(),
        "installed hook binary must be a regular file"
    );
    let _lock = lock_receipt_parent(&args.receipt)?;
    let original = read_config(&args.config)?;
    let (mut config, currently_exists) = original.clone();
    let prior = read_receipt(&args.receipt)?;
    let (config_existed, prior_entries) =
        prior_install_state(prior.as_ref(), args, currently_exists)?;
    let installed_entry = installed_hook(args)?;
    let journal_entries = journal_entries(&prior_entries, &installed_entry);
    write_receipt(&args.receipt, args, config_existed, journal_entries)?;
    remove_owned_hooks(&mut config, &prior_entries);
    add_hook(&mut config, &installed_entry)?;
    publish_config_if_current(args, &original, &config, "installation")?;
    write_receipt(&args.receipt, args, config_existed, vec![installed_entry])
}

fn uninstall(args: &ConfigureHookArgs) -> Result<()> {
    let _lock = lock_receipt_parent(&args.receipt)?;
    let receipt = read_receipt(&args.receipt)?.context("hook install receipt is missing")?;
    validate_receipt(&receipt, args)?;
    let entries = receipt_entries(&receipt, args)?;
    let original = read_config(&args.config)?;
    let (mut config, currently_exists) = original.clone();
    remove_owned_hooks(&mut config, &entries);
    ensure_config_current(args, &original, "uninstallation")?;
    publish_uninstalled_config(args, &config, currently_exists, receipt.config_existed)?;
    remove_regular_file(&args.receipt)
}

fn prior_install_state(
    prior: Option<&HookReceipt>,
    args: &ConfigureHookArgs,
    currently_exists: bool,
) -> Result<(bool, Vec<OwnedHook>)> {
    let Some(receipt) = prior else {
        return Ok((currently_exists, Vec::new()));
    };
    validate_receipt(receipt, args)?;
    Ok((receipt.config_existed, receipt_entries(receipt, args)?))
}

fn journal_entries(prior: &[OwnedHook], installed: &OwnedHook) -> Vec<OwnedHook> {
    let mut entries = prior.to_vec();
    if !entries.contains(installed) {
        entries.push(installed.clone());
    }
    entries
}

fn publish_config_if_current(
    args: &ConfigureHookArgs,
    original: &(Value, bool),
    config: &Value,
    operation: &str,
) -> Result<()> {
    ensure_config_current(args, original, operation)?;
    write_json(&args.config, config)
}

fn ensure_config_current(
    args: &ConfigureHookArgs,
    original: &(Value, bool),
    operation: &str,
) -> Result<()> {
    ensure!(
        read_config(&args.config)? == *original,
        "agent hook config changed while {operation} was prepared"
    );
    Ok(())
}

fn publish_uninstalled_config(
    args: &ConfigureHookArgs,
    config: &Value,
    currently_exists: bool,
    config_existed: bool,
) -> Result<()> {
    if !currently_exists || (!config_existed && empty_object(config)) {
        remove_regular_file(&args.config)
    } else {
        write_json(&args.config, config)
    }
}

fn read_receipt(path: &Path) -> Result<Option<HookReceipt>> {
    read_optional_json(path)?
        .map(|value| serde_json::from_value(value).context("validate hook install receipt"))
        .transpose()
}

fn validate_receipt(receipt: &HookReceipt, args: &ConfigureHookArgs) -> Result<()> {
    ensure!(
        receipt.schema == RECEIPT_SCHEMA,
        "unsupported hook receipt schema"
    );
    ensure!(
        receipt.agent == args.agent,
        "hook receipt agent does not match"
    );
    ensure!(
        receipt.config == args.config,
        "hook receipt config path does not match"
    );
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HookReceipt {
    schema: String,
    agent: Agent,
    config: PathBuf,
    config_existed: bool,
    #[serde(default)]
    owned_entries: Vec<OwnedHook>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OwnedHook {
    matcher: String,
    entry: Value,
}

fn installed_hook(args: &ConfigureHookArgs) -> Result<OwnedHook> {
    hook_with_status(args, "Running Opcore Verify and Project Sense")
}

fn legacy_installed_hook(args: &ConfigureHookArgs) -> Result<OwnedHook> {
    let mut owned = hook_with_status(args, "Running Opcore Verify")?;
    owned.matcher = match args.agent {
        Agent::Codex => "apply_patch|Edit|Write",
        Agent::Claude => "Edit|MultiEdit|Write",
    }
    .into();
    Ok(owned)
}

fn hook_with_status(args: &ConfigureHookArgs, status_message: &str) -> Result<OwnedHook> {
    Ok(OwnedHook {
        matcher: args.agent.matcher().into(),
        entry: json!({
            "type": "command",
            "command": hook_command(&args.binary)?,
            "timeout": 30,
            "statusMessage": status_message,
        }),
    })
}

fn receipt_entries(receipt: &HookReceipt, args: &ConfigureHookArgs) -> Result<Vec<OwnedHook>> {
    let entries = if receipt.owned_entries.is_empty() {
        vec![legacy_installed_hook(args)?]
    } else {
        receipt.owned_entries.clone()
    };
    ensure!(entries.len() <= 2, "hook receipt owns too many entries");
    ensure!(
        entries.iter().all(|owned| owned.entry.is_object()),
        "hook receipt entry must be an object"
    );
    Ok(entries)
}

fn write_receipt(
    path: &Path,
    args: &ConfigureHookArgs,
    config_existed: bool,
    owned_entries: Vec<OwnedHook>,
) -> Result<()> {
    let receipt = HookReceipt {
        schema: RECEIPT_SCHEMA.into(),
        agent: args.agent,
        config: args.config.clone(),
        config_existed,
        owned_entries,
    };
    write_json(path, &serde_json::to_value(receipt)?)
}

fn lock_receipt_parent(receipt: &Path) -> Result<File> {
    let parent = receipt.parent().context("receipt path has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let directory = File::open(parent).context("open hook receipt directory")?;
    fs2::FileExt::lock_exclusive(&directory).context("lock hook receipt directory")?;
    Ok(directory)
}

fn read_config(path: &Path) -> Result<(Value, bool)> {
    match read_optional_json(path)? {
        Some(value) => {
            ensure!(value.is_object(), "agent hook config must be a JSON object");
            validate_hook_groups(&value)?;
            Ok((value, true))
        }
        None => Ok((Value::Object(Map::new()), false)),
    }
}

fn validate_hook_groups(config: &Value) -> Result<()> {
    let Some(hooks) = config.get("hooks") else {
        return Ok(());
    };
    let hooks = hooks
        .as_object()
        .context("agent config hooks must be an object")?;
    for (event, groups) in hooks {
        let groups = groups
            .as_array()
            .with_context(|| format!("agent hook event {event} must be an array"))?;
        for group in groups {
            let handlers = group
                .get("hooks")
                .and_then(Value::as_array)
                .with_context(|| {
                    format!("agent hook event {event} requires a hooks array in each group")
                })?;
            ensure!(
                handlers.iter().all(Value::is_object),
                "agent hook handlers must be objects"
            );
        }
    }
    Ok(())
}

fn read_optional_json(path: &Path) -> Result<Option<Value>> {
    read_optional_bytes(path)?
        .map(|bytes| parse_unique_json(&bytes).context("parse unique agent hook JSON"))
        .transpose()
}

fn read_optional_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("open {}", path.display())),
    };
    let metadata = file.metadata().context("inspect agent hook config")?;
    ensure!(
        metadata.is_file(),
        "agent hook config must be a regular file"
    );
    ensure!(
        metadata.len() <= MAX_AGENT_CONFIG_BYTES as u64,
        "agent hook config exceeds {MAX_AGENT_CONFIG_BYTES} bytes"
    );
    let mut bytes = Vec::new();
    file.take((MAX_AGENT_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .context("read agent hook config")?;
    ensure!(
        bytes.len() <= MAX_AGENT_CONFIG_BYTES,
        "agent hook config exceeds {MAX_AGENT_CONFIG_BYTES} bytes"
    );
    Ok(Some(bytes))
}

fn add_hook(config: &mut Value, owned: &OwnedHook) -> Result<()> {
    let root = config
        .as_object_mut()
        .context("agent config is not an object")?;
    let hooks = object_entry(root, "hooks")?;
    let groups = array_entry(hooks, "PostToolUse")?;
    let group_index = groups
        .iter()
        .position(|group| group.get("matcher").and_then(Value::as_str) == Some(&owned.matcher));
    if let Some(index) = group_index {
        let group = groups[index]
            .as_object_mut()
            .context("matching PostToolUse group must be an object")?;
        array_entry(group, "hooks")?.push(owned.entry.clone());
    } else {
        groups.push(json!({ "matcher": owned.matcher, "hooks": [owned.entry] }));
    }
    Ok(())
}

fn remove_owned_hooks(config: &mut Value, owned: &[OwnedHook]) {
    let Some(root) = config.as_object_mut() else {
        return;
    };
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(groups) = hooks.get_mut("PostToolUse").and_then(Value::as_array_mut) else {
        return;
    };
    for group in groups.iter_mut() {
        let matcher = group
            .get("matcher")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(entries) = group.get_mut("hooks").and_then(Value::as_array_mut) {
            entries.retain(|entry| {
                !owned.iter().any(|owned| {
                    matcher.as_deref() == Some(owned.matcher.as_str()) && entry == &owned.entry
                })
            });
        }
    }
    groups.retain(|group| {
        group
            .get("hooks")
            .and_then(Value::as_array)
            .is_none_or(|entries| {
                !entries.is_empty() || group.as_object().is_some_and(|v| v.len() > 2)
            })
    });
    if groups.is_empty() {
        hooks.remove("PostToolUse");
    }
    if hooks.is_empty() {
        root.remove("hooks");
    }
}

fn object_entry<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>> {
    let value = object
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    value
        .as_object_mut()
        .with_context(|| format!("agent config {key} must be an object"))
}

fn array_entry<'a>(object: &'a mut Map<String, Value>, key: &str) -> Result<&'a mut Vec<Value>> {
    let value = object
        .entry(key.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    value
        .as_array_mut()
        .with_context(|| format!("agent config {key} must be an array"))
}

fn hook_command(binary: &Path) -> Result<String> {
    let binary = binary.to_str().context("binary path is not valid UTF-8")?;
    Ok(format!(
        "{} agent-gate # {COMMAND_MARKER}",
        shell_quote(binary)
    ))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let parent = path
        .parent()
        .context("JSON target has no parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let mode = json_target_mode(path)?;
    let mut temporary = temporary_json(parent, mode)?;
    serde_json::to_writer_pretty(&mut temporary, value).context("serialize JSON")?;
    temporary.write_all(b"\n").context("finish JSON")?;
    temporary.as_file().sync_all().context("sync JSON")?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("publish {}", path.display()))?;
    Ok(())
}

fn json_target_mode(path: &Path) -> Result<u32> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(metadata.permissions().mode() & 0o777),
        Ok(_) => anyhow::bail!("JSON target must be a regular file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0o600),
        Err(error) => Err(error).context("inspect JSON target"),
    }
}

fn temporary_json(parent: &Path, mode: u32) -> Result<tempfile::NamedTempFile> {
    let temporary = tempfile::NamedTempFile::new_in(parent).context("create temporary JSON")?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(mode))
        .context("set private JSON permissions")?;
    Ok(temporary)
}

fn remove_regular_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => ensure!(metadata.is_file(), "refusing to remove a non-file target"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("inspect removal target"),
    }
    fs::remove_file(path).with_context(|| format!("remove {}", path.display()))
}

fn empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(Map::is_empty)
}
