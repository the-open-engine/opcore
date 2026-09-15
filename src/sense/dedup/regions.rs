use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Range,
    sync::Arc,
};

use crate::{
    facts,
    identity::{FileFactKey, hash_domain},
    limits::{
        DEDUP_REGION_KGRAM_TOKENS, MAX_DEDUP_TOKEN_COMPARISONS, MAX_OBSERVATION_PATHS,
        MAX_REGION_FINGERPRINTS_PER_FILE, MIN_DEDUP_REGION_TOKENS,
    },
    model::{FingerprintExtractionStatus, RegionFingerprintFacts, SourceFile, SourceRange},
    path::RepoPath,
    source::snapshot::SourceSnapshot,
};

mod evidence;

use evidence::DecodedTokens;

use super::{
    DedupLimitStage, DuplicateKind, DuplicateOccurrence, FactKeyLookup, FingerprintCoverage,
    IntroducedDuplicate, SenseIssue, SenseView, bound_occurrences, lookup_file_fact, path_counts,
    paths_with_growth, prospective_region_anchor_total,
};

type AnchorKey = (u64, u64);
#[derive(Clone)]
enum EvidenceState {
    Validated,
    Decoded(Arc<DecodedTokens>),
    Malformed,
}

#[derive(Default)]
struct DecodedEvidence(BTreeMap<FileFactKey, EvidenceState>);

impl DecodedEvidence {
    fn state(
        &mut self,
        fact_key: FileFactKey,
        source: &SourceFile,
        facts: &RegionFingerprintFacts,
        retain: bool,
    ) -> EvidenceState {
        let state = self.0.entry(fact_key).or_insert_with(|| {
            if retain {
                DecodedTokens::decode(source, facts)
                    .map(Arc::new)
                    .map_or(EvidenceState::Malformed, EvidenceState::Decoded)
            } else if DecodedTokens::validate(source, facts) {
                EvidenceState::Validated
            } else {
                EvidenceState::Malformed
            }
        });
        if retain && matches!(state, EvidenceState::Validated) {
            *state = DecodedTokens::decode(source, facts)
                .map(Arc::new)
                .map_or(EvidenceState::Malformed, EvidenceState::Decoded);
        }
        state.clone()
    }

    fn malformed_fact_keys(&self) -> BTreeSet<FileFactKey> {
        self.0
            .iter()
            .filter_map(|(key, state)| matches!(state, EvidenceState::Malformed).then_some(*key))
            .collect()
    }
}

struct RegionViewInputs<'source, 'request, 'cache> {
    view: SenseView,
    snapshot: &'source SourceSnapshot,
    file_facts: &'request facts::FactMap,
    fact_keys: &'request FactKeyLookup,
    continuity: &'request BTreeMap<RepoPath, RepoPath>,
    decoded_evidence: &'cache mut DecodedEvidence,
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
    pub malformed_fact_keys: BTreeSet<FileFactKey>,
}

#[derive(Default)]
pub(super) struct RegionCoverage {
    anchors: usize,
    tokens: usize,
    request_truncated: bool,
    malformed_evidence: bool,
}

impl RegionCoverage {
    pub(super) fn apply(self, coverage: &mut FingerprintCoverage) {
        coverage.region_anchors = self.anchors;
        coverage.region_tokens = self.tokens;
        coverage.request_truncated |= self.request_truncated;
        coverage.malformed_evidence |= self.malformed_evidence;
    }
}

