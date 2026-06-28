use crate::extraction::normalize_watch_paths;
use crate::pipeline::{display_path, update_snapshot, GraphPipelineOptions};
use crate::protocol::{
    available_status_with_wal_checkpoint, query_failed_status, warming_status,
    AvailableStatusInput, GraphDaemonResponse, GraphFreshness, GraphPipelineResult,
    GraphProviderStatus, GraphWatchLifecycle, GraphWatchLifecycleState, RepoIdentity,
};
use crate::GRAPH_SCHEMA_VERSION;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

mod args;
mod session;
use args::parse_watch_args;
use session::{write_lifecycle_state, WatchSession};

const GRAPH_DAEMON_PROTOCOL: &str = "opcore.graph.daemon";
pub const DEFAULT_WATCH_IDLE_TIMEOUT_MS: u64 = 1_800_000;
pub const WATCH_IDLE_TIMEOUT_ENV: &str = "LATTICE_GRAPH_WATCH_IDLE_TIMEOUT_MS";

type KindCounts = BTreeMap<String, u32>;

#[derive(Debug, Clone)]
pub struct WatchCliOptions {
    pub repo_root: PathBuf,
    pub base_ref: Option<String>,
    pub watch_paths: Vec<String>,
    pub poll_interval_ms: u64,
    pub idle_timeout_ms: u64,
    pub once: bool,
    pub max_wal_bytes: u64,
}

pub fn run_watch_cli(args: &[String]) -> Result<(), String> {
    let options = parse_watch_args(args)?;
    let response = run_watch(options)?;
    serde_json::to_writer(std::io::stdout(), &response)
        .map_err(|error| format!("failed to write watch response: {error}"))?;
    println!();
    Ok(())
}

pub fn run_watch(mut options: WatchCliOptions) -> Result<GraphDaemonResponse, String> {
    options.watch_paths = normalize_watch_paths(&options.watch_paths)?;
    let repo_root = canonicalize_watch_repo(&options.repo_root)?;
    let session = WatchSession::start(&repo_root, &options)?;
    write_lifecycle_state(
        &session,
        GraphWatchLifecycleState::Warming,
        Some("graph watch daemon warming".to_string()),
    )?;
    session.log("warming")?;

    let response = initial_watch_response(&options, &repo_root, &session)?;
    finish_watch(&options, &repo_root, &session, response)
}

fn initial_watch_response(
    options: &WatchCliOptions,
    repo_root: &Path,
    session: &WatchSession,
) -> Result<GraphDaemonResponse, String> {
    let mut pipeline = match run_watch_update(options, repo_root) {
        Ok(pipeline) => pipeline,
        Err(error) => return startup_error_response(session, options.once, error),
    };
    pipeline.summary.operation = "watch".to_string();
    watch_response_from_pipeline(session, repo_root, pipeline)
}

fn finish_watch(
    options: &WatchCliOptions,
    repo_root: &Path,
    session: &WatchSession,
    response: GraphDaemonResponse,
) -> Result<GraphDaemonResponse, String> {
    if options.once {
        stop_watch_session(session, "graph watch daemon stopped")?;
        return Ok(response);
    }
    let exit = run_watch_loop(options, repo_root, session)?;
    stop_watch_session(session, exit.message())?;
    Ok(response)
}

fn canonicalize_watch_repo(repo_root: &Path) -> Result<PathBuf, String> {
    repo_root
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize watch repo: {error}"))
}

fn startup_error_response(
    session: &WatchSession,
    once: bool,
    error: String,
) -> Result<GraphDaemonResponse, String> {
    let lifecycle = write_lifecycle_state(
        session,
        GraphWatchLifecycleState::Error,
        Some(error.clone()),
    )?;
    session.log(&format!("startup error: {error}"))?;
    if !once {
        return Err(error);
    }
    Ok(GraphDaemonResponse {
        protocol: GRAPH_DAEMON_PROTOCOL.to_string(),
        request_id: "graph-watch".to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        status: query_failed_status(error, Vec::new()),
        result: None,
        named_query: None,
        impact: None,
        review_context: None,
        changes: None,
        search: None,
        pipeline: None,
        lifecycle: Some(lifecycle),
    })
}

