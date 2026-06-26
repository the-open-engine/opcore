use crate::protocol::{GraphFactEdge, GraphFactNode, GraphFactQueryKind, GraphFactQuerySelector};
use std::collections::{BTreeMap, BTreeSet};

use super::common::{edge_sort_key, limit_to_usize, sorted_edges};
use super::GraphStoreQueryResult;

pub(super) fn select_graph_facts(
    all_nodes: &[GraphFactNode],
    all_edges: &[GraphFactEdge],
    selector: &GraphFactQuerySelector,
) -> GraphStoreQueryResult {
    let mut nodes_by_id = BTreeMap::new();
    for node in all_nodes {
        nodes_by_id.insert(node.id.clone(), node.clone());
    }

    match selector.kind {
        GraphFactQueryKind::Nodes => select_nodes(all_nodes, all_edges, selector),
        GraphFactQueryKind::Edges => select_edges(&nodes_by_id, all_edges, selector),
        GraphFactQueryKind::Neighbors => select_neighbors(&nodes_by_id, all_edges, selector),
        GraphFactQueryKind::Symbols => select_symbols(all_nodes, all_edges, selector),
        GraphFactQueryKind::Impact => GraphStoreQueryResult::Unsupported {
            message: "impact traversal requires graph impact envelope".to_string(),
        },
    }
}

fn select_nodes(
    all_nodes: &[GraphFactNode],
    all_edges: &[GraphFactEdge],
    selector: &GraphFactQuerySelector,
) -> GraphStoreQueryResult {
    let mut nodes = all_nodes
        .iter()
        .filter(|node| node_matches(node, selector))
        .cloned()
        .collect::<Vec<_>>();
    sort_and_limit_nodes(&mut nodes, selector.limit);
    let selected_ids = nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    let edges = edges_between_selected(all_edges, &selected_ids);
    GraphStoreQueryResult::Available { nodes, edges }
}

fn select_edges(
    nodes_by_id: &BTreeMap<String, GraphFactNode>,
    all_edges: &[GraphFactEdge],
    selector: &GraphFactQuerySelector,
) -> GraphStoreQueryResult {
    let mut edges = all_edges
        .iter()
        .filter(|edge| edge_matches(edge, selector))
        .filter(|edge| edge_endpoints_exist(nodes_by_id, edge))
        .cloned()
        .collect::<Vec<_>>();
    sort_and_limit_edges(&mut edges, selector.limit);
    let nodes = endpoint_nodes(nodes_by_id, &edges);
    GraphStoreQueryResult::Available { nodes, edges }
}

fn select_neighbors(
    nodes_by_id: &BTreeMap<String, GraphFactNode>,
    all_edges: &[GraphFactEdge],
    selector: &GraphFactQuerySelector,
) -> GraphStoreQueryResult {
    let requested = selector.ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut edges = all_edges
        .iter()
        .filter(|edge| {
            (requested.is_empty() || requested.contains(&edge.from) || requested.contains(&edge.to))
                && edge_matches(edge, selector)
                && edge_endpoints_exist(nodes_by_id, edge)
        })
        .cloned()
        .collect::<Vec<_>>();
    sort_and_limit_edges(&mut edges, selector.limit);
    let nodes = endpoint_nodes(nodes_by_id, &edges);
    GraphStoreQueryResult::Available { nodes, edges }
}

fn select_symbols(
    all_nodes: &[GraphFactNode],
    all_edges: &[GraphFactEdge],
    selector: &GraphFactQuerySelector,
) -> GraphStoreQueryResult {
    let mut nodes = all_nodes
        .iter()
        .filter(|node| node.kind != "File")
        .filter(|node| node_matches(node, selector))
        .cloned()
        .collect::<Vec<_>>();
    sort_and_limit_nodes(&mut nodes, selector.limit);
    let selected_ids = nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    let edges = edges_between_selected(all_edges, &selected_ids);
    GraphStoreQueryResult::Available { nodes, edges }
}

fn node_matches(node: &GraphFactNode, selector: &GraphFactQuerySelector) -> bool {
    (selector.ids.is_empty() || selector.ids.contains(&node.id))
        && (selector.node_kinds.is_empty() || selector.node_kinds.contains(&node.kind))
        && selector.text.as_ref().is_none_or(|text| {
            node.id.contains(text) || node.name.as_ref().is_some_and(|name| name.contains(text))
        })
}

fn edge_matches(edge: &GraphFactEdge, selector: &GraphFactQuerySelector) -> bool {
    let edge_id = edge.id.as_deref().unwrap_or("");
    edge_id_matches(edge, edge_id, selector)
        && edge_kind_matches(edge, selector)
        && edge_text_matches(edge, edge_id, selector)
}

fn edge_id_matches(edge: &GraphFactEdge, edge_id: &str, selector: &GraphFactQuerySelector) -> bool {
    selector.ids.is_empty()
        || selector.ids.contains(&edge.from)
        || selector.ids.contains(&edge.to)
        || selector.ids.iter().any(|id| id == edge_id)
}

fn edge_kind_matches(edge: &GraphFactEdge, selector: &GraphFactQuerySelector) -> bool {
    selector.edge_kinds.is_empty() || selector.edge_kinds.contains(&edge.kind)
}

fn edge_text_matches(
    edge: &GraphFactEdge,
    edge_id: &str,
    selector: &GraphFactQuerySelector,
) -> bool {
    selector.text.as_ref().is_none_or(|text| {
        edge_id.contains(text) || edge.from.contains(text) || edge.to.contains(text)
    })
}

fn endpoint_nodes(
    nodes_by_id: &BTreeMap<String, GraphFactNode>,
    edges: &[GraphFactEdge],
) -> Vec<GraphFactNode> {
    let mut ids = BTreeSet::new();
    for edge in edges {
        ids.insert(edge.from.clone());
        ids.insert(edge.to.clone());
    }
    ids.into_iter()
        .filter_map(|id| nodes_by_id.get(&id).cloned())
        .collect()
}

fn edges_between_selected(
    all_edges: &[GraphFactEdge],
    selected_ids: &BTreeSet<String>,
) -> Vec<GraphFactEdge> {
    sorted_edges(
        all_edges
            .iter()
            .filter(|edge| selected_ids.contains(&edge.from) && selected_ids.contains(&edge.to))
            .cloned()
            .collect(),
    )
}

fn edge_endpoints_exist(
    nodes_by_id: &BTreeMap<String, GraphFactNode>,
    edge: &GraphFactEdge,
) -> bool {
    nodes_by_id.contains_key(&edge.from) && nodes_by_id.contains_key(&edge.to)
}

fn sort_and_limit_nodes(nodes: &mut Vec<GraphFactNode>, limit: Option<u32>) {
    nodes.sort_by(|left, right| left.id.cmp(&right.id));
    if let Some(limit) = limit {
        nodes.truncate(limit_to_usize(limit));
    }
}

fn sort_and_limit_edges(edges: &mut Vec<GraphFactEdge>, limit: Option<u32>) {
    edges.sort_by_key(edge_sort_key);
    if let Some(limit) = limit {
        edges.truncate(limit_to_usize(limit));
    }
}