pub(super) fn region_findings(inputs: RegionInputs<'_>) -> RegionResult {
    let mut decoded_evidence = DecodedEvidence::default();
    let before = RegionView::new(RegionViewInputs {
        view: SenseView::Before,
        snapshot: inputs.before,
        file_facts: inputs.file_facts,
        fact_keys: inputs.fact_keys,
        continuity: inputs.continuity,
        decoded_evidence: &mut decoded_evidence,
    });
    let after = RegionView::new(RegionViewInputs {
        view: SenseView::After,
        snapshot: inputs.after,
        file_facts: inputs.file_facts,
        fact_keys: inputs.fact_keys,
        continuity: &BTreeMap::new(),
        decoded_evidence: &mut decoded_evidence,
    });
    let context = EvaluationContext {
        inputs,
        before: &before,
        after: &after,
    };
    let mut state = EvaluationState::default();
    state.comparison.observe_malformed_view(&before);
    state.comparison.observe_malformed_view(&after);
    if !state.comparison.incomplete {
        'families: for (family, groups) in &context.after.groups {
            for (anchor, after_occurrences) in groups {
                state.evaluate_group(context, family, *anchor, after_occurrences);
                if state.comparison.incomplete {
                    break 'families;
                }
            }
        }
    }

    let comparison_issues = state.comparison.issues();
    let malformed_fact_keys = decoded_evidence.malformed_fact_keys();
    RegionResult {
        findings: state.findings,
        findings_truncated: state.comparison.findings_truncated,
        before: before.coverage(&state.comparison),
        after: after.coverage(&state.comparison),
        comparison_issues,
        malformed_fact_keys,
    }
}

pub(super) fn validate_identical_snapshot(
    snapshot: &SourceSnapshot,
    file_facts: &facts::FactMap,
    fact_keys: &FactKeyLookup,
) -> (RegionCoverage, Vec<SenseIssue>, BTreeSet<FileFactKey>) {
    let mut decoded_evidence = DecodedEvidence::default();
    let view = RegionView::new(RegionViewInputs {
        view: SenseView::Before,
        snapshot,
        file_facts,
        fact_keys,
        continuity: &BTreeMap::new(),
        decoded_evidence: &mut decoded_evidence,
    });
    let mut comparison = ComparisonState::default();
    comparison.observe_malformed_view(&view);
    if comparison.malformed_evidence {
        comparison.views.insert(SenseView::After);
    }
    let coverage = view.coverage(&comparison);
    (
        coverage,
        comparison.issues(),
        decoded_evidence.malformed_fact_keys(),
    )
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
        let Some(range) = file.range(start..end) else {
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
    request_truncated: bool,
    malformed_paths: BTreeSet<RepoPath>,
    malformed_paths_truncated: bool,
}

impl<'a> RegionView<'a> {
    fn new(inputs: RegionViewInputs<'a, '_, '_>) -> Self {
        let RegionViewInputs {
            view: sense_view,
            snapshot,
            file_facts,
            fact_keys,
            continuity,
            decoded_evidence,
        } = inputs;
        let mut view = Self {
            view: sense_view,
            files: Vec::new(),
            groups: BTreeMap::new(),
            retained_anchors: 0,
            retained_tokens: 0,
            request_truncated: false,
            malformed_paths: BTreeSet::new(),
            malformed_paths_truncated: false,
        };
        for source in snapshot.files() {
            let Some((fact_key, facts)) = lookup_file_fact(source, file_facts, fact_keys) else {
                continue;
            };
            if facts.region_fingerprints.status != FingerprintExtractionStatus::Complete {
                continue;
            }
            let path = continuity
                .get(&source.path)
                .cloned()
                .unwrap_or_else(|| source.path.clone());
            let file_bounded =
                facts.region_fingerprints.anchors.len() <= MAX_REGION_FINGERPRINTS_PER_FILE;
            let retained_anchors = file_bounded
                .then(|| {
                    prospective_region_anchor_total(
                        view.retained_anchors,
                        facts.region_fingerprints.anchors.len(),
                    )
                })
                .flatten();
            let state = decoded_evidence.state(
                fact_key,
                source,
                &facts.region_fingerprints,
                retained_anchors.is_some(),
            );
            let EvidenceState::Decoded(decoded) = state else {
                if matches!(state, EvidenceState::Malformed) {
                    record_bounded_path(
                        &mut view.malformed_paths,
                        &mut view.malformed_paths_truncated,
                        path,
                    );
                } else if file_bounded {
                    view.request_truncated = true;
                }
                continue;
            };
            let Some(retained_anchors) = retained_anchors else {
                view.request_truncated = true;
                continue;
            };
            view.retained_anchors = retained_anchors;
            let file = view.files.len();
            view.retained_tokens = view.retained_tokens.saturating_add(
                usize::try_from(facts.region_fingerprints.token_count).unwrap_or(usize::MAX),
            );
            view.files.push(RegionFile {
                source,
                path,
                decoded,
            });
            for anchor in &facts.region_fingerprints.anchors {
                view.groups
                    .entry(source.language.family())
                    .or_default()
                    .entry((anchor.hash_one, anchor.hash_two))
                    .or_default()
                    .push(AnchorOccurrence {
                        file,
                        token_index: anchor.token_index,
                    });
            }
        }
        for occurrences in view.groups.values_mut().flat_map(BTreeMap::values_mut) {
            occurrences.sort_by(|left, right| {
                (&view.files[left.file].path, left.token_index)
                    .cmp(&(&view.files[right.file].path, right.token_index))
            });
        }
        view
    }

    fn coverage(&self, comparison: &ComparisonState) -> RegionCoverage {
        RegionCoverage {
            anchors: self.retained_anchors,
            tokens: self.retained_tokens,
            request_truncated: self.request_truncated
                || (comparison.limit_reached && comparison.views.contains(&self.view)),
            malformed_evidence: !self.malformed_paths.is_empty()
                || self.malformed_paths_truncated
                || (comparison.malformed_evidence && comparison.views.contains(&self.view)),
        }
    }

    fn exact_token(&self, location: TokenLocation) -> Option<ExactToken<'_>> {
        let file = self.files.get(location.file)?;
        let decoded = file.tokens();
        let token = decoded.tokens.get(location.token)?;
        Some(ExactToken {
            tag: token.tag,
            prefix: decoded.bytes.get(token.prefix.clone())?,
            text: file.source.bytes.get(token.start..token.end)?,
        })
    }

    fn region_digest(&self, file: usize, range: Range<usize>) -> Option<String> {
        let file = self.files.get(file)?;
        let decoded = file.tokens();
        let mut encoded = Vec::new();
        for token in decoded.tokens.get(range)? {
            let prefix = decoded.bytes.get(token.prefix.clone())?;
            encoded.extend_from_slice(
                &u32::try_from(prefix.len())
                    .unwrap_or(u32::MAX)
                    .to_be_bytes(),
            );
            encoded.extend_from_slice(prefix);
            encoded.push(token.tag);
            let text = file.source.bytes.get(token.start..token.end)?;
            encoded.extend_from_slice(&u32::try_from(text.len()).unwrap_or(u32::MAX).to_be_bytes());
            encoded.extend_from_slice(text);
        }
        Some(hex::encode(hash_domain(
            "dedup-token-region/v1",
            &[file.source.language.family().as_bytes(), &encoded],
        )))
    }
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
    decoded: Arc<DecodedTokens>,
}

