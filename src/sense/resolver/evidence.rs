use crate::{limits::MAX_OBSERVATION_PATHS, model::DependencyReference, path::RepoPath};

use super::super::model::{Projection, ResolutionGapEvidence, ResolutionGapKind};

pub(super) fn record_reference_gap(
    projection: &mut Projection,
    path: &RepoPath,
    reference: &DependencyReference,
    kind: ResolutionGapKind,
) {
    record_resolution_gap(
        projection,
        ResolutionGapEvidence {
            path: path.clone(),
            specifier: reference.specifier.clone(),
            kind,
        },
    );
}

pub(super) fn record_resolution_gap(projection: &mut Projection, gap: ResolutionGapEvidence) {
    if projection.resolution_gaps.contains(&gap) {
        return;
    }
    projection.resolution_gaps.insert(gap);
    if projection.resolution_gaps.len() > MAX_OBSERVATION_PATHS {
        projection.resolution_gaps.pop_last();
        projection.resolution_gaps_truncated = true;
    }
}