fn watch_response_from_pipeline(
    session: &WatchSession,
    repo_root: &Path,
    mut pipeline: GraphPipelineResult,
) -> Result<GraphDaemonResponse, String> {
    if !watch_pipeline_available(&pipeline.status) {
        return unavailable_watch_response_from_pipeline(session, pipeline);
    }

    let lifecycle = write_lifecycle_state(
        session,
        GraphWatchLifecycleState::Available,
        Some("graph watch daemon available".to_string()),
    )?;
    session.log("available")?;
    let (nodes_by_kind, edges_by_kind) = available_status_counts(&pipeline.status);
    pipeline.lifecycle = Some(lifecycle.clone());
    pipeline.status = available_status_with_wal_checkpoint(AvailableStatusInput {
        repo: session.repo.clone(),
        freshness: available_freshness(&lifecycle),
        db_path: Some(display_path(
            &repo_root.join(".lattice").join("graph").join("graph.db"),
        )),
        nodes_by_kind,
        edges_by_kind,
        message: Some("graph watch daemon available".to_string()),
        wal_checkpoint: pipeline.summary.wal_checkpoint.clone(),
    });
    Ok(watch_response_for_pipeline(pipeline, lifecycle))
}

fn unavailable_watch_response_from_pipeline(
    session: &WatchSession,
    mut pipeline: GraphPipelineResult,
) -> Result<GraphDaemonResponse, String> {
    let message = watch_pipeline_status_message(&pipeline.status);
    let stale = matches!(pipeline.status, GraphProviderStatus::Stale { .. });
    let state = if stale {
        GraphWatchLifecycleState::Available
    } else {
        GraphWatchLifecycleState::Error
    };
    let lifecycle = write_lifecycle_state(session, state, Some(message.clone()))?;
    log_unavailable_watch_pipeline(session, stale, &message)?;
    pipeline.lifecycle = Some(lifecycle.clone());
    Ok(watch_response_for_pipeline(pipeline, lifecycle))
}

fn log_unavailable_watch_pipeline(
    session: &WatchSession,
    stale: bool,
    message: &str,
) -> Result<(), String> {
    if stale {
        return session.log(&format!("stale: {message}"));
    }
    session.log(&format!("unavailable: {message}"))
}

fn available_status_counts(
    status: &GraphProviderStatus,
) -> (Option<KindCounts>, Option<KindCounts>) {
    match status {
        GraphProviderStatus::Available {
            nodes_by_kind,
            edges_by_kind,
            ..
        } => (Some(nodes_by_kind.clone()), Some(edges_by_kind.clone())),
        _ => (None, None),
    }
}

fn watch_pipeline_available(status: &GraphProviderStatus) -> bool {
    matches!(status, GraphProviderStatus::Available { .. })
}

fn watch_pipeline_status_message(status: &GraphProviderStatus) -> String {
    match status {
        GraphProviderStatus::Available { message, .. }
        | GraphProviderStatus::Warming { message, .. } => message
            .clone()
            .unwrap_or_else(|| "graph watch pipeline unavailable".to_string()),
        GraphProviderStatus::Skipped { failure, .. }
        | GraphProviderStatus::RequiredMissing { failure, .. }
        | GraphProviderStatus::Stale { failure, .. }
        | GraphProviderStatus::SchemaMismatch { failure, .. }
        | GraphProviderStatus::DaemonUnavailable { failure, .. }
        | GraphProviderStatus::Error { failure, .. } => failure.message.clone(),
    }
}

fn available_freshness(lifecycle: &GraphWatchLifecycle) -> GraphFreshness {
    GraphFreshness {
        generated_at: lifecycle.updated_at.clone(),
        age_ms: 0,
        max_age_ms: None,
        stale: false,
        reason: None,
    }
}

fn watch_response_for_pipeline(
    pipeline: GraphPipelineResult,
    lifecycle: GraphWatchLifecycle,
) -> GraphDaemonResponse {
    GraphDaemonResponse {
        protocol: GRAPH_DAEMON_PROTOCOL.to_string(),
        request_id: "graph-watch".to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        status: pipeline.status.clone(),
        result: None,
        named_query: None,
        impact: None,
        review_context: None,
        changes: None,
        search: None,
        pipeline: Some(pipeline),
        lifecycle: Some(lifecycle),
    }
}

fn run_watch_loop(
    options: &WatchCliOptions,
    repo_root: &Path,
    session: &WatchSession,
) -> Result<WatchLoopExit, String> {
    let running = Arc::new(AtomicBool::new(true));
    install_shutdown_handler(&running)?;
    let idle_started = Instant::now();
    let idle_timeout = watch_idle_timeout(options.idle_timeout_ms);
    while running.load(Ordering::SeqCst) {
        let sleep_duration = watch_loop_sleep_duration(
            Duration::from_millis(options.poll_interval_ms),
            idle_started,
            idle_timeout,
        );
        if sleep_duration.is_zero() {
            return Ok(WatchLoopExit::IdleTimeout);
        }
        thread::sleep(sleep_duration);
        if !running.load(Ordering::SeqCst) {
            return Ok(WatchLoopExit::Signal);
        }
        if watch_idle_timeout_elapsed(idle_started, idle_timeout) {
            return Ok(WatchLoopExit::IdleTimeout);
        }
        run_watch_loop_iteration(options, repo_root, session)?;
    }
    Ok(WatchLoopExit::Signal)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchLoopExit {
    Signal,
    IdleTimeout,
}

impl WatchLoopExit {
    fn message(self) -> &'static str {
        match self {
            Self::Signal => "graph watch daemon stopped",
            Self::IdleTimeout => "graph watch daemon stopped after idle timeout",
        }
    }
}

