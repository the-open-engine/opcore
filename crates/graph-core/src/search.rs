use crate::protocol::{
    GraphFactEdge, GraphFactNode, GraphSearchMode, GraphSearchRequest, GraphSearchResultEntry,
    GraphSearchSummary,
};
use crate::store::{StoreError, StoreResult};
use rusqlite::{params, Connection, OptionalExtension};
mod dependents;
mod scoring;

use dependents::dependent_files_for_files;
use scoring::{search_rows, SearchRowsSpec};
use std::collections::{BTreeMap, BTreeSet};

pub const NODES_FTS_SCHEMA: &str = "CREATE VIRTUAL TABLE nodes_fts USING fts5(node_id UNINDEXED, kind UNINDEXED, path UNINDEXED, name, qualified_name, file_path, signature)";

const DEFAULT_SEARCH_LIMIT: u32 = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct SearchIndexUpdate {
    pub strategy: String,
    pub changed_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub dependent_files: Vec<String>,
    pub reindexed_node_ids: Vec<String>,
    pub deleted_node_ids: Vec<String>,
    pub full_rebuild_required: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphSearchOutput {
    pub query: String,
    pub search_mode: GraphSearchMode,
    pub summary: GraphSearchSummary,
    pub results: Vec<GraphSearchResultEntry>,
    pub hints: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SearchIndexRow {
    pub node_id: String,
    pub kind: String,
    pub path: Option<String>,
    pub name: Option<String>,
    pub qualified_name: String,
    pub file_path: Option<String>,
    pub signature: String,
}

pub(crate) struct SearchIndexRefresh<'a> {
    pub current_nodes: &'a [GraphFactNode],
    pub current_edges: &'a [GraphFactEdge],
    pub previous_nodes: &'a [GraphFactNode],
    pub previous_edges: &'a [GraphFactEdge],
    pub changed_files: &'a [String],
    pub deleted_files: &'a [String],
}

pub fn create_search_schema(connection: &Connection) -> StoreResult<()> {
    connection.execute_batch(NODES_FTS_SCHEMA)?;
    Ok(())
}

pub fn validate_search_schema(connection: &Connection) -> StoreResult<()> {
    let sql: Option<String> = connection
        .query_row(
            "select sql from sqlite_master where type = 'table' and name = 'nodes_fts'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(sql) = sql else {
        return Err(StoreError::SchemaMismatch {
            message: "required search table nodes_fts is missing".to_string(),
            actual_version: crate::store::store_user_version(connection).unwrap_or_default(),
        });
    };
    let normalized = sql.replace(['\n', '\r'], " ").to_lowercase();
    for column in [
        "node_id",
        "kind",
        "path",
        "name",
        "qualified_name",
        "file_path",
        "signature",
    ] {
        if !normalized.contains(column) {
            return Err(StoreError::SchemaMismatch {
                message: format!("required search column nodes_fts.{column} is missing"),
                actual_version: crate::store::store_user_version(connection).unwrap_or_default(),
            });
        }
    }
    Ok(())
}

pub fn rebuild_search_index(
    tx: &rusqlite::Transaction<'_>,
    nodes: &[GraphFactNode],
) -> StoreResult<()> {
    tx.execute("delete from nodes_fts", [])?;
    index_nodes(tx, nodes)?;
    Ok(())
}

pub fn index_nodes(tx: &rusqlite::Transaction<'_>, nodes: &[GraphFactNode]) -> StoreResult<()> {
    let mut rows = nodes.iter().map(project_node).collect::<Vec<_>>();
    rows.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    for row in rows {
        tx.execute(
            "insert into nodes_fts(node_id, kind, path, name, qualified_name, file_path, signature) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.node_id,
                row.kind,
                row.path,
                row.name,
                row.qualified_name,
                row.file_path,
                row.signature
            ],
        )?;
    }
    Ok(())
}

