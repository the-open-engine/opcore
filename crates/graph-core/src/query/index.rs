use crate::protocol::{GraphFactEdge, GraphFactNode, GraphNamedQueryKind, GraphTraversalMetadata};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::common::{edge_key, normalize_path, path_from_node_id, reached_u32_limit, sorted_edges};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Direction {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct TraversalSpec {
    edge_kinds: &'static [&'static str],
    direction: Direction,
    max_depth: u32,
    pub(super) limit: u32,
}

impl TraversalSpec {
    pub(super) fn new(
        edge_kinds: &'static [&'static str],
        direction: Direction,
        max_depth: u32,
        limit: u32,
    ) -> Self {
        Self {
            edge_kinds,
            direction,
            max_depth,
            limit,
        }
    }
}

#[derive(Debug)]
pub(crate) struct GraphIndex {
    pub(super) nodes_by_id: BTreeMap<String, GraphFactNode>,
    pub(super) edges: Vec<GraphFactEdge>,
    pub(super) file_id_by_path: BTreeMap<String, String>,
}

#[derive(Debug)]
pub(super) struct Selection {
    pub(super) nodes: Vec<GraphFactNode>,
    pub(super) edges: Vec<GraphFactEdge>,
    pub(super) traversal: GraphTraversalMetadata,
}

#[derive(Debug)]
pub(super) struct SelectionAccumulator {
    pub(super) selected_ids: BTreeSet<String>,
    pub(super) selected_edges: BTreeMap<String, GraphFactEdge>,
    limit: u32,
    pub(super) truncated: bool,
}

struct TraversalVisitState<'a> {
    selection: &'a mut SelectionAccumulator,
    visited: &'a mut BTreeSet<String>,
    queue: &'a mut VecDeque<(String, u32)>,
}

struct TraversalEdgeVisit<'a> {
    edge: &'a GraphFactEdge,
    direction: Direction,
    depth: u32,
}

impl SelectionAccumulator {
    pub(super) fn new(limit: u32) -> Self {
        Self {
            selected_ids: BTreeSet::new(),
            selected_edges: BTreeMap::new(),
            limit,
            truncated: false,
        }
    }

    pub(super) fn from_start_ids(index: &GraphIndex, start_ids: &[String], limit: u32) -> Self {
        let mut selection = Self::new(limit);
        for id in start_ids {
            selection.add_node(index, id);
        }
        selection
    }

    pub(super) fn add_node(&mut self, index: &GraphIndex, id: &str) -> bool {
        if !index.nodes_by_id.contains_key(id) {
            return false;
        }
        if self.selected_ids.contains(id) {
            return true;
        }
        if reached_u32_limit(self.selected_ids.len(), self.limit) {
            self.truncated = true;
            return false;
        }
        self.selected_ids.insert(id.to_string());
        true
    }

    pub(super) fn add_edge_if_selected(&mut self, edge: &GraphFactEdge) {
        if self.selected_ids.contains(&edge.from) && self.selected_ids.contains(&edge.to) {
            self.selected_edges.insert(edge_key(edge), edge.clone());
        }
    }

    pub(super) fn selected_file_ids(&self, index: &GraphIndex) -> Vec<String> {
        self.selected_ids
            .iter()
            .filter(|id| {
                index
                    .nodes_by_id
                    .get(*id)
                    .is_some_and(|node| node.kind == "File")
            })
            .cloned()
            .collect()
    }

    pub(super) fn selected_symbol_ids(&self, index: &GraphIndex) -> Vec<String> {
        self.selected_ids
            .iter()
            .filter(|id| {
                index
                    .nodes_by_id
                    .get(*id)
                    .is_some_and(|node| node.kind != "File" && !is_test_node(node))
            })
            .cloned()
            .collect()
    }

    pub(super) fn into_selection(self, index: &GraphIndex, max_depth: u32) -> Selection {
        let nodes = index.nodes_for_ids(&self.selected_ids);
        let total = nodes.len();
        let edges = sorted_edges(
            self.selected_edges
                .into_values()
                .filter(|edge| {
                    self.selected_ids.contains(&edge.from) && self.selected_ids.contains(&edge.to)
                })
                .collect(),
        );
        Selection {
            nodes,
            edges,
            traversal: GraphTraversalMetadata {
                max_depth,
                truncated: self.truncated,
                total,
                empty: total == 0,
            },
        }
    }
}

