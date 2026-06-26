use super::facts::{
    GraphDetectChangesRequest, GraphDetectChangesResult, GraphFactQueryRequest,
    GraphFactQueryResult, GraphImpactRequest, GraphImpactResult, GraphNamedQueryRequest,
    GraphNamedQueryResult, GraphReviewContextRequest, GraphReviewContextResult, GraphSearchRequest,
    GraphSearchResult,
};
use super::provider::{GraphProviderStatus, RepoIdentity};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphDaemonOperation {
    Build,
    Update,
    Watch,
    Status,
    Query,
    Ping,
    Health,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPipelinePhaseTiming {
    pub phase: String,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphWalCheckpointSummary {
    pub wal_path: String,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub budget_bytes: u64,
    pub checkpointed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPipelineSummary {
    pub operation: String,
    pub repo: RepoIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_path: Option<String>,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub discovered_files: usize,
    pub parsed_files: usize,
    pub changed_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub unchanged_files: usize,
    pub full_rebuild_required: bool,
    pub diagnostics_count: usize,
    pub phase_timings: Vec<GraphPipelinePhaseTiming>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub watch_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wal_checkpoint: Option<GraphWalCheckpointSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphWatchLifecycleState {
    Warming,
    Available,
    Error,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphWatchLifecycle {
    pub state: GraphWatchLifecycleState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub started_at: String,
    pub updated_at: String,
    pub pid_path: String,
    pub state_path: String,
    pub log_path: String,
    pub poll_interval_ms: u64,
    pub idle_timeout_ms: u64,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub watch_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPipelineResult {
    pub summary: GraphPipelineSummary,
    pub status: GraphProviderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<GraphWatchLifecycle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDaemonRequest {
    pub protocol: String,
    pub request_id: String,
    pub schema_version: u32,
    pub operation: GraphDaemonOperation,
    pub repo: RepoIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<GraphFactQueryRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub named_query: Option<GraphNamedQueryRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<GraphImpactRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_context: Option<GraphReviewContextRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<GraphDetectChangesRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<GraphSearchRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub watch_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll_interval_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub once: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_wal_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDaemonResponse {
    pub protocol: String,
    pub request_id: String,
    pub schema_version: u32,
    pub status: GraphProviderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<GraphFactQueryResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub named_query: Option<GraphNamedQueryResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<GraphImpactResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_context: Option<GraphReviewContextResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<GraphDetectChangesResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<GraphSearchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<GraphPipelineResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<GraphWatchLifecycle>,
}
