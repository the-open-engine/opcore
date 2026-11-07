use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    ops::Range,
    rc::Rc,
    sync::Arc,
};

use crate::{
    facts,
    identity::{FileFactKey, hash_domain},
    limits::{
        DEDUP_REGION_KGRAM_TOKENS, MAX_DEDUP_DECODE_BYTES, MAX_DEDUP_TOKEN_COMPARISONS,
        MAX_OBSERVATION_PATHS, MAX_REGION_FINGERPRINTS_PER_BATCH, MAX_REGION_FINGERPRINTS_PER_FILE,
        MIN_DEDUP_REGION_TOKENS,
    },
    model::{FingerprintExtractionStatus, RegionFingerprintFacts, SourceFile, SourceRange},
    path::RepoPath,
    source::snapshot::SourceSnapshot,
};

mod batches;
mod evidence;
mod view;

use evidence::DecodedTokens;

use super::{
    DedupLimitStage, DuplicateKind, DuplicateOccurrence, FactKeyLookup, FingerprintCoverage,
    IntroducedDuplicate, SenseIssue, SenseView, bound_occurrences, lookup_file_fact, path_counts,
    paths_with_growth,
};

type AnchorKey = (u64, u64);
#[derive(Clone)]
enum EvidenceState {
    Validated,
    Decoded(Arc<DecodedTokens>),
    Malformed,
}

impl EvidenceState {
    fn decoded(self) -> Option<Arc<DecodedTokens>> {
        match self {
            Self::Decoded(decoded) => Some(decoded),
            Self::Validated | Self::Malformed => None,
        }
    }
}

struct DecodedEvidence {
    states: BTreeMap<FileFactKey, EvidenceState>,
    orders: BTreeMap<FileFactKey, Arc<[u16]>>,
    recent: Vec<FileFactKey>,
    decode_remaining: usize,
    decode_limit: usize,
    decode_exhausted: bool,
    #[cfg(test)]
    live: Arc<evidence::LiveDecodes>,
    #[cfg(test)]
    decodes: usize,
}

impl Default for DecodedEvidence {
    fn default() -> Self {
        Self {
            states: BTreeMap::new(),
            orders: BTreeMap::new(),
            recent: Vec::new(),
            decode_remaining: MAX_DEDUP_DECODE_BYTES,
            decode_limit: MAX_DEDUP_DECODE_BYTES,
            decode_exhausted: false,
            #[cfg(test)]
            decodes: 0,
            #[cfg(test)]
            live: Arc::default(),
        }
    }
}

impl DecodedEvidence {
    fn state(
        &mut self,
        fact_key: FileFactKey,
        source: &SourceFile,
        facts: &RegionFingerprintFacts,
        retain: bool,
    ) -> EvidenceState {
        self.states.entry(fact_key).or_insert_with(|| {
            if DecodedTokens::validate(source, facts) {
                EvidenceState::Validated
            } else {
                EvidenceState::Malformed
            }
        });
        if retain && matches!(self.states[&fact_key], EvidenceState::Validated) {
            let cost = DecodedTokens::decode_cost(source, facts);
            if cost > self.decode_remaining {
                self.decode_exhausted = true;
                return EvidenceState::Validated;
            }
            self.decode_remaining -= cost;
            self.touch(fact_key);
            let decoded = DecodedTokens::decode(source, facts);
            #[cfg(test)]
            let decoded = decoded.map(|decoded| decoded.tracked(Arc::clone(&self.live)));
            let decoded = decoded
                .map(Arc::new)
                .map_or(EvidenceState::Malformed, EvidenceState::Decoded);
            self.states.insert(fact_key, decoded);
            #[cfg(test)]
            {
                self.decodes += 1;
            }
        }
        if retain && matches!(self.states[&fact_key], EvidenceState::Decoded(_)) {
            self.touch(fact_key);
        }
        self.states[&fact_key].clone()
    }

    fn touch(&mut self, fact_key: FileFactKey) {
        // Exact comparisons need two files. Evict before decoding the next file.
        if let Some(position) = self.recent.iter().position(|key| *key == fact_key) {
            self.recent.remove(position);
        } else if self.recent.len() == 2 {
            let expired = self.recent.remove(0);
            self.states.insert(expired, EvidenceState::Validated);
        }
        self.recent.push(fact_key);
    }

