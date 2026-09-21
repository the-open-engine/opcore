use std::collections::{BTreeMap, BTreeSet};

use crate::{
    facts,
    identity::{ContentId, FileFactKey},
    limits::{
        MAX_CALLABLE_FINGERPRINTS_PER_FILE, MAX_CALLABLE_FINGERPRINTS_PER_REQUEST,
        MAX_OBSERVATION_PATHS, MAX_REGION_FINGERPRINTS_PER_FILE,
        MAX_REGION_FINGERPRINTS_PER_REQUEST,
    },
    model::{CallableKind, FileFacts, FingerprintExtractionStatus, SourceRange},
    path::RepoPath,
    source::snapshot::SourceSnapshot,
};

pub(super) use super::model::{
    DedupCoverage, DedupLimitStage, DuplicateKind, DuplicateOccurrence, FingerprintCoverage,
    IntroducedDuplicate, SenseIssue, SenseView,
};

mod regions;

pub(super) type FactKeyLookup = BTreeMap<ContentId, BTreeMap<String, FileFactKey>>;

#[derive(Clone, Copy)]
pub(super) struct DedupInputs<'a> {
    pub before: &'a SourceSnapshot,
    pub after: &'a SourceSnapshot,
    pub file_facts: &'a facts::FactMap,
    pub fact_keys: &'a FactKeyLookup,
    pub changed_paths: &'a BTreeSet<RepoPath>,
    pub continuity: &'a BTreeMap<RepoPath, RepoPath>,
    pub minimum_identical_bytes: usize,
    pub finding_limit: usize,
}

pub(super) struct DedupResult {
    pub findings: Vec<IntroducedDuplicate>,
    pub findings_truncated: bool,
    pub coverage: DedupCoverage,
    pub issues: Vec<SenseIssue>,
}

pub(super) fn introduced_duplicates(inputs: DedupInputs<'_>) -> DedupResult {
    if inputs.before.id() == inputs.after.id() {
        return identical_snapshot_result(inputs);
    }
    let mut issues = Vec::new();
    let changed_paths = canonical_changed_paths(inputs.changed_paths, inputs.continuity);
    let (mut findings, suppressed_paths, mut findings_truncated) =
        identical_file_findings(IdenticalFileInputs {
            before: inputs.before,
            after: inputs.after,
            changed_paths: &changed_paths,
            continuity: inputs.continuity,
            minimum_bytes: inputs.minimum_identical_bytes,
            finding_limit: inputs.finding_limit,
        });
    let empty_continuity = BTreeMap::new();
    let before = callable_view(
        inputs.before,
        inputs.file_facts,
        inputs.fact_keys,
        inputs.continuity,
    );
    let after = callable_view(
        inputs.after,
        inputs.file_facts,
        inputs.fact_keys,
        &empty_continuity,
    );
    let callable_limit = inputs.finding_limit.saturating_sub(findings.len());
    let (callable_findings, callable_truncated) = callable_findings(
        &before.groups,
        &after.groups,
        &changed_paths,
        &suppressed_paths,
        callable_limit,
    );
    findings.extend(callable_findings);
    findings_truncated |= callable_truncated;
    let region_limit = inputs.finding_limit.saturating_sub(findings.len());
    let region_result = regions::region_findings(regions::RegionInputs {
        before: inputs.before,
        after: inputs.after,
        file_facts: inputs.file_facts,
        fact_keys: inputs.fact_keys,
        changed_paths: &changed_paths,
        continuity: inputs.continuity,
        suppressed_paths: &suppressed_paths,
        callable_findings: &findings,
        finding_limit: region_limit,
    });
    issues.extend(snapshot_limit_issues(
        inputs.before,
        inputs.file_facts,
        inputs.fact_keys,
        &[SenseView::Before],
        &region_result.malformed_fact_keys,
    ));
    issues.extend(snapshot_limit_issues(
        inputs.after,
        inputs.file_facts,
        inputs.fact_keys,
        &[SenseView::After],
        &region_result.malformed_fact_keys,
    ));
    findings.extend(region_result.findings);
    findings_truncated |= region_result.findings_truncated;
    let mut before_coverage = before.coverage;
    let mut after_coverage = after.coverage;
    region_result.before.apply(&mut before_coverage);
    region_result.after.apply(&mut after_coverage);
    issues.extend(region_result.comparison_issues);
    DedupResult {
        findings,
        findings_truncated,
        coverage: DedupCoverage {
            before: before_coverage,
            after: after_coverage,
        },
        issues,
    }
}

fn identical_snapshot_result(inputs: DedupInputs<'_>) -> DedupResult {
    let mut coverage = fingerprint_coverage(inputs.before, inputs.file_facts, inputs.fact_keys);
    let (region_coverage, region_issues, malformed_fact_keys) =
        regions::validate_identical_snapshot(inputs.before, inputs.file_facts, inputs.fact_keys);
    let mut issues = snapshot_limit_issues(
        inputs.before,
        inputs.file_facts,
        inputs.fact_keys,
        &[SenseView::Before, SenseView::After],
        &malformed_fact_keys,
    );
    region_coverage.apply(&mut coverage);
    issues.extend(region_issues);
    DedupResult {
        findings: Vec::new(),
        findings_truncated: false,
        coverage: DedupCoverage {
            before: coverage.clone(),
            after: coverage,
        },
        issues,
    }
}

#[derive(Default)]
struct AffectedPaths {
    count: usize,
    paths: Vec<RepoPath>,
}

impl AffectedPaths {
    fn push(&mut self, path: &RepoPath) {
        self.count = self.count.saturating_add(1);
        self.paths.push(path.clone());
    }
}

#[derive(Default)]
struct SnapshotLimitState {
    callable_files: AffectedPaths,
    region_files: AffectedPaths,
    callable_request: AffectedPaths,
    region_request: AffectedPaths,
    callables: usize,
    regions: usize,
}

