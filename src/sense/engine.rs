use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};

use rayon::prelude::*;

use crate::{
    analysis::AnalysisError,
    cache::{FactCache, MemoryFactCache, metadata_delta},
    cancel::CancelToken,
    facts,
    identity::{ContentId, FileFactKey, hash_domain},
    limits::{MAX_SENSE_FINDINGS, MIN_DEDUP_CALLABLE_TOKENS, MIN_DEDUP_REGION_TOKENS, RuleLimits},
    model::{
        CacheMetadata, DependencyExtractionStatus, DependencyFacts, FileFacts, ProviderMetadata,
        SourceFile,
    },
    parallel::worker_pool,
    path::RepoPath,
    source::snapshot::SourceSnapshot,
};

use super::{
    dedup::{self, DedupInputs, FactKeyLookup},
    graph::{canonicalize, exact_path_continuity, introduced_cycles},
    metrics,
    model::{
        DedupCoverage, DocumentationCoverage, EdgeKind, EffectiveSensePolicy, GraphViewSummary,
        InterfaceFinding, IntroducedCycle, IntroducedDuplicate, Projection, SenseIssue,
        SenseObservations, SenseReport, SenseStatus, SenseTiming,
    },
    resolver,
};

const PARALLEL_FILE_THRESHOLD: usize = 8;

#[derive(Clone, Debug)]
pub struct SenseOptions {
    pub limits: RuleLimits,
    pub high_impact_threshold: usize,
    pub minimum_identical_bytes: usize,
    pub max_dependency_targets: usize,
    pub max_edge_selectors: usize,
    pub max_module_exports: usize,
    pub max_shape_members: usize,
}

impl Default for SenseOptions {
    fn default() -> Self {
        Self {
            limits: RuleLimits::default(),
            high_impact_threshold: 10,
            minimum_identical_bytes: 256,
            max_dependency_targets: 20,
            max_edge_selectors: 8,
            max_module_exports: 20,
            max_shape_members: 20,
        }
    }
}

pub struct SenseRequest {
    pub before: Arc<SourceSnapshot>,
    pub after: Arc<SourceSnapshot>,
    pub changed_paths: BTreeSet<RepoPath>,
    pub before_unsupported_files: usize,
    pub after_unsupported_files: usize,
    pub unsupported_changed_files: usize,
    pub dependency_metadata_changed_files: usize,
    pub go_modules: GoModuleViews,
    pub valid_as_of: String,
    pub options: SenseOptions,
}

#[derive(Clone, Debug, Default)]
pub struct GoModuleViews {
    pub before: BTreeMap<RepoPath, Arc<[u8]>>,
    pub after: BTreeMap<RepoPath, Arc<[u8]>>,
}

pub struct SenseEngine {
    cache: Arc<dyn FactCache>,
}

impl Default for SenseEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SenseEngine {
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

    /// Evaluates a request-local dependency projection and comparison.
    ///
    /// # Errors
    ///
    /// Returns an error when fact analysis, deterministic cache publication, or worker execution
    /// fails.
    pub async fn evaluate(
        &self,
        request: SenseRequest,
        cancel: CancelToken,
    ) -> anyhow::Result<SenseReport> {
        let cache = Arc::clone(&self.cache);
        tokio::task::spawn_blocking(move || evaluate_blocking(request, cache.as_ref(), &cancel))
            .await?
    }
}

