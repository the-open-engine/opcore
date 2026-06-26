use super::*;
use crate::protocol::{
    GraphFactQueryKind, GraphFactQueryRequest, GraphFactQuerySelector, GraphProviderMode,
    GraphSearchRequest, RepoIdentity,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn repo() -> RepoIdentity {
    RepoIdentity {
        repo_id: Some("lattice".to_string()),
        repo_root: None,
        remote_url: None,
        commit_sha: None,
    }
}

fn fixture_repo(repo_root: &Path) -> Result<RepoIdentity, std::io::Error> {
    Ok(RepoIdentity {
        repo_id: None,
        repo_root: Some(repo_root.canonicalize()?.to_string_lossy().to_string()),
        remote_url: None,
        commit_sha: None,
    })
}

fn status_request() -> Result<GraphDaemonRequest, serde_json::Error> {
    serde_json::from_value(json!({
        "protocol": "lattice.graph.daemon",
        "requestId": "status-1",
        "schemaVersion": GRAPH_SCHEMA_VERSION,
        "operation": "status",
        "repo": repo(),
        "paths": [],
        "watchPaths": []
    }))
}

fn query_request(repo_root: &Path) -> Result<GraphDaemonRequest, std::io::Error> {
    let repo = fixture_repo(repo_root)?;
    let mut request = status_request().map_err(std::io::Error::other)?;
    request.request_id = "query-1".to_string();
    request.operation = GraphDaemonOperation::Query;
    request.repo = repo.clone();
    request.query = Some(GraphFactQueryRequest {
        request_id: Some("query-1".to_string()),
        repo,
        schema_version: GRAPH_SCHEMA_VERSION,
        mode: GraphProviderMode::Required,
        selector: GraphFactQuerySelector {
            kind: GraphFactQueryKind::Nodes,
            node_kinds: Vec::new(),
            edge_kinds: Vec::new(),
            ids: Vec::new(),
            text: None,
            limit: Some(1),
        },
    });
    Ok(request)
}

#[test]
fn status_handshake_reports_capabilities() -> TestResult {
    let response = handle_request(status_request()?);

    let value = serde_json::to_value(response)?;
    assert_json_eq(&value, "/protocol", json!("lattice.graph.daemon"));
    assert_json_eq(&value, "/status/provider", json!("lattice-graph"));
    assert_json_eq(
        &value,
        "/status/handshake/supportedOperations/0",
        json!("build"),
    );
    assert_json_eq(&value, "/status/handshake/nodeKinds/0", json!("repo"));
    let node_kinds = value
        .pointer("/status/handshake/nodeKinds")
        .and_then(Value::as_array)
        .ok_or_else(|| std::io::Error::other("missing handshake nodeKinds"))?;
    for kind in [
        "repo", "File", "Function", "Module", "Struct", "Trait", "Method",
    ] {
        assert!(node_kinds.iter().any(|value| value == kind), "{kind}");
    }
    assert_json_eq(
        &value,
        "/status/handshake/artifact/artifactName",
        json!("lattice-graph-core"),
    );
    Ok(())
}

#[test]
fn query_returns_extracted_graph_result() -> TestResult {
    let fixture = copied_wave1_fixture()?;
    let mut build = status_request()?;
    build.operation = GraphDaemonOperation::Build;
    build.repo = fixture_repo(fixture.path())?;
    assert!(matches!(
        handle_request(build).status,
        GraphProviderStatus::Available { .. }
    ));
    let response = handle_request(query_request(fixture.path())?);

    let value = serde_json::to_value(response)?;
    let nodes = json_array(&value, "/result/nodes")?;
    assert!(!nodes.is_empty());
    let node_ids = nodes
        .iter()
        .filter_map(|node| node.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    for edge in json_array(&value, "/result/edges")? {
        assert!(edge
            .get("from")
            .and_then(Value::as_str)
            .is_some_and(|from| node_ids.contains(&from)));
        assert!(edge
            .get("to")
            .and_then(Value::as_str)
            .is_some_and(|to| node_ids.contains(&to)));
    }
    assert_json_eq(&value, "/result/metadata/provider", json!("lattice-graph"));
    Ok(())
}

#[test]
fn invalid_protocol_and_schema_do_not_report_available() -> TestResult {
    let mut request = status_request()?;
    request.protocol = "bad.protocol".to_string();
    request.schema_version = 99;

    let value = serde_json::to_value(handle_request(request))?;
    assert_json_eq(&value, "/status/state", json!("schema_mismatch"));
    assert_json_eq(
        &value,
        "/status/expectedSchemaVersion",
        json!(GRAPH_SCHEMA_VERSION),
    );
    assert_json_eq(&value, "/status/actualSchemaVersion", json!(99));
    assert!(value.pointer("/status/handshake").is_none());
    assert!(value.get("result").is_none());
    Ok(())
}

#[test]
fn query_without_query_returns_failure_without_graph_data() -> TestResult {
    let fixture = copied_wave1_fixture()?;
    let mut request = query_request(fixture.path())?;
    request.query = None;

    let value = serde_json::to_value(handle_request(request))?;
    assert_json_eq(&value, "/status/state", json!("schema_mismatch"));
    assert_json_eq(&value, "/result/status/state", json!("schema_mismatch"));
    assert!(value.pointer("/result/metadata").is_none());
    assert!(value.pointer("/result/nodes").is_none());
    assert!(value.pointer("/result/edges").is_none());
    Ok(())
}

#[test]
fn search_rejects_non_repo_relative_context_files() -> TestResult {
    let fixture = copied_wave1_fixture()?;
    let repo = fixture_repo(fixture.path())?;
    let mut build = status_request()?;
    build.operation = GraphDaemonOperation::Build;
    build.repo = repo.clone();
    assert!(matches!(
        handle_request(build).status,
        GraphProviderStatus::Available { .. }
    ));

    let mut request = query_request(fixture.path())?;
    request.query = None;
    request.search = Some(GraphSearchRequest {
        request_id: Some("search-1".to_string()),
        repo,
        schema_version: GRAPH_SCHEMA_VERSION,
        mode: GraphProviderMode::Required,
        query: "Greeting".to_string(),
        limit: Some(5),
        files: vec!["/tmp/not-repo-relative.ts".to_string()],
    });

    let value = serde_json::to_value(handle_request(request))?;
    assert_json_eq(&value, "/status/state", json!("schema_mismatch"));
    assert_json_eq(&value, "/search/status/state", json!("schema_mismatch"));
    assert!(value.pointer("/search/results").is_none());
    assert!(value.pointer("/search/searchMode").is_none());
    Ok(())
}

#[test]
fn status_for_missing_store_is_read_only() -> TestResult {
    let repo = tempfile::tempdir()?;
    fs::write(repo.path().join("a.ts"), "export const a = 1;\n")?;
    let request = GraphDaemonRequest {
        repo: fixture_repo(repo.path())?,
        ..status_request()?
    };

    let value = serde_json::to_value(handle_request(request))?;

    assert_json_eq(&value, "/status/state", json!("stale"));
    assert_json_eq(
        &value,
        "/status/message",
        json!("graph store snapshot is missing"),
    );
    assert!(!repo.path().join(".lattice").exists());
    assert!(!repo.path().join(".lattice/graph/graph.db").exists());
    Ok(())
}

fn copied_wave1_fixture() -> Result<TempDir, std::io::Error> {
    let destination = tempfile::tempdir()?;
    copy_dir(&wave1_fixture_root()?, destination.path())?;
    Ok(destination)
}

fn wave1_fixture_root() -> Result<PathBuf, std::io::Error> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/fixtures/source-extraction/wave1")
        .canonicalize()
}

fn copy_dir(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
    while let Some((from_dir, to_dir)) = pending.pop() {
        fs::create_dir_all(&to_dir)?;
        for entry in fs::read_dir(&from_dir)? {
            let entry = entry?;
            if entry.file_name() == ".lattice" {
                continue;
            }
            let from_path = entry.path();
            let to_path = to_dir.join(entry.file_name());
            if from_path.is_dir() {
                pending.push((from_path, to_path));
            } else {
                fs::copy(from_path, to_path)?;
            }
        }
    }
    Ok(())
}

fn assert_json_eq(value: &Value, pointer: &str, expected: Value) {
    assert_eq!(value.pointer(pointer), Some(&expected), "{pointer}");
}

fn json_array<'a>(value: &'a Value, pointer: &str) -> Result<&'a Vec<Value>, std::io::Error> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .ok_or_else(|| std::io::Error::other(format!("missing JSON array {pointer}")))
}