    fn anchor_order(
        &mut self,
        key: FileFactKey,
        facts: &RegionFingerprintFacts,
    ) -> Option<Arc<[u16]>> {
        if let Some(order) = self.orders.get(&key) {
            return Some(Arc::clone(order));
        }
        let mut order = (0..facts.anchors.len())
            .map(u16::try_from)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        order.sort_by_key(|index| {
            let anchor = &facts.anchors[usize::from(*index)];
            (anchor.hash_one, anchor.hash_two)
        });
        let order: Arc<[u16]> = order.into();
        self.orders.insert(key, Arc::clone(&order));
        Some(order)
    }
}

struct RegionViewInputs<'source, 'request> {
    view: SenseView,
    snapshot: &'source SourceSnapshot,
    file_facts: &'request facts::FactMap,
    fact_keys: &'request FactKeyLookup,
    continuity: &'request BTreeMap<RepoPath, RepoPath>,
    decoded_evidence: Rc<RefCell<DecodedEvidence>>,
}

#[derive(Clone, Copy)]
pub(super) struct RegionInputs<'a> {
    pub suppressed_paths: &'a BTreeSet<RepoPath>,
    pub callable_findings: &'a [IntroducedDuplicate],
    pub finding_limit: usize,
    pub changed_paths: &'a BTreeSet<RepoPath>,
    pub continuity: &'a BTreeMap<RepoPath, RepoPath>,
    pub before: &'a SourceSnapshot,
    pub after: &'a SourceSnapshot,
    pub file_facts: &'a facts::FactMap,
    pub fact_keys: &'a FactKeyLookup,
}

pub(super) struct RegionResult {
    pub findings: Vec<IntroducedDuplicate>,
    pub findings_truncated: bool,
    pub before: RegionCoverage,
    pub after: RegionCoverage,
    pub comparison_issues: Vec<SenseIssue>,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct RegionCoverage {
    anchors: usize,
    tokens: usize,
    request_truncated: bool,
    malformed_evidence: bool,
}

impl RegionCoverage {
    fn include_comparison(&mut self, comparison: &ComparisonState, view: SenseView) {
        if comparison.views.contains(&view) {
            self.request_truncated |=
                comparison.limit_reached || comparison.decode_processed.is_some();
            self.malformed_evidence |= comparison.malformed_evidence;
        }
    }

    pub(super) fn apply(self, coverage: &mut FingerprintCoverage) {
        coverage.region_anchors = self.anchors;
        coverage.region_tokens = self.tokens;
        coverage.request_truncated |= self.request_truncated;
        coverage.malformed_evidence |= self.malformed_evidence;
    }
}

pub(super) fn region_findings(inputs: RegionInputs<'_>) -> RegionResult {
    region_findings_bounded(inputs, MAX_REGION_FINGERPRINTS_PER_BATCH)
}

fn region_findings_bounded(inputs: RegionInputs<'_>, anchor_limit: usize) -> RegionResult {
    let decoded = Rc::new(RefCell::new(DecodedEvidence::default()));
    let mut state = EvaluationState::default();
    let before = RegionView::new(&RegionViewInputs {
        view: SenseView::Before,
        snapshot: inputs.before,
        file_facts: inputs.file_facts,
        fact_keys: inputs.fact_keys,
        continuity: inputs.continuity,
        decoded_evidence: Rc::clone(&decoded),
    });
    let after = RegionView::new(&RegionViewInputs {
        view: SenseView::After,
        snapshot: inputs.after,
        file_facts: inputs.file_facts,
        fact_keys: inputs.fact_keys,
        continuity: &BTreeMap::new(),
        decoded_evidence: decoded,
    });
    state.comparison.observe_malformed_view(&before);
    state.comparison.observe_malformed_view(&after);
    state.before = before.coverage(&state.comparison);
    state.after = after.coverage(&state.comparison);
    if !state.comparison.incomplete {
        batches::evaluate(inputs, anchor_limit, &mut [before, after], &mut state);
    }
    state
        .before
        .include_comparison(&state.comparison, SenseView::Before);
    state
        .after
        .include_comparison(&state.comparison, SenseView::After);
    state.issues.extend(state.comparison.issues());
    RegionResult {
        findings: state.findings,
        findings_truncated: state.comparison.findings_truncated,
        before: state.before,
        after: state.after,
        comparison_issues: state.issues,
    }
}

pub(super) fn validate_identical_snapshot(
    snapshot: &SourceSnapshot,
    file_facts: &facts::FactMap,
    fact_keys: &FactKeyLookup,
) -> (RegionCoverage, Vec<SenseIssue>) {
    let decoded_evidence = Rc::new(RefCell::new(DecodedEvidence::default()));
    let view = RegionView::new(&RegionViewInputs {
        view: SenseView::Before,
        snapshot,
        file_facts,
        fact_keys,
        continuity: &BTreeMap::new(),
        decoded_evidence,
    });
    let mut comparison = ComparisonState::default();
    comparison.observe_malformed_view(&view);
    if comparison.malformed_evidence {
        comparison.views.insert(SenseView::After);
    }
    let coverage = view.coverage(&comparison);
    (coverage, comparison.issues())
}

#[derive(Clone, Copy)]
struct EvaluationContext<'view, 'data> {
    inputs: RegionInputs<'data>,
    before: &'view RegionView<'data>,
    after: &'view RegionView<'data>,
}

#[derive(Default)]
struct EvaluationState {
    comparison: ComparisonState,
    before: RegionCoverage,
    after: RegionCoverage,
    issues: Vec<SenseIssue>,
    findings: Vec<IntroducedDuplicate>,
    reported_classes: BTreeSet<(String, String)>,
    covered: BTreeMap<usize, Vec<Range<usize>>>,
}

impl EvaluationState {
    fn evaluate_group(
        &mut self,
        context: EvaluationContext<'_, '_>,
        family: &'static str,
        anchor: AnchorKey,
        after_occurrences: &[AnchorOccurrence],
    ) {
        if !anchor_class_may_be_introduced(AnchorClassInputs {
            after: after_occurrences,
            after_view: context.after,
            changed_paths: context.inputs.changed_paths,
            suppressed_paths: context.inputs.suppressed_paths,
        }) {
            return;
        }
        for seed in after_occurrences {
            self.evaluate_seed(context, family, anchor, after_occurrences, *seed);
            if self.comparison.incomplete {
                break;
            }
        }
    }