impl GraphIndex {
    pub(crate) fn new(nodes: &[GraphFactNode], edges: &[GraphFactEdge]) -> Self {
        let nodes_by_id = nodes
            .iter()
            .map(|node| (node.id.clone(), node.clone()))
            .collect::<BTreeMap<_, _>>();
        let file_id_by_path = nodes
            .iter()
            .filter(|node| node.kind == "File")
            .filter_map(|node| {
                node.path
                    .as_ref()
                    .map(|path| (path.clone(), node.id.clone()))
            })
            .collect::<BTreeMap<_, _>>();
        Self {
            nodes_by_id,
            edges: sorted_edges(edges.to_vec()),
            file_id_by_path,
        }
    }

    pub(super) fn resolve_query_targets(
        &self,
        kind: GraphNamedQueryKind,
        target: &str,
    ) -> Vec<String> {
        let Some(id) = self.resolve_node_id(target) else {
            return Vec::new();
        };
        if !matches!(
            kind,
            GraphNamedQueryKind::CallersOf
                | GraphNamedQueryKind::CalleesOf
                | GraphNamedQueryKind::TestsFor
        ) {
            return vec![id];
        }
        let mut ids = vec![id.clone()];
        if id.starts_with("file:") {
            for descendant_id in self.contained_descendant_ids(&id) {
                if !ids.contains(&descendant_id) {
                    ids.push(descendant_id);
                }
            }
        }
        ids
    }

    pub(super) fn resolve_node_id(&self, target: &str) -> Option<String> {
        if self.nodes_by_id.contains_key(target) {
            return Some(target.to_string());
        }
        let normalized = normalize_path(target);
        self.file_id_by_path.get(&normalized).cloned()
    }

    pub(super) fn traverse(&self, start_ids: &[String], spec: TraversalSpec) -> Selection {
        let mut selection = SelectionAccumulator::from_start_ids(self, start_ids, spec.limit);
        let mut visited = selection.selected_ids.clone();
        let mut queue = traversal_queue(start_ids, &selection);
        while let Some((current, depth)) = queue.pop_front() {
            if depth >= spec.max_depth {
                continue;
            }
            let edges = self.traversal_edges(&current, spec);
            for edge in edges {
                self.visit_traversal_edge(
                    TraversalEdgeVisit {
                        edge,
                        direction: spec.direction,
                        depth,
                    },
                    TraversalVisitState {
                        selection: &mut selection,
                        visited: &mut visited,
                        queue: &mut queue,
                    },
                );
            }
        }
        selection.into_selection(self, spec.max_depth)
    }

    pub(super) fn tests_for(&self, start_ids: &[String], max_depth: u32, limit: u32) -> Selection {
        let mut selection = SelectionAccumulator::from_start_ids(self, start_ids, limit);
        let selected_start_ids = start_ids
            .iter()
            .filter(|id| selection.selected_ids.contains(*id))
            .cloned()
            .collect::<Vec<_>>();
        for start_id in selected_start_ids {
            for edge in self.edges_from(&start_id, &["TESTED_BY"]) {
                let test_selected = selection.add_node(self, &edge.to);
                if test_selected {
                    selection.add_edge_if_selected(edge);
                    if let Some(test_path) = self.node_file_path(&edge.to) {
                        if let Some(file_id) = self.file_id_by_path.get(&test_path) {
                            selection.add_node(self, file_id);
                        }
                    }
                }
            }
        }
        selection.into_selection(self, max_depth)
    }

