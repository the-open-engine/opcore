use super::WatchCliOptions;
use crate::pipeline::{display_path, now_rfc3339};
use crate::protocol::{GraphWatchLifecycle, GraphWatchLifecycleState, RepoIdentity};
use fs2::FileExt;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
struct WatchPaths {
    daemon_dir: PathBuf,
    lock_path: PathBuf,
    pid_path: PathBuf,
    state_path: PathBuf,
    log_path: PathBuf,
}

impl WatchPaths {
    fn new(repo_root: &Path) -> Self {
        let daemon_dir = repo_root.join(".opcore").join("graph").join("daemon");
        Self {
            lock_path: daemon_dir.join("watch.lock"),
            pid_path: daemon_dir.join("pid"),
            state_path: daemon_dir.join("state.json"),
            log_path: daemon_dir.join("daemon.log"),
            daemon_dir,
        }
    }
}

struct WatchLock {
    file: fs::File,
}

impl WatchLock {
    fn acquire(paths: &WatchPaths) -> Result<Self, String> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&paths.lock_path)
            .map_err(|error| {
                format!(
                    "failed to open daemon lock {}: {error}",
                    display_path(&paths.lock_path)
                )
            })?;
        match file.try_lock_exclusive() {
            Ok(()) => {
                refuse_existing_live_watch(paths)?;
                Ok(Self { file })
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                Err(daemon_lock_held_message(paths))
            }
            Err(error) => Err(format!(
                "failed to acquire daemon lock {}: {error}",
                display_path(&paths.lock_path)
            )),
        }
    }
}

impl Drop for WatchLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn daemon_lock_held_message(paths: &WatchPaths) -> String {
    if let Some(pid) = existing_live_watch_pid(paths) {
        return format!(
            "graph watch daemon already running with pid {pid}; pid file {} was not replaced",
            display_path(&paths.pid_path)
        );
    }
    format!(
        "graph watch daemon lock {} is already held; pid file {} was not replaced",
        display_path(&paths.lock_path),
        display_path(&paths.pid_path)
    )
}

fn refuse_existing_live_watch(paths: &WatchPaths) -> Result<(), String> {
    if let Some(pid) = existing_live_watch_pid(paths) {
        return Err(format!(
            "graph watch daemon already running with pid {pid}; pid file {} was not replaced",
            display_path(&paths.pid_path)
        ));
    }
    Ok(())
}

fn existing_live_watch_pid(paths: &WatchPaths) -> Option<u32> {
    let pid = crate::daemon::read_daemon_pid(&paths.pid_path).ok()?;
    if !crate::daemon::process_is_alive(pid) {
        return None;
    }
    if lifecycle_state_is_stopped(&paths.state_path) {
        return None;
    }
    Some(pid)
}

fn lifecycle_state_is_stopped(state_path: &Path) -> bool {
    fs::read_to_string(state_path)
        .ok()
        .and_then(|content| serde_json::from_str::<GraphWatchLifecycle>(&content).ok())
        .is_some_and(|lifecycle| lifecycle.state == GraphWatchLifecycleState::Stopped)
}

pub(super) struct WatchSession {
    paths: WatchPaths,
    _lock: Option<WatchLock>,
    started_at: String,
    pub(super) repo: RepoIdentity,
    poll_interval_ms: u64,
    idle_timeout_ms: u64,
    watch_paths: Vec<String>,
}

impl WatchSession {
    pub(super) fn start(repo_root: &Path, options: &WatchCliOptions) -> Result<Self, String> {
        let paths = WatchPaths::new(repo_root);
        fs::create_dir_all(&paths.daemon_dir)
            .map_err(|error| format!("failed to create daemon dir: {error}"))?;
        let lock = if options.once {
            None
        } else {
            Some(WatchLock::acquire(&paths)?)
        };
        fs::write(&paths.pid_path, std::process::id().to_string())
            .map_err(|error| format!("failed to write pid file: {error}"))?;
        Ok(Self {
            paths,
            _lock: lock,
            started_at: now_rfc3339(),
            repo: repo_identity(repo_root),
            poll_interval_ms: options.poll_interval_ms,
            idle_timeout_ms: options.idle_timeout_ms,
            watch_paths: options.watch_paths.clone(),
        })
    }

    fn lifecycle(
        &self,
        state: GraphWatchLifecycleState,
        message: Option<String>,
    ) -> GraphWatchLifecycle {
        GraphWatchLifecycle {
            state,
            pid: Some(std::process::id()),
            started_at: self.started_at.clone(),
            updated_at: now_rfc3339(),
            pid_path: display_path(&self.paths.pid_path),
            state_path: display_path(&self.paths.state_path),
            log_path: display_path(&self.paths.log_path),
            poll_interval_ms: self.poll_interval_ms,
            idle_timeout_ms: self.idle_timeout_ms,
            watch_paths: self.watch_paths.clone(),
            message,
        }
    }

    fn write_lifecycle(&self, lifecycle: &GraphWatchLifecycle) -> Result<(), String> {
        fs::write(
            &self.paths.state_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(lifecycle)
                    .map_err(|error| format!("failed to encode lifecycle: {error}"))?
            ),
        )
        .map_err(|error| format!("failed to write lifecycle: {error}"))
    }

    pub(super) fn log(&self, message: &str) -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.paths.log_path)
            .map_err(|error| format!("failed to open daemon log: {error}"))?;
        writeln!(file, "{} {message}", now_rfc3339())
            .map_err(|error| format!("failed to write daemon log: {error}"))
    }
}

