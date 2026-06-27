use super::*;
use crate::protocol::{GraphFactQueryKind, GraphFreshness, GraphProviderMode, RepoIdentity};
use serde_json::json;
use std::collections::BTreeSet;

#[test]
fn impact_traverses_reverse_file_dependencies_and_tests() {
    let snapshot = fixture_snapshot();
    let output = impact(
        &snapshot,
        &GraphImpactRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            files: vec!["src/models.ts".to_string()],
            base_ref: None,
            max_depth: Some(3),
            limit: Some(100),
        },
    );

    assert_eq!(output.changed_files, vec!["src/models.ts"]);
    assert!(output
        .impacted_files
        .contains(&"src/components/GreetingCard.tsx".to_string()));
    assert!(output
        .tests
        .contains(&"src/__tests__/greeting.test.ts".to_string()));
    assert!(!output.traversal.truncated);
}

#[test]
fn python_file_queries_traverse_nested_symbols_and_is_test_functions() {
    let snapshot = python_test_snapshot();
    let tests = named_query(
        &snapshot,
        &GraphNamedQueryRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            query_kind: GraphNamedQueryKind::TestsFor,
            target: "src/pkg/models.py".to_string(),
            max_depth: Some(1),
            limit: Some(100),
        },
    );
    assert!(tests
        .nodes
        .iter()
        .any(|node| node.path.as_deref() == Some("tests/test_models.py")));

    let summary = named_query(
        &snapshot,
        &GraphNamedQueryRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            query_kind: GraphNamedQueryKind::FileSummary,
            target: "src/pkg/models.py".to_string(),
            max_depth: None,
            limit: Some(100),
        },
    );
    assert!(summary
        .edges
        .iter()
        .any(|edge| edge.kind == "CONTAINS" && edge.to == "class:src/pkg/models.py#PublicModel"));

    let impact = impact(
        &snapshot,
        &GraphImpactRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            files: vec!["src/pkg/models.py".to_string()],
            base_ref: None,
            max_depth: Some(3),
            limit: Some(100),
        },
    );
    assert!(impact.tests.contains(&"tests/test_models.py".to_string()));
    assert!(impact
        .impacted_symbols
        .contains(&"class:src/pkg/models.py#PublicModel".to_string()));
    assert!(!impact
        .impacted_symbols
        .contains(&"function:tests/test_models.py#test_make_model".to_string()));

    let review = review_context(
        &snapshot,
        &[hash("src/pkg/models.py", "aaa")],
        &[hash("src/pkg/models.py", "bbb")],
        &GraphReviewContextRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            files: vec!["src/pkg/models.py".to_string()],
            base_ref: None,
            max_depth: Some(3),
            limit: Some(100),
        },
    );
    assert_eq!(review.changed_files, vec!["src/pkg/models.py"]);
    assert!(review.tests.contains(&"tests/test_models.py".to_string()));
}

#[test]
fn named_query_reports_empty_missing_targets() {
    let snapshot = fixture_snapshot();
    let output = named_query(
        &snapshot,
        &GraphNamedQueryRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            query_kind: GraphNamedQueryKind::ImportersOf,
            target: "src/missing.ts".to_string(),
            max_depth: Some(2),
            limit: Some(10),
        },
    );

    assert!(output.traversal.empty);
    assert!(output.nodes.is_empty());
    assert!(output.edges.is_empty());
}

#[test]
fn named_query_handles_import_cycles_with_deterministic_order() {
    let snapshot = cycle_snapshot();
    let output = named_query(
        &snapshot,
        &GraphNamedQueryRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            query_kind: GraphNamedQueryKind::ImportersOf,
            target: "src/a.ts".to_string(),
            max_depth: Some(4),
            limit: Some(10),
        },
    );

    let node_ids = output
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<Vec<_>>();
    let edge_ids = output
        .edges
        .iter()
        .map(|edge| edge.id.as_deref().unwrap_or_default())
        .collect::<Vec<_>>();

    assert_eq!(
        node_ids,
        vec!["file:src/a.ts", "file:src/b.ts", "file:src/c.ts"]
    );
    assert_eq!(
        edge_ids,
        vec![
            "DEPENDS_ON:file:src/a.ts->file:src/b.ts",
            "DEPENDS_ON:file:src/b.ts->file:src/a.ts",
            "DEPENDS_ON:file:src/c.ts->file:src/a.ts"
        ]
    );
    assert!(!output.traversal.truncated);
    assert_eq!(output.traversal.total, 3);
}

