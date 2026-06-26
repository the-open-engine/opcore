use crate::extraction::SourceFileHash;
use crate::protocol::GraphRenamedFile;
use std::collections::BTreeMap;

use super::common::normalize_path;

struct RenameDetection<'a> {
    stored_by_path: &'a BTreeMap<&'a str, &'a str>,
    changed_by_sha: &'a BTreeMap<&'a str, String>,
}

impl RenameDetection<'_> {
    fn renamed_files(&self, deleted: &[String]) -> Vec<GraphRenamedFile> {
        deleted
            .iter()
            .filter_map(|path| {
                let before = self.stored_by_path.get(path.as_str())?;
                let to_path = self.changed_by_sha.get(before)?;
                Some(GraphRenamedFile {
                    from_path: path.clone(),
                    to_path: to_path.clone(),
                    checksum_before: Some((*before).to_string()),
                    checksum_after: Some((*before).to_string()),
                })
            })
            .collect()
    }
}

pub(super) fn detect_changed_paths(
    stored_hashes: &[SourceFileHash],
    current_hashes: &[SourceFileHash],
    requested_files: &[String],
) -> (Vec<String>, Vec<String>, Vec<GraphRenamedFile>) {
    let stored_by_path = stored_hashes
        .iter()
        .map(|hash| (hash.relative_path.as_str(), hash.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    let current_by_path = current_hashes
        .iter()
        .map(|hash| (hash.relative_path.as_str(), hash.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    if !requested_files.is_empty() {
        return requested_path_changes(&current_by_path, requested_files);
    }

    stored_path_changes(&stored_by_path, &current_by_path)
}

fn requested_path_changes(
    current_by_path: &BTreeMap<&str, &str>,
    requested_files: &[String],
) -> (Vec<String>, Vec<String>, Vec<GraphRenamedFile>) {
    let mut changed = Vec::new();
    let mut deleted = Vec::new();
    for path in requested_files.iter().map(|path| normalize_path(path)) {
        if current_by_path.contains_key(path.as_str()) {
            changed.push(path);
        } else {
            deleted.push(path);
        }
    }
    changed.sort();
    changed.dedup();
    deleted.sort();
    deleted.dedup();
    (changed, deleted, Vec::new())
}

fn stored_path_changes(
    stored_by_path: &BTreeMap<&str, &str>,
    current_by_path: &BTreeMap<&str, &str>,
) -> (Vec<String>, Vec<String>, Vec<GraphRenamedFile>) {
    let mut changed = current_changed_paths(stored_by_path, current_by_path);
    let mut deleted = deleted_paths(stored_by_path, current_by_path);
    let changed_by_sha = changed
        .iter()
        .filter_map(|path| {
            current_by_path
                .get(path.as_str())
                .map(|sha| (*sha, path.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    let renamed_files = RenameDetection {
        stored_by_path,
        changed_by_sha: &changed_by_sha,
    }
    .renamed_files(&deleted);
    changed.sort();
    deleted.sort();
    (changed, deleted, renamed_files)
}

fn current_changed_paths(
    stored_by_path: &BTreeMap<&str, &str>,
    current_by_path: &BTreeMap<&str, &str>,
) -> Vec<String> {
    current_by_path
        .iter()
        .filter_map(|(path, sha)| match stored_by_path.get(path) {
            Some(stored_sha) if stored_sha == sha => None,
            _ => Some((*path).to_string()),
        })
        .collect()
}

fn deleted_paths(
    stored_by_path: &BTreeMap<&str, &str>,
    current_by_path: &BTreeMap<&str, &str>,
) -> Vec<String> {
    stored_by_path
        .keys()
        .filter(|path| !current_by_path.contains_key(**path))
        .map(|path| (*path).to_string())
        .collect()
}