    pub(super) fn file_summary(&self, start_ids: &[String], limit: u32) -> Selection {
        let mut selection = SelectionAccumulator::from_start_ids(self, start_ids, limit);
        let selected_start_ids = start_ids
            .iter()
            .filter(|id| selection.selected_ids.contains(*id))
            .cloned()
            .collect::<Vec<_>>();
        for id in selected_start_ids {
            selection.add_contained_descendants(self, &id);
            for edge in self.edges_from(&id, &["IMPORTS_FROM", "DEPENDS_ON"]) {
                if selection.add_node(self, &edge.to) {
                    selection.add_edge_if_selected(edge);
                }
            }
            for edge in self.edges_to(&id, &["IMPORTS_FROM", "DEPENDS_ON"]) {
                if selection.add_node(self, &edge.from) {
                    selection.add_edge_if_selected(edge);
                }
            }
        }
        selection.into_selection(self, 1)
    }

    pub(super) fn contained_descendant_ids(&self, root_id: &str) -> Vec<String> {
        let mut descendants = BTreeSet::new();
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::from([root_id.to_string()]);
        while let Some(current) = queue.pop_front() {
            if !visited.insert(current.clone()) {
                continue;
            }
            for edge in self.edges_from(&current, &["CONTAINS"]) {
                if descendants.insert(edge.to.clone()) {
                    queue.push_back(edge.to.clone());
                }
            }
        }
        descendants.into_iter().collect()
    }

    pub(super) fn nodes_for_ids(&self, ids: &BTreeSet<String>) -> Vec<GraphFactNode> {
        ids.iter()
            .filter_map(|id| self.nodes_by_id.get(id).cloned())
            .collect::<Vec<_>>()
    }

    pub(super) fn edges_from<'a>(
        &'a self,
        id: &'a str,
        edge_kinds: &'a [&'a str],
    ) -> impl Iterator<Item = &'a GraphFactEdge> + 'a {
        self.edges
            .iter()
            .filter(move |edge| edge.from == id && edge_kinds.contains(&edge.kind.as_str()))
    }

    pub(super) fn edges_to<'a>(
        &'a self,
        id: &'a str,
        edge_kinds: &'a [&'a str],
    ) -> impl Iterator<Item = &'a GraphFactEdge> + 'a {
        self.edges
            .iter()
            .filter(move |edge| edge.to == id && edge_kinds.contains(&edge.kind.as_str()))
    }

    pub(super) fn node_file_path(&self, node_id: &str) -> Option<String> {
        self.nodes_by_id
            .get(node_id)
            .and_then(|node| node.path.clone())
            .or_else(|| path_from_node_id(node_id))
    }

    fn traversal_edges<'a>(
        &'a self,
        current: &'a str,
        spec: TraversalSpec,
    ) -> Vec<&'a GraphFactEdge> {
        match spec.direction {
            Direction::Incoming => self.edges_to(current, spec.edge_kinds).collect(),
            Direction::Outgoing => self.edges_from(current, spec.edge_kinds).collect(),
        }
    }

    fn visit_traversal_edge(&self, visit: TraversalEdgeVisit<'_>, state: TraversalVisitState<'_>) {
        let next = next_traversal_node(visit.edge, visit.direction);
        if state.selection.add_node(self, &next) {
            state.selection.add_edge_if_selected(visit.edge);
            if state.visited.insert(next.clone()) {
                state.queue.push_back((next, visit.depth + 1));
            }
        }
    }
}

impl SelectionAccumulator {
    pub(super) fn add_contained_descendants(&mut self, index: &GraphIndex, root_id: &str) {
        for descendant_id in index.contained_descendant_ids(root_id) {
            self.add_node(index, &descendant_id);
        }
        for edge in &index.edges {
            if edge.kind == "CONTAINS" {
                self.add_edge_if_selected(edge);
            }
        }
    }
}

fn traversal_queue(
    start_ids: &[String],
    selection: &SelectionAccumulator,
) -> VecDeque<(String, u32)> {
    start_ids
        .iter()
        .filter(|id| selection.selected_ids.contains(*id))
        .cloned()
        .map(|id| (id, 0))
        .collect()
}

fn next_traversal_node(edge: &GraphFactEdge, direction: Direction) -> String {
    match direction {
        Direction::Incoming => edge.from.clone(),
        Direction::Outgoing => edge.to.clone(),
    }
}

pub(super) fn is_test_node(node: &GraphFactNode) -> bool {
    node.kind == "Test"
        || node
            .attributes
            .as_ref()
            .and_then(|attributes| attributes.get("isTest"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
}