fn evaluate_blocking(
    request: SenseRequest,
    cache: &dyn FactCache,
    cancel: &CancelToken,
) -> anyhow::Result<SenseReport> {
    let started = Instant::now();
    let parser_options = serde_json::to_vec(&request.options.limits)?;
    let unique_files = unique_files(&request.before, &request.after, &parser_options);
    let unique_source_bytes = unique_files
        .files
        .values()
        .map(|file| file.bytes.len())
        .sum::<usize>();
    let unique_files_analyzed = unique_files.files.len();
    let cache_before = cache.metadata();

    let facts_started = Instant::now();
    let file_facts = load_facts(
        unique_files.files,
        &request.options.limits,
        &parser_options,
        cache,
        cancel,
    )?;
    let facts_us = elapsed_us(facts_started.elapsed());

    let graph = evaluate_graph(
        &request,
        &file_facts,
        &unique_files.fact_keys,
        &parser_options,
    );
    Ok(build_report(
        request,
        graph,
        &EvaluationContext {
            started,
            cache_before,
            facts_us,
            unique_files_analyzed,
            unique_source_bytes,
        },
        cache.metadata(),
    ))
}

struct EvaluationContext {
    started: Instant,
    cache_before: CacheMetadata,
    facts_us: u64,
    unique_files_analyzed: usize,
    unique_source_bytes: usize,
}

fn build_report(
    request: SenseRequest,
    graph: GraphEvaluation,
    context: &EvaluationContext,
    cache_after: CacheMetadata,
) -> SenseReport {
    let GraphEvaluation {
        before_projection,
        after_projection,
        introduced_cycles,
        introduced_duplicates,
        interface_findings,
        findings_truncated,
        dedup_coverage,
        dedup_issues,
        observations,
        resolution_us,
        cycles_us,
        observations_us,
        dedup_us,
    } = graph;
    let truncation = ReportTruncation {
        findings: findings_truncated,
        observations: observations.truncated,
        impact: observations.impact_truncated,
    };
    let status = sense_status(StatusInputs {
        before: &before_projection,
        after: &after_projection,
        has_findings: !introduced_cycles.is_empty()
            || !introduced_duplicates.is_empty()
            || !interface_findings.is_empty(),
        truncation,
        dedup: &dedup_coverage,
    });
    let before = graph_summary(
        &request.before,
        &request.go_modules.before,
        before_projection,
    );
    let after = graph_summary(&request.after, &request.go_modules.after, after_projection);
    let issues = report_issues(IssueInputs {
        findings_truncated: truncation.findings,
        observations_truncated: truncation.observations,
        impact_truncated: truncation.impact,
        dedup: &dedup_coverage,
        dedup_issues: &dedup_issues,
        before: &before,
        after: &after,
    });

    SenseReport {
        status,
        issues,
        introduced_cycles,
        introduced_duplicates,
        interface_findings,
        documentation_requirements: Vec::new(),
        findings_truncated,
        dedup_coverage,
        documentation_coverage: DocumentationCoverage::default(),
        observations,
        effective_policy: effective_policy(&request.options),
        before,
        after,
        changed_files: request
            .changed_paths
            .len()
            .saturating_add(request.unsupported_changed_files)
            .saturating_add(request.dependency_metadata_changed_files),
        valid_as_of: request.valid_as_of,
        provider: ProviderMetadata::default(),
        timing: SenseTiming {
            total_us: elapsed_us(context.started.elapsed()),
            facts_us: context.facts_us,
            resolution_us,
            cycles_us,
            observations_us,
            dedup_us,
            unique_files_analyzed: context.unique_files_analyzed,
            unique_source_bytes: context.unique_source_bytes,
            ..SenseTiming::default()
        },
        cache: metadata_delta(&context.cache_before, cache_after),
    }
}

struct GraphEvaluation {
    before_projection: Projection,
    after_projection: Projection,
    introduced_cycles: Vec<IntroducedCycle>,
    introduced_duplicates: Vec<IntroducedDuplicate>,
    interface_findings: Vec<InterfaceFinding>,
    findings_truncated: bool,
    dedup_coverage: DedupCoverage,
    dedup_issues: Vec<SenseIssue>,
    observations: SenseObservations,
    resolution_us: u64,
    cycles_us: u64,
    observations_us: u64,
    dedup_us: u64,
}

