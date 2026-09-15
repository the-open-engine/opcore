use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use crate::{
    limits::{
        MAX_IMPACT_EDGE_VISITS, MAX_OBSERVATION_PATHS, MAX_SENSE_OBSERVATIONS,
        MAX_SENSE_SAMPLE_PATHS,
    },
    path::RepoPath,
};

use super::model::{
    DirectDependencyDelta, EdgeKind, HighImpactChange, ImpactObservation, ImportantNodeObservation,
    InterfaceDelta, InterfaceFinding, ModuleInterface, Projection, SenseObservations,
};

#[derive(Clone, Copy)]
pub(super) struct MetricInputs<'a> {
    pub before: &'a Projection,
    pub after: &'a Projection,
    pub changed_paths: &'a BTreeSet<RepoPath>,
    pub continuity: &'a BTreeMap<RepoPath, RepoPath>,
    pub high_impact_threshold: usize,
    pub max_dependency_targets: usize,
    pub max_edge_selectors: usize,
    pub max_module_exports: usize,
    pub max_shape_members: usize,
}

#[derive(Default)]
pub(super) struct MetricResults {
    pub observations: SenseObservations,
    pub interface_findings: Vec<InterfaceFinding>,
}

pub(super) fn collect(inputs: MetricInputs<'_>) -> MetricResults {
    if inputs.changed_paths.is_empty() {
        return MetricResults::default();
    }
    let changed_paths = canonical_changed_paths(inputs.changed_paths, inputs.continuity);
    let before_outgoing = outgoing_counts(inputs.before, &changed_paths);
    let after_outgoing = outgoing_counts(inputs.after, &changed_paths);
    let dependency_deltas = changed_paths
        .iter()
        .map(|path| dependency_delta(&before_outgoing, &after_outgoing, &inputs.after.nodes, path))
        .collect();
    let (impact, high_impact_changes, impact_truncated) = impact_observations(
        inputs.before,
        inputs.after,
        &changed_paths,
        inputs.high_impact_threshold,
    );
    let (interfaces, important_nodes, interface_findings) = interface_metrics(
        inputs.before,
        inputs.after,
        &changed_paths,
        inputs.continuity,
        InterfacePolicy {
            dependency_targets_limit: inputs.max_dependency_targets,
            edge_selectors_limit: inputs.max_edge_selectors,
            module_exports_limit: inputs.max_module_exports,
            shape_members_limit: inputs.max_shape_members,
            important_fan_in: inputs.high_impact_threshold,
        },
    );
    MetricResults {
        observations: bound_observations(SenseObservations {
            dependency_deltas,
            impact,
            high_impact_changes,
            interfaces,
            important_nodes,
            impact_truncated,
            truncated: false,
        }),
        interface_findings,
    }
}

#[derive(Clone, Copy)]
struct InterfacePolicy {
    dependency_targets_limit: usize,
    edge_selectors_limit: usize,
    module_exports_limit: usize,
    shape_members_limit: usize,
    important_fan_in: usize,
}

fn interface_metrics(
    before: &Projection,
    after: &Projection,
    changed_paths: &BTreeSet<RepoPath>,
    continuity: &BTreeMap<RepoPath, RepoPath>,
    policy: InterfacePolicy,
) -> (
    Vec<InterfaceDelta>,
    Vec<ImportantNodeObservation>,
    Vec<InterfaceFinding>,
) {
    let context = InterfaceMetricContext::new(before, after, changed_paths, continuity, policy);
    let mut results = InterfaceMetricResults::with_capacity(changed_paths.len());
    for path in changed_paths {
        context.collect_path(path, &mut results);
    }
    results.findings.sort();
    (results.deltas, results.important_nodes, results.findings)
}

struct InterfaceMetricContext<'a> {
    before: &'a Projection,
    after: &'a Projection,
    before_index: InterfaceMetricIndex,
    after_index: InterfaceMetricIndex,
    before_dependency_fan_in: HashMap<RepoPath, usize>,
    after_dependency_fan_in: HashMap<RepoPath, usize>,
    prior_path_by_current: BTreeMap<&'a RepoPath, &'a RepoPath>,
    policy: InterfacePolicy,
}

impl<'a> InterfaceMetricContext<'a> {
    fn new(
        before: &'a Projection,
        after: &'a Projection,
        changed_paths: &BTreeSet<RepoPath>,
        continuity: &'a BTreeMap<RepoPath, RepoPath>,
        policy: InterfacePolicy,
    ) -> Self {
        Self {
            before,
            after,
            before_index: InterfaceMetricIndex::new(before, changed_paths),
            after_index: InterfaceMetricIndex::new(after, changed_paths),
            before_dependency_fan_in: dependency_fan_in(before, changed_paths),
            after_dependency_fan_in: dependency_fan_in(after, changed_paths),
            prior_path_by_current: continuity
                .iter()
                .map(|(before, after)| (after, before))
                .collect(),
            policy,
        }
    }

    fn collect_path(&self, path: &RepoPath, results: &mut InterfaceMetricResults) {
        let metrics = InterfacePathMetrics::new(self, path);
        if let Some(observation) = self.important_node(path, &metrics) {
            results.important_nodes.push(observation);
        }
        let delta = metrics.delta(path);
        if delta.changed() {
            results.deltas.push(delta);
        }
        self.collect_findings(path, &metrics, &mut results.findings);
    }

