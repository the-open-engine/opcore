use super::metadata::optional_json;
use super::types::{FileHashesByPath, NodesById, SnapshotRefreshOptions, StoreSnapshot};
use super::{
    display_path, search, StoreError, StoreResult, COMPAT_SCHEMA_VERSION, STORE_SCHEMA_VERSION,
};
use crate::extraction::{FileFacts, SourceFileHash};
use crate::protocol::{GraphFactEdge, GraphFactNode};
use crate::GRAPH_SCHEMA_VERSION;
use rusqlite::params;
use std::collections::BTreeSet;
use std::path::Path;

pub(super) fn validate_snapshot(snapshot: &StoreSnapshot) -> StoreResult<()> {
    if snapshot.metadata.schema_version != GRAPH_SCHEMA_VERSION {
        return Err(StoreError::InvalidSnapshot(format!(
            "snapshot schemaVersion {} does not match GraphProvider {}",
            snapshot.metadata.schema_version, GRAPH_SCHEMA_VERSION
        )));
    }
    let node_ids = snapshot
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    for edge in &snapshot.edges {
        if !node_ids.contains(&edge.from) || !node_ids.contains(&edge.to) {
            return Err(StoreError::InvalidSnapshot(format!(
                "edge {} references missing endpoint {} -> {}",
                edge.id.clone().unwrap_or_else(|| edge.kind.clone()),
                edge.from,
                edge.to
            )));
        }
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct PreviousSearchFacts {
    pub(super) nodes: Vec<GraphFactNode>,
    pub(super) edges: Vec<GraphFactEdge>,
}

pub(super) struct SnapshotIndexes {
    file_hashes_by_path: FileHashesByPath,
    nodes_by_id: NodesById,
}

impl SnapshotIndexes {
    pub(super) fn from_snapshot(snapshot: &StoreSnapshot) -> Self {
        Self {
            file_hashes_by_path: snapshot
                .file_hashes
                .iter()
                .map(|hash| (hash.relative_path.clone(), hash.clone()))
                .collect(),
            nodes_by_id: snapshot
                .nodes
                .iter()
                .map(|node| (node.id.clone(), node.clone()))
                .collect(),
        }
    }
}

pub(super) struct SnapshotInsertContext<'a> {
    repo_root: &'a Path,
    now: &'a str,
    operation: &'a str,
}

impl<'a> SnapshotInsertContext<'a> {
    pub(super) fn new(repo_root: &'a Path, now: &'a str, operation: &'a str) -> Self {
        Self {
            repo_root,
            now,
            operation,
        }
    }
}

pub(super) fn clear_snapshot_tables(
    tx: &rusqlite::Transaction<'_>,
    incremental_search: bool,
) -> StoreResult<()> {
    for table in ["metadata", "lattice_store", "file_hashes", "edges", "nodes"] {
        tx.execute(&format!("delete from {table}"), [])?;
    }
    if !incremental_search {
        tx.execute("delete from nodes_fts", [])?;
    }
    Ok(())
}

pub(super) fn write_snapshot_rows(
    tx: &rusqlite::Transaction<'_>,
    context: &SnapshotInsertContext<'_>,
    snapshot: &StoreSnapshot,
    indexes: &SnapshotIndexes,
) -> StoreResult<()> {
    insert_metadata_rows(tx, snapshot, context.now, context.operation)?;
    insert_file_hashes(tx, &snapshot.file_hashes, context.now)?;
    insert_cached_file_facts(tx, &snapshot.file_facts)?;
    insert_nodes(tx, context, &snapshot.nodes, &indexes.file_hashes_by_path)?;
    insert_edges(tx, context, &snapshot.edges, &indexes.nodes_by_id)
}

pub(super) fn write_search_index(
    tx: &rusqlite::Transaction<'_>,
    snapshot: &StoreSnapshot,
    previous: &PreviousSearchFacts,
    options: &SnapshotRefreshOptions<'_>,
) -> StoreResult<search::SearchIndexUpdate> {
    if options.incremental_search() {
        return search::refresh_search_index_incremental(
            tx,
            search::SearchIndexRefresh {
                current_nodes: &snapshot.nodes,
                current_edges: &snapshot.edges,
                previous_nodes: &previous.nodes,
                previous_edges: &previous.edges,
                changed_files: options.changed_files,
                deleted_files: options.deleted_files,
            },
        );
    }
    search::rebuild_search_index(tx, &snapshot.nodes)?;
    Ok(full_search_update_metadata(
        &snapshot.nodes,
        options.changed_files,
        options.deleted_files,
        options.full_rebuild_required,
    ))
}

fn insert_metadata_rows(
    tx: &rusqlite::Transaction<'_>,
    snapshot: &StoreSnapshot,
    now: &str,
    operation: &str,
) -> StoreResult<()> {
    let metadata_json = serde_json::to_string(&snapshot.metadata)?;
    let diagnostics_json = serde_json::to_string(&snapshot.diagnostics)?;
    let rows = [
        ("schema_version", COMPAT_SCHEMA_VERSION.to_string()),
        ("last_updated", snapshot.metadata.generated_at.clone()),
        ("last_build_type", operation.to_string()),
        (
            "lattice_store_schema_version",
            STORE_SCHEMA_VERSION.to_string(),
        ),
        (
            "lattice_graph_schema_version",
            GRAPH_SCHEMA_VERSION.to_string(),
        ),
        ("lattice_provider", snapshot.metadata.provider.clone()),
        (
            "lattice_repo_root",
            snapshot.metadata.repo.repo_root.clone().unwrap_or_default(),
        ),
        ("lattice_snapshot_metadata", metadata_json.clone()),
        ("lattice_diagnostics_json", diagnostics_json.clone()),
    ];
    for (key, value) in rows {
        tx.execute(
            "insert into metadata(key, value) values (?1, ?2)",
            params![key, value],
        )?;
    }
    for (key, value) in [
        ("schema_version", STORE_SCHEMA_VERSION.to_string()),
        ("last_updated", snapshot.metadata.generated_at.clone()),
        ("last_write_at", now.to_string()),
        ("metadata_json", metadata_json),
        ("diagnostics_json", diagnostics_json),
    ] {
        tx.execute(
            "insert into lattice_store(key, value) values (?1, ?2)",
            params![key, value],
        )?;
    }
    Ok(())
}

fn insert_cached_file_facts(
    tx: &rusqlite::Transaction<'_>,
    file_facts: &[FileFacts],
) -> StoreResult<()> {
    tx.execute(
        "insert into lattice_store(key, value) values ('file_facts_json', ?1)",
        params![serde_json::to_string(file_facts)?],
    )?;
    Ok(())
}

fn full_search_update_metadata(
    nodes: &[GraphFactNode],
    changed_files: &[String],
    deleted_files: &[String],
    full_rebuild_required: bool,
) -> search::SearchIndexUpdate {
    search::SearchIndexUpdate {
        strategy: "full".to_string(),
        changed_files: changed_files.to_vec(),
        deleted_files: deleted_files.to_vec(),
        dependent_files: Vec::new(),
        reindexed_node_ids: nodes.iter().map(|node| node.id.clone()).collect::<Vec<_>>(),
        deleted_node_ids: Vec::new(),
        full_rebuild_required,
    }
}

pub(super) fn insert_search_update_metadata(
    tx: &rusqlite::Transaction<'_>,
    update: &search::SearchIndexUpdate,
) -> StoreResult<()> {
    let metadata = serde_json::json!({
        "strategy": update.strategy,
        "changedFiles": update.changed_files,
        "deletedFiles": update.deleted_files,
        "dependentFiles": update.dependent_files,
        "reindexedNodeIds": update.reindexed_node_ids,
        "deletedNodeIds": update.deleted_node_ids,
        "fullRebuildRequired": update.full_rebuild_required
    });
    tx.execute(
        "insert into lattice_store(key, value) values ('search_index_last_update_json', ?1)",
        params![serde_json::to_string(&metadata)?],
    )?;
    tx.execute(
        "insert into metadata(key, value) values ('search_index_last_update_json', ?1)",
        params![serde_json::to_string(&metadata)?],
    )?;
    Ok(())
}

fn insert_file_hashes(
    tx: &rusqlite::Transaction<'_>,
    file_hashes: &[SourceFileHash],
    now: &str,
) -> StoreResult<()> {
    let mut sorted = file_hashes.to_vec();
    sorted.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    for file_hash in sorted {
        tx.execute(
            "insert into file_hashes(relative_path, absolute_path, language, sha256, updated_at) values (?1, ?2, ?3, ?4, ?5)",
            params![
                file_hash.relative_path,
                file_hash.absolute_path,
                file_hash.language,
                file_hash.sha256,
                now
            ],
        )?;
    }
    Ok(())
}

fn insert_nodes(
    tx: &rusqlite::Transaction<'_>,
    context: &SnapshotInsertContext<'_>,
    nodes: &[GraphFactNode],
    file_hashes_by_path: &FileHashesByPath,
) -> StoreResult<()> {
    let mut sorted = nodes.to_vec();
    sorted.sort_by(|left, right| left.id.cmp(&right.id));
    for node in sorted {
        let row = node_insert_row(context, file_hashes_by_path, &node)?;
        tx.execute(
            r#"
            insert into nodes(
              id, kind, name, qualified_name, file_path, line_start, line_end, language,
              parent_name, params, return_type, modifiers, is_test, is_exported, file_hash,
              extra, updated_at, signature, community_id, path, attributes_json, canonical_json
            )
            values (?1, ?2, ?3, ?4, ?5, null, null, ?6, null, null, null, null, ?7, ?8, ?9, ?10, ?11, ?12, null, ?13, ?14, ?15)
            "#,
            params![
                row.id,
                row.kind,
                row.name,
                row.qualified_name,
                row.file_path,
                row.language,
                row.is_test,
                row.is_exported,
                row.sha256,
                row.canonical_json.clone(),
                context.now,
                row.signature,
                row.path,
                row.attributes_json,
                row.canonical_json,
            ],
        )?;
    }
    Ok(())
}

struct NodeInsertRow {
    id: String,
    kind: String,
    name: Option<String>,
    qualified_name: String,
    file_path: Option<String>,
    language: Option<String>,
    is_test: i32,
    is_exported: i32,
    sha256: Option<String>,
    signature: Option<String>,
    path: Option<String>,
    attributes_json: Option<String>,
    canonical_json: String,
}

fn node_insert_row(
    context: &SnapshotInsertContext<'_>,
    file_hashes_by_path: &FileHashesByPath,
    node: &GraphFactNode,
) -> StoreResult<NodeInsertRow> {
    let path = node.path.clone();
    let file_hash = path.as_ref().and_then(|path| file_hashes_by_path.get(path));
    Ok(NodeInsertRow {
        id: node.id.clone(),
        kind: node.kind.clone(),
        name: node.name.clone(),
        qualified_name: node.id.clone(),
        file_path: node_file_path(context, path.as_deref(), file_hash),
        language: file_hash.map(|hash| hash.language.clone()),
        is_test: if is_test_node(node) { 1 } else { 0 },
        is_exported: if node
            .attributes
            .as_ref()
            .and_then(|attributes| attributes.get("exported"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            1
        } else {
            0
        },
        sha256: file_hash.map(|hash| hash.sha256.clone()),
        signature: node.name.clone(),
        path,
        attributes_json: optional_json(&node.attributes)?,
        canonical_json: serde_json::to_string(node)?,
    })
}

fn is_test_node(node: &GraphFactNode) -> bool {
    node.kind == "Test"
        || node
            .attributes
            .as_ref()
            .and_then(|attributes| attributes.get("isTest"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
}

fn node_file_path(
    context: &SnapshotInsertContext<'_>,
    path: Option<&str>,
    file_hash: Option<&SourceFileHash>,
) -> Option<String> {
    path.map(|path| display_path(&context.repo_root.join(path)))
        .or_else(|| file_hash.map(|hash| hash.absolute_path.clone()))
}

fn insert_edges(
    tx: &rusqlite::Transaction<'_>,
    context: &SnapshotInsertContext<'_>,
    edges: &[GraphFactEdge],
    nodes_by_id: &NodesById,
) -> StoreResult<()> {
    let mut sorted = edges.to_vec();
    sorted.sort_by(|left, right| {
        (
            left.kind.clone(),
            left.from.clone(),
            left.to.clone(),
            left.id.clone().unwrap_or_default(),
        )
            .cmp(&(
                right.kind.clone(),
                right.from.clone(),
                right.to.clone(),
                right.id.clone().unwrap_or_default(),
            ))
    });
    for edge in sorted {
        let id = edge
            .id
            .clone()
            .unwrap_or_else(|| format!("edge:{}:{}->{}", edge.kind, edge.from, edge.to));
        let kind = edge.kind.clone();
        let from = edge.from.clone();
        let to = edge.to.clone();
        let source_path = nodes_by_id
            .get(&edge.from)
            .and_then(|node| node.path.as_ref());
        let target_path = nodes_by_id
            .get(&edge.to)
            .and_then(|node| node.path.as_ref());
        let file_path = source_path
            .or(target_path)
            .map(|path| display_path(&context.repo_root.join(path)));
        let attributes_json = optional_json(&edge.attributes)?;
        let canonical_json = serde_json::to_string(&edge)?;
        tx.execute(
            r#"
            insert into edges(
              id, kind, source_qualified, target_qualified, file_path, line, extra, updated_at,
              from_id, to_id, attributes_json, canonical_json
            )
            values (?1, ?2, ?3, ?4, ?5, null, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
            params![
                id,
                kind,
                from,
                to,
                file_path,
                canonical_json.clone(),
                context.now,
                edge.from,
                edge.to,
                attributes_json,
                canonical_json,
            ],
        )?;
    }
    Ok(())
}