impl RegionFile<'_> {
    fn tokens(&self) -> &DecodedTokens {
        &self.decoded
    }

    fn range(&self, tokens: Range<usize>) -> Option<SourceRange> {
        let decoded = self.tokens();
        let first = decoded.tokens.get(tokens.start)?;
        let last = decoded.tokens.get(tokens.end.checked_sub(1)?)?;
        Some(SourceRange {
            start: decoded.position(first.start),
            end: decoded.position(last.end),
        })
    }
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
    malformed_evidence: bool,
    views: BTreeSet<SenseView>,
    paths: BTreeSet<RepoPath>,
    paths_truncated: bool,
}

impl Default for ComparisonState {
    fn default() -> Self {
        Self {
            remaining: MAX_DEDUP_TOKEN_COMPARISONS,
            incomplete: false,
            findings_truncated: false,
            limit_reached: false,
            malformed_evidence: false,
            views: BTreeSet::new(),
            paths: BTreeSet::new(),
            paths_truncated: false,
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
            record_bounded_path(&mut self.paths, &mut self.paths_truncated, path.clone());
        }
        self.paths_truncated |= view.malformed_paths_truncated;
    }

    fn record_location(&mut self, view: &RegionView<'_>, file: usize) {
        self.views.insert(view.view);
        let Some(path) = view.files.get(file).map(|file| &file.path) else {
            return;
        };
        record_bounded_path(&mut self.paths, &mut self.paths_truncated, path.clone());
    }

    fn record_pair(&mut self, pair: &TokenPair<'_, '_>) {
        self.record_location(pair.left_view, pair.left.file);
        self.record_location(pair.right_view, pair.right.file);
    }