    fn important_node(
        &self,
        path: &RepoPath,
        metrics: &InterfacePathMetrics,
    ) -> Option<ImportantNodeObservation> {
        if !metrics.before.important && !metrics.after.important {
            return None;
        }
        Some(ImportantNodeObservation {
            path: path.clone(),
            before_path: self
                .prior_path_by_current
                .get(path)
                .map(|path| (*path).clone()),
            deleted: metrics.deleted,
            before_confirmed_dependency_fan_in: metrics.before.fan_in,
            after_confirmed_dependency_fan_in: metrics.after.fan_in,
            before_explicit_exports: metrics.before.exports,
            after_explicit_exports: metrics.after.exports,
            before_public_surface_authoritative: metrics.before.authoritative,
            after_public_surface_authoritative: metrics.after.authoritative,
            newly_important: !metrics.deleted
                && (crossed_importance_threshold(
                    metrics.before.fan_in,
                    metrics.after.fan_in,
                    self.policy.important_fan_in,
                ) || (metrics.before.authoritative
                    && metrics.after.authoritative
                    && introduced_violation(
                        metrics.before.exports,
                        metrics.after.exports,
                        self.policy.module_exports_limit,
                    ))),
            public_surface_changed: metrics.public_surface_changed,
        })
    }

    fn collect_findings(
        &self,
        path: &RepoPath,
        metrics: &InterfacePathMetrics,
        findings: &mut Vec<InterfaceFinding>,
    ) {
        let Some(after_module) = self.after.interfaces.get(path) else {
            return;
        };
        if is_test_like(path) || after_module.declaration_file {
            return;
        }
        self.collect_dependency_finding(path, metrics, findings);
        self.collect_module_finding(path, metrics, after_module, findings);
        self.collect_edge_findings(path, findings);
        self.collect_shape_findings(path, metrics, after_module, findings);
    }

    fn collect_dependency_finding(
        &self,
        path: &RepoPath,
        metrics: &InterfacePathMetrics,
        findings: &mut Vec<InterfaceFinding>,
    ) {
        if !introduced_violation(
            metrics.before.targets,
            metrics.after.targets,
            self.policy.dependency_targets_limit,
        ) {
            return;
        }
        findings.push(interface_finding(InterfaceFindingInput {
            code: "sense.interface.dependency_targets",
            path,
            target: None,
            entity: None,
            metric: "confirmed_dependency_targets",
            before: metrics.before.targets,
            after: metrics.after.targets,
            limit: self.policy.dependency_targets_limit,
        }));
    }

    fn collect_module_finding(
        &self,
        path: &RepoPath,
        metrics: &InterfacePathMetrics,
        after_module: &ModuleInterface,
        findings: &mut Vec<InterfaceFinding>,
    ) {
        if after_module.pure_barrel() {
            return;
        }
        if self.before.nodes.contains(path) && !metrics.before.authoritative {
            return;
        }
        if !introduced_violation(
            metrics.before.exports,
            metrics.after.exports,
            self.policy.module_exports_limit,
        ) {
            return;
        }
        findings.push(interface_finding(InterfaceFindingInput {
            code: "sense.interface.module_exports",
            path,
            target: None,
            entity: None,
            metric: "explicit_module_exports",
            before: metrics.before.exports,
            after: metrics.after.exports,
            limit: self.policy.module_exports_limit,
        }));
    }

    fn collect_edge_findings(&self, path: &RepoPath, findings: &mut Vec<InterfaceFinding>) {
        for (key, edge) in self
            .after
            .interface_edges
            .iter()
            .filter(|(key, _)| &key.from == path)
        {
            let after_count = edge.selectors.len();
            let before_edge = self.before.interface_edges.get(key);
            let before_count = before_edge.map_or(0, |edge| edge.selectors.len());
            if before_edge.is_some_and(|edge| edge.unknown_width) {
                continue;
            }
            if !introduced_violation(before_count, after_count, self.policy.edge_selectors_limit) {
                continue;
            }
            findings.push(interface_finding(InterfaceFindingInput {
                code: "sense.interface.edge_selectors",
                path,
                target: Some(key.to.clone()),
                entity: None,
                metric: edge_selector_metric(key.namespace),
                before: before_count,
                after: after_count,
                limit: self.policy.edge_selectors_limit,
            }));
        }
    }

    fn collect_shape_findings(
        &self,
        path: &RepoPath,
        metrics: &InterfacePathMetrics,
        after_module: &ModuleInterface,
        findings: &mut Vec<InterfaceFinding>,
    ) {
        if self.before.nodes.contains(path) && !metrics.before.authoritative {
            return;
        }
        let before_module = self.before.interfaces.get(path);
        for (shape, &after_count) in &after_module.shapes {
            let before_count = before_module
                .and_then(|module| module.shapes.get(shape))
                .copied()
                .unwrap_or(0);
            if !introduced_violation(before_count, after_count, self.policy.shape_members_limit) {
                continue;
            }
            findings.push(interface_finding(InterfaceFindingInput {
                code: "sense.interface.shape_members",
                path,
                target: None,
                entity: Some(shape.name.clone()),
                metric: shape_member_metric(shape.kind),
                before: before_count,
                after: after_count,
                limit: self.policy.shape_members_limit,
            }));
        }
    }
}

