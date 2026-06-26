use crate::extraction::{
    collect_file_facts_for_sources, discover_sources_for_options, finalize_discovered_sources,
    normalize_watch_paths, source_file_hashes, DiscoveredSource, ExtractionOptions, FileFacts,
};
use crate::protocol::{
    available_status_with_wal_checkpoint, AvailableStatusInput, GraphExtractionDiagnostic,
    GraphExtractionDiagnosticCategory, GraphExtractionDiagnosticSeverity, GraphPipelinePhaseTiming,
    GraphPipelineResult, GraphPipelineSummary, GraphProviderStatus, RepoIdentity,
};
use crate::store::{
    GraphStore, SnapshotRefreshOptions, StoreError, StorePaths, StoreSnapshot,
    DEFAULT_WAL_BUDGET_BYTES,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Instant;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Debug, Clone)]
pub struct GraphPipelineOptions {
    pub repo_root: PathBuf,
    pub base_ref: Option<String>,
    pub watch_paths: Vec<String>,
    pub max_wal_bytes: u64,
}

impl GraphPipelineOptions {
    pub fn new(repo_root: impl Into<PathBuf>) -> Self {
        Self {
            repo_root: repo_root.into(),
            base_ref: None,
            watch_paths: Vec::new(),
            max_wal_bytes: DEFAULT_WAL_BUDGET_BYTES,
        }
    }

    fn extraction_options(&self) -> ExtractionOptions {
        let mut options = ExtractionOptions::new(&self.repo_root);
        options.watch_paths = self.watch_paths.clone();
        options
    }
}

#[derive(Debug)]
struct Timed<T> {
    value: T,
    timing: GraphPipelinePhaseTiming,
}

struct SnapshotInput {
    extraction_options: ExtractionOptions,
    discovered: crate::extraction::DiscoveryResult,
    current_hashes: Vec<crate::extraction::SourceFileHash>,
    file_facts: Vec<FileFacts>,
    parsed_files: usize,
    changed_files: Vec<String>,
    deleted_files: Vec<String>,
    unchanged_files: usize,
    full_rebuild_required: bool,
    diagnostics: Vec<GraphExtractionDiagnostic>,
    phase_timings: Vec<GraphPipelinePhaseTiming>,
}

struct SnapshotSourceContext<'a> {
    options: &'a GraphPipelineOptions,
    extraction_options: &'a ExtractionOptions,
    discovery: &'a crate::extraction::DiscoveryResult,
    current_hashes: &'a [crate::extraction::SourceFileHash],
}

pub fn build_full_snapshot(
    options: GraphPipelineOptions,
) -> Result<GraphPipelineResult, StoreError> {
    write_snapshot(options, "build", false, None)
}

pub fn update_snapshot(options: GraphPipelineOptions) -> Result<GraphPipelineResult, StoreError> {
    let store = GraphStore::open(StorePaths::for_repo_root(&options.repo_root))?;
    if store.search_schema_repaired() {
        return write_snapshot(options, "update", true, None);
    }
    let cached = store.cached_file_facts()?;
    if cached.is_empty() || store.file_hashes()?.is_empty() {
        return write_snapshot(options, "update", true, None);
    }
    write_snapshot(options, "update", false, Some(cached))
}