    fn mark_malformed_location(&mut self, view: &RegionView<'_>, file: usize) {
        self.incomplete = true;
        self.malformed_evidence = true;
        self.record_location(view, file);
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
            issue.paths = self.paths.iter().cloned().collect();
            issue.paths_truncated = self.paths_truncated;
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
        if !self.limit_reached {
            return None;
        }
        let mut issue = SenseIssue::new(
            "dedup_exact_comparison_limit",
            format!(
                "exact token comparison reached the fixed limit of {MAX_DEDUP_TOKEN_COMPARISONS}; candidate duplicate regions remain unchecked"
            ),
        );
        issue.stage = Some(DedupLimitStage::ExactTokenComparison);
        issue.views = self.views.iter().copied().collect();
        issue.limit = Some(MAX_DEDUP_TOKEN_COMPARISONS);
        issue.processed = Some(MAX_DEDUP_TOKEN_COMPARISONS);
        issue.paths = self.paths.iter().cloned().collect();
        issue.paths_truncated = self.paths_truncated;
        issue.next_step = Some(concat!(
            "No runtime option raises this fixed safety limit. Split unusually repetitive source ",
            "or keep generated code outside the captured Git source set where appropriate."
        ).into());
        Some(issue)
    }

    fn token_exists(&mut self, view: &RegionView<'_>, file_index: usize, token: usize) -> bool {
        let Some(file) = view.files.get(file_index) else {
            self.mark_malformed_location(view, file_index);
            return false;
        };
        let tokens = file.tokens();
        token < tokens.tokens.len()
    }

