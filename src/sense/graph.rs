use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::{
    identity::ContentId,
    limits::{MAX_CYCLE_MEMBER_PATHS, MAX_CYCLE_WITNESS_PATHS},
    path::RepoPath,
    source::snapshot::SourceSnapshot,
};

use super::model::{DependencyEdge, InterfaceEdge, InterfaceEdgeKey, IntroducedCycle, Projection};

pub(crate) fn exact_path_continuity(
    before: &SourceSnapshot,
    after: &SourceSnapshot,
) -> BTreeMap<RepoPath, RepoPath> {
    let (removed_paths, added_paths) = unmatched_paths(before, after);
    let removed = content_paths(before, removed_paths);
    let added = content_paths(after, added_paths);
    removed
        .into_iter()
        .filter_map(|(content, before_paths)| {
            let after_paths = added.get(&content)?;
            (before_paths.len() == 1 && after_paths.len() == 1)
                .then(|| (before_paths[0].clone(), after_paths[0].clone()))
        })
        .collect()
}

fn unmatched_paths<'a>(
    before: &'a SourceSnapshot,
    after: &'a SourceSnapshot,
) -> (Vec<&'a RepoPath>, Vec<&'a RepoPath>) {
    let mut removed = Vec::new();
    let mut added = Vec::new();
    let mut before_paths = before.paths().peekable();
    let mut after_paths = after.paths().peekable();
    while let (Some(before_path), Some(after_path)) = (before_paths.peek(), after_paths.peek()) {
        match before_path.cmp(after_path) {
            std::cmp::Ordering::Less => {
                if let Some(path) = before_paths.next() {
                    removed.push(path);
                }
            }
            std::cmp::Ordering::Greater => {
                if let Some(path) = after_paths.next() {
                    added.push(path);
                }
            }
            std::cmp::Ordering::Equal => {
                before_paths.next();
                after_paths.next();
            }
        }
    }
    removed.extend(before_paths);
    added.extend(after_paths);
    (removed, added)
}

fn content_paths<'a>(
    snapshot: &SourceSnapshot,
    paths: impl IntoIterator<Item = &'a RepoPath>,
) -> BTreeMap<ContentId, Vec<RepoPath>> {
    let mut grouped = BTreeMap::<ContentId, Vec<RepoPath>>::new();
    for path in paths {
        if let Some(file) = snapshot.read(path) {
            grouped
                .entry(file.content_id)
                .or_default()
                .push(path.clone());
        }
    }
    grouped
}

pub(crate) fn introduced_cycles(before: &Projection, after: &Projection) -> Vec<IntroducedCycle> {
    let before_components = cyclic_components(before);
    let before_membership = component_membership(&before_components);
    let before_edges = before.runtime_edges().cloned().collect::<BTreeSet<_>>();
    let new_edges = new_runtime_edges(after, &before_edges);
    let adjacency = adjacency(&after.nodes, after.runtime_edges());
    cyclic_components(after)
        .into_iter()
        .filter(|component| !contained_in_prior_cycle(component, &before_membership))
        .filter_map(|component| {
            let trigger = first_new_internal_edge(&component, &new_edges)?;
            introduced_cycle(&adjacency, component, trigger)
        })
        .collect()
}

fn component_membership(components: &[BTreeSet<RepoPath>]) -> BTreeMap<RepoPath, usize> {
    components
        .iter()
        .enumerate()
        .flat_map(|(index, component)| component.iter().cloned().map(move |path| (path, index)))
        .collect()
}

fn new_runtime_edges(
    after: &Projection,
    before: &BTreeSet<DependencyEdge>,
) -> BTreeMap<RepoPath, Vec<DependencyEdge>> {
    let mut edges = BTreeMap::<RepoPath, Vec<DependencyEdge>>::new();
    for edge in after.runtime_edges().filter(|edge| !before.contains(*edge)) {
        edges
            .entry(edge.from.clone())
            .or_default()
            .push(edge.clone());
    }
    edges
}