fn snapshot_limit_issues(
    snapshot: &SourceSnapshot,
    file_facts: &facts::FactMap,
    fact_keys: &FactKeyLookup,
    views: &[SenseView],
    malformed_fact_keys: &BTreeSet<FileFactKey>,
) -> Vec<SenseIssue> {
    let mut state = SnapshotLimitState::default();
    for file in snapshot.files() {
        let Some((fact_key, file_facts)) = lookup_file_fact(file, file_facts, fact_keys) else {
            continue;
        };
        observe_callable_limits(&mut state, &file.path, file_facts);
        observe_region_limits(
            &mut state,
            &file.path,
            file_facts,
            malformed_fact_keys.contains(&fact_key),
        );
    }
    render_snapshot_limit_issues(state, views)
}

fn observe_callable_limits(
    state: &mut SnapshotLimitState,
    path: &RepoPath,
    file_facts: &FileFacts,
) {
    let count = file_facts.callable_fingerprints.callables.len();
    let bounded = count <= MAX_CALLABLE_FINGERPRINTS_PER_FILE;
    if file_facts.callable_fingerprints.status == FingerprintExtractionStatus::Truncated || !bounded
    {
        state.callable_files.push(path);
    }
    if !bounded || file_facts.callable_fingerprints.status != FingerprintExtractionStatus::Complete
    {
        return;
    }
    let remaining = MAX_CALLABLE_FINGERPRINTS_PER_REQUEST.saturating_sub(state.callables);
    if count > remaining {
        state.callable_request.push(path);
    }
    state.callables = state.callables.saturating_add(count.min(remaining));
}

fn observe_region_limits(
    state: &mut SnapshotLimitState,
    path: &RepoPath,
    file_facts: &FileFacts,
    malformed: bool,
) {
    let count = file_facts.region_fingerprints.anchors.len();
    let bounded = count <= MAX_REGION_FINGERPRINTS_PER_FILE;
    if file_facts.region_fingerprints.status == FingerprintExtractionStatus::Truncated || !bounded {
        state.region_files.push(path);
    }
    if bounded
        && !malformed
        && file_facts.region_fingerprints.status == FingerprintExtractionStatus::Complete
        && !admit_region_anchors(&mut state.regions, count)
    {
        state.region_request.push(path);
    }
}

fn render_snapshot_limit_issues(state: SnapshotLimitState, views: &[SenseView]) -> Vec<SenseIssue> {
    let mut issues = Vec::new();
    push_limit_issue(
        &mut issues,
        state.callable_files,
        LimitIssueSpec {
            code: "dedup_callable_file_limit",
            stage: DedupLimitStage::CallableFileExtraction,
            views,
            limit: MAX_CALLABLE_FINGERPRINTS_PER_FILE,
            processed: MAX_CALLABLE_FINGERPRINTS_PER_FILE,
            message: "callable-body duplicate extraction is incomplete",
        },
    );
    push_limit_issue(
        &mut issues,
        state.region_files,
        LimitIssueSpec {
            code: "dedup_region_file_limit",
            stage: DedupLimitStage::TokenRegionFileExtraction,
            views,
            limit: MAX_REGION_FINGERPRINTS_PER_FILE,
            processed: MAX_REGION_FINGERPRINTS_PER_FILE,
            message: "token-region duplicate extraction is incomplete",
        },
    );
    push_limit_issue(
        &mut issues,
        state.callable_request,
        LimitIssueSpec {
            code: "dedup_callable_request_limit",
            stage: DedupLimitStage::CallableRequestCollection,
            views,
            limit: MAX_CALLABLE_FINGERPRINTS_PER_REQUEST,
            processed: state.callables,
            message: "request-wide callable duplicate collection is incomplete",
        },
    );
    push_limit_issue(
        &mut issues,
        state.region_request,
        LimitIssueSpec {
            code: "dedup_region_request_limit",
            stage: DedupLimitStage::TokenRegionRequestCollection,
            views,
            limit: MAX_REGION_FINGERPRINTS_PER_REQUEST,
            processed: state.regions,
            message: "request-wide token-region duplicate collection is incomplete",
        },
    );
    issues
}

fn admit_region_anchors(retained: &mut usize, count: usize) -> bool {
    let Some(total) = prospective_region_anchor_total(*retained, count) else {
        return false;
    };
    *retained = total;
    true
}

fn prospective_region_anchor_total(retained: usize, count: usize) -> Option<usize> {
    (count <= MAX_REGION_FINGERPRINTS_PER_REQUEST.saturating_sub(retained))
        .then(|| retained.saturating_add(count))
}

#[derive(Clone, Copy)]
struct LimitIssueSpec<'a> {
    code: &'a str,
    stage: DedupLimitStage,
    views: &'a [SenseView],
    limit: usize,
    processed: usize,
    message: &'a str,
}

fn push_limit_issue(
    issues: &mut Vec<SenseIssue>,
    affected: AffectedPaths,
    spec: LimitIssueSpec<'_>,
) {
    if affected.count == 0 {
        return;
    }
    let mut issue = SenseIssue::new(
        spec.code,
        format!(
            "{}: the fixed limit of {} was reached; at least {} path(s) were affected",
            spec.message, spec.limit, affected.count
        ),
    );
    issue.stage = Some(spec.stage);
    issue.views = spec.views.to_vec();
    issue.limit = Some(spec.limit);
    issue.processed = Some(spec.processed);
    issue.paths = affected.paths;
    issue.paths_truncated = affected.count > issue.paths.len();
    issue.next_step = Some(
        concat!(
            "No runtime option raises this fixed safety limit. Split unusually dense source files ",
            "or add literal file or subtree entries to targets.exclude where appropriate; see ",
            "docs/configuration.md#select-targets."
        )
        .into(),
    );
    issues.push(issue);
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

struct FileGroup {
    bytes: usize,
    paths: BTreeSet<RepoPath>,
}

#[derive(Clone, Copy)]
struct IdenticalFileInputs<'a> {
    before: &'a SourceSnapshot,
    after: &'a SourceSnapshot,
    changed_paths: &'a BTreeSet<RepoPath>,
    continuity: &'a BTreeMap<RepoPath, RepoPath>,
    minimum_bytes: usize,
    finding_limit: usize,
}

