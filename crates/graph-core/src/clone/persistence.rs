use crate::extraction::SourceLanguage;
use std::path::Path;
use std::process::Command;

pub(super) fn should_persist_clone_index(
    repo_root: &Path,
    overlays_empty: bool,
    paths_empty: bool,
) -> bool {
    overlays_empty
        && paths_empty
        && matches!(
            git_clone_source_state(repo_root),
            GitCloneSourceState::Clean
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitCloneSourceState {
    Clean,
    Dirty,
    NotGit,
    Unknown,
}

fn git_clone_source_state(repo_root: &Path) -> GitCloneSourceState {
    let inside = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output();
    let Ok(inside) = inside else {
        return GitCloneSourceState::Unknown;
    };
    if !inside.status.success() {
        return GitCloneSourceState::NotGit;
    }
    if String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return GitCloneSourceState::NotGit;
    }

    let mut status = Command::new("git");
    status.arg("-C").arg(repo_root).args([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
    ]);
    let Ok(status) = status.output() else {
        return GitCloneSourceState::Unknown;
    };
    if !status.status.success() {
        return GitCloneSourceState::Unknown;
    }
    if status_has_clone_source_change(&status.stdout) {
        GitCloneSourceState::Dirty
    } else {
        GitCloneSourceState::Clean
    }
}

fn status_has_clone_source_change(output: &[u8]) -> bool {
    let mut entries = output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty());
    while let Some(entry) = entries.next() {
        let Some((status, path)) = parse_status_entry(entry) else {
            return true;
        };
        if is_clone_source_status_path(path) {
            return true;
        }
        if status_mentions_rename_or_copy(status) {
            let Some(source_path) = entries.next() else {
                return true;
            };
            if is_clone_source_status_path(source_path) {
                return true;
            }
        }
    }
    false
}

fn parse_status_entry(entry: &[u8]) -> Option<([u8; 2], &[u8])> {
    match entry {
        [index_status, worktree_status, b' ', path @ ..] if !path.is_empty() => {
            Some(([*index_status, *worktree_status], path))
        }
        _ => None,
    }
}

fn status_mentions_rename_or_copy(status: [u8; 2]) -> bool {
    matches!(status[0], b'R' | b'C') || matches!(status[1], b'R' | b'C')
}

fn is_clone_source_status_path(path: &[u8]) -> bool {
    let Ok(path) = std::str::from_utf8(path) else {
        return true;
    };
    SourceLanguage::from_path(Path::new(path)).is_some()
}
