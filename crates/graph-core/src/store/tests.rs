use super::*;
use crate::extraction::{extract_sources, ExtractionOptions};
use crate::protocol::{GraphFactQueryKind, GraphFactQuerySelector, GraphPipelineSummary};
use crate::GRAPH_SCHEMA_VERSION;
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

mod rust_fact_columns;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn store_creates_schema_and_indexes() -> TestResult {
    let repo = temp_repo()?;
    let store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;

    assert_eq!(store_user_version(&store.connection)?, 1);
    for table in ["metadata", "file_hashes", "nodes", "edges"] {
        require_table(&store.connection, table)?;
    }
    for index in STORE_INDEX_NAMES {
        require_index(&store.connection, index)?;
    }
    Ok(())
}

#[test]
fn store_configures_wal_and_checkpoint_budget() -> TestResult {
    let repo = temp_repo()?;
    let store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;

    let journal_mode: String = store
        .connection
        .query_row("pragma journal_mode", [], |row| row.get(0))?;
    let wal_autocheckpoint: u32 =
        store
            .connection
            .query_row("pragma wal_autocheckpoint", [], |row| row.get(0))?;

    assert_eq!(journal_mode, "wal");
    assert_eq!(wal_autocheckpoint, WAL_AUTOCHECKPOINT_PAGES);
    Ok(())
}

#[test]
fn corrupt_metadata_json_fails_fast_on_open() -> TestResult {
    let repo = temp_repo_with_source("export function a() { return 1; }")?;
    {
        let mut store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
        store.refresh_full_snapshot(snapshot(repo.path()))?;
        let corrupt_json = char::from(123).to_string();
        store.connection.execute(
            "update metadata set value = ?1 where key = 'lattice_snapshot_metadata'",
            params![corrupt_json],
        )?;
    }

    let error = open_store_error(repo.path())?;
    assert!(matches!(error, StoreError::SchemaMismatch { .. }));
    Ok(())
}

#[test]
fn snapshot_metadata_schema_mismatch_fails_fast_on_open() -> TestResult {
    let repo = temp_repo_with_source("export function a() { return 1; }")?;
    {
        let mut store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
        store.refresh_full_snapshot(snapshot(repo.path()))?;
        let mut metadata = store
            .read_metadata()?
            .ok_or_else(|| std::io::Error::other("missing snapshot metadata"))?;
        metadata.schema_version = GRAPH_SCHEMA_VERSION + 1;
        let metadata_json = serde_json::to_string(&metadata)?;
        store.connection.execute(
            "update metadata set value = ?1 where key = 'lattice_snapshot_metadata'",
            params![metadata_json],
        )?;
    }

    let error = open_store_error(repo.path())?;
    assert!(matches!(error, StoreError::SchemaMismatch { .. }));
    Ok(())
}

#[test]
fn partial_migration_marker_fails_fast_on_open() -> TestResult {
    let repo = temp_repo()?;
    {
        let store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
        store.connection.execute(
            "update lattice_migrations set state = 'in_progress' where version = 1",
            [],
        )?;
    }

    let error = open_store_error(repo.path())?;
    assert!(matches!(error, StoreError::SchemaMismatch { .. }));
    Ok(())
}

#[test]
fn missing_required_index_fails_fast_on_open() -> TestResult {
    let repo = temp_repo()?;
    {
        let store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
        store.connection.execute("drop index idx_nodes_kind", [])?;
    }

    let error = open_store_error(repo.path())?;
    assert!(matches!(error, StoreError::SchemaMismatch { .. }));
    Ok(())
}

#[test]
fn invalid_edge_snapshot_rolls_back_previous_snapshot() -> TestResult {
    let repo = temp_repo_with_source("export function a() { return 1; }")?;
    let mut store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
    store.refresh_full_snapshot(snapshot(repo.path()))?;
    let before = store.query(&all_nodes_selector())?.nodes.len();

    let mut invalid = snapshot(repo.path());
    let source_id = invalid
        .nodes
        .first()
        .ok_or_else(|| std::io::Error::other("snapshot has no nodes"))?
        .id
        .clone();
    invalid.edges.push(GraphFactEdge {
        id: Some("edge:CALLS:missing".to_string()),
        kind: "CALLS".to_string(),
        from: source_id,
        to: "function:missing.ts#missing".to_string(),
        attributes: None,
    });
    let error = match store.refresh_full_snapshot(invalid) {
        Ok(()) => return Err(std::io::Error::other("invalid edge was accepted").into()),
        Err(error) => error,
    };
    assert!(matches!(error, StoreError::InvalidSnapshot(_)));
    let after = store.query(&all_nodes_selector())?.nodes.len();
    assert_eq!(after, before);
    Ok(())
}

#[test]
fn freshness_becomes_stale_after_file_hash_change() -> TestResult {
    let repo = temp_repo_with_source("export function a() { return 1; }")?;
    let mut store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
    store.refresh_full_snapshot(snapshot(repo.path()))?;
    assert!(matches!(
        store.freshness_state(None)?,
        FreshnessState::Available { .. }
    ));

    fs::write(
        repo.path().join("src/a.ts"),
        "export function a() { return 2; }",
    )?;

    assert!(matches!(
        store.freshness_state(None)?,
        FreshnessState::Stale { .. }
    ));
    Ok(())
}

