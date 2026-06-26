use crate::pipeline::{
    build_full_snapshot, display_path, repo_identity, update_snapshot, GraphPipelineOptions,
};
use crate::protocol::{
    available_status, query_failed_status, required_missing_status, schema_mismatch_status,
    stale_status, unsupported_mode_status, GraphDaemonOperation, GraphDaemonRequest,
    GraphDaemonResponse, GraphDetectChangesResult, GraphFactQueryResult, GraphFreshness,
    GraphImpactResult, GraphNamedQueryResult, GraphPipelineResult, GraphProviderStatus,
    GraphReviewContextResult, GraphSearchResult, RepoIdentity,
};
use crate::store::{GraphStore, StoreError, StorePaths, StoreQueryOutput};
use crate::watch::{run_watch, WatchCliOptions, DEFAULT_WATCH_IDLE_TIMEOUT_MS};
use crate::GRAPH_SCHEMA_VERSION;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

mod lifecycle;
mod query;
mod response;
#[cfg(test)]
mod tests;
mod validation;

use lifecycle::lifecycle_status;
use query::query_result;
use response::{empty_parts, failure_response, query_failure_parts, status_only};
use validation::validate_request;

const GRAPH_DAEMON_PROTOCOL: &str = "lattice.graph.daemon";

#[derive(Debug, Clone)]
struct ResponseParts {
    status: GraphProviderStatus,
    result: Option<GraphFactQueryResult>,
    named_query: Option<GraphNamedQueryResult>,
    impact: Option<GraphImpactResult>,
    review_context: Option<GraphReviewContextResult>,
    changes: Option<GraphDetectChangesResult>,
    search: Option<GraphSearchResult>,
    pipeline: Option<GraphPipelineResult>,
}

struct QueryResources {
    status: GraphProviderStatus,
    store: GraphStore,
    snapshot: StoreQueryOutput,
}

pub fn run_stdio() -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("failed to read request: {error}"))?;
        let Some(request) = parse_request_line(line)? else {
            continue;
        };
        let should_shutdown = request.operation == GraphDaemonOperation::Shutdown;
        let response = handle_request(request);
        write_response_line(&mut stdout, &response)?;
        if should_shutdown {
            break;
        }
    }
    Ok(())
}

fn parse_request_line(line: String) -> Result<Option<GraphDaemonRequest>, String> {
    if line.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&line)
        .map(Some)
        .map_err(|error| format!("invalid graph daemon request: {error}"))
}

fn write_response_line(
    stdout: &mut impl Write,
    response: &GraphDaemonResponse,
) -> Result<(), String> {
    serde_json::to_writer(&mut *stdout, response)
        .map_err(|error| format!("failed to write response: {error}"))?;
    stdout
        .write_all(b"\n")
        .map_err(|error| format!("failed to write response newline: {error}"))?;
    stdout
        .flush()
        .map_err(|error| format!("failed to flush response: {error}"))
}

pub fn handle_request(request: GraphDaemonRequest) -> GraphDaemonResponse {
    if let Err(error) = validate_request(&request) {
        return failure_response(&request, error.status());
    }
    handle_valid_request(request)
}

fn handle_valid_request(request: GraphDaemonRequest) -> GraphDaemonResponse {
    let now = "2026-06-04T00:00:00.000Z".to_string();
    let parts = match request.operation {
        GraphDaemonOperation::Build => pipeline_result(&request),
        GraphDaemonOperation::Update => pipeline_result(&request),
        GraphDaemonOperation::Watch => return watch_response(request),
        GraphDaemonOperation::Status => status_result(&request, now),
        GraphDaemonOperation::Query => query_result(&request),
        GraphDaemonOperation::Ping => status_only(available_status(request.repo.clone(), now)),
        GraphDaemonOperation::Health => health_result(&request),
        GraphDaemonOperation::Shutdown => status_only(available_status(request.repo.clone(), now)),
    };

    GraphDaemonResponse {
        protocol: GRAPH_DAEMON_PROTOCOL.to_string(),
        request_id: request.request_id,
        schema_version: GRAPH_SCHEMA_VERSION,
        status: parts.status,
        result: parts.result,
        named_query: parts.named_query,
        impact: parts.impact,
        review_context: parts.review_context,
        changes: parts.changes,
        search: parts.search,
        pipeline: parts.pipeline,
        lifecycle: None,
    }
}

fn watch_response(request: GraphDaemonRequest) -> GraphDaemonResponse {
    let Some(repo_root) = request.repo.repo_root.clone() else {
        return failure_response(
            &request,
            required_missing_status("GraphProvider watch requires repo.repoRoot"),
        );
    };
    if request.once != Some(true) {
        return failure_response(
            &request,
            unsupported_mode_status(
                "Graph daemon JSONL watch requires once=true; use graph-core watch CLI for long-lived watch daemons",
            ),
        );
    }
    let options = WatchCliOptions {
        repo_root: PathBuf::from(repo_root),
        base_ref: request.base_ref.clone(),
        watch_paths: request_watch_paths(&request),
        poll_interval_ms: request.poll_interval_ms.unwrap_or(1000),
        idle_timeout_ms: request
            .idle_timeout_ms
            .unwrap_or(DEFAULT_WATCH_IDLE_TIMEOUT_MS),
        once: true,
        max_wal_bytes: request
            .max_wal_bytes
            .unwrap_or(crate::store::DEFAULT_WAL_BUDGET_BYTES),
    };
    match run_watch(options) {
        Ok(mut response) => {
            response.request_id = request.request_id;
            response
        }
        Err(error) => failure_response(&request, query_failed_status(error, Vec::new())),
    }
}