pub(super) fn canonicalize(
    projection: &Projection,
    continuity: &BTreeMap<RepoPath, RepoPath>,
) -> Projection {
    let canonical_path = |path: &RepoPath| {
        continuity
            .get(path)
            .cloned()
            .unwrap_or_else(|| path.clone())
    };
    let mut interfaces = BTreeMap::new();
    for (path, interface) in &projection.interfaces {
        interfaces.insert(canonical_path(path), interface.clone());
    }
    let mut interface_edges = BTreeMap::new();
    for (key, edge) in &projection.interface_edges {
        let destination = interface_edges
            .entry(InterfaceEdgeKey {
                from: canonical_path(&key.from),
                to: canonical_path(&key.to),
                namespace: key.namespace,
            })
            .or_insert_with(InterfaceEdge::default);
        destination.unknown_width |= edge.unknown_width;
        destination.selectors.extend(edge.selectors.clone());
    }
    Projection {
        nodes: projection.nodes.iter().map(canonical_path).collect(),
        edges: projection
            .edges
            .iter()
            .map(|edge| DependencyEdge {
                from: canonical_path(&edge.from),
                to: canonical_path(&edge.to),
                kind: edge.kind,
            })
            .collect(),
        coverage: projection.coverage.clone(),
        resolution_gaps: projection
            .resolution_gaps
            .iter()
            .map(|gap| super::model::ResolutionGapEvidence {
                path: canonical_path(&gap.path),
                specifier: gap.specifier.clone(),
                kind: gap.kind,
            })
            .collect(),
        resolution_gaps_truncated: projection.resolution_gaps_truncated,
        interfaces,
        interface_edges,
        interface_coverage: projection.interface_coverage.clone(),
    }
}

fn cyclic_components(projection: &Projection) -> Vec<BTreeSet<RepoPath>> {
    let runtime_edges = projection.runtime_edges().cloned().collect::<Vec<_>>();
    let self_edges = runtime_edges
        .iter()
        .filter(|edge| edge.from == edge.to)
        .map(|edge| edge.from.clone())
        .collect::<BTreeSet<_>>();
    components(&projection.nodes, &runtime_edges)
        .into_iter()
        .filter(|component| {
            component.len() > 1 || component.iter().any(|node| self_edges.contains(node))
        })
        .collect()
}