fn write_snapshot(
    mut options: GraphPipelineOptions,
    operation: &str,
    full_rebuild_required: bool,
    cached_file_facts: Option<Vec<FileFacts>>,
) -> Result<GraphPipelineResult, StoreError> {
    options.watch_paths = normalized_pipeline_watch_paths(&options.watch_paths)?;
    let started = Instant::now();
    let started_at = now_rfc3339();
    let input = snapshot_input(&options, full_rebuild_required, cached_file_facts)?;
    fail_on_diagnostics(&input.diagnostics)?;
    let extraction = finalize_discovered_sources(
        &input.extraction_options,
        &input.discovered,
        input.file_facts,
        input.diagnostics,
    );
    fail_on_diagnostics(&extraction.diagnostics)?;
    let diagnostics_count = extraction.diagnostics.len();
    let snapshot = store_snapshot(extraction);
    let mut store = GraphStore::open(StorePaths::for_repo_root(&options.repo_root))?;
    let store_timing = timed("store", || {
        store.refresh_snapshot_with_operation(
            snapshot,
            SnapshotRefreshOptions {
                operation,
                changed_files: &input.changed_files,
                deleted_files: &input.deleted_files,
                full_rebuild_required: input.full_rebuild_required,
            },
        )
    });
    store_timing.value?;
    let wal_checkpoint = store.checkpoint_wal_if_over_budget(options.max_wal_bytes)?;
    let completed_at = now_rfc3339();
    let phase_timings = with_store_timing(input.phase_timings, store_timing.timing);
    let summary = GraphPipelineSummary {
        operation: operation.to_string(),
        repo: repo_identity(&store.paths().repo_root),
        store_path: Some(display_path(&store.paths().db_path)),
        started_at,
        completed_at: completed_at.clone(),
        duration_ms: elapsed_millis_u64(started),
        discovered_files: input.current_hashes.len(),
        parsed_files: input.parsed_files,
        changed_files: input.changed_files,
        deleted_files: input.deleted_files,
        unchanged_files: input.unchanged_files,
        full_rebuild_required: input.full_rebuild_required,
        diagnostics_count,
        phase_timings,
        base_ref: options.base_ref,
        watch_paths: options.watch_paths.clone(),
        wal_checkpoint: Some(wal_checkpoint),
    };
    store.record_pipeline_summary(&summary)?;
    let status = store.status_for_watch_paths(None, &options.watch_paths)?;
    let status = attach_store_message(status, operation, completed_at);
    Ok(GraphPipelineResult {
        summary,
        status,
        lifecycle: None,
    })
}

fn normalized_pipeline_watch_paths(watch_paths: &[String]) -> Result<Vec<String>, StoreError> {
    normalize_watch_paths(watch_paths).map_err(|message| StoreError::ExtractionFailed {
        message: format!("Graph extraction failed: {message}"),
        diagnostics: vec![GraphExtractionDiagnostic {
            category: GraphExtractionDiagnosticCategory::PathTraversal,
            severity: GraphExtractionDiagnosticSeverity::Error,
            message,
            path: None,
            language: None,
        }],
    })
}

fn snapshot_input(
    options: &GraphPipelineOptions,
    full_rebuild_required: bool,
    cached_file_facts: Option<Vec<FileFacts>>,
) -> Result<SnapshotInput, StoreError> {
    let extraction_options = options.extraction_options();
    let discovered = timed("discovery", || {
        discover_sources_for_options(&extraction_options)
    });
    let mut diagnostics = discovered.value.diagnostics.clone();
    let current_hashes = source_file_hashes(&discovered.value.sources);
    let mut phase_timings = vec![discovered.timing];
    let context = SnapshotSourceContext {
        options,
        extraction_options: &extraction_options,
        discovery: &discovered.value,
        current_hashes: &current_hashes,
    };
    let facts = match cached_file_facts {
        Some(cached) if !full_rebuild_required => {
            incremental_file_facts(&context, cached, &mut diagnostics)?
        }
        _ => full_file_facts(&context, &mut diagnostics, full_rebuild_required),
    };
    phase_timings.push(facts.timing);
    Ok(SnapshotInput {
        extraction_options,
        discovered: discovered.value,
        current_hashes,
        file_facts: facts.file_facts,
        parsed_files: facts.parsed_files,
        changed_files: facts.changed_files,
        deleted_files: facts.deleted_files,
        unchanged_files: facts.unchanged_files,
        full_rebuild_required: facts.full_rebuild_required,
        diagnostics,
        phase_timings,
    })
}

struct FileFactPlan {
    file_facts: Vec<FileFacts>,
    parsed_files: usize,
    changed_files: Vec<String>,
    deleted_files: Vec<String>,
    unchanged_files: usize,
    full_rebuild_required: bool,
    timing: GraphPipelinePhaseTiming,
}