    fn evaluate_seed(
        &mut self,
        context: EvaluationContext<'_, '_>,
        family: &'static str,
        anchor: AnchorKey,
        occurrences: &[AnchorOccurrence],
        seed: AnchorOccurrence,
    ) {
        let seed_path = &context.after.files[seed.file].path;
        if !context.inputs.changed_paths.contains(seed_path)
            || context.inputs.suppressed_paths.contains(seed_path)
            || interval_contains(&self.covered, seed.file, seed.token_index)
        {
            return;
        }
        let candidates = candidate_regions(
            context.after,
            anchor,
            seed,
            occurrences,
            &mut self.comparison,
        );
        let Some(class) = self.best_class(context, family, candidates) else {
            return;
        };
        mark_covered(&mut self.covered, &class.after_occurrences);
        if !self
            .reported_classes
            .insert((family.to_owned(), class.digest.clone()))
        {
            return;
        }
        if self.findings.len() >= context.inputs.finding_limit {
            self.comparison.findings_truncated = true;
            return;
        }
        self.findings.push(class.into_finding());
    }

    fn best_class(
        &mut self,
        context: EvaluationContext<'_, '_>,
        family: &'static str,
        candidates: Vec<Candidate>,
    ) -> Option<ExactClass> {
        let mut best = None;
        for candidate in candidates {
            let Some(class) = exact_class(
                ExactClassInputs {
                    before: context.before,
                    after: context.after,
                    family,
                    changed_paths: context.inputs.changed_paths,
                    suppressed_paths: context.inputs.suppressed_paths,
                    callable_findings: context.inputs.callable_findings,
                },
                candidate,
                &mut self.comparison,
            ) else {
                if self.comparison.incomplete {
                    break;
                }
                continue;
            };
            if class_precedes(best.as_ref(), &class) {
                best = Some(class);
            }
        }
        best
    }
}

fn class_precedes(current: Option<&ExactClass>, candidate: &ExactClass) -> bool {
    current.is_none_or(|current| {
        (candidate.after_occurrences.len(), candidate.token_count)
            > (current.after_occurrences.len(), current.token_count)
    })
}

#[derive(Clone, Copy)]
struct AnchorClassInputs<'view, 'data> {
    after: &'view [AnchorOccurrence],
    after_view: &'view RegionView<'data>,
    changed_paths: &'data BTreeSet<RepoPath>,
    suppressed_paths: &'data BTreeSet<RepoPath>,
}

fn anchor_class_may_be_introduced(inputs: AnchorClassInputs<'_, '_>) -> bool {
    inputs.after.len() >= 2
        && has_distinct_anchors(inputs.after)
        && inputs.after.iter().any(|occurrence| {
            let path = &inputs.after_view.files[occurrence.file].path;
            inputs.changed_paths.contains(path) && !inputs.suppressed_paths.contains(path)
        })
}

fn has_distinct_anchors(occurrences: &[AnchorOccurrence]) -> bool {
    let Some(first) = occurrences.first() else {
        return false;
    };
    occurrences[1..]
        .iter()
        .any(|candidate| distinct_anchor(*first, *candidate))
}

#[derive(Clone, Copy)]
struct Candidate {
    file: usize,
    start: usize,
    end: usize,
    anchor: AnchorKey,
    anchor_offset: usize,
}

impl Candidate {
    fn len(self) -> usize {
        self.end.saturating_sub(self.start)
    }
}

#[derive(Clone, Copy)]
struct TokenLocation {
    file: usize,
    token: usize,
}

impl TokenLocation {
    fn offset(self, offset: usize) -> Self {
        Self {
            token: self.token.saturating_add(offset),
            ..self
        }
    }

