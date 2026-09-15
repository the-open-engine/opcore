use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use crate::{
    identity::ContentId,
    limits::{MAX_AUXILIARY_PATHS, MAX_TOTAL_AUXILIARY_BYTES},
    path::RepoPath,
    source::SourceError,
};

use super::{
    CAPTURE_ATTEMPTS, GitRepository, GitScope, Sentinel, add_bounded_blob_length,
    content_view_digest, exact_explicit_sentinel_scope, git_blobs_from_objects_bounded,
    head_tree_or_empty, index_entries, read_optional_worktree_blob, reject_unmerged,
    sentinel_from_scope, sentinel_index_hash, sparse_paths, tree_entries, worktree_state,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuxiliaryBlob {
    pub content_id: ContentId,
    pub bytes: Arc<[u8]>,
}

impl AuxiliaryBlob {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            content_id: ContentId::of(&bytes),
            bytes: bytes.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuxiliaryPathState {
    pub before: Option<AuxiliaryBlob>,
    pub after: Option<AuxiliaryBlob>,
}

impl AuxiliaryPathState {
    pub fn content_changed(&self) -> bool {
        self.before.as_ref().map(|blob| blob.content_id)
            != self.after.as_ref().map(|blob| blob.content_id)
    }
}

#[derive(Clone, Debug)]
pub struct GitAuxiliaryCapture {
    pub paths: BTreeMap<RepoPath, AuxiliaryPathState>,
    pub valid_as_of: String,
    sentinel: AuxiliarySentinel,
}

#[derive(Clone, Debug)]
enum AuxiliarySentinel {
    Worktree(Sentinel),
    Staged(Sentinel),
    Tree {
        sentinel: Sentinel,
        tree_ref: String,
        base_ref: Option<String>,
    },
}

impl GitRepository {
    /// Captures exact HEAD and current worktree/index bytes for caller-selected paths.
    pub fn capture_auxiliary(
        &self,
        paths: &BTreeSet<RepoPath>,
    ) -> Result<GitAuxiliaryCapture, SourceError> {
        require_path_bound(paths)?;
        let explicit = paths.iter().cloned().collect::<Vec<_>>();
        let mut last_error = None;
        for _ in 0..CAPTURE_ATTEMPTS {
            let before_sentinel = self.auxiliary_sentinel(&explicit)?;
            match self.capture_auxiliary_once(paths, &before_sentinel) {
                Ok(capture) => {
                    let after_sentinel = self.auxiliary_sentinel(&explicit)?;
                    if before_sentinel == after_sentinel {
                        return Ok(capture);
                    }
                    last_error = Some(
                        "HEAD, index, or selected worktree paths changed while auxiliary blobs were read"
                            .to_owned(),
                    );
                }
                Err(error @ SourceError::Changed(_)) => last_error = Some(error.to_string()),
                Err(error) => return Err(error),
            }
        }
        Err(SourceError::Changed(last_error.unwrap_or_else(|| {
            "auxiliary blob capture did not stabilize".into()
        })))
    }

    /// Revalidates a capture after its consumer has finished evaluating and rendering output.
    pub fn is_auxiliary_current(&self, capture: &GitAuxiliaryCapture) -> Result<bool, SourceError> {
        let explicit = capture.paths.keys().cloned().collect::<Vec<_>>();
        match &capture.sentinel {
            AuxiliarySentinel::Worktree(sentinel) => {
                Ok(*sentinel == self.auxiliary_sentinel(&explicit)?)
            }
            AuxiliarySentinel::Staged(sentinel) => {
                Ok(*sentinel == self.staged_auxiliary_sentinel()?)
            }
            AuxiliarySentinel::Tree {
                sentinel,
                tree_ref,
                base_ref,
            } => Ok(*sentinel
                == self.sentinel_with(
                    GitScope::Tree,
                    &[],
                    |_| true,
                    base_ref.as_deref(),
                    Some(tree_ref),
                )?),
        }
    }

    /// Captures exact HEAD and stage-0 index bytes for caller-selected paths.
    pub fn capture_staged_auxiliary(
        &self,
        paths: &BTreeSet<RepoPath>,
    ) -> Result<GitAuxiliaryCapture, SourceError> {
        require_path_bound(paths)?;
        let mut last_error = None;
        for _ in 0..CAPTURE_ATTEMPTS {
            let before_sentinel = self.staged_auxiliary_sentinel()?;
            match self.capture_staged_auxiliary_once(paths, &before_sentinel) {
                Ok(capture) => {
                    if before_sentinel == self.staged_auxiliary_sentinel()? {
                        return Ok(capture);
                    }
                    last_error = Some(
                        "HEAD or worktree-local index changed while auxiliary blobs were read"
                            .into(),
                    );
                }
                Err(error @ SourceError::Changed(_)) => last_error = Some(error.to_string()),
                Err(error) => return Err(error),
            }
        }
        Err(SourceError::Changed(last_error.unwrap_or_else(|| {
            "staged auxiliary blob capture did not stabilize".into()
        })))
    }

    /// Captures exact immutable target and optional baseline bytes for selected paths.
    pub fn capture_tree_auxiliary(
        &self,
        paths: &BTreeSet<RepoPath>,
        tree_ref: &str,
        base_ref: Option<&str>,
    ) -> Result<GitAuxiliaryCapture, SourceError> {
        require_path_bound(paths)?;
        super::stable_capture(
            || self.sentinel_with(GitScope::Tree, &[], |_| true, base_ref, Some(tree_ref)),
            |sentinel| {
                let target = sentinel
                    .target_tree
                    .as_deref()
                    .ok_or_else(|| SourceError::Invalid("missing target tree".into()))?;
                let before_tree = if base_ref.is_some() {
                    &sentinel.base_tree
                } else {
                    target
                };
                let before = auxiliary_git_blobs(
                    &self.root,
                    &tree_entries(&self.root, before_tree, paths)?,
                    MAX_TOTAL_AUXILIARY_BYTES,
                )?;
                let after = auxiliary_git_blobs(
                    &self.root,
                    &tree_entries(&self.root, target, paths)?,
                    MAX_TOTAL_AUXILIARY_BYTES,
                )?;
                Ok(build_capture(
                    paths,
                    before,
                    after,
                    AuxiliarySentinel::Tree {
                        sentinel: sentinel.clone(),
                        tree_ref: tree_ref.to_owned(),
                        base_ref: base_ref.map(str::to_owned),
                    },
                    "git-auxiliary-tree",
                ))
            },
            |_| self.sentinel_with(GitScope::Tree, &[], |_| true, base_ref, Some(tree_ref)),
            "Git refs changed while auxiliary files were captured",
            "auxiliary tree capture did not stabilize",
        )
    }

    fn auxiliary_sentinel(&self, paths: &[RepoPath]) -> Result<Sentinel, SourceError> {
        let head_tree = head_tree_or_empty(&self.root)?;
        let index_hash = sentinel_index_hash(GitScope::Explicit, &self.index_path)?;
        let scoped = exact_explicit_sentinel_scope(&self.root, paths)?;
        Ok(sentinel_from_scope(
            head_tree, None, false, index_hash, scoped,
        ))
    }

    fn staged_auxiliary_sentinel(&self) -> Result<Sentinel, SourceError> {
        self.sentinel_with(GitScope::Staged, &[], |_| true, None, None)
    }

    fn capture_auxiliary_once(
        &self,
        paths: &BTreeSet<RepoPath>,
        sentinel: &Sentinel,
    ) -> Result<GitAuxiliaryCapture, SourceError> {
        reject_unmerged(&self.root)?;
        let before_entries = tree_entries(&self.root, &sentinel.base_tree, paths)?;
        let before = auxiliary_git_blobs(&self.root, &before_entries, MAX_TOTAL_AUXILIARY_BYTES)?;
        let after = auxiliary_worktree_blobs(&self.root, paths)?;
        verify_captured_state(paths, &after, sentinel)?;
        Ok(build_capture(
            paths,
            before,
            after,
            AuxiliarySentinel::Worktree(sentinel.clone()),
            "git-auxiliary",
        ))
    }

    fn capture_staged_auxiliary_once(
        &self,
        paths: &BTreeSet<RepoPath>,
        sentinel: &Sentinel,
    ) -> Result<GitAuxiliaryCapture, SourceError> {
        reject_unmerged(&self.root)?;
        let before_entries = tree_entries(&self.root, &sentinel.base_tree, paths)?;
        let after_entries = index_entries(&self.root, paths)?;
        let before = auxiliary_git_blobs(&self.root, &before_entries, MAX_TOTAL_AUXILIARY_BYTES)?;
        let after = auxiliary_git_blobs(&self.root, &after_entries, MAX_TOTAL_AUXILIARY_BYTES)?;
        Ok(build_capture(
            paths,
            before,
            after,
            AuxiliarySentinel::Staged(sentinel.clone()),
            "git-auxiliary-index",
        ))
    }
}

impl GitAuxiliaryCapture {
    pub fn apply_hypothetical(
        mut self,
        overlays: &BTreeMap<RepoPath, Option<Vec<u8>>>,
        request_digest: &str,
    ) -> Result<Self, SourceError> {
        let mut before_total = 0usize;
        let mut after_total = 0usize;
        for (path, state) in &mut self.paths {
            state.before = state.after.clone();
            if let Some(content) = overlays.get(path) {
                state.after = content.clone().map(AuxiliaryBlob::new);
            }
            if let Some(blob) = &state.before {
                add_bounded_blob_length(
                    &mut before_total,
                    blob.bytes.len(),
                    path,
                    MAX_TOTAL_AUXILIARY_BYTES,
                )?;
            }
            if let Some(blob) = &state.after {
                add_bounded_blob_length(
                    &mut after_total,
                    blob.bytes.len(),
                    path,
                    MAX_TOTAL_AUXILIARY_BYTES,
                )?;
            }
        }
        self.valid_as_of = serde_json::json!({
            "kind": "git-auxiliary-hypothetical",
            "base": self.valid_as_of,
            "request": request_digest,
        })
        .to_string();
        Ok(self)
    }
}

fn require_path_bound(paths: &BTreeSet<RepoPath>) -> Result<(), SourceError> {
    if paths.len() > MAX_AUXILIARY_PATHS {
        return Err(SourceError::Incomplete(format!(
            "{} auxiliary paths exceed limit {MAX_AUXILIARY_PATHS}",
            paths.len()
        )));
    }
    Ok(())
}

fn auxiliary_git_blobs(
    root: &std::path::Path,
    entries: &BTreeMap<RepoPath, super::TreeEntry>,
    total_limit: usize,
) -> Result<BTreeMap<RepoPath, AuxiliaryBlob>, SourceError> {
    git_blobs_from_objects_bounded(root, entries.iter().collect(), total_limit).map(|blobs| {
        blobs
            .into_iter()
            .map(|blob| (blob.path, AuxiliaryBlob::new(blob.bytes)))
            .collect()
    })
}

fn auxiliary_worktree_blobs(
    root: &std::path::Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<BTreeMap<RepoPath, AuxiliaryBlob>, SourceError> {
    let mut result = BTreeMap::new();
    let mut missing = BTreeSet::new();
    let mut total = 0usize;
    for path in paths {
        if let Some(bytes) = read_optional_worktree_blob(root, path)? {
            add_bounded_blob_length(&mut total, bytes.len(), path, MAX_TOTAL_AUXILIARY_BYTES)?;
            result.insert(path.clone(), AuxiliaryBlob::new(bytes));
        } else {
            missing.insert(path.clone());
        }
    }

    let sparse = sparse_paths(root, &missing)?;
    let entries = index_entries(root, &sparse)?;
    let remaining = MAX_TOTAL_AUXILIARY_BYTES.saturating_sub(total);
    for (path, blob) in auxiliary_git_blobs(root, &entries, remaining)? {
        add_bounded_blob_length(
            &mut total,
            blob.bytes.len(),
            &path,
            MAX_TOTAL_AUXILIARY_BYTES,
        )?;
        result.insert(path, blob);
    }
    Ok(result)
}

fn verify_captured_state(
    paths: &BTreeSet<RepoPath>,
    after: &BTreeMap<RepoPath, AuxiliaryBlob>,
    sentinel: &Sentinel,
) -> Result<(), SourceError> {
    let expected = sentinel.worktree_state.ok_or_else(|| {
        SourceError::Incomplete("auxiliary sentinel omitted exact worktree state".into())
    })?;
    let contents = after
        .iter()
        .map(|(path, blob)| (path.clone(), blob.content_id))
        .collect();
    if worktree_state(paths, &contents, |_| true) != expected {
        return Err(SourceError::Changed(
            "selected auxiliary paths changed while blobs were captured".into(),
        ));
    }
    Ok(())
}

fn build_capture(
    paths: &BTreeSet<RepoPath>,
    mut before: BTreeMap<RepoPath, AuxiliaryBlob>,
    mut after: BTreeMap<RepoPath, AuxiliaryBlob>,
    sentinel: AuxiliarySentinel,
    kind: &str,
) -> GitAuxiliaryCapture {
    let paths = paths
        .iter()
        .cloned()
        .map(|path| {
            let before_blob = before.remove(&path);
            let mut after_blob = after.remove(&path);
            if let (Some(before_blob), Some(after_blob)) = (&before_blob, &mut after_blob)
                && before_blob.content_id == after_blob.content_id
            {
                after_blob.bytes = Arc::clone(&before_blob.bytes);
            }
            let state = AuxiliaryPathState {
                before: before_blob,
                after: after_blob,
            };
            (path, state)
        })
        .collect::<BTreeMap<_, _>>();
    let before_view = content_view_digest("git-auxiliary-view/v1", &paths, |state| {
        state
            .before
            .as_ref()
            .map(|blob| blob.content_id.as_bytes().as_slice())
    });
    let after_view = content_view_digest("git-auxiliary-view/v1", &paths, |state| {
        state
            .after
            .as_ref()
            .map(|blob| blob.content_id.as_bytes().as_slice())
    });
    let value = match &sentinel {
        AuxiliarySentinel::Worktree(value)
        | AuxiliarySentinel::Staged(value)
        | AuxiliarySentinel::Tree {
            sentinel: value, ..
        } => value,
    };
    let valid_as_of = serde_json::json!({
        "kind": kind,
        "headTree": value.base_tree,
        "targetTree": value.target_tree,
        "index": hex::encode(value.index_hash),
        "scopeState": hex::encode(value.scope_state),
        "beforeView": before_view,
        "afterView": after_view,
    })
    .to_string();
    GitAuxiliaryCapture {
        paths,
        valid_as_of,
        sentinel,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use std::{io::BufReader, path::Path};

    use super::*;
    use crate::source::git::git_at;

    fn path(value: &str) -> RepoPath {
        RepoPath::from_protocol(value).unwrap()
    }

    fn paths(values: &[&str]) -> BTreeSet<RepoPath> {
        values.iter().map(|value| path(value)).collect()
    }

    fn initialize_repository(root: &Path) {
        fs::create_dir_all(root.join("docs")).unwrap();
        git_at(root, ["init", "-q"]).unwrap();
        git_at(root, ["config", "user.name", "Test"]).unwrap();
        git_at(root, ["config", "user.email", "test@example.com"]).unwrap();
        fs::write(root.join(".opcore.json"), b"base registry\n").unwrap();
        fs::write(root.join("docs/a.md"), b"base docs\n").unwrap();
        git_at(root, ["add", "."]).unwrap();
        git_at(root, ["commit", "-qm", "initial"]).unwrap();
    }

    fn bytes(blob: Option<&AuxiliaryBlob>) -> Option<&[u8]> {
        blob.map(|blob| blob.bytes.as_ref())
    }

    #[test]
    fn captures_head_then_staged_dirty_added_and_deleted_worktree_states() {
        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        let repository = GitRepository::discover(temp.path()).unwrap();
        let selected = paths(&[".opcore.json", "docs/a.md", "docs/new.md"]);

        fs::write(temp.path().join(".opcore.json"), b"staged registry\n").unwrap();
        git_at(temp.path(), ["add", ".opcore.json"]).unwrap();
        let staged = repository.capture_auxiliary(&selected).unwrap();
        let registry = &staged.paths[&path(".opcore.json")];
        assert_eq!(
            bytes(registry.before.as_ref()),
            Some(&b"base registry\n"[..])
        );
        assert_eq!(
            bytes(registry.after.as_ref()),
            Some(&b"staged registry\n"[..])
        );

        fs::write(temp.path().join(".opcore.json"), b"dirty registry\n").unwrap();
        fs::write(temp.path().join("docs/new.md"), b"untracked docs\n").unwrap();
        git_at(temp.path(), ["rm", "-q", "docs/a.md"]).unwrap();
        let dirty = repository.capture_auxiliary(&selected).unwrap();
        assert_eq!(
            bytes(dirty.paths[&path(".opcore.json")].after.as_ref()),
            Some(&b"dirty registry\n"[..])
        );
        assert_eq!(
            bytes(dirty.paths[&path("docs/new.md")].before.as_ref()),
            None
        );
        assert_eq!(
            bytes(dirty.paths[&path("docs/new.md")].after.as_ref()),
            Some(&b"untracked docs\n"[..])
        );
        assert_eq!(
            bytes(dirty.paths[&path("docs/a.md")].before.as_ref()),
            Some(&b"base docs\n"[..])
        );
        assert_eq!(bytes(dirty.paths[&path("docs/a.md")].after.as_ref()), None);
        assert!(repository.is_auxiliary_current(&dirty).unwrap());
    }

    #[test]
    fn captures_rename_as_exact_old_absence_and_new_presence() {
        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        git_at(temp.path(), ["mv", "docs/a.md", "docs/b.md"]).unwrap();
        let repository = GitRepository::discover(temp.path()).unwrap();
        let capture = repository
            .capture_auxiliary(&paths(&["docs/a.md", "docs/b.md"]))
            .unwrap();

        assert_eq!(
            bytes(capture.paths[&path("docs/a.md")].before.as_ref()),
            Some(&b"base docs\n"[..])
        );
        assert_eq!(
            bytes(capture.paths[&path("docs/a.md")].after.as_ref()),
            None
        );
        assert_eq!(
            bytes(capture.paths[&path("docs/b.md")].before.as_ref()),
            None
        );
        assert_eq!(
            bytes(capture.paths[&path("docs/b.md")].after.as_ref()),
            Some(&b"base docs\n"[..])
        );
    }

    #[cfg(unix)]
    #[test]
    fn treats_git_pathspec_metacharacters_as_literal_filenames() {
        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        fs::write(temp.path().join("docs/*.md"), b"literal wildcard\n").unwrap();
        fs::write(temp.path().join("docs/other.md"), b"other docs\n").unwrap();
        git_at(temp.path(), ["add", "."]).unwrap();
        git_at(temp.path(), ["commit", "-qm", "literal path"]).unwrap();
        let repository = GitRepository::discover(temp.path()).unwrap();
        let capture = repository
            .capture_auxiliary(&paths(&["docs/*.md"]))
            .unwrap();

        assert_eq!(capture.paths.len(), 1);
        assert_eq!(
            bytes(capture.paths[&path("docs/*.md")].before.as_ref()),
            Some(&b"literal wildcard\n"[..])
        );
    }

    #[test]
    fn missing_skip_worktree_path_reads_exact_index_blob() {
        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        git_at(
            temp.path(),
            ["update-index", "--skip-worktree", "docs/a.md"],
        )
        .unwrap();
        fs::remove_file(temp.path().join("docs/a.md")).unwrap();
        let repository = GitRepository::discover(temp.path()).unwrap();
        let capture = repository
            .capture_auxiliary(&paths(&["docs/a.md"]))
            .unwrap();

        let state = &capture.paths[&path("docs/a.md")];
        assert_eq!(bytes(state.before.as_ref()), Some(&b"base docs\n"[..]));
        assert_eq!(bytes(state.after.as_ref()), Some(&b"base docs\n"[..]));
        assert!(Arc::ptr_eq(
            &state.before.as_ref().unwrap().bytes,
            &state.after.as_ref().unwrap().bytes
        ));
        assert!(repository.is_auxiliary_current(&capture).unwrap());
    }

    #[test]
    fn aggregate_bound_is_checked_from_the_header_before_blob_allocation() {
        let selected = path("docs/large.md");
        let entry = super::super::TreeEntry {
            mode: "100644".into(),
            oid: "object-id".into(),
        };
        let mut reader = BufReader::new(b"object-id blob 2\n".as_slice());
        let result = super::super::read_cat_blobs(&mut reader, vec![(&selected, &entry)], 1);
        assert!(matches!(result, Err(SourceError::Incomplete(_))));
    }

    #[test]
    fn per_file_bound_is_checked_from_the_header_before_blob_allocation() {
        let selected = path("docs/large.md");
        let entry = super::super::TreeEntry {
            mode: "100644".into(),
            oid: "object-id".into(),
        };
        let header = format!("object-id blob {}\n", crate::limits::MAX_SOURCE_BYTES + 1);
        let mut reader = BufReader::new(header.as_bytes());
        let result = super::super::read_cat_blobs(
            &mut reader,
            vec![(&selected, &entry)],
            MAX_TOTAL_AUXILIARY_BYTES,
        );
        assert!(matches!(result, Err(SourceError::Incomplete(_))));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_worktree_and_tracked_symlinks_without_following_them() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        fs::remove_file(temp.path().join("docs/a.md")).unwrap();
        symlink("../.opcore.json", temp.path().join("docs/a.md")).unwrap();
        let repository = GitRepository::discover(temp.path()).unwrap();
        assert!(matches!(
            repository.capture_auxiliary(&paths(&["docs/a.md"])),
            Err(SourceError::Denied(_))
        ));

        let tracked = tempfile::tempdir().unwrap();
        fs::create_dir_all(tracked.path().join("docs")).unwrap();
        git_at(tracked.path(), ["init", "-q"]).unwrap();
        git_at(tracked.path(), ["config", "user.name", "Test"]).unwrap();
        git_at(tracked.path(), ["config", "user.email", "test@example.com"]).unwrap();
        fs::write(tracked.path().join("target.md"), b"outside\n").unwrap();
        symlink("../target.md", tracked.path().join("docs/link.md")).unwrap();
        git_at(tracked.path(), ["add", "."]).unwrap();
        git_at(tracked.path(), ["commit", "-qm", "symlink"]).unwrap();
        let repository = GitRepository::discover(tracked.path()).unwrap();
        assert!(matches!(
            repository.capture_auxiliary(&paths(&["docs/link.md"])),
            Err(SourceError::Denied(_))
        ));
    }

    #[test]
    fn linked_worktrees_keep_dirty_bytes_and_indexes_local() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let linked = temp.path().join("linked");
        fs::create_dir_all(&main).unwrap();
        initialize_repository(&main);
        git_at(
            &main,
            [
                "worktree",
                "add",
                "-q",
                "-b",
                "docs-linked",
                linked.to_str().unwrap(),
            ],
        )
        .unwrap();

        fs::write(main.join("docs/a.md"), b"main dirty\n").unwrap();
        fs::write(linked.join("docs/a.md"), b"linked staged\n").unwrap();
        git_at(&linked, ["add", "docs/a.md"]).unwrap();
        fs::write(linked.join(".opcore.json"), b"linked registry\n").unwrap();

        let main_repository = GitRepository::discover(&main).unwrap();
        let linked_repository = GitRepository::discover(&linked).unwrap();
        assert_eq!(main_repository.common_dir(), linked_repository.common_dir());
        assert_ne!(main_repository.root(), linked_repository.root());
        let selected = paths(&[".opcore.json", "docs/a.md"]);
        let main_capture = main_repository.capture_auxiliary(&selected).unwrap();
        let linked_capture = linked_repository.capture_auxiliary(&selected).unwrap();
        assert_eq!(
            bytes(main_capture.paths[&path("docs/a.md")].after.as_ref()),
            Some(&b"main dirty\n"[..])
        );
        assert_eq!(
            bytes(linked_capture.paths[&path("docs/a.md")].after.as_ref()),
            Some(&b"linked staged\n"[..])
        );
        assert_eq!(
            bytes(linked_capture.paths[&path(".opcore.json")].after.as_ref()),
            Some(&b"linked registry\n"[..])
        );
        assert_ne!(main_capture.valid_as_of, linked_capture.valid_as_of);

        fs::write(linked.join("docs/a.md"), b"linked changed again\n").unwrap();
        assert!(main_repository.is_auxiliary_current(&main_capture).unwrap());
        assert!(
            !linked_repository
                .is_auxiliary_current(&linked_capture)
                .unwrap()
        );
    }

    #[test]
    fn mutation_between_sentinel_and_read_is_rejected_and_final_revalidation_detects_change() {
        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        let repository = GitRepository::discover(temp.path()).unwrap();
        let selected = paths(&["docs/a.md"]);
        let explicit = selected.iter().cloned().collect::<Vec<_>>();
        let sentinel = repository.auxiliary_sentinel(&explicit).unwrap();
        fs::write(temp.path().join("docs/a.md"), b"changed before read\n").unwrap();
        assert!(matches!(
            repository.capture_auxiliary_once(&selected, &sentinel),
            Err(SourceError::Changed(_))
        ));

        let capture = repository.capture_auxiliary(&selected).unwrap();
        fs::write(temp.path().join("docs/a.md"), b"changed after capture\n").unwrap();
        assert!(!repository.is_auxiliary_current(&capture).unwrap());
    }

    #[test]
    fn enforces_selected_path_bound_before_capture() {
        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        let repository = GitRepository::discover(temp.path()).unwrap();
        let selected = (0..=MAX_AUXILIARY_PATHS)
            .map(|index| path(&format!("docs/{index}.md")))
            .collect();
        assert!(matches!(
            repository.capture_auxiliary(&selected),
            Err(SourceError::Incomplete(_))
        ));
    }
}
