//! Bounded execution for the bundled native check providers.
//!
//! The caller supplies an already-materialized private workspace. Native tools may execute
//! repository-controlled behavior, so execution hygiene is not a replacement for the OS sandbox
//! required for authoritative use. This module never points a tool at the user's worktree.

mod node;
mod output;
mod process;
mod python;

use std::{
    collections::BTreeMap,
    env,
    ffi::{OsStr, OsString},
    fs::{File, Metadata},
    io::Read as _,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{cancel::CancelToken, identity::hash_domain, path::RepoPath};

const SOURCE: &str = "opcore-rust-native";
const RULE: &str = "cargo-check";
const DEFAULT_TIMEOUT: Duration = Duration::from_mins(2);
const MAX_TIMEOUT: Duration = Duration::from_mins(10);
const DEFAULT_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOOL_BYTES: u64 = 256 * 1024 * 1024;
const PYTHON_CHILD_ENVIRONMENT: &[&str] = &[
    "PATH",
    "HOME",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "OPCORE_PYTHON",
    "OPCORE_PYTHON_SOURCE",
];

const RUST_CHILD_ENVIRONMENT: &[&str] = &[
    "PATH",
    "HOME",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
];

const NODE_CHILD_ENVIRONMENT: &[&str] = &[
    "PATH",
    "HOME",
    "NPM_CONFIG_CACHE",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
];

const RUST_FIXED_ENVIRONMENT: &[(&str, &str)] = &[
    ("CARGO_NET_OFFLINE", "true"),
    ("CARGO_TERM_COLOR", "never"),
    ("CARGO_INCREMENTAL", "0"),
    ("CARGO_TARGET_DIR", "ephemeral-per-run"),
    ("TMPDIR", "provider-private-target"),
    ("TMP", "provider-private-target"),
    ("TEMP", "provider-private-target"),
    ("LC_ALL", "C"),
    ("RUST_BACKTRACE", "0"),
];

const NODE_FIXED_ENVIRONMENT: &[(&str, &str)] = &[
    ("CI", "true"),
    ("LC_ALL", "C"),
    ("NO_COLOR", "1"),
    ("NPM_CONFIG_OFFLINE", "true"),
    ("NPM_CONFIG_IGNORE_SCRIPTS", "true"),
    ("NPM_CONFIG_AUDIT", "false"),
    ("NPM_CONFIG_FUND", "false"),
    ("NPM_CONFIG_UPDATE_NOTIFIER", "false"),
    ("TMPDIR", "provider-private-scratch"),
    ("TMP", "provider-private-scratch"),
    ("TEMP", "provider-private-scratch"),
];

const PYTHON_FIXED_ENVIRONMENT: &[(&str, &str)] = &[
    ("LC_ALL", "C"),
    ("NO_COLOR", "1"),
    ("PYTHONUTF8", "1"),
    ("MYPY_FORCE_COLOR", "0"),
    ("TMPDIR", "provider-private-scratch"),
    ("TMP", "provider-private-scratch"),
    ("TEMP", "provider-private-scratch"),
];

pub(crate) const fn child_environment(
    profile: crate::protocol::asp::ProviderProfile,
) -> &'static [&'static str] {
    match profile {
        crate::protocol::asp::ProviderProfile::Fast => &[],
        crate::protocol::asp::ProviderProfile::RustNative => RUST_CHILD_ENVIRONMENT,
        crate::protocol::asp::ProviderProfile::NodeNative => NODE_CHILD_ENVIRONMENT,
        crate::protocol::asp::ProviderProfile::PythonNative => PYTHON_CHILD_ENVIRONMENT,
    }
}

const fn fixed_environment(
    profile: crate::protocol::asp::ProviderProfile,
) -> &'static [(&'static str, &'static str)] {
    match profile {
        crate::protocol::asp::ProviderProfile::Fast => &[],
        crate::protocol::asp::ProviderProfile::RustNative => RUST_FIXED_ENVIRONMENT,
        crate::protocol::asp::ProviderProfile::NodeNative => NODE_FIXED_ENVIRONMENT,
        crate::protocol::asp::ProviderProfile::PythonNative => PYTHON_FIXED_ENVIRONMENT,
    }
}

/// One request-local snapshot of the environment selection and native executable bytes.
#[derive(Clone)]
pub(crate) struct NativeExecutionIdentity {
    environment: Vec<(OsString, OsString)>,
    tool_digest: String,
    environment_digest: String,
    runtime: Option<RuntimeIdentity>,
}

#[derive(Clone)]
struct RuntimeIdentity {
    kind: &'static str,
    path: PathBuf,
    digest: String,
    source: &'static str,
    marker: Option<(PathBuf, String)>,
}

