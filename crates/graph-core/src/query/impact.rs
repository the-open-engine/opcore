use crate::protocol::GraphRenamedFile;
use crate::store::StoreQueryOutput;
use std::collections::{BTreeSet, VecDeque};

use super::common::sorted_repo_paths;
use super::index::{GraphIndex, Selection, SelectionAccumulator};
use super::GraphImpactOutput;

pub(super) struct ImpactTraversal {
    changed_files: Vec<String>,
    max_depth: u32,
    limit: u32,
}

impl ImpactTraversal {
    pub(super) fn new(changed_files: Vec<String>, max_depth: u32, limit: u32) -> Self {
        Self {
            changed_files,
            max_depth,
            limit,
        }
    }

    pub(super) fn run(self, snapshot: &StoreQueryOutput, index: &GraphIndex) -> GraphImpactOutput {
        let start_files = self.start_file_ids(index);
        let mut selection = SelectionAccumulator::from_start_ids(index, &start_files, self.limit);
        self.collect_reverse_file_dependents(index, &start_files, &mut selection);
        self.add_contained_symbols(index, &mut selection);
        self.add_tests_for_symbols(index, &mut selection);
        let traversal = self.impact_paths_from_selection(index, selection);
        self.build_impact_output(snapshot, traversal)
    }

    fn start_file_ids(&self, index: &GraphIndex) -> Vec<String> {
        self.changed_files
            .iter()
            .filter_map(|path| index.file_id_by_path.get(path).cloned())
            .collect()
    }

    fn collect_reverse_file_dependents(
        &self,
        index: &GraphIndex,
        start_files: &[String],
        selection: &mut SelectionAccumulator,
    ) {
        let mut visited = selection.selected_ids.clone();
        let mut queue = start_files
            .iter()
            .filter(|id| selection.selected_ids.contains(*id))
            .cloned()
            .map(|id| (id, 0))
            .collect::<VecDeque<_>>();
        while let Some((current, depth)) = queue.pop_front() {
            if depth >= self.max_depth {
                continue;
            }
            for edge in index.edges_to(&current, &["IMPORTS_FROM", "DEPENDS_ON"]) {
                let next = edge.from.clone();
                if selection.add_node(index, &next) {
                    selection.add_edge_if_selected(edge);
                    if visited.insert(next.clone()) {
                        queue.push_back((next, depth + 1));
                    }
                }
            }
        }
    }

    fn add_contained_symbols(&self, index: &GraphIndex, selection: &mut SelectionAccumulator) {
        for file_id in selection.selected_file_ids(index) {
            for edge in index.edges_from(&file_id, &["CONTAINS"]) {
                if selection.add_node(index, &edge.to) {
                    selection.add_edge_if_selected(edge);
                }
            }
        }
    }

    fn add_tests_for_symbols(&self, index: &GraphIndex, selection: &mut SelectionAccumulator) {
        for symbol_id in selection.selected_symbol_ids(index) {
            for edge in index.edges_from(&symbol_id, &["TESTED_BY"]) {
                let test_selected = selection.add_node(index, &edge.to);
                if test_selected {
                    selection.add_edge_if_selected(edge);
                    if let Some(test_path) = index.node_file_path(&edge.to) {
                        if let Some(file_id) = index.file_id_by_path.get(&test_path) {
                            selection.add_node(index, file_id);
                        }
                    }
                }
            }
        }
    }

    fn impact_paths_from_selection(
        &self,
        index: &GraphIndex,
        selection: SelectionAccumulator,
    ) -> ImpactSelection {
        let traversal = selection.into_selection(index, self.max_depth);
        let impacted_files = traversal
            .nodes
            .iter()
            .filter(|node| node.kind == "File")
            .filter_map(|node| node.path.clone())
            .collect::<Vec<_>>();
        let impacted_symbols = traversal
            .nodes
            .iter()
            .filter(|node| node.kind != "File" && node.kind != "Test")
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        let tests = traversal
            .nodes
            .iter()
            .filter(|node| node.kind == "Test")
            .filter_map(|node| index.node_file_path(&node.id))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        ImpactSelection {
            traversal,
            impacted_files,
            impacted_symbols,
            tests,
        }
    }

    fn build_impact_output(
        self,
        snapshot: &StoreQueryOutput,
        impact: ImpactSelection,
    ) -> GraphImpactOutput {
        GraphImpactOutput {
            metadata: snapshot.metadata.clone(),
            changed_files: self.changed_files,
            impacted_files: impact.impacted_files,
            impacted_symbols: impact.impacted_symbols,
            tests: impact.tests,
            nodes: impact.traversal.nodes,
            edges: impact.traversal.edges,
            traversal: impact.traversal.traversal,
            diagnostics: snapshot.diagnostics.clone(),
        }
    }
}

struct ImpactSelection {
    traversal: Selection,
    impacted_files: Vec<String>,
    impacted_symbols: Vec<String>,
    tests: Vec<String>,
}

pub(super) fn change_impact_files(
    changed_files: &[String],
    deleted_files: &[String],
    renamed_files: &[GraphRenamedFile],
) -> Vec<String> {
    let mut files = changed_files.to_vec();
    files.extend(deleted_files.iter().cloned());
    files.extend(renamed_files.iter().map(|rename| rename.from_path.clone()));
    sorted_repo_paths(files)
}
