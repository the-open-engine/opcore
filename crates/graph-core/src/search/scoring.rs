use super::{collect_rows, limit_to_usize, searchable_text};
use crate::store::StoreResult;
use rusqlite::{params, Connection};
use std::collections::BTreeSet;

pub(super) struct SearchRowsSpec<'a> {
    pub(super) query: &'a str,
    pub(super) fts_query: &'a str,
    pub(super) limit: u32,
    pub(super) context_files: &'a BTreeSet<String>,
}

pub(super) fn search_rows(
    connection: &Connection,
    spec: SearchRowsSpec<'_>,
) -> StoreResult<Vec<SearchRow>> {
    let mut statement = connection.prepare(
        r#"
        select nodes_fts.node_id,
               nodes_fts.kind,
               nodes_fts.path,
               nodes.name,
               coalesce(nodes.qualified_name, nodes_fts.node_id) as qualified_name,
               nodes_fts.file_path,
               nodes_fts.signature,
               -bm25(nodes_fts, 0.0, 0.0, 0.0, 10.0, 6.0, 3.0, 1.0) as score
        from nodes_fts
        left join nodes on nodes.id = nodes_fts.node_id
        where nodes_fts match ?1
        "#,
    )?;
    let rows = statement.query_map(params![spec.fts_query], |row| map_search_row(row, &spec))?;
    let mut rows = collect_rows(rows)?;
    rows.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.qualified_name.cmp(&right.qualified_name))
            .then_with(|| left.node_id.cmp(&right.node_id))
    });
    rows.truncate(limit_to_usize(spec.limit));
    Ok(rows)
}

fn map_search_row(
    row: &rusqlite::Row<'_>,
    spec: &SearchRowsSpec<'_>,
) -> rusqlite::Result<SearchRow> {
    let text = SearchRowText {
        kind: row.get(1)?,
        path: row.get(2)?,
        name: row.get(3)?,
        qualified_name: row.get(4)?,
        signature: row.get(6)?,
    };
    Ok(SearchRow {
        node_id: row.get(0)?,
        kind: text.kind.clone(),
        path: text.path.clone(),
        name: text.name.clone(),
        qualified_name: text.qualified_name.clone(),
        file_path: row.get(5)?,
        signature: text.signature.clone(),
        score: score_search_row(row.get(7)?, spec, &text),
        matches: matched_columns(
            spec.query,
            text.name.as_deref(),
            &text.qualified_name,
            &text.signature,
        ),
    })
}

fn score_search_row(base_score: f64, spec: &SearchRowsSpec<'_>, text: &SearchRowText) -> f64 {
    let mut score = base_score + kind_rank_bonus(&text.kind);
    score += text_match_bonus(spec.query, text.name.as_deref()) * 2.0;
    score += leading_function_name_bonus(spec.query, &text.kind, text.name.as_deref());
    score += text_match_bonus(spec.query, Some(&text.qualified_name));
    score += text_match_bonus(spec.query, Some(&text.signature)) * 0.25;
    if context_file_boost_applies(&text.kind, text.path.as_deref(), spec.context_files) {
        score += 1000.0;
    }
    score
}

fn context_file_boost_applies(
    kind: &str,
    path: Option<&str>,
    context_files: &BTreeSet<String>,
) -> bool {
    !matches!(kind, "File" | "Test") && path.is_some_and(|path| context_files.contains(path))
}

fn kind_rank_bonus(kind: &str) -> f64 {
    match kind {
        "Class" => 320.0,
        "Function" => 280.0,
        "Type" => 240.0,
        "Test" => -400.0,
        "File" => -500.0,
        _ => 0.0,
    }
}

fn leading_function_name_bonus(query: &str, kind: &str, name: Option<&str>) -> f64 {
    if kind != "Function" {
        return 0.0;
    }
    let Some(name) = name else {
        return 0.0;
    };
    let needle = searchable_text(query).to_lowercase();
    let normalized_name = searchable_text(name).to_lowercase();
    let first_token = normalized_name.split_whitespace().next().unwrap_or("");
    if first_token == needle {
        90.0
    } else {
        0.0
    }
}

fn text_match_bonus(query: &str, value: Option<&str>) -> f64 {
    let Some(value) = value else {
        return 0.0;
    };
    let needle = searchable_text(query).to_lowercase();
    let haystack = searchable_text(value).to_lowercase();
    if haystack == needle {
        160.0
    } else if haystack.split_whitespace().any(|part| part == needle) {
        120.0
    } else if haystack.contains(&needle) {
        80.0
    } else {
        0.0
    }
}

fn matched_columns(
    query: &str,
    name: Option<&str>,
    qualified_name: &str,
    signature: &str,
) -> Vec<String> {
    let needle = searchable_text(query).to_lowercase();
    let mut matches = Vec::new();
    if name.is_some_and(|value| searchable_text(value).to_lowercase().contains(&needle)) {
        matches.push("name".to_string());
    }
    if searchable_text(qualified_name)
        .to_lowercase()
        .contains(&needle)
    {
        matches.push("qualified_name".to_string());
    }
    if searchable_text(signature).to_lowercase().contains(&needle) {
        matches.push("signature".to_string());
    }
    matches
}

pub(super) struct SearchRow {
    pub(super) node_id: String,
    pub(super) kind: String,
    pub(super) path: Option<String>,
    pub(super) name: Option<String>,
    pub(super) qualified_name: String,
    pub(super) file_path: Option<String>,
    pub(super) signature: String,
    pub(super) score: f64,
    pub(super) matches: Vec<String>,
}

struct SearchRowText {
    kind: String,
    path: Option<String>,
    name: Option<String>,
    qualified_name: String,
    signature: String,
}