fn status_result(request: &GraphDaemonRequest, generated_at: String) -> ResponseParts {
    let Some(repo_root) = request.repo.repo_root.clone() else {
        return status_only(available_status(request.repo.clone(), generated_at));
    };
    let watch_paths = request_watch_paths(request);
    match status_store_for_repo(&repo_root, &watch_paths) {
        Ok(status) => status_only(status),
        Err(error) => status_only(store_error_status(error)),
    }
}

fn pipeline_result(request: &GraphDaemonRequest) -> ResponseParts {
    let Some(repo_root) = request.repo.repo_root.clone() else {
        return status_only(required_missing_status(
            "GraphProvider pipeline requires repo.repoRoot",
        ));
    };
    let mut options = GraphPipelineOptions::new(repo_root);
    options.base_ref = request.base_ref.clone();
    options.watch_paths = if request.watch_paths.is_empty() {
        request.paths.clone()
    } else {
        request.watch_paths.clone()
    };
    options.max_wal_bytes = request
        .max_wal_bytes
        .unwrap_or(crate::store::DEFAULT_WAL_BUDGET_BYTES);
    let result = if request.operation == GraphDaemonOperation::Build {
        build_full_snapshot(options)
    } else {
        update_snapshot(options)
    };
    match result {
        Ok(pipeline) => ResponseParts {
            status: pipeline.status.clone(),
            pipeline: Some(pipeline),
            ..empty_parts()
        },
        Err(error) => status_only(store_error_status(error)),
    }
}

fn missing_query_result(request: &GraphDaemonRequest) -> ResponseParts {
    let status = schema_mismatch_status(
        "Graph daemon query request must include query",
        GRAPH_SCHEMA_VERSION,
    );
    query_failure_parts(request, status)
}

fn health_result(request: &GraphDaemonRequest) -> ResponseParts {
    status_result(request, crate::pipeline::now_rfc3339())
}

fn query_repo_root(request: &GraphDaemonRequest) -> Option<String> {
    query_repo_candidates(request)
        .into_iter()
        .flatten()
        .find_map(|repo| repo.repo_root.clone())
}

fn query_repo_candidates(request: &GraphDaemonRequest) -> [Option<&RepoIdentity>; 7] {
    [
        request.query.as_ref().map(|query| &query.repo),
        request.named_query.as_ref().map(|query| &query.repo),
        request.impact.as_ref().map(|query| &query.repo),
        request.review_context.as_ref().map(|query| &query.repo),
        request.changes.as_ref().map(|query| &query.repo),
        request.search.as_ref().map(|query| &query.repo),
        Some(&request.repo),
    ]
}

fn open_store_readonly(repo_root: &str) -> Result<GraphStore, StoreError> {
    GraphStore::open_readonly(StorePaths::for_repo_root(repo_root))
}

fn status_store_for_repo(
    repo_root: &str,
    watch_paths: &[String],
) -> Result<GraphProviderStatus, StoreError> {
    if let Some(status) = lifecycle_status(repo_root) {
        return Ok(status);
    }
    let paths = readonly_store_paths(repo_root)?;
    if !paths.db_path.is_file() {
        return Ok(missing_store_status(&paths.repo_root));
    }
    let store = GraphStore::open_readonly(paths)?;
    store.status_for_watch_paths(None, watch_paths)
}

fn request_watch_paths(request: &GraphDaemonRequest) -> Vec<String> {
    if request.watch_paths.is_empty() {
        request.paths.clone()
    } else {
        request.watch_paths.clone()
    }
}

fn readonly_store_paths(repo_root: &str) -> Result<StorePaths, StoreError> {
    let repo_root = Path::new(repo_root);
    if !repo_root.is_dir() {
        return Err(StoreError::RequiredMissing(format!(
            "{} is not a directory",
            display_path(repo_root)
        )));
    }
    Ok(StorePaths::for_repo_root(repo_root.canonicalize()?))
}

fn missing_store_status(repo_root: &Path) -> GraphProviderStatus {
    let reason = "graph store snapshot is missing";
    stale_status(
        repo_identity(repo_root),
        GraphFreshness {
            generated_at: crate::extraction::EXTRACTION_GENERATED_AT.to_string(),
            age_ms: 0,
            max_age_ms: None,
            stale: true,
            reason: Some(reason.to_string()),
        },
        reason,
    )
}

fn store_error_status(error: StoreError) -> GraphProviderStatus {
    match error {
        StoreError::RequiredMissing(message) => required_missing_status(message),
        StoreError::SchemaMismatch {
            message,
            actual_version,
        } => schema_mismatch_status(message, actual_version),
        StoreError::UnsupportedMode(message) => unsupported_mode_status(message),
        StoreError::InvalidSnapshot(message) => query_failed_status(message, Vec::new()),
        StoreError::ExtractionFailed {
            message,
            diagnostics,
        } => query_failed_status(message, diagnostics),
        StoreError::Sqlite(error) => query_failed_status(error.to_string(), Vec::new()),
        StoreError::Io(error) => query_failed_status(error.to_string(), Vec::new()),
        StoreError::Json(error) => query_failed_status(error.to_string(), Vec::new()),
    }
}

fn status_state_is_failure(status: &GraphProviderStatus) -> bool {
    !matches!(status, GraphProviderStatus::Available { .. })
}

pub fn boundary_name() -> &'static str {
    "daemon lifecycle boundary"
}
