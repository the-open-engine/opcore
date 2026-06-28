use super::provider::{
    GraphExtractionDiagnostic, GraphFreshness, GraphProviderMode, GraphProviderStatus, RepoIdentity,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFactNode {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFactEdge {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub kind: String,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshotMetadata {
    pub schema_version: u32,
    pub provider: String,
    pub repo: RepoIdentity,
    pub generated_at: String,
    pub freshness: GraphFreshness,
    pub node_kinds: Vec<String>,
    pub edge_kinds: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphFactQueryKind {
    Nodes,
    Edges,
    Neighbors,
    Symbols,
    Impact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFactQuerySelector {
    pub kind: GraphFactQueryKind,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub node_kinds: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub edge_kinds: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFactQueryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub repo: RepoIdentity,
    pub schema_version: u32,
    pub mode: GraphProviderMode,
    pub selector: GraphFactQuerySelector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum GraphFactQueryResult {
    Available {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
        metadata: Box<GraphSnapshotMetadata>,
        nodes: Vec<GraphFactNode>,
        edges: Vec<GraphFactEdge>,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
    Failure {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphNamedQueryKind {
    CallersOf,
    CalleesOf,
    ImportersOf,
    ImportsOf,
    TestsFor,
    InheritorsOf,
    ChildrenOf,
    FileSummary,
}

impl GraphNamedQueryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GraphNamedQueryKind::CallersOf => "callers_of",
            GraphNamedQueryKind::CalleesOf => "callees_of",
            GraphNamedQueryKind::ImportersOf => "importers_of",
            GraphNamedQueryKind::ImportsOf => "imports_of",
            GraphNamedQueryKind::TestsFor => "tests_for",
            GraphNamedQueryKind::InheritorsOf => "inheritors_of",
            GraphNamedQueryKind::ChildrenOf => "children_of",
            GraphNamedQueryKind::FileSummary => "file_summary",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphTraversalMetadata {
    pub max_depth: u32,
    pub truncated: bool,
    pub total: usize,
    pub empty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNamedQueryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub repo: RepoIdentity,
    pub schema_version: u32,
    pub mode: GraphProviderMode,
    pub query_kind: GraphNamedQueryKind,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum GraphNamedQueryResult {
    Available {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
        metadata: Box<GraphSnapshotMetadata>,
        query_kind: GraphNamedQueryKind,
        target: String,
        nodes: Vec<GraphFactNode>,
        edges: Vec<GraphFactEdge>,
        traversal: GraphTraversalMetadata,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
    Failure {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphImpactRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub repo: RepoIdentity,
    pub schema_version: u32,
    pub mode: GraphProviderMode,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum GraphImpactResult {
    Available {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
        metadata: Box<GraphSnapshotMetadata>,
        changed_files: Vec<String>,
        impacted_files: Vec<String>,
        impacted_symbols: Vec<String>,
        tests: Vec<String>,
        nodes: Vec<GraphFactNode>,
        edges: Vec<GraphFactEdge>,
        traversal: GraphTraversalMetadata,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
    Failure {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRenamedFile {
    pub from_path: String,
    pub to_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDetectChangesRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub repo: RepoIdentity,
    pub schema_version: u32,
    pub mode: GraphProviderMode,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum GraphDetectChangesResult {
    Available {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
        metadata: Box<GraphSnapshotMetadata>,
        changed_files: Vec<String>,
        deleted_files: Vec<String>,
        renamed_files: Vec<GraphRenamedFile>,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
    Failure {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphReviewContextRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub repo: RepoIdentity,
    pub schema_version: u32,
    pub mode: GraphProviderMode,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum GraphReviewContextResult {
    Available {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
        metadata: Box<GraphSnapshotMetadata>,
        changed_files: Vec<String>,
        deleted_files: Vec<String>,
        renamed_files: Vec<GraphRenamedFile>,
        impacted_files: Vec<String>,
        impacted_symbols: Vec<String>,
        tests: Vec<String>,
        nodes: Vec<GraphFactNode>,
        edges: Vec<GraphFactEdge>,
        traversal: GraphTraversalMetadata,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
    Failure {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSearchRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub repo: RepoIdentity,
    pub schema_version: u32,
    pub mode: GraphProviderMode,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSearchMode {
    pub engine: String,
    pub query_syntax: String,
    pub limit: u32,
    #[serde(default)]
    pub context_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSearchResultEntry {
    pub node_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub qualified_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub signature: String,
    pub score: f64,
    pub rank: u32,
    #[serde(default)]
    pub matches: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSearchSummary {
    pub query: String,
    pub total: usize,
    pub returned: usize,
    pub limit: u32,
    pub indexed_node_kinds: Vec<String>,
    pub context_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum GraphSearchResult {
    Available {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
        metadata: Box<GraphSnapshotMetadata>,
        query: String,
        search_mode: GraphSearchMode,
        summary: GraphSearchSummary,
        results: Vec<GraphSearchResultEntry>,
        #[serde(default)]
        hints: Vec<String>,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
    Failure {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        status: Box<GraphProviderStatus>,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        hints: Vec<String>,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        diagnostics: Vec<GraphExtractionDiagnostic>,
    },
}
