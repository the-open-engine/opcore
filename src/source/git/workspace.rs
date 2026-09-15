use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    sync::Arc,
};

use crate::{
    limits::{MAX_FILES, MAX_SOURCE_BYTES, MAX_TOTAL_SOURCE_BYTES},
    model::SourceFile,
    path::RepoPath,
    source::{SourceError, snapshot::SourceSnapshot},
};

use super::{
    CAPTURE_ATTEMPTS, GitRepository, GitScope, Sentinel, detect_language, files_from_git_objects,
    generation_state, is_dependency_capture_candidate, is_dependency_source_candidate,
    metadata_state, reject_unmerged, source_file, sparse_paths, special_index_paths,
};

pub struct GitWorkspaceCapture {
    pub before: Arc<SourceSnapshot>,
    pub after: Arc<SourceSnapshot>,
    pub paths: BTreeSet<RepoPath>,
    pub changed_paths: BTreeSet<RepoPath>,
    pub before_unsupported_files: usize,
    pub after_unsupported_files: usize,
    pub unsupported_changed_files: usize,
    pub valid_as_of: String,
    sentinel: SenseSentinel,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SenseSentinel {
    Worktree(WorkspaceSentinel),
    Staged(Sentinel),
    Tree {
        sentinel: Sentinel,
        tree_ref: String,
        base_ref: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WorkspaceSentinel {
    git: Sentinel,
    paths: BTreeSet<RepoPath>,
    special_paths: BTreeSet<RepoPath>,
    generations: [u8; 32],
}

impl GitRepository {
    pub fn capture_workspace(&self) -> Result<GitWorkspaceCapture, SourceError> {
        let mut last_error = None;
        for _ in 0..CAPTURE_ATTEMPTS {
            let before_sentinel = self.workspace_sentinel(None)?;
            match self.capture_workspace_once(&before_sentinel) {
                Ok(capture) => {
                    let after_sentinel = self.workspace_sentinel(Some(&before_sentinel))?;
                    if before_sentinel == after_sentinel {
                        return Ok(capture);
                    }
                    last_error = Some(
                        "HEAD, index, paths, or working tree changed while files were read"
                            .to_owned(),
                    );
                }
                Err(error @ SourceError::Changed(_)) => last_error = Some(error.to_string()),
                Err(error) => return Err(error),
            }
        }
        Err(SourceError::Changed(last_error.unwrap_or_else(|| {
            "workspace capture did not stabilize".into()
        })))
    }

    pub fn is_workspace_current(&self, capture: &GitWorkspaceCapture) -> Result<bool, SourceError> {
        match &capture.sentinel {
            SenseSentinel::Worktree(sentinel) => {
                Ok(*sentinel == self.workspace_sentinel(Some(sentinel))?)
            }
            SenseSentinel::Staged(sentinel) => Ok(*sentinel == self.staged_workspace_sentinel()?),
            SenseSentinel::Tree {
                sentinel,
                tree_ref,
                base_ref,
            } => Ok(*sentinel
                == self.sentinel_with(
                    GitScope::Tree,
                    &[],
                    is_dependency_capture_candidate,
                    base_ref.as_deref(),
                    Some(tree_ref),
                )?),
        }
    }

    pub fn capture_staged_workspace(&self) -> Result<GitWorkspaceCapture, SourceError> {
        let mut last_error = None;
        for _ in 0..CAPTURE_ATTEMPTS {
            let before_sentinel = self.staged_workspace_sentinel()?;
            match self.capture_staged_workspace_once(&before_sentinel) {
                Ok(capture) => {
                    if before_sentinel == self.staged_workspace_sentinel()? {
                        return Ok(capture);
                    }
                    last_error =
                        Some("HEAD or worktree-local index changed while files were read".into());
                }
                Err(error @ SourceError::Changed(_)) => last_error = Some(error.to_string()),
                Err(error) => return Err(error),
            }
        }
        Err(SourceError::Changed(last_error.unwrap_or_else(|| {
            "staged workspace capture did not stabilize".into()
        })))
    }

    /// Captures the complete selected dependency views from immutable Git trees.
    pub fn capture_tree_workspace(
        &self,
        tree_ref: &str,
        base_ref: Option<&str>,
    ) -> Result<GitWorkspaceCapture, SourceError> {
        super::stable_capture(
            || {
                self.sentinel_with(
                    GitScope::Tree,
                    &[],
                    is_dependency_capture_candidate,
                    base_ref,
                    Some(tree_ref),
                )
            },
            |sentinel| {
                let mut comparison = sentinel.clone();
                if base_ref.is_none() {
                    comparison.base_tree = comparison
                        .target_tree
                        .clone()
                        .ok_or_else(|| SourceError::Invalid("missing target tree".into()))?;
                }
                let mut capture = self.capture_staged_workspace_once(&comparison)?;
                capture.sentinel = SenseSentinel::Tree {
                    sentinel: sentinel.clone(),
                    tree_ref: tree_ref.to_owned(),
                    base_ref: base_ref.map(str::to_owned),
                };
                Ok(capture)
            },
            |_| {
                self.sentinel_with(
                    GitScope::Tree,
                    &[],
                    is_dependency_capture_candidate,
                    base_ref,
                    Some(tree_ref),
                )
            },
            "Git refs changed while dependency files were captured",
            "dependency tree capture did not stabilize",
        )
    }

    fn capture_workspace_once(
        &self,
        sentinel: &WorkspaceSentinel,
    ) -> Result<GitWorkspaceCapture, SourceError> {
        reject_unmerged(&self.root)?;
        let mut entries = super::objects::all_tree_entries_filtered(
            &self.root,
            &sentinel.git.base_tree,
            &|path| self.dependency_candidate(path),
        )?;
        entries.retain(|path, _| is_dependency_capture_candidate(path));
        let before_paths = entries.keys().cloned().collect::<BTreeSet<_>>();
        let paths = before_paths
            .union(&sentinel.paths)
            .cloned()
            .collect::<BTreeSet<_>>();
        require_path_bound(&paths)?;

        let after_paths = workspace_after_paths(&self.root, &before_paths, &sentinel.paths)?;
        let before_unsupported_files = unsupported_count(&before_paths);
        let after_unsupported_files = unsupported_count(&after_paths);
        let unsupported_changed_files = sentinel
            .git
            .worktree_paths
            .iter()
            .filter(|path| is_dependency_source_candidate(path) && detect_language(path).is_none())
            .count();
        entries.retain(|path, _| detect_language(path).is_some());
        let before_files = files_from_git_objects(&self.root, &entries)?;
        let overlay_files = self.read_worktree_files(&sentinel.paths)?;
        let (before_files, after_files) =
            apply_workspace_overlay(before_files, &sentinel.paths, overlay_files);
        let changed_paths = changed_source_paths(&before_files, &after_files);
        Ok(build_workspace_capture(
            WorkspaceCaptureParts {
                paths,
                changed_paths,
                before_unsupported_files,
                after_unsupported_files,
                unsupported_changed_files,
                before_files,
                after_files,
            },
            sentinel,
        ))
    }

    fn capture_staged_workspace_once(
        &self,
        sentinel: &Sentinel,
    ) -> Result<GitWorkspaceCapture, SourceError> {
        if sentinel.target_tree.is_none() {
            reject_unmerged(&self.root)?;
        }
        let mut before_entries =
            super::objects::all_tree_entries_filtered(&self.root, &sentinel.base_tree, &|path| {
                self.dependency_candidate(path)
            })?;
        let mut after_entries = if let Some(target) = &sentinel.target_tree {
            super::objects::all_tree_entries_filtered(&self.root, target, &|path| {
                self.dependency_candidate(path)
            })?
        } else {
            super::objects::all_index_entries_filtered(&self.root, &|path| {
                self.dependency_candidate(path)
            })?
        };
        before_entries.retain(|path, _| is_dependency_capture_candidate(path));
        after_entries.retain(|path, _| is_dependency_capture_candidate(path));
        let before_paths = before_entries.keys().cloned().collect::<BTreeSet<_>>();
        let after_paths = after_entries.keys().cloned().collect::<BTreeSet<_>>();
        let paths = before_paths.union(&after_paths).cloned().collect();
        require_path_bound(&paths)?;

        let before_unsupported_files = unsupported_count(&before_paths);
        let after_unsupported_files = unsupported_count(&after_paths);
        let unsupported_changed_files = paths
            .iter()
            .filter(|path| {
                is_dependency_source_candidate(path)
                    && detect_language(path).is_none()
                    && before_entries.get(*path) != after_entries.get(*path)
            })
            .count();
        let after_source_paths = after_entries
            .keys()
            .filter(|path| detect_language(path).is_some())
            .cloned()
            .collect::<BTreeSet<_>>();
        let changed_after_entries = after_entries
            .iter()
            .filter(|(path, entry)| {
                detect_language(path).is_some() && before_entries.get(*path) != Some(*entry)
            })
            .map(|(path, entry)| (path.clone(), entry.clone()))
            .collect();
        before_entries.retain(|path, _| detect_language(path).is_some());
        let before_files = files_from_git_objects(&self.root, &before_entries)?;
        let changed_after_files = files_from_git_objects(&self.root, &changed_after_entries)?;
        let after_files =
            staged_after_files(&before_files, &after_source_paths, changed_after_files);
        let changed_paths = changed_source_paths(&before_files, &after_files);
        Ok(build_staged_capture(
            WorkspaceCaptureParts {
                paths,
                changed_paths,
                before_unsupported_files,
                after_unsupported_files,
                unsupported_changed_files,
                before_files,
                after_files,
            },
            sentinel,
        ))
    }

    fn staged_workspace_sentinel(&self) -> Result<Sentinel, SourceError> {
        self.sentinel_with(
            GitScope::Staged,
            &[],
            is_dependency_capture_candidate,
            None,
            None,
        )
    }

    fn workspace_sentinel(
        &self,
        prior: Option<&WorkspaceSentinel>,
    ) -> Result<WorkspaceSentinel, SourceError> {
        let git = self.dependency_sentinel()?;
        let special_paths = match prior {
            Some(prior) if prior.git.index_hash == git.index_hash => prior.special_paths.clone(),
            _ => special_index_paths(&self.root, &|path| self.dependency_candidate(path))?,
        };
        let mut paths = git
            .worktree_paths
            .iter()
            .filter(|path| self.dependency_candidate(path))
            .cloned()
            .collect::<BTreeSet<_>>();
        paths.extend(
            special_paths
                .iter()
                .filter(|path| self.dependency_candidate(path))
                .cloned(),
        );
        let generations = workspace_generation_state(&self.root, &paths)?;
        Ok(WorkspaceSentinel {
            git,
            paths,
            special_paths,
            generations,
        })
    }
}

impl GitWorkspaceCapture {
    pub fn apply_hypothetical(
        mut self,
        overlays: &BTreeMap<RepoPath, Option<Vec<u8>>>,
        request_digest: &str,
    ) -> Result<Self, SourceError> {
        let before = Arc::clone(&self.after);
        let mut files = before
            .files()
            .cloned()
            .map(|file| (file.path.clone(), file))
            .collect::<BTreeMap<_, _>>();
        let mut after_paths = self.paths.clone();
        for (path, content) in overlays {
            if !is_dependency_capture_candidate(path) {
                continue;
            }
            if let Some(content) = content {
                after_paths.insert(path.clone());
                if detect_language(path).is_some() {
                    if content.len() > MAX_SOURCE_BYTES {
                        return Err(SourceError::Incomplete(format!(
                            "{path} exceeds {MAX_SOURCE_BYTES} bytes"
                        )));
                    }
                    if let Some(file) = source_file(path.clone(), content.clone()) {
                        files.insert(path.clone(), file);
                    }
                }
            } else {
                after_paths.remove(path);
                files.remove(path);
            }
        }
        require_path_bound(&after_paths)?;
        let total_bytes = files
            .values()
            .fold(0usize, |total, file| total.saturating_add(file.bytes.len()));
        if total_bytes > MAX_TOTAL_SOURCE_BYTES {
            return Err(SourceError::Incomplete(format!(
                "hypothetical source view exceeds {MAX_TOTAL_SOURCE_BYTES} total bytes"
            )));
        }
        let after = Arc::new(SourceSnapshot::new(files.into_values()));
        let changed_paths = changed_source_paths(before.files(), after.files());
        let unsupported_changed_files = overlays
            .keys()
            .filter(|path| is_dependency_source_candidate(path) && detect_language(path).is_none())
            .count();
        self.before = before;
        self.after = after;
        self.paths = self.paths.union(&after_paths).cloned().collect();
        self.changed_paths = changed_paths;
        self.before_unsupported_files = self.after_unsupported_files;
        self.after_unsupported_files = unsupported_count(&after_paths);
        self.unsupported_changed_files = unsupported_changed_files;
        self.valid_as_of = serde_json::json!({
            "kind": "git-hypothetical",
            "base": self.valid_as_of,
            "request": request_digest,
            "beforeView": self.before.id(),
            "afterView": self.after.id(),
        })
        .to_string();
        Ok(self)
    }
}

fn unsupported_count(paths: &BTreeSet<RepoPath>) -> usize {
    paths
        .iter()
        .filter(|path| is_dependency_source_candidate(path) && detect_language(path).is_none())
        .count()
}

fn workspace_after_paths(
    root: &Path,
    before: &BTreeSet<RepoPath>,
    overlay: &BTreeSet<RepoPath>,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let mut after = before.clone();
    let mut missing = BTreeSet::new();
    for path in overlay {
        after.remove(path);
        match fs::symlink_metadata(root.join(path.to_path_buf())) {
            Ok(_) => {
                after.insert(path.clone());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.insert(path.clone());
            }
            Err(error) => return Err(SourceError::Io(error.to_string())),
        }
    }
    after.extend(sparse_paths(root, &missing)?);
    Ok(after)
}

fn require_path_bound(paths: &BTreeSet<RepoPath>) -> Result<(), SourceError> {
    if paths.len() > MAX_FILES {
        return Err(SourceError::Incomplete(format!(
            "{} paths exceed limit {MAX_FILES}",
            paths.len()
        )));
    }
    Ok(())
}

fn apply_workspace_overlay(
    before_files: Vec<SourceFile>,
    overlay_paths: &BTreeSet<RepoPath>,
    overlay_files: Vec<SourceFile>,
) -> (Vec<SourceFile>, Vec<SourceFile>) {
    let mut after_by_path = before_files
        .iter()
        .cloned()
        .map(|file| (file.path.clone(), file))
        .collect::<BTreeMap<_, _>>();
    for path in overlay_paths {
        after_by_path.remove(path);
    }
    for file in overlay_files {
        after_by_path.insert(file.path.clone(), file);
    }
    (before_files, after_by_path.into_values().collect())
}

fn changed_source_paths<'a>(
    before_files: impl IntoIterator<Item = &'a SourceFile>,
    after_files: impl IntoIterator<Item = &'a SourceFile>,
) -> BTreeSet<RepoPath> {
    let mut changed = BTreeSet::new();
    let mut before = before_files.into_iter().peekable();
    let mut after = after_files.into_iter().peekable();
    while let (Some(before_file), Some(after_file)) = (before.peek(), after.peek()) {
        match before_file.path.cmp(&after_file.path) {
            std::cmp::Ordering::Less => {
                if let Some(file) = before.next() {
                    changed.insert(file.path.clone());
                }
            }
            std::cmp::Ordering::Greater => {
                if let Some(file) = after.next() {
                    changed.insert(file.path.clone());
                }
            }
            std::cmp::Ordering::Equal => {
                if before_file.content_id != after_file.content_id {
                    changed.insert(before_file.path.clone());
                }
                before.next();
                after.next();
            }
        }
    }
    changed.extend(before.map(|file| file.path.clone()));
    changed.extend(after.map(|file| file.path.clone()));
    changed
}

fn staged_after_files(
    before_files: &[SourceFile],
    after_paths: &BTreeSet<RepoPath>,
    changed_files: Vec<SourceFile>,
) -> Vec<SourceFile> {
    let mut after = before_files
        .iter()
        .filter(|file| after_paths.contains(&file.path))
        .cloned()
        .map(|file| (file.path.clone(), file))
        .collect::<BTreeMap<_, _>>();
    after.extend(
        changed_files
            .into_iter()
            .map(|file| (file.path.clone(), file)),
    );
    after.into_values().collect()
}

struct WorkspaceCaptureParts {
    paths: BTreeSet<RepoPath>,
    changed_paths: BTreeSet<RepoPath>,
    before_unsupported_files: usize,
    after_unsupported_files: usize,
    unsupported_changed_files: usize,
    before_files: Vec<SourceFile>,
    after_files: Vec<SourceFile>,
}

fn build_workspace_capture(
    parts: WorkspaceCaptureParts,
    sentinel: &WorkspaceSentinel,
) -> GitWorkspaceCapture {
    let before = Arc::new(SourceSnapshot::new(parts.before_files));
    let after = Arc::new(SourceSnapshot::new(parts.after_files));
    let valid_as_of = serde_json::json!({
        "kind": "git-workspace",
        "headTree": sentinel.git.base_tree,
        "index": hex::encode(sentinel.git.index_hash),
        "scopeState": hex::encode(sentinel.git.scope_state),
        "generations": hex::encode(sentinel.generations),
        "beforeView": before.id(),
        "afterView": after.id(),
    })
    .to_string();
    GitWorkspaceCapture {
        before,
        after,
        paths: parts.paths,
        changed_paths: parts.changed_paths,
        before_unsupported_files: parts.before_unsupported_files,
        after_unsupported_files: parts.after_unsupported_files,
        unsupported_changed_files: parts.unsupported_changed_files,
        valid_as_of,
        sentinel: SenseSentinel::Worktree(sentinel.clone()),
    }
}

fn build_staged_capture(parts: WorkspaceCaptureParts, sentinel: &Sentinel) -> GitWorkspaceCapture {
    let before = Arc::new(SourceSnapshot::new(parts.before_files));
    let after = Arc::new(SourceSnapshot::new(parts.after_files));
    let valid_as_of = super::source_valid_as_of("git-index", sentinel, &before, &after);
    GitWorkspaceCapture {
        before,
        after,
        paths: parts.paths,
        changed_paths: parts.changed_paths,
        before_unsupported_files: parts.before_unsupported_files,
        after_unsupported_files: parts.after_unsupported_files,
        unsupported_changed_files: parts.unsupported_changed_files,
        valid_as_of,
        sentinel: SenseSentinel::Staged(sentinel.clone()),
    }
}

pub(super) fn workspace_generation_state(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<[u8; 32], SourceError> {
    let mut generations = BTreeMap::new();
    for path in paths {
        let absolute = root.join(path.to_path_buf());
        let state = match fs::symlink_metadata(absolute) {
            Ok(metadata) => metadata_state(&metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => [0; 56],
            Err(error) => return Err(SourceError::Io(error.to_string())),
        };
        generations.insert(path.clone(), state);
    }
    Ok(generation_state(generations))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::Language, source::git::git_at};

    fn source(path: RepoPath, contents: &[u8]) -> SourceFile {
        SourceFile::new(path, contents, Language::TypeScript, "typescript".into())
    }

    fn initialize_repository(root: &Path) {
        fs::create_dir_all(root.join("src")).unwrap();
        git_at(root, ["init", "-q"]).unwrap();
        git_at(root, ["config", "user.name", "Test"]).unwrap();
        git_at(root, ["config", "user.email", "test@example.com"]).unwrap();
        fs::write(
            root.join("src/a.ts"),
            "export function ok(a) { return a; }\n",
        )
        .unwrap();
        git_at(root, ["add", "src/a.ts"]).unwrap();
        git_at(root, ["commit", "-qm", "initial"]).unwrap();
    }

    #[test]
    fn preserves_staged_deletion_in_before_view() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let repository = GitRepository::discover(&root).unwrap();
        git_at(&root, ["rm", "-q", "src/a.ts"]).unwrap();

        let capture = repository.capture_workspace().unwrap();
        let path = RepoPath::from_protocol("src/a.ts").unwrap();
        assert!(capture.before.read(&path).is_some());
        assert!(capture.after.read(&path).is_none());
        assert!(capture.paths.contains(&path));
        assert!(capture.changed_paths.contains(&path));
        assert!(repository.is_workspace_current(&capture).unwrap());
    }

    #[test]
    fn uses_dirty_content_over_staged_addition() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let repository = GitRepository::discover(&root).unwrap();
        let path = RepoPath::from_protocol("src/new.py").unwrap();
        fs::write(root.join("src/new.py"), "value = 'staged'\n").unwrap();
        git_at(&root, ["add", "src/new.py"]).unwrap();
        fs::write(root.join("src/new.py"), "value = 'dirty'\n").unwrap();

        let capture = repository.capture_workspace().unwrap();
        assert!(capture.before.read(&path).is_none());
        assert_eq!(
            capture.after.read(&path).unwrap().bytes.as_ref(),
            b"value = 'dirty'\n"
        );
        assert!(capture.changed_paths.contains(&path));
    }

    #[test]
    fn staged_workspace_uses_full_index_and_ignores_dirty_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        fs::write(root.join("src/b.ts"), "import './a';\n").unwrap();
        git_at(&root, ["add", "src/b.ts"]).unwrap();
        fs::write(root.join("src/b.ts"), "dirty repair\n").unwrap();
        fs::write(root.join("src/untracked.ts"), "untracked\n").unwrap();
        let repository = GitRepository::discover(&root).unwrap();

        let capture = repository.capture_staged_workspace().unwrap();
        let a = RepoPath::from_protocol("src/a.ts").unwrap();
        let b = RepoPath::from_protocol("src/b.ts").unwrap();
        assert_eq!(capture.before.files().count(), 1);
        assert_eq!(capture.after.files().count(), 2);
        assert!(capture.before.read(&a).is_some());
        assert_eq!(
            capture.after.read(&b).unwrap().bytes.as_ref(),
            b"import './a';\n"
        );
        assert!(capture.changed_paths.contains(&b));
        assert!(repository.is_workspace_current(&capture).unwrap());
        assert!(capture.valid_as_of.contains("git-index"));
    }