pub(crate) fn refresh_search_index_incremental(
    tx: &rusqlite::Transaction<'_>,
    refresh: SearchIndexRefresh<'_>,
) -> StoreResult<SearchIndexUpdate> {
    let dependent_files = dependent_files_for_files(
        refresh.current_edges,
        refresh.previous_edges,
        refresh.changed_files,
        refresh.deleted_files,
    );
    let reindex_files = sorted_strings(
        refresh
            .changed_files
            .iter()
            .chain(dependent_files.iter())
            .cloned()
            .collect(),
    );
    let delete_paths = sorted_strings(
        reindex_files
            .iter()
            .chain(refresh.deleted_files.iter())
            .cloned()
            .collect(),
    );
    for path in &delete_paths {
        tx.execute("delete from nodes_fts where path = ?1", params![path])?;
    }
    let nodes_to_index = nodes_to_reindex(refresh.current_nodes, &reindex_files);
    index_nodes(tx, &nodes_to_index)?;

    let reindexed_node_ids = sorted_node_ids(&nodes_to_index);
    let deleted_node_ids =
        deleted_node_ids(refresh.previous_nodes, refresh.current_nodes, &delete_paths);

    Ok(SearchIndexUpdate {
        strategy: "incremental".to_string(),
        changed_files: sorted_strings(refresh.changed_files.to_vec()),
        deleted_files: sorted_strings(refresh.deleted_files.to_vec()),
        dependent_files,
        reindexed_node_ids,
        deleted_node_ids,
        full_rebuild_required: false,
    })
}

fn nodes_to_reindex(nodes: &[GraphFactNode], reindex_files: &[String]) -> Vec<GraphFactNode> {
    let reindex_set = reindex_files
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    nodes
        .iter()
        .filter(|node| {
            node.path
                .as_deref()
                .is_some_and(|path| reindex_set.contains(path))
        })
        .cloned()
        .collect()
}

