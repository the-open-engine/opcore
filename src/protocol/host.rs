//! Minimal ASP Core host transport for bundled providers.
//!
//! The host owns an immutable callback view and never gives a provider a repository path. The
//! caller remains responsible for Git capture, freshness, policy, and decisions.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    io::{BufRead, BufReader, Read, Write},
    os::unix::process::CommandExt as _,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc,
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use rustix::process::{
    Pid, Signal, WaitId, WaitIdOptions, kill_process_group as signal_process_group, waitid,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    json::parse_unique_json,
    limits::{MAX_FILES, MAX_FRAME_BYTES, MAX_SOURCE_BYTES, MAX_TOTAL_SOURCE_BYTES},
    path::RepoPath,
    protocol::asp::{PROTOCOL_VERSION, ProviderProfile},
};

mod validation;

use validation::{validate_assessment, validate_initialize_result};

const DEFAULT_WALLCLOCK_MS: u64 = 30_000;
const MAX_WALLCLOCK_MS: u64 = 300_000;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const PROVIDER_STARTUP_RESERVE: Duration = Duration::from_secs(1);
const PROVIDER_SHUTDOWN_RESERVE: Duration = Duration::from_secs(1);
const PRIVATE_TEMP_BASES: &[&str] = &["/tmp", "/var/tmp"];

/// Exact executable and arguments for one provider process.
#[derive(Clone, Debug)]
pub(crate) struct ProviderCommand {
    executable: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    profile: Option<ProviderProfile>,
}

impl ProviderCommand {
    /// Creates a provider command without invoking a shell.
    #[must_use]
    pub(crate) fn new(
        executable: impl Into<PathBuf>,
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        Self {
            executable: executable.into(),
            arguments: arguments.into_iter().map(Into::into).collect(),
            environment: Vec::new(),
            profile: None,
        }
    }

    /// Selects one bundled provider with a validated private project path.
    pub(crate) fn current_scoped(
        profile: ProviderProfile,
        project_root: Option<&RepoPath>,
    ) -> Result<Self> {
        let executable = std::env::current_exe().context("locate current Opcore executable")?;
        let mut command = Self::new(executable, provider_arguments(profile));
        if let Some(project_root) = project_root {
            command.arguments.push("--project-root".into());
            command.arguments.push(project_root.to_string().into());
        }
        command.profile = Some(profile);
        command.environment = provider_environment(profile);
        Ok(command)
    }

    /// Replaces one explicitly inherited variable without exposing the caller's ambient process
    /// environment wholesale.
    pub(crate) fn with_environment(
        mut self,
        name: &'static str,
        value: impl Into<OsString>,
    ) -> Self {
        self.environment
            .retain(|(existing, _)| existing != OsStr::new(name));
        self.environment.push((name.into(), value.into()));
        self
    }
}

fn provider_arguments(profile: ProviderProfile) -> Vec<&'static str> {
    match profile {
        ProviderProfile::Fast => vec!["serve", "--stdio"],
        _ => vec!["serve", "--stdio", "--profile", profile.cli_name()],
    }
}

fn provider_environment(profile: ProviderProfile) -> Vec<(OsString, OsString)> {
    super::native::child_environment(profile)
        .iter()
        .copied()
        .chain(configured_variables(profile).iter().copied())
        .filter_map(|name| std::env::var_os(name).map(|value| (name.into(), value)))
        .collect()
}

const fn configured_variables(profile: ProviderProfile) -> &'static [&'static str] {
    match profile {
        ProviderProfile::Fast => &[],
        ProviderProfile::RustNative => &["OPCORE_CARGO"],
        ProviderProfile::NodeNative => &["OPCORE_NPM"],
        ProviderProfile::PythonNative => &["OPCORE_PYRIGHT", "OPCORE_MYPY"],
    }
}

/// Immutable baseline tree and content-addressed blob grant exposed through ASP callbacks.
#[derive(Clone, Debug)]
pub(crate) struct HostWorkspace {
    baseline: Value,
    entries: BTreeMap<RepoPath, String>,
    blobs: BTreeMap<String, Arc<[u8]>>,
    total_blob_bytes: usize,
}