    #[test]
    fn reuses_unchanged_source_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let repository = GitRepository::discover(&root).unwrap();

        let capture = repository.capture_workspace().unwrap();
        let path = RepoPath::from_protocol("src/a.ts").unwrap();
        let before = capture.before.read(&path).unwrap();
        let after = capture.after.read(&path).unwrap();
        assert!(Arc::ptr_eq(&before.bytes, &after.bytes));
        assert!(capture.changed_paths.is_empty());
    }

    #[test]
    fn changed_source_paths_merges_additions_deletions_and_content_changes() {
        let non_utf8 = RepoPath::new(b"src/non-utf8-\xff.ts".to_vec()).unwrap();
        let before = vec![
            source(RepoPath::from_protocol("src/changed.ts").unwrap(), b"old"),
            source(RepoPath::from_protocol("src/deleted.ts").unwrap(), b"same"),
            source(non_utf8.clone(), b"same"),
            source(RepoPath::from_protocol("src/stable.ts").unwrap(), b"same"),
        ];
        let after = vec![
            source(RepoPath::from_protocol("src/added.ts").unwrap(), b"same"),
            source(RepoPath::from_protocol("src/changed.ts").unwrap(), b"new"),
            source(non_utf8, b"same"),
            source(RepoPath::from_protocol("src/stable.ts").unwrap(), b"same"),
        ];

        assert_eq!(
            changed_source_paths(&before, &after),
            BTreeSet::from([
                RepoPath::from_protocol("src/added.ts").unwrap(),
                RepoPath::from_protocol("src/changed.ts").unwrap(),
                RepoPath::from_protocol("src/deleted.ts").unwrap(),
            ])
        );
    }

    #[test]
    fn derives_changes_even_when_git_ignores_the_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let repository = GitRepository::discover(&root).unwrap();
        git_at(&root, ["update-index", "--assume-unchanged", "src/a.ts"]).unwrap();
        fs::write(root.join("src/a.ts"), "export const actual = 2;\n").unwrap();

        let capture = repository.capture_workspace().unwrap();
        let path = RepoPath::from_protocol("src/a.ts").unwrap();
        assert!(capture.changed_paths.contains(&path));
        assert_eq!(
            capture.after.read(&path).unwrap().bytes.as_ref(),
            b"export const actual = 2;\n"
        );
    }

    #[test]
    fn missing_skip_worktree_file_uses_its_index_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let repository = GitRepository::discover(&root).unwrap();
        git_at(&root, ["update-index", "--skip-worktree", "src/a.ts"]).unwrap();
        fs::remove_file(root.join("src/a.ts")).unwrap();

        let capture = repository.capture_workspace().unwrap();
        let path = RepoPath::from_protocol("src/a.ts").unwrap();
        assert_eq!(
            capture.after.read(&path).unwrap().bytes.as_ref(),
            b"export function ok(a) { return a; }\n"
        );
        assert!(capture.changed_paths.is_empty());
        assert!(repository.is_workspace_current(&capture).unwrap());
    }

    #[test]
    fn ignored_worktree_mutation_invalidates_a_captured_view() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let repository = GitRepository::discover(&root).unwrap();
        git_at(&root, ["update-index", "--assume-unchanged", "src/a.ts"]).unwrap();
        let capture = repository.capture_workspace().unwrap();

        fs::write(root.join("src/a.ts"), "export const changed = true;\n").unwrap();

        assert!(!repository.is_workspace_current(&capture).unwrap());
    }

    #[test]
    fn mutation_after_the_workspace_sentinel_cannot_be_returned_as_current() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let repository = GitRepository::discover(&root).unwrap();
        fs::write(root.join("src/a.ts"), "export const first = true;\n").unwrap();
        let sentinel = repository.workspace_sentinel(None).unwrap();
        fs::write(root.join("src/a.ts"), "export const second = true;\n").unwrap();

        let capture = repository.capture_workspace_once(&sentinel).unwrap();

        assert!(!repository.is_workspace_current(&capture).unwrap());
    }

    #[test]
    fn same_content_replacement_keeps_the_content_view_current() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let repository = GitRepository::discover(&root).unwrap();
        let before = repository.workspace_sentinel(None).unwrap();
        let contents = fs::read(root.join("src/a.ts")).unwrap();
        fs::write(root.join("src/replacement"), contents).unwrap();
        fs::rename(root.join("src/replacement"), root.join("src/a.ts")).unwrap();
        let after = repository.workspace_sentinel(Some(&before)).unwrap();

        assert_eq!(before, after);
    }
}