fn evaluate_graph(
    request: &SenseRequest,
    file_facts: &facts::FactMap,
    fact_keys: &FactKeyLookup,
    parser_options: &[u8],
) -> GraphEvaluation {
    let resolution_started = Instant::now();
    let (mut before_projection, mut after_projection, logical_changed_paths) =
        resolver::project_pair(resolver::PairInput {
            before: &request.before,
            after: &request.after,
            file_facts,
            parser_options,
            interface_paths: &request.changed_paths,
            go_modules: &request.go_modules,
        });
    add_unsupported_coverage(&mut before_projection, request.before_unsupported_files);
    add_unsupported_coverage(&mut after_projection, request.after_unsupported_files);
    let resolution_us = elapsed_us(resolution_started.elapsed());
    let views_match = request.before.id() == request.after.id()
        && request.go_modules.before == request.go_modules.after;
    let continuity = if views_match {
        BTreeMap::new()
    } else {
        exact_path_continuity(&request.before, &request.after)
    };
    let cycles_started = Instant::now();
    let canonical_before =
        (!continuity.is_empty()).then(|| canonicalize(&before_projection, &continuity));
    let comparison_before = canonical_before.as_ref().unwrap_or(&before_projection);
    let mut introduced_cycles = if views_match {
        Vec::new()
    } else {
        introduced_cycles(comparison_before, &after_projection)
    };
    let cycle_count = introduced_cycles.len();
    introduced_cycles.truncate(MAX_SENSE_FINDINGS);
    let cycles_us = elapsed_us(cycles_started.elapsed());
    let observations_started = Instant::now();
    let metrics = metrics::collect(metrics::MetricInputs {
        before: comparison_before,
        after: &after_projection,
        changed_paths: &logical_changed_paths,
        continuity: &continuity,
        high_impact_threshold: request.options.high_impact_threshold,
        max_dependency_targets: request.options.max_dependency_targets,
        max_edge_selectors: request.options.max_edge_selectors,
        max_module_exports: request.options.max_module_exports,
        max_shape_members: request.options.max_shape_members,
    });
    let observations_us = elapsed_us(observations_started.elapsed());
    let dedup_started = Instant::now();
    let mut dedup = dedup::introduced_duplicates(DedupInputs {
        before: &request.before,
        after: &request.after,
        file_facts,
        fact_keys,
        changed_paths: &request.changed_paths,
        continuity: &continuity,
        minimum_identical_bytes: request.options.minimum_identical_bytes,
        finding_limit: MAX_SENSE_FINDINGS.saturating_sub(introduced_cycles.len()),
    });
    let dedup_us = elapsed_us(dedup_started.elapsed());
    let mut interface_findings = metrics.interface_findings;
    let interface_count = interface_findings.len();
    let interface_budget = MAX_SENSE_FINDINGS
        .saturating_sub(introduced_cycles.len())
        .saturating_sub(dedup.findings.len());
    interface_findings.truncate(interface_budget);
    let findings_truncated = cycle_count > MAX_SENSE_FINDINGS
        || dedup.findings_truncated
        || interface_count > interface_budget;
    GraphEvaluation {
        before_projection,
        after_projection,
        introduced_cycles,
        introduced_duplicates: std::mem::take(&mut dedup.findings),
        interface_findings,
        findings_truncated,
        dedup_coverage: dedup.coverage,
        dedup_issues: dedup.issues,
        observations: metrics.observations,
        resolution_us,
        cycles_us,
        observations_us,
        dedup_us,
    }
}

fn add_unsupported_coverage(projection: &mut Projection, files: usize) {
    projection.coverage.files = projection.coverage.files.saturating_add(files);
    projection.coverage.unsupported_files =
        projection.coverage.unsupported_files.saturating_add(files);
    projection.interface_coverage.files = projection.interface_coverage.files.saturating_add(files);
    projection.interface_coverage.unsupported_files = projection
        .interface_coverage
        .unsupported_files
        .saturating_add(files);
}