#[derive(Default)]
struct InterfaceMetricResults {
    deltas: Vec<InterfaceDelta>,
    important_nodes: Vec<ImportantNodeObservation>,
    findings: Vec<InterfaceFinding>,
}

impl InterfaceMetricResults {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            deltas: Vec::with_capacity(capacity),
            ..Self::default()
        }
    }
}

struct InterfacePathMetrics {
    deleted: bool,
    before: InterfacePathState,
    after: InterfacePathState,
    public_surface_changed: bool,
}

struct InterfacePathState {
    targets: usize,
    exports: usize,
    max_edge: usize,
    max_shape: usize,
    fan_in: usize,
    authoritative: bool,
    important: bool,
}

impl InterfacePathMetrics {
    fn new(context: &InterfaceMetricContext<'_>, path: &RepoPath) -> Self {
        let before_module = context.before.interfaces.get(path);
        let after_module = context.after.interfaces.get(path);
        let before_exports = export_count(before_module);
        let after_exports = export_count(after_module);
        let before_authoritative = public_surface_is_authoritative(before_module);
        let after_authoritative = public_surface_is_authoritative(after_module);
        let before_fan_in = fan_in_count(&context.before_dependency_fan_in, path);
        let after_fan_in = fan_in_count(&context.after_dependency_fan_in, path);
        Self {
            deleted: after_module.is_none(),
            before: InterfacePathState {
                targets: context.before_index.target_count(path),
                exports: before_exports,
                max_edge: context.before_index.max_edge_selectors(path),
                max_shape: max_shape_members(before_module),
                fan_in: before_fan_in,
                authoritative: before_authoritative,
                important: is_important(
                    before_fan_in,
                    before_exports,
                    before_authoritative,
                    context.policy,
                ),
            },
            after: InterfacePathState {
                targets: context.after_index.target_count(path),
                exports: after_exports,
                max_edge: context.after_index.max_edge_selectors(path),
                max_shape: max_shape_members(after_module),
                fan_in: after_fan_in,
                authoritative: after_authoritative,
                important: is_important(
                    after_fan_in,
                    after_exports,
                    after_authoritative,
                    context.policy,
                ),
            },
            public_surface_changed: public_surface_changed(
                context.before,
                path,
                before_module,
                after_module,
            ),
        }
    }

    fn delta(&self, path: &RepoPath) -> InterfaceDelta {
        InterfaceDelta {
            path: path.clone(),
            deleted: self.deleted,
            before_public_surface_authoritative: self.before.authoritative,
            after_public_surface_authoritative: self.after.authoritative,
            public_surface_changed: self.public_surface_changed,
            before_dependency_targets: self.before.targets,
            after_dependency_targets: self.after.targets,
            before_exports: self.before.exports,
            after_exports: self.after.exports,
            before_max_edge_selectors: self.before.max_edge,
            after_max_edge_selectors: self.after.max_edge,
            before_max_shape_members: self.before.max_shape,
            after_max_shape_members: self.after.max_shape,
        }
    }
}

impl InterfaceDelta {
    fn changed(&self) -> bool {
        self.deleted
            || self.public_surface_changed
            || self.before_dependency_targets != self.after_dependency_targets
            || self.before_exports != self.after_exports
            || self.before_max_edge_selectors != self.after_max_edge_selectors
            || self.before_max_shape_members != self.after_max_shape_members
    }
}

fn export_count(module: Option<&ModuleInterface>) -> usize {
    module.map_or(0, |module| module.exports.len())
}

fn max_shape_members(module: Option<&ModuleInterface>) -> usize {
    module.map_or(0, |module| {
        module.shapes.values().copied().max().unwrap_or(0)
    })
}

fn public_surface_is_authoritative(module: Option<&ModuleInterface>) -> bool {
    module.is_some_and(|module| module.public_surface_complete)
}

fn fan_in_count(counts: &HashMap<RepoPath, usize>, path: &RepoPath) -> usize {
    counts.get(path).copied().unwrap_or(0)
}

fn is_important(
    fan_in: usize,
    exports: usize,
    authoritative: bool,
    policy: InterfacePolicy,
) -> bool {
    fan_in >= policy.important_fan_in || (authoritative && exports > policy.module_exports_limit)
}

fn public_surface_changed(
    before: &Projection,
    path: &RepoPath,
    before_module: Option<&ModuleInterface>,
    after_module: Option<&ModuleInterface>,
) -> bool {
    let Some(after_module) = after_module.filter(|module| module.public_surface_complete) else {
        return false;
    };
    if !before.nodes.contains(path) {
        return !after_module.exports.is_empty() || !after_module.shapes.is_empty();
    }
    let Some(before_module) = before_module.filter(|module| module.public_surface_complete) else {
        return false;
    };
    before_module.exports != after_module.exports
        || before_module.shapes != after_module.shapes
        || before_module.shape_fingerprints != after_module.shape_fingerprints
}

fn edge_selector_metric(namespace: crate::model::InterfaceNamespace) -> &'static str {
    match namespace {
        crate::model::InterfaceNamespace::Runtime => "confirmed_runtime_edge_selectors",
        crate::model::InterfaceNamespace::TypeOnly => "confirmed_type_edge_selectors",
    }
}

fn shape_member_metric(kind: crate::model::InterfaceShapeKind) -> &'static str {
    match kind {
        crate::model::InterfaceShapeKind::Interface => "exported_interface_members",
        crate::model::InterfaceShapeKind::Struct => "exported_struct_fields",
        crate::model::InterfaceShapeKind::TypeLiteralAlias => "exported_type_literal_members",
    }
}

