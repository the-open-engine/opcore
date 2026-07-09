use super::{CloneAnalysisRequest, CloneError, CloneFinding, CloneOverlay, CloneReportMode};
use crate::extraction::{
    discover_sources_for_options, normalize_repo_relative_path, ExtractionOptions, SourceLanguage,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Debug, Clone)]
pub(super) struct CloneSource {
    pub(super) path: String,
    pub(super) language: String,
    pub(super) sha256: String,
    pub(super) content: String,
    pub(super) introduced: bool,
}

#[derive(Debug, Clone)]
pub(super) struct CloneOccurrence {
    pub(super) path: String,
    pub(super) introduced: bool,
}

#[derive(Debug, Clone)]
pub(super) struct CloneClass {
    pub(super) clone_class_id: String,
    pub(super) content_hash: String,
    pub(super) line_count: usize,
    pub(super) token_count: usize,
    pub(super) occurrences: Vec<CloneOccurrence>,
}

pub(super) fn clone_sources(
    repo_root: &Path,
    request: &CloneAnalysisRequest,
) -> Result<Vec<CloneSource>, CloneError> {
    let mut sources = discovered_clone_sources(repo_root)?;
    apply_overlays(&mut sources, repo_root, &request.overlays)?;
    if !request.exclude.is_empty() {
        sources.retain(|source| {
            !request
                .exclude
                .iter()
                .any(|pattern| clone_pattern_matches(pattern, &source.path))
        });
    }
    sources.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(sources)
}

pub(super) fn clone_classes(
    sources: &[CloneSource],
    window_size: usize,
    min_lines: usize,
    min_tokens: usize,
) -> Vec<CloneClass> {
    let mut classes_by_hash: BTreeMap<String, CloneClass> = BTreeMap::new();
    for source in sources {
        let lines = normalized_code_lines(&source.content);
        for window in lines.windows(window_size) {
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
        .filter(|class| class.line_count >= min_lines)
        .filter(|class| distinct_paths(&class.occurrences).len() > 1)
        .collect()
}

pub(super) fn clone_findings(
    classes: &[CloneClass],
    request: &CloneAnalysisRequest,
) -> Vec<CloneFinding> {
    let scoped_paths = request.paths.iter().cloned().collect::<BTreeSet<_>>();
    let mut findings = Vec::new();
    for class in classes {
        let paths = distinct_paths(&class.occurrences);
        if introduced_class_is_unreported(class, request.report_mode) {
            continue;
        }
        for occurrence in &class.occurrences {
            if !reported_occurrence(occurrence, request.report_mode, &scoped_paths) {
                continue;
            }
            let Some(peer) = peer_occurrence(class, occurrence, request) else {
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

fn introduced_class_is_unreported(class: &CloneClass, report_mode: CloneReportMode) -> bool {
    report_mode == CloneReportMode::Introduced
        && !class
            .occurrences
            .iter()
            .any(|occurrence| occurrence.introduced)
}

fn reported_occurrence(
    occurrence: &CloneOccurrence,
    report_mode: CloneReportMode,
    scoped_paths: &BTreeSet<String>,
) -> bool {
    (scoped_paths.is_empty() || scoped_paths.contains(&occurrence.path))
        && (report_mode != CloneReportMode::Introduced || occurrence.introduced)
}

fn peer_occurrence<'a>(
    class: &'a CloneClass,
    occurrence: &CloneOccurrence,
    request: &CloneAnalysisRequest,
) -> Option<&'a CloneOccurrence> {
    let occurrence_partition = clone_partition_index(&request.partitions, &occurrence.path);
    class
        .occurrences
        .iter()
        .find(|peer| peer_is_reportable(peer, occurrence, occurrence_partition, request))
}

fn peer_is_reportable(
    peer: &CloneOccurrence,
    occurrence: &CloneOccurrence,
    occurrence_partition: Option<usize>,
    request: &CloneAnalysisRequest,
) -> bool {
    peer.path != occurrence.path
        && (request.partitions.is_empty()
            || occurrence_partition.is_some()
                && clone_partition_index(&request.partitions, &peer.path) == occurrence_partition)
}

pub(super) fn validate_clone_pattern(pattern: &str, label: &str) -> Result<(), CloneError> {
    normalize_repo_relative_path(pattern, label)
        .map(|_| ())
        .map_err(|message| CloneError::InvalidRequest(message.to_string()))
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

fn clone_partition_index(partitions: &[Vec<String>], path: &str) -> Option<usize> {
    partitions.iter().position(|partition| {
        partition
            .iter()
            .any(|pattern| clone_pattern_matches(pattern, path))
    })
}

fn clone_pattern_matches(pattern: &str, path: &str) -> bool {
    let normalized_pattern = pattern.replace('\\', "/");
    let normalized_path = path.replace('\\', "/");
    if let Some(prefix) = normalized_pattern.strip_suffix("/**") {
        return normalized_path == prefix || normalized_path.starts_with(&format!("{prefix}/"));
    }
    if normalized_pattern.ends_with('/') {
        return normalized_path.starts_with(&normalized_pattern);
    }
    normalized_path == normalized_pattern
        || normalized_path.starts_with(&format!("{normalized_pattern}/"))
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
