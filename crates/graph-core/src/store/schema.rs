use super::metadata::{collect_rows, validate_metadata_json};
use super::{
    now_rfc3339, search, StoreError, StoreResult, STORE_SCHEMA_VERSION, WAL_AUTOCHECKPOINT_PAGES,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeSet;

#[cfg_attr(not(test), allow(dead_code))]
pub(super) const STORE_INDEX_NAMES: [&str; 8] = [
    "idx_nodes_file",
    "idx_nodes_kind",
    "idx_nodes_qualified",
    "idx_edges_source",
    "idx_edges_target",
    "idx_edges_kind",
    "idx_edges_file",
    "idx_nodes_exported_name",
];

pub(super) fn configure_sqlite(connection: &Connection) -> StoreResult<()> {
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)?;
    Ok(())
}

pub(super) fn migrate_or_validate(connection: &Connection) -> StoreResult<bool> {
    let user_version = user_version(connection)?;
    if user_version == 0 && sqlite_schema_is_empty(connection)? {
        initialize_schema(connection)?;
        validate_schema(connection)?;
        return Ok(false);
    }
    let search_schema_repaired = repair_search_schema_if_needed(connection)?;
    validate_schema(connection)?;
    Ok(search_schema_repaired)
}

fn initialize_schema(connection: &Connection) -> StoreResult<()> {
    create_migration_table(connection)?;
    connection.execute(
        "insert into lattice_migrations(version, state, applied_at) values (?1, 'in_progress', ?2)",
        params![STORE_SCHEMA_VERSION, now_rfc3339()],
    )?;
    create_store_tables(connection)?;
    create_store_indices(connection)?;
    search::create_search_schema(connection)?;
    connection.execute(
        "update lattice_migrations set state = 'applied', applied_at = ?1 where version = ?2",
        params![now_rfc3339(), STORE_SCHEMA_VERSION],
    )?;
    connection.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
    Ok(())
}

fn create_migration_table(connection: &Connection) -> StoreResult<()> {
    connection.execute_batch(
        r#"
        create table if not exists lattice_migrations (
          version integer primary key,
          state text not null,
          applied_at text
        );
        "#,
    )?;
    Ok(())
}

fn create_store_tables(connection: &Connection) -> StoreResult<()> {
    connection.execute_batch(
        r#"
        create table lattice_store (
          key text primary key,
          value text not null
        );

        create table metadata (
          key text primary key,
          value text not null
        );

        create table file_hashes (
          relative_path text primary key,
          absolute_path text not null,
          language text not null,
          sha256 text not null,
          updated_at text not null
        );

        create table nodes (
          id text primary key,
          kind text not null,
          name text,
          qualified_name text not null,
          file_path text,
          line_start integer,
          line_end integer,
          language text,
          parent_name text,
          params text,
          return_type text,
          modifiers text,
          is_test integer not null default 0,
          is_exported integer not null default 0,
          file_hash text,
          extra text,
          updated_at text not null,
          signature text,
          community_id text,
          path text,
          attributes_json text,
          canonical_json text not null
        );

        create table edges (
          id text primary key,
          kind text not null,
          source_qualified text not null,
          target_qualified text not null,
          file_path text,
          line integer,
          extra text,
          updated_at text not null,
          from_id text not null,
          to_id text not null,
          attributes_json text,
          canonical_json text not null
        );
        "#,
    )?;
    Ok(())
}

fn create_store_indices(connection: &Connection) -> StoreResult<()> {
    connection.execute_batch(
        r#"
        create index idx_nodes_file on nodes(file_path);
        create index idx_nodes_kind on nodes(kind);
        create index idx_nodes_qualified on nodes(qualified_name);
        create index idx_edges_source on edges(source_qualified);
        create index idx_edges_target on edges(target_qualified);
        create index idx_edges_kind on edges(kind);
        create index idx_edges_file on edges(file_path);
        create index idx_nodes_exported_name on nodes(is_exported, name);
        "#,
    )?;
    Ok(())
}

pub(super) fn validate_schema(connection: &Connection) -> StoreResult<()> {
    let actual = user_version(connection)?;
    if actual != STORE_SCHEMA_VERSION {
        return Err(StoreError::SchemaMismatch {
            message: format!("expected user_version {STORE_SCHEMA_VERSION}, found {actual}"),
            actual_version: actual,
        });
    }

    require_store_tables(connection)?;
    require_store_columns(connection)?;
    search::validate_search_schema(connection)?;
    require_store_indices(connection)?;
    require_no_partial_migration(connection)?;
    validate_metadata_json(connection)?;
    Ok(())
}

fn require_store_tables(connection: &Connection) -> StoreResult<()> {
    for table in [
        "lattice_store",
        "lattice_migrations",
        "metadata",
        "file_hashes",
        "nodes",
        "edges",
        "nodes_fts",
    ] {
        require_table(connection, table)?;
    }
    Ok(())
}

