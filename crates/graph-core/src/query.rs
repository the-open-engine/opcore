use crate::extraction::SourceFileHash;
use crate::protocol::{
    GraphDetectChangesRequest, GraphFactEdge, GraphFactNode, GraphFactQuerySelector,
    GraphImpactRequest, GraphNamedQueryKind, GraphNamedQueryRequest, GraphRenamedFile,
    GraphReviewContextRequest, GraphSnapshotMetadata, GraphTraversalMetadata,
};
use crate::store::StoreQueryOutput;

mod changes;
mod common;
mod impact;
mod index;
mod selectors;

#[cfg(test)]
mod tests;

use changes::detect_changed_paths;
use common::sorted_repo_paths;
use impact::{change_impact_files, ImpactTraversal};
use index::{Direction, GraphIndex, TraversalSpec};

const DEFAULT_MAX_DEPTH: u32 = 3;
const DEFAULT_LIMIT: u32 = 250;

#[derive(Debug, Clone, PartialEq)]
pub enum GraphStoreQueryResult {
    Available {
        nodes: Vec<GraphFactNode>,
        edges: Vec<GraphFactEdge>,
    },
    Unsupported {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphNamedQueryOutput {
    pub metadata: GraphSnapshotMetadata,
    pub query_kind: GraphNamedQueryKind,
    pub target: String,
    pub nodes: Vec<GraphFactNode>,
    pub edges: Vec<GraphFactEdge>,
    pub traversal: GraphTraversalMetadata,
    pub diagnostics: Vec<crate::protocol::GraphExtractionDiagnostic>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphImpactOutput {
    pub metadata: GraphSnapshotMetadata,
    pub changed_files: Vec<String>,
    pub impacted_files: Vec<String>,
    pub impacted_symbols: Vec<String>,
    pub tests: Vec<String>,
    pub nodes: Vec<GraphFactNode>,
    pub edges: Vec<GraphFactEdge>,
    pub traversal: GraphTraversalMetadata,
    pub diagnostics: Vec<crate::protocol::GraphExtractionDiagnostic>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphChangesOutput {
    pub metadata: GraphSnapshotMetadata,
    pub changed_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub renamed_files: Vec<GraphRenamedFile>,
    pub diagnostics: Vec<crate::protocol::GraphExtractionDiagnostic>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphReviewContextOutput {
    pub metadata: GraphSnapshotMetadata,
    pub changed_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub renamed_files: Vec<GraphRenamedFile>,
    pub impacted_files: Vec<String>,
    pub impacted_symbols: Vec<String>,
    pub tests: Vec<String>,
    pub nodes: Vec<GraphFactNode>,
    pub edges: Vec<GraphFactEdge>,
    pub traversal: GraphTraversalMetadata,
    pub diagnostics: Vec<crate::protocol::GraphExtractionDiagnostic>,
}

pub fn select_graph_facts(
    all_nodes: &[GraphFactNode],
    all_edges: &[GraphFactEdge],
    selector: &GraphFactQuerySelector,
) -> GraphStoreQueryResult {
    selectors::select_graph_facts(all_nodes, all_edges, selector)
}

pub fn named_query(
    snapshot: &StoreQueryOutput,
    request: &GraphNamedQueryRequest,
) -> GraphNamedQueryOutput {
    let index = GraphIndex::new(&snapshot.nodes, &snapshot.edges);
    let max_depth = request.max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT);
    let target_ids = index.resolve_query_targets(request.query_kind, &request.target);
    let selection = match request.query_kind {
        GraphNamedQueryKind::CallersOf => index.traverse(
            &target_ids,
            TraversalSpec::new(&["CALLS"], Direction::Incoming, max_depth, limit),
        ),
        GraphNamedQueryKind::CalleesOf => index.traverse(
            &target_ids,
            TraversalSpec::new(&["CALLS"], Direction::Outgoing, max_depth, limit),
        ),
        GraphNamedQueryKind::ImportersOf => index.traverse(
            &target_ids,
            TraversalSpec::new(
                &["IMPORTS_FROM", "DEPENDS_ON"],
                Direction::Incoming,
                max_depth,
                limit,
            ),
        ),
        GraphNamedQueryKind::ImportsOf => index.traverse(
            &target_ids,
            TraversalSpec::new(
                &["IMPORTS_FROM", "DEPENDS_ON"],
                Direction::Outgoing,
                max_depth,
                limit,
            ),
        ),
        GraphNamedQueryKind::TestsFor => index.tests_for(&target_ids, max_depth, limit),
        GraphNamedQueryKind::ChildrenOf => index.traverse(
            &target_ids,
            TraversalSpec::new(&["CONTAINS"], Direction::Outgoing, max_depth, limit),
        ),
        GraphNamedQueryKind::FileSummary => index.file_summary(&target_ids, limit),
    };
    GraphNamedQueryOutput {
        metadata: snapshot.metadata.clone(),
        query_kind: request.query_kind,
        target: request.target.clone(),
        nodes: selection.nodes,
        edges: selection.edges,
        traversal: selection.traversal,
        diagnostics: snapshot.diagnostics.clone(),
    }
}

pub fn impact(snapshot: &StoreQueryOutput, request: &GraphImpactRequest) -> GraphImpactOutput {
    let index = GraphIndex::new(&snapshot.nodes, &snapshot.edges);
    let max_depth = request.max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT);
    let changed_files = sorted_repo_paths(request.files.clone());
    ImpactTraversal::new(changed_files, max_depth, limit).run(snapshot, &index)
}

pub fn detect_changes(
    snapshot: &StoreQueryOutput,
    stored_hashes: &[SourceFileHash],
    current_hashes: &[SourceFileHash],
    request: &GraphDetectChangesRequest,
) -> GraphChangesOutput {
    let (changed_files, deleted_files, renamed_files) =
        detect_changed_paths(stored_hashes, current_hashes, &request.files);
    GraphChangesOutput {
        metadata: snapshot.metadata.clone(),
        changed_files,
        deleted_files,
        renamed_files,
        diagnostics: snapshot.diagnostics.clone(),
    }
}

pub fn review_context(
    snapshot: &StoreQueryOutput,
    stored_hashes: &[SourceFileHash],
    current_hashes: &[SourceFileHash],
    request: &GraphReviewContextRequest,
) -> GraphReviewContextOutput {
    let changes_request = GraphDetectChangesRequest {
        request_id: request.request_id.clone(),
        repo: request.repo.clone(),
        schema_version: request.schema_version,
        mode: request.mode.clone(),
        files: request.files.clone(),
        base_ref: request.base_ref.clone(),
    };
    let changes = detect_changes(snapshot, stored_hashes, current_hashes, &changes_request);
    let impact_files = change_impact_files(
        &changes.changed_files,
        &changes.deleted_files,
        &changes.renamed_files,
    );
    let impact_request = GraphImpactRequest {
        request_id: request.request_id.clone(),
        repo: request.repo.clone(),
        schema_version: request.schema_version,
        mode: request.mode.clone(),
        files: impact_files,
        base_ref: request.base_ref.clone(),
        max_depth: request.max_depth,
        limit: request.limit,
    };
    let impact = impact(snapshot, &impact_request);
    GraphReviewContextOutput {
        metadata: snapshot.metadata.clone(),
        changed_files: changes.changed_files,
        deleted_files: changes.deleted_files,
        renamed_files: changes.renamed_files,
        impacted_files: impact.impacted_files,
        impacted_symbols: impact.impacted_symbols,
        tests: impact.tests,
        nodes: impact.nodes,
        edges: impact.edges,
        traversal: impact.traversal,
        diagnostics: snapshot.diagnostics.clone(),
    }
}

pub fn boundary_name() -> &'static str {
    "store-backed graph query selector boundary"
}

pub fn behavior_status() -> &'static str {
    "implemented: GraphProvider store selectors, named queries, impact, review context, and change detection"
}