fn sorted_node_ids(nodes: &[GraphFactNode]) -> Vec<String> {
    nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn deleted_node_ids(
    previous_nodes: &[GraphFactNode],
    current_nodes: &[GraphFactNode],
    delete_paths: &[String],
) -> Vec<String> {
    let current_ids = current_nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    let delete_path_set = delete_paths
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    previous_nodes
        .iter()
        .filter(|node| {
            node.path
                .as_deref()
                .is_some_and(|path| delete_path_set.contains(path))
        })
        .filter(|node| !current_ids.contains(node.id.as_str()))
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub fn search(
    connection: &Connection,
    request: &GraphSearchRequest,
) -> StoreResult<GraphSearchOutput> {
    validate_search_schema(connection)?;
    let query = request.query.trim();
    if query.is_empty() {
        return Err(StoreError::UnsupportedMode(
            "Graph search request query must not be empty".to_string(),
        ));
    }
    let limit = request.limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    if limit == 0 {
        return Err(StoreError::UnsupportedMode(
            "Graph search request limit must be positive".to_string(),
        ));
    }
    let context_files = sorted_strings(request.files.clone());
    let context_set = context_files.iter().cloned().collect::<BTreeSet<_>>();
    let fts_query = fts_query(query)?;
    let raw_rows = search_rows(
        connection,
        SearchRowsSpec {
            query,
            fts_query: &fts_query,
            limit,
            context_files: &context_set,
        },
    )?;
    let total = count_matches(connection, &fts_query)?;
    let indexed_node_kinds = indexed_node_kinds(connection)?;
    let mut results = Vec::new();
    for (index, row) in raw_rows.into_iter().enumerate() {
        results.push(GraphSearchResultEntry {
            node_id: row.node_id,
            kind: row.kind,
            path: row.path,
            name: row.name,
            qualified_name: row.qualified_name,
            file_path: row.file_path,
            signature: row.signature,
            score: row.score,
            rank: rank_for_index(index),
            matches: row.matches,
        });
    }
    let mut hints = vec!["fts5".to_string()];
    if !context_files.is_empty() {
        hints.push("context_file_boost".to_string());
    }
    Ok(GraphSearchOutput {
        query: query.to_string(),
        search_mode: GraphSearchMode {
            engine: "fts5".to_string(),
            query_syntax: "fts5".to_string(),
            limit,
            context_files: context_files.clone(),
        },
        summary: GraphSearchSummary {
            query: query.to_string(),
            total,
            returned: results.len(),
            limit,
            indexed_node_kinds,
            context_files,
        },
        results,
        hints,
    })
}

pub fn projected_node_ids_for_files(nodes: &[GraphFactNode], files: &[String]) -> Vec<String> {
    let file_set = files.iter().map(String::as_str).collect::<BTreeSet<_>>();
    nodes
        .iter()
        .filter(|node| {
            node.path
                .as_deref()
                .is_some_and(|path| file_set.contains(path))
        })
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub fn node_ids_by_path(nodes: &[GraphFactNode]) -> BTreeMap<String, Vec<String>> {
    let mut by_path = BTreeMap::<String, BTreeSet<String>>::new();
    for node in nodes {
        if let Some(path) = &node.path {
            by_path
                .entry(path.clone())
                .or_default()
                .insert(node.id.clone());
        }
    }
    by_path
        .into_iter()
        .map(|(path, ids)| (path, ids.into_iter().collect()))
        .collect()
}

fn count_matches(connection: &Connection, fts_query: &str) -> StoreResult<usize> {
    let count: u32 = connection.query_row(
        "select count(*) from nodes_fts where nodes_fts match ?1",
        params![fts_query],
        |row| row.get(0),
    )?;
    usize::try_from(count).map_err(|_| {
        StoreError::InvalidSnapshot("search match count exceeds platform usize".to_string())
    })
}

fn rank_for_index(index: usize) -> u32 {
    u32::try_from(index.saturating_add(1)).unwrap_or(u32::MAX)
}

fn limit_to_usize(limit: u32) -> usize {
    match usize::try_from(limit) {
        Ok(limit) => limit,
        Err(_) => usize::MAX,
    }
}

fn indexed_node_kinds(connection: &Connection) -> StoreResult<Vec<String>> {
    let mut statement = connection.prepare("select distinct kind from nodes_fts order by kind")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    collect_rows(rows)
}

fn project_node(node: &GraphFactNode) -> SearchIndexRow {
    let path = node.path.clone();
    let file_path = path.clone();
    let name = node.name.clone().or_else(|| {
        path.as_ref()
            .and_then(|path| path.rsplit('/').next())
            .map(ToString::to_string)
    });
    let qualified_name = node.id.clone();
    let signature = signature_for_node(node, name.as_deref());
    SearchIndexRow {
        node_id: node.id.clone(),
        kind: node.kind.clone(),
        path,
        name: name.map(|name| searchable_text(&name)),
        qualified_name: searchable_text(&qualified_name),
        file_path,
        signature,
    }
}

fn signature_for_node(node: &GraphFactNode, name: Option<&str>) -> String {
    let repo_path = node.path.as_deref().unwrap_or("");
    let display_name = name.unwrap_or(repo_path);
    let split_name = searchable_text(display_name);
    let qualified = searchable_text(&node.id);
    format!("{} {} {} {}", node.kind, split_name, repo_path, qualified)
}

fn searchable_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len() * 2);
    let mut previous_lower = false;
    for character in value.chars() {
        if character.is_ascii_uppercase() && previous_lower {
            output.push(' ');
        }
        if character.is_ascii_alphanumeric() {
            output.push(character);
            previous_lower = character.is_ascii_lowercase() || character.is_ascii_digit();
        } else {
            output.push(' ');
            previous_lower = false;
        }
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn fts_query(query: &str) -> StoreResult<String> {
    let normalized = searchable_text(query);
    if normalized.is_empty() {
        return Err(StoreError::UnsupportedMode(
            "Graph search request query must contain searchable text".to_string(),
        ));
    }
    Ok(normalized)
}

fn sorted_strings(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn collect_rows<T, F>(rows: rusqlite::MappedRows<'_, F>) -> StoreResult<Vec<T>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut values = Vec::new();
    for row in rows {
        values.push(row?);
    }
    Ok(values)
}

pub fn boundary_name() -> &'static str {
    "GraphProvider FTS5 search boundary"
}

pub fn behavior_status() -> &'static str {
    "implemented: signature projection, FTS5 index lifecycle, deterministic ranked search"
}