    fn prior(self) -> Self {
        Self {
            token: self.token.saturating_sub(1),
            ..self
        }
    }
}

#[derive(Clone, Copy)]
struct TokenPair<'view, 'data> {
    left_view: &'view RegionView<'data>,
    left: TokenLocation,
    right_view: &'view RegionView<'data>,
    right: TokenLocation,
}

struct RegionPair<'view, 'data> {
    left_view: &'view RegionView<'data>,
    left_file: usize,
    left: Range<usize>,
    right_view: &'view RegionView<'data>,
    right_file: usize,
    right: Range<usize>,
}

impl<'view, 'data> TokenPair<'view, 'data> {
    fn same_view(
        view: &'view RegionView<'data>,
        left: TokenLocation,
        right: TokenLocation,
    ) -> Self {
        Self {
            left_view: view,
            left,
            right_view: view,
            right,
        }
    }
}

fn candidate_regions(
    view: &RegionView<'_>,
    anchor: AnchorKey,
    seed: AnchorOccurrence,
    occurrences: &[AnchorOccurrence],
    comparison: &mut ComparisonState,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut candidate_ranges = BTreeSet::new();
    for peer in occurrences
        .iter()
        .copied()
        .filter(|peer| distinct_anchor(seed, *peer))
    {
        let Some((start, end)) = maximal_exact_region(view, seed, peer, comparison) else {
            if comparison.incomplete {
                break;
            }
            continue;
        };
        if end.saturating_sub(start) < MIN_DEDUP_REGION_TOKENS {
            continue;
        }
        let candidate = Candidate {
            file: seed.file,
            start,
            end,
            anchor,
            anchor_offset: usize::try_from(seed.token_index)
                .unwrap_or(usize::MAX)
                .saturating_sub(start),
        };
        if candidate_ranges.insert((start, end)) {
            candidates.push(candidate);
        }
    }
    candidates.sort_by(|left, right| (right.len(), left.start).cmp(&(left.len(), right.start)));
    candidates
}

fn distinct_anchor(left: AnchorOccurrence, right: AnchorOccurrence) -> bool {
    left.file != right.file
        || usize::try_from(left.token_index.abs_diff(right.token_index)).unwrap_or(usize::MAX)
            >= MIN_DEDUP_REGION_TOKENS
}

fn maximal_exact_region(
    view: &RegionView<'_>,
    left: AnchorOccurrence,
    right: AnchorOccurrence,
    comparison: &mut ComparisonState,
) -> Option<(usize, usize)> {
    let left_anchor = usize::try_from(left.token_index).ok()?;
    let right_anchor = usize::try_from(right.token_index).ok()?;
    if !anchor_tokens_match(
        view,
        TokenLocation {
            file: left.file,
            token: left_anchor,
        },
        TokenLocation {
            file: right.file,
            token: right_anchor,
        },
        comparison,
    )? {
        return None;
    }
    let left_start = extend_left(
        view,
        TokenLocation {
            file: left.file,
            token: left_anchor,
        },
        TokenLocation {
            file: right.file,
            token: right_anchor,
        },
        comparison,
    )?;
    let left_end = extend_right(
        view,
        TokenLocation {
            file: left.file,
            token: left_anchor.saturating_add(DEDUP_REGION_KGRAM_TOKENS),
        },
        TokenLocation {
            file: right.file,
            token: right_anchor.saturating_add(DEDUP_REGION_KGRAM_TOKENS),
        },
        comparison,
    )?;
    Some((left_start, left_end))
}

fn anchor_tokens_match(
    view: &RegionView<'_>,
    left: TokenLocation,
    right: TokenLocation,
    comparison: &mut ComparisonState,
) -> Option<bool> {
    for offset in 0..DEDUP_REGION_KGRAM_TOKENS {
        if !comparison.tokens_equal(TokenPair::same_view(
            view,
            left.offset(offset),
            right.offset(offset),
        ))? {
            return Some(false);
        }
    }
    Some(true)
}

fn extend_left(
    view: &RegionView<'_>,
    mut left: TokenLocation,
    mut right: TokenLocation,
    comparison: &mut ComparisonState,
) -> Option<usize> {
    while left.token > 0 && right.token > 0 {
        let prior_left = left.prior();
        let prior_right = right.prior();
        if !comparison.tokens_equal(TokenPair::same_view(view, prior_left, prior_right))? {
            break;
        }
        left = prior_left;
        right = prior_right;
    }
    Some(left.token)
}

fn extend_right(
    view: &RegionView<'_>,
    mut left: TokenLocation,
    mut right: TokenLocation,
    comparison: &mut ComparisonState,
) -> Option<usize> {
    while comparison.token_exists(view, left.file, left.token)
        && comparison.token_exists(view, right.file, right.token)
    {
        if !comparison.tokens_equal(TokenPair::same_view(view, left, right))? {
            break;
        }
        left.token = left.token.saturating_add(1);
        right.token = right.token.saturating_add(1);
    }
    Some(left.token)
}

struct ExactClass {
    digest: String,
    family: &'static str,
    before_count: usize,
    after_occurrences: Vec<ExactOccurrence>,
    introduced_count: usize,
    token_count: usize,
}

impl ExactClass {
    fn into_finding(self) -> IntroducedDuplicate {
        let mut occurrences = self
            .after_occurrences
            .into_iter()
            .map(|occurrence| DuplicateOccurrence {
                path: occurrence.path,
                range: Some(occurrence.range),
                callable_kind: None,
                changed: occurrence.changed,
            })
            .collect::<Vec<_>>();
        occurrences.sort_by(|left, right| {
            (!left.changed, &left.path, left.range).cmp(&(!right.changed, &right.path, right.range))
        });
        let after_count = occurrences.len();
        let (occurrences, occurrences_truncated) = bound_occurrences(occurrences);
        IntroducedDuplicate {
            class_id: format!("region-{}", short_id(&self.digest)),
            kind: DuplicateKind::TokenRegion,
            language_family: Some(self.family.into()),
            before_count: self.before_count,
            after_count,
            introduced_count: self.introduced_count,
            bytes: None,
            token_count: Some(self.token_count),
            occurrences,
            occurrences_truncated,
        }
    }
}

#[derive(Clone, Copy)]
struct ExactClassInputs<'a> {
    before: &'a RegionView<'a>,
    after: &'a RegionView<'a>,
    family: &'static str,
    changed_paths: &'a BTreeSet<RepoPath>,
    suppressed_paths: &'a BTreeSet<RepoPath>,
    callable_findings: &'a [IntroducedDuplicate],
}