fn dependency_fan_in(
    projection: &Projection,
    changed_paths: &BTreeSet<RepoPath>,
) -> HashMap<RepoPath, usize> {
    let mut fan_in = changed_paths
        .iter()
        .cloned()
        .map(|path| (path, 0usize))
        .collect::<HashMap<_, _>>();
    for edge in projection
        .dependency_edges()
        .filter(|edge| edge.from != edge.to)
    {
        if let Some(count) = fan_in.get_mut(&edge.to) {
            *count = count.saturating_add(1);
        }
    }
    fan_in
}

struct InterfaceMetricIndex {
    targets: BTreeMap<RepoPath, usize>,
    max_edge_selectors: BTreeMap<RepoPath, usize>,
}

impl InterfaceMetricIndex {
    fn new(projection: &Projection, changed_paths: &BTreeSet<RepoPath>) -> Self {
        Self {
            targets: dependency_target_counts(projection, changed_paths),
            max_edge_selectors: max_edge_selector_counts(projection, changed_paths),
        }
    }

    fn target_count(&self, path: &RepoPath) -> usize {
        self.targets.get(path).copied().unwrap_or(0)
    }

    fn max_edge_selectors(&self, path: &RepoPath) -> usize {
        self.max_edge_selectors.get(path).copied().unwrap_or(0)
    }
}

fn dependency_target_counts(
    projection: &Projection,
    changed_paths: &BTreeSet<RepoPath>,
) -> BTreeMap<RepoPath, usize> {
    let mut counts = BTreeMap::<RepoPath, usize>::new();
    let mut current_from = None;
    let mut current_from_selected = false;
    let mut last_target = None;
    let mut target_count = 0usize;
    for edge in &projection.edges {
        if current_from != Some(&edge.from) {
            record_target_count(
                &mut counts,
                current_from,
                current_from_selected,
                target_count,
            );
            current_from = Some(&edge.from);
            current_from_selected = changed_paths.contains(&edge.from);
            last_target = None;
            target_count = 0;
        }
        if !current_from_selected || last_target == Some(&edge.to) {
            continue;
        }
        target_count = target_count.saturating_add(1);
        last_target = Some(&edge.to);
    }
    record_target_count(
        &mut counts,
        current_from,
        current_from_selected,
        target_count,
    );
    counts
}

fn record_target_count(
    counts: &mut BTreeMap<RepoPath, usize>,
    path: Option<&RepoPath>,
    selected: bool,
    count: usize,
) {
    if let Some(path) = path.filter(|_| selected) {
        counts.insert(path.clone(), count);
    }
}

fn max_edge_selector_counts(
    projection: &Projection,
    changed_paths: &BTreeSet<RepoPath>,
) -> BTreeMap<RepoPath, usize> {
    let mut counts = BTreeMap::<RepoPath, usize>::new();
    let mut current_from = None;
    let mut current_max = 0usize;
    for (key, edge) in &projection.interface_edges {
        if !changed_paths.contains(&key.from) {
            continue;
        }
        if current_from != Some(&key.from) {
            record_selector_max(&mut counts, current_from, current_max);
            current_from = Some(&key.from);
            current_max = 0;
        }
        current_max = current_max.max(edge.selectors.len());
    }
    record_selector_max(&mut counts, current_from, current_max);
    counts
}

fn record_selector_max(
    counts: &mut BTreeMap<RepoPath, usize>,
    path: Option<&RepoPath>,
    count: usize,
) {
    if let Some(path) = path {
        counts.insert(path.clone(), count);
    }
}

fn introduced_violation(before: usize, after: usize, limit: usize) -> bool {
    after > limit && after > before
}

fn crossed_importance_threshold(before: usize, after: usize, threshold: usize) -> bool {
    before < threshold && after >= threshold
}

struct InterfaceFindingInput<'a> {
    code: &'a str,
    path: &'a RepoPath,
    target: Option<RepoPath>,
    entity: Option<String>,
    metric: &'a str,
    before: usize,
    after: usize,
    limit: usize,
}

fn interface_finding(input: InterfaceFindingInput<'_>) -> InterfaceFinding {
    InterfaceFinding {
        code: input.code.into(),
        path: input.path.clone(),
        target: input.target,
        entity: input.entity,
        metric: input.metric.into(),
        before: input.before,
        after: input.after,
        limit: input.limit,
        basis: "confirmed".into(),
    }
}

fn is_test_like(path: &RepoPath) -> bool {
    let Some(path) = path.as_utf8() else {
        return false;
    };
    let lower = path.to_ascii_lowercase();
    if lower.ends_with("_test.go") {
        return true;
    }
    lower.split('/').any(|segment| {
        matches!(segment, "test" | "tests" | "__tests__")
            || segment.contains(".test.")
            || segment.contains(".spec.")
    })
}

fn canonical_changed_paths(
    changed_paths: &BTreeSet<RepoPath>,
    continuity: &BTreeMap<RepoPath, RepoPath>,
) -> BTreeSet<RepoPath> {
    changed_paths
        .iter()
        .map(|path| {
            continuity
                .get(path)
                .cloned()
                .unwrap_or_else(|| path.clone())
        })
        .collect()
}

