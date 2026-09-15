use std::{
    cmp,
    ffi::OsString,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

use super::{NativeCheckRequest, NativeStatus};

const PIPE_DRAIN_GRACE: Duration = Duration::from_millis(250);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub(super) enum Applicability {
    Applicable { working_root: PathBuf, locked: bool },
    NotApplicable,
}

pub(super) struct PreflightFailure {
    pub(super) status: NativeStatus,
    pub(super) detail: &'static str,
}

pub(super) struct RunFailure {
    pub(super) status: NativeStatus,
    pub(super) detail: &'static str,
    pub(super) exit_code: Option<i32>,
    pub(super) captured_output_bytes: usize,
}

pub(super) struct Execution {
    pub(super) workspace_root: PathBuf,
    pub(super) exit_status: ExitStatus,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
    target_dir: tempfile::TempDir,
}

pub(super) struct ToolExecution {
    pub(super) exit_status: ExitStatus,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
}

struct CapturedChild {
    exit_status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl ToolExecution {
    pub(super) fn captured_output_bytes(&self) -> usize {
        self.stdout.len().saturating_add(self.stderr.len())
    }
}

impl Execution {
    pub(super) fn target(&self) -> &Path {
        self.target_dir.path()
    }

    pub(super) fn captured_output_bytes(&self) -> usize {
        self.stdout.len().saturating_add(self.stderr.len())
    }
}

pub(super) fn preflight(
    request: &NativeCheckRequest<'_>,
    deadline: Instant,
) -> Result<Applicability, PreflightFailure> {
    let callback_root = inspect_root(request.workspace_root)?;
    let working_root = request.project_root.map_or_else(
        || Ok(callback_root.clone()),
        |path| inspect_root(&callback_root.join(path.to_path_buf())),
    )?;
    let manifest = working_root.join("Cargo.toml");
    if !required_file(&manifest, "the root Cargo.toml must be a regular file")? {
        return Ok(Applicability::NotApplicable);
    }
    inspect_cargo(request.tool_program)?;
    request
        .identity
        .verify_tool(request.tool_program, request.cancel, deadline)
        .map_err(|_| identity_failure(request))?;
    let lock = callback_root.join("Cargo.lock");
    let locked = required_file(
        &lock,
        "the root Cargo.lock must be a regular file when present",
    )?;
    Ok(Applicability::Applicable {
        working_root,
        locked,
    })
}

fn inspect_root(workspace_root: &Path) -> Result<PathBuf, PreflightFailure> {
    if !workspace_root.is_absolute() {
        return Err(incomplete(
            "the materialized workspace path must be absolute",
        ));
    }
    let metadata = fs::symlink_metadata(workspace_root)
        .map_err(|_| incomplete("the materialized workspace could not be inspected"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(incomplete(
            "the materialized workspace must be a real directory",
        ));
    }
    workspace_root
        .canonicalize()
        .map_err(|_| incomplete("the materialized workspace could not be canonicalized"))
}

fn inspect_cargo(cargo_program: &Path) -> Result<(), PreflightFailure> {
    if !cargo_program.is_absolute() {
        return Err(unavailable(
            "the configured Cargo executable path must be absolute",
        ));
    }
    let metadata = fs::metadata(cargo_program)
        .map_err(|_| unavailable("the configured Cargo executable is unavailable"))?;
    if !metadata.is_file() {
        return Err(unavailable("the configured Cargo executable is not a file"));
    }
    Ok(())
}

fn required_file(path: &Path, invalid_detail: &'static str) -> Result<bool, PreflightFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(incomplete(invalid_detail))
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(incomplete("a required Cargo input could not be inspected")),
    }
}

pub(super) fn cargo_argv(locked: bool, scoped_project: bool) -> Vec<String> {
    let mut argv = vec![
        "check".to_owned(),
        "--all-targets".to_owned(),
        "--message-format=json".to_owned(),
    ];
    if !scoped_project {
        argv.insert(1, "--workspace".to_owned());
    }
    if locked {
        argv.push("--locked".to_owned());
    }
    argv
}

pub(super) fn run(
    request: &NativeCheckRequest<'_>,
    workspace_root: &Path,
    argv: &[String],
    deadline: Instant,
) -> Result<Execution, RunFailure> {
    if request.cancel.is_cancelled() {
        return Err(cancelled_run());
    }
    if Instant::now() >= deadline {
        return Err(incomplete_run(
            "Cargo check exceeded the configured wall-time limit",
        ));
    }
    let target_dir = tempfile::Builder::new()
        .prefix("opcore-native-target-")
        .tempdir_in(workspace_root.parent().ok_or_else(|| {
            incomplete_run("native workspace has no provider-private scratch parent")
        })?)
        .map_err(|_| incomplete_run("could not allocate the ephemeral Cargo target directory"))?;
    let child = spawn_cargo(request, workspace_root, argv, target_dir.path())?;
    let captured = capture_child(child, request, deadline)?;
    Ok(Execution {
        workspace_root: request.workspace_root.to_owned(),
        exit_status: captured.exit_status,
        stdout: captured.stdout,
        stderr: captured.stderr,
        target_dir,
    })
}

pub(super) fn run_tool(
    request: &NativeCheckRequest<'_>,
    workspace_root: &Path,
    argv: &[String],
    environment: &[(OsString, OsString)],
    deadline: Instant,
) -> Result<ToolExecution, RunFailure> {
    if request.cancel.is_cancelled() {
        return Err(cancelled_run());
    }
    if Instant::now() >= deadline {
        return Err(incomplete_run(
            "native tool exceeded the configured wall-time limit",
        ));
    }
    let mut command = base_command(request, workspace_root, argv);
    command
        .env_clear()
        .envs(request.identity.environment.iter().cloned())
        .envs(environment.iter().cloned());
    let child = command.spawn().map_err(|error| {
        spawn_failure(&error, "the configured native tool could not be started")
    })?;
    let captured = capture_child(child, request, deadline)?;
    Ok(ToolExecution {
        exit_status: captured.exit_status,
        stdout: captured.stdout,
        stderr: captured.stderr,
    })
}

fn capture_child(
    mut child: Child,
    request: &NativeCheckRequest<'_>,
    deadline: Instant,
) -> Result<CapturedChild, RunFailure> {
    let capture = CaptureSession::start(&mut child, request.limits.max_output_bytes)
        .map_err(|detail| stop_with(&mut child, detail, 0))?;
    let exit_status = wait_for_exit(&mut child, &capture.budget, deadline, request.cancel)
        .map_err(|failure| stop_with_status(&mut child, failure, capture.budget.captured()))?;
    let drain_deadline = cmp::min(deadline, Instant::now() + PIPE_DRAIN_GRACE);
    let output_budget = Arc::clone(&capture.budget);
    let (stdout, stderr) = capture
        .collect(drain_deadline)
        .map_err(|detail| RunFailure {
            status: NativeStatus::Incomplete,
            detail,
            exit_code: exit_status.code(),
            captured_output_bytes: output_budget.captured(),
        })?;
    Ok(CapturedChild {
        exit_status,
        stdout,
        stderr,
    })
}

fn spawn_cargo(
    request: &NativeCheckRequest<'_>,
    workspace_root: &Path,
    argv: &[String],
    target_dir: &Path,
) -> Result<Child, RunFailure> {
    let mut command = base_command(request, workspace_root, argv);
    configure_environment(&mut command, target_dir, request);
    command.spawn().map_err(|error| {
        spawn_failure(
            &error,
            "the configured Cargo executable could not be started",
        )
    })
}

fn base_command(
    request: &NativeCheckRequest<'_>,
    workspace_root: &Path,
    argv: &[String],
) -> Command {
    let mut command = Command::new(request.tool_program);
    command
        .args(argv)
        .current_dir(workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn spawn_failure(error: &io::Error, detail: &'static str) -> RunFailure {
    RunFailure {
        status: if matches!(
            error.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
        ) {
            NativeStatus::Unavailable
        } else {
            NativeStatus::Incomplete
        },
        detail,
        exit_code: None,
        captured_output_bytes: 0,
    }
}

fn configure_environment(
    command: &mut Command,
    target_dir: &Path,
    request: &NativeCheckRequest<'_>,
) {
    command.env_clear();
    for (key, value) in &request.identity.environment {
        command.env(key, value);
    }
    command
        .env("CARGO_NET_OFFLINE", "true")
        .env("CARGO_TERM_COLOR", "never")
        .env("CARGO_INCREMENTAL", "0")
        .env("CARGO_TARGET_DIR", target_dir)
        .env("TMPDIR", target_dir)
        .env("TMP", target_dir)
        .env("TEMP", target_dir)
        .env("LC_ALL", "C")
        .env("RUST_BACKTRACE", "0");
}

#[derive(Clone, Copy)]
struct WaitFailure {
    status: NativeStatus,
    detail: &'static str,
}

fn wait_for_exit(
    child: &mut Child,
    budget: &OutputBudget,
    deadline: Instant,
    cancel: &crate::cancel::CancelToken,
) -> Result<ExitStatus, WaitFailure> {
    loop {
        if cancel.is_cancelled() {
            return Err(WaitFailure {
                status: NativeStatus::Cancelled,
                detail: "native evaluation was cancelled",
            });
        }
        if budget.exceeded() {
            return Err(incomplete_wait(
                "native tool output exceeded the configured byte limit",
            ));
        }
        if Instant::now() >= deadline {
            return Err(incomplete_wait(
                "native tool exceeded the configured wall-time limit",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
            Err(_) => {
                return Err(incomplete_wait(
                    "native tool process state could not be observed",
                ));
            }
        }
    }
}

fn stop_with(child: &mut Child, detail: &'static str, captured: usize) -> RunFailure {
    stop_with_status(child, incomplete_wait(detail), captured)
}

fn stop_with_status(child: &mut Child, failure: WaitFailure, captured: usize) -> RunFailure {
    let _ = child.kill();
    let exit_code = child.wait().ok().and_then(|status| status.code());
    RunFailure {
        status: failure.status,
        detail: failure.detail,
        exit_code,
        captured_output_bytes: captured,
    }
}

fn incomplete(detail: &'static str) -> PreflightFailure {
    PreflightFailure {
        status: NativeStatus::Incomplete,
        detail,
    }
}

fn unavailable(detail: &'static str) -> PreflightFailure {
    PreflightFailure {
        status: NativeStatus::Unavailable,
        detail,
    }
}

fn identity_failure(request: &NativeCheckRequest<'_>) -> PreflightFailure {
    if request.cancel.is_cancelled() {
        PreflightFailure {
            status: NativeStatus::Cancelled,
            detail: "Rust-native evaluation was cancelled",
        }
    } else {
        incomplete("the configured Cargo executable identity changed or could not be verified")
    }
}

fn incomplete_run(detail: &'static str) -> RunFailure {
    RunFailure {
        status: NativeStatus::Incomplete,
        detail,
        exit_code: None,
        captured_output_bytes: 0,
    }
}

fn cancelled_run() -> RunFailure {
    RunFailure {
        status: NativeStatus::Cancelled,
        detail: "native evaluation was cancelled",
        exit_code: None,
        captured_output_bytes: 0,
    }
}

fn incomplete_wait(detail: &'static str) -> WaitFailure {
    WaitFailure {
        status: NativeStatus::Incomplete,
        detail,
    }
}

#[derive(Clone, Copy)]
enum StreamKind {
    Stdout,
    Stderr,
}

type Capture = (StreamKind, io::Result<Vec<u8>>);

struct CaptureSession {
    receiver: Receiver<Capture>,
    budget: Arc<OutputBudget>,
}

impl CaptureSession {
    fn start(child: &mut Child, output_limit: usize) -> Result<Self, &'static str> {
        let stdout = child
            .stdout
            .take()
            .ok_or("native tool stdout was unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("native tool stderr was unavailable")?;
        let budget = Arc::new(OutputBudget::new(output_limit));
        let (sender, receiver) = mpsc::channel();
        spawn_reader(
            "opcore-native-stdout",
            StreamKind::Stdout,
            stdout,
            Arc::clone(&budget),
            sender.clone(),
        )?;
        spawn_reader(
            "opcore-native-stderr",
            StreamKind::Stderr,
            stderr,
            Arc::clone(&budget),
            sender,
        )?;
        Ok(Self { receiver, budget })
    }

    fn collect(self, deadline: Instant) -> Result<(Vec<u8>, Vec<u8>), &'static str> {
        let mut stdout = None;
        let mut stderr = None;
        while stdout.is_none() || stderr.is_none() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("native tool output streams did not close cleanly");
            }
            match self.receiver.recv_timeout(remaining) {
                Ok((StreamKind::Stdout, Ok(bytes))) => stdout = Some(bytes),
                Ok((StreamKind::Stderr, Ok(bytes))) => stderr = Some(bytes),
                Ok((_, Err(_)))
                | Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                    return Err("native tool output streams did not close cleanly");
                }
            }
        }
        if self.budget.exceeded() {
            return Err("native tool output exceeded the configured byte limit");
        }
        stdout
            .zip(stderr)
            .ok_or("native tool output streams were incomplete")
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    name: &'static str,
    kind: StreamKind,
    reader: R,
    budget: Arc<OutputBudget>,
    sender: mpsc::Sender<Capture>,
) -> Result<(), &'static str> {
    thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let result = capture(reader, &budget);
            let _ = sender.send((kind, result));
        })
        .map(|_| ())
        .map_err(|_| "could not start bounded native tool output readers")
}