fn exact_class(
    inputs: ExactClassInputs<'_>,
    candidate: Candidate,
    comparison: &mut ComparisonState,
) -> Option<ExactClass> {
    let before_occurrences = exact_occurrences(
        OccurrenceInputs {
            candidate_view: inputs.after,
            candidate,
            target: inputs.before,
            family: inputs.family,
            changed_paths: inputs.changed_paths,
        },
        comparison,
    )?;
    let after_occurrences = exact_occurrences(
        OccurrenceInputs {
            candidate_view: inputs.after,
            candidate,
            target: inputs.after,
            family: inputs.family,
            changed_paths: inputs.changed_paths,
        },
        comparison,
    )?;
    if after_occurrences.len() < 2 || after_occurrences.len() <= before_occurrences.len() {
        return None;
    }
    let before_by_path = path_counts(&before_occurrences, |occurrence| &occurrence.path);
    let after_by_path = path_counts(&after_occurrences, |occurrence| &occurrence.path);
    let grew_paths = paths_with_growth(&before_by_path, &after_by_path);
    if grew_paths.is_disjoint(inputs.changed_paths)
        || (!grew_paths.is_empty() && grew_paths.is_subset(inputs.suppressed_paths))
        || shadowed_by_callable(&after_occurrences, &grew_paths, inputs.callable_findings)
    {
        return None;
    }
    let Some(digest) = inputs
        .after
        .region_digest(candidate.file, candidate.start..candidate.end)
    else {
        comparison.mark_malformed_location(inputs.after, candidate.file);
        return None;
    };
    Some(ExactClass {
        digest,
        family: inputs.family,
        before_count: before_occurrences.len(),
        introduced_count: after_occurrences
            .len()
            .saturating_sub(before_occurrences.len()),
        after_occurrences,
        token_count: candidate.len(),
    })
}