fn dependency_delta(
    before: &BTreeMap<&RepoPath, OutgoingCounts>,
    after: &BTreeMap<&RepoPath, OutgoingCounts>,
    after_nodes: &BTreeSet<RepoPath>,
    path: &RepoPath,
) -> DirectDependencyDelta {
    let before = before.get(path).copied().unwrap_or_default();
    let after = after.get(path).copied().unwrap_or_default();
    DirectDependencyDelta {
        path: path.clone(),
        deleted: !after_nodes.contains(path),
        before_runtime: before.runtime,
        after_runtime: after.runtime,
        runtime_delta: signed_delta(after.runtime, before.runtime),
        before_type_only: before.type_only,
        after_type_only: after.type_only,
        type_only_delta: signed_delta(after.type_only, before.type_only),
        before_structural: before.structural,
        after_structural: after.structural,
        structural_delta: signed_delta(after.structural, before.structural),
    }
}

#[derive(Clone, Copy, Default)]
struct OutgoingCounts {
    runtime: usize,
    type_only: usize,
    structural: usize,
}

fn outgoing_counts<'a>(
    projection: &'a Projection,
    changed_paths: &BTreeSet<RepoPath>,
) -> BTreeMap<&'a RepoPath, OutgoingCounts> {
    let mut counts = BTreeMap::<&RepoPath, OutgoingCounts>::new();
    for edge in &projection.edges {
        if !changed_paths.contains(&edge.from) {
            continue;
        }
        let count = counts.entry(&edge.from).or_default();
        match edge.kind {
            EdgeKind::Runtime => {
                count.runtime = count.runtime.saturating_add(1);
            }
            EdgeKind::TypeOnly => {
                count.type_only = count.type_only.saturating_add(1);
            }
            EdgeKind::Structural => {
                count.structural = count.structural.saturating_add(1);
            }
        }
    }
    counts
}

fn signed_delta(after: usize, before: usize) -> i64 {
    i64::try_from(after).unwrap_or(i64::MAX) - i64::try_from(before).unwrap_or(i64::MAX)
}

fn impact_observations(
    before: &Projection,
    after: &Projection,
    changed_paths: &BTreeSet<RepoPath>,
    high_impact_threshold: usize,
) -> (Vec<ImpactObservation>, Vec<HighImpactChange>, bool) {
    let before_reverse = reverse_adjacency(before);
    let after_reverse = reverse_adjacency(after);
    let mut impact = Vec::with_capacity(changed_paths.len());
    let mut high_impact = Vec::new();
    let mut sample_budget = MAX_SENSE_SAMPLE_PATHS;
    let mut edge_visit_budget = MAX_IMPACT_EDGE_VISITS;
    let mut impact_truncated = false;
    for path in changed_paths {
        let deleted = !after.nodes.contains(path);
        let reverse = if deleted {
            &before_reverse
        } else {
            &after_reverse
        };
        let direct_count = reverse.get(path).map_or(0, BTreeSet::len);
        let (reachable, reachable_complete) =
            reverse_reachable(path, reverse, &mut edge_visit_budget);
        impact_truncated |= !reachable_complete;
        if direct_count >= high_impact_threshold {
            high_impact.push(HighImpactChange {
                path: path.clone(),
                confirmed_direct_dependents: direct_count,
                threshold: high_impact_threshold,
            });
        }
        let sample_count = reachable
            .len()
            .min(MAX_OBSERVATION_PATHS)
            .min(sample_budget);
        sample_budget = sample_budget.saturating_sub(sample_count);
        impact.push(ImpactObservation {
            path: path.clone(),
            deleted,
            confirmed_direct_dependents: direct_count,
            confirmed_reachable_dependents: reachable.len(),
            reachable_count_is_lower_bound: !reachable_complete,
            sample: reachable.iter().take(sample_count).cloned().collect(),
            sample_truncated: reachable.len() > sample_count,
        });
    }
    (impact, high_impact, impact_truncated)
}

fn reverse_adjacency(projection: &Projection) -> BTreeMap<RepoPath, BTreeSet<RepoPath>> {
    let mut reverse = projection
        .nodes
        .iter()
        .cloned()
        .map(|path| (path, BTreeSet::new()))
        .collect::<BTreeMap<_, _>>();
    for edge in &projection.edges {
        if edge.from != edge.to
            && let Some(dependents) = reverse.get_mut(&edge.to)
        {
            dependents.insert(edge.from.clone());
        }
    }
    reverse
}

fn reverse_reachable(
    path: &RepoPath,
    reverse: &BTreeMap<RepoPath, BTreeSet<RepoPath>>,
    edge_visit_budget: &mut usize,
) -> (BTreeSet<RepoPath>, bool) {
    let direct = reverse.get(path).into_iter().flatten();
    if *edge_visit_budget == 0 {
        let reachable = direct.cloned().collect::<BTreeSet<_>>();
        return (reachable, reverse.get(path).is_none_or(BTreeSet::is_empty));
    }
    let mut visited = BTreeSet::from([path.clone()]);
    let mut reachable = BTreeSet::new();
    let mut queue = direct.cloned().collect::<VecDeque<_>>();
    while let Some(current) = queue.pop_front() {
        if !visited.insert(current.clone()) {
            continue;
        }
        reachable.insert(current.clone());
        for dependent in reverse.get(&current).into_iter().flatten() {
            if *edge_visit_budget == 0 {
                return (reachable, false);
            }
            *edge_visit_budget = edge_visit_budget.saturating_sub(1);
            queue.push_back(dependent.clone());
        }
    }
    (reachable, true)
}