#[test]
fn available_status_reports_snapshot_age_without_max_age_policy() -> TestResult {
    let repo = temp_repo_with_source("export function a() { return 1; }")?;
    let mut old_snapshot = snapshot(repo.path());
    old_snapshot.metadata.generated_at = EXTRACTION_GENERATED_AT.to_string();
    old_snapshot.metadata.freshness.generated_at = EXTRACTION_GENERATED_AT.to_string();
    old_snapshot.metadata.freshness.age_ms = 0;

    let mut store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
    store.refresh_full_snapshot(old_snapshot)?;

    match store.status(None)? {
        GraphProviderStatus::Available { freshness, .. } => {
            assert!(
                freshness.age_ms > 0,
                "available snapshots must report real age"
            );
            assert_eq!(freshness.generated_at, EXTRACTION_GENERATED_AT);
            assert!(!freshness.stale);
        }
        other => return Err(std::io::Error::other(format!("unexpected status: {other:?}")).into()),
    }
    Ok(())
}

#[test]
fn status_uses_pipeline_completion_for_legacy_fixed_metadata() -> TestResult {
    let repo = temp_repo_with_source("export function a() { return 1; }")?;
    let mut legacy_snapshot = snapshot(repo.path());
    legacy_snapshot.metadata.generated_at = EXTRACTION_GENERATED_AT.to_string();
    legacy_snapshot.metadata.freshness.generated_at = EXTRACTION_GENERATED_AT.to_string();

    let mut store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
    store.refresh_full_snapshot(legacy_snapshot)?;
    let completed_at = now_rfc3339();
    store.record_pipeline_summary(&GraphPipelineSummary {
        operation: "build".to_string(),
        repo: repo_identity(repo.path()),
        store_path: Some(display_path(&store.paths().db_path)),
        started_at: completed_at.clone(),
        completed_at: completed_at.clone(),
        duration_ms: 1,
        discovered_files: 1,
        parsed_files: 1,
        changed_files: vec!["src/a.ts".to_string()],
        deleted_files: Vec::new(),
        unchanged_files: 0,
        full_rebuild_required: true,
        diagnostics_count: 0,
        phase_timings: Vec::new(),
        base_ref: None,
        watch_paths: Vec::new(),
        wal_checkpoint: None,
    })?;

    match store.status(None)? {
        GraphProviderStatus::Available { freshness, .. } => {
            assert_eq!(freshness.generated_at, completed_at);
            assert_ne!(freshness.generated_at, EXTRACTION_GENERATED_AT);
            assert!(!freshness.stale);
        }
        other => return Err(std::io::Error::other(format!("unexpected status: {other:?}")).into()),
    }
    Ok(())
}

#[test]
fn relative_repo_root_stores_absolute_paths() -> TestResult {
    let repo = relative_temp_repo_with_source("export function a() { return 1; }")?;
    let relative_root = PathBuf::from(
        repo.path()
            .file_name()
            .ok_or_else(|| std::io::Error::other("relative repo missing filename"))?,
    );
    let mut store = GraphStore::open(StorePaths::for_repo_root(relative_root))?;

    store.refresh_full_snapshot(snapshot(store.paths().repo_root.as_path()))?;

    assert!(store.paths().repo_root.is_absolute());
    assert!(store.paths().db_path.is_absolute());
    let file_path: String = store.connection.query_row(
        "select file_path from nodes where file_path is not null order by file_path limit 1",
        [],
        |row| row.get(0),
    )?;
    assert!(Path::new(&file_path).is_absolute(), "{file_path}");
    Ok(())
}

#[test]
fn direct_lattice_sqlite_queries_work_over_wave1_facts() -> TestResult {
    let fixture = copied_wave1_fixture()?;
    let mut store = GraphStore::open(StorePaths::for_repo_root(fixture.path()))?;
    store.refresh_full_snapshot(snapshot(fixture.path()))?;
    assert_direct_node_counts(&store.connection)?;
    assert_direct_export_flags(&store.connection)?;
    assert_direct_edge_counts(&store)?;
    assert_direct_metadata(&store.connection)?;
    Ok(())
}

fn assert_direct_node_counts(connection: &Connection) -> TestResult {
    let node_counts = grouped_counts(
        connection,
        "select kind, count(*) from nodes group by kind order by kind",
    )?;
    assert_eq!(
        node_counts,
        vec![
            ("Class".to_string(), 5),
            ("File".to_string(), 9),
            ("Function".to_string(), 9),
            ("Test".to_string(), 1),
            ("Type".to_string(), 2),
            ("Variable".to_string(), 5),
        ]
    );
    let found: String = connection.query_row(
        "select qualified_name from nodes where name like ?1 order by kind, qualified_name limit ?2",
        params!["%GreetingCard%", 1],
        |row| row.get(0),
    )?;
    assert_eq!(
        found,
        "function:src/components/GreetingCard.tsx#GreetingCard"
    );
    Ok(())
}