#[test]
fn named_query_filters_dangling_edges_without_missing_nodes() {
    let mut snapshot = cycle_snapshot();
    snapshot
        .edges
        .push(edge("DEPENDS_ON", "file:src/a.ts", "file:src/missing.ts"));
    let output = named_query(
        &snapshot,
        &GraphNamedQueryRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            query_kind: GraphNamedQueryKind::ImportsOf,
            target: "src/a.ts".to_string(),
            max_depth: Some(1),
            limit: Some(10),
        },
    );

    assert!(!output
        .edges
        .iter()
        .any(|edge| edge.to == "file:src/missing.ts"));
    assert!(!output
        .nodes
        .iter()
        .any(|node| node.id == "file:src/missing.ts"));
    assert!(!output.traversal.empty);
}

#[test]
fn traversal_limits_nodes_and_edges_together() {
    let snapshot = fixture_snapshot();
    let importers = named_query(
        &snapshot,
        &GraphNamedQueryRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            query_kind: GraphNamedQueryKind::ImportersOf,
            target: "src/models.ts".to_string(),
            max_depth: Some(2),
            limit: Some(1),
        },
    );
    assert_limited_without_dangling(&importers.nodes, &importers.edges, 1);
    assert!(importers.traversal.truncated);

    let tests = named_query(
        &snapshot,
        &GraphNamedQueryRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            query_kind: GraphNamedQueryKind::TestsFor,
            target: "src/models.ts".to_string(),
            max_depth: Some(1),
            limit: Some(1),
        },
    );
    assert_limited_without_dangling(&tests.nodes, &tests.edges, 1);
    assert!(tests.traversal.truncated);

    let summary = named_query(
        &snapshot,
        &GraphNamedQueryRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            query_kind: GraphNamedQueryKind::FileSummary,
            target: "src/models.ts".to_string(),
            max_depth: Some(1),
            limit: Some(1),
        },
    );
    assert_limited_without_dangling(&summary.nodes, &summary.edges, 1);
    assert!(summary.traversal.truncated);

    let impact = impact(
        &snapshot,
        &GraphImpactRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            files: vec!["src/models.ts".to_string()],
            base_ref: None,
            max_depth: Some(3),
            limit: Some(1),
        },
    );
    assert_limited_without_dangling(&impact.nodes, &impact.edges, 1);
    assert!(impact.traversal.truncated);
    assert_eq!(impact.impacted_files, vec!["src/models.ts"]);
    assert!(impact.impacted_symbols.is_empty());
    assert!(impact.tests.is_empty());
}

#[test]
fn fact_selector_limits_nodes_and_edges_together() {
    let mut snapshot = cycle_snapshot();
    snapshot
        .edges
        .push(edge("DEPENDS_ON", "file:src/a.ts", "file:src/missing.ts"));
    let result = select_graph_facts(
        &snapshot.nodes,
        &snapshot.edges,
        &GraphFactQuerySelector {
            kind: GraphFactQueryKind::Nodes,
            node_kinds: Vec::new(),
            edge_kinds: Vec::new(),
            ids: Vec::new(),
            text: None,
            limit: Some(1),
        },
    );
    assert!(matches!(result, GraphStoreQueryResult::Available { .. }));
    if let GraphStoreQueryResult::Available { nodes, edges } = result {
        assert_limited_without_dangling(&nodes, &edges, 1);
    }
}

#[test]
fn detect_changes_reports_renames_by_checksum() {
    let snapshot = fixture_snapshot();
    let stored = vec![hash("src/old.ts", "aaa")];
    let current = vec![hash("src/new.ts", "aaa")];
    let output = detect_changes(
        &snapshot,
        &stored,
        &current,
        &GraphDetectChangesRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            files: Vec::new(),
            base_ref: None,
        },
    );
    assert_eq!(
        output
            .renamed_files
            .first()
            .map(|rename| rename.from_path.as_str()),
        Some("src/old.ts")
    );
    assert_eq!(
        output
            .renamed_files
            .first()
            .map(|rename| rename.to_path.as_str()),
        Some("src/new.ts")
    );
}

#[test]
fn detect_changes_reports_deleted_files() {
    let snapshot = fixture_snapshot();
    let stored = vec![hash("src/deleted.ts", "aaa"), hash("src/kept.ts", "bbb")];
    let current = vec![hash("src/kept.ts", "bbb")];
    let output = detect_changes(
        &snapshot,
        &stored,
        &current,
        &GraphDetectChangesRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            files: Vec::new(),
            base_ref: None,
        },
    );

    assert_eq!(output.changed_files, Vec::<String>::new());
    assert_eq!(output.deleted_files, vec!["src/deleted.ts"]);
    assert!(output.renamed_files.is_empty());
}