fn components(nodes: &BTreeSet<RepoPath>, edges: &[DependencyEdge]) -> Vec<BTreeSet<RepoPath>> {
    let paths = nodes.iter().cloned().collect::<Vec<_>>();
    let indexes = paths
        .iter()
        .enumerate()
        .map(|(index, path)| (path.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let mut forward = vec![Vec::new(); paths.len()];
    let mut reverse = vec![Vec::new(); paths.len()];
    for edge in edges {
        if let (Some(&from), Some(&to)) = (indexes.get(&edge.from), indexes.get(&edge.to)) {
            forward[from].push(to);
            reverse[to].push(from);
        }
    }
    for targets in forward.iter_mut().chain(reverse.iter_mut()) {
        targets.sort_unstable();
        targets.dedup();
    }
    let order = finish_order(&forward);
    collect_components(&paths, &reverse, order)
}

fn finish_order(adjacency: &[Vec<usize>]) -> Vec<usize> {
    let mut visited = vec![false; adjacency.len()];
    let mut order = Vec::with_capacity(adjacency.len());
    for start in 0..adjacency.len() {
        if visited[start] {
            continue;
        }
        visited[start] = true;
        let mut stack = vec![(start, 0usize)];
        while let Some((node, next)) = stack.pop() {
            if let Some(&target) = adjacency[node].get(next) {
                stack.push((node, next.saturating_add(1)));
                if !visited[target] {
                    visited[target] = true;
                    stack.push((target, 0));
                }
            } else {
                order.push(node);
            }
        }
    }
    order
}

fn collect_components(
    paths: &[RepoPath],
    reverse: &[Vec<usize>],
    order: Vec<usize>,
) -> Vec<BTreeSet<RepoPath>> {
    let mut visited = vec![false; paths.len()];
    let mut components = Vec::new();
    for start in order.into_iter().rev() {
        if visited[start] {
            continue;
        }
        visited[start] = true;
        let mut stack = vec![start];
        let mut component = BTreeSet::new();
        while let Some(node) = stack.pop() {
            component.insert(paths[node].clone());
            for &target in reverse[node].iter().rev() {
                if !visited[target] {
                    visited[target] = true;
                    stack.push(target);
                }
            }
        }
        components.push(component);
    }
    components.sort_by(|left, right| left.first().cmp(&right.first()));
    components
}

fn contained_in_prior_cycle(
    after: &BTreeSet<RepoPath>,
    membership: &BTreeMap<RepoPath, usize>,
) -> bool {
    let Some(component) = after.first().and_then(|path| membership.get(path)) else {
        return false;
    };
    after
        .iter()
        .all(|path| membership.get(path) == Some(component))
}

fn first_new_internal_edge(
    component: &BTreeSet<RepoPath>,
    new_edges: &BTreeMap<RepoPath, Vec<DependencyEdge>>,
) -> Option<DependencyEdge> {
    component.iter().find_map(|path| {
        new_edges
            .get(path)?
            .iter()
            .find(|edge| component.contains(&edge.to))
            .cloned()
    })
}

fn introduced_cycle(
    adjacency: &BTreeMap<RepoPath, Vec<RepoPath>>,
    component: BTreeSet<RepoPath>,
    trigger: DependencyEdge,
) -> Option<IntroducedCycle> {
    let witness = shortest_witness(adjacency, &component, &trigger)?;
    let member_count = component.len();
    let members_truncated = member_count > MAX_CYCLE_MEMBER_PATHS;
    let witness_truncated = witness.len() > MAX_CYCLE_WITNESS_PATHS;
    Some(IntroducedCycle {
        member_count,
        members: component.into_iter().take(MAX_CYCLE_MEMBER_PATHS).collect(),
        members_truncated,
        trigger,
        witness: if witness_truncated {
            Vec::new()
        } else {
            witness
        },
        witness_truncated,
    })
}

fn adjacency<'a>(
    nodes: &BTreeSet<RepoPath>,
    edges: impl IntoIterator<Item = &'a DependencyEdge>,
) -> BTreeMap<RepoPath, Vec<RepoPath>> {
    let mut adjacency = nodes
        .iter()
        .cloned()
        .map(|node| (node, Vec::new()))
        .collect::<BTreeMap<_, _>>();
    for edge in edges {
        if let Some(targets) = adjacency.get_mut(&edge.from) {
            targets.push(edge.to.clone());
        }
    }
    for targets in adjacency.values_mut() {
        targets.sort();
        targets.dedup();
    }
    adjacency
}

fn shortest_witness(
    adjacency: &BTreeMap<RepoPath, Vec<RepoPath>>,
    component: &BTreeSet<RepoPath>,
    trigger: &DependencyEdge,
) -> Option<Vec<RepoPath>> {
    if trigger.from == trigger.to {
        return Some(vec![trigger.from.clone(), trigger.from.clone()]);
    }
    let previous = witness_predecessors(adjacency, component, &trigger.to, &trigger.from)?;
    reconstruct_witness(&previous, trigger)
}

fn witness_predecessors(
    adjacency: &BTreeMap<RepoPath, Vec<RepoPath>>,
    component: &BTreeSet<RepoPath>,
    start: &RepoPath,
    target: &RepoPath,
) -> Option<BTreeMap<RepoPath, RepoPath>> {
    let mut queue = VecDeque::from([start.clone()]);
    let mut previous = BTreeMap::<RepoPath, RepoPath>::new();
    let mut visited = BTreeSet::from([start.clone()]);
    while let Some(node) = queue.pop_front() {
        if &node == target {
            break;
        }
        for target in adjacency.get(&node).into_iter().flatten() {
            if component.contains(target) && visited.insert(target.clone()) {
                previous.insert(target.clone(), node.clone());
                queue.push_back(target.clone());
            }
        }
    }
    visited.contains(target).then_some(previous)
}

fn reconstruct_witness(
    previous: &BTreeMap<RepoPath, RepoPath>,
    trigger: &DependencyEdge,
) -> Option<Vec<RepoPath>> {
    let mut reverse_path = vec![trigger.from.clone()];
    while reverse_path.last() != Some(&trigger.to) {
        reverse_path.push(previous.get(reverse_path.last()?)?.clone());
    }
    reverse_path.reverse();
    let mut witness = vec![trigger.from.clone()];
    witness.extend(reverse_path);
    Some(witness)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Language, SourceFile};
    use crate::sense::model::EdgeKind;

    fn path(value: &str) -> RepoPath {
        RepoPath::from_protocol(value).unwrap()
    }

    fn edge(from: &str, to: &str, kind: EdgeKind) -> DependencyEdge {
        DependencyEdge {
            from: path(from),
            to: path(to),
            kind,
        }
    }

    fn projection(nodes: &[&str], edges: Vec<DependencyEdge>) -> Projection {
        Projection {
            nodes: nodes.iter().map(|node| path(node)).collect(),
            edges: edges.into_iter().collect(),
            ..Projection::default()
        }
    }

    #[test]
    fn reports_joint_cycles_self_loops_and_scc_expansion_but_not_baseline_debt() {
        let baseline = projection(
            &["a.ts", "b.ts", "c.ts", "stable.ts"],
            vec![
                edge("a.ts", "b.ts", EdgeKind::Runtime),
                edge("b.ts", "a.ts", EdgeKind::Runtime),
                edge("stable.ts", "stable.ts", EdgeKind::Runtime),
            ],
        );
        let after = projection(
            &["a.ts", "b.ts", "c.ts", "stable.ts", "self.ts"],
            vec![
                edge("a.ts", "b.ts", EdgeKind::Runtime),
                edge("b.ts", "a.ts", EdgeKind::Runtime),
                edge("b.ts", "c.ts", EdgeKind::Runtime),
                edge("c.ts", "a.ts", EdgeKind::Runtime),
                edge("stable.ts", "stable.ts", EdgeKind::Runtime),
                edge("self.ts", "self.ts", EdgeKind::Runtime),
                edge("c.ts", "b.ts", EdgeKind::TypeOnly),
            ],
        );

        let cycles = introduced_cycles(&baseline, &after);
        assert_eq!(cycles.len(), 2);
        assert_eq!(
            cycles[0].members,
            vec![path("a.ts"), path("b.ts"), path("c.ts")]
        );
        assert_eq!(cycles[0].member_count, 3);
        assert!(!cycles[0].members_truncated);
        assert_eq!(cycles[0].trigger, edge("b.ts", "c.ts", EdgeKind::Runtime));
        assert_eq!(
            cycles[0].witness,
            vec![path("b.ts"), path("c.ts"), path("a.ts"), path("b.ts")]
        );
        assert_eq!(cycles[1].members, vec![path("self.ts")]);
    }

    #[test]
    fn type_only_cycles_and_added_edges_inside_a_prior_scc_do_not_report() {
        let before = projection(
            &["a.ts", "b.ts"],
            vec![
                edge("a.ts", "b.ts", EdgeKind::Runtime),
                edge("b.ts", "a.ts", EdgeKind::Runtime),
            ],
        );
        let after = projection(
            &["a.ts", "b.ts"],
            vec![
                edge("a.ts", "b.ts", EdgeKind::Runtime),
                edge("b.ts", "a.ts", EdgeKind::Runtime),
                edge("a.ts", "a.ts", EdgeKind::Runtime),
                edge("a.ts", "b.ts", EdgeKind::TypeOnly),
            ],
        );
        assert!(introduced_cycles(&before, &after).is_empty());

        let type_cycle = projection(
            &["x.ts", "y.ts"],
            vec![
                edge("x.ts", "y.ts", EdgeKind::TypeOnly),
                edge("y.ts", "x.ts", EdgeKind::TypeOnly),
            ],
        );
        assert!(introduced_cycles(&Projection::default(), &type_cycle).is_empty());

        let split = projection(
            &["a.ts", "b.ts"],
            vec![
                edge("a.ts", "a.ts", EdgeKind::Runtime),
                edge("b.ts", "b.ts", EdgeKind::Runtime),
            ],
        );
        assert!(introduced_cycles(&before, &split).is_empty());
    }

    #[test]
    fn exact_one_to_one_rename_preserves_cycle_continuity() {
        let before_snapshot = SourceSnapshot::new([
            SourceFile::new(
                path("a.ts"),
                b"same".as_slice(),
                Language::TypeScript,
                "ts".into(),
            ),
            SourceFile::new(
                path("b.ts"),
                b"b".as_slice(),
                Language::TypeScript,
                "ts".into(),
            ),
        ]);
        let after_snapshot = SourceSnapshot::new([
            SourceFile::new(
                path("renamed.ts"),
                b"same".as_slice(),
                Language::TypeScript,
                "ts".into(),
            ),
            SourceFile::new(
                path("b.ts"),
                b"b".as_slice(),
                Language::TypeScript,
                "ts".into(),
            ),
        ]);
        let before = projection(
            &["a.ts", "b.ts"],
            vec![
                edge("a.ts", "b.ts", EdgeKind::Runtime),
                edge("b.ts", "a.ts", EdgeKind::Runtime),
            ],
        );
        let after = projection(
            &["renamed.ts", "b.ts"],
            vec![
                edge("renamed.ts", "b.ts", EdgeKind::Runtime),
                edge("b.ts", "renamed.ts", EdgeKind::Runtime),
            ],
        );
        let continuity = exact_path_continuity(&before_snapshot, &after_snapshot);
        assert_eq!(continuity.get(&path("a.ts")), Some(&path("renamed.ts")));
        let before = canonicalize(&before, &continuity);
        assert!(introduced_cycles(&before, &after).is_empty());
    }

    #[test]
    fn unmatched_paths_reports_only_sorted_set_difference() {
        let before = SourceSnapshot::new([
            SourceFile::new(
                path("a.ts"),
                b"a".as_slice(),
                Language::TypeScript,
                "ts".into(),
            ),
            SourceFile::new(
                path("shared.ts"),
                b"shared".as_slice(),
                Language::TypeScript,
                "ts".into(),
            ),
        ]);
        let after = SourceSnapshot::new([
            SourceFile::new(
                path("added.ts"),
                b"added".as_slice(),
                Language::TypeScript,
                "ts".into(),
            ),
            SourceFile::new(
                path("shared.ts"),
                b"changed without changing path".as_slice(),
                Language::TypeScript,
                "ts".into(),
            ),
        ]);

        let (removed, added) = unmatched_paths(&before, &after);
        assert_eq!(
            removed.into_iter().cloned().collect::<Vec<_>>(),
            vec![path("a.ts")]
        );
        assert_eq!(
            added.into_iter().cloned().collect::<Vec<_>>(),
            vec![path("added.ts")]
        );
    }
}