fn require_store_columns(connection: &Connection) -> StoreResult<()> {
    require_columns(connection, "lattice_store", &["key", "value"])?;
    require_columns(
        connection,
        "lattice_migrations",
        &["version", "state", "applied_at"],
    )?;
    require_columns(connection, "metadata", &["key", "value"])?;
    require_columns(
        connection,
        "file_hashes",
        &[
            "relative_path",
            "absolute_path",
            "language",
            "sha256",
            "updated_at",
        ],
    )?;
    require_columns(
        connection,
        "nodes",
        &[
            "id",
            "kind",
            "name",
            "qualified_name",
            "file_path",
            "line_start",
            "line_end",
            "language",
            "parent_name",
            "params",
            "return_type",
            "modifiers",
            "is_test",
            "is_exported",
            "file_hash",
            "extra",
            "updated_at",
            "signature",
            "community_id",
            "path",
            "canonical_json",
        ],
    )?;
    require_columns(
        connection,
        "edges",
        &[
            "id",
            "kind",
            "source_qualified",
            "target_qualified",
            "file_path",
            "line",
            "extra",
            "updated_at",
            "from_id",
            "to_id",
            "canonical_json",
        ],
    )?;
    require_columns(
        connection,
        "nodes_fts",
        &[
            "node_id",
            "kind",
            "path",
            "name",
            "qualified_name",
            "file_path",
            "signature",
        ],
    )?;
    Ok(())
}

fn require_store_indices(connection: &Connection) -> StoreResult<()> {
    for index in STORE_INDEX_NAMES {
        require_index(connection, index)?;
    }
    Ok(())
}

fn repair_search_schema_if_needed(connection: &Connection) -> StoreResult<bool> {
    if user_version(connection)? != STORE_SCHEMA_VERSION {
        return Ok(false);
    }
    match search::validate_search_schema(connection) {
        Ok(()) => Ok(false),
        Err(StoreError::SchemaMismatch { .. }) => {
            connection.execute("drop table if exists nodes_fts", [])?;
            search::create_search_schema(connection)?;
            Ok(true)
        }
        Err(error) => Err(error),
    }
}

pub(super) fn user_version(connection: &Connection) -> StoreResult<u32> {
    Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

pub fn store_user_version(connection: &Connection) -> StoreResult<u32> {
    user_version(connection)
}

pub(super) fn sqlite_schema_is_empty(connection: &Connection) -> StoreResult<bool> {
    let count: u32 = connection.query_row(
        "select count(*) from sqlite_master where name not like 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    Ok(count == 0)
}

pub(super) fn require_table(connection: &Connection, table: &str) -> StoreResult<()> {
    let exists: Option<String> = connection
        .query_row(
            "select name from sqlite_master where type = 'table' and name = ?1",
            params![table],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(StoreError::SchemaMismatch {
            message: format!("required table {table} is missing"),
            actual_version: user_version(connection).unwrap_or_default(),
        });
    }
    Ok(())
}

fn require_columns(connection: &Connection, table: &str, required: &[&str]) -> StoreResult<()> {
    let mut statement = connection.prepare(&format!("pragma table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let columns = collect_rows(rows)?.into_iter().collect::<BTreeSet<_>>();
    for column in required {
        if !columns.contains(*column) {
            return Err(StoreError::SchemaMismatch {
                message: format!("required column {table}.{column} is missing"),
                actual_version: user_version(connection).unwrap_or_default(),
            });
        }
    }
    Ok(())
}

pub(super) fn require_index(connection: &Connection, index: &str) -> StoreResult<()> {
    let exists: Option<String> = connection
        .query_row(
            "select name from sqlite_master where type = 'index' and name = ?1",
            params![index],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(StoreError::SchemaMismatch {
            message: format!("required index {index} is missing"),
            actual_version: user_version(connection).unwrap_or_default(),
        });
    }
    Ok(())
}

fn require_no_partial_migration(connection: &Connection) -> StoreResult<()> {
    let partial: Option<String> = connection
        .query_row(
            "select version || ':' || state from lattice_migrations where state <> 'applied' order by version limit 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(partial) = partial {
        return Err(StoreError::SchemaMismatch {
            message: format!("partial migration marker found: {partial}"),
            actual_version: user_version(connection).unwrap_or_default(),
        });
    }
    let applied: Option<u32> = connection
        .query_row(
            "select version from lattice_migrations where version = ?1 and state = 'applied'",
            params![STORE_SCHEMA_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if applied != Some(STORE_SCHEMA_VERSION) {
        return Err(StoreError::SchemaMismatch {
            message: "applied migration marker for schema v1 is missing".to_string(),
            actual_version: user_version(connection).unwrap_or_default(),
        });
    }
    Ok(())
}