impl NativeExecutionIdentity {
    pub(crate) fn capture(
        profile: crate::protocol::asp::ProviderProfile,
        tool_program: &Path,
        cancel: &CancelToken,
        deadline: Instant,
    ) -> Result<Self, String> {
        let tool_digest = digest_tool(tool_program, cancel, deadline)?;
        let environment = child_environment(profile)
            .iter()
            .filter_map(|key| env::var_os(key).map(|value| (OsString::from(key), value)))
            .collect::<Vec<_>>();
        let runtime = capture_runtime_identity(profile, cancel, deadline)?;
        let environment_digest = digest_environment(profile, &environment, runtime.as_ref());
        Ok(Self {
            environment,
            tool_digest,
            environment_digest,
            runtime,
        })
    }

    fn verify_tool(
        &self,
        tool_program: &Path,
        cancel: &CancelToken,
        deadline: Instant,
    ) -> Result<(), String> {
        if digest_tool(tool_program, cancel, deadline)? == self.tool_digest {
            Ok(())
        } else {
            Err("the native tool executable changed during evaluation".into())
        }
    }

    fn verify_runtime(&self, cancel: &CancelToken, deadline: Instant) -> Result<(), String> {
        let Some(runtime) = &self.runtime else {
            return Err("the native runtime was not selected".into());
        };
        if digest_tool(&runtime.path, cancel, deadline)? != runtime.digest {
            return Err("the native runtime executable changed during evaluation".into());
        }
        if let Some((path, expected)) = &runtime.marker
            && digest_tool(path, cancel, deadline)? != *expected
        {
            return Err("the native runtime environment marker changed during evaluation".into());
        }
        Ok(())
    }

    fn verify(
        &self,
        tool_program: &Path,
        cancel: &CancelToken,
        deadline: Instant,
    ) -> Result<(), String> {
        self.verify_tool(tool_program, cancel, deadline)?;
        self.verify_runtime(cancel, deadline)
    }

    fn runtime_path(&self) -> Option<&Path> {
        self.runtime.as_ref().map(|runtime| runtime.path.as_path())
    }

    fn runtime_source(&self) -> Option<&'static str> {
        self.runtime.as_ref().map(|runtime| runtime.source)
    }
}

fn capture_runtime_identity(
    profile: crate::protocol::asp::ProviderProfile,
    cancel: &CancelToken,
    deadline: Instant,
) -> Result<Option<RuntimeIdentity>, String> {
    let Some((kind, path, source)) = runtime_selection(profile)? else {
        return Ok(None);
    };
    let digest = digest_tool(&path, cancel, deadline)?;
    let marker = (profile == crate::protocol::asp::ProviderProfile::PythonNative)
        .then(|| python_environment_marker(&path, cancel, deadline))
        .transpose()?
        .flatten();
    Ok(Some(RuntimeIdentity {
        kind,
        path,
        digest,
        source,
        marker,
    }))
}

fn runtime_selection(
    profile: crate::protocol::asp::ProviderProfile,
) -> Result<Option<(&'static str, PathBuf, &'static str)>, String> {
    match profile {
        crate::protocol::asp::ProviderProfile::Fast => Ok(None),
        crate::protocol::asp::ProviderProfile::RustNative => {
            Ok(runtime_on_path("rustc").map(|path| ("rustc-launcher", path, "path")))
        }
        crate::protocol::asp::ProviderProfile::NodeNative => {
            Ok(runtime_on_path("node").map(|path| ("node", path, "path")))
        }
        crate::protocol::asp::ProviderProfile::PythonNative => python_runtime_selection()
            .map(|selection| selection.map(|(path, source)| ("python-interpreter", path, source))),
    }
}

pub(super) fn python_runtime_selection() -> Result<Option<(PathBuf, &'static str)>, String> {
    let configured = env::var_os("OPCORE_PYTHON").map(PathBuf::from);
    let selection = if let Some(path) = configured {
        Some((path, python_environment_source()?))
    } else {
        runtime_on_path("python3")
            .or_else(|| runtime_on_path("python"))
            .map(|path| (path, "ambient"))
    };
    if selection
        .as_ref()
        .is_some_and(|(path, _)| !path.is_absolute() || !path.is_file())
    {
        return Err("the selected Python interpreter is not an absolute file".into());
    }
    Ok(selection)
}

fn python_environment_source() -> Result<&'static str, String> {
    match env::var("OPCORE_PYTHON_SOURCE").as_deref() {
        Ok("project-dot-venv") => Ok("project-dot-venv"),
        Ok("active-project-venv") => Ok("active-project-venv"),
        Ok("explicit") | Err(env::VarError::NotPresent) => Ok("explicit"),
        Ok(_) => Err("OPCORE_PYTHON_SOURCE is unsupported".into()),
        Err(env::VarError::NotUnicode(_)) => {
            Err("OPCORE_PYTHON_SOURCE is not valid Unicode".into())
        }
    }
}

fn python_environment_marker(
    interpreter: &Path,
    cancel: &CancelToken,
    deadline: Instant,
) -> Result<Option<(PathBuf, String)>, String> {
    let Some(root) = interpreter.parent().and_then(Path::parent) else {
        return Ok(None);
    };
    let marker = root.join("pyvenv.cfg");
    if !marker.is_file() {
        return Ok(None);
    }
    let digest = digest_tool(&marker, cancel, deadline)?;
    Ok(Some((marker, digest)))
}