fn identical_file_findings(
    inputs: IdenticalFileInputs<'_>,
) -> (Vec<IntroducedDuplicate>, BTreeSet<RepoPath>, bool) {
    let empty_continuity = BTreeMap::new();
    let before_groups = file_groups(inputs.before, inputs.minimum_bytes, inputs.continuity);
    let after_groups = file_groups(inputs.after, inputs.minimum_bytes, &empty_continuity);
    let mut findings = Vec::new();
    let mut suppressed_paths = BTreeSet::new();
    let mut truncated = false;
    for (content_id, after_group) in after_groups {
        let empty = BTreeSet::new();
        let before_paths = before_groups
            .get(&content_id)
            .map_or(&empty, |group| &group.paths);
        if after_group.paths.len() < 2 || after_group.paths.len() <= before_paths.len() {
            continue;
        }
        let introduced_paths = after_group
            .paths
            .difference(before_paths)
            .cloned()
            .collect::<BTreeSet<_>>();
        if introduced_paths.is_disjoint(inputs.changed_paths) {
            continue;
        }
        suppressed_paths.extend(introduced_paths);
        if findings.len() >= inputs.finding_limit {
            truncated = true;
            continue;
        }
        let mut occurrences = after_group
            .paths
            .iter()
            .map(|path| DuplicateOccurrence {
                path: path.clone(),
                range: None,
                callable_kind: None,
                changed: inputs.changed_paths.contains(path),
            })
            .collect::<Vec<_>>();
        occurrences
            .sort_by(|left, right| (!left.changed, &left.path).cmp(&(!right.changed, &right.path)));
        let (occurrences, occurrences_truncated) = bound_occurrences(occurrences);
        findings.push(IntroducedDuplicate {
            class_id: format!("file-{}", short_id(&content_id.hex())),
            kind: DuplicateKind::IdenticalFile,
            language_family: None,
            before_count: before_paths.len(),
            after_count: after_group.paths.len(),
            introduced_count: after_group.paths.len().saturating_sub(before_paths.len()),
            bytes: Some(after_group.bytes),
            token_count: None,
            occurrences,
            occurrences_truncated,
        });
    }
    (findings, suppressed_paths, truncated)
}

fn file_groups(
    snapshot: &SourceSnapshot,
    minimum_bytes: usize,
    continuity: &BTreeMap<RepoPath, RepoPath>,
) -> BTreeMap<ContentId, FileGroup> {
    let mut groups = BTreeMap::<ContentId, FileGroup>::new();
    for file in snapshot
        .files()
        .filter(|file| file.bytes.len() >= minimum_bytes)
    {
        let path = continuity
            .get(&file.path)
            .cloned()
            .unwrap_or_else(|| file.path.clone());
        let group = groups.entry(file.content_id).or_insert_with(|| FileGroup {
            bytes: file.bytes.len(),
            paths: BTreeSet::new(),
        });
        group.paths.insert(path);
    }
    groups
}

#[derive(Clone)]
struct CallableOccurrence {
    path: RepoPath,
    range: SourceRange,
    kind: CallableKind,
    token_count: usize,
}

type CallableGroups = BTreeMap<&'static str, BTreeMap<String, Vec<CallableOccurrence>>>;

struct CallableView {
    groups: CallableGroups,
    coverage: FingerprintCoverage,
}

fn fingerprint_coverage(
    snapshot: &SourceSnapshot,
    file_facts: &facts::FactMap,
    fact_keys: &FactKeyLookup,
) -> FingerprintCoverage {
    let mut coverage = FingerprintCoverage::default();
    for file in snapshot.files() {
        coverage.files = coverage.files.saturating_add(1);
        let Some(file_facts) = lookup_file_facts(file, file_facts, fact_keys) else {
            coverage.unsupported_files = coverage.unsupported_files.saturating_add(1);
            continue;
        };
        record_non_region_coverage(&mut coverage, file_facts);
    }
    coverage
}

fn callable_view(
    snapshot: &SourceSnapshot,
    file_facts: &facts::FactMap,
    fact_keys: &FactKeyLookup,
    continuity: &BTreeMap<RepoPath, RepoPath>,
) -> CallableView {
    let mut groups = CallableGroups::new();
    let mut coverage = FingerprintCoverage::default();
    for file in snapshot.files() {
        coverage.files = coverage.files.saturating_add(1);
        let Some(file_facts) = lookup_file_facts(file, file_facts, fact_keys) else {
            coverage.unsupported_files = coverage.unsupported_files.saturating_add(1);
            continue;
        };
        record_fingerprint_status(&mut coverage, file_facts);
        if file_facts.callable_fingerprints.status != FingerprintExtractionStatus::Complete
            || file_facts.callable_fingerprints.callables.is_empty()
            || file_facts.callable_fingerprints.callables.len() > MAX_CALLABLE_FINGERPRINTS_PER_FILE
        {
            continue;
        }
        let path = continuity
            .get(&file.path)
            .cloned()
            .unwrap_or_else(|| file.path.clone());
        for callable in &file_facts.callable_fingerprints.callables {
            if coverage.callable_occurrences >= MAX_CALLABLE_FINGERPRINTS_PER_REQUEST {
                coverage.request_truncated = true;
                continue;
            }
            coverage.callable_occurrences = coverage.callable_occurrences.saturating_add(1);
            groups
                .entry(file.language.family())
                .or_default()
                .entry(callable.digest.clone())
                .or_default()
                .push(CallableOccurrence {
                    path: path.clone(),
                    range: callable.range,
                    kind: callable.kind,
                    token_count: usize::try_from(callable.token_count).unwrap_or(usize::MAX),
                });
        }
    }
    for occurrences in groups.values_mut().flat_map(BTreeMap::values_mut) {
        occurrences.sort_by(|left, right| {
            (&left.path, left.range, left.kind).cmp(&(&right.path, right.range, right.kind))
        });
    }
    CallableView { groups, coverage }
}