impl HostWorkspace {
    /// Starts an empty callback view bound to one ASP baseline stamp.
    ///
    /// # Errors
    ///
    /// Returns an error when the baseline has no non-empty string `rev`.
    pub(crate) fn new(baseline: Value) -> Result<Self> {
        let rev = baseline
            .get("rev")
            .and_then(Value::as_str)
            .context("ASP baseline requires a string rev")?;
        if rev.is_empty() {
            bail!("ASP baseline rev must not be empty");
        }
        Ok(Self {
            baseline,
            entries: BTreeMap::new(),
            blobs: BTreeMap::new(),
            total_blob_bytes: 0,
        })
    }

    /// Adds one baseline file and returns its canonical blob reference.
    ///
    /// # Errors
    ///
    /// Returns an error for duplicate paths or when a workspace byte/file bound is exceeded.
    pub(crate) fn add_baseline_file(
        &mut self,
        path: RepoPath,
        bytes: impl Into<Arc<[u8]>>,
    ) -> Result<String> {
        if self.entries.len() >= MAX_FILES {
            bail!("ASP host workspace exceeds {MAX_FILES} baseline files");
        }
        if self.entries.contains_key(&path) {
            bail!("duplicate ASP host baseline path {path}");
        }
        let blob = self.add_blob(bytes)?;
        self.entries.insert(path, blob.clone());
        Ok(blob)
    }

    /// Adds candidate content to the callback grant and returns its canonical blob reference.
    ///
    /// # Errors
    ///
    /// Returns an error when a workspace byte bound is exceeded.
    pub(crate) fn add_candidate_blob(&mut self, bytes: impl Into<Arc<[u8]>>) -> Result<String> {
        self.add_blob(bytes)
    }

    #[must_use]
    pub(crate) fn baseline(&self) -> &Value {
        &self.baseline
    }

    fn add_blob(&mut self, bytes: impl Into<Arc<[u8]>>) -> Result<String> {
        let bytes = bytes.into();
        if bytes.len() > MAX_SOURCE_BYTES {
            bail!("ASP host blob exceeds {MAX_SOURCE_BYTES} bytes");
        }
        let id = format!("blob:sha256:{}", hex::encode(Sha256::digest(&bytes)));
        if let Some(existing) = self.blobs.get(&id) {
            if existing.as_ref() != bytes.as_ref() {
                bail!("unequal content produced the same ASP blob reference");
            }
            return Ok(id);
        }
        let total = self
            .total_blob_bytes
            .checked_add(bytes.len())
            .context("ASP host blob byte count overflow")?;
        if total > MAX_TOTAL_SOURCE_BYTES {
            bail!("ASP host blobs exceed {MAX_TOTAL_SOURCE_BYTES} total bytes");
        }
        self.total_blob_bytes = total;
        self.blobs.insert(id.clone(), bytes);
        Ok(id)
    }

    fn callback(&self, method: &str, params: &Value) -> Result<Value> {
        match method {
            "workspace/listTree" => self.list_tree(params),
            "workspace/readBlob" => self.read_blobs(params),
            _ => bail!("provider requested unsupported callback {method}"),
        }
    }

    fn list_tree(&self, params: &Value) -> Result<Value> {
        let object = exact_object(params, &["baseline", "paths"], "workspace/listTree")?;
        if object.get("baseline") != Some(&self.baseline) {
            bail!("workspace/listTree requested a stale or unknown baseline");
        }
        let requested = object
            .get("paths")
            .map(|paths| {
                serde_json::from_value::<Vec<RepoPath>>(paths.clone())
                    .context("workspace/listTree paths must be valid repository paths")
            })
            .transpose()?;
        if requested
            .as_ref()
            .is_some_and(|paths| paths.len() > MAX_FILES)
        {
            bail!("workspace/listTree exceeds {MAX_FILES} requested paths");
        }
        let requested = requested
            .map(|paths| {
                let count = paths.len();
                let paths = paths.into_iter().collect::<BTreeSet<_>>();
                if paths.len() != count {
                    bail!("workspace/listTree contains duplicate paths");
                }
                Ok(paths)
            })
            .transpose()?;
        let entries = self
            .entries
            .iter()
            .filter(|(path, _)| {
                requested
                    .as_ref()
                    .is_none_or(|requested| requested.contains(*path))
            })
            .map(|(path, blob)| json!({ "path": path, "blobId": blob, "kind": "file" }))
            .collect::<Vec<_>>();
        Ok(json!({ "entries": entries, "truncated": false }))
    }