fn shadowed_by_callable(
    occurrences: &[ExactOccurrence],
    grew_paths: &BTreeSet<RepoPath>,
    callable_findings: &[IntroducedDuplicate],
) -> bool {
    !grew_paths.is_empty()
        && grew_paths.iter().all(|path| {
            occurrences
                .iter()
                .filter(|occurrence| &occurrence.path == path)
                .all(|region| {
                    callable_findings.iter().any(|finding| {
                        finding.kind == DuplicateKind::CallableBody
                            && finding.occurrences.iter().any(|callable| {
                                callable.path == region.path
                                    && callable.range.is_some_and(|range| {
                                        range.start.byte < region.range.end.byte
                                            && range.end.byte > region.range.start.byte
                                    })
                            })
                    })
                })
        })
}

#[derive(Clone)]
struct ExactOccurrence {
    file: usize,
    path: RepoPath,
    start: usize,
    end: usize,
    range: SourceRange,
    changed: bool,
}

#[derive(Clone, Copy)]
struct OccurrenceInputs<'view, 'data> {
    candidate_view: &'view RegionView<'data>,
    candidate: Candidate,
    target: &'view RegionView<'data>,
    family: &'static str,
    changed_paths: &'data BTreeSet<RepoPath>,
}

fn exact_occurrences(
    inputs: OccurrenceInputs<'_, '_>,
    comparison: &mut ComparisonState,
) -> Option<Vec<ExactOccurrence>> {
    let Some(group) = inputs
        .target
        .groups
        .get(inputs.family)
        .and_then(|groups| groups.get(&inputs.candidate.anchor))
    else {
        return Some(Vec::new());
    };
    let mut occurrences = BTreeMap::<(RepoPath, usize), ExactOccurrence>::new();
    for anchor in group {
        let Ok(anchor_index) = usize::try_from(anchor.token_index) else {
            comparison.mark_malformed_location(inputs.target, anchor.file);
            return None;
        };
        let Some(start) = anchor_index.checked_sub(inputs.candidate.anchor_offset) else {
            continue;
        };
        let end = start.saturating_add(inputs.candidate.len());
        if !comparison.regions_equal(&RegionPair {
            left_view: inputs.candidate_view,
            left_file: inputs.candidate.file,
            left: inputs.candidate.start..inputs.candidate.end,
            right_view: inputs.target,
            right_file: anchor.file,
            right: start..end,
        })? {
            continue;
        }
        let file = &inputs.target.files[anchor.file];
        let Some(range) = inputs.target.region_range(anchor.file, start..end) else {
            comparison.mark_malformed_location(inputs.target, anchor.file);
            return None;
        };
        occurrences
            .entry((file.path.clone(), start))
            .or_insert_with(|| ExactOccurrence {
                file: anchor.file,
                path: file.path.clone(),
                start,
                end,
                range,
                changed: inputs.changed_paths.contains(&file.path),
            });
    }
    let mut occurrences = occurrences.into_values().collect::<Vec<_>>();
    occurrences.sort_by(|left, right| {
        (&left.path, left.start, left.end).cmp(&(&right.path, right.start, right.end))
    });
    let mut non_overlapping = Vec::<ExactOccurrence>::new();
    for occurrence in occurrences {
        if non_overlapping
            .last()
            .is_none_or(|prior| prior.path != occurrence.path || prior.end <= occurrence.start)
        {
            non_overlapping.push(occurrence);
        }
    }
    Some(non_overlapping)
}

fn interval_contains(
    covered: &BTreeMap<usize, Vec<Range<usize>>>,
    file: usize,
    token: u32,
) -> bool {
    let token = usize::try_from(token).unwrap_or(usize::MAX);
    covered
        .get(&file)
        .is_some_and(|ranges| ranges.iter().any(|range| range.contains(&token)))
}

fn mark_covered(covered: &mut BTreeMap<usize, Vec<Range<usize>>>, occurrences: &[ExactOccurrence]) {
    for occurrence in occurrences.iter().filter(|occurrence| occurrence.changed) {
        covered
            .entry(occurrence.file)
            .or_default()
            .push(occurrence.start..occurrence.end);
    }
}

fn short_id(digest: &str) -> &str {
    digest.get(..24).unwrap_or(digest)
}

#[derive(Clone, Copy)]
struct AnchorOccurrence {
    file: usize,
    token_index: u32,
}