#[test]
fn review_context_impacts_renamed_source_paths() {
    let snapshot = fixture_snapshot();
    let stored = vec![hash("src/models.ts", "aaa")];
    let current = vec![hash("src/models-renamed.ts", "aaa")];
    let output = review_context(
        &snapshot,
        &stored,
        &current,
        &GraphReviewContextRequest {
            request_id: None,
            repo: repo(),
            schema_version: 1,
            mode: GraphProviderMode::Required,
            files: Vec::new(),
            base_ref: None,
            max_depth: Some(3),
            limit: Some(100),
        },
    );

    assert_eq!(output.changed_files, vec!["src/models-renamed.ts"]);
    assert_eq!(output.deleted_files, vec!["src/models.ts"]);
    assert_eq!(
        output
            .renamed_files
            .first()
            .map(|rename| rename.from_path.as_str()),
        Some("src/models.ts")
    );
    assert!(output
        .impacted_files
        .contains(&"src/components/GreetingCard.tsx".to_string()));
    assert!(output
        .tests
        .contains(&"src/__tests__/greeting.test.ts".to_string()));
}

fn fixture_snapshot() -> StoreQueryOutput {
    StoreQueryOutput {
        metadata: GraphSnapshotMetadata {
            schema_version: 1,
            provider: "lattice-graph".to_string(),
            repo: repo(),
            generated_at: "2026-06-04T00:00:00.000Z".to_string(),
            freshness: GraphFreshness {
                generated_at: "2026-06-04T00:00:00.000Z".to_string(),
                age_ms: 0,
                max_age_ms: None,
                stale: false,
                reason: None,
            },
            node_kinds: vec![
                "File".to_string(),
                "Function".to_string(),
                "Test".to_string(),
            ],
            edge_kinds: vec![
                "CONTAINS".to_string(),
                "DEPENDS_ON".to_string(),
                "TESTED_BY".to_string(),
            ],
        },
        nodes: vec![
            node("file:src/models.ts", "File", Some("src/models.ts")),
            node(
                "file:src/components/GreetingCard.tsx",
                "File",
                Some("src/components/GreetingCard.tsx"),
            ),
            node(
                "file:src/__tests__/greeting.test.ts",
                "File",
                Some("src/__tests__/greeting.test.ts"),
            ),
            node("function:src/models.ts#formatGreeting", "Function", None),
            node(
                "test:src/__tests__/greeting.test.ts#renders greeting cards",
                "Test",
                None,
            ),
        ],
        edges: vec![
            edge(
                "CONTAINS",
                "file:src/models.ts",
                "function:src/models.ts#formatGreeting",
            ),
            edge(
                "DEPENDS_ON",
                "file:src/components/GreetingCard.tsx",
                "file:src/models.ts",
            ),
            edge(
                "DEPENDS_ON",
                "file:src/__tests__/greeting.test.ts",
                "file:src/components/GreetingCard.tsx",
            ),
            edge(
                "TESTED_BY",
                "function:src/models.ts#formatGreeting",
                "test:src/__tests__/greeting.test.ts#renders greeting cards",
            ),
        ],
        diagnostics: Vec::new(),
    }
}

fn cycle_snapshot() -> StoreQueryOutput {
    StoreQueryOutput {
        metadata: GraphSnapshotMetadata {
            schema_version: 1,
            provider: "lattice-graph".to_string(),
            repo: repo(),
            generated_at: "2026-06-04T00:00:00.000Z".to_string(),
            freshness: GraphFreshness {
                generated_at: "2026-06-04T00:00:00.000Z".to_string(),
                age_ms: 0,
                max_age_ms: None,
                stale: false,
                reason: None,
            },
            node_kinds: vec!["File".to_string()],
            edge_kinds: vec!["DEPENDS_ON".to_string()],
        },
        nodes: vec![
            node("file:src/c.ts", "File", Some("src/c.ts")),
            node("file:src/a.ts", "File", Some("src/a.ts")),
            node("file:src/b.ts", "File", Some("src/b.ts")),
        ],
        edges: vec![
            edge("DEPENDS_ON", "file:src/c.ts", "file:src/a.ts"),
            edge("DEPENDS_ON", "file:src/b.ts", "file:src/a.ts"),
            edge("DEPENDS_ON", "file:src/a.ts", "file:src/b.ts"),
        ],
        diagnostics: Vec::new(),
    }
}

fn python_test_snapshot() -> StoreQueryOutput {
    StoreQueryOutput {
        metadata: python_test_metadata(),
        nodes: python_test_nodes(),
        edges: python_test_edges(),
        diagnostics: Vec::new(),
    }
}