    fn read_blobs(&self, params: &Value) -> Result<Value> {
        let object = exact_object(params, &["blobs"], "workspace/readBlob")?;
        let ids = object
            .get("blobs")
            .and_then(Value::as_array)
            .context("workspace/readBlob.blobs must be an array")?;
        if ids.len() != 1 {
            bail!("workspace/readBlob requires exactly one blob per bounded callback");
        }
        let mut seen = BTreeSet::new();
        let mut blobs = Vec::with_capacity(ids.len());
        for value in ids {
            let id = value
                .as_str()
                .context("workspace/readBlob ids must be strings")?;
            if !seen.insert(id) {
                bail!("workspace/readBlob contains duplicate id {id}");
            }
            let bytes = self
                .blobs
                .get(id)
                .with_context(|| format!("workspace/readBlob requested unknown id {id}"))?;
            blobs.push(encoded_blob(id, bytes));
        }
        Ok(json!({ "blobs": blobs }))
    }
}

/// One canonical `check/evaluate` request and its bounded resource grant.
#[derive(Clone, Debug)]
pub(crate) struct HostRequest {
    workspace: HostWorkspace,
    evaluation_params: Value,
    wallclock_ms: u64,
    candidate_root: Option<PathBuf>,
}

impl HostRequest {
    /// Creates one host request using the default wallclock grant.
    ///
    /// # Errors
    ///
    /// Returns an error unless `evaluation_params` is a JSON object.
    pub(crate) fn new(workspace: HostWorkspace, evaluation_params: Value) -> Result<Self> {
        if !evaluation_params.is_object() {
            bail!("check/evaluate params must be an object");
        }
        Ok(Self {
            workspace,
            evaluation_params,
            wallclock_ms: DEFAULT_WALLCLOCK_MS,
            candidate_root: None,
        })
    }

    /// Narrows or expands the wallclock grant within the protocol hard ceiling.
    ///
    /// # Errors
    ///
    /// Returns an error for a zero or excessive grant.
    pub(crate) fn with_wallclock_ms(mut self, wallclock_ms: u64) -> Result<Self> {
        if !(1..=MAX_WALLCLOCK_MS).contains(&wallclock_ms) {
            bail!("ASP host wallclock grant must be between 1 and {MAX_WALLCLOCK_MS} ms");
        }
        self.wallclock_ms = wallclock_ms;
        Ok(self)
    }

    /// Keeps provider-private scratch outside the caller's candidate repository.
    pub(crate) fn with_candidate_root(mut self, root: &Path) -> Result<Self> {
        self.candidate_root = Some(
            root.canonicalize()
                .context("resolve candidate root for private ASP scratch")?,
        );
        Ok(self)
    }
}

/// Runs one provider process through the complete ASP Core lifecycle.
///
/// # Errors
///
/// Returns an error for process failures, protocol violations, callback refusals, oversized
/// frames, or an expired wallclock grant.
pub(crate) fn evaluate(command: &ProviderCommand, request: &HostRequest) -> Result<Value> {
    let timing = LifecycleTiming::new(Instant::now(), request.wallclock_ms)?;
    let mut provider = ProviderProcess::spawn_avoiding(command, request.candidate_root.as_deref())?;
    let result = run_lifecycle(&mut provider, request, timing);
    if result.is_err() {
        provider.terminate();
        return result;
    }
    provider
        .shutdown(&request.workspace, timing.shutdown_deadline)
        .context("complete ASP provider shutdown")?;
    result
}

#[derive(Clone, Copy)]
struct LifecycleTiming {
    evaluation_deadline: Instant,
    shutdown_deadline: Instant,
    provider_wallclock_ms: u64,
}

