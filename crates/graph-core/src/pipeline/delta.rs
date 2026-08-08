use crate::extraction::{SourceFileHash, SourcePathOps, SourcePaths};

pub(super) struct SourceDelta {
    pub(super) changed_files: Vec<String>,
    pub(super) deleted_files: Vec<String>,
}

pub(super) struct Delta;

pub(super) trait SourceDeltaOps {
    fn source_delta(stored: &[SourceFileHash], current: &[SourceFileHash]) -> SourceDelta;
}

impl SourceDeltaOps for Delta {
    fn source_delta(stored: &[SourceFileHash], current: &[SourceFileHash]) -> SourceDelta {
        let stored_by_path = SourcePaths::source_hashes_by_path(stored);
        let current_by_path = SourcePaths::source_hashes_by_path(current);
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
}