fn lookup_file_facts<'a>(
    file: &crate::model::SourceFile,
    file_facts: &'a facts::FactMap,
    fact_keys: &FactKeyLookup,
) -> Option<&'a FileFacts> {
    lookup_file_fact(file, file_facts, fact_keys).map(|(_, facts)| facts)
}

fn lookup_file_fact<'a>(
    file: &crate::model::SourceFile,
    file_facts: &'a facts::FactMap,
    fact_keys: &FactKeyLookup,
) -> Option<(FileFactKey, &'a FileFacts)> {
    let key = fact_keys
        .get(&file.content_id)?
        .get(file.language_mode.as_str())?;
    file_facts.get(key).map(|facts| (*key, facts.as_ref()))
}

fn record_non_region_coverage(coverage: &mut FingerprintCoverage, file_facts: &FileFacts) {
    record_fingerprint_status(coverage, file_facts);
    if file_facts.callable_fingerprints.status != FingerprintExtractionStatus::Complete
        || file_facts.callable_fingerprints.callables.len() > MAX_CALLABLE_FINGERPRINTS_PER_FILE
    {
        return;
    }
    let remaining =
        MAX_CALLABLE_FINGERPRINTS_PER_REQUEST.saturating_sub(coverage.callable_occurrences);
    coverage.callable_occurrences = coverage.callable_occurrences.saturating_add(
        file_facts
            .callable_fingerprints
            .callables
            .len()
            .min(remaining),
    );
    coverage.request_truncated |= file_facts.callable_fingerprints.callables.len() > remaining;
}

fn record_fingerprint_status(coverage: &mut FingerprintCoverage, file_facts: &FileFacts) {
    let mut status = file_facts
        .callable_fingerprints
        .status
        .max(file_facts.region_fingerprints.status);
    if file_facts.callable_fingerprints.callables.len() > MAX_CALLABLE_FINGERPRINTS_PER_FILE
        || file_facts.region_fingerprints.anchors.len() > MAX_REGION_FINGERPRINTS_PER_FILE
    {
        status = FingerprintExtractionStatus::Truncated;
    }
    match status {
        FingerprintExtractionStatus::Complete => {
            coverage.complete_files = coverage.complete_files.saturating_add(1);
        }
        FingerprintExtractionStatus::Unsupported => {
            coverage.unsupported_files = coverage.unsupported_files.saturating_add(1);
        }
        FingerprintExtractionStatus::ParserFailed => {
            coverage.parser_failed_files = coverage.parser_failed_files.saturating_add(1);
        }
        FingerprintExtractionStatus::Truncated => {
            coverage.truncated_files = coverage.truncated_files.saturating_add(1);
        }
    }
}

fn callable_findings(
    before: &CallableGroups,
    after: &CallableGroups,
    changed_paths: &BTreeSet<RepoPath>,
    suppressed_paths: &BTreeSet<RepoPath>,
    finding_limit: usize,
) -> (Vec<IntroducedDuplicate>, bool) {
    let mut findings = Vec::new();
    let mut truncated = false;
    for (language_family, groups) in after {
        for (digest, after_occurrences) in groups {
            let before_occurrences = before
                .get(language_family)
                .and_then(|group| group.get(digest));
            let before_count = before_occurrences.map_or(0, Vec::len);
            if after_occurrences.len() < 2 || after_occurrences.len() <= before_count {
                continue;
            }
            let before_by_path =
                path_counts(before_occurrences.into_iter().flatten(), |occurrence| {
                    &occurrence.path
                });
            let after_by_path =
                path_counts(after_occurrences.iter(), |occurrence| &occurrence.path);
            let grew_paths = paths_with_growth(&before_by_path, &after_by_path);
            if grew_paths.is_disjoint(changed_paths)
                || (!grew_paths.is_empty() && grew_paths.is_subset(suppressed_paths))
            {
                continue;
            }
            if findings.len() >= finding_limit {
                truncated = true;
                continue;
            }
            let mut occurrences = after_occurrences
                .iter()
                .map(|occurrence| DuplicateOccurrence {
                    path: occurrence.path.clone(),
                    range: Some(occurrence.range),
                    callable_kind: Some(occurrence.kind),
                    changed: changed_paths.contains(&occurrence.path),
                })
                .collect::<Vec<_>>();
            occurrences.sort_by(|left, right| {
                (!left.changed, &left.path, left.range, left.callable_kind).cmp(&(
                    !right.changed,
                    &right.path,
                    right.range,
                    right.callable_kind,
                ))
            });
            let (occurrences, occurrences_truncated) = bound_occurrences(occurrences);
            findings.push(IntroducedDuplicate {
                class_id: format!("dup-{}", short_id(digest)),
                kind: DuplicateKind::CallableBody,
                language_family: Some((*language_family).into()),
                before_count,
                after_count: after_occurrences.len(),
                introduced_count: after_occurrences.len().saturating_sub(before_count),
                bytes: None,
                token_count: after_occurrences
                    .first()
                    .map(|occurrence| occurrence.token_count),
                occurrences,
                occurrences_truncated,
            });
        }
    }
    (findings, truncated)
}

pub(super) fn path_counts<'a, T: 'a>(
    occurrences: impl IntoIterator<Item = &'a T>,
    path: impl Fn(&T) -> &RepoPath,
) -> BTreeMap<RepoPath, usize> {
    let mut counts = BTreeMap::new();
    for occurrence in occurrences {
        let count = counts.entry(path(occurrence).clone()).or_insert(0usize);
        *count = count.saturating_add(1);
    }
    counts
}

pub(super) fn paths_with_growth(
    before: &BTreeMap<RepoPath, usize>,
    after: &BTreeMap<RepoPath, usize>,
) -> BTreeSet<RepoPath> {
    after
        .iter()
        .filter(|(path, count)| before.get(*path).copied().unwrap_or(0) < **count)
        .map(|(path, _)| path.clone())
        .collect()
}

fn bound_occurrences(
    mut occurrences: Vec<DuplicateOccurrence>,
) -> (Vec<DuplicateOccurrence>, bool) {
    let truncated = occurrences.len() > MAX_OBSERVATION_PATHS;
    occurrences.truncate(MAX_OBSERVATION_PATHS);
    (occurrences, truncated)
}