impl LifecycleTiming {
    fn new(started: Instant, wallclock_ms: u64) -> Result<Self> {
        let total = Duration::from_millis(wallclock_ms);
        let evaluation = total
            .checked_sub(PROVIDER_SHUTDOWN_RESERVE)
            .context("ASP host wallclock grant leaves no provider shutdown time")?;
        let provider = evaluation
            .checked_sub(PROVIDER_STARTUP_RESERVE)
            .context("ASP host wallclock grant leaves no provider startup time")?;
        if provider.is_zero() {
            bail!("ASP host wallclock grant leaves no provider evaluation time");
        }
        Ok(Self {
            evaluation_deadline: started
                .checked_add(evaluation)
                .context("ASP host evaluation deadline overflow")?,
            shutdown_deadline: started
                .checked_add(total)
                .context("ASP host shutdown deadline overflow")?,
            provider_wallclock_ms: u64::try_from(provider.as_millis())
                .context("ASP provider wallclock grant overflow")?,
        })
    }
}

fn run_lifecycle(
    provider: &mut ProviderProcess,
    request: &HostRequest,
    timing: LifecycleTiming,
) -> Result<Value> {
    let mut read_blobs = BTreeSet::new();
    provider.send(
        &json!({
            "jsonrpc": "2.0", "id": "host:initialize", "method": "initialize", "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "host": { "name": "opcore-host", "version": env!("CARGO_PKG_VERSION") },
                "workspace": { "root": "/candidate", "baseline": request.workspace.baseline() }
            }
        }),
        timing.evaluation_deadline,
    )?;
    let initialized = provider.wait_response(
        "host:initialize",
        &request.workspace,
        timing.evaluation_deadline,
        false,
        &mut read_blobs,
    )?;
    let profile = provider
        .profile()
        .context("minimal ASP host only launches a bundled provider profile")?;
    validate_initialize_result(&initialized, profile)?;
    provider.send(
        &json!({
            "jsonrpc": "2.0", "method": "initialized", "params": {
                "grantedPermissions": {
                    "read": ["**/*"], "write": false, "network": false,
                    "resourceLimits": { "wallclockMs": timing.provider_wallclock_ms }
                },
                "baseline": request.workspace.baseline()
            }
        }),
        timing.evaluation_deadline,
    )?;
    provider.send(
        &json!({
            "jsonrpc": "2.0", "id": "host:evaluate", "method": "check/evaluate",
            "params": request.evaluation_params
        }),
        timing.evaluation_deadline,
    )?;
    let assessment = provider.wait_response(
        "host:evaluate",
        &request.workspace,
        timing.evaluation_deadline,
        true,
        &mut read_blobs,
    )?;
    validate_assessment(assessment, request, profile, &read_blobs)
}

fn encoded_blob(id: &str, bytes: &[u8]) -> Value {
    // Base64 has one predictable 4/3 expansion. JSON-escaping arbitrary valid UTF-8 can expand a
    // bounded source blob by 6x before the enclosing frame limit can be checked.
    json!({
        "id": id,
        "encoding": "base64",
        "bytes": base64::engine::general_purpose::STANDARD.encode(bytes)
    })
}

fn exact_object<'a>(
    value: &'a Value,
    allowed: &[&str],
    method: &str,
) -> Result<&'a serde_json::Map<String, Value>> {
    let object = value
        .as_object()
        .with_context(|| format!("{method} params must be an object"))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        bail!("{method} contains unsupported field {field}");
    }
    Ok(object)
}

enum ReaderEvent {
    Frame(Vec<u8>),
    Invalid(String),
    Eof,
}

struct ProviderProcess {
    child: Child,
    process_group: Option<Pid>,
    profile: Option<ProviderProfile>,
    stdin: Option<mpsc::Sender<WriteRequest>>,
    frames: Receiver<ReaderEvent>,
    stderr: Receiver<Vec<u8>>,
    _working_directory: tempfile::TempDir,
}

impl ProviderProcess {
    #[cfg(test)]
    fn spawn(spec: &ProviderCommand) -> Result<Self> {
        Self::spawn_avoiding(spec, None)
    }