fn python_test_metadata() -> GraphSnapshotMetadata {
    GraphSnapshotMetadata {
        schema_version: 1,
        provider: "lattice-graph".to_string(),
        repo: repo(),
        generated_at: "2026-06-04T00:00:00.000Z".to_string(),
        freshness: GraphFreshness {
            generated_at: "2026-06-04T00:00:00.000Z".to_string(),
            age_ms: 0,
            max_age_ms: None,
            stale: false,
            reason: None,
        },
        node_kinds: vec![
            "File".to_string(),
            "Module".to_string(),
            "Class".to_string(),
            "Function".to_string(),
        ],
        edge_kinds: vec![
            "CONTAINS".to_string(),
            "IMPORTS_FROM".to_string(),
            "TESTED_BY".to_string(),
        ],
    }
}

fn python_test_nodes() -> Vec<GraphFactNode> {
    vec![
        node("file:src/pkg/models.py", "File", Some("src/pkg/models.py")),
        node(
            "module:src/pkg/models.py#src.pkg.models",
            "Module",
            Some("src/pkg/models.py"),
        ),
        node(
            "class:src/pkg/models.py#PublicModel",
            "Class",
            Some("src/pkg/models.py"),
        ),
        node(
            "function:src/pkg/models.py#make_model",
            "Function",
            Some("src/pkg/models.py"),
        ),
        node(
            "file:tests/test_models.py",
            "File",
            Some("tests/test_models.py"),
        ),
        node(
            "module:tests/test_models.py#tests.test_models",
            "Module",
            Some("tests/test_models.py"),
        ),
        node_with_attributes(
            "function:tests/test_models.py#test_make_model",
            "Function",
            Some("tests/test_models.py"),
            json!({"isTest": true}),
        ),
    ]
}

fn python_test_edges() -> Vec<GraphFactEdge> {
    vec![
        edge(
            "CONTAINS",
            "file:src/pkg/models.py",
            "module:src/pkg/models.py#src.pkg.models",
        ),
        edge(
            "CONTAINS",
            "module:src/pkg/models.py#src.pkg.models",
            "class:src/pkg/models.py#PublicModel",
        ),
        edge(
            "CONTAINS",
            "module:src/pkg/models.py#src.pkg.models",
            "function:src/pkg/models.py#make_model",
        ),
        edge(
            "CONTAINS",
            "file:tests/test_models.py",
            "module:tests/test_models.py#tests.test_models",
        ),
        edge(
            "CONTAINS",
            "module:tests/test_models.py#tests.test_models",
            "function:tests/test_models.py#test_make_model",
        ),
        edge(
            "IMPORTS_FROM",
            "file:tests/test_models.py",
            "file:src/pkg/models.py",
        ),
        edge(
            "TESTED_BY",
            "class:src/pkg/models.py#PublicModel",
            "function:tests/test_models.py#test_make_model",
        ),
        edge(
            "TESTED_BY",
            "function:src/pkg/models.py#make_model",
            "function:tests/test_models.py#test_make_model",
        ),
    ]
}

fn repo() -> RepoIdentity {
    RepoIdentity {
        repo_id: Some("fixture".to_string()),
        repo_root: None,
        remote_url: None,
        commit_sha: None,
    }
}

fn node(id: &str, kind: &str, path: Option<&str>) -> GraphFactNode {
    GraphFactNode {
        id: id.to_string(),
        kind: kind.to_string(),
        path: path.map(str::to_string),
        name: None,
        attributes: None,
    }
}

fn node_with_attributes(
    id: &str,
    kind: &str,
    path: Option<&str>,
    attributes: serde_json::Value,
) -> GraphFactNode {
    GraphFactNode {
        attributes: Some(attributes),
        ..node(id, kind, path)
    }
}

fn edge(kind: &str, from: &str, to: &str) -> GraphFactEdge {
    GraphFactEdge {
        id: Some(format!("{kind}:{from}->{to}")),
        kind: kind.to_string(),
        from: from.to_string(),
        to: to.to_string(),
        attributes: None,
    }
}

fn hash(path: &str, sha: &str) -> SourceFileHash {
    SourceFileHash {
        relative_path: path.to_string(),
        absolute_path: format!("/repo/{path}"),
        language: "typescript".to_string(),
        sha256: sha.to_string(),
    }
}

fn assert_limited_without_dangling(nodes: &[GraphFactNode], edges: &[GraphFactEdge], limit: usize) {
    assert!(nodes.len() <= limit);
    let node_ids = nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    for edge in edges {
        assert!(node_ids.contains(edge.from.as_str()));
        assert!(node_ids.contains(edge.to.as_str()));
    }
}