fn capture(mut reader: impl Read, budget: &OutputBudget) -> io::Result<Vec<u8>> {
    let mut captured = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            return Ok(captured);
        }
        let retained = budget.claim(read);
        captured.extend_from_slice(&chunk[..retained]);
    }
}

struct OutputBudget {
    remaining: AtomicUsize,
    captured: AtomicUsize,
    exceeded: AtomicBool,
}

impl OutputBudget {
    fn new(limit: usize) -> Self {
        Self {
            remaining: AtomicUsize::new(limit),
            captured: AtomicUsize::new(0),
            exceeded: AtomicBool::new(false),
        }
    }

    fn claim(&self, requested: usize) -> usize {
        let mut remaining = self.remaining.load(Ordering::Relaxed);
        loop {
            let retained = cmp::min(remaining, requested);
            match self.remaining.compare_exchange_weak(
                remaining,
                remaining - retained,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => {
                    self.captured.fetch_add(retained, Ordering::Relaxed);
                    if retained < requested {
                        self.exceeded.store(true, Ordering::Release);
                    }
                    return retained;
                }
                Err(actual) => remaining = actual,
            }
        }
    }

    fn exceeded(&self) -> bool {
        self.exceeded.load(Ordering::Acquire)
    }

    fn captured(&self) -> usize {
        self.captured.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_argument_is_conditional_and_ordered() {
        assert_eq!(
            cargo_argv(false, false),
            [
                "check",
                "--workspace",
                "--all-targets",
                "--message-format=json"
            ]
        );
        assert_eq!(
            cargo_argv(true, false).last().map(String::as_str),
            Some("--locked")
        );
        assert!(!cargo_argv(false, true).contains(&"--workspace".to_owned()));
    }

    #[test]
    fn output_budget_is_shared_and_marks_overflow() {
        let budget = OutputBudget::new(5);
        assert_eq!(budget.claim(3), 3);
        assert_eq!(budget.claim(4), 2);
        assert_eq!(budget.captured(), 5);
        assert!(budget.exceeded());
    }
}