    fn spawn_avoiding(spec: &ProviderCommand, forbidden: Option<&Path>) -> Result<Self> {
        let working_directory = private_provider_directory(forbidden)?;
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.arguments)
            .current_dir(working_directory.path())
            .env_clear()
            .envs(spec.environment.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.process_group(0);
        let mut child = command
            .spawn()
            .with_context(|| format!("start ASP provider {}", spec.executable.display()))?;
        let process_group = Pid::from_child(&child);
        let (stdin, frames, stderr_receiver) = match configure_child(&mut child) {
            Ok(configured) => configured,
            Err(error) => {
                terminate_process_group(&mut child, process_group);
                return Err(error);
            }
        };
        Ok(Self {
            child,
            process_group: Some(process_group),
            profile: spec.profile,
            stdin: Some(stdin),
            frames,
            stderr: stderr_receiver,
            _working_directory: working_directory,
        })
    }

    fn send(&mut self, value: &Value, deadline: Instant) -> Result<()> {
        let bytes = serde_json::to_vec(value).context("serialize ASP host frame")?;
        if bytes.len() > MAX_FRAME_BYTES {
            bail!("ASP host frame exceeds {MAX_FRAME_BYTES} bytes");
        }
        let stdin = self
            .stdin
            .as_ref()
            .context("ASP provider stdin is closed")?;
        let (completion, completed) = mpsc::sync_channel(1);
        stdin
            .send(WriteRequest { bytes, completion })
            .context("ASP provider stdin writer stopped")?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("ASP provider write exceeded its wallclock grant")?;
        match completed.recv_timeout(remaining) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => bail!("write ASP host frame: {error}"),
            Err(RecvTimeoutError::Timeout) => {
                bail!("ASP provider write exceeded its wallclock grant")
            }
            Err(RecvTimeoutError::Disconnected) => bail!("ASP provider stdin writer stopped"),
        }
    }

    fn wait_response(
        &mut self,
        expected_id: &str,
        workspace: &HostWorkspace,
        deadline: Instant,
        callbacks_allowed: bool,
        read_blobs: &mut BTreeSet<String>,
    ) -> Result<Value> {
        loop {
            let value = self.receive(deadline)?;
            let object = response_object(&value, expected_id)?;
            if let Some(method) = object.get("method") {
                if !callbacks_allowed {
                    bail!("ASP provider requested a workspace callback outside evaluation");
                }
                self.answer_callback(object, method, workspace, deadline, read_blobs)?;
                continue;
            }
            return rpc_result(object);
        }
    }

    fn answer_callback(
        &mut self,
        object: &serde_json::Map<String, Value>,
        method: &Value,
        workspace: &HostWorkspace,
        deadline: Instant,
        read_blobs: &mut BTreeSet<String>,
    ) -> Result<()> {
        let callback = parse_callback(object, method)?;
        let result = workspace.callback(callback.method, &callback.params);
        let message = callback_response(&callback.id, &result);
        if serialized_len(&message)? > MAX_FRAME_BYTES {
            return self.send(&oversized_callback_error(&callback.id), deadline);
        }
        self.send(&message, deadline)?;
        record_blob_read(&callback, &result, read_blobs)
    }

    fn receive(&self, deadline: Instant) -> Result<Value> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("ASP provider exceeded its wallclock grant")?;
        match self.frames.recv_timeout(remaining) {
            Ok(ReaderEvent::Frame(frame)) => {
                parse_unique_json(&frame).context("parse ASP provider frame")
            }
            Ok(ReaderEvent::Invalid(error)) => bail!("invalid ASP provider frame: {error}"),
            Ok(ReaderEvent::Eof) => bail!("ASP provider closed stdout before completing lifecycle"),
            Err(RecvTimeoutError::Timeout) => bail!("ASP provider exceeded its wallclock grant"),
            Err(RecvTimeoutError::Disconnected) => bail!("ASP provider stdout reader stopped"),
        }
    }

    fn shutdown(&mut self, workspace: &HostWorkspace, deadline: Instant) -> Result<()> {
        let mut read_blobs = BTreeSet::new();
        self.send(
            &json!({
                "jsonrpc": "2.0", "id": "host:shutdown", "method": "shutdown", "params": {}
            }),
            deadline,
        )?;
        let result =
            self.wait_response("host:shutdown", workspace, deadline, false, &mut read_blobs)?;
        if !result.is_null() {
            bail!("ASP provider shutdown result must be null");
        }
        self.send(
            &json!({ "jsonrpc": "2.0", "method": "exit", "params": {} }),
            deadline,
        )?;
        drop(self.stdin.take());
        self.await_exit(deadline)
    }

    fn await_exit(&mut self, deadline: Instant) -> Result<()> {
        loop {
            if child_exited(&self.child)? {
                self.kill_process_group();
                let status = self.child.wait().context("reap ASP provider")?;
                if status.success() {
                    return Ok(());
                }
                bail!("ASP provider exited unsuccessfully{}", self.stderr_suffix());
            }
            if Instant::now() >= deadline {
                self.terminate();
                bail!("ASP provider did not exit before its wallclock deadline");
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn stderr_suffix(&self) -> String {
        self.stderr.try_recv().map_or_else(
            |_| String::new(),
            |bytes| {
                let text = String::from_utf8_lossy(&bytes);
                format!(": {text}")
            },
        )
    }

    fn terminate(&mut self) {
        drop(self.stdin.take());
        if let Some(process_group) = self.process_group.take() {
            terminate_process_group(&mut self.child, process_group);
        }
    }

    fn kill_process_group(&mut self) {
        if let Some(process_group) = self.process_group.take() {
            let _ = signal_process_group(process_group, Signal::KILL);
        }
    }

    const fn profile(&self) -> Option<ProviderProfile> {
        self.profile
    }
}

fn private_provider_directory(forbidden: Option<&Path>) -> Result<tempfile::TempDir> {
    let mut failures = Vec::new();
    for base in PRIVATE_TEMP_BASES {
        let base = match Path::new(base).canonicalize() {
            Ok(base) => base,
            Err(error) => {
                failures.push(error.to_string());
                continue;
            }
        };
        if forbidden.is_some_and(|root| base == root || base.starts_with(root)) {
            continue;
        }
        match tempfile::Builder::new()
            .prefix("opcore-provider-")
            .tempdir_in(&base)
        {
            Ok(directory) if forbidden.is_none_or(|root| !directory.path().starts_with(root)) => {
                return Ok(directory);
            }
            Ok(_) => failures.push("temporary directory resolved inside candidate root".into()),
            Err(error) => failures.push(error.to_string()),
        }
    }
    bail!(
        "allocate ASP provider working directory outside candidate root: {}",
        failures.join("; ")
    )
}

struct Callback<'a> {
    id: Value,
    method: &'a str,
    params: Value,
}

fn response_object<'a>(
    value: &'a Value,
    expected_id: &str,
) -> Result<&'a serde_json::Map<String, Value>> {
    let object = value
        .as_object()
        .context("ASP provider frame must be an object")?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        bail!("ASP provider frame has an invalid jsonrpc version");
    }
    if !object.contains_key("method")
        && object.get("id").and_then(Value::as_str) != Some(expected_id)
    {
        bail!("ASP provider returned an unexpected response id");
    }
    Ok(object)
}