    fn tokens_equal(&mut self, pair: TokenPair<'_, '_>) -> Option<bool> {
        if self.remaining == 0 {
            self.incomplete = true;
            self.limit_reached = true;
            self.record_pair(&pair);
            return None;
        }
        self.remaining = self.remaining.saturating_sub(1);
        let Some(left) = pair.left_view.exact_token(pair.left) else {
            self.mark_malformed_location(pair.left_view, pair.left.file);
            return None;
        };
        let Some(right) = pair.right_view.exact_token(pair.right) else {
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
mod tests {
    use std::{fmt::Write as _, sync::Arc};

    use super::*;
    use crate::{analysis, cancel::CancelToken, limits::RuleLimits, model::Language};

    fn evaluate_regions<'a>(
        before: &'a SourceSnapshot,
        after: &'a SourceSnapshot,
        file_facts: &'a facts::FactMap,
        fact_keys: &'a FactKeyLookup,
        changed_paths: &'a BTreeSet<RepoPath>,
    ) -> RegionResult {
        region_findings(RegionInputs {
            before,
            after,
            file_facts,
            fact_keys,
            changed_paths,
            continuity: &BTreeMap::new(),
            suppressed_paths: &BTreeSet::new(),
            callable_findings: &[],
            finding_limit: 32,
        })
    }

    fn source(path: &str, prefix: &str) -> SourceFile {
        let mut text = format!("export function {prefix}() {{\n  let value = 0;\n");
        for index in 0..20 {
            writeln!(text, "  value = value + {prefix}_{index};").unwrap();
        }
        text.push_str("  return value;\n}\n");
        SourceFile::new(
            RepoPath::from_protocol(path).unwrap(),
            text.into_bytes(),
            Language::TypeScript,
            "typescript".into(),
        )
    }

    fn single_file_region_state(
        file: &SourceFile,
    ) -> (SourceSnapshot, facts::FactMap, FactKeyLookup) {
        let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let analyzed =
            analysis::analyze(file, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let snapshot = SourceSnapshot::new([file.clone()]);
        let key = facts::key(file, &options);
        let file_facts = facts::FactMap::from([(key, Arc::new(analyzed))]);
        let fact_keys = FactKeyLookup::from([(
            file.content_id,
            BTreeMap::from([(file.language_mode.clone(), key)]),
        )]);
        (snapshot, file_facts, fact_keys)
    }

    #[test]
    fn exact_comparison_limit_reports_stage_view_path_and_recovery() {
        let alpha = source("alpha.ts", "alpha");
        let (snapshot, file_facts, fact_keys) = single_file_region_state(&alpha);
        let mut decoded_evidence = DecodedEvidence::default();
        let view = RegionView::new(RegionViewInputs {
            view: SenseView::After,
            snapshot: &snapshot,
            file_facts: &file_facts,
            fact_keys: &fact_keys,
            continuity: &BTreeMap::new(),
            decoded_evidence: &mut decoded_evidence,
        });
        let mut comparison = ComparisonState {
            remaining: 0,
            ..ComparisonState::default()
        };
        let location = TokenLocation { file: 0, token: 0 };
        assert_eq!(
            comparison.tokens_equal(TokenPair::same_view(&view, location, location)),
            None
        );
        let issue = comparison.limit_issue().unwrap();

        assert_eq!(issue.stage, Some(DedupLimitStage::ExactTokenComparison));
        assert_eq!(issue.views, vec![SenseView::After]);
        assert_eq!(issue.paths, vec![alpha.path]);
        assert_eq!(issue.limit, Some(MAX_DEDUP_TOKEN_COMPARISONS));
        assert_eq!(issue.processed, Some(MAX_DEDUP_TOKEN_COMPARISONS));
        assert!(issue.next_step.is_some());
    }

    #[test]
    fn malformed_exact_token_evidence_has_a_distinct_fail_closed_issue() {
        let alpha = source("alpha.ts", "alpha");
        let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let mut analyzed =
            analysis::analyze(&alpha, &RuleLimits::default(), &CancelToken::new()).unwrap();
        assert!(!analyzed.region_fingerprints.anchors.is_empty());
        analyzed.region_fingerprints.encoded_tokens = "not-base64".into();
        let snapshot = SourceSnapshot::new([alpha.clone()]);
        let key = facts::key(&alpha, &options);
        let file_facts = facts::FactMap::from([(key, Arc::new(analyzed))]);
        let fact_keys = FactKeyLookup::from([(
            alpha.content_id,
            BTreeMap::from([(alpha.language_mode.clone(), key)]),
        )]);
        let result = evaluate_regions(
            &SourceSnapshot::new([]),
            &snapshot,
            &file_facts,
            &fact_keys,
            &BTreeSet::from([alpha.path.clone()]),
        );

        assert!(result.findings.is_empty());
        assert_eq!(result.comparison_issues.len(), 1);
        assert_eq!(
            result.comparison_issues[0].code,
            "dedup_exact_evidence_malformed"
        );
        assert_eq!(result.comparison_issues[0].views, vec![SenseView::After]);
        assert_eq!(result.comparison_issues[0].paths, vec![alpha.path]);
        assert!(result.after.malformed_evidence);
        assert_eq!(result.after.anchors, 0);
        assert!(!result.after.request_truncated);
    }

    #[test]
    fn malformed_token_location_marks_only_the_failing_view() {
        let before_file = source("before.ts", "before");
        let after_file = source("after.ts", "after");
        let (before_snapshot, before_facts, before_keys) = single_file_region_state(&before_file);
        let (after_snapshot, after_facts, after_keys) = single_file_region_state(&after_file);
        let mut decoded_evidence = DecodedEvidence::default();
        let before = RegionView::new(RegionViewInputs {
            view: SenseView::Before,
            snapshot: &before_snapshot,
            file_facts: &before_facts,
            fact_keys: &before_keys,
            continuity: &BTreeMap::new(),
            decoded_evidence: &mut decoded_evidence,
        });
        let after = RegionView::new(RegionViewInputs {
            view: SenseView::After,
            snapshot: &after_snapshot,
            file_facts: &after_facts,
            fact_keys: &after_keys,
            continuity: &BTreeMap::new(),
            decoded_evidence: &mut decoded_evidence,
        });
        let mut comparison = ComparisonState::default();

        assert_eq!(
            comparison.tokens_equal(TokenPair {
                left_view: &before,
                left: TokenLocation {
                    file: 0,
                    token: usize::MAX,
                },
                right_view: &after,
                right: TokenLocation { file: 0, token: 0 },
            }),
            None
        );
        let issue = comparison.issues().pop().unwrap();
        assert_eq!(issue.views, vec![SenseView::Before]);
        assert_eq!(issue.paths, vec![before_file.path]);

        let mut before_coverage = FingerprintCoverage::default();
        before.coverage(&comparison).apply(&mut before_coverage);
        let mut after_coverage = FingerprintCoverage::default();
        after.coverage(&comparison).apply(&mut after_coverage);
        assert!(before_coverage.malformed_evidence);
        assert!(!after_coverage.malformed_evidence);
    }

    #[test]
    fn anchor_hash_collision_cannot_become_a_region_finding() {
        let alpha = source("alpha.ts", "alpha");
        let beta = source("beta.ts", "beta");
        let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let mut alpha_facts =
            analysis::analyze(&alpha, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let mut beta_facts =
            analysis::analyze(&beta, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let alpha_anchor = alpha_facts.region_fingerprints.anchors[0];
        let beta_anchor = beta_facts.region_fingerprints.anchors[0];
        alpha_facts.region_fingerprints.anchors = vec![alpha_anchor];
        beta_facts.region_fingerprints.anchors = vec![crate::model::RegionFingerprint {
            hash_one: alpha_anchor.hash_one,
            hash_two: alpha_anchor.hash_two,
            token_index: beta_anchor.token_index,
        }];

        let after = SourceSnapshot::new([alpha.clone(), beta.clone()]);
        let before = SourceSnapshot::new([]);
        let mut file_facts = facts::FactMap::new();
        file_facts.insert(facts::key(&alpha, &options), Arc::new(alpha_facts));
        file_facts.insert(facts::key(&beta, &options), Arc::new(beta_facts));
        let mut fact_keys = FactKeyLookup::new();
        for file in [&alpha, &beta] {
            fact_keys
                .entry(file.content_id)
                .or_default()
                .insert(file.language_mode.clone(), facts::key(file, &options));
        }
        let changed_paths = BTreeSet::from([alpha.path.clone(), beta.path.clone()]);
        let result = evaluate_regions(&before, &after, &file_facts, &fact_keys, &changed_paths);

        assert!(result.findings.is_empty());
        assert!(!result.after.request_truncated);
    }

    #[test]
    fn unchanged_anchor_count_cannot_hide_an_introduced_exact_region() {
        let alpha = source("alpha.ts", "shared");
        let before_beta = source("beta.ts", "different");
        let after_beta = SourceFile::new(
            before_beta.path.clone(),
            alpha.bytes.clone(),
            alpha.language,
            alpha.language_mode.clone(),
        );
        let options = serde_json::to_vec(&RuleLimits::default()).unwrap();
        let alpha_facts =
            analysis::analyze(&alpha, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let mut before_beta_facts =
            analysis::analyze(&before_beta, &RuleLimits::default(), &CancelToken::new()).unwrap();
        assert_eq!(
            alpha_facts.region_fingerprints.anchors.len(),
            before_beta_facts.region_fingerprints.anchors.len()
        );
        for (anchor, replacement) in before_beta_facts
            .region_fingerprints
            .anchors
            .iter_mut()
            .zip(&alpha_facts.region_fingerprints.anchors)
        {
            anchor.hash_one = replacement.hash_one;
            anchor.hash_two = replacement.hash_two;
        }

        let before = SourceSnapshot::new([alpha.clone(), before_beta.clone()]);
        let after = SourceSnapshot::new([alpha.clone(), after_beta.clone()]);
        let mut file_facts = facts::FactMap::new();
        file_facts.insert(facts::key(&alpha, &options), Arc::new(alpha_facts.clone()));
        file_facts.insert(
            facts::key(&before_beta, &options),
            Arc::new(before_beta_facts),
        );
        let mut fact_keys = FactKeyLookup::new();
        for file in [&alpha, &before_beta, &after_beta] {
            fact_keys
                .entry(file.content_id)
                .or_default()
                .insert(file.language_mode.clone(), facts::key(file, &options));
        }
        let changed_paths = BTreeSet::from([after_beta.path.clone()]);
        let result = evaluate_regions(&before, &after, &file_facts, &fact_keys, &changed_paths);

        assert_eq!(result.findings.len(), 1);
        assert_eq!(result.findings[0].before_count, 1);
        assert_eq!(result.findings[0].after_count, 2);
        assert!(!result.after.request_truncated);
    }
}