#[derive(Clone, Copy)]
struct IssueInputs<'a> {
    findings_truncated: bool,
    observations_truncated: bool,
    impact_truncated: bool,
    dedup: &'a DedupCoverage,
    dedup_issues: &'a [SenseIssue],
    before: &'a GraphViewSummary,
    after: &'a GraphViewSummary,
}

fn report_issues(inputs: IssueInputs<'_>) -> Vec<SenseIssue> {
    let mut issues = Vec::new();
    if inputs.findings_truncated {
        issues.push(SenseIssue::new(
            "findings_truncated",
            "sense findings exceeded the report bound",
        ));
    }
    if inputs.observations_truncated {
        issues.push(SenseIssue::new(
            "observations_truncated",
            "sense observations exceeded the report bound",
        ));
    }
    if inputs.impact_truncated {
        issues.push(SenseIssue::new(
            "impact_truncated",
            "reverse-impact traversal reached its request-wide edge-visit bound",
        ));
    }
    if incomplete_summary(inputs.before) || incomplete_summary(inputs.after) {
        issues.push(SenseIssue::new(
            "graph_truncated",
            "dependency/interface facts or confirmed edges/selectors exceeded a resource bound",
        ));
    }
    if incomplete_dedup(inputs.dedup) {
        if inputs.dedup_issues.is_empty() {
            issues.push(SenseIssue::new(
                "dedup_truncated",
                "duplicate fingerprint extraction, request collection, or exact comparison exceeded a resource bound",
            ));
        } else {
            issues.extend_from_slice(inputs.dedup_issues);
        }
    }
    issues
}

fn incomplete_summary(summary: &GraphViewSummary) -> bool {
    summary.coverage.truncated_files > 0
        || summary.coverage.configuration_errors > 0
        || summary.coverage.edges_truncated
        || summary.interface_coverage.truncated_files > 0
        || summary.interface_coverage.selectors_truncated
}

struct UniqueFiles {
    files: BTreeMap<FileFactKey, SourceFile>,
    fact_keys: FactKeyLookup,
}

fn unique_files(
    before: &SourceSnapshot,
    after: &SourceSnapshot,
    parser_options: &[u8],
) -> UniqueFiles {
    let mut files = BTreeMap::new();
    let mut fact_keys = FactKeyLookup::new();
    for file in before.files().chain(after.files()) {
        let key = facts::key(file, parser_options);
        files.insert(key, file.clone());
        fact_keys
            .entry(file.content_id)
            .or_default()
            .insert(file.language_mode.clone(), key);
    }
    UniqueFiles { files, fact_keys }
}

fn load_facts(
    files: BTreeMap<FileFactKey, SourceFile>,
    limits: &RuleLimits,
    parser_options: &[u8],
    cache: &dyn FactCache,
    cancel: &CancelToken,
) -> anyhow::Result<facts::FactMap> {
    let files = files.into_iter().collect::<Vec<_>>();
    let load = |(key, file): (FileFactKey, SourceFile)| {
        let facts = match facts::load(&file, limits, parser_options, cache, cancel) {
            Ok(facts) => facts,
            Err(AnalysisError::Unsupported(_)) => Arc::new(unsupported_facts()),
            Err(error) => return Err(anyhow::Error::new(error)),
        };
        Ok((key, facts))
    };
    let loaded = if files.len() < PARALLEL_FILE_THRESHOLD {
        files.into_iter().map(load).collect::<Vec<_>>()
    } else {
        match worker_pool() {
            Some(pool) => pool.install(|| files.into_par_iter().map(load).collect()),
            None => files.into_iter().map(load).collect(),
        }
    };
    loaded.into_iter().collect()
}

fn unsupported_facts() -> FileFacts {
    FileFacts {
        dependencies: DependencyFacts {
            status: DependencyExtractionStatus::Unsupported,
            ..DependencyFacts::default()
        },
        ..FileFacts::default()
    }
}