fn parse_callback<'a>(
    object: &serde_json::Map<String, Value>,
    method: &'a Value,
) -> Result<Callback<'a>> {
    if let Some(field) = object
        .keys()
        .find(|field| !["jsonrpc", "id", "method", "params"].contains(&field.as_str()))
    {
        bail!("ASP provider callback contains unsupported field {field}");
    }
    let id = object
        .get("id")
        .cloned()
        .context("ASP provider callback omitted id")?;
    if !valid_request_id(&id) {
        bail!("ASP provider callback id must be a string or integer");
    }
    let method = method
        .as_str()
        .context("ASP provider callback method must be a string")?;
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    Ok(Callback { id, method, params })
}

fn callback_response(id: &Value, result: &Result<Value>) -> Value {
    match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(error) => callback_error(id, &error.to_string()),
    }
}

fn oversized_callback_error(id: &Value) -> Value {
    callback_error(
        id,
        "workspace callback result exceeded the host frame bound",
    )
}

fn record_blob_read(
    callback: &Callback<'_>,
    result: &Result<Value>,
    read_blobs: &mut BTreeSet<String>,
) -> Result<()> {
    if result.is_err() || callback.method != "workspace/readBlob" {
        return Ok(());
    }
    let blob = callback
        .params
        .pointer("/blobs/0")
        .and_then(Value::as_str)
        .context("validated workspace/readBlob omitted its blob")?;
    read_blobs.insert(blob.to_owned());
    Ok(())
}

