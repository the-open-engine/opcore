use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, BinaryHeap},
    sync::{Arc, Mutex, MutexGuard},
    time::Instant,
};

use rayon::prelude::*;

use crate::{
    analysis::AnalysisError,
    cache::{FactCache, MemoryFactCache, metadata_delta},
    cancel::CancelToken,
    facts,
    identity::hash_domain,
    limits::{MAX_DIAGNOSTICS, MAX_FILES, MAX_TOTAL_SOURCE_BYTES, RuleLimits},
    model::{
        Assessment, AssessmentStatus, Comparison, Coverage, CoverageGap, CoverageStatus,
        Diagnostic, FileFacts, ProviderMetadata, Scope, SourceFile, Timing,
    },
    parallel::worker_pool,
    path::RepoPath,
    source::snapshot::SourceSnapshot,
};

pub struct EvaluationRequest {
    pub before: Option<Arc<SourceSnapshot>>,
    pub after: Arc<SourceSnapshot>,
    pub scope: Scope,
    pub comparison: Comparison,
    pub paths: BTreeSet<RepoPath>,
    pub limits: RuleLimits,
    pub valid_as_of: String,
    /// ASP requires literal set subtraction by the fingerprints it exposes on the wire.
    pub public_fingerprint_comparison: bool,
}

pub struct Engine {
    cache: Arc<dyn FactCache>,
}

const PARALLEL_FILE_THRESHOLD: usize = 8;

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    #[must_use]
    pub fn new() -> Self {
        Self {
            cache: Arc::new(MemoryFactCache::new()),
        }
    }

    #[must_use]
    pub fn with_cache(cache: Arc<dyn FactCache>) -> Self {
        Self { cache }
    }

    /// Evaluates one immutable before/after request.
    ///
    /// # Errors
    ///
    /// Returns an error when fact serialization, worker execution, or deterministic cache
    /// publication fails.
    pub async fn evaluate(
        &self,
        request: EvaluationRequest,
        cancel: CancelToken,
    ) -> anyhow::Result<Assessment> {
        let started = Instant::now();
        let cache_before = self.cache.metadata();
        let prepared = match prepare_evaluation(&request, &cancel, started) {
            Ok(prepared) => prepared,
            Err(assessment) => return Ok(*assessment),
        };
        let PreparedEvaluation {
            inputs,
            path_continuity,
            files_read,
        } = prepared;
        let batch =
            analyze_prepared(inputs, request.limits, Arc::clone(&self.cache), cancel).await?;
        Ok(finalize_assessment(FinalAssessment {
            request,
            path_continuity,
            files_read,
            batch,
            cache_before,
            cache_after: self.cache.metadata(),
            started,
        }))
    }
}

struct PreparedEvaluation {
    inputs: Vec<EvaluationInput>,
    path_continuity: BTreeMap<RepoPath, RepoPath>,
    files_read: usize,
}

fn prepare_evaluation(
    request: &EvaluationRequest,
    cancel: &CancelToken,
    started: Instant,
) -> Result<PreparedEvaluation, Box<Assessment>> {
    let paths = evaluation_paths(request);
    if paths.len() > MAX_FILES {
        return Err(Box::new(incomplete_assessment(
            request.valid_as_of.clone(),
            format!(
                "request includes {} files; limit is {MAX_FILES}",
                paths.len()
            ),
            started,
        )));
    }
    let mut total_bytes = 0usize;
    let mut files_read = 0usize;
    let mut inputs = Vec::with_capacity(paths.len());
    for path in paths {
        if cancel.is_cancelled() {
            return Err(Box::new(cancelled_assessment(
                request.valid_as_of.clone(),
                started,
            )));
        }
        let input = evaluation_input(request, path);
        files_read = files_read.saturating_add(input.file_count());
        total_bytes = total_bytes.saturating_add(input.byte_count());
        if total_bytes > MAX_TOTAL_SOURCE_BYTES {
            return Err(Box::new(incomplete_assessment(
                request.valid_as_of.clone(),
                format!("request source exceeds the {MAX_TOTAL_SOURCE_BYTES}-byte limit"),
                started,
            )));
        }
        inputs.push(input);
    }
    let path_continuity = path_continuity(request.comparison, &inputs);
    Ok(PreparedEvaluation {
        inputs,
        path_continuity,
        files_read,
    })
}

fn evaluation_paths(request: &EvaluationRequest) -> BTreeSet<RepoPath> {
    let mut paths = request.paths.clone();
    if !matches!(request.scope, Scope::Workspace) {
        return paths;
    }
    paths.extend(request.after.paths().cloned());
    if request.comparison != Comparison::All
        && let Some(before) = &request.before
    {
        paths.extend(before.paths().cloned());
    }
    paths
}