pub(super) fn write_lifecycle_state(
    session: &WatchSession,
    state: GraphWatchLifecycleState,
    message: Option<String>,
) -> Result<GraphWatchLifecycle, String> {
    let lifecycle = session.lifecycle(state, message);
    session.write_lifecycle(&lifecycle)?;
    Ok(lifecycle)
}

fn repo_identity(repo_root: &Path) -> RepoIdentity {
    RepoIdentity {
        repo_id: None,
        repo_root: Some(display_path(repo_root)),
        remote_url: None,
        commit_sha: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::{WatchCliOptions, DEFAULT_WATCH_IDLE_TIMEOUT_MS};
    use fs2::FileExt;
    use std::io;
    use std::process::{Child, Command, Stdio};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn start_refuses_live_active_watch_without_replacing_pid_file() -> TestResult {
        let repo = tempfile::tempdir()?;
        let paths = WatchPaths::new(repo.path());
        fs::create_dir_all(&paths.daemon_dir)?;
        let child = LiveChild::spawn()?;
        let child_pid = child.id();
        fs::write(&paths.pid_path, child_pid.to_string())?;
        write_test_lifecycle(&paths, GraphWatchLifecycleState::Available, child_pid)?;

        let result = WatchSession::start(repo.path(), &watch_options(repo.path(), false));

        let message = result
            .err()
            .ok_or_else(|| io::Error::other("watch session unexpectedly started"))?;
        assert!(message.contains(&format!("pid {child_pid}")), "{message}");
        assert_eq!(
            fs::read_to_string(&paths.pid_path)?.trim(),
            child_pid.to_string()
        );
        Ok(())
    }

    #[test]
    fn start_reclaims_dead_active_pid_for_new_session() -> TestResult {
        let repo = tempfile::tempdir()?;
        let paths = WatchPaths::new(repo.path());
        fs::create_dir_all(&paths.daemon_dir)?;
        let stale_pid = inactive_pid_candidate()?;
        fs::write(&paths.pid_path, stale_pid.to_string())?;
        write_test_lifecycle(&paths, GraphWatchLifecycleState::Available, stale_pid)?;

        let session = WatchSession::start(repo.path(), &watch_options(repo.path(), false))
            .map_err(io::Error::other)?;

        assert_eq!(
            fs::read_to_string(&paths.pid_path)?.trim(),
            std::process::id().to_string()
        );
        drop(session);
        Ok(())
    }

    #[test]
    fn start_holds_lock_until_session_drops() -> TestResult {
        let repo = tempfile::tempdir()?;
        let paths = WatchPaths::new(repo.path());
        let session = WatchSession::start(repo.path(), &watch_options(repo.path(), false))
            .map_err(io::Error::other)?;
        let competing_lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&paths.lock_path)?;

        assert!(competing_lock.try_lock_exclusive().is_err());
        drop(session);
        competing_lock.try_lock_exclusive()?;
        competing_lock.unlock()?;
        Ok(())
    }

    fn watch_options(repo_root: &Path, once: bool) -> WatchCliOptions {
        WatchCliOptions {
            repo_root: repo_root.to_path_buf(),
            base_ref: None,
            watch_paths: Vec::new(),
            poll_interval_ms: 1000,
            idle_timeout_ms: DEFAULT_WATCH_IDLE_TIMEOUT_MS,
            once,
            max_wal_bytes: crate::store::DEFAULT_WAL_BUDGET_BYTES,
        }
    }

    fn write_test_lifecycle(
        paths: &WatchPaths,
        state: GraphWatchLifecycleState,
        pid: u32,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let lifecycle = GraphWatchLifecycle {
            state,
            pid: Some(pid),
            started_at: "2026-06-28T00:00:00.000Z".to_string(),
            updated_at: "2026-06-28T00:00:00.000Z".to_string(),
            pid_path: display_path(&paths.pid_path),
            state_path: display_path(&paths.state_path),
            log_path: display_path(&paths.log_path),
            poll_interval_ms: 1000,
            idle_timeout_ms: DEFAULT_WATCH_IDLE_TIMEOUT_MS,
            watch_paths: Vec::new(),
            message: Some("graph watch daemon available".to_string()),
        };
        fs::write(&paths.state_path, serde_json::to_string_pretty(&lifecycle)?)?;
        Ok(())
    }

    fn inactive_pid_candidate() -> Result<u32, io::Error> {
        let start = std::process::id().saturating_add(1);
        for candidate in start..u32::MAX {
            if !crate::daemon::process_is_alive(candidate) {
                return Ok(candidate);
            }
        }
        Err(io::Error::other("could not find an inactive pid candidate"))
    }

    struct LiveChild {
        child: Child,
    }

    impl LiveChild {
        fn spawn() -> Result<Self, io::Error> {
            Ok(Self {
                child: sleep_command().spawn()?,
            })
        }

        fn id(&self) -> u32 {
            self.child.id()
        }
    }

    impl Drop for LiveChild {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[cfg(unix)]
    fn sleep_command() -> Command {
        let mut command = Command::new("sleep");
        command
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[cfg(windows)]
    fn sleep_command() -> Command {
        let mut command = Command::new("cmd");
        command
            .arg("/C")
            .arg("ping -n 60 127.0.0.1 >NUL")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }
}