fn child_exited(child: &Child) -> Result<bool> {
    let options = WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT;
    waitid(WaitId::Pid(Pid::from_child(child)), options)
        .map(|status| status.is_some())
        .context("observe ASP provider exit")
}

fn terminate_process_group(child: &mut Child, process_group: Pid) {
    if signal_process_group(process_group, Signal::KILL).is_err()
        && child.try_wait().ok().flatten().is_none()
    {
        drop(child.kill());
    }
    drop(child.wait());
}

type ChildChannels = (
    mpsc::Sender<WriteRequest>,
    Receiver<ReaderEvent>,
    Receiver<Vec<u8>>,
);

fn configure_child(child: &mut Child) -> Result<ChildChannels> {
    let stdin = child.stdin.take().context("open ASP provider stdin")?;
    let stdout = child.stdout.take().context("open ASP provider stdout")?;
    let stderr = child.stderr.take().context("open ASP provider stderr")?;
    let (write_sender, write_receiver) = mpsc::channel();
    thread::Builder::new()
        .name("opcore-asp-stdin".into())
        .spawn(move || write_frames(stdin, &write_receiver))
        .context("start ASP provider stdin writer")?;
    let (frame_sender, frames) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("opcore-asp-stdout".into())
        .spawn(move || read_frames(BufReader::new(stdout), &frame_sender))
        .context("start ASP provider stdout reader")?;
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("opcore-asp-stderr".into())
        .spawn(move || drain_stderr(stderr, &stderr_sender))
        .context("start ASP provider stderr reader")?;
    Ok((write_sender, frames, stderr_receiver))
}

struct WriteRequest {
    bytes: Vec<u8>,
    completion: SyncSender<std::result::Result<(), String>>,
}

fn write_frames(mut stdin: ChildStdin, receiver: &Receiver<WriteRequest>) {
    while let Ok(request) = receiver.recv() {
        let result = stdin
            .write_all(&request.bytes)
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(|error| error.to_string());
        let failed = result.is_err();
        drop(request.completion.send(result));
        if failed {
            return;
        }
    }
}

impl Drop for ProviderProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn rpc_result(object: &serde_json::Map<String, Value>) -> Result<Value> {
    match (object.get("result"), object.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => bail!("ASP provider returned an RPC error: {error}"),
        _ => bail!("ASP provider response must contain exactly one of result or error"),
    }
}

fn callback_error(id: &Value, detail: &str) -> Value {
    json!({
        "jsonrpc": "2.0", "id": id,
        "error": {
            "code": -32012, "message": "policy-denied",
            "data": { "failClass": "policy", "retryable": false, "detail": detail }
        }
    })
}

fn serialized_len(value: &Value) -> Result<usize> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .context("serialize ASP callback response")
}

fn valid_request_id(id: &Value) -> bool {
    id.is_string() || id.as_i64().is_some() || id.as_u64().is_some()
}

fn read_frames(mut reader: impl BufRead, sender: &SyncSender<ReaderEvent>) {
    loop {
        match read_frame(&mut reader) {
            Ok(Some(frame)) => {
                if sender.send(ReaderEvent::Frame(frame)).is_err() {
                    return;
                }
            }
            Ok(None) => {
                drop(sender.send(ReaderEvent::Eof));
                return;
            }
            Err(error) => {
                drop(sender.send(ReaderEvent::Invalid(error)));
                return;
            }
        }
    }
}

fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|error| error.to_string())?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("stdout ended before the frame newline".into())
            };
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if frame.len().saturating_add(take) > MAX_FRAME_BYTES {
            return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
        }
        let complete = available[..take].ends_with(b"\n");
        frame.extend_from_slice(&available[..take]);
        reader.consume(take);
        if complete {
            frame.pop();
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            if frame.is_empty() {
                return Err("empty JSON-RPC frame".into());
            }
            return Ok(Some(frame));
        }
    }
}

fn drain_stderr(mut stderr: impl Read, sender: &SyncSender<Vec<u8>>) {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = MAX_STDERR_BYTES.saturating_sub(retained.len());
                retained.extend_from_slice(&buffer[..read.min(remaining)]);
            }
        }
    }
    drop(sender.send(retained));
}

#[cfg(test)]
mod tests;
