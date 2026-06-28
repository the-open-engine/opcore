use super::*;

#[test]
fn store_round_trips_rust_fact_columns() -> TestResult {
    let (_repo, store, rust_file_path) = rust_fact_store()?;

    assert_eq!(store_user_version(&store.connection)?, 1);
    insert_rust_fact_fixture(&store.connection, &rust_file_path)?;
    assert_rust_fact_fixture(&store.connection)?;
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

fn rust_fact_store() -> Result<(TempDir, GraphStore, String), Box<dyn std::error::Error>> {
    let repo = temp_repo()?;
    let store = GraphStore::open(StorePaths::for_repo_root(repo.path()))?;
    let rust_file = store.paths().repo_root.join("src/lib.rs");
    let rust_file_path = display_path(&rust_file);
    Ok((repo, store, rust_file_path))
}

fn insert_rust_fact_fixture(connection: &Connection, rust_file_path: &str) -> TestResult {
    insert_rust_file_hash(connection, rust_file_path)?;
    insert_rust_node(connection, rust_struct_node(rust_file_path))?;
    insert_rust_node(connection, rust_test_node(rust_file_path))?;
    insert_rust_edges(connection, rust_file_path)?;
    insert_rust_fts_row(connection)?;
    Ok(())
}

fn assert_rust_fact_fixture(connection: &Connection) -> TestResult {
    assert_rust_file_hash_language(connection)?;
    assert_rust_node_columns(connection)?;
    assert_rust_test_flag(connection)?;
    assert_rust_edge_kinds(connection)?;
    assert_rust_fts_hit(connection)?;
    Ok(())
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
    let rust_struct: (String, u32, u32, String, String, String, String, String, String) =
        connection.query_row(
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