struct RegionView<'a> {
    view: SenseView,
    files: Vec<RegionFile<'a>>,
    groups: BTreeMap<&'static str, BTreeMap<AnchorKey, Vec<AnchorOccurrence>>>,
    retained_anchors: usize,
    retained_tokens: usize,
    decoded_evidence: Rc<RefCell<DecodedEvidence>>,
    #[cfg(test)]
    indexed: usize,
    malformed_paths: BTreeSet<RepoPath>,
    malformed_paths_truncated: bool,
}

fn record_bounded_path(paths: &mut BTreeSet<RepoPath>, paths_truncated: &mut bool, path: RepoPath) {
    if paths.contains(&path) {
        return;
    }
    if paths.len() >= MAX_OBSERVATION_PATHS {
        *paths_truncated = true;
        return;
    }
    paths.insert(path);
}

#[derive(Eq, PartialEq)]
struct ExactToken<'a> {
    tag: u8,
    prefix: &'a [u8],
    text: &'a [u8],
}

struct RegionFile<'a> {
    source: &'a SourceFile,
    path: RepoPath,
    fact_key: FileFactKey,
    facts: Arc<crate::model::FileFacts>,
    anchor_order: Arc<[u16]>,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "comparison completeness, report truncation, limit identity, and sample truncation are independent states"
)]
struct ComparisonState {
    remaining: usize,
    incomplete: bool,
    findings_truncated: bool,
    limit_reached: bool,
    decode_processed: Option<(usize, usize)>,
    malformed_evidence: bool,
    views: BTreeSet<SenseView>,
    limit_paths: BTreeSet<RepoPath>,
    malformed_paths: BTreeSet<RepoPath>,
    malformed_paths_truncated: bool,
}

impl Default for ComparisonState {
    fn default() -> Self {
        Self {
            remaining: MAX_DEDUP_TOKEN_COMPARISONS,
            incomplete: false,
            findings_truncated: false,
            limit_reached: false,
            decode_processed: None,
            malformed_evidence: false,
            views: BTreeSet::new(),
            limit_paths: BTreeSet::new(),
            malformed_paths: BTreeSet::new(),
            malformed_paths_truncated: false,
        }
    }
}

impl ComparisonState {
    fn observe_malformed_view(&mut self, view: &RegionView<'_>) {
        if view.malformed_paths.is_empty() && !view.malformed_paths_truncated {
            return;
        }
        self.incomplete = true;
        self.malformed_evidence = true;
        self.views.insert(view.view);
        for path in &view.malformed_paths {
            record_bounded_path(
                &mut self.malformed_paths,
                &mut self.malformed_paths_truncated,
                path.clone(),
            );
        }
        self.malformed_paths_truncated |= view.malformed_paths_truncated;
    }

    fn record_limit_location(&mut self, view: &RegionView<'_>, file: usize) {
        self.views.insert(view.view);
        let Some(path) = view.files.get(file).map(|file| &file.path) else {
            return;
        };
        if self.limit_paths.len() < MAX_OBSERVATION_PATHS {
            self.limit_paths.insert(path.clone());
        }
    }

    fn record_limit_pair(&mut self, pair: &TokenPair<'_, '_>) {
        self.record_limit_location(pair.left_view, pair.left.file);
        self.record_limit_location(pair.right_view, pair.right.file);
    }

    fn mark_malformed_location(&mut self, view: &RegionView<'_>, file: usize) {
        let cache = view.decoded_evidence.borrow();
        if cache.decode_exhausted {
            self.incomplete = true;
            self.decode_processed = Some((
                cache.decode_limit,
                cache.decode_limit - cache.decode_remaining,
            ));
            self.record_limit_location(view, file);
            return;
        }
        self.incomplete = true;
        self.malformed_evidence = true;
        self.views.insert(view.view);
        let Some(path) = view.files.get(file).map(|file| &file.path) else {
            return;
        };
        record_bounded_path(
            &mut self.malformed_paths,
            &mut self.malformed_paths_truncated,
            path.clone(),
        );
    }

    fn issues(&self) -> Vec<SenseIssue> {
        let mut issues = Vec::new();
        if let Some(issue) = self.limit_issue() {
            issues.push(issue);
        }
        if self.malformed_evidence {
            let mut issue = SenseIssue::new(
                "dedup_exact_evidence_malformed",
                "exact token evidence was malformed; duplicate comparison could not complete",
            );
            issue.views = self.views.iter().copied().collect();
            issue.paths = self.malformed_paths.iter().cloned().collect();
            issue.paths_truncated = self.malformed_paths_truncated;
            issue.next_step = Some(
                concat!(
                    "Rerun with a fresh local cache. If the error repeats, report the affected ",
                    "files; --allow-partial cannot make malformed evidence complete."
                )
                .into(),
            );
            issues.push(issue);
        }
        issues
    }

