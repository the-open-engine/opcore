use crate::extraction::{
    discover_sources_for_options, normalize_repo_relative_path, ExtractionOptions, SourceLanguage,
};
use crate::protocol::RepoIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use thiserror::Error;

mod persistence;
mod store;

use persistence::should_persist_clone_index;
use store::persist_clone_index;

const CLONE_PROTOCOL: &str = "opcore.clone.v1";
const CLONE_SCHEMA_VERSION: u32 = 1;
const CLONE_STORE_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MIN_LINES: usize = 5;
const DEFAULT_MIN_TOKENS: usize = 20;

#[derive(Debug, Error)]
pub enum CloneError {
    #[error("clone analysis request is invalid: {0}")]
    InvalidRequest(String),
    #[error("clone analysis requires repo.repoRoot")]
    MissingRepoRoot,
    #[error("clone analysis failed to canonicalize repo root: {0}")]
    Canonicalize(#[from] std::io::Error),
    #[error("clone analysis SQLite store error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("clone analysis JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneAnalysisRequest {
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub schema_version: u32,
    pub repo: RepoIdentity,
    pub report_mode: CloneReportMode,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub overlays: Vec<CloneOverlay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_tokens: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloneReportMode {
    All,
    Introduced,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum CloneOverlay {
    #[serde(rename_all = "camelCase")]
    Write {
        path: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        checksum_before: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Delete {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        checksum_before: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneAnalysisResult {
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub schema_version: u32,
    pub repo: RepoIdentity,
    pub report_mode: CloneReportMode,
    pub status: String,
    pub persisted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_path: Option<String>,
    pub findings: Vec<CloneFinding>,
    pub summary: CloneAnalysisSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneFinding {
    pub clone_class_id: String,
    pub content_hash: String,
    pub path: String,
    pub peer_path: String,
    pub paths: Vec<String>,
    pub line_count: usize,
    pub token_count: usize,
    pub introduced: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneAnalysisSummary {
    pub analyzed_files: usize,
    pub clone_class_count: usize,
    pub finding_count: usize,
    pub overlay_count: usize,
}

#[derive(Debug, Clone)]
struct CloneSource {
    path: String,
    language: String,
    sha256: String,
    content: String,
    introduced: bool,
}

#[derive(Debug, Clone)]
struct CloneOccurrence {
    path: String,
    introduced: bool,
}

#[derive(Debug, Clone)]
struct CloneClass {
    clone_class_id: String,
    content_hash: String,
    line_count: usize,
    token_count: usize,
    occurrences: Vec<CloneOccurrence>,
}

pub fn run_clone_cli(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("usage: opcore-graph-core clone < clone-request.json");
        return Ok(());
    }
    if !args.iter().all(|arg| arg == "clone") {
        return Err("unsupported clone arg; pass JSON on stdin".to_string());
    }
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read clone request: {error}"))?;
    let request: CloneAnalysisRequest = serde_json::from_str(&input)
        .map_err(|error| format!("invalid clone request JSON: {error}"))?;
    let response = analyze_clones(request).map_err(|error| error.to_string())?;
    serde_json::to_writer(std::io::stdout(), &response)
        .map_err(|error| format!("failed to write clone response: {error}"))?;
    println!();
    Ok(())
}

pub fn analyze_clones(request: CloneAnalysisRequest) -> Result<CloneAnalysisResult, CloneError> {
    validate_request(&request)?;
    let repo_root = request
        .repo
        .repo_root
        .as_deref()
        .ok_or(CloneError::MissingRepoRoot)?;
    let repo_root = PathBuf::from(repo_root).canonicalize()?;
    let min_lines = request.min_lines.unwrap_or(DEFAULT_MIN_LINES);
    let min_tokens = request.min_tokens.unwrap_or(DEFAULT_MIN_TOKENS);
    let sources = clone_sources(&repo_root, &request)?;
    let classes = clone_classes(&sources, min_lines, min_tokens);
    let findings = clone_findings(&classes, &request);
    let persisted = should_persist_clone_index(
        &repo_root,
        request.overlays.is_empty(),
        request.paths.is_empty(),
    );
    let db_path = if persisted {
        let path = persist_clone_index(&repo_root, &sources, &classes)?;
        Some(repo_relative_display(&repo_root, &path))
    } else {
        None
    };
    let summary = CloneAnalysisSummary {
        analyzed_files: sources.len(),
        clone_class_count: classes.len(),
        finding_count: findings.len(),
        overlay_count: request.overlays.len(),
    };
    Ok(CloneAnalysisResult {
        protocol: CLONE_PROTOCOL.to_string(),
        request_id: request.request_id,
        schema_version: CLONE_SCHEMA_VERSION,
        repo: RepoIdentity {
            repo_id: request.repo.repo_id,
            repo_root: Some(repo_root.to_string_lossy().replace('\\', "/")),
            remote_url: request.repo.remote_url,
            commit_sha: request.repo.commit_sha,
        },
        report_mode: request.report_mode,
        status: "passed".to_string(),
        persisted,
        db_path,
        findings,
        summary,
    })
}

fn validate_request(request: &CloneAnalysisRequest) -> Result<(), CloneError> {
    if request.protocol != CLONE_PROTOCOL {
        return Err(CloneError::InvalidRequest(format!(
            "protocol must be {CLONE_PROTOCOL}"
        )));
    }
    if request.schema_version != CLONE_SCHEMA_VERSION {
        return Err(CloneError::InvalidRequest(format!(
            "schemaVersion must be {CLONE_SCHEMA_VERSION}"
        )));
    }
    if request.repo.repo_root.as_deref().is_none_or(str::is_empty) {
        return Err(CloneError::MissingRepoRoot);
    }
    if request.min_lines == Some(0) {
        return Err(CloneError::InvalidRequest(
            "minLines must be positive".to_string(),
        ));
    }
    if request.min_tokens == Some(0) {
        return Err(CloneError::InvalidRequest(
            "minTokens must be positive".to_string(),
        ));
    }
    for path in &request.paths {
        normalize_repo_relative_path(path, "clone request path")
            .map_err(|message| CloneError::InvalidRequest(message.to_string()))?;
    }
    for overlay in &request.overlays {
        normalize_repo_relative_path(overlay.path(), "clone overlay path")
            .map_err(|message| CloneError::InvalidRequest(message.to_string()))?;
    }
    Ok(())
}

fn clone_sources(
    repo_root: &Path,
    request: &CloneAnalysisRequest,
) -> Result<Vec<CloneSource>, CloneError> {
    let mut sources = discovered_clone_sources(repo_root)?;
    apply_overlays(&mut sources, repo_root, &request.overlays)?;
    sources.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(sources)
}

fn discovered_clone_sources(repo_root: &Path) -> Result<Vec<CloneSource>, CloneError> {
    let discovery = discover_sources_for_options(&ExtractionOptions::new(repo_root));
    let mut sources = Vec::new();
    for source in discovery.sources {
        let content = std::fs::read_to_string(&source.absolute_path)?;
        sources.push(CloneSource {
            path: source.relative_path,
            language: source.language.as_str().to_string(),
            sha256: source.sha256,
            content,
            introduced: false,
        });
    }
    Ok(sources)
}

fn apply_overlays(
    sources: &mut Vec<CloneSource>,
    repo_root: &Path,
    overlays: &[CloneOverlay],
) -> Result<(), CloneError> {
    for overlay in overlays {
        let path = normalize_repo_relative_path(overlay.path(), "clone overlay path")
            .map_err(|message| CloneError::InvalidRequest(message.to_string()))?;
        sources.retain(|source| source.path != path);
        if let CloneOverlay::Write { content, .. } = overlay {
            if let Some(language) = SourceLanguage::from_path(Path::new(&path)) {
                sources.push(CloneSource {
                    path: path.clone(),
                    language: language.as_str().to_string(),
                    sha256: sha256_hex(content.as_bytes()),
                    content: content.clone(),
                    introduced: true,
                });
            }
        }
    }
    sources
        .retain(|source| repo_root.join(&source.path).starts_with(repo_root) || source.introduced);
    Ok(())
}

fn clone_classes(sources: &[CloneSource], min_lines: usize, min_tokens: usize) -> Vec<CloneClass> {
    let mut classes_by_hash: BTreeMap<String, CloneClass> = BTreeMap::new();
    for source in sources {
        let lines = normalized_code_lines(&source.content);
        for window in lines.windows(min_lines) {
            let block = window.join("\n");
            let token_count = token_count(&block);
            if token_count < min_tokens {
                continue;
            }
            let content_hash = sha256_hex(block.as_bytes());
            let Some(clone_id) = clone_class_id(&block) else {
                continue;
            };
            let entry = classes_by_hash
                .entry(content_hash.clone())
                .or_insert(CloneClass {
                    clone_class_id: clone_id,
                    content_hash,
                    line_count: window.len(),
                    token_count,
                    occurrences: Vec::new(),
                });
            if !entry
                .occurrences
                .iter()
                .any(|occurrence| occurrence.path == source.path)
            {
                entry.occurrences.push(CloneOccurrence {
                    path: source.path.clone(),
                    introduced: source.introduced,
                });
            }
        }
    }
    classes_by_hash
        .into_values()
        .filter(|class| distinct_paths(&class.occurrences).len() > 1)
        .collect()
}

fn clone_findings(classes: &[CloneClass], request: &CloneAnalysisRequest) -> Vec<CloneFinding> {
    let scoped_paths = request.paths.iter().cloned().collect::<BTreeSet<_>>();
    let mut findings = Vec::new();
    for class in classes {
        let paths = distinct_paths(&class.occurrences);
        if request.report_mode == CloneReportMode::Introduced
            && !class
                .occurrences
                .iter()
                .any(|occurrence| occurrence.introduced)
        {
            continue;
        }
        for occurrence in &class.occurrences {
            if !scoped_paths.is_empty() && !scoped_paths.contains(&occurrence.path) {
                continue;
            }
            if request.report_mode == CloneReportMode::Introduced && !occurrence.introduced {
                continue;
            }
            let Some(peer) = class
                .occurrences
                .iter()
                .find(|peer| peer.path != occurrence.path)
            else {
                continue;
            };
            findings.push(CloneFinding {
                clone_class_id: class.clone_class_id.clone(),
                content_hash: class.content_hash.clone(),
                path: occurrence.path.clone(),
                peer_path: peer.path.clone(),
                paths: paths.iter().cloned().collect(),
                line_count: class.line_count,
                token_count: class.token_count,
                introduced: occurrence.introduced,
            });
        }
    }
    findings.sort_by(|left, right| {
        (
            left.path.as_str(),
            left.peer_path.as_str(),
            left.clone_class_id.as_str(),
        )
            .cmp(&(
                right.path.as_str(),
                right.peer_path.as_str(),
                right.clone_class_id.as_str(),
            ))
    });
    findings
}

fn normalized_code_lines(content: &str) -> Vec<String> {
    content.lines().filter_map(normalize_code_line).collect()
}

fn normalize_code_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
        return None;
    }
    let without_comment = strip_inline_comment(trimmed);
    let normalized = without_comment
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn strip_inline_comment(line: &str) -> &str {
    line.split_once("//")
        .map(|(before, _comment)| before.trim_end())
        .unwrap_or(line)
}

fn token_count(content: &str) -> usize {
    content
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .count()
}

fn distinct_paths(occurrences: &[CloneOccurrence]) -> BTreeSet<String> {
    occurrences
        .iter()
        .map(|occurrence| occurrence.path.clone())
        .collect()
}

fn clone_class_id(content: &str) -> Option<String> {
    digest_u64(content.as_bytes()).map(|value| format!("clone-{value:016x}"))
}

fn digest_u64(bytes: &[u8]) -> Option<u64> {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    let first = digest.first_chunk::<8>()?;
    Some(u64::from_be_bytes(*first))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn repo_relative_display(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

impl CloneOverlay {
    fn path(&self) -> &str {
        match self {
            Self::Write { path, .. } | Self::Delete { path, .. } => path,
        }
    }
}

#[cfg(test)]
mod tests;
