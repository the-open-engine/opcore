use super::daemon::{GraphDaemonOperation, GraphWalCheckpointSummary, GraphWatchLifecycle};
use crate::artifact::{runtime_artifact_metadata, GraphProviderArtifactMetadata};
use crate::{GRAPH_PROVIDER_NAME, GRAPH_SCHEMA_VERSION};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFreshness {
    pub generated_at: String,
    pub age_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_age_ms: Option<u64>,
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphProviderMode {
    Optional,
    Required,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFailureCategory {
    ProviderMissing,
    DaemonUnavailable,
    SchemaMismatch,
    StaleSnapshot,
    QueryFailed,
    PermissionDenied,
    UnsupportedMode,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFailure {
    pub category: ProviderFailureCategory,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphExtractionDiagnosticCategory {
    MissingTsconfig,
    MalformedTsconfig,
    UnsupportedLanguage,
    ParseError,
    MissingParser,
    UnresolvedImport,
    MaxFilesExceeded,
    MaxDepthExceeded,
    PathTraversal,
    IoError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphExtractionDiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphExtractionDiagnostic {
    pub category: GraphExtractionDiagnosticCategory,
    pub severity: GraphExtractionDiagnosticSeverity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphProviderCapabilityHandshake {
    pub provider: String,
    pub graph_schema_version: u32,
    pub artifact_name: String,
    pub artifact_version: String,
    pub target_platform: String,
    pub supported_operations: Vec<GraphDaemonOperation>,
    pub node_kinds: Vec<String>,
    pub edge_kinds: Vec<String>,
    pub query_kinds: Vec<String>,
    pub artifact: GraphProviderArtifactMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GraphProviderStatus {
    Available {
        mode: GraphProviderMode,
        provider: String,
        schema_version: u32,
        repo: RepoIdentity,
        freshness: GraphFreshness,
        #[serde(skip_serializing_if = "Option::is_none")]
        db_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        capabilities: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        handshake: Option<Box<GraphProviderCapabilityHandshake>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        wal_checkpoint: Option<GraphWalCheckpointSummary>,
    },
    Warming {
        mode: GraphProviderMode,
        provider: String,
        schema_version: u32,
        repo: RepoIdentity,
        freshness: GraphFreshness,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lifecycle: Option<Box<GraphWatchLifecycle>>,
    },
    Skipped {
        mode: GraphProviderMode,
        provider: String,
        schema_version: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        failure: ProviderFailure,
    },
    RequiredMissing {
        mode: GraphProviderMode,
        provider: String,
        schema_version: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        failure: ProviderFailure,
    },
    Stale {
        mode: GraphProviderMode,
        provider: String,
        schema_version: u32,
        repo: RepoIdentity,
        freshness: GraphFreshness,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        failure: ProviderFailure,
    },
    SchemaMismatch {
        mode: GraphProviderMode,
        provider: String,
        schema_version: u32,
        expected_schema_version: u32,
        actual_schema_version: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        failure: ProviderFailure,
    },
    DaemonUnavailable {
        mode: GraphProviderMode,
        provider: String,
        schema_version: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        failure: ProviderFailure,
    },
    Error {
        mode: GraphProviderMode,
        provider: String,
        schema_version: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        failure: ProviderFailure,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
}

pub fn graph_capability_handshake() -> GraphProviderCapabilityHandshake {
    GraphProviderCapabilityHandshake {
        provider: GRAPH_PROVIDER_NAME.to_string(),
        graph_schema_version: GRAPH_SCHEMA_VERSION,
        artifact_name: crate::artifact::ARTIFACT_NAME.to_string(),
        artifact_version: crate::artifact::ARTIFACT_VERSION.to_string(),
        target_platform: crate::artifact::target_platform(),
        supported_operations: vec![
            GraphDaemonOperation::Build,
            GraphDaemonOperation::Update,
            GraphDaemonOperation::Watch,
            GraphDaemonOperation::Status,
            GraphDaemonOperation::Query,
            GraphDaemonOperation::Ping,
            GraphDaemonOperation::Health,
            GraphDaemonOperation::Shutdown,
        ],
        node_kinds: vec![
            "repo".to_string(),
            "package".to_string(),
            "file".to_string(),
            "symbol".to_string(),
            "test".to_string(),
            "File".to_string(),
            "Module".to_string(),
            "Class".to_string(),
            "Function".to_string(),
            "Variable".to_string(),
            "Type".to_string(),
            "Test".to_string(),
        ],
        edge_kinds: vec![
            "CONTAINS".to_string(),
            "DECLARES".to_string(),
            "IMPORTS_FROM".to_string(),
            "CALLS".to_string(),
            "TESTED_BY".to_string(),
            "INHERITS".to_string(),
            "IMPLEMENTS".to_string(),
            "DEPENDS_ON".to_string(),
        ],
        query_kinds: vec![
            "nodes".to_string(),
            "edges".to_string(),
            "neighbors".to_string(),
            "symbols".to_string(),
            "impact".to_string(),
            "callers_of".to_string(),
            "callees_of".to_string(),
            "importers_of".to_string(),
            "imports_of".to_string(),
            "tests_for".to_string(),
            "children_of".to_string(),
            "file_summary".to_string(),
            "review_context".to_string(),
            "detect_changes".to_string(),
            "search".to_string(),
        ],
        artifact: runtime_artifact_metadata(),
    }
}

pub fn available_status(repo: RepoIdentity, generated_at: String) -> GraphProviderStatus {
    available_status_with_freshness(
        repo,
        GraphFreshness {
            generated_at,
            age_ms: 0,
            max_age_ms: None,
            stale: false,
            reason: None,
        },
        None,
        Some("graph-core sidecar source extraction ready".to_string()),
    )
}

pub fn available_status_with_freshness(
    repo: RepoIdentity,
    freshness: GraphFreshness,
    db_path: Option<String>,
    message: Option<String>,
) -> GraphProviderStatus {
    available_status_with_wal_checkpoint(AvailableStatusInput {
        repo,
        freshness,
        db_path,
        message,
        wal_checkpoint: None,
    })
}

pub struct AvailableStatusInput {
    pub repo: RepoIdentity,
    pub freshness: GraphFreshness,
    pub db_path: Option<String>,
    pub message: Option<String>,
    pub wal_checkpoint: Option<GraphWalCheckpointSummary>,
}

pub fn available_status_with_wal_checkpoint(input: AvailableStatusInput) -> GraphProviderStatus {
    GraphProviderStatus::Available {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        repo: input.repo,
        freshness: input.freshness,
        db_path: input.db_path,
        message: input.message,
        capabilities: vec![
            "build".to_string(),
            "update".to_string(),
            "watch".to_string(),
            "status".to_string(),
            "query".to_string(),
            "impact".to_string(),
            "review-context".to_string(),
            "detect-changes".to_string(),
            "search".to_string(),
        ],
        handshake: Some(Box::new(graph_capability_handshake())),
        wal_checkpoint: input.wal_checkpoint,
    }
}

pub fn warming_status(
    repo: RepoIdentity,
    freshness: GraphFreshness,
    lifecycle: Option<GraphWatchLifecycle>,
    message: impl Into<String>,
) -> GraphProviderStatus {
    GraphProviderStatus::Warming {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        repo,
        freshness,
        message: Some(message.into()),
        lifecycle: lifecycle.map(Box::new),
    }
}

pub fn stale_status(
    repo: RepoIdentity,
    freshness: GraphFreshness,
    message: impl Into<String>,
) -> GraphProviderStatus {
    let message = message.into();
    GraphProviderStatus::Stale {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        repo,
        freshness,
        message: Some(message.clone()),
        failure: ProviderFailure {
            category: ProviderFailureCategory::StaleSnapshot,
            message,
            retryable: Some(true),
            cause: None,
        },
    }
}

pub fn required_missing_status(message: impl Into<String>) -> GraphProviderStatus {
    let message = message.into();
    GraphProviderStatus::RequiredMissing {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        message: Some(message.clone()),
        failure: ProviderFailure {
            category: ProviderFailureCategory::ProviderMissing,
            message,
            retryable: Some(false),
            cause: None,
        },
    }
}

pub fn schema_mismatch_status(
    message: impl Into<String>,
    actual_schema_version: u32,
) -> GraphProviderStatus {
    let message = message.into();
    GraphProviderStatus::SchemaMismatch {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        expected_schema_version: GRAPH_SCHEMA_VERSION,
        actual_schema_version,
        message: Some(message.clone()),
        failure: ProviderFailure {
            category: ProviderFailureCategory::SchemaMismatch,
            message,
            retryable: None,
            cause: None,
        },
    }
}

pub fn query_failed_status(
    message: impl Into<String>,
    diagnostics: Vec<GraphExtractionDiagnostic>,
) -> GraphProviderStatus {
    let message = message.into();
    GraphProviderStatus::Error {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        message: Some(message.clone()),
        failure: ProviderFailure {
            category: ProviderFailureCategory::QueryFailed,
            message,
            retryable: None,
            cause: None,
        },
        diagnostics,
    }
}

pub fn unsupported_mode_status(message: impl Into<String>) -> GraphProviderStatus {
    let message = message.into();
    GraphProviderStatus::Error {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        message: Some(message.clone()),
        failure: ProviderFailure {
            category: ProviderFailureCategory::UnsupportedMode,
            message,
            retryable: Some(false),
            cause: None,
        },
        diagnostics: Vec::new(),
    }
}