fn runtime_on_path(executable: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path).find_map(|directory| {
        let candidate = directory.join(if cfg!(windows) {
            format!("{executable}.exe")
        } else {
            executable.to_owned()
        });
        (candidate.is_absolute() && candidate.is_file()).then_some(candidate)
    })
}

/// One Rust-native evaluation against a private, immutable candidate copy.
pub(crate) struct NativeCheckRequest<'a> {
    pub(crate) profile: crate::protocol::asp::ProviderProfile,
    pub(crate) workspace_root: &'a Path,
    pub(crate) project_root: Option<&'a RepoPath>,
    pub(crate) source_files: &'a BTreeMap<RepoPath, Arc<[u8]>>,
    pub(crate) tool_program: &'a Path,
    pub(crate) identity: &'a NativeExecutionIdentity,
    pub(crate) cancel: &'a CancelToken,
    pub(crate) limits: NativeLimits,
}

/// A host may lower these limits to honor its request deadline; hard ceilings stay fixed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct NativeLimits {
    timeout: Duration,
    max_output_bytes: usize,
}

impl NativeLimits {
    pub(crate) fn bounded(timeout: Duration, max_output_bytes: usize) -> Option<Self> {
        let valid = !timeout.is_zero()
            && timeout <= MAX_TIMEOUT
            && max_output_bytes > 0
            && max_output_bytes <= MAX_OUTPUT_BYTES;
        valid.then_some(Self {
            timeout,
            max_output_bytes,
        })
    }
}