fn assert_direct_export_flags(connection: &Connection) -> TestResult {
    let exported_add: u32 = connection.query_row(
        "select is_exported from nodes where id = ?1",
        params!["function:src/math.js#add"],
        |row| row.get(0),
    )?;
    assert_eq!(exported_add, 1);
    let internal_factor: u32 = connection.query_row(
        "select is_exported from nodes where id = ?1",
        params!["variable:src/math.js#internalFactor"],
        |row| row.get(0),
    )?;
    assert_eq!(internal_factor, 0);
    let file_export_flag: u32 = connection.query_row(
        "select is_exported from nodes where id = ?1",
        params!["file:src/math.js"],
        |row| row.get(0),
    )?;
    assert_eq!(file_export_flag, 0);
    Ok(())
}

fn assert_direct_edge_counts(store: &GraphStore) -> TestResult {
    let edge_counts = grouped_counts(
        &store.connection,
        "select kind, count(*) from edges group by kind order by kind",
    )?;
    assert!(edge_counts.contains(&("CALLS".to_string(), 13)));
    assert!(edge_counts.contains(&("CONTAINS".to_string(), 22)));

    let impact_file = display_path(&store.paths().repo_root.join("src/models.ts"));
    let impact_count: u32 = store.connection.query_row(
        "select count(*) from edges where file_path = ?1",
        params![impact_file],
        |row| row.get(0),
    )?;
    assert!(impact_count > 0);
    Ok(())
}

fn assert_direct_metadata(connection: &Connection) -> TestResult {
    let freshness = connection
        .prepare("select key, value from metadata where key in ('schema_version', 'last_updated', 'last_build_type') order by key")?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .and_then(Iterator::collect::<Result<std::collections::BTreeMap<_, _>, _>>)?;
    assert_eq!(
        freshness.get("last_build_type").map(String::as_str),
        Some("full")
    );
    assert_eq!(
        freshness.get("schema_version").map(String::as_str),
        Some("6")
    );
    let last_updated = freshness
        .get("last_updated")
        .ok_or_else(|| std::io::Error::other("missing last_updated"))?;
    assert_ne!(last_updated, EXTRACTION_GENERATED_AT);
    OffsetDateTime::parse(last_updated, &Rfc3339)?;
    Ok(())
}

fn snapshot(repo_root: &Path) -> StoreSnapshot {
    let extraction = extract_sources(ExtractionOptions::new(repo_root));
    assert!(
        !extraction
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity
                == crate::protocol::GraphExtractionDiagnosticSeverity::Error),
        "{:?}",
        extraction.diagnostics
    );
    StoreSnapshot {
        metadata: extraction.metadata,
        nodes: extraction.nodes,
        edges: extraction.edges,
        diagnostics: extraction.diagnostics,
        file_hashes: extraction.file_hashes,
        file_facts: extraction.file_facts,
    }
}

fn all_nodes_selector() -> GraphFactQuerySelector {
    GraphFactQuerySelector {
        kind: GraphFactQueryKind::Nodes,
        node_kinds: Vec::new(),
        edge_kinds: Vec::new(),
        ids: Vec::new(),
        text: None,
        limit: None,
    }
}

fn grouped_counts(connection: &Connection, sql: &str) -> rusqlite::Result<Vec<(String, u32)>> {
    connection
        .prepare(sql)?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()
}

fn temp_repo() -> Result<TempDir, std::io::Error> {
    tempfile::tempdir()
}

fn temp_repo_with_source(source: &str) -> Result<TempDir, std::io::Error> {
    let repo = temp_repo()?;
    fs::create_dir_all(repo.path().join("src"))?;
    fs::write(
        repo.path().join("tsconfig.json"),
        r#"{"compilerOptions":{"baseUrl":"."}}"#,
    )?;
    fs::write(repo.path().join("src/a.ts"), source)?;
    Ok(repo)
}

fn relative_temp_repo_with_source(source: &str) -> Result<TempDir, std::io::Error> {
    let repo = tempfile::Builder::new()
        .prefix("lattice-relative-store-")
        .tempdir_in(std::env::current_dir()?)?;
    fs::create_dir_all(repo.path().join("src"))?;
    fs::write(
        repo.path().join("tsconfig.json"),
        r#"{"compilerOptions":{"baseUrl":"."}}"#,
    )?;
    fs::write(repo.path().join("src/a.ts"), source)?;
    Ok(repo)
}

fn copied_wave1_fixture() -> Result<TempDir, std::io::Error> {
    let destination = temp_repo()?;
    copy_dir(&wave1_fixture_root()?, destination.path())?;
    Ok(destination)
}

fn wave1_fixture_root() -> Result<PathBuf, std::io::Error> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/fixtures/source-extraction/wave1")
        .canonicalize()
}

fn copy_dir(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_name() == ".lattice" {
            continue;
        }
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn open_store_error(repo: &Path) -> Result<StoreError, std::io::Error> {
    match GraphStore::open(StorePaths::for_repo_root(repo)) {
        Ok(_) => Err(std::io::Error::other("store open unexpectedly succeeded")),
        Err(error) => Ok(error),
    }
}