fn watch_idle_timeout(idle_timeout_ms: u64) -> Option<Duration> {
    if idle_timeout_ms == 0 {
        None
    } else {
        Some(Duration::from_millis(idle_timeout_ms))
    }
}

fn watch_loop_sleep_duration(
    poll_interval: Duration,
    idle_started: Instant,
    idle_timeout: Option<Duration>,
) -> Duration {
    if let Some(timeout) = idle_timeout {
        return timeout
            .checked_sub(idle_started.elapsed())
            .unwrap_or(Duration::ZERO)
            .min(poll_interval);
    }
    poll_interval
}

fn watch_idle_timeout_elapsed(idle_started: Instant, idle_timeout: Option<Duration>) -> bool {
    idle_timeout.is_some_and(|timeout| idle_started.elapsed() >= timeout)
}

fn install_shutdown_handler(running: &Arc<AtomicBool>) -> Result<(), String> {
    let running = Arc::clone(running);
    ctrlc::set_handler(move || {
        running.store(false, Ordering::SeqCst);
    })
    .map_err(|error| format!("failed to install signal handler: {error}"))
}

fn run_watch_loop_iteration(
    options: &WatchCliOptions,
    repo_root: &Path,
    session: &WatchSession,
) -> Result<(), String> {
    match run_watch_update(options, repo_root) {
        Ok(pipeline) => record_watch_pipeline_status(session, &pipeline.status),
        Err(error) => record_watch_error(session, error),
    }
}

fn record_watch_pipeline_status(
    session: &WatchSession,
    status: &GraphProviderStatus,
) -> Result<(), String> {
    if watch_pipeline_available(status) {
        return record_watch_available(session);
    }
    if matches!(status, GraphProviderStatus::Stale { .. }) {
        return record_watch_stale(session, watch_pipeline_status_message(status));
    }
    record_watch_error(session, watch_pipeline_status_message(status))
}

fn record_watch_available(session: &WatchSession) -> Result<(), String> {
    write_lifecycle_state(
        session,
        GraphWatchLifecycleState::Available,
        Some("graph watch daemon available".to_string()),
    )?;
    session.log("poll update complete")
}

fn record_watch_stale(session: &WatchSession, message: String) -> Result<(), String> {
    write_lifecycle_state(
        session,
        GraphWatchLifecycleState::Available,
        Some(message.clone()),
    )?;
    session.log(&format!("stale: {message}"))
}

fn record_watch_error(session: &WatchSession, error: String) -> Result<(), String> {
    write_lifecycle_state(
        session,
        GraphWatchLifecycleState::Error,
        Some(error.clone()),
    )?;
    session.log(&format!("error: {error}"))
}

fn stop_watch_session(session: &WatchSession, message: &str) -> Result<(), String> {
    write_lifecycle_state(
        session,
        GraphWatchLifecycleState::Stopped,
        Some(message.to_string()),
    )?;
    session.log(message)
}

fn run_watch_update(
    options: &WatchCliOptions,
    repo_root: &Path,
) -> Result<GraphPipelineResult, String> {
    let mut pipeline_options = GraphPipelineOptions::new(repo_root);
    pipeline_options.base_ref = options.base_ref.clone();
    pipeline_options.watch_paths = options.watch_paths.clone();
    pipeline_options.max_wal_bytes = options.max_wal_bytes;
    update_snapshot(pipeline_options).map_err(|error| error.to_string())
}

pub fn boundary_name() -> &'static str {
    "watch refresh boundary"
}

pub fn behavior_status() -> &'static str {
    "implemented: polling watch lifecycle, daemon artifacts, and bounded update refresh"
}

pub fn warming_provider_status(
    repo: RepoIdentity,
    lifecycle: GraphWatchLifecycle,
) -> GraphProviderStatus {
    warming_status(
        repo,
        GraphFreshness {
            generated_at: lifecycle.updated_at.clone(),
            age_ms: 0,
            max_age_ms: None,
            stale: true,
            reason: lifecycle.message.clone(),
        },
        Some(lifecycle),
        "graph watch daemon warming",
    )
}
