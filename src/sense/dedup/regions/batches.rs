use super::super::{AffectedPaths, LimitIssueSpec, push_limit_issue};
use super::{
    BTreeSet, DedupLimitStage, EvaluationContext, EvaluationState, RegionInputs, RegionView,
};
use crate::model::RegionFingerprint;

// Ordered hash ranges keep every occurrence of an anchor together, regardless of path.
// Splitting only the in-memory index preserves the existing global evaluation order.
#[derive(Clone, Copy)]
pub(super) struct Batch {
    family: &'static str,
    start: u128,
    end: u128,
    pub(super) limit: usize,
}

impl Batch {
    pub(super) fn full(family: &'static str, limit: usize) -> Self {
        Self {
            family,
            start: 0,
            end: u128::MAX,
            limit,
        }
    }

    fn select(self, view: &RegionView<'_>) -> Selection {
        let mut selection = Selection {
            ranges: Vec::with_capacity(view.files.len()),
            count: 0,
            bounds: None,
        };
        for file in &view.files {
            let hash = |index: &u16| {
                anchor_hash(&file.facts.region_fingerprints.anchors[usize::from(*index)])
            };
            let range = if file.source.language.family() == self.family {
                let start = file
                    .anchor_order
                    .partition_point(|index| hash(index) < self.start);
                let end = file
                    .anchor_order
                    .partition_point(|index| hash(index) <= self.end);
                start..end
            } else {
                0..0
            };
            if !range.is_empty() {
                let min = hash(&file.anchor_order[range.start]);
                let max = hash(&file.anchor_order[range.end - 1]);
                selection.bounds = Some(
                    selection
                        .bounds
                        .map_or((min, max), |(a, b)| (a.min(min), b.max(max))),
                );
            }
            selection.count = selection.count.saturating_add(range.len());
            selection.ranges.push(range);
        }
        selection
    }

    fn split(self, before: &Selection, after: &Selection) -> Option<(Self, Self)> {
        let (min, max) = [before.bounds, after.bounds]
            .into_iter()
            .flatten()
            .reduce(|(a, b), (c, d)| (a.min(c), b.max(d)))?;
        if min == max {
            return None;
        }
        let midpoint = min + (max - min) / 2;
        Some((
            Self {
                end: midpoint,
                ..self
            },
            Self {
                start: midpoint + 1,
                ..self
            },
        ))
    }
}

pub(super) struct Selection {
    pub(super) ranges: Vec<std::ops::Range<usize>>,
    count: usize,
    bounds: Option<(u128, u128)>,
}

impl Selection {
    fn report_limit(
        &self,
        view: &RegionView<'_>,
        limit: usize,
        issues: &mut Vec<super::SenseIssue>,
    ) -> bool {
        if self.count <= limit {
            return false;
        }
        let mut retained = 0usize;
        let mut paths = Vec::new();
        for (file, range) in view.files.iter().zip(&self.ranges) {
            if range.len() > limit.saturating_sub(retained) {
                paths.push(file.path.clone());
            } else {
                retained += range.len();
            }
        }
        paths.sort();
        push_limit_issue(
            issues,
            AffectedPaths {
                count: paths.len(),
                paths,
            },
            LimitIssueSpec {
                code: "dedup_region_request_limit",
                stage: DedupLimitStage::TokenRegionRequestCollection,
                views: &[view.view],
                limit,
                processed: retained,
                message: "one token-region anchor class exceeds the bounded batch",
            },
        );
        true
    }
}

pub(super) fn anchor_hash(anchor: &RegionFingerprint) -> u128 {
    (u128::from(anchor.hash_one) << 64) | u128::from(anchor.hash_two)
}

pub(super) fn evaluate(
    inputs: RegionInputs<'_>,
    limit: usize,
    views: &mut [RegionView<'_>; 2],
    state: &mut EvaluationState,
) {
    let families = inputs
        .after
        .files()
        .map(|file| file.language.family())
        .collect::<BTreeSet<_>>();
    for family in families {
        let mut pending = vec![Batch::full(family, limit)];
        while let Some(batch) = pending.pop() {
            let split = evaluate_batch(inputs, batch, views, state);
            if state.comparison.incomplete {
                return;
            }
            if let Some((left, right)) = split {
                pending.push(right);
                pending.push(left);
            }
        }
    }
}

fn evaluate_batch(
    inputs: RegionInputs<'_>,
    batch: Batch,
    views: &mut [RegionView<'_>; 2],
    state: &mut EvaluationState,
) -> Option<(Batch, Batch)> {
    let [before, after] = views;
    let before_selection = batch.select(before);
    let after_selection = batch.select(after);
    if before_selection.count > batch.limit || after_selection.count > batch.limit {
        if let Some(split) = batch.split(&before_selection, &after_selection) {
            return Some(split);
        }
        // A single anchor class cannot be split without losing exact cardinality.
        for (view, selection, coverage) in [
            (&*before, &before_selection, &mut state.before),
            (&*after, &after_selection, &mut state.after),
        ] {
            coverage.request_truncated |=
                selection.report_limit(view, batch.limit, &mut state.issues);
        }
        state.comparison.incomplete = true;
        return None;
    }
    before.index_batch(&before_selection);
    after.index_batch(&after_selection);
    let context = EvaluationContext {
        inputs,
        before,
        after,
    };
    for (family, groups) in &after.groups {
        for (anchor, occurrences) in groups {
            state.evaluate_group(context, family, *anchor, occurrences);
            if state.comparison.incomplete {
                return None;
            }
        }
    }
    None
}