fn short_id(digest: &str) -> &str {
    digest.get(..24).unwrap_or(digest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        analysis,
        cancel::CancelToken,
        facts,
        limits::RuleLimits,
        model::{
            CallableFingerprint, CallableFingerprintFacts, FileFacts, Language, Position,
            RegionFingerprint, RegionFingerprintFacts,
        },
    };
    use base64::Engine as _;
    use std::sync::Arc;

    fn path(value: &str) -> RepoPath {
        RepoPath::from_protocol(value).unwrap()
    }

    fn source(path_value: &str, contents: &str, language: Language) -> crate::model::SourceFile {
        crate::model::SourceFile::new(
            path(path_value),
            contents.as_bytes(),
            language,
            match language {
                Language::JavaScript => "javascript",
                Language::TypeScript => "typescript",
                Language::Rust => "rust",
                Language::Python => "python",
                Language::Go => "go",
                Language::Hcl => "hcl",
                Language::Shell => "shell",
                Language::Protobuf => "protobuf",
            }
            .into(),
        )
    }

    fn parser_options() -> Vec<u8> {
        serde_json::to_vec(&RuleLimits::default()).unwrap()
    }

    fn insert_facts(
        facts_by_file: &mut facts::FactMap,
        snapshot: &SourceSnapshot,
        path_value: &str,
        parser_options: &[u8],
        digests: &[&str],
    ) {
        let file = snapshot.read(&path(path_value)).unwrap();
        let callables = digests
            .iter()
            .enumerate()
            .map(|(index, digest)| CallableFingerprint {
                kind: CallableKind::Function,
                range: SourceRange {
                    start: Position {
                        line: u32::try_from(index + 1).unwrap(),
                        column: 1,
                        byte: u32::try_from(index * 100).unwrap(),
                    },
                    end: Position {
                        line: u32::try_from(index + 10).unwrap(),
                        column: 1,
                        byte: u32::try_from(index * 100 + 99).unwrap(),
                    },
                },
                token_count: 64,
                token_line_count: 10,
                digest: (*digest).into(),
            })
            .collect();
        facts_by_file.insert(
            facts::key(&file, parser_options),
            Arc::new(FileFacts {
                callable_fingerprints: CallableFingerprintFacts {
                    status: FingerprintExtractionStatus::Complete,
                    callables,
                },
                ..FileFacts::default()
            }),
        );
    }

    fn evaluate<'a>(
        before: &'a SourceSnapshot,
        after: &'a SourceSnapshot,
        facts_by_file: &'a facts::FactMap,
        parser_options: &'a [u8],
        change: (&'a BTreeSet<RepoPath>, &'a BTreeMap<RepoPath, RepoPath>),
    ) -> DedupResult {
        let (changed, continuity) = change;
        let fact_keys = fact_key_lookup(&[before, after], parser_options);
        introduced_duplicates(DedupInputs {
            before,
            after,
            file_facts: facts_by_file,
            fact_keys: &fact_keys,
            changed_paths: changed,
            continuity,
            minimum_identical_bytes: 1,
            finding_limit: 32,
        })
    }

    fn fact_key_lookup(snapshots: &[&SourceSnapshot], parser_options: &[u8]) -> FactKeyLookup {
        let mut lookup = FactKeyLookup::new();
        for file in snapshots.iter().flat_map(|snapshot| snapshot.files()) {
            lookup
                .entry(file.content_id)
                .or_default()
                .insert(file.language_mode.clone(), facts::key(file, parser_options));
        }
        lookup
    }

    fn single_file_limit_issues(file_facts: FileFacts) -> Vec<SenseIssue> {
        let snapshot = SourceSnapshot::new([source(
            "large.ts",
            "export const value = true;",
            Language::TypeScript,
        )]);
        let options = parser_options();
        let file = snapshot.read(&path("large.ts")).unwrap();
        let facts_by_file =
            facts::FactMap::from([(facts::key(&file, &options), Arc::new(file_facts))]);
        let fact_keys = fact_key_lookup(&[&snapshot], &options);
        snapshot_limit_issues(
            &snapshot,
            &facts_by_file,
            &fact_keys,
            &[SenseView::After],
            &BTreeSet::new(),
        )
    }

    fn swap_first_encoded_token_records(facts: &mut RegionFingerprintFacts) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&facts.encoded_tokens)
            .unwrap();
        let record_end = |start: usize| {
            let prefix = u16::from_be_bytes(bytes[start + 9..start + 11].try_into().unwrap());
            start + 11 + usize::from(prefix)
        };
        let first_end = record_end(0);
        let second_end = record_end(first_end);
        let mut reordered = Vec::with_capacity(bytes.len());
        reordered.extend_from_slice(&bytes[first_end..second_end]);
        reordered.extend_from_slice(&bytes[..first_end]);
        reordered.extend_from_slice(&bytes[second_end..]);
        facts.encoded_tokens = base64::engine::general_purpose::STANDARD.encode(reordered);
    }

    #[test]
    fn identical_views_still_reject_malformed_exact_evidence() {
        let file = source(
            "same.ts",
            "export function same() { const value = 1; return value + value + value; }",
            Language::TypeScript,
        );
        let snapshot = SourceSnapshot::new([file.clone()]);
        let options = parser_options();
        for corruption in 0..3 {
            let mut analyzed =
                analysis::analyze(&file, &RuleLimits::default(), &CancelToken::new()).unwrap();
            match corruption {
                0 => analyzed.region_fingerprints.encoded_tokens = "not-base64".into(),
                1 => {
                    analyzed.region_fingerprints.encoded_tokens.clear();
                    analyzed.region_fingerprints.token_count = u32::MAX;
                }
                _ => swap_first_encoded_token_records(&mut analyzed.region_fingerprints),
            }
            let facts_by_file =
                facts::FactMap::from([(facts::key(&file, &options), Arc::new(analyzed))]);
            let result = evaluate(
                &snapshot,
                &snapshot,
                &facts_by_file,
                &options,
                (&BTreeSet::new(), &BTreeMap::new()),
            );

            assert_eq!(result.issues.len(), 1);
            assert_eq!(result.issues[0].code, "dedup_exact_evidence_malformed");
            assert_eq!(
                result.issues[0].views,
                vec![SenseView::Before, SenseView::After]
            );
            assert!(result.coverage.before.malformed_evidence);
            assert!(result.coverage.after.malformed_evidence);
        }
    }

    #[test]
    fn malformed_region_does_not_create_a_request_limit_for_later_valid_evidence() {
        let expression = (0..60)
            .map(|index| format!("value{index}"))
            .collect::<Vec<_>>()
            .join(" + ");
        let malformed = source(
            "a-malformed.ts",
            &format!("export function malformed() {{ return {expression}; }}"),
            Language::TypeScript,
        );
        let valid = source(
            "z-valid.ts",
            &format!("export function valid() {{ return 1 + {expression}; }}"),
            Language::TypeScript,
        );
        let options = parser_options();
        let mut malformed_facts =
            analysis::analyze(&malformed, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let valid_facts =
            analysis::analyze(&valid, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let valid_anchor_count = valid_facts.region_fingerprints.anchors.len();
        assert!(valid_anchor_count > 0);
        let anchor = malformed_facts.region_fingerprints.anchors[0];
        malformed_facts.region_fingerprints.anchors =
            vec![anchor; MAX_REGION_FINGERPRINTS_PER_FILE];
        malformed_facts.region_fingerprints.encoded_tokens = "not-base64".into();
        let before = SourceSnapshot::new([]);
        let after = SourceSnapshot::new([malformed.clone(), valid.clone()]);
        let facts_by_file = facts::FactMap::from([
            (facts::key(&malformed, &options), Arc::new(malformed_facts)),
            (facts::key(&valid, &options), Arc::new(valid_facts)),
        ]);
        let result = evaluate(
            &before,
            &after,
            &facts_by_file,
            &options,
            (
                &BTreeSet::from([malformed.path, valid.path]),
                &BTreeMap::new(),
            ),
        );

        assert_eq!(result.issues.len(), 1);
        assert_eq!(result.issues[0].code, "dedup_exact_evidence_malformed");
        assert_eq!(result.coverage.after.region_anchors, valid_anchor_count);
        assert!(!result.coverage.after.request_truncated);
    }

    #[test]
    fn malformed_region_after_valid_capacity_is_still_reported_as_malformed() {
        let large_expression = (0..60)
            .map(|index| format!("value{index}"))
            .collect::<Vec<_>>()
            .join(" + ");
        let large = source(
            "a-valid-00.ts",
            &format!("export function valid() {{ return {large_expression}; }}"),
            Language::TypeScript,
        );
        let small_expression = (0..60)
            .map(|index| format!("value{index}"))
            .collect::<Vec<_>>()
            .join(" + ");
        let small = source(
            "b-small.ts",
            &format!("export function small() {{ return {small_expression}; }}"),
            Language::TypeScript,
        );
        let malformed = source(
            "z-malformed.ts",
            &format!("export function malformed() {{ return 1 + {small_expression}; }}"),
            Language::TypeScript,
        );
        let options = parser_options();
        let mut large_facts =
            analysis::analyze(&large, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let large_anchor = large_facts.region_fingerprints.anchors[0];
        large_facts.region_fingerprints.anchors =
            vec![large_anchor; MAX_REGION_FINGERPRINTS_PER_FILE];
        let small_facts =
            analysis::analyze(&small, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let mut malformed_facts =
            analysis::analyze(&malformed, &RuleLimits::default(), &CancelToken::new()).unwrap();
        let anchor = malformed_facts.region_fingerprints.anchors[0];
        malformed_facts.region_fingerprints.anchors =
            vec![anchor; MAX_REGION_FINGERPRINTS_PER_FILE];
        malformed_facts.region_fingerprints.encoded_tokens = "not-base64".into();

        let valid_files = (0..48).map(|index| {
            source(
                &format!("a-valid-{index:02}.ts"),
                std::str::from_utf8(&large.bytes).unwrap(),
                Language::TypeScript,
            )
        });
        let after = SourceSnapshot::new(valid_files.chain([small.clone(), malformed.clone()]));
        let before = SourceSnapshot::new([]);
        let facts_by_file = facts::FactMap::from([
            (facts::key(&large, &options), Arc::new(large_facts)),
            (facts::key(&small, &options), Arc::new(small_facts)),
            (facts::key(&malformed, &options), Arc::new(malformed_facts)),
        ]);
        let result = evaluate(
            &before,
            &after,
            &facts_by_file,
            &options,
            (
                &BTreeSet::from([small.path, malformed.path]),
                &BTreeMap::new(),
            ),
        );

        assert!(
            result
                .issues
                .iter()
                .any(|issue| issue.code == "dedup_exact_evidence_malformed")
        );
        assert!(
            result
                .issues
                .iter()
                .all(|issue| issue.code != "dedup_region_request_limit")
        );
        assert!(!result.coverage.after.request_truncated);

        let identical = evaluate(
            &after,
            &after,
            &facts_by_file,
            &options,
            (&BTreeSet::new(), &BTreeMap::new()),
        );
        assert_eq!(identical.issues.len(), 1);
        assert_eq!(identical.issues[0].code, "dedup_exact_evidence_malformed");
        assert!(!identical.coverage.before.request_truncated);
        assert!(!identical.coverage.after.request_truncated);
    }

    fn region_request_limit_issue(
        snapshot: &SourceSnapshot,
        facts_by_file: &facts::FactMap,
        options: &[u8],
    ) -> SenseIssue {
        let fact_keys = fact_key_lookup(&[snapshot], options);
        snapshot_limit_issues(
            snapshot,
            facts_by_file,
            &fact_keys,
            &[SenseView::After],
            &BTreeSet::new(),
        )
        .into_iter()
        .find(|issue| issue.code == "dedup_region_request_limit")
        .unwrap()
    }

    #[test]
    fn request_wide_region_limit_names_the_stage_and_affected_paths() {
        let snapshot = SourceSnapshot::new((0..50).map(|index| {
            source(
                &format!("file-{index:02}.ts"),
                "export const shared = true;",
                Language::TypeScript,
            )
        }));
        let options = parser_options();
        let file = snapshot.read(&path("file-00.ts")).unwrap();
        let anchors = (0..MAX_REGION_FINGERPRINTS_PER_FILE)
            .map(|index| RegionFingerprint {
                hash_one: u64::try_from(index).unwrap(),
                hash_two: u64::try_from(index).unwrap(),
                token_index: u32::try_from(index).unwrap(),
            })
            .collect();
        let mut facts_by_file = facts::FactMap::new();
        facts_by_file.insert(
            facts::key(&file, &options),
            Arc::new(FileFacts {
                region_fingerprints: RegionFingerprintFacts {
                    status: FingerprintExtractionStatus::Complete,
                    token_count: u32::try_from(MAX_REGION_FINGERPRINTS_PER_FILE).unwrap(),
                    encoded_tokens: String::new(),
                    anchors,
                },
                ..FileFacts::default()
            }),
        );
        let issue = region_request_limit_issue(&snapshot, &facts_by_file, &options);

        assert_eq!(
            issue.stage,
            Some(DedupLimitStage::TokenRegionRequestCollection)
        );
        assert_eq!(issue.limit, Some(MAX_REGION_FINGERPRINTS_PER_REQUEST));
        assert_eq!(issue.processed, Some(48 * MAX_REGION_FINGERPRINTS_PER_FILE));
        assert_eq!(issue.views, vec![SenseView::After]);
        assert_eq!(issue.paths, vec![path("file-48.ts"), path("file-49.ts")]);
        assert!(!issue.paths_truncated);
    }

    #[test]
    fn region_request_limit_skips_an_overlarge_file_but_admits_a_later_small_file() {
        let counts = (0..48)
            .map(|_| MAX_REGION_FINGERPRINTS_PER_FILE)
            .chain([4_000, 100])
            .collect::<Vec<_>>();
        let snapshot = SourceSnapshot::new(counts.iter().enumerate().map(|(index, _)| {
            source(
                &format!("file-{index:02}.ts"),
                &format!("export const value{index} = true;"),
                Language::TypeScript,
            )
        }));
        let options = parser_options();
        let mut facts_by_file = facts::FactMap::new();
        for (file_index, count) in counts.into_iter().enumerate() {
            let path = path(&format!("file-{file_index:02}.ts"));
            let file = snapshot.read(&path).unwrap();
            let anchors = (0..count)
                .map(|anchor_index| RegionFingerprint {
                    hash_one: u64::try_from(file_index).unwrap(),
                    hash_two: u64::try_from(anchor_index).unwrap(),
                    token_index: u32::try_from(anchor_index).unwrap(),
                })
                .collect();
            facts_by_file.insert(
                facts::key(&file, &options),
                Arc::new(FileFacts {
                    region_fingerprints: RegionFingerprintFacts {
                        status: FingerprintExtractionStatus::Complete,
                        token_count: u32::try_from(count).unwrap(),
                        encoded_tokens: String::new(),
                        anchors,
                    },
                    ..FileFacts::default()
                }),
            );
        }
        let issue = region_request_limit_issue(&snapshot, &facts_by_file, &options);

        assert_eq!(issue.paths, vec![path("file-48.ts")]);
        assert_eq!(
            issue.processed,
            Some(48 * MAX_REGION_FINGERPRINTS_PER_FILE + 100)
        );
        assert!(!issue.processed_is_lower_bound);
    }

    #[test]
    fn per_file_limits_identify_callable_and_region_extraction() {
        let issues = single_file_limit_issues(FileFacts {
            callable_fingerprints: CallableFingerprintFacts {
                status: FingerprintExtractionStatus::Truncated,
                callables: Vec::new(),
            },
            region_fingerprints: RegionFingerprintFacts {
                status: FingerprintExtractionStatus::Truncated,
                ..RegionFingerprintFacts::default()
            },
            ..FileFacts::default()
        });

        for (code, stage, limit) in [
            (
                "dedup_callable_file_limit",
                DedupLimitStage::CallableFileExtraction,
                MAX_CALLABLE_FINGERPRINTS_PER_FILE,
            ),
            (
                "dedup_region_file_limit",
                DedupLimitStage::TokenRegionFileExtraction,
                MAX_REGION_FINGERPRINTS_PER_FILE,
            ),
        ] {
            let issue = issues.iter().find(|issue| issue.code == code).unwrap();
            assert_eq!(issue.stage, Some(stage));
            assert_eq!(issue.limit, Some(limit));
            assert_eq!(issue.processed, Some(limit));
            assert_eq!(issue.views, vec![SenseView::After]);
            assert_eq!(issue.paths, vec![path("large.ts")]);
        }
    }

    #[test]
    fn complete_facts_cannot_exceed_per_file_limits() {
        let callable = CallableFingerprint {
            kind: CallableKind::Function,
            range: SourceRange {
                start: Position {
                    line: 1,
                    column: 1,
                    byte: 0,
                },
                end: Position {
                    line: 1,
                    column: 2,
                    byte: 1,
                },
            },
            token_count: 64,
            token_line_count: 1,
            digest: "sha256:test".into(),
        };
        let anchor = RegionFingerprint {
            hash_one: 1,
            hash_two: 2,
            token_index: 0,
        };
        let issues = single_file_limit_issues(FileFacts {
            callable_fingerprints: CallableFingerprintFacts {
                status: FingerprintExtractionStatus::Complete,
                callables: vec![callable; MAX_CALLABLE_FINGERPRINTS_PER_FILE + 1],
            },
            region_fingerprints: RegionFingerprintFacts {
                status: FingerprintExtractionStatus::Complete,
                token_count: 64,
                encoded_tokens: String::new(),
                anchors: vec![anchor; MAX_REGION_FINGERPRINTS_PER_FILE + 1],
            },
            ..FileFacts::default()
        });

        assert!(
            issues
                .iter()
                .any(|issue| issue.code == "dedup_callable_file_limit")
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == "dedup_region_file_limit")
        );
        assert!(issues.iter().all(|issue| !issue.code.contains("request")));
    }

    #[test]
    fn callable_debt_is_introduced_only_and_same_file_growth_is_actionable() {
        let before = SourceSnapshot::new([source("a.ts", "before", Language::TypeScript)]);
        let after = SourceSnapshot::new([source("a.ts", "after", Language::TypeScript)]);
        let options = parser_options();
        let mut facts_by_file = BTreeMap::new();
        insert_facts(&mut facts_by_file, &before, "a.ts", &options, &["same"]);
        insert_facts(
            &mut facts_by_file,
            &after,
            "a.ts",
            &options,
            &["same", "same"],
        );
        let result = evaluate(
            &before,
            &after,
            &facts_by_file,
            &options,
            (&BTreeSet::from([path("a.ts")]), &BTreeMap::new()),
        );

        assert_eq!(result.findings.len(), 1);
        assert_eq!(result.findings[0].kind, DuplicateKind::CallableBody);
        assert_eq!(result.findings[0].before_count, 1);
        assert_eq!(result.findings[0].after_count, 2);
        assert!(result.findings[0].occurrences[0].changed);
    }

    #[test]
    fn baseline_duplicate_debt_blocks_only_when_another_copy_is_added() {
        let before = SourceSnapshot::new([
            source("a.ts", "one", Language::TypeScript),
            source("b.ts", "two", Language::TypeScript),
        ]);
        let after = SourceSnapshot::new([
            source("a.ts", "one", Language::TypeScript),
            source("b.ts", "two", Language::TypeScript),
            source("c.ts", "three", Language::TypeScript),
        ]);
        let options = parser_options();
        let mut facts_by_file = BTreeMap::new();
        for (snapshot, path_value) in [(&before, "a.ts"), (&before, "b.ts"), (&after, "c.ts")] {
            insert_facts(
                &mut facts_by_file,
                snapshot,
                path_value,
                &options,
                &["shared"],
            );
        }
        let result = evaluate(
            &before,
            &after,
            &facts_by_file,
            &options,
            (&BTreeSet::from([path("c.ts")]), &BTreeMap::new()),
        );

        assert_eq!(result.findings.len(), 1);
        assert_eq!(result.findings[0].before_count, 2);
        assert_eq!(result.findings[0].after_count, 3);
        assert_eq!(result.findings[0].occurrences[0].path, path("c.ts"));
    }

    #[test]
    fn copy_delete_continuity_does_not_invent_a_duplicate() {
        let before = SourceSnapshot::new([
            source("a.ts", "same", Language::TypeScript),
            source("b.ts", "same", Language::TypeScript),
        ]);
        let after = SourceSnapshot::new([
            source("b.ts", "same", Language::TypeScript),
            source("c.ts", "same", Language::TypeScript),
        ]);
        let options = parser_options();
        let mut facts_by_file = BTreeMap::new();
        insert_facts(&mut facts_by_file, &before, "a.ts", &options, &["same"]);
        let continuity = BTreeMap::from([(path("a.ts"), path("c.ts"))]);
        let result = evaluate(
            &before,
            &after,
            &facts_by_file,
            &options,
            (&BTreeSet::from([path("a.ts"), path("c.ts")]), &continuity),
        );

        assert!(result.findings.is_empty());
    }

    #[test]
    fn identical_file_finding_suppresses_its_callable_cascade() {
        let repeated = "same source long enough";
        let before = SourceSnapshot::new([source("a.ts", repeated, Language::TypeScript)]);
        let after = SourceSnapshot::new([
            source("a.ts", repeated, Language::TypeScript),
            source("copy.ts", repeated, Language::TypeScript),
        ]);
        let options = parser_options();
        let mut facts_by_file = BTreeMap::new();
        insert_facts(&mut facts_by_file, &before, "a.ts", &options, &["same"]);
        let result = evaluate(
            &before,
            &after,
            &facts_by_file,
            &options,
            (&BTreeSet::from([path("copy.ts")]), &BTreeMap::new()),
        );

        assert_eq!(result.findings.len(), 1);
        assert_eq!(result.findings[0].kind, DuplicateKind::IdenticalFile);
    }

    #[test]
    fn whole_file_large_group_keeps_the_changed_path_in_its_sample() {
        let repeated = "same source long enough";
        let before = SourceSnapshot::new((0..8).map(|index| {
            source(
                &format!("baseline-{index}.ts"),
                repeated,
                Language::TypeScript,
            )
        }));
        let after = SourceSnapshot::new(before.files().cloned().chain([source(
            "z-new.ts",
            repeated,
            Language::TypeScript,
        )]));
        let options = parser_options();
        let result = evaluate(
            &before,
            &after,
            &BTreeMap::new(),
            &options,
            (&BTreeSet::from([path("z-new.ts")]), &BTreeMap::new()),
        );

        assert_eq!(result.findings.len(), 1);
        assert!(result.findings[0].occurrences_truncated);
        assert_eq!(result.findings[0].occurrences[0].path, path("z-new.ts"));
        assert!(result.findings[0].occurrences[0].changed);
    }

    #[test]
    fn callable_classes_never_cross_language_families() {
        let before = SourceSnapshot::new([]);
        let after = SourceSnapshot::new([
            source("a.ts", "node", Language::TypeScript),
            source("a.py", "python", Language::Python),
        ]);
        let options = parser_options();
        let mut facts_by_file = BTreeMap::new();
        insert_facts(&mut facts_by_file, &after, "a.ts", &options, &["same"]);
        insert_facts(&mut facts_by_file, &after, "a.py", &options, &["same"]);
        let result = evaluate(
            &before,
            &after,
            &facts_by_file,
            &options,
            (
                &BTreeSet::from([path("a.ts"), path("a.py")]),
                &BTreeMap::new(),
            ),
        );

        assert!(result.findings.is_empty());
    }
}
