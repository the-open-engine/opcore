use crate::extraction::normalize_repo_relative_path;
use crate::protocol::RepoIdentity;
use analysis::{clone_classes, clone_findings, clone_sources, validate_clone_pattern};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use thiserror::Error;

mod analysis;
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
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_read_mode: Option<CloneSourceReadMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_tree_ref: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub overlays: Vec<CloneOverlay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_size: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_tokens: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub partitions: Vec<Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub exclude: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloneReportMode {
    All,
    Introduced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloneSourceReadMode {
    Disk,
    GitIndex,
    GitTree,
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
    let window_size = request.window_size.unwrap_or(min_lines);
    let min_tokens = request
        .min_tokens
        .or(request.threshold)
        .unwrap_or(DEFAULT_MIN_TOKENS);
    let sources = clone_sources(&repo_root, &request)?;
    let classes = clone_classes(&sources, window_size, min_lines, min_tokens);
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
    validate_protocol(request)?;
    if request.repo.repo_root.as_deref().is_none_or(str::is_empty) {
        return Err(CloneError::MissingRepoRoot);
    }
    validate_positive_options(request)?;
    validate_request_paths(request)?;
    validate_source_read_mode(request)?;
    validate_modes(&request.modes)?;
    Ok(())
}

fn validate_protocol(request: &CloneAnalysisRequest) -> Result<(), CloneError> {
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
    Ok(())
}

fn validate_positive_options(request: &CloneAnalysisRequest) -> Result<(), CloneError> {
    validate_positive_option("windowSize", request.window_size)?;
    validate_positive_option("minLines", request.min_lines)?;
    validate_positive_option("minTokens", request.min_tokens)?;
    validate_positive_option("threshold", request.threshold)
}

fn validate_positive_option(label: &str, value: Option<usize>) -> Result<(), CloneError> {
    if value == Some(0) {
        return Err(CloneError::InvalidRequest(format!(
            "{label} must be positive"
        )));
    }
    Ok(())
}

fn validate_request_paths(request: &CloneAnalysisRequest) -> Result<(), CloneError> {
    for path in &request.paths {
        normalize_repo_relative_path(path, "clone request path")
            .map_err(|message| CloneError::InvalidRequest(message.to_string()))?;
    }
    if let Some(paths) = &request.source_paths {
        for path in paths {
            normalize_repo_relative_path(path, "clone request source path")
                .map_err(|message| CloneError::InvalidRequest(message.to_string()))?;
        }
    }
    for (index, partition) in request.partitions.iter().enumerate() {
        if partition.is_empty() {
            return Err(CloneError::InvalidRequest(format!(
                "partitions[{index}] must not be empty"
            )));
        }
        for pattern in partition {
            validate_clone_pattern(pattern, "clone partition pattern")?;
        }
    }
    for pattern in &request.exclude {
        validate_clone_pattern(pattern, "clone exclude pattern")?;
    }
    for overlay in &request.overlays {
        normalize_repo_relative_path(overlay.path(), "clone overlay path")
            .map_err(|message| CloneError::InvalidRequest(message.to_string()))?;
    }
    Ok(())
}

fn validate_source_read_mode(request: &CloneAnalysisRequest) -> Result<(), CloneError> {
    match request
        .source_read_mode
        .unwrap_or(CloneSourceReadMode::Disk)
    {
        CloneSourceReadMode::GitTree => {
            if request.source_tree_ref.as_deref().is_none_or(str::is_empty) {
                return Err(CloneError::InvalidRequest(
                    "sourceTreeRef is required when sourceReadMode is gitTree".to_string(),
                ));
            }
        }
        CloneSourceReadMode::Disk | CloneSourceReadMode::GitIndex => {
            if request.source_tree_ref.is_some() {
                return Err(CloneError::InvalidRequest(
                    "sourceTreeRef is only valid when sourceReadMode is gitTree".to_string(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_modes(modes: &[String]) -> Result<(), CloneError> {
    for mode in modes {
        if mode.is_empty() {
            return Err(CloneError::InvalidRequest(
                "clone mode must be non-empty".to_string(),
            ));
        }
    }
    Ok(())
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
