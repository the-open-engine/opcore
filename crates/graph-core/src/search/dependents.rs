use crate::protocol::GraphFactEdge;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub(super) fn dependent_files_for_files(
    current_edges: &[GraphFactEdge],
    previous_edges: &[GraphFactEdge],
    changed_files: &[String],
    deleted_files: &[String],
) -> Vec<String> {
    let root_files = changed_files
        .iter()
        .chain(deleted_files.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    let incoming = incoming_file_edges(current_edges, previous_edges);
    let (mut visited, mut queue) = root_file_queue(&root_files);

    let mut dependent_files = BTreeSet::new();
    while let Some(current) = queue.pop_front() {
        for dependent_id in incoming.get(&current).into_iter().flatten() {
            if !visited.insert(dependent_id.clone()) {
                continue;
            }
            insert_dependent_file(&root_files, &mut dependent_files, dependent_id);
            queue.push_back(dependent_id.clone());
        }
    }
    dependent_files.into_iter().collect()
}

fn incoming_file_edges(
    current_edges: &[GraphFactEdge],
    previous_edges: &[GraphFactEdge],
) -> BTreeMap<String, BTreeSet<String>> {
    let mut incoming = BTreeMap::<String, BTreeSet<String>>::new();
    for edge in current_edges.iter().chain(previous_edges.iter()) {
        if is_file_dependency_edge(edge) {
            incoming
                .entry(edge.to.clone())
                .or_default()
                .insert(edge.from.clone());
        }
    }
    incoming
}

fn is_file_dependency_edge(edge: &GraphFactEdge) -> bool {
    matches!(edge.kind.as_str(), "IMPORTS_FROM" | "DEPENDS_ON")
        && edge.from.starts_with("file:")
        && edge.to.starts_with("file:")
}

fn root_file_queue(root_files: &BTreeSet<String>) -> (BTreeSet<String>, VecDeque<String>) {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    for path in root_files {
        let id = file_id(path);
        visited.insert(id.clone());
        queue.push_back(id);
    }
    (visited, queue)
}

fn insert_dependent_file(
    root_files: &BTreeSet<String>,
    dependent_files: &mut BTreeSet<String>,
    dependent_id: &str,
) {
    if let Some(path) = file_path_from_id(dependent_id) {
        if !root_files.contains(&path) {
            dependent_files.insert(path);
        }
    }
}

fn file_id(path: &str) -> String {
    format!("file:{path}")
}

fn file_path_from_id(id: &str) -> Option<String> {
    id.strip_prefix("file:").map(ToString::to_string)
}