fn graph_summary(
    snapshot: &SourceSnapshot,
    module_files: &BTreeMap<RepoPath, Arc<[u8]>>,
    projection: Projection,
) -> GraphViewSummary {
    let runtime_edges = projection.runtime_edges().count();
    let structural_edges = projection
        .edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::Structural)
        .count();
    let interface_edges = projection.interface_edges.len();
    GraphViewSummary {
        view_id: graph_view_id(snapshot, module_files),
        files: projection.coverage.files,
        runtime_edges,
        type_only_edges: projection
            .edges
            .len()
            .saturating_sub(runtime_edges)
            .saturating_sub(structural_edges),
        structural_edges,
        coverage: projection.coverage,
        resolution_gaps: projection.resolution_gaps.into_iter().collect(),
        resolution_gaps_truncated: projection.resolution_gaps_truncated,
        interface_edges,
        interface_coverage: projection.interface_coverage,
    }
}

fn graph_view_id(
    snapshot: &SourceSnapshot,
    module_files: &BTreeMap<RepoPath, Arc<[u8]>>,
) -> String {
    if module_files.is_empty() {
        return snapshot.id().hex();
    }
    let mut manifest = Vec::new();
    for (path, bytes) in module_files {
        manifest.extend_from_slice(&(path.as_bytes().len() as u64).to_be_bytes());
        manifest.extend_from_slice(path.as_bytes());
        manifest.extend_from_slice(ContentId::of(bytes).as_bytes());
    }
    hex::encode(hash_domain(
        "sense-graph-view/v1",
        &[snapshot.id().hex().as_bytes(), &manifest],
    ))
}

#[derive(Clone, Copy)]
struct StatusInputs<'a> {
    before: &'a Projection,
    after: &'a Projection,
    has_findings: bool,
    truncation: ReportTruncation,
    dedup: &'a DedupCoverage,
}

#[derive(Clone, Copy)]
struct ReportTruncation {
    findings: bool,
    observations: bool,
    impact: bool,
}

fn sense_status(inputs: StatusInputs<'_>) -> SenseStatus {
    if status_incomplete(&inputs) {
        SenseStatus::Incomplete
    } else if status_partial(&inputs) {
        SenseStatus::Partial
    } else if inputs.has_findings {
        SenseStatus::Findings
    } else {
        SenseStatus::Clean
    }
}

fn status_incomplete(inputs: &StatusInputs<'_>) -> bool {
    inputs.truncation.findings
        || inputs.truncation.observations
        || incomplete_coverage(inputs.before)
        || incomplete_coverage(inputs.after)
        || incomplete_dedup(inputs.dedup)
}

fn status_partial(inputs: &StatusInputs<'_>) -> bool {
    inputs.truncation.impact
        || partial_coverage(inputs.before)
        || partial_coverage(inputs.after)
        || partial_dedup(inputs.dedup)
}

fn incomplete_dedup(coverage: &DedupCoverage) -> bool {
    coverage.before.truncated_files > 0
        || coverage.after.truncated_files > 0
        || coverage.before.request_truncated
        || coverage.after.request_truncated
        || coverage.before.malformed_evidence
        || coverage.after.malformed_evidence
}

fn partial_dedup(coverage: &DedupCoverage) -> bool {
    coverage.before.unsupported_files > 0
        || coverage.after.unsupported_files > 0
        || coverage.before.parser_failed_files > 0
        || coverage.after.parser_failed_files > 0
}

fn incomplete_coverage(projection: &Projection) -> bool {
    projection.coverage.truncated_files > 0
        || projection.coverage.configuration_errors > 0
        || projection.coverage.edges_truncated
        || projection.interface_coverage.truncated_files > 0
        || projection.interface_coverage.truncated_public_surfaces > 0
        || projection.interface_coverage.selectors_truncated
}