impl Default for NativeLimits {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_TIMEOUT,
            max_output_bytes: DEFAULT_OUTPUT_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeStatus {
    NotApplicable,
    Clean,
    Findings,
    Unavailable,
    Incomplete,
    Cancelled,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeCheckResult {
    pub(crate) status: NativeStatus,
    pub(crate) diagnostics: Vec<NativeDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
    pub(crate) evidence: Value,
    #[serde(skip)]
    pub(crate) comparison_safe: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEvidence {
    pub(crate) tool: String,
    pub(crate) tool_digest: String,
    pub(crate) environment_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_digest: Option<String>,
    pub(crate) argv: Vec<String>,
    pub(crate) elapsed_ms: u64,
    pub(crate) exit_code: Option<i32>,
    pub(crate) locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project_root: Option<String>,
    pub(crate) captured_output_bytes: usize,
    pub(crate) timeout_ms: u64,
    pub(crate) max_output_bytes: usize,
    pub(crate) cargo_offline: bool,
    pub(crate) target_cache: &'static str,
    pub(crate) isolation: &'static str,
    pub(crate) file_mode_policy: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) generated_lock_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) stderr_excerpt: Option<String>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeDiagnostic {
    pub(crate) code: String,
    pub(crate) severity: NativeSeverity,
    pub(crate) source: &'static str,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) help: Option<String>,
    pub(crate) location: NativeLocation,
    pub(crate) fingerprint: String,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeSeverity {
    Error,
    Warning,
}

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLocation {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) range: Option<NativeRange>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub(crate) struct NativeRange {
    pub(crate) start: NativePosition,
    pub(crate) end: NativePosition,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub(crate) struct NativePosition {
    pub(crate) line: u32,
    pub(crate) char: u32,
}

/// Runs the profile's intentionally fixed native command. Policy and decisions remain host-owned.
pub(crate) fn evaluate(request: &NativeCheckRequest<'_>) -> NativeCheckResult {
    match request.profile {
        crate::protocol::asp::ProviderProfile::RustNative => evaluate_rust(request),
        crate::protocol::asp::ProviderProfile::NodeNative => node::evaluate(request),
        crate::protocol::asp::ProviderProfile::PythonNative => python::evaluate(request),
        crate::protocol::asp::ProviderProfile::Fast => unavailable_result(
            request,
            "fast checks do not use the native execution backend",
        ),
    }
}

pub(crate) fn applicable(
    profile: crate::protocol::asp::ProviderProfile,
    files: &BTreeMap<RepoPath, Arc<[u8]>>,
) -> bool {
    match profile {
        crate::protocol::asp::ProviderProfile::RustNative => {
            files.keys().any(|path| path.as_bytes() == b"Cargo.toml")
        }
        crate::protocol::asp::ProviderProfile::NodeNative => node::applicable(files),
        crate::protocol::asp::ProviderProfile::PythonNative => python::applicable(files),
        crate::protocol::asp::ProviderProfile::Fast => false,
    }
}

pub(crate) fn not_applicable(profile: crate::protocol::asp::ProviderProfile) -> NativeCheckResult {
    let detail = match profile {
        crate::protocol::asp::ProviderProfile::RustNative => "the candidate has no root Cargo.toml",
        crate::protocol::asp::ProviderProfile::NodeNative => {
            "the candidate has no root locked npm TypeScript project"
        }
        crate::protocol::asp::ProviderProfile::PythonNative => "the candidate has no Python source",
        crate::protocol::asp::ProviderProfile::Fast => "fast is not a native provider",
    };
    NativeCheckResult {
        status: NativeStatus::NotApplicable,
        diagnostics: Vec::new(),
        detail: Some(detail.into()),
        evidence: json!({
            "profile": profile.cli_name(),
            "elapsedMs": 0,
            "isolation": "not-executed"
        }),
        comparison_safe: true,
    }
}

fn evaluate_rust(request: &NativeCheckRequest<'_>) -> NativeCheckResult {
    let started = Instant::now();
    let deadline = started
        .checked_add(request.limits.timeout)
        .unwrap_or(started);
    let tool = request.tool_program.to_string_lossy().into_owned();
    if request.cancel.is_cancelled() {
        return NativeEvidence::new(request, tool, Vec::new(), false).finish(
            NativeStatus::Cancelled,
            Vec::new(),
            "Rust-native evaluation was cancelled",
            started,
        );
    }
    if request.identity.runtime_path().is_none() {
        return NativeEvidence::new(request, tool, Vec::new(), false).finish(
            NativeStatus::Unavailable,
            Vec::new(),
            "Rust-native could not bind the PATH-selected rustc launcher",
            started,
        );
    }
    let applicability = match process::preflight(request, deadline) {
        Ok(applicability) => applicability,
        Err(failure) => {
            return NativeEvidence::new(request, tool, Vec::new(), false).finish(
                failure.status,
                Vec::new(),
                failure.detail,
                started,
            );
        }
    };
    let process::Applicability::Applicable {
        working_root,
        locked,
    } = applicability
    else {
        return NativeEvidence::new(
            request,
            tool,
            process::cargo_argv(false, request.project_root.is_some()),
            false,
        )
        .finish(
            NativeStatus::NotApplicable,
            Vec::new(),
            "the candidate has no root Cargo.toml",
            started,
        );
    };

    let argv = process::cargo_argv(locked, request.project_root.is_some());
    let mut evidence = NativeEvidence::new(request, tool, argv.clone(), locked);
    let execution = match process::run(request, &working_root, &argv, deadline) {
        Ok(execution) => execution,
        Err(failure) => {
            evidence.exit_code = failure.exit_code;
            evidence.captured_output_bytes = failure.captured_output_bytes;
            return evidence.finish(failure.status, Vec::new(), failure.detail, started);
        }
    };
    evidence.exit_code = execution.exit_status.code();
    evidence.captured_output_bytes = execution.captured_output_bytes();
    evidence.stderr_excerpt = output::stderr_excerpt(
        &execution.stderr,
        &execution.workspace_root,
        execution.target(),
    );
    if request
        .identity
        .verify(request.tool_program, request.cancel, deadline)
        .is_err()
    {
        let (status, detail) = if request.cancel.is_cancelled() {
            (
                NativeStatus::Cancelled,
                "Rust-native evaluation was cancelled",
            )
        } else {
            (
                NativeStatus::Incomplete,
                "the Cargo or rustc launcher changed or could not be verified during native evaluation",
            )
        };
        return evidence.finish(status, Vec::new(), detail, started);
    }
    assess_execution(&execution, request.source_files, evidence, started)
}

fn assess_execution(
    execution: &process::Execution,
    source_files: &BTreeMap<RepoPath, Arc<[u8]>>,
    evidence: NativeEvidence,
    started: Instant,
) -> NativeCheckResult {
    if !execution.exit_status.success() && output::unavailable(&execution.stderr, &execution.stdout)
    {
        let detail = detail_with_excerpt(
            "Cargo or an offline dependency/toolchain input was unavailable",
            evidence.stderr_excerpt.as_deref(),
        );
        return evidence.finish(NativeStatus::Unavailable, Vec::new(), detail, started);
    }
    let Ok(parsed) = output::parse(
        &execution.stdout,
        &execution.workspace_root,
        execution.target(),
        source_files,
    ) else {
        return evidence.finish(
            NativeStatus::Incomplete,
            Vec::new(),
            "Cargo returned malformed or unsupported message-format JSON",
            started,
        );
    };
    if parsed.build_finished != Some(true) && execution.exit_status.success() {
        return evidence.finish(
            NativeStatus::Incomplete,
            Vec::new(),
            "Cargo did not report a successful completed build",
            started,
        );
    }
    if !execution.exit_status.success() && parsed.error_count == 0 {
        let detail = detail_with_excerpt(
            "Cargo failed without a structured compiler error",
            evidence.stderr_excerpt.as_deref(),
        );
        return evidence.finish(NativeStatus::Incomplete, Vec::new(), detail, started);
    }
    let status = if parsed.diagnostics.is_empty() {
        NativeStatus::Clean
    } else {
        NativeStatus::Findings
    };
    evidence.finish(status, parsed.diagnostics, "", started)
}

impl NativeEvidence {
    fn new(
        request: &NativeCheckRequest<'_>,
        tool: String,
        argv: Vec<String>,
        locked: bool,
    ) -> Self {
        Self {
            tool,
            tool_digest: request.identity.tool_digest.clone(),
            environment_digest: request.identity.environment_digest.clone(),
            runtime: request
                .identity
                .runtime
                .as_ref()
                .map(|runtime| runtime.kind),
            runtime_digest: request
                .identity
                .runtime
                .as_ref()
                .map(|runtime| runtime.digest.clone()),
            argv,
            elapsed_ms: 0,
            exit_code: None,
            locked,
            project_root: request.project_root.map(ToString::to_string),
            captured_output_bytes: 0,
            timeout_ms: millis(request.limits.timeout),
            max_output_bytes: request.limits.max_output_bytes,
            cargo_offline: true,
            target_cache: "ephemeral",
            isolation: "host-sandbox-required",
            file_mode_policy: "regular-owner-read-write",
            generated_lock_digest: None,
            stderr_excerpt: None,
        }
    }

    fn finish(
        mut self,
        status: NativeStatus,
        diagnostics: Vec<NativeDiagnostic>,
        detail: impl Into<String>,
        started: Instant,
    ) -> NativeCheckResult {
        self.elapsed_ms = millis(started.elapsed());
        let detail = detail.into();
        let comparison_safe = status == NativeStatus::NotApplicable || self.exit_code == Some(0);
        let evidence =
            serde_json::to_value(self).unwrap_or_else(|_| json!({ "serializationFailure": true }));
        NativeCheckResult {
            status,
            diagnostics,
            detail: (!detail.is_empty()).then_some(detail),
            evidence,
            comparison_safe,
        }
    }
}

pub(super) fn unavailable_result(
    request: &NativeCheckRequest<'_>,
    detail: &str,
) -> NativeCheckResult {
    NativeCheckResult {
        status: NativeStatus::Unavailable,
        diagnostics: Vec::new(),
        detail: Some(detail.to_owned()),
        evidence: json!({
            "tool": request.tool_program,
            "elapsedMs": 0,
            "isolation": "host-sandbox-required"
        }),
        comparison_safe: false,
    }
}

#[cfg(test)]
impl NativeEvidence {
    pub(crate) fn test_value() -> Self {
        let limits = NativeLimits::default();
        Self {
            tool: "/usr/bin/cargo".into(),
            tool_digest: "sha256:test-tool".into(),
            environment_digest: "sha256:test-environment".into(),
            runtime: Some("rustc-launcher"),
            runtime_digest: Some("sha256:test-runtime".into()),
            argv: process::cargo_argv(false, false),
            elapsed_ms: 0,
            exit_code: None,
            locked: false,
            project_root: None,
            captured_output_bytes: 0,
            timeout_ms: millis(limits.timeout),
            max_output_bytes: limits.max_output_bytes,
            cargo_offline: true,
            target_cache: "ephemeral",
            isolation: "host-sandbox-required",
            file_mode_policy: "regular-owner-read-write",
            generated_lock_digest: None,
            stderr_excerpt: None,
        }
    }
}

#[cfg(test)]
impl NativeDiagnostic {
    pub(crate) fn test_value(fingerprint: &str) -> Self {
        Self {
            code: format!("{SOURCE}/{RULE}"),
            severity: NativeSeverity::Error,
            source: SOURCE,
            message: "test diagnostic".to_owned(),
            help: Some("test help".to_owned()),
            location: NativeLocation {
                path: "src/lib.rs".to_owned(),
                range: None,
            },
            fingerprint: fingerprint.to_owned(),
        }
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

pub(super) fn evaluation_window(timeout: Duration) -> (Instant, Instant) {
    let started = Instant::now();
    let deadline = started.checked_add(timeout).unwrap_or(started);
    (started, deadline)
}

pub(super) fn private_temp_environment(workspace_root: &Path) -> [(OsString, OsString); 3] {
    let temporary = workspace_root
        .parent()
        .unwrap_or(workspace_root)
        .as_os_str()
        .to_owned();
    [
        (OsString::from("TMPDIR"), temporary.clone()),
        (OsString::from("TMP"), temporary.clone()),
        (OsString::from("TEMP"), temporary),
    ]
}

pub(super) fn common_evidence(
    request: &NativeCheckRequest<'_>,
    started: Instant,
    captured_output_bytes: usize,
    exit_code: Option<i32>,
) -> serde_json::Map<String, Value> {
    let runtime = request.identity.runtime.as_ref();
    json!({
        "tool": request.tool_program.to_string_lossy(),
        "toolDigest": request.identity.tool_digest,
        "environmentDigest": request.identity.environment_digest,
        "runtime": runtime.map(|identity| identity.kind),
        "runtimeDigest": runtime.map(|identity| identity.digest.as_str()),
        "runtimeSource": runtime.map(|identity| identity.source),
        "runtimeEnvironmentMarkerDigest": runtime
            .and_then(|identity| identity.marker.as_ref())
            .map(|(_, digest)| digest.as_str()),
        "elapsedMs": millis(started.elapsed()),
        "exitCode": exit_code,
        "capturedOutputBytes": captured_output_bytes,
        "timeoutMs": millis(request.limits.timeout),
        "maxOutputBytes": request.limits.max_output_bytes,
        "isolation": "host-sandbox-required",
        "fileModePolicy": "regular-owner-read-write"
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

pub(super) fn complete_result(
    status: NativeStatus,
    diagnostics: Vec<NativeDiagnostic>,
    detail: String,
    evidence: serde_json::Map<String, Value>,
    comparison_safe: bool,
) -> NativeCheckResult {
    NativeCheckResult {
        status,
        diagnostics,
        detail: (!detail.is_empty()).then_some(detail),
        evidence: Value::Object(evidence),
        comparison_safe,
    }
}

pub(super) fn resolve_diagnostic_path(
    raw: &str,
    workspace_root: &Path,
    files: &BTreeMap<RepoPath, Arc<[u8]>>,
) -> Option<RepoPath> {
    let candidate = Path::new(raw);
    let relative = if candidate.is_absolute() {
        candidate.strip_prefix(workspace_root).ok()?
    } else {
        candidate
    };
    let normalized = relative.to_string_lossy().replace('\\', "/");
    let path = RepoPath::from_protocol(&normalized).ok()?;
    files.contains_key(&path).then_some(path)
}

#[derive(Clone, Copy)]
pub(super) struct NativeFingerprintInput<'input> {
    pub(super) domain: &'static str,
    pub(super) code: &'input str,
    pub(super) message: &'input str,
    pub(super) path: &'input RepoPath,
    pub(super) range: Option<NativeRange>,
    pub(super) files: &'input BTreeMap<RepoPath, Arc<[u8]>>,
}

pub(super) fn diagnostic_fingerprint(input: NativeFingerprintInput<'_>) -> String {
    let line = input
        .range
        .and_then(|range| usize::try_from(range.start.line).ok())
        .and_then(|line| {
            input
                .files
                .get(input.path)?
                .split(|byte| *byte == b'\n')
                .nth(line)
        })
        .map(normalized_bytes)
        .unwrap_or_default();
    hex::encode(hash_domain(
        input.domain,
        &[input.code.as_bytes(), input.message.as_bytes(), &line],
    ))
}

fn normalized_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut whitespace = false;
    for byte in bytes {
        if byte.is_ascii_whitespace() {
            whitespace = !normalized.is_empty();
        } else {
            if whitespace {
                normalized.push(b' ');
                whitespace = false;
            }
            normalized.push(*byte);
        }
    }
    normalized
}

pub(super) fn sort_diagnostics(diagnostics: &mut Vec<NativeDiagnostic>) {
    diagnostics.sort_by(|left, right| {
        (&left.location, &left.code, &left.message, &left.fingerprint).cmp(&(
            &right.location,
            &right.code,
            &right.message,
            &right.fingerprint,
        ))
    });
    diagnostics.dedup();
}

pub(super) fn output_detail(summary: &str, stdout: &[u8], stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    let lines = || stderr.lines().chain(stdout.lines());
    let mut excerpt = lines()
        .filter(|line| failure_line(line) && !bare_failure_marker(line))
        .take(3)
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" | ");
    if excerpt.is_empty()
        && let Some(line) = lines().find(|line| !line.trim().is_empty())
    {
        excerpt.push_str(line.trim());
    }
    let excerpt = (!excerpt.is_empty()).then(|| excerpt.chars().take(512).collect::<String>());
    excerpt.map_or_else(
        || summary.to_owned(),
        |excerpt| format!("{summary}: {excerpt}"),
    )
}

fn bare_failure_marker(line: &str) -> bool {
    let marker = line.trim().strip_prefix("npm ").unwrap_or(line.trim());
    ["error", "fatal", "failed"]
        .iter()
        .any(|candidate| marker.eq_ignore_ascii_case(candidate))
}

fn failure_line(line: &str) -> bool {
    [b"error".as_slice(), b"fatal", b"failed"]
        .iter()
        .any(|needle| {
            line.as_bytes()
                .windows(needle.len())
                .any(|window| window.eq_ignore_ascii_case(needle))
        })
}

fn detail_with_excerpt(summary: &str, excerpt: Option<&str>) -> String {
    excerpt.map_or_else(
        || summary.to_owned(),
        |excerpt| format!("{summary}: {excerpt}"),
    )
}

fn digest_tool(path: &Path, cancel: &CancelToken, deadline: Instant) -> Result<String, String> {
    require_tool_identity_active(cancel, deadline)?;
    let before = bounded_tool_metadata(path)?;
    let mut file = File::open(path).map_err(|error| format!("open native tool: {error}"))?;
    let digest = read_tool_digest(&mut file, before.len(), cancel, deadline)?;
    let after = file
        .metadata()
        .map_err(|error| format!("reinspect native tool: {error}"))?;
    ensure_unchanged_tool(&before, &after)?;
    Ok(format!("sha256:{}", hex::encode(digest.finalize())))
}

fn bounded_tool_metadata(path: &Path) -> Result<Metadata, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("inspect native tool: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_TOOL_BYTES {
        return Err("the native tool is not a bounded regular file".into());
    }
    Ok(metadata)
}

fn read_tool_digest(
    file: &mut File,
    expected_bytes: u64,
    cancel: &CancelToken,
    deadline: Instant,
) -> Result<Sha256, String> {
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    let maximum = expected_bytes
        .checked_add(1)
        .ok_or_else(|| "native tool byte bound overflowed".to_owned())?;
    let mut total = 0_u64;
    loop {
        require_tool_identity_active(cancel, deadline)?;
        let remaining = maximum.saturating_sub(total);
        if remaining == 0 {
            return Err("the native tool grew while it was read".into());
        }
        let limit = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let read = file
            .read(&mut buffer[..limit])
            .map_err(|error| format!("read native tool: {error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or_else(|| "native tool byte count overflowed".to_owned())?;
        digest.update(&buffer[..read]);
    }
    if total != expected_bytes {
        return Err("the native tool changed length while it was read".into());
    }
    Ok(digest)
}

fn require_tool_identity_active(cancel: &CancelToken, deadline: Instant) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("native tool identity capture was cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("native tool identity capture exceeded its wallclock grant".into());
    }
    Ok(())
}

fn ensure_unchanged_tool(before: &Metadata, after: &Metadata) -> Result<(), String> {
    if !same_tool_identity(before, after) {
        return Err("the native tool changed while it was read".into());
    }
    Ok(())
}

#[cfg(unix)]
fn same_tool_identity(before: &Metadata, after: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;

    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
        && before.modified().ok() == after.modified().ok()
}

#[cfg(not(unix))]
fn same_tool_identity(before: &Metadata, after: &Metadata) -> bool {
    before.len() == after.len() && before.modified().ok() == after.modified().ok()
}

fn digest_environment(
    profile: crate::protocol::asp::ProviderProfile,
    environment: &[(OsString, OsString)],
    runtime: Option<&RuntimeIdentity>,
) -> String {
    let mut digest = Sha256::new();
    update_bytes_digest(&mut digest, profile.cli_name().as_bytes());
    for (key, value) in environment {
        update_os_digest(&mut digest, key);
        update_os_digest(&mut digest, value);
    }
    for (key, value) in fixed_environment(profile) {
        update_bytes_digest(&mut digest, key.as_bytes());
        update_bytes_digest(&mut digest, value.as_bytes());
    }
    if let Some(runtime) = runtime {
        update_bytes_digest(&mut digest, runtime.kind.as_bytes());
        update_bytes_digest(&mut digest, runtime.digest.as_bytes());
        update_bytes_digest(&mut digest, runtime.source.as_bytes());
        if let Some((_, marker_digest)) = &runtime.marker {
            update_bytes_digest(&mut digest, marker_digest.as_bytes());
        }
    }
    format!("sha256:{}", hex::encode(digest.finalize()))
}

fn update_os_digest(digest: &mut Sha256, value: &OsStr) {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt as _;
        update_bytes_digest(digest, value.as_bytes());
    }
    #[cfg(not(unix))]
    update_bytes_digest(digest, value.to_string_lossy().as_bytes());
}

fn update_bytes_digest(digest: &mut Sha256, value: &[u8]) {
    digest.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    digest.update(value);
}

#[cfg(test)]
pub(super) mod test_support {
    use std::{
        collections::BTreeMap,
        fs,
        os::unix::fs::PermissionsExt as _,
        path::{Path, PathBuf},
        sync::Arc,
        time::{Duration, Instant},
    };

    use crate::{cancel::CancelToken, path::RepoPath, protocol::asp::ProviderProfile};

    use super::{NativeCheckRequest, NativeExecutionIdentity, NativeLimits};

    pub(super) struct NativeHarness {
        profile: ProviderProfile,
        _workspace: tempfile::TempDir,
        workspace_root: PathBuf,
        _tools: tempfile::TempDir,
        files: BTreeMap<RepoPath, Arc<[u8]>>,
        tool: PathBuf,
        identity: NativeExecutionIdentity,
        cancel: CancelToken,
    }

    impl NativeHarness {
        pub(super) fn new(
            profile: ProviderProfile,
            entries: &[(&str, &str)],
            tool_name: &str,
            tool_source: &str,
            cancelled: bool,
        ) -> Self {
            let workspace = tempfile::tempdir().expect("workspace");
            let workspace_root = workspace
                .path()
                .canonicalize()
                .expect("canonical workspace");
            let files = materialize(&workspace_root, entries);
            let tools = tempfile::tempdir().expect("tool directory");
            let tool = tools.path().join(tool_name);
            executable(&tool, tool_source);
            let cancel = CancelToken::new();
            let identity = NativeExecutionIdentity::capture(
                profile,
                &tool,
                &cancel,
                Instant::now() + Duration::from_secs(30),
            )
            .expect("capture fake native tool");
            if cancelled {
                cancel.cancel();
            }
            Self {
                profile,
                _workspace: workspace,
                workspace_root,
                _tools: tools,
                files,
                tool,
                identity,
                cancel,
            }
        }

        pub(super) fn insert_virtual(&mut self, path: RepoPath, content: &[u8]) {
            self.files.insert(path, Arc::<[u8]>::from(content));
        }

        pub(super) fn request(&self) -> NativeCheckRequest<'_> {
            NativeCheckRequest {
                profile: self.profile,
                workspace_root: &self.workspace_root,
                project_root: None,
                source_files: &self.files,
                tool_program: &self.tool,
                identity: &self.identity,
                cancel: &self.cancel,
                limits: NativeLimits::bounded(Duration::from_secs(30), 64 * 1024)
                    .expect("test limits"),
            }
        }
    }

    pub(super) fn executable(path: &Path, source: &str) {
        fs::write(path, source).expect("write fake native tool");
        let mut permissions = fs::metadata(path)
            .expect("fake native tool metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).expect("make fake native tool executable");
    }

    fn materialize(root: &Path, entries: &[(&str, &str)]) -> BTreeMap<RepoPath, Arc<[u8]>> {
        entries
            .iter()
            .map(|(raw_path, content)| {
                let path = RepoPath::from_protocol(raw_path).expect("fixture path");
                let disk_path = root.join(path.to_path_buf());
                if let Some(parent) = disk_path.parent() {
                    fs::create_dir_all(parent).expect("create fixture parent");
                }
                fs::write(&disk_path, content).expect("write fixture content");
                (path, Arc::<[u8]>::from(content.as_bytes()))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rust_request<'a>(
        workspace_root: &'a Path,
        source_files: &'a BTreeMap<RepoPath, Arc<[u8]>>,
        tool_program: &'a Path,
        identity: &'a NativeExecutionIdentity,
        cancel: &'a CancelToken,
    ) -> NativeCheckRequest<'a> {
        NativeCheckRequest {
            profile: crate::protocol::asp::ProviderProfile::RustNative,
            workspace_root,
            project_root: None,
            source_files,
            tool_program,
            identity,
            cancel,
            limits: NativeLimits::default(),
        }
    }

    #[test]
    fn limits_reject_unbounded_requests() {
        assert!(NativeLimits::bounded(Duration::ZERO, 1).is_none());
        assert!(NativeLimits::bounded(MAX_TIMEOUT + Duration::from_secs(1), 1).is_none());
        assert!(NativeLimits::bounded(Duration::from_secs(1), MAX_OUTPUT_BYTES + 1).is_none());
    }

    #[test]
    fn failure_details_prefer_actionable_lines_over_warnings() {
        let detail = output_detail(
            "tool failed",
            b"",
            b"npm warn unsupported engine\nnpm error code EUSAGE\nnpm error\n\
              npm error package.json and package-lock.json are not in sync\n",
        );
        assert_eq!(
            detail,
            "tool failed: npm error code EUSAGE | npm error package.json and package-lock.json are not in sync"
        );
    }

    #[test]
    fn cancellation_preempts_workspace_and_tool_inspection() {
        let cancel = CancelToken::new();
        cancel.cancel();
        let cargo = std::env::current_exe().unwrap();
        let active = CancelToken::new();
        let identity = NativeExecutionIdentity::capture(
            crate::protocol::asp::ProviderProfile::RustNative,
            &cargo,
            &active,
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        let source_files = BTreeMap::new();
        let request = rust_request(
            Path::new("/missing-workspace"),
            &source_files,
            &cargo,
            &identity,
            &cancel,
        );

        assert_eq!(evaluate(&request).status, NativeStatus::Cancelled);
    }

    #[cfg(unix)]
    #[test]
    fn successful_non_cargo_process_cannot_report_clean() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("Cargo.toml"),
            "[package]\nname='fake-cargo-test'\nversion='0.1.0'\n",
        )
        .unwrap();
        let tools = tempfile::tempdir().unwrap();
        let cargo = tools.path().join("not-cargo");
        test_support::executable(&cargo, "#!/bin/sh\nexit 0\n");
        let cancel = CancelToken::new();
        let identity = NativeExecutionIdentity::capture(
            crate::protocol::asp::ProviderProfile::RustNative,
            &cargo,
            &cancel,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
        let source_files = BTreeMap::new();
        let request = rust_request(workspace.path(), &source_files, &cargo, &identity, &cancel);

        assert_eq!(evaluate(&request).status, NativeStatus::Incomplete);
    }
}