fn evaluation_input(request: &EvaluationRequest, path: RepoPath) -> EvaluationInput {
    let after = request.after.read(&path);
    let before = match (&request.before, request.comparison) {
        (Some(view), comparison) if comparison != Comparison::All => view.read(&path),
        _ => None,
    };
    EvaluationInput {
        path,
        before,
        after,
    }
}

fn path_continuity(
    comparison: Comparison,
    inputs: &[EvaluationInput],
) -> BTreeMap<RepoPath, RepoPath> {
    if comparison == Comparison::All {
        BTreeMap::new()
    } else {
        exact_content_path_continuity(inputs)
    }
}

async fn analyze_prepared(
    inputs: Vec<EvaluationInput>,
    limits: RuleLimits,
    cache: Arc<dyn FactCache>,
    cancel: CancelToken,
) -> anyhow::Result<AnalysisBatch> {
    let parser_options = serde_json::to_vec(&limits)?;
    tokio::task::spawn_blocking(move || {
        run_analysis(inputs, &limits, &parser_options, cache.as_ref(), &cancel)
    })
    .await?
}

fn run_analysis(
    inputs: Vec<EvaluationInput>,
    limits: &RuleLimits,
    parser_options: &[u8],
    cache: &dyn FactCache,
    cancel: &CancelToken,
) -> anyhow::Result<AnalysisBatch> {
    let analyze = |input| {
        analyze_input(
            input,
            AnalysisContext {
                limits,
                parser_options,
                cache,
                cancel,
            },
        )
    };
    if inputs.len() < PARALLEL_FILE_THRESHOLD {
        let mut batch = AnalysisBatch::default();
        for input in inputs {
            batch.push(analyze(input)?);
        }
        return Ok(batch);
    }
    let batch = Mutex::new(AnalysisBatch::default());
    let errors = Mutex::new(Vec::new());
    match worker_pool() {
        Some(pool) => pool.install(|| {
            inputs
                .into_par_iter()
                .enumerate()
                .for_each(|(index, input)| match analyze(input) {
                    Ok(result) => lock_unpoisoned(&batch).push(result),
                    Err(error) => lock_unpoisoned(&errors).push((index, error)),
                });
        }),
        None => {
            for (index, input) in inputs.into_iter().enumerate() {
                match analyze(input) {
                    Ok(result) => lock_unpoisoned(&batch).push(result),
                    Err(error) => lock_unpoisoned(&errors).push((index, error)),
                }
            }
        }
    }
    let mut errors = into_unpoisoned(errors);
    if !errors.is_empty() {
        errors.sort_by_key(|(index, _)| *index);
        return Err(errors.remove(0).1);
    }
    Ok(into_unpoisoned(batch))
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn into_unpoisoned<T>(mutex: Mutex<T>) -> T {
    match mutex.into_inner() {
        Ok(value) => value,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[derive(Default)]
struct AnalysisBatch {
    files_considered: usize,
    files_covered: usize,
    coverage_gaps: Vec<CoverageGap>,
    before_diagnostics: BoundedDiagnostics,
    after_diagnostics: BoundedDiagnostics,
    cancelled: bool,
}

impl AnalysisBatch {
    fn push(&mut self, result: AnalyzedInput) {
        self.files_considered = self.files_considered.saturating_add(1);
        match result {
            AnalyzedInput::Ready { before, after } => self.push_ready(before, after),
            AnalyzedInput::Unsupported {
                path,
                language,
                reason,
            } => self.coverage_gaps.push(CoverageGap {
                path,
                status: CoverageStatus::Unsupported,
                language,
                reason: Some(reason),
            }),
            AnalyzedInput::Cancelled { path, language } => {
                self.cancelled = true;
                self.coverage_gaps.push(CoverageGap {
                    path,
                    status: CoverageStatus::Incomplete,
                    language,
                    reason: Some("evaluation cancelled".into()),
                });
            }
        }
    }

    fn push_ready(&mut self, before: Option<Box<AnalyzedFile>>, after: Option<Box<AnalyzedFile>>) {
        self.files_covered = self.files_covered.saturating_add(1);
        if let Some(item) = before {
            self.before_diagnostics.merge(item.diagnostics);
        }
        if let Some(item) = after {
            self.after_diagnostics.merge(item.diagnostics);
        }
    }
}

struct FinalAssessment {
    request: EvaluationRequest,
    path_continuity: BTreeMap<RepoPath, RepoPath>,
    files_read: usize,
    batch: AnalysisBatch,
    cache_before: crate::model::CacheMetadata,
    cache_after: crate::model::CacheMetadata,
    started: Instant,
}

fn finalize_assessment(mut final_state: FinalAssessment) -> Assessment {
    let before_overflowed = final_state.batch.before_diagnostics.overflowed();
    let after_overflowed = final_state.batch.after_diagnostics.overflowed();
    let before_diagnostics =
        std::mem::take(&mut final_state.batch.before_diagnostics).into_sorted();
    let after_diagnostics = std::mem::take(&mut final_state.batch.after_diagnostics).into_sorted();
    let comparison_incomplete = match final_state.request.comparison {
        Comparison::All => after_overflowed,
        Comparison::Introduced => before_overflowed || after_overflowed,
    };
    let diagnostics = match (final_state.request.comparison, before_overflowed) {
        (Comparison::Introduced, true) => Vec::new(),
        _ => compared_diagnostics(
            final_state.request.comparison,
            &before_diagnostics,
            after_diagnostics,
            &final_state.path_continuity,
            final_state.request.public_fingerprint_comparison,
        ),
    };
    if comparison_incomplete {
        let overflowing_view = if before_overflowed && after_overflowed {
            "baseline and candidate views"
        } else if before_overflowed {
            "baseline view"
        } else {
            "candidate view"
        };
        final_state.batch.coverage_gaps.push(CoverageGap {
            path: RepoPath::request_marker(),
            status: CoverageStatus::Incomplete,
            language: None,
            reason: Some(format!(
                "diagnostic working set for the {overflowing_view} exceeded the \
                 {MAX_DIAGNOSTICS}-finding limit; exact comparison is incomplete"
            )),
        });
    }
    final_state
        .batch
        .coverage_gaps
        .sort_by(|left, right| left.path.cmp(&right.path));
    let cache = metadata_delta(&final_state.cache_before, final_state.cache_after);
    let status = assessment_status(
        final_state.batch.cancelled,
        comparison_incomplete,
        &diagnostics,
        &final_state.batch.coverage_gaps,
    );
    Assessment {
        status,
        diagnostics,
        coverage: Coverage {
            files_considered: final_state.batch.files_considered,
            files_covered: final_state.batch.files_covered,
            gaps: final_state.batch.coverage_gaps,
        },
        valid_as_of: final_state.request.valid_as_of,
        provider: ProviderMetadata::default(),
        timing: Timing {
            duration_ms: u64::try_from(final_state.started.elapsed().as_millis())
                .unwrap_or(u64::MAX),
            files_read: final_state.files_read,
            files_parsed: cache.misses,
        },
        cache,
    }
}

fn compared_diagnostics(
    comparison: Comparison,
    before: &[EvaluatedDiagnostic],
    after: Vec<EvaluatedDiagnostic>,
    continuity: &BTreeMap<RepoPath, RepoPath>,
    public_fingerprint_comparison: bool,
) -> Vec<Diagnostic> {
    match comparison {
        Comparison::All => after.into_iter().map(|item| item.diagnostic).collect(),
        Comparison::Introduced if public_fingerprint_comparison => {
            public_fingerprint_difference(after, before)
        }
        Comparison::Introduced => semantic_difference(after, before, continuity),
    }
}

fn public_fingerprint_difference(
    candidates: Vec<EvaluatedDiagnostic>,
    subtract: &[EvaluatedDiagnostic],
) -> Vec<Diagnostic> {
    let prior = subtract
        .iter()
        .map(|item| item.diagnostic.fingerprint.as_str())
        .collect::<BTreeSet<_>>();
    candidates
        .into_iter()
        .filter(|item| !prior.contains(item.diagnostic.fingerprint.as_str()))
        .map(|item| item.diagnostic)
        .collect()
}

fn assessment_status(
    cancelled: bool,
    comparison_incomplete: bool,
    diagnostics: &[Diagnostic],
    coverage_gaps: &[CoverageGap],
) -> AssessmentStatus {
    if cancelled {
        return AssessmentStatus::Cancelled;
    }
    if comparison_incomplete || has_coverage(coverage_gaps, CoverageStatus::Incomplete) {
        return AssessmentStatus::Incomplete;
    }
    if !diagnostics.is_empty() {
        return AssessmentStatus::Findings;
    }
    AssessmentStatus::Clean
}

fn has_coverage(gaps: &[CoverageGap], status: CoverageStatus) -> bool {
    gaps.iter().any(|item| item.status == status)
}

struct EvaluationInput {
    path: RepoPath,
    before: Option<Arc<SourceFile>>,
    after: Option<Arc<SourceFile>>,
}

impl EvaluationInput {
    fn file_count(&self) -> usize {
        usize::from(self.before.is_some()) + usize::from(self.after.is_some())
    }

    fn byte_count(&self) -> usize {
        self.before
            .as_ref()
            .map_or(0, |file| file.bytes.len())
            .saturating_add(self.after.as_ref().map_or(0, |file| file.bytes.len()))
    }
}

fn exact_content_path_continuity(inputs: &[EvaluationInput]) -> BTreeMap<RepoPath, RepoPath> {
    type ContinuityKey = (crate::identity::ContentId, crate::model::Language, String);
    let mut removed = BTreeMap::<ContinuityKey, Vec<RepoPath>>::new();
    let mut added = BTreeMap::<ContinuityKey, Vec<RepoPath>>::new();
    for input in inputs {
        match (&input.before, &input.after) {
            (Some(before), None) => removed
                .entry((
                    before.content_id,
                    before.language,
                    before.language_mode.clone(),
                ))
                .or_default()
                .push(input.path.clone()),
            (None, Some(after)) => added
                .entry((
                    after.content_id,
                    after.language,
                    after.language_mode.clone(),
                ))
                .or_default()
                .push(input.path.clone()),
            _ => {}
        }
    }
    let mut continuity = BTreeMap::new();
    for (key, mut before_paths) in removed {
        let Some(after_paths) = added.get_mut(&key) else {
            continue;
        };
        before_paths.sort();
        after_paths.sort();
        for (before, after) in before_paths.into_iter().zip(after_paths.iter().cloned()) {
            continuity.insert(before, after);
        }
    }
    continuity
}

struct AnalyzedFile {
    diagnostics: BoundedDiagnostics,
}

enum AnalyzedInput {
    Ready {
        before: Option<Box<AnalyzedFile>>,
        after: Option<Box<AnalyzedFile>>,
    },
    Unsupported {
        path: RepoPath,
        language: Option<crate::model::Language>,
        reason: String,
    },
    Cancelled {
        path: RepoPath,
        language: Option<crate::model::Language>,
    },
}

#[derive(Clone, Copy)]
struct AnalysisContext<'a> {
    limits: &'a RuleLimits,
    parser_options: &'a [u8],
    cache: &'a dyn FactCache,
    cancel: &'a CancelToken,
}

fn analyze_input(
    input: EvaluationInput,
    context: AnalysisContext<'_>,
) -> Result<AnalyzedInput, anyhow::Error> {
    let language = input
        .after
        .as_ref()
        .or(input.before.as_ref())
        .map(|file| file.language);
    if input.before.is_none() && input.after.is_none() {
        return Ok(AnalyzedInput::Unsupported {
            path: input.path,
            language: None,
            reason: "path is missing or its language is outside the supported envelope".into(),
        });
    }
    match analyze_pair(input.before.as_deref(), input.after.as_deref(), &context) {
        Ok((before, after)) => Ok(AnalyzedInput::Ready {
            before: before.map(Box::new),
            after: after.map(Box::new),
        }),
        Err(AnalysisError::Unsupported(reason)) => Ok(AnalyzedInput::Unsupported {
            path: input.path,
            language,
            reason,
        }),
        Err(AnalysisError::Cancelled) => Ok(AnalyzedInput::Cancelled {
            path: input.path,
            language,
        }),
        Err(error) => Err(error.into()),
    }
}

fn analyze_pair(
    before: Option<&SourceFile>,
    after: Option<&SourceFile>,
    context: &AnalysisContext<'_>,
) -> Result<(Option<AnalyzedFile>, Option<AnalyzedFile>), AnalysisError> {
    let before = before.map(|file| analyze_one(file, context)).transpose()?;
    let after = after.map(|file| analyze_one(file, context)).transpose()?;
    Ok((before, after))
}

fn analyze_one(
    file: &SourceFile,
    context: &AnalysisContext<'_>,
) -> Result<AnalyzedFile, AnalysisError> {
    let facts = facts::load(
        file,
        context.limits,
        context.parser_options,
        context.cache,
        context.cancel,
    )?;
    Ok(AnalyzedFile {
        diagnostics: materialize(file, &facts),
    })
}

#[derive(Default)]
struct BoundedDiagnostics {
    storage: DiagnosticStorage,
    overflowed: bool,
}

enum DiagnosticStorage {
    Exact(Vec<EvaluatedDiagnostic>),
    Truncated(BinaryHeap<EvaluatedDiagnostic>),
}

impl Default for DiagnosticStorage {
    fn default() -> Self {
        Self::Exact(Vec::new())
    }
}

impl BoundedDiagnostics {
    fn push(&mut self, diagnostic: EvaluatedDiagnostic) {
        match &mut self.storage {
            DiagnosticStorage::Exact(items) if items.len() < MAX_DIAGNOSTICS => {
                items.push(diagnostic);
            }
            DiagnosticStorage::Exact(items) => {
                self.overflowed = true;
                let mut retained = BinaryHeap::from(std::mem::take(items));
                retain_bounded(&mut retained, diagnostic);
                self.storage = DiagnosticStorage::Truncated(retained);
            }
            DiagnosticStorage::Truncated(items) => {
                self.overflowed = true;
                retain_bounded(items, diagnostic);
            }
        }
    }

    fn merge(&mut self, other: Self) {
        self.overflowed |= other.overflowed;
        match other.storage {
            DiagnosticStorage::Exact(items) => {
                for item in items {
                    self.push(item);
                }
            }
            DiagnosticStorage::Truncated(items) => {
                for item in items {
                    self.push(item);
                }
            }
        }
    }

    fn overflowed(&self) -> bool {
        self.overflowed
    }

    fn into_sorted(self) -> Vec<EvaluatedDiagnostic> {
        match self.storage {
            DiagnosticStorage::Exact(mut items) => {
                items.sort_by(diagnostic_order);
                items
            }
            DiagnosticStorage::Truncated(items) => items.into_sorted_vec(),
        }
    }
}

fn retain_bounded(retained: &mut BinaryHeap<EvaluatedDiagnostic>, candidate: EvaluatedDiagnostic) {
    if retained.peek().is_some_and(|largest| candidate < *largest) {
        retained.pop();
        retained.push(candidate);
    }
}

struct EvaluatedDiagnostic {
    diagnostic: Diagnostic,
    comparison_key: String,
    materialization_order: usize,
}

impl PartialEq for EvaluatedDiagnostic {
    fn eq(&self, other: &Self) -> bool {
        diagnostic_order(self, other) == Ordering::Equal
    }
}

impl Eq for EvaluatedDiagnostic {}

impl PartialOrd for EvaluatedDiagnostic {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for EvaluatedDiagnostic {
    fn cmp(&self, other: &Self) -> Ordering {
        diagnostic_order(self, other)
    }
}

fn materialize(file: &SourceFile, facts: &FileFacts) -> BoundedDiagnostics {
    let mut diagnostics = BoundedDiagnostics::default();
    for (materialization_order, raw) in facts.diagnostics.iter().enumerate() {
        let comparison_key = hex::encode(hash_domain(
            "diagnostic-comparison/v1",
            &[
                raw.rule_id.as_bytes(),
                file.language.family().as_bytes(),
                raw.entity_key.as_bytes(),
                raw.cause_key.as_bytes(),
            ],
        ));
        let fingerprint = hex::encode(hash_domain(
            "diagnostic-fingerprint/v1",
            &[file.path.as_bytes(), comparison_key.as_bytes()],
        ));
        diagnostics.push(EvaluatedDiagnostic {
            diagnostic: Diagnostic {
                rule_id: raw.rule_id.clone(),
                severity: raw.severity,
                message: raw.message.clone(),
                path: file.path.clone(),
                range: raw.range,
                fingerprint,
                language: file.language,
                evidence: raw.evidence.clone(),
            },
            comparison_key,
            materialization_order,
        });
    }
    diagnostics
}

fn diagnostic_order(left: &EvaluatedDiagnostic, right: &EvaluatedDiagnostic) -> std::cmp::Ordering {
    left.diagnostic
        .path
        .cmp(&right.diagnostic.path)
        .then_with(|| left.diagnostic.rule_id.cmp(&right.diagnostic.rule_id))
        .then_with(|| {
            left.diagnostic
                .fingerprint
                .cmp(&right.diagnostic.fingerprint)
        })
        .then_with(|| left.materialization_order.cmp(&right.materialization_order))
}

fn semantic_difference(
    candidates: Vec<EvaluatedDiagnostic>,
    subtract: &[EvaluatedDiagnostic],
    continuity: &BTreeMap<RepoPath, RepoPath>,
) -> Vec<Diagnostic> {
    let mut exact_counts = BTreeMap::<(RepoPath, String), usize>::new();
    let mut alias_counts = BTreeMap::<(RepoPath, String), usize>::new();
    for item in subtract {
        *exact_counts
            .entry((item.diagnostic.path.clone(), item.comparison_key.clone()))
            .or_default() += 1;
        if let Some(after) = continuity.get(&item.diagnostic.path) {
            *alias_counts
                .entry((after.clone(), item.comparison_key.clone()))
                .or_default() += 1;
        }
    }
    let mut pending = Vec::new();
    for item in candidates {
        let exact_key = (item.diagnostic.path.clone(), item.comparison_key.clone());
        if !decrement(&mut exact_counts, &exact_key) {
            pending.push(item);
        }
    }
    pending
        .into_iter()
        .filter_map(|item| {
            let alias_key = (item.diagnostic.path.clone(), item.comparison_key.clone());
            if decrement(&mut alias_counts, &alias_key) {
                None
            } else {
                Some(item.diagnostic)
            }
        })
        .collect()
}

fn decrement<K: Ord>(counts: &mut BTreeMap<K, usize>, key: &K) -> bool {
    counts.get_mut(key).is_some_and(|count| {
        if *count == 0 {
            false
        } else {
            *count -= 1;
            true
        }
    })
}

fn incomplete_assessment(valid_as_of: String, reason: String, started: Instant) -> Assessment {
    let path = RepoPath::request_marker();
    Assessment {
        status: AssessmentStatus::Incomplete,
        diagnostics: Vec::new(),
        coverage: Coverage {
            files_considered: 1,
            files_covered: 0,
            gaps: vec![CoverageGap {
                path,
                status: CoverageStatus::Incomplete,
                language: None,
                reason: Some(reason),
            }],
        },
        valid_as_of,
        provider: ProviderMetadata::default(),
        timing: Timing::default().with_duration(started.elapsed()),
        cache: crate::model::CacheMetadata {
            state: "unknown".into(),
            ..crate::model::CacheMetadata::default()
        },
    }
}

fn cancelled_assessment(valid_as_of: String, started: Instant) -> Assessment {
    Assessment {
        status: AssessmentStatus::Cancelled,
        diagnostics: Vec::new(),
        coverage: Coverage::default(),
        valid_as_of,
        provider: ProviderMetadata::default(),
        timing: Timing::default().with_duration(started.elapsed()),
        cache: crate::model::CacheMetadata {
            state: "unknown".into(),
            ..crate::model::CacheMetadata::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cache::CacheError,
        identity::FileFactKey,
        model::{Language, SourceFile},
        source::snapshot::SourceSnapshot,
    };

    fn file_at(path: &str, contents: &str) -> SourceFile {
        SourceFile::new(
            RepoPath::from_protocol(path).unwrap(),
            Arc::<[u8]>::from(contents.as_bytes()),
            Language::JavaScript,
            "javascript:module".into(),
        )
    }

    fn file(contents: &str) -> SourceFile {
        file_at("src/a.js", contents)
    }

    fn evaluated_diagnostic(path: &RepoPath, index: usize) -> EvaluatedDiagnostic {
        EvaluatedDiagnostic {
            diagnostic: Diagnostic {
                rule_id: "test.rule".into(),
                severity: crate::model::Severity::Error,
                message: "finding".into(),
                path: path.clone(),
                range: None,
                fingerprint: format!("fingerprint-{index:05}"),
                language: Language::JavaScript,
                evidence: BTreeMap::new(),
            },
            comparison_key: format!("comparison-{index:05}"),
            materialization_order: index,
        }
    }

    fn assess_bounded_diagnostics(
        comparison: Comparison,
        before_diagnostics: BoundedDiagnostics,
        after_diagnostics: BoundedDiagnostics,
    ) -> Assessment {
        let after = Arc::new(SourceSnapshot::new(Vec::new()));
        let before = matches!(comparison, Comparison::Introduced).then(|| Arc::clone(&after));
        finalize_assessment(FinalAssessment {
            request: EvaluationRequest {
                before,
                after,
                scope: Scope::Workspace,
                comparison,
                paths: BTreeSet::new(),
                limits: RuleLimits::default(),
                valid_as_of: "test".into(),
                public_fingerprint_comparison: false,
            },
            path_continuity: BTreeMap::new(),
            files_read: 0,
            batch: AnalysisBatch {
                before_diagnostics,
                after_diagnostics,
                ..AnalysisBatch::default()
            },
            cache_before: crate::model::CacheMetadata::default(),
            cache_after: crate::model::CacheMetadata::default(),
            started: Instant::now(),
        })
    }

    struct FailingCache;

    impl FactCache for FailingCache {
        fn get(&self, _key: FileFactKey) -> Result<Option<Arc<FileFacts>>, CacheError> {
            Err(std::io::Error::other("cache unavailable").into())
        }

        fn put(&self, _key: FileFactKey, _facts: Arc<FileFacts>) -> Result<(), CacheError> {
            Err(std::io::Error::other("cache unavailable").into())
        }

        fn metadata(&self) -> crate::model::CacheMetadata {
            crate::model::CacheMetadata {
                state: "unavailable".into(),
                ..crate::model::CacheMetadata::default()
            }
        }
    }

    #[tokio::test]
    async fn comparison_uses_semantic_fingerprints_not_positions() {
        let before = Arc::new(SourceSnapshot::new([file("const value = 1;\n")]));
        let after = Arc::new(SourceSnapshot::new([file("\nconst value = 1;\n")]));
        let paths = [RepoPath::from_protocol("src/a.js").unwrap()]
            .into_iter()
            .collect();
        let result = Engine::new()
            .evaluate(
                EvaluationRequest {
                    before: Some(before),
                    after,
                    scope: Scope::Changeset,
                    comparison: Comparison::Introduced,
                    paths,
                    limits: RuleLimits::default(),
                    valid_as_of: "test".into(),
                    public_fingerprint_comparison: false,
                },
                CancelToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.status, AssessmentStatus::Clean);
    }

    #[tokio::test]
    async fn disposable_cache_io_failure_does_not_block_findings() {
        let after = Arc::new(SourceSnapshot::new([file(
            "export function overloaded(a,b,c,d,e,f) { return a; }\n",
        )]));
        let paths = [RepoPath::from_protocol("src/a.js").unwrap()]
            .into_iter()
            .collect();
        let result = Engine::with_cache(Arc::new(FailingCache))
            .evaluate(
                EvaluationRequest {
                    before: None,
                    after,
                    scope: Scope::Changeset,
                    comparison: Comparison::All,
                    paths,
                    limits: RuleLimits::default(),
                    valid_as_of: "cache-failure".into(),
                    public_fingerprint_comparison: false,
                },
                CancelToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.status, AssessmentStatus::Findings);
        assert_eq!(result.diagnostics.len(), 1);
    }

    #[test]
    fn all_comparison_bounds_diagnostics_and_reports_incomplete_coverage() {
        let path = RepoPath::from_protocol("src/a.js").unwrap();
        let mut after_diagnostics = BoundedDiagnostics::default();
        for index in 0..=MAX_DIAGNOSTICS {
            after_diagnostics.push(evaluated_diagnostic(&path, index));
        }
        let result = assess_bounded_diagnostics(
            Comparison::All,
            BoundedDiagnostics::default(),
            after_diagnostics,
        );

        assert_eq!(result.status, AssessmentStatus::Incomplete);
        assert_eq!(result.diagnostics.len(), MAX_DIAGNOSTICS);
        assert_eq!(result.coverage.gaps.len(), 1);
        assert_eq!(result.coverage.gaps[0].path.as_utf8(), Some("_request"));
        assert!(
            result.coverage.gaps[0]
                .reason
                .as_deref()
                .unwrap()
                .contains("candidate view")
        );
    }

    #[test]
    fn introduced_comparison_is_incomplete_when_only_baseline_overflows() {
        let path = RepoPath::from_protocol("src/a.js").unwrap();
        let mut before_diagnostics = BoundedDiagnostics::default();
        for index in 0..=MAX_DIAGNOSTICS {
            before_diagnostics.push(evaluated_diagnostic(&path, index));
        }
        let mut after_diagnostics = BoundedDiagnostics::default();
        after_diagnostics.push(evaluated_diagnostic(&path, MAX_DIAGNOSTICS + 1));
        let result = assess_bounded_diagnostics(
            Comparison::Introduced,
            before_diagnostics,
            after_diagnostics,
        );

        assert_eq!(result.status, AssessmentStatus::Incomplete);
        assert!(result.diagnostics.is_empty());
        assert_eq!(result.coverage.gaps.len(), 1);
        assert!(
            result.coverage.gaps[0]
                .reason
                .as_deref()
                .unwrap()
                .contains("baseline view")
        );
    }

    #[tokio::test]
    async fn semantic_comparison_preserves_rename_continuity_and_duplicate_counts() {
        let bad = "export function repeated(a,b,c,d,e,f) { return a; }\n";
        let before = Arc::new(SourceSnapshot::new([file_at("src/a.js", bad)]));
        let renamed = Arc::new(SourceSnapshot::new([file_at("src/b.js", bad)]));
        let paths = ["src/a.js", "src/b.js"]
            .into_iter()
            .map(|path| RepoPath::from_protocol(path).unwrap())
            .collect::<BTreeSet<_>>();
        let result = Engine::new()
            .evaluate(
                EvaluationRequest {
                    before: Some(Arc::clone(&before)),
                    after: renamed,
                    scope: Scope::Changeset,
                    comparison: Comparison::Introduced,
                    paths: paths.clone(),
                    limits: RuleLimits::default(),
                    valid_as_of: "rename".into(),
                    public_fingerprint_comparison: false,
                },
                CancelToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.status, AssessmentStatus::Clean);

        let duplicated = Arc::new(SourceSnapshot::new([
            file_at("src/a.js", bad),
            file_at("src/b.js", bad),
        ]));
        let result = Engine::new()
            .evaluate(
                EvaluationRequest {
                    before: Some(before),
                    after: duplicated,
                    scope: Scope::Changeset,
                    comparison: Comparison::Introduced,
                    paths,
                    limits: RuleLimits::default(),
                    valid_as_of: "duplicate".into(),
                    public_fingerprint_comparison: false,
                },
                CancelToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].path.to_string(), "src/b.js");
    }

    #[test]
    fn path_continuity_pairs_exact_content_multisets() {
        let same = "export function same(a) { return a; }\n";
        let inputs = vec![
            EvaluationInput {
                path: RepoPath::from_protocol("old-a.js").unwrap(),
                before: Some(Arc::new(file_at("old-a.js", same))),
                after: None,
            },
            EvaluationInput {
                path: RepoPath::from_protocol("old-b.js").unwrap(),
                before: Some(Arc::new(file_at("old-b.js", same))),
                after: None,
            },
            EvaluationInput {
                path: RepoPath::from_protocol("new-a.js").unwrap(),
                before: None,
                after: Some(Arc::new(file_at("new-a.js", same))),
            },
            EvaluationInput {
                path: RepoPath::from_protocol("new-b.js").unwrap(),
                before: None,
                after: Some(Arc::new(file_at("new-b.js", same))),
            },
        ];
        assert_eq!(
            exact_content_path_continuity(&inputs),
            [
                (
                    RepoPath::from_protocol("old-a.js").unwrap(),
                    RepoPath::from_protocol("new-a.js").unwrap()
                ),
                (
                    RepoPath::from_protocol("old-b.js").unwrap(),
                    RepoPath::from_protocol("new-b.js").unwrap()
                )
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn asp_introduced_comparison_is_set_difference_by_fingerprint() {
        let diagnostic = |fingerprint: &str| EvaluatedDiagnostic {
            diagnostic: Diagnostic {
                rule_id: "test.rule".into(),
                severity: crate::model::Severity::Error,
                message: "finding".into(),
                path: RepoPath::from_protocol("src/a.js").unwrap(),
                range: None,
                fingerprint: fingerprint.into(),
                language: Language::JavaScript,
                evidence: BTreeMap::new(),
            },
            comparison_key: fingerprint.into(),
            materialization_order: 0,
        };
        let prior = [diagnostic("old")];
        let candidate = vec![diagnostic("old"), diagnostic("old"), diagnostic("new")];

        assert_eq!(
            public_fingerprint_difference(candidate, &prior)
                .into_iter()
                .map(|item| item.fingerprint)
                .collect::<Vec<_>>(),
            ["new"]
        );
    }

    #[test]
    fn semantic_difference_handles_many_independent_renames() {
        let count = 4_096;
        let diagnostic = |path: RepoPath, comparison_key: String| EvaluatedDiagnostic {
            diagnostic: Diagnostic {
                rule_id: "test.rule".into(),
                severity: crate::model::Severity::Error,
                message: "finding".into(),
                path,
                range: None,
                fingerprint: comparison_key.clone(),
                language: Language::JavaScript,
                evidence: BTreeMap::new(),
            },
            comparison_key,
            materialization_order: 0,
        };
        let continuity = (0..count)
            .map(|index| {
                let before = format!("old/{index:04}.js");
                let after = format!("new/{index:04}.js");
                (
                    RepoPath::from_protocol(&before).unwrap(),
                    RepoPath::from_protocol(&after).unwrap(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let subtract = continuity
            .iter()
            .enumerate()
            .map(|(index, (before, _))| diagnostic(before.clone(), format!("key-{index:04}")))
            .collect::<Vec<_>>();
        let candidates = continuity
            .iter()
            .enumerate()
            .map(|(index, (_, after))| diagnostic(after.clone(), format!("key-{index:04}")))
            .collect::<Vec<_>>();

        assert!(semantic_difference(candidates, &subtract, &continuity).is_empty());
    }
}