fn partial_coverage(projection: &Projection) -> bool {
    let coverage = &projection.coverage;
    coverage.unsupported_files > 0
        || coverage.parser_failed_files > 0
        || coverage.node_builtin_references > 0
        || coverage.external_references > 0
        || coverage.ambiguous_references > 0
        || coverage.unresolved_references > 0
        || coverage.unsupported_dynamic_references > 0
        || partial_interface_coverage(projection)
}

fn partial_interface_coverage(projection: &Projection) -> bool {
    projection.interface_coverage.partial_files > 0
        || projection.interface_coverage.unsupported_files > 0
        || projection.interface_coverage.parser_failed_files > 0
        || projection.interface_coverage.partial_public_surfaces > 0
        || projection.interface_coverage.unsupported_public_surfaces > 0
}

pub(super) fn effective_policy(options: &SenseOptions) -> EffectiveSensePolicy {
    EffectiveSensePolicy {
        minimum_identical_bytes: options.minimum_identical_bytes,
        minimum_callable_tokens: MIN_DEDUP_CALLABLE_TOKENS,
        minimum_region_tokens: MIN_DEDUP_REGION_TOKENS,
        max_dependency_targets: options.max_dependency_targets,
        max_edge_selectors: options.max_edge_selectors,
        max_module_exports: options.max_module_exports,
        max_shape_members: options.max_shape_members,
        important_fan_in: options.high_impact_threshold,
        documentation_registry: crate::documentation::DOCUMENTATION_REGISTRY_PATH.into(),
        excluded_paths: Vec::new(),
    }
}

fn elapsed_us(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Language;

    fn source(path: &str, source: &str) -> SourceFile {
        SourceFile::new(
            RepoPath::from_protocol(path).unwrap(),
            source.as_bytes(),
            Language::TypeScript,
            "typescript".into(),
        )
    }

    fn request(
        before: Arc<SourceSnapshot>,
        after: Arc<SourceSnapshot>,
        changed_paths: impl IntoIterator<Item = &'static str>,
    ) -> SenseRequest {
        SenseRequest {
            before,
            after,
            changed_paths: changed_paths
                .into_iter()
                .map(|path| RepoPath::from_protocol(path).unwrap())
                .collect(),
            before_unsupported_files: 0,
            after_unsupported_files: 0,
            unsupported_changed_files: 0,
            dependency_metadata_changed_files: 0,
            go_modules: GoModuleViews::default(),
            valid_as_of: "test".into(),
            options: SenseOptions::default(),
        }
    }

    #[tokio::test]
    async fn reports_only_an_introduced_runtime_cycle_as_a_finding() {
        let before = Arc::new(SourceSnapshot::new([
            source("a.ts", "import './b';\n"),
            source("b.ts", "export const b = 1;\n"),
        ]));
        let after = Arc::new(SourceSnapshot::new([
            source("a.ts", "import './b';\n"),
            source("b.ts", "import './a';\nexport const b = 1;\n"),
        ]));
        let report = SenseEngine::new()
            .evaluate(request(before, after, ["b.ts"]), CancelToken::new())
            .await
            .unwrap();

        assert_eq!(report.status, SenseStatus::Findings);
        assert_eq!(report.introduced_cycles.len(), 1);
        assert_eq!(report.introduced_cycles[0].member_count, 2);
        assert_eq!(report.cache.misses, 3);
    }

    #[tokio::test]
    async fn type_only_cycle_is_nonblocking() {
        let empty = Arc::new(SourceSnapshot::new([]));
        let after = Arc::new(SourceSnapshot::new([
            source("a.ts", "import type { B } from './b';\n"),
            source("b.ts", "import type { A } from './a';\n"),
        ]));
        let report = SenseEngine::new()
            .evaluate(request(empty, after, ["a.ts", "b.ts"]), CancelToken::new())
            .await
            .unwrap();

        assert_eq!(report.status, SenseStatus::Clean);
        assert!(report.introduced_cycles.is_empty());
        assert_eq!(report.after.type_only_edges, 2);
    }
}
