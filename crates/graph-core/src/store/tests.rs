use super::*;
use crate::extraction::{extract_sources, ExtractionOptions};
use crate::protocol::{GraphFactQueryKind, GraphFactQuerySelector};
use crate::GRAPH_SCHEMA_VERSION;
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

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
fn store_round_trips_rust_fact_columns() -> TestResult {
    let repo = temp_repo()?;
    let store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
    let rust_file = store.paths().repo_root.join("src/lib.rs");
    let rust_file_path = display_path(&rust_file);

    assert_eq!(store_user_version(&store.connection)?, 1);
    insert_rust_file_hash(&store.connection, &rust_file_path)?;
    insert_rust_node(&store.connection, rust_struct_node(&rust_file_path))?;
    insert_rust_node(&store.connection, rust_test_node(&rust_file_path))?;
    insert_rust_edges(&store.connection, &rust_file_path)?;
    insert_rust_fts_row(&store.connection)?;
    assert_rust_file_hash_language(&store.connection)?;
    assert_rust_node_columns(&store.connection)?;
    assert_rust_test_flag(&store.connection)?;
    assert_rust_edge_kinds(&store.connection)?;
    assert_rust_fts_hit(&store.connection)?;
    Ok(())
}

const RUST_FILE_RELATIVE_PATH: &str = "src/lib.rs";
const RUST_FILE_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct RustNodeFixture<'a> {
    id: &'a str,
    kind: &'a str,
    name: &'a str,
    qualified_name: &'a str,
    file_path: &'a str,
    line_start: u32,
    line_end: u32,
    parent_name: &'a str,
    params: &'a str,
    return_type: &'a str,
    modifiers: &'a str,
    is_test: u32,
    is_exported: u32,
    signature: &'a str,
    attributes_json: &'a str,
    canonical_json: &'a str,
}

fn insert_rust_file_hash(connection: &Connection, absolute_path: &str) -> TestResult {
    connection.execute(
        "insert into file_hashes(relative_path, absolute_path, language, sha256, updated_at) values (?1, ?2, ?3, ?4, ?5)",
        params![
            RUST_FILE_RELATIVE_PATH,
            absolute_path,
            "rust",
            RUST_FILE_HASH,
            EXTRACTION_GENERATED_AT
        ],
    )?;
    Ok(())
}

fn rust_struct_node(file_path: &str) -> RustNodeFixture<'_> {
    RustNodeFixture {
        id: "struct:src/lib.rs#Widget",
        kind: "Struct",
        name: "Widget",
        qualified_name: "crate::Widget",
        file_path,
        line_start: 3,
        line_end: 7,
        parent_name: "crate",
        params: "name: String",
        return_type: "Self",
        modifiers: "pub,derive(Debug)",
        is_test: 0,
        is_exported: 1,
        signature: "pub struct Widget { name: String }",
        attributes_json: r#"{"exported":true}"#,
        canonical_json: r#"{"id":"struct:src/lib.rs#Widget","kind":"Struct"}"#,
    }
}

fn rust_test_node(file_path: &str) -> RustNodeFixture<'_> {
    RustNodeFixture {
        id: "test:src/lib.rs#widget_smoke",
        kind: "Test",
        name: "widget_smoke",
        qualified_name: "crate::tests::widget_smoke",
        file_path,
        line_start: 12,
        line_end: 15,
        parent_name: "crate::tests",
        params: "",
        return_type: "",
        modifiers: "#[test]",
        is_test: 1,
        is_exported: 0,
        signature: "#[test] fn widget_smoke()",
        attributes_json: r#"{"test":true}"#,
        canonical_json: r#"{"id":"test:src/lib.rs#widget_smoke","kind":"Test"}"#,
    }
}

fn insert_rust_node(connection: &Connection, node: RustNodeFixture<'_>) -> TestResult {
    connection.execute(
        "insert into nodes(id, kind, name, qualified_name, file_path, line_start, line_end, language, parent_name, params, return_type, modifiers, is_test, is_exported, file_hash, extra, updated_at, signature, attributes_json, canonical_json) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            node.id,
            node.kind,
            node.name,
            node.qualified_name,
            node.file_path,
            node.line_start,
            node.line_end,
            "rust",
            node.parent_name,
            node.params,
            node.return_type,
            node.modifiers,
            node.is_test,
            node.is_exported,
            RUST_FILE_HASH,
            "",
            EXTRACTION_GENERATED_AT,
            node.signature,
            node.attributes_json,
            node.canonical_json
        ],
    )?;
    Ok(())
}

