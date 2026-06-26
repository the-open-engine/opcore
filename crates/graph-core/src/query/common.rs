use crate::extraction::normalize_repo_relative_path;
use crate::protocol::GraphFactEdge;

pub(super) fn reached_u32_limit(count: usize, limit: u32) -> bool {
    match u32::try_from(count) {
        Ok(count) => count >= limit,
        Err(_) => true,
    }
}

pub(super) fn limit_to_usize(limit: u32) -> usize {
    match usize::try_from(limit) {
        Ok(limit) => limit,
        Err(_) => usize::MAX,
    }
}

pub(super) fn sorted_edges(mut edges: Vec<GraphFactEdge>) -> Vec<GraphFactEdge> {
    edges.sort_by_key(edge_sort_key);
    edges
}

pub(super) fn sorted_repo_paths(mut paths: Vec<String>) -> Vec<String> {
    paths = paths
        .into_iter()
        .map(|path| normalize_path(&path))
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

pub(super) fn normalize_path(path: &str) -> String {
    normalize_repo_relative_path(path, "query path")
        .unwrap_or_else(|_| path.trim().trim_start_matches("./").replace('\\', "/"))
}

pub(super) fn path_from_node_id(id: &str) -> Option<String> {
    let (_, rest) = id.split_once(':')?;
    let path = rest.split_once('#').map(|(path, _)| path).unwrap_or(rest);
    Some(path.to_string())
}

pub(super) fn edge_key(edge: &GraphFactEdge) -> String {
    format!(
        "{}\0{}\0{}\0{}",
        edge.kind,
        edge.from,
        edge.to,
        edge.id.clone().unwrap_or_default()
    )
}

pub(super) fn edge_sort_key(edge: &GraphFactEdge) -> (String, String, String, String) {
    (
        edge.kind.clone(),
        edge.from.clone(),
        edge.to.clone(),
        edge.id.clone().unwrap_or_default(),
    )
}
