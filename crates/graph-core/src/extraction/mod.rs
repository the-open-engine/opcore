pub mod diagnostics;
mod discovery;
mod facts;
mod language;
mod parser;
mod python_imports;
mod tsconfig;

#[cfg(test)]
mod tests;

use crate::protocol::{
    GraphExtractionDiagnostic, GraphFactEdge, GraphFactNode, GraphSnapshotMetadata, RepoIdentity,
};
use crate::{GRAPH_PROVIDER_NAME, GRAPH_SCHEMA_VERSION};
use diagnostics::has_error;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use diagnostics::{error, info, warning};
pub use discovery::{
    normalize_repo_relative_path, normalize_watch_paths, DiscoveredSource, DiscoveryResult,
};
pub use facts::FileFacts;
pub use language::SourceLanguage;

pub const DEFAULT_MAX_FILES: usize = 4_000;
pub const DEFAULT_MAX_DEPTH: usize = 64;
pub const EXTRACTION_GENERATED_AT: &str = "2026-06-04T00:00:00.000Z";

#[derive(Debug, Clone)]
pub struct ExtractionOptions {
    pub repo_root: PathBuf,
    pub max_files: usize,
    pub max_depth: usize,
    pub force_missing_parser: bool,
    pub watch_paths: Vec<String>,
}