fn bound_observations(mut observations: SenseObservations) -> SenseObservations {
    let mut lengths = [
        observations.dependency_deltas.len(),
        observations.impact.len(),
        observations.high_impact_changes.len(),
        observations.interfaces.len(),
        observations.important_nodes.len(),
    ];
    let original_total = lengths.iter().sum::<usize>();
    while lengths.iter().sum::<usize>() > MAX_SENSE_OBSERVATIONS {
        let index = lengths
            .iter()
            .enumerate()
            .max_by_key(|(index, length)| (**length, std::cmp::Reverse(*index)))
            .map_or(0, |(index, _)| index);
        lengths[index] = lengths[index].saturating_sub(1);
    }
    observations.dependency_deltas.truncate(lengths[0]);
    observations.impact.truncate(lengths[1]);
    observations.high_impact_changes.truncate(lengths[2]);
    observations.interfaces.truncate(lengths[3]);
    observations.important_nodes.truncate(lengths[4]);
    observations.truncated = original_total > MAX_SENSE_OBSERVATIONS;
    observations
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{
            InterfaceExportNamespace, InterfaceNamespace, InterfaceSelector, InterfaceSelectorKind,
            InterfaceShapeKind,
        },
        sense::model::{
            DependencyEdge, InterfaceEdge, InterfaceEdgeKey, InterfaceExportKey, InterfaceShapeKey,
            ModuleInterface, Projection,
        },
    };

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

    fn module(exports: usize, shape_members: Option<usize>, complete: bool) -> ModuleInterface {
        let mut module = ModuleInterface {
            has_local_exports: exports > 0,
            public_surface_complete: complete,
            ..ModuleInterface::default()
        };
        module.exports = (0..exports)
            .map(|index| InterfaceExportKey {
                namespace: InterfaceExportNamespace::Value,
                name: format!("export_{index:02}"),
            })
            .collect();
        if let Some(member_count) = shape_members {
            let key = InterfaceShapeKey {
                kind: InterfaceShapeKind::Interface,
                name: "PublicShape".into(),
            };
            module.shapes.insert(key.clone(), member_count);
            module
                .shape_fingerprints
                .insert(key, format!("shape-{member_count}"));
        }
        module
    }

    fn selectors(count: usize) -> BTreeSet<InterfaceSelector> {
        (0..count)
            .map(|index| InterfaceSelector {
                kind: InterfaceSelectorKind::Named,
                name: format!("name_{index:02}"),
            })
            .collect()
    }

    fn interface_policy() -> InterfacePolicy {
        InterfacePolicy {
            dependency_targets_limit: 20,
            edge_selectors_limit: 8,
            module_exports_limit: 20,
            shape_members_limit: 20,
            important_fan_in: 10,
        }
    }

    #[test]
    fn reports_dependency_deltas_and_reverse_impact_in_the_correct_view() {
        let before = projection(
            &["a.ts", "b.ts", "deleted.ts", "x.ts", "y.ts"],
            vec![
                edge("a.ts", "b.ts", EdgeKind::Runtime),
                edge("x.ts", "a.ts", EdgeKind::Runtime),
                edge("y.ts", "x.ts", EdgeKind::TypeOnly),
                edge("x.ts", "deleted.ts", EdgeKind::Runtime),
            ],
        );
        let after = projection(
            &["a.ts", "b.ts", "c.ts", "x.ts", "y.ts"],
            vec![
                edge("a.ts", "b.ts", EdgeKind::Runtime),
                edge("a.ts", "c.ts", EdgeKind::TypeOnly),
                edge("x.ts", "a.ts", EdgeKind::Runtime),
                edge("y.ts", "x.ts", EdgeKind::TypeOnly),
            ],
        );
        let changed_paths = BTreeSet::from([path("a.ts"), path("deleted.ts")]);
        let continuity = BTreeMap::new();
        let observations = collect(MetricInputs {
            before: &before,
            after: &after,
            changed_paths: &changed_paths,
            continuity: &continuity,
            high_impact_threshold: 1,
            max_dependency_targets: 20,
            max_edge_selectors: 8,
            max_module_exports: 20,
            max_shape_members: 20,
        })
        .observations;

        assert_eq!(observations.dependency_deltas[0].runtime_delta, 0);
        assert_eq!(observations.dependency_deltas[0].type_only_delta, 1);
        assert_eq!(observations.impact[0].confirmed_direct_dependents, 1);
        assert_eq!(observations.impact[0].confirmed_reachable_dependents, 2);
        assert!(observations.impact[1].deleted);
        assert_eq!(observations.impact[1].confirmed_direct_dependents, 1);
        assert_eq!(observations.impact[1].confirmed_reachable_dependents, 2);
        assert_eq!(observations.high_impact_changes.len(), 2);
    }

    #[test]
    fn impact_budget_returns_an_explicit_deterministic_lower_bound() {
        let reverse = BTreeMap::from([
            (path("a.ts"), BTreeSet::from([path("b.ts")])),
            (path("b.ts"), BTreeSet::from([path("c.ts")])),
            (path("c.ts"), BTreeSet::new()),
        ]);
        let mut budget = 0;
        let (reachable, complete) = reverse_reachable(&path("a.ts"), &reverse, &mut budget);
        assert!(!complete);
        assert_eq!(reachable, BTreeSet::from([path("b.ts")]));
    }

    #[test]
    fn introduced_interface_limits_emit_each_confirmed_finding() {
        let api = path("src/api.ts");
        let targets = (0..21)
            .map(|index| path(&format!("src/target-{index:02}.ts")))
            .collect::<Vec<_>>();
        let edge_key = InterfaceEdgeKey {
            from: api.clone(),
            to: targets[0].clone(),
            namespace: InterfaceNamespace::Runtime,
        };
        let mut before = Projection::default();
        before.nodes.insert(api.clone());
        before.nodes.extend(targets.iter().cloned());
        before
            .edges
            .extend(targets[..20].iter().map(|target| DependencyEdge {
                from: api.clone(),
                to: target.clone(),
                kind: EdgeKind::Runtime,
            }));
        before
            .interfaces
            .insert(api.clone(), module(20, Some(20), true));
        before.interface_edges.insert(
            edge_key.clone(),
            InterfaceEdge {
                selectors: selectors(8),
                unknown_width: false,
            },
        );
        let mut after = before.clone();
        after.edges.insert(DependencyEdge {
            from: api.clone(),
            to: targets[20].clone(),
            kind: EdgeKind::Runtime,
        });
        after
            .interfaces
            .insert(api.clone(), module(21, Some(21), true));
        after.interface_edges.insert(
            edge_key,
            InterfaceEdge {
                selectors: selectors(9),
                unknown_width: false,
            },
        );

        let (_, _, findings) = interface_metrics(
            &before,
            &after,
            &BTreeSet::from([api]),
            &BTreeMap::new(),
            interface_policy(),
        );
        assert_eq!(
            findings
                .iter()
                .map(|finding| finding.code.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                "sense.interface.dependency_targets",
                "sense.interface.edge_selectors",
                "sense.interface.module_exports",
                "sense.interface.shape_members",
            ])
        );
        assert!(findings.iter().all(|finding| finding.basis == "confirmed"));
    }

    #[test]
    fn unknown_before_width_never_fabricates_an_introduced_interface_finding() {
        let api = path("src/api.ts");
        let target = path("src/target.ts");
        let edge_key = InterfaceEdgeKey {
            from: api.clone(),
            to: target.clone(),
            namespace: InterfaceNamespace::Runtime,
        };
        let mut before = projection(
            &["src/api.ts", "src/target.ts"],
            vec![edge("src/api.ts", "src/target.ts", EdgeKind::Runtime)],
        );
        before
            .interfaces
            .insert(api.clone(), module(0, None, false));
        before.interface_edges.insert(
            edge_key.clone(),
            InterfaceEdge {
                selectors: BTreeSet::new(),
                unknown_width: true,
            },
        );
        let mut after = before.clone();
        after
            .interfaces
            .insert(api.clone(), module(21, Some(21), true));
        after.interface_edges.insert(
            edge_key,
            InterfaceEdge {
                selectors: selectors(9),
                unknown_width: false,
            },
        );

        let (_, important, findings) = interface_metrics(
            &before,
            &after,
            &BTreeSet::from([api]),
            &BTreeMap::new(),
            interface_policy(),
        );
        assert!(findings.is_empty());
        assert_eq!(important.len(), 1);
        assert!(!important[0].newly_important);
    }

    #[test]
    fn new_authoritative_surface_can_block_but_exempt_surfaces_do_not() {
        let mut after = Projection::default();
        let api = path("src/api.ts");
        let test = path("src/api.test.ts");
        let declaration = path("src/types.d.ts");
        let barrel = path("src/index.ts");
        after.nodes.extend([
            api.clone(),
            test.clone(),
            declaration.clone(),
            barrel.clone(),
        ]);
        after
            .interfaces
            .insert(api.clone(), module(21, Some(21), true));
        after
            .interfaces
            .insert(test.clone(), module(21, Some(21), true));
        let mut declaration_module = module(21, Some(21), true);
        declaration_module.declaration_file = true;
        after
            .interfaces
            .insert(declaration.clone(), declaration_module);
        let mut barrel_module = module(21, None, true);
        barrel_module.has_local_exports = false;
        barrel_module.has_reexports = true;
        after.interfaces.insert(barrel.clone(), barrel_module);

        let (_, _, findings) = interface_metrics(
            &Projection::default(),
            &after,
            &BTreeSet::from([api.clone(), test, declaration, barrel]),
            &BTreeMap::new(),
            interface_policy(),
        );
        assert_eq!(findings.len(), 2);
        assert!(findings.iter().all(|finding| finding.path == api));
        assert_eq!(
            findings
                .iter()
                .map(|finding| finding.code.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                "sense.interface.module_exports",
                "sense.interface.shape_members",
            ])
        );
    }

    #[test]
    fn important_nodes_cover_new_importance_surface_change_rename_and_deletion() {
        let core = path("src/core.ts");
        let mut before = Projection::default();
        before.nodes.insert(core.clone());
        before
            .interfaces
            .insert(core.clone(), module(1, None, true));
        for index in 0..9 {
            let importer = path(&format!("src/importer-{index}.ts"));
            before.nodes.insert(importer.clone());
            before.edges.insert(DependencyEdge {
                from: importer,
                to: core.clone(),
                kind: EdgeKind::Runtime,
            });
        }
        let mut after = before.clone();
        let importer = path("src/importer-9.ts");
        after.nodes.insert(importer.clone());
        after.edges.insert(DependencyEdge {
            from: importer,
            to: core.clone(),
            kind: EdgeKind::Runtime,
        });
        let mut changed_surface = module(1, None, true);
        changed_surface.exports = BTreeSet::from([InterfaceExportKey {
            namespace: InterfaceExportNamespace::Value,
            name: "renamed_export".into(),
        }]);
        after.interfaces.insert(core.clone(), changed_surface);

        let (_, important, _) = interface_metrics(
            &before,
            &after,
            &BTreeSet::from([core.clone()]),
            &BTreeMap::new(),
            interface_policy(),
        );
        assert_eq!(important.len(), 1);
        assert!(important[0].newly_important);
        assert!(important[0].public_surface_changed);
        assert_eq!(important[0].before_confirmed_dependency_fan_in, 9);
        assert_eq!(important[0].after_confirmed_dependency_fan_in, 10);

        let old = path("src/old-core.ts");
        let continuity = BTreeMap::from([(old.clone(), core.clone())]);
        let (_, renamed, _) = interface_metrics(
            &after,
            &after,
            &BTreeSet::from([core.clone()]),
            &continuity,
            interface_policy(),
        );
        assert_eq!(renamed[0].before_path, Some(old));
        assert!(!renamed[0].newly_important);
        assert!(!renamed[0].public_surface_changed);

        let mut deleted_after = after.clone();
        deleted_after.nodes.remove(&core);
        deleted_after.interfaces.remove(&core);
        deleted_after.edges.retain(|edge| edge.to != core);
        let (_, deleted, _) = interface_metrics(
            &after,
            &deleted_after,
            &BTreeSet::from([core]),
            &BTreeMap::new(),
            interface_policy(),
        );
        assert_eq!(deleted.len(), 1);
        assert!(deleted[0].deleted);
        assert_eq!(deleted[0].before_confirmed_dependency_fan_in, 10);
        assert_eq!(deleted[0].after_confirmed_dependency_fan_in, 0);
    }

    #[test]
    fn important_node_surface_change_includes_same_size_shape_fingerprint_changes() {
        let core = path("src/core.ts");
        let mut before = Projection::default();
        before.nodes.insert(core.clone());
        before
            .interfaces
            .insert(core.clone(), module(1, Some(2), true));
        for index in 0..10 {
            let importer = path(&format!("src/importer-{index}.ts"));
            before.nodes.insert(importer.clone());
            before.edges.insert(DependencyEdge {
                from: importer,
                to: core.clone(),
                kind: EdgeKind::Runtime,
            });
        }
        let mut after = before.clone();
        let mut changed_shape = module(1, Some(2), true);
        *changed_shape
            .shape_fingerprints
            .values_mut()
            .next()
            .unwrap() = "changed-shape".into();
        after.interfaces.insert(core.clone(), changed_shape);

        let (_, important, _) = interface_metrics(
            &before,
            &after,
            &BTreeSet::from([core]),
            &BTreeMap::new(),
            interface_policy(),
        );

        assert_eq!(important.len(), 1);
        assert!(!important[0].newly_important);
        assert!(important[0].public_surface_changed);
    }

    #[test]
    fn ordinary_interface_delta_retains_authoritative_same_size_surface_churn() {
        let core = path("src/core.ts");
        let mut before = Projection::default();
        before.nodes.insert(core.clone());
        before
            .interfaces
            .insert(core.clone(), module(1, Some(2), true));
        let mut after = before.clone();
        let mut changed = module(1, Some(2), true);
        changed.exports = BTreeSet::from([InterfaceExportKey {
            namespace: InterfaceExportNamespace::Value,
            name: "renamed_export".into(),
        }]);
        *changed.shape_fingerprints.values_mut().next().unwrap() = "changed-shape".into();
        after.interfaces.insert(core.clone(), changed);

        let (deltas, important, findings) = interface_metrics(
            &before,
            &after,
            &BTreeSet::from([core]),
            &BTreeMap::new(),
            interface_policy(),
        );

        assert!(important.is_empty());
        assert!(findings.is_empty());
        assert_eq!(deltas.len(), 1);
        assert!(deltas[0].before_public_surface_authoritative);
        assert!(deltas[0].after_public_surface_authoritative);
        assert!(deltas[0].public_surface_changed);
        assert_eq!(deltas[0].before_exports, deltas[0].after_exports);
        assert_eq!(
            deltas[0].before_max_shape_members,
            deltas[0].after_max_shape_members
        );
    }

    #[test]
    fn important_node_observations_share_the_request_wide_output_bound() {
        let observation = ImportantNodeObservation {
            path: path("src/core.ts"),
            before_path: None,
            deleted: false,
            before_confirmed_dependency_fan_in: 10,
            after_confirmed_dependency_fan_in: 10,
            before_explicit_exports: 1,
            after_explicit_exports: 1,
            before_public_surface_authoritative: true,
            after_public_surface_authoritative: true,
            newly_important: false,
            public_surface_changed: false,
        };
        let bounded = bound_observations(SenseObservations {
            important_nodes: vec![observation; MAX_SENSE_OBSERVATIONS + 1],
            ..SenseObservations::default()
        });
        assert_eq!(bounded.important_nodes.len(), MAX_SENSE_OBSERVATIONS);
        assert!(bounded.truncated);
    }
}