fn incremental_file_facts(
    context: &SnapshotSourceContext<'_>,
    cached: Vec<FileFacts>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> Result<FileFactPlan, StoreError> {
    let store = GraphStore::open(StorePaths::for_repo_root(&context.options.repo_root))?;
    let delta = source_delta(&store.file_hashes()?, context.current_hashes);
    let changed_sources = sources_for_paths(&context.discovery.sources, &delta.changed_files);
    let changed_extractable_sources = graph_extractable_sources(&changed_sources);
    let parsed = timed("extraction", || {
        collect_file_facts_for_sources(
            context.extraction_options,
            &changed_extractable_sources,
            diagnostics,
        )
    });
    let cache = CachedFacts::new(
        cached,
        context.current_hashes,
        &context.discovery.sources,
        &delta.changed_files,
    );
    if cache.missing_unchanged_file() {
        return Ok(full_file_facts(context, diagnostics, true));
    }
    let unchanged_files = cache.unchanged_files();
    let parsed_files = changed_extractable_sources.len();
    Ok(FileFactPlan {
        file_facts: cache.merge(parsed.value),
        parsed_files,
        changed_files: delta.changed_files,
        deleted_files: delta.deleted_files,
        unchanged_files,
        full_rebuild_required: false,
        timing: with_file_count(parsed.timing, parsed_files),
    })
}

fn full_file_facts(
    context: &SnapshotSourceContext<'_>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
    full_rebuild_required: bool,
) -> FileFactPlan {
    let extractable_sources = graph_extractable_sources(&context.discovery.sources);
    let parsed = timed("extraction", || {
        collect_file_facts_for_sources(
            context.extraction_options,
            &extractable_sources,
            diagnostics,
        )
    });
    let parsed_files = extractable_sources.len();
    FileFactPlan {
        file_facts: parsed.value,
        parsed_files,
        changed_files: context
            .current_hashes
            .iter()
            .map(|hash| hash.relative_path.clone())
            .collect(),
        deleted_files: Vec::new(),
        unchanged_files: 0,
        full_rebuild_required,
        timing: with_file_count(parsed.timing, parsed_files),
    }
}

struct CachedFacts {
    by_path: BTreeMap<String, FileFacts>,
    current_fact_paths: BTreeSet<String>,
    changed_paths: BTreeSet<String>,
    current_count: usize,
}

impl CachedFacts {
    fn new(
        cached: Vec<FileFacts>,
        current_hashes: &[crate::extraction::SourceFileHash],
        current_sources: &[DiscoveredSource],
        changed_files: &[String],
    ) -> Self {
        Self {
            by_path: cached
                .into_iter()
                .map(|facts| (facts.path.clone(), facts))
                .collect(),
            current_fact_paths: current_sources
                .iter()
                .filter(|source| source.language.is_graph_extractable())
                .map(|source| source.relative_path.clone())
                .collect(),
            changed_paths: changed_files.iter().cloned().collect(),
            current_count: current_hashes.len(),
        }
    }

    fn missing_unchanged_file(&self) -> bool {
        self.current_fact_paths
            .iter()
            .any(|path| !self.changed_paths.contains(path) && !self.by_path.contains_key(path))
    }

    fn unchanged_files(&self) -> usize {
        self.current_count.saturating_sub(self.changed_paths.len())
    }

    fn merge(self, parsed: Vec<FileFacts>) -> Vec<FileFacts> {
        let mut merged = self
            .by_path
            .into_iter()
            .filter(|(path, _)| {
                self.current_fact_paths.contains(path) && !self.changed_paths.contains(path)
            })
            .map(|(_, facts)| facts)
            .collect::<Vec<_>>();
        merged.extend(parsed);
        merged.sort_by(|left, right| left.path.cmp(&right.path));
        merged
    }
}

fn store_snapshot(extraction: crate::extraction::ExtractionResult) -> StoreSnapshot {
    StoreSnapshot {
        metadata: extraction.metadata,
        nodes: extraction.nodes,
        edges: extraction.edges,
        diagnostics: extraction.diagnostics,
        file_hashes: extraction.file_hashes,
        file_facts: extraction.file_facts,
    }
}

fn with_store_timing(
    mut phase_timings: Vec<GraphPipelinePhaseTiming>,
    store_timing: GraphPipelinePhaseTiming,
) -> Vec<GraphPipelinePhaseTiming> {
    phase_timings.push(store_timing);
    phase_timings
}

fn timed<T>(phase: &str, run: impl FnOnce() -> T) -> Timed<T> {
    let started = Instant::now();
    let started_at = now_rfc3339();
    let value = run();
    let completed_at = now_rfc3339();
    Timed {
        value,
        timing: GraphPipelinePhaseTiming {
            phase: phase.to_string(),
            started_at,
            completed_at,
            duration_ms: elapsed_millis_u64(started),
            file_count: None,
        },
    }
}

fn elapsed_millis_u64(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn with_file_count(
    mut timing: GraphPipelinePhaseTiming,
    file_count: usize,
) -> GraphPipelinePhaseTiming {
    timing.file_count = Some(file_count);
    timing
}

#[derive(Debug)]
struct SourceDelta {
    changed_files: Vec<String>,
    deleted_files: Vec<String>,
}

fn source_delta(
    stored: &[crate::extraction::SourceFileHash],
    current: &[crate::extraction::SourceFileHash],
) -> SourceDelta {
    let stored_by_path = stored
        .iter()
        .map(|hash| (hash.relative_path.as_str(), hash.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    let current_by_path = current
        .iter()
        .map(|hash| (hash.relative_path.as_str(), hash.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    let mut changed_files = current_by_path
        .iter()
        .filter_map(|(path, sha)| match stored_by_path.get(path) {
            Some(stored_sha) if stored_sha == sha => None,
            _ => Some((*path).to_string()),
        })
        .collect::<Vec<_>>();
    let mut deleted_files = stored_by_path
        .keys()
        .filter(|path| !current_by_path.contains_key(**path))
        .map(|path| (*path).to_string())
        .collect::<Vec<_>>();
    changed_files.sort();
    deleted_files.sort();
    SourceDelta {
        changed_files,
        deleted_files,
    }
}

fn sources_for_paths(sources: &[DiscoveredSource], paths: &[String]) -> Vec<DiscoveredSource> {
    let wanted = paths.iter().map(String::as_str).collect::<BTreeSet<_>>();
    sources
        .iter()
        .filter(|source| wanted.contains(source.relative_path.as_str()))
        .cloned()
        .collect()
}

fn graph_extractable_sources(sources: &[DiscoveredSource]) -> Vec<DiscoveredSource> {
    sources
        .iter()
        .filter(|source| source.language.is_graph_extractable())
        .cloned()
        .collect()
}

fn fail_on_diagnostics(diagnostics: &[GraphExtractionDiagnostic]) -> Result<(), StoreError> {
    if !diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == GraphExtractionDiagnosticSeverity::Error)
    {
        return Ok(());
    }
    let message = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == GraphExtractionDiagnosticSeverity::Error)
        .map(|diagnostic| diagnostic.message.clone())
        .collect::<Vec<_>>()
        .join("; ");
    Err(StoreError::ExtractionFailed {
        message: format!("Graph extraction failed: {message}"),
        diagnostics: diagnostics.to_vec(),
    })
}

fn attach_store_message(
    status: GraphProviderStatus,
    operation: &str,
    generated_at: String,
) -> GraphProviderStatus {
    match status {
        GraphProviderStatus::Available {
            repo,
            freshness,
            db_path,
            wal_checkpoint,
            ..
        } => available_status_with_wal_checkpoint(AvailableStatusInput {
            repo,
            freshness,
            db_path,
            message: Some(format!(
                "GraphProvider {operation} completed at {generated_at}"
            )),
            wal_checkpoint,
        }),
        other => other,
    }
}

pub fn repo_identity(repo_root: &Path) -> RepoIdentity {
    RepoIdentity {
        repo_id: None,
        repo_root: Some(display_path(repo_root)),
        remote_url: None,
        commit_sha: None,
    }
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| crate::extraction::EXTRACTION_GENERATED_AT.to_string())
}
