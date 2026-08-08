use super::*;

#[cfg(test)]
pub(super) fn fixture_snapshot() -> StoreQueryOutput {
    StoreQueryOutput {
        metadata: GraphSnapshotMetadata {
            schema_version: 1,
            provider: "opcore-graph".to_string(),
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

#[cfg(test)]
pub(super) fn inheritance_snapshot() -> StoreQueryOutput {
    StoreQueryOutput {
        metadata: GraphSnapshotMetadata {
            schema_version: 1,
            provider: "opcore-graph".to_string(),
            repo: repo(),
            generated_at: "2026-06-04T00:00:00.000Z".to_string(),
            freshness: GraphFreshness {
                generated_at: "2026-06-04T00:00:00.000Z".to_string(),
                age_ms: 0,
                max_age_ms: None,
                stale: false,
                reason: None,
            },
            node_kinds: vec!["Class".to_string()],
            edge_kinds: vec!["INHERITS".to_string()],
        },
        nodes: vec![
            node(
                "class:src/models.ts#BaseModel",
                "Class",
                Some("src/models.ts"),
            ),
            node(
                "class:src/models.ts#DirectModel",
                "Class",
                Some("src/models.ts"),
            ),
            node(
                "class:src/models.ts#IndirectModel",
                "Class",
                Some("src/models.ts"),
            ),
            node(
                "class:src/other.ts#UnrelatedModel",
                "Class",
                Some("src/other.ts"),
            ),
        ],
        edges: vec![
            edge(
                "INHERITS",
                "class:src/models.ts#DirectModel",
                "class:src/models.ts#BaseModel",
            ),
            edge(
                "INHERITS",
                "class:src/models.ts#IndirectModel",
                "class:src/models.ts#DirectModel",
            ),
        ],
        diagnostics: Vec::new(),
    }
}

#[cfg(test)]
pub(super) fn cycle_snapshot() -> StoreQueryOutput {
    StoreQueryOutput {
        metadata: GraphSnapshotMetadata {
            schema_version: 1,
            provider: "opcore-graph".to_string(),
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

#[cfg(test)]
pub(super) fn python_test_snapshot() -> StoreQueryOutput {
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
        provider: "opcore-graph".to_string(),
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

#[cfg(test)]
pub(super) fn repo() -> RepoIdentity {
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

#[cfg(test)]
pub(super) fn edge(kind: &str, from: &str, to: &str) -> GraphFactEdge {
    GraphFactEdge {
        id: Some(format!("{kind}:{from}->{to}")),
        kind: kind.to_string(),
        from: from.to_string(),
        to: to.to_string(),
        attributes: None,
    }
}

#[cfg(test)]
pub(super) fn hash(path: &str, sha: &str) -> SourceFileHash {
    SourceFileHash {
        relative_path: path.to_string(),
        absolute_path: format!("/repo/{path}"),
        language: "typescript".to_string(),
        sha256: sha.to_string(),
    }
}

#[cfg(test)]
pub(super) fn assert_limited_without_dangling(
    nodes: &[GraphFactNode],
    edges: &[GraphFactEdge],
    limit: usize,
) {
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