impl ExtractionOptions {
    pub fn new(repo_root: impl Into<PathBuf>) -> Self {
        Self {
            repo_root: repo_root.into(),
            max_files: DEFAULT_MAX_FILES,
            max_depth: DEFAULT_MAX_DEPTH,
            force_missing_parser: false,
            watch_paths: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileHash {
    pub relative_path: String,
    pub absolute_path: String,
    pub language: String,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct SourceFileHashResult {
    pub repo_root: PathBuf,
    pub repo_root_display: String,
    pub file_hashes: Vec<SourceFileHash>,
    pub diagnostics: Vec<crate::protocol::GraphExtractionDiagnostic>,
}

#[derive(Debug, Clone)]
pub struct ExtractionResult {
    pub metadata: GraphSnapshotMetadata,
    pub nodes: Vec<GraphFactNode>,
    pub edges: Vec<GraphFactEdge>,
    pub diagnostics: Vec<crate::protocol::GraphExtractionDiagnostic>,
    pub file_hashes: Vec<SourceFileHash>,
    pub file_facts: Vec<FileFacts>,
}

pub fn extract_sources(options: ExtractionOptions) -> ExtractionResult {
    let discovery = discover_sources_for_options(&options);
    let mut diagnostics = discovery.diagnostics.clone();
    let file_facts = collect_file_facts_for_sources(&options, &discovery.sources, &mut diagnostics);
    finalize_discovered_sources(&options, &discovery, file_facts, diagnostics)
}

pub fn collect_source_file_hashes(options: ExtractionOptions) -> SourceFileHashResult {
    let discovery = discovery::discover_sources(&options);
    SourceFileHashResult {
        repo_root: discovery.repo_root,
        repo_root_display: discovery.repo_root_display,
        file_hashes: source_file_hashes(&discovery.sources),
        diagnostics: discovery.diagnostics,
    }
}

pub fn discover_sources_for_options(options: &ExtractionOptions) -> DiscoveryResult {
    discovery::discover_sources(options)
}

pub fn source_file_hashes(sources: &[DiscoveredSource]) -> Vec<SourceFileHash> {
    sources
        .iter()
        .map(|source| SourceFileHash {
            relative_path: source.relative_path.clone(),
            absolute_path: source.absolute_path.to_string_lossy().replace('\\', "/"),
            language: source.language.as_str().to_string(),
            sha256: source.sha256.clone(),
        })
        .collect()
}

fn load_tsconfig_if_ready(
    repo_root: &std::path::Path,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> Option<tsconfig::TsConfig> {
    if has_error(diagnostics) {
        return None;
    }
    let loaded = tsconfig::load_tsconfig(repo_root);
    diagnostics.extend(loaded.diagnostics);
    loaded.config
}

pub fn collect_file_facts_for_sources(
    options: &ExtractionOptions,
    sources: &[DiscoveredSource],
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> Vec<facts::FileFacts> {
    if has_error(diagnostics) {
        return Vec::new();
    }
    sources
        .iter()
        .filter(|source| source.language.is_graph_extractable())
        .map(|source| collect_file_fact(source, options.force_missing_parser, diagnostics))
        .collect()
}

fn collect_file_fact(
    source: &DiscoveredSource,
    force_missing_parser: bool,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> facts::FileFacts {
    let file_node = facts::file_node(source);
    match std::fs::read_to_string(&source.absolute_path) {
        Ok(source_text) => parse_file_fact(
            ParseFileFact {
                source,
                file_node,
                source_text: &source_text,
                force_missing_parser,
            },
            diagnostics,
        ),
        Err(read_error) => {
            diagnostics.push(error(
                crate::protocol::GraphExtractionDiagnosticCategory::IoError,
                format!("failed to read source file: {read_error}"),
                Some(source.relative_path.clone()),
                Some(source.language.as_str().to_string()),
            ));
            facts::file_facts_without_ast(source, file_node)
        }
    }
}

struct ParseFileFact<'a> {
    source: &'a DiscoveredSource,
    file_node: GraphFactNode,
    source_text: &'a str,
    force_missing_parser: bool,
}

fn parse_file_fact(
    input: ParseFileFact<'_>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> facts::FileFacts {
    let allocator = oxc_allocator::Allocator::default();
    let parsed = parser::parse_source(
        &allocator,
        input.source_text,
        input.source,
        input.force_missing_parser,
    );
    diagnostics.extend(parsed.diagnostics);
    match parsed.program {
        Some(parser::ParsedProgram::Oxc(program)) => {
            facts::extract_oxc_file_facts(input.source, input.file_node, &program)
        }
        Some(parser::ParsedProgram::Python(tree)) => facts::extract_python_file_facts(
            input.source,
            input.file_node,
            input.source_text,
            &tree,
        ),
        None => facts::file_facts_without_ast(input.source, input.file_node),
    }
}

pub fn finalize_discovered_sources(
    _options: &ExtractionOptions,
    discovery: &DiscoveryResult,
    file_facts: Vec<FileFacts>,
    mut diagnostics: Vec<GraphExtractionDiagnostic>,
) -> ExtractionResult {
    let tsconfig = load_tsconfig_if_ready(&discovery.repo_root, &mut diagnostics);
    let (nodes, edges) = finalize_file_facts(&file_facts, tsconfig.as_ref(), &mut diagnostics);
    let metadata = metadata(&discovery.repo_root_display, &nodes, &edges);
    ExtractionResult {
        metadata,
        nodes,
        edges,
        diagnostics,
        file_hashes: source_file_hashes(&discovery.sources),
        file_facts,
    }
}

fn finalize_file_facts(
    file_facts: &[facts::FileFacts],
    tsconfig: Option<&tsconfig::TsConfig>,
    diagnostics: &mut Vec<GraphExtractionDiagnostic>,
) -> (Vec<GraphFactNode>, Vec<GraphFactEdge>) {
    if has_error(diagnostics) {
        return (Vec::new(), Vec::new());
    }
    let (nodes, edges) = facts::finalize_facts(file_facts, tsconfig, diagnostics);
    if has_error(diagnostics) {
        (Vec::new(), Vec::new())
    } else {
        (nodes, edges)
    }
}

fn metadata(
    repo_root: &str,
    nodes: &[GraphFactNode],
    edges: &[GraphFactEdge],
) -> GraphSnapshotMetadata {
    let mut node_kinds = nodes
        .iter()
        .map(|node| node.kind.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut edge_kinds = edges
        .iter()
        .map(|edge| edge.kind.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    node_kinds.sort();
    edge_kinds.sort();

    GraphSnapshotMetadata {
        schema_version: GRAPH_SCHEMA_VERSION,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        repo: RepoIdentity {
            repo_id: None,
            repo_root: Some(repo_root.to_string()),
            remote_url: None,
            commit_sha: None,
        },
        generated_at: EXTRACTION_GENERATED_AT.to_string(),
        freshness: crate::protocol::GraphFreshness {
            generated_at: EXTRACTION_GENERATED_AT.to_string(),
            age_ms: 0,
            max_age_ms: None,
            stale: false,
            reason: None,
        },
        node_kinds,
        edge_kinds,
    }
}

pub fn boundary_name() -> &'static str {
    "source extraction boundary"
}

pub fn behavior_status() -> &'static str {
    "wave1: staged TypeScript/JavaScript/Python source extraction"
}