    fn limit_issue(&self) -> Option<SenseIssue> {
        let (code, stage, limit, processed, work) =
            if let Some((limit, processed)) = self.decode_processed {
                (
                    "dedup_exact_decode_limit",
                    DedupLimitStage::ExactEvidenceDecoding,
                    limit,
                    processed,
                    "exact evidence decoding",
                )
            } else if self.limit_reached {
                (
                    "dedup_exact_comparison_limit",
                    DedupLimitStage::ExactTokenComparison,
                    MAX_DEDUP_TOKEN_COMPARISONS,
                    MAX_DEDUP_TOKEN_COMPARISONS,
                    "exact token comparison",
                )
            } else {
                return None;
            };
        let mut issue = SenseIssue::new(
            code,
            format!(
                "{work} reached the fixed work limit of {limit}; candidate duplicate regions remain unchecked"
            ),
        );
        issue.stage = Some(stage);
        issue.views = self.views.iter().copied().collect();
        issue.limit = Some(limit);
        issue.processed = Some(processed);
        issue.paths = self.limit_paths.iter().cloned().collect();
        // Evaluation stops at the exhausted comparison. Paths from unchecked candidates are
        // intentionally unknown, so this remains a bounded sample rather than complete evidence.
        issue.paths_truncated = true;
        issue.next_step = Some(concat!(
            "No runtime option raises this fixed safety limit. Split unusually repetitive source ",
            "or, for generated/vendor trees, use literal targets.exclude entries such as ",
            "{\"schemaVersion\":1,\"targets\":{\"exclude\":[\"generated\",\"vendor\"]}}. See ",
            "https://the-open-engine.github.io/opcore/v",
            env!("CARGO_PKG_VERSION_MAJOR"),
            ".",
            env!("CARGO_PKG_VERSION_MINOR"),
            "/docs/configuration.html#select-targets."
        ).into());
        Some(issue)
    }

    fn token_exists(&mut self, view: &RegionView<'_>, file_index: usize, token: usize) -> bool {
        let Some(tokens) = view.tokens(file_index) else {
            self.mark_malformed_location(view, file_index);
            return false;
        };
        token < tokens.tokens.len()
    }

    fn tokens_equal(&mut self, pair: TokenPair<'_, '_>) -> Option<bool> {
        if self.remaining == 0 {
            self.incomplete = true;
            self.limit_reached = true;
            self.record_limit_pair(&pair);
            return None;
        }
        self.remaining = self.remaining.saturating_sub(1);
        let Some(left_tokens) = pair.left_view.tokens(pair.left.file) else {
            self.mark_malformed_location(pair.left_view, pair.left.file);
            return None;
        };
        let Some(right_tokens) = pair.right_view.tokens(pair.right.file) else {
            self.mark_malformed_location(pair.right_view, pair.right.file);
            return None;
        };
        let Some(left) = pair.left_view.exact_token(pair.left, &left_tokens) else {
            self.mark_malformed_location(pair.left_view, pair.left.file);
            return None;
        };
        let Some(right) = pair.right_view.exact_token(pair.right, &right_tokens) else {
            self.mark_malformed_location(pair.right_view, pair.right.file);
            return None;
        };
        Some(left == right)
    }

    fn regions_equal(&mut self, pair: &RegionPair<'_, '_>) -> Option<bool> {
        if pair.left.len() != pair.right.len() {
            return Some(false);
        }
        if !self.token_exists(
            pair.left_view,
            pair.left_file,
            pair.left.end.saturating_sub(1),
        ) || !self.token_exists(
            pair.right_view,
            pair.right_file,
            pair.right.end.saturating_sub(1),
        ) {
            return if self.incomplete { None } else { Some(false) };
        }
        for offset in 0..pair.left.len() {
            if !self.tokens_equal(TokenPair {
                left_view: pair.left_view,
                left: TokenLocation {
                    file: pair.left_file,
                    token: pair.left.start.saturating_add(offset),
                },
                right_view: pair.right_view,
                right: TokenLocation {
                    file: pair.right_file,
                    token: pair.right.start.saturating_add(offset),
                },
            })? {
                return Some(false);
            }
        }
        Some(true)
    }
}

#[cfg(test)]
mod tests;