fn insert_rust_edges(connection: &Connection, rust_file_path: &str) -> TestResult {
    for (id, kind) in [
        ("edge:CONTAINS:src/lib.rs#Widget", "CONTAINS"),
        ("edge:IMPORTS_FROM:src/lib.rs#serde", "IMPORTS_FROM"),
        ("edge:CALLS:src/lib.rs#Widget::new", "CALLS"),
        ("edge:IMPLEMENTS:src/lib.rs#Widget.Display", "IMPLEMENTS"),
        ("edge:DEPENDS_ON:Cargo.toml#serde", "DEPENDS_ON"),
        ("edge:INHERITS:src/lib.rs#WidgetTrait.Debug", "INHERITS"),
    ] {
        connection.execute(
            "insert into edges(id, kind, source_qualified, target_qualified, file_path, line, extra, updated_at, from_id, to_id, canonical_json) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                kind,
                "crate::Widget",
                "crate::Target",
                rust_file_path,
                4,
                "",
                EXTRACTION_GENERATED_AT,
                "struct:src/lib.rs#Widget",
                "test:src/lib.rs#widget_smoke",
                format!(r#"{{"id":"{id}","kind":"{kind}"}}"#)
            ],
        )?;
    }
    Ok(())
}

fn insert_rust_fts_row(connection: &Connection) -> TestResult {
    connection.execute(
        "insert into nodes_fts(node_id, kind, path, name, qualified_name, file_path, signature) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            "struct:src/lib.rs#Widget",
            "Struct",
            RUST_FILE_RELATIVE_PATH,
            "Widget",
            "crate::Widget",
            RUST_FILE_RELATIVE_PATH,
            "pub struct Widget"
        ],
    )?;
    Ok(())
}

fn assert_rust_file_hash_language(connection: &Connection) -> TestResult {
    let rust_file_language: String = connection.query_row(
        "select language from file_hashes where relative_path = ?1",
        params![RUST_FILE_RELATIVE_PATH],
        |row| row.get(0),
    )?;
    assert_eq!(rust_file_language, "rust");
    Ok(())
}

fn assert_rust_node_columns(connection: &Connection) -> TestResult {
    let rust_struct: (String, u32, u32, String, String, String, String, String, String) = connection.query_row(
        "select language, is_exported, is_test, signature, qualified_name, parent_name, params, return_type, modifiers from nodes where id = ?1",
        params!["struct:src/lib.rs#Widget"],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        },
    )?;
    assert_eq!(
        rust_struct,
        (
            "rust".to_string(),
            1,
            0,
            "pub struct Widget { name: String }".to_string(),
            "crate::Widget".to_string(),
            "crate".to_string(),
            "name: String".to_string(),
            "Self".to_string(),
            "pub,derive(Debug)".to_string()
        )
    );
    Ok(())
}

fn assert_rust_test_flag(connection: &Connection) -> TestResult {
    let rust_test_flag: u32 = connection.query_row(
        "select is_test from nodes where id = ?1",
        params!["test:src/lib.rs#widget_smoke"],
        |row| row.get(0),
    )?;
    assert_eq!(rust_test_flag, 1);
    Ok(())
}

fn assert_rust_edge_kinds(connection: &Connection) -> TestResult {
    let edge_kinds = grouped_counts(
        connection,
        "select kind, count(*) from edges group by kind order by kind",
    )?
    .into_iter()
    .map(|(kind, _count)| kind)
    .collect::<Vec<_>>();
    assert_eq!(
        edge_kinds,
        vec![
            "CALLS",
            "CONTAINS",
            "DEPENDS_ON",
            "IMPLEMENTS",
            "IMPORTS_FROM",
            "INHERITS"
        ]
    );
    Ok(())
}

fn assert_rust_fts_hit(connection: &Connection) -> TestResult {
    let fts_count: u32 = connection.query_row(
        "select count(*) from nodes_fts where nodes_fts match ?1",
        params!["Widget"],
        |row| row.get(0),
    )?;
    assert_eq!(fts_count, 1);
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
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)?;
    assert_eq!(
        freshness,
        vec![
            ("last_build_type".to_string(), "full".to_string()),
            (
                "last_updated".to_string(),
                EXTRACTION_GENERATED_AT.to_string()
            ),
            ("schema_version".to_string(), "6".to_string()),
        ]
    );
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
