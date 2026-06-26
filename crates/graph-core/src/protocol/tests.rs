use super::*;
use crate::GRAPH_PROVIDER_NAME;
use crate::GRAPH_SCHEMA_VERSION;
use serde_json::{json, Value};
use std::fs;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn repo() -> RepoIdentity {
    RepoIdentity {
        repo_id: Some("lattice".to_string()),
        repo_root: None,
        remote_url: None,
        commit_sha: None,
    }
}

fn query_request() -> GraphFactQueryRequest {
    GraphFactQueryRequest {
        request_id: Some("query-1".to_string()),
        repo: repo(),
        schema_version: GRAPH_SCHEMA_VERSION,
        mode: GraphProviderMode::Required,
        selector: GraphFactQuerySelector {
            kind: GraphFactQueryKind::Nodes,
            node_kinds: vec!["repo".to_string()],
            edge_kinds: vec![],
            ids: vec![],
            text: None,
            limit: Some(1),
        },
    }
}

#[test]
fn daemon_request_round_trips() -> TestResult {
    let request = GraphDaemonRequest {
        protocol: "lattice.graph.daemon".to_string(),
        request_id: "status-1".to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        operation: GraphDaemonOperation::Status,
        repo: repo(),
        query: None,
        named_query: None,
        impact: None,
        review_context: None,
        changes: None,
        search: None,
        base_ref: None,
        paths: Vec::new(),
        watch_paths: Vec::new(),
        poll_interval_ms: None,
        idle_timeout_ms: Some(0),
        once: None,
        max_wal_bytes: None,
    };

    let encoded = serde_json::to_string(&request)?;
    let decoded: GraphDaemonRequest = serde_json::from_str(&encoded)?;
    assert_eq!(decoded, request);
    assert!(encoded.contains("\"protocol\":\"lattice.graph.daemon\""));
    assert!(encoded.contains("\"schemaVersion\":1"));
    assert!(encoded.contains("\"idleTimeoutMs\":0"));
    Ok(())
}

#[test]
fn query_result_round_trips_without_graph_data_on_failure() -> TestResult {
    let status = GraphProviderStatus::DaemonUnavailable {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        message: Some("daemon unavailable".to_string()),
        failure: ProviderFailure {
            category: ProviderFailureCategory::DaemonUnavailable,
            message: "daemon unavailable".to_string(),
            retryable: Some(true),
            cause: None,
        },
    };
    let result = GraphFactQueryResult::Failure {
        request_id: Some("query-1".to_string()),
        status: Box::new(status),
    };

    let value = serde_json::to_value(&result)?;
    assert!(value.get("status").is_some());
    assert!(value.get("metadata").is_none());
    assert!(value.get("nodes").is_none());
    assert!(value.get("edges").is_none());
    let decoded: GraphFactQueryResult = serde_json::from_value(value)?;
    assert_eq!(decoded, result);
    Ok(())
}

#[test]
fn status_response_round_trips_with_handshake() -> TestResult {
    let status = available_status(repo(), "2026-06-04T00:00:00.000Z".to_string());
    let response = GraphDaemonResponse {
        protocol: "lattice.graph.daemon".to_string(),
        request_id: "status-1".to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        status,
        result: None,
        named_query: None,
        impact: None,
        review_context: None,
        changes: None,
        search: None,
        pipeline: None,
        lifecycle: None,
    };

    let value = serde_json::to_value(&response)?;
    assert_json_eq(&value, "/status/state", json!("available"));
    assert_json_eq(
        &value,
        "/status/handshake/artifactName",
        json!("lattice-graph-core"),
    );
    let node_kinds = value
        .pointer("/status/handshake/nodeKinds")
        .and_then(|value| value.as_array())
        .ok_or_else(|| std::io::Error::other("missing handshake nodeKinds"))?;
    for kind in ["Module", "Struct", "Trait", "Method"] {
        assert!(node_kinds.iter().any(|value| value == kind), "{kind}");
    }
    let edge_kinds = value
        .pointer("/status/handshake/edgeKinds")
        .and_then(|value| value.as_array())
        .ok_or_else(|| std::io::Error::other("missing handshake edgeKinds"))?;
    for kind in ["IMPLEMENTS", "DEPENDS_ON", "INHERITS"] {
        assert!(edge_kinds.iter().any(|value| value == kind), "{kind}");
    }
    let decoded: GraphDaemonResponse = serde_json::from_value(value)?;
    assert_eq!(decoded, response);
    Ok(())
}

#[test]
fn schema_defines_daemon_and_query_envelopes() -> TestResult {
    let schema =
        fs::read_to_string("../../packages/contracts/schemas/lattice-contracts.schema.json")?;
    for token in [
        "GraphDaemonRequest",
        "GraphDaemonResponse",
        "GraphFactQueryRequest",
        "GraphFactQueryResult",
        "GraphProviderStatus",
        "GraphProviderCapabilityHandshake",
    ] {
        assert!(schema.contains(token), "{token}");
    }
    Ok(())
}

#[test]
fn protocol_excludes_edit_validation_and_policy_endpoints() -> TestResult {
    let source = fs::read_to_string("src/protocol.rs")?;
    let forbidden = [
        ["C", "ix"].join(""),
        ["R", "ox"].join(""),
        ["Check", "Endpoint"].join(""),
        ["Validate", "Endpoint"].join(""),
        ["Edit", "Endpoint"].join(""),
    ];
    for token in forbidden {
        assert!(!source.contains(&token), "{token}");
    }
    assert!(query_request().selector.kind == GraphFactQueryKind::Nodes);
    Ok(())
}

fn assert_json_eq(value: &Value, pointer: &str, expected: Value) {
    assert_eq!(value.pointer(pointer), Some(&expected), "{pointer}");
}
