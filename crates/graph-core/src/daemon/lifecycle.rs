use crate::pipeline::display_path;
use crate::protocol::{
    query_failed_status, GraphProviderMode, GraphProviderStatus, GraphWatchLifecycle,
    GraphWatchLifecycleState, ProviderFailure, ProviderFailureCategory, RepoIdentity,
};
use crate::{GRAPH_PROVIDER_NAME, GRAPH_SCHEMA_VERSION};
use std::path::Path;
use std::process::Command;

pub(super) fn lifecycle_status(repo_root: &str) -> Option<GraphProviderStatus> {
    let daemon_dir = std::path::Path::new(repo_root)
        .join(".lattice")
        .join("graph")
        .join("daemon");
    let state_path = daemon_dir.join("state.json");
    if !state_path.exists() {
        return None;
    }
    let lifecycle = match read_lifecycle(repo_root, &state_path) {
        Ok(lifecycle) => lifecycle,
        Err(status) => return Some(*status),
    };
    lifecycle_status_for_state(repo_root, &daemon_dir, lifecycle)
}

fn read_lifecycle(
    repo_root: &str,
    state_path: &Path,
) -> Result<GraphWatchLifecycle, Box<GraphProviderStatus>> {
    let content = match std::fs::read_to_string(state_path) {
        Ok(content) => content,
        Err(error) => {
            return Err(Box::new(daemon_unavailable_status(
                repo_root,
                format!(
                    "graph watch daemon state file {} is unreadable: {error}",
                    display_path(state_path)
                ),
            )))
        }
    };
    serde_json::from_str::<GraphWatchLifecycle>(&content).map_err(|error| {
        Box::new(daemon_unavailable_status(
            repo_root,
            format!(
                "graph watch daemon state file {} is invalid: {error}",
                display_path(state_path)
            ),
        ))
    })
}

fn lifecycle_status_for_state(
    repo_root: &str,
    daemon_dir: &Path,
    lifecycle: GraphWatchLifecycle,
) -> Option<GraphProviderStatus> {
    let repo = RepoIdentity {
        repo_id: None,
        repo_root: Some(repo_root.to_string()),
        remote_url: None,
        commit_sha: None,
    };
    match lifecycle.state {
        GraphWatchLifecycleState::Warming => {
            warming_lifecycle_status(repo_root, daemon_dir, repo, lifecycle)
        }
        GraphWatchLifecycleState::Error => error_lifecycle_status(repo_root, daemon_dir, lifecycle),
        GraphWatchLifecycleState::Available => {
            stale_active_lifecycle_status(repo_root, &lifecycle, daemon_dir)
        }
        GraphWatchLifecycleState::Stopped => None,
    }
}

fn warming_lifecycle_status(
    repo_root: &str,
    daemon_dir: &Path,
    repo: RepoIdentity,
    lifecycle: GraphWatchLifecycle,
) -> Option<GraphProviderStatus> {
    if let Some(status) = stale_active_lifecycle_status(repo_root, &lifecycle, daemon_dir) {
        return Some(status);
    }
    Some(crate::watch::warming_provider_status(repo, lifecycle))
}

fn error_lifecycle_status(
    repo_root: &str,
    daemon_dir: &Path,
    lifecycle: GraphWatchLifecycle,
) -> Option<GraphProviderStatus> {
    if let Some(status) = stale_active_lifecycle_status(repo_root, &lifecycle, daemon_dir) {
        return Some(status);
    }
    Some(query_failed_status(
        lifecycle
            .message
            .clone()
            .unwrap_or_else(|| "graph watch daemon error".to_string()),
        Vec::new(),
    ))
}

fn stale_active_lifecycle_status(
    repo_root: &str,
    lifecycle: &GraphWatchLifecycle,
    daemon_dir: &Path,
) -> Option<GraphProviderStatus> {
    let lifecycle_pid = match lifecycle.pid {
        Some(pid) if pid > 0 => pid,
        _ => {
            return Some(daemon_unavailable_status(
                repo_root,
                "graph watch daemon lifecycle is active but has no pid",
            ))
        }
    };
    let pid_path = daemon_dir.join("pid");
    let recorded_pid = match read_daemon_pid(&pid_path) {
        Ok(pid) => pid,
        Err(message) => return Some(daemon_unavailable_status(repo_root, message)),
    };
    if recorded_pid != lifecycle_pid {
        return Some(daemon_unavailable_status(
            repo_root,
            format!(
                "graph watch daemon lifecycle pid {lifecycle_pid} does not match pid file {recorded_pid}"
            ),
        ));
    }
    if !process_is_alive(lifecycle_pid) {
        return Some(daemon_unavailable_status(
            repo_root,
            format!("graph watch daemon pid {lifecycle_pid} is not running"),
        ));
    }
    None
}

fn read_daemon_pid(pid_path: &Path) -> Result<u32, String> {
    let content = std::fs::read_to_string(pid_path).map_err(|error| {
        format!(
            "graph watch daemon pid file {} is unreadable: {error}",
            display_path(pid_path)
        )
    })?;
    content.trim().parse::<u32>().map_err(|error| {
        format!(
            "graph watch daemon pid file {} is invalid: {error}",
            display_path(pid_path)
        )
    })
}

fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    process_is_alive_platform(pid)
}

#[cfg(unix)]
fn process_is_alive_platform(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn process_is_alive_platform(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    Command::new("tasklist")
        .arg("/FI")
        .arg(filter)
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive_platform(_pid: u32) -> bool {
    true
}

fn daemon_unavailable_status(_repo_root: &str, message: impl Into<String>) -> GraphProviderStatus {
    let message = message.into();
    GraphProviderStatus::DaemonUnavailable {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        message: Some(message.clone()),
        failure: ProviderFailure {
            category: ProviderFailureCategory::DaemonUnavailable,
            message,
            retryable: Some(true),
            cause: None,
        },
    }
}
