use crate::extraction::{FileFacts, SourceFileHash};
use crate::protocol::{
    schema_mismatch_status, GraphExtractionDiagnostic, GraphFactEdge, GraphFactNode,
    GraphFreshness, GraphProviderStatus, GraphSnapshotMetadata,
};
use crate::search::GraphSearchOutput;
use std::collections::BTreeMap;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorePaths {
    pub repo_root: PathBuf,
    pub graph_dir: PathBuf,
    pub db_path: PathBuf,
}

impl StorePaths {
    pub fn for_repo_root(repo_root: impl Into<PathBuf>) -> Self {
        let repo_root = repo_root.into();
        let graph_dir = repo_root.join(".lattice").join("graph");
        let db_path = graph_dir.join("graph.db");
        Self {
            repo_root,
            graph_dir,
            db_path,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoreSnapshot {
    pub metadata: GraphSnapshotMetadata,
    pub nodes: Vec<GraphFactNode>,
    pub edges: Vec<GraphFactEdge>,
    pub diagnostics: Vec<GraphExtractionDiagnostic>,
    pub file_hashes: Vec<SourceFileHash>,
    pub file_facts: Vec<FileFacts>,
}

pub(crate) struct SnapshotRefreshOptions<'a> {
    pub operation: &'a str,
    pub changed_files: &'a [String],
    pub deleted_files: &'a [String],
    pub full_rebuild_required: bool,
}

impl<'a> SnapshotRefreshOptions<'a> {
    pub(super) fn full(operation: &'a str) -> Self {
        Self {
            operation,
            changed_files: &[],
            deleted_files: &[],
            full_rebuild_required: true,
        }
    }

    pub(super) fn incremental_search(&self) -> bool {
        self.operation == "update" && !self.full_rebuild_required
    }
}

#[derive(Debug, Clone)]
pub struct StoreQueryOutput {
    pub metadata: GraphSnapshotMetadata,
    pub nodes: Vec<GraphFactNode>,
    pub edges: Vec<GraphFactEdge>,
    pub diagnostics: Vec<GraphExtractionDiagnostic>,
}

#[derive(Debug, Clone)]
pub struct StoreSearchOutput {
    pub metadata: GraphSnapshotMetadata,
    pub search: GraphSearchOutput,
    pub diagnostics: Vec<GraphExtractionDiagnostic>,
}

#[derive(Debug, Clone)]
pub enum FreshnessState {
    Available {
        metadata: GraphSnapshotMetadata,
        freshness: GraphFreshness,
    },
    Stale {
        metadata: Option<GraphSnapshotMetadata>,
        freshness: GraphFreshness,
        reason: String,
    },
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("repo root is required for GraphProvider store operations: {0}")]
    RequiredMissing(String),
    #[error("GraphProvider store schema mismatch: {message}")]
    SchemaMismatch {
        message: String,
        actual_version: u32,
    },
    #[error("GraphProvider store snapshot is invalid: {0}")]
    InvalidSnapshot(String),
    #[error("GraphProvider extraction failed: {message}")]
    ExtractionFailed {
        message: String,
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
    #[error("GraphProvider store query is unsupported: {0}")]
    UnsupportedMode(String),
    #[error("SQLite store error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("store I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("store JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl StoreError {
    pub fn schema_status(&self) -> GraphProviderStatus {
        match self {
            StoreError::SchemaMismatch {
                message,
                actual_version,
            } => schema_mismatch_status(message.clone(), *actual_version),
            StoreError::RequiredMissing(message) => {
                crate::protocol::required_missing_status(message.clone())
            }
            _ => schema_mismatch_status(self.to_string(), 0),
        }
    }
}

pub type StoreResult<T> = Result<T, StoreError>;
pub(super) type FileHashesByPath = BTreeMap<String, SourceFileHash>;
pub(super) type NodesById = BTreeMap<String, GraphFactNode>;
