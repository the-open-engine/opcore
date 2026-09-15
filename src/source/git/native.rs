use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use sha2::{Digest, Sha256};

use crate::{
    limits::{MAX_FILES, MAX_TOTAL_SOURCE_BYTES},
    path::RepoPath,
    source::SourceError,
};

use super::{
    GitRepository, GitScope, TreeEntry, add_bounded_blob_length, content_view_digest,
    current_native_worktree_state, git_blobs_from_objects_bounded, head_tree_or_empty,
    index_entries, native_index_paths, native_tree_paths, native_worktree_paths,
    read_optional_worktree_blob, reject_unmerged, sentinel_index_hash, sparse_paths,
    stable_capture, tree_entries,
};

/// One exact file payload in a native-provider workspace view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeBlob {
    pub(crate) blob_id: String,
    pub(crate) bytes: Arc<[u8]>,
}

impl NativeBlob {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            blob_id: format!("blob:sha256:{}", hex::encode(Sha256::digest(&bytes))),
            bytes: bytes.into(),
        }
    }
}

/// Before and after content for one path in an immutable native-provider capture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativePathState {
    pub(crate) before: Option<NativeBlob>,
    pub(crate) after: Option<NativeBlob>,
}

/// A bounded full-file Git view used only by the ASP host/native provider boundary.
///
/// Unlike `SourceSnapshot`, this view deliberately retains manifests, lockfiles, build scripts,
/// and non-source resources. It is never fed to the fast parser engine or persisted in its cache.
#[derive(Clone, Debug)]
pub(crate) struct GitNativeCapture {
    pub(crate) baseline_rev: String,
    pub(crate) paths: BTreeMap<RepoPath, NativePathState>,
    pub(crate) changed_paths: BTreeSet<RepoPath>,
    pub(crate) valid_as_of: String,
    roots: Vec<RepoPath>,
    filter: super::NativeCaptureFilter,
    sentinel: NativeSentinel,
    base_ref: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum NativeSentinel {
    Worktree {
        head_tree: String,
        observed_head_tree: String,
        index_state: [u8; 32],
        paths: BTreeSet<RepoPath>,
        content_state: [u8; 32],
        generation_state: [u8; 32],
    },
    Staged {
        head_tree: String,
        observed_head_tree: String,
        index_state: [u8; 32],
        before_paths: BTreeSet<RepoPath>,
        after_paths: BTreeSet<RepoPath>,
    },
    Tree {
        head_tree: String,
        target_tree: String,
        tree_ref: String,
        base_ref: Option<String>,
        before_paths: BTreeSet<RepoPath>,
        after_paths: BTreeSet<RepoPath>,
    },
}

impl GitRepository {
    /// Captures all tracked and non-ignored untracked regular files for native ASP evaluation.
    #[cfg(test)]
    pub(crate) fn capture_native_workspace(
        &self,
        staged: bool,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<GitNativeCapture, SourceError> {
        stable_capture(
            || self.native_sentinel(staged, roots, filter),
            |sentinel| self.capture_native_once(sentinel, roots, filter),
            |_| self.native_sentinel(staged, roots, filter),
            "HEAD, index, native path set, or worktree bytes changed during capture",
            "native workspace capture did not stabilize",
        )
    }

    pub(crate) fn is_native_current(
        &self,
        capture: &GitNativeCapture,
    ) -> Result<bool, SourceError> {
        if let NativeSentinel::Tree {
            tree_ref, base_ref, ..
        } = &capture.sentinel
        {
            Ok(capture.sentinel
                == self.native_tree_sentinel(
                    tree_ref,
                    base_ref.as_deref(),
                    &capture.roots,
                    capture.filter,
                )?)
        } else {
            let staged = matches!(capture.sentinel, NativeSentinel::Staged { .. });
            Ok(capture.sentinel
                == self.native_sentinel_from(
                    staged,
                    capture.base_ref.as_deref(),
                    &capture.roots,
                    capture.filter,
                )?)
        }
    }

    /// Lists the exact candidate path envelope without reading file contents.
    pub(crate) fn native_candidate_paths(
        &self,
        staged: bool,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<BTreeSet<RepoPath>, SourceError> {
        if staged {
            native_index_paths(&self.root, roots, filter, &self.targets)
        } else {
            native_worktree_paths(&self.root, roots, filter, &self.targets)
        }
    }

    pub(crate) fn capture_native_from(
        &self,
        view: &crate::policy::ConfigView,
        base_ref: Option<&str>,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<GitNativeCapture, SourceError> {
        let crate::policy::ConfigView::Tree(tree_ref) = view else {
            let staged = matches!(view, crate::policy::ConfigView::Index);
            let mut capture = stable_capture(
                || self.native_sentinel_from(staged, base_ref, roots, filter),
                |sentinel| self.capture_native_once(sentinel, roots, filter),
                |_| self.native_sentinel_from(staged, base_ref, roots, filter),
                "Git refs, index or native inputs changed during capture",
                "native capture did not stabilize",
            )?;
            capture.base_ref = base_ref.map(str::to_owned);
            return Ok(capture);
        };
        stable_capture(
            || self.native_tree_sentinel(tree_ref, base_ref, roots, filter),
            |sentinel| self.capture_native_once(sentinel, roots, filter),
            |_| self.native_tree_sentinel(tree_ref, base_ref, roots, filter),
            "Git refs changed while native workspace was captured",
            "native tree capture did not stabilize",
        )
    }

    pub(crate) fn native_candidate_paths_from(
        &self,
        view: &crate::policy::ConfigView,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<BTreeSet<RepoPath>, SourceError> {
        match view {
            crate::policy::ConfigView::Tree(reference) => {
                let tree = super::resolve_tree(&self.root, reference)?;
                native_tree_paths(&self.root, &tree, roots, filter, &self.targets)
            }
            _ => self.native_candidate_paths(
                matches!(view, crate::policy::ConfigView::Index),
                roots,
                filter,
            ),
        }
    }

    fn native_tree_sentinel(
        &self,
        tree_ref: &str,
        base_ref: Option<&str>,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<NativeSentinel, SourceError> {
        let target_tree = super::resolve_tree(&self.root, tree_ref)?;
        let head_tree = base_ref.map_or_else(
            || Ok(target_tree.clone()),
            |reference| super::resolve_tree(&self.root, reference),
        )?;
        let before_paths = native_tree_paths(&self.root, &head_tree, roots, filter, &self.targets)?;
        let after_paths =
            native_tree_paths(&self.root, &target_tree, roots, filter, &self.targets)?;
        Ok(NativeSentinel::Tree {
            head_tree,
            target_tree,
            tree_ref: tree_ref.to_owned(),
            base_ref: base_ref.map(str::to_owned),
            before_paths,
            after_paths,
        })
    }

    #[cfg(test)]
    fn native_sentinel(
        &self,
        staged: bool,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<NativeSentinel, SourceError> {
        self.native_sentinel_from(staged, None, roots, filter)
    }

    fn native_sentinel_from(
        &self,
        staged: bool,
        base_ref: Option<&str>,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<NativeSentinel, SourceError> {
        let observed_head_tree = head_tree_or_empty(&self.root)?;
        let head_tree = base_ref.map_or_else(
            || Ok(observed_head_tree.clone()),
            |reference| super::resolve_tree(&self.root, reference),
        )?;
        let index_state = sentinel_index_hash(GitScope::Changed, &self.index_path)?;
        let before_paths = native_tree_paths(&self.root, &head_tree, roots, filter, &self.targets)?;
        if staged {
            return self.staged_native_sentinel(
                (head_tree, observed_head_tree),
                index_state,
                before_paths,
                roots,
                filter,
            );
        }
        self.worktree_native_sentinel(head_tree, observed_head_tree, index_state, roots, filter)
    }

    fn staged_native_sentinel(
        &self,
        trees: (String, String),
        index_state: [u8; 32],
        before_paths: BTreeSet<RepoPath>,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<NativeSentinel, SourceError> {
        let after_paths = native_index_paths(&self.root, roots, filter, &self.targets)?;
        Ok(NativeSentinel::Staged {
            head_tree: trees.0,
            observed_head_tree: trees.1,
            index_state,
            before_paths,
            after_paths,
        })
    }

    fn worktree_native_sentinel(
        &self,
        head_tree: String,
        observed_head_tree: String,
        index_state: [u8; 32],
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<NativeSentinel, SourceError> {
        let paths = native_worktree_paths(&self.root, roots, filter, &self.targets)?;
        let (content_state, generation_state) = current_native_worktree_state(&self.root, &paths)?;
        Ok(NativeSentinel::Worktree {
            head_tree,
            observed_head_tree,
            index_state,
            paths,
            content_state,
            generation_state,
        })
    }

    fn capture_native_once(
        &self,
        sentinel: &NativeSentinel,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<GitNativeCapture, SourceError> {
        if !matches!(sentinel, NativeSentinel::Tree { .. }) {
            reject_unmerged(&self.root)?;
        }
        match sentinel {
            NativeSentinel::Worktree {
                head_tree, paths, ..
            } => self.capture_native_worktree(head_tree, paths, sentinel, roots, filter),
            NativeSentinel::Staged { .. } => self.capture_native_index(sentinel, roots, filter),
            NativeSentinel::Tree { .. } => self.capture_native_tree(sentinel, roots, filter),
        }
    }

    fn capture_native_tree(
        &self,
        sentinel: &NativeSentinel,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<GitNativeCapture, SourceError> {
        let NativeSentinel::Tree {
            head_tree,
            target_tree,
            before_paths,
            after_paths,
            ..
        } = sentinel
        else {
            return Err(SourceError::Invalid(
                "native tree capture requires a tree sentinel".into(),
            ));
        };
        validate_path_sets(before_paths, after_paths)?;
        let before = raw_git_blobs(
            &self.root,
            &tree_entries(&self.root, head_tree, before_paths)?,
        )?;
        let after = raw_git_blobs(
            &self.root,
            &tree_entries(&self.root, target_tree, after_paths)?,
        )?;
        Ok(build_capture(
            before,
            after,
            sentinel.clone(),
            roots.to_vec(),
            filter,
        ))
    }

    fn capture_native_worktree(
        &self,
        head_tree: &str,
        after_paths: &BTreeSet<RepoPath>,
        sentinel: &NativeSentinel,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<GitNativeCapture, SourceError> {
        let before_paths = native_tree_paths(&self.root, head_tree, roots, filter, &self.targets)?;
        validate_path_sets(&before_paths, after_paths)?;
        let before_entries = tree_entries(&self.root, head_tree, &before_paths)?;
        let before = raw_git_blobs(&self.root, &before_entries)?;
        let after = raw_worktree_blobs(&self.root, after_paths)?;
        Ok(build_capture(
            before,
            after,
            sentinel.clone(),
            roots.to_vec(),
            filter,
        ))
    }

    fn capture_native_index(
        &self,
        sentinel: &NativeSentinel,
        roots: &[RepoPath],
        filter: super::NativeCaptureFilter,
    ) -> Result<GitNativeCapture, SourceError> {
        let NativeSentinel::Staged {
            head_tree,
            before_paths,
            after_paths,
            ..
        } = sentinel
        else {
            return Err(SourceError::Invalid(
                "worktree sentinel used for staged native capture".into(),
            ));
        };
        validate_path_sets(before_paths, after_paths)?;
        let before_entries = tree_entries(&self.root, head_tree, before_paths)?;
        let after_entries = index_entries(&self.root, after_paths)?;
        let before = raw_git_blobs(&self.root, &before_entries)?;
        let after = raw_git_blobs(&self.root, &after_entries)?;
        Ok(build_capture(
            before,
            after,
            sentinel.clone(),
            roots.to_vec(),
            filter,
        ))
    }
}

fn validate_path_sets(
    before_paths: &BTreeSet<RepoPath>,
    after_paths: &BTreeSet<RepoPath>,
) -> Result<(), SourceError> {
    require_path_bound(before_paths)?;
    require_path_bound(after_paths)?;
    require_path_bound(&before_paths.union(after_paths).cloned().collect())?;
    Ok(())
}

fn require_path_bound(paths: &BTreeSet<RepoPath>) -> Result<(), SourceError> {
    if paths.len() > MAX_FILES {
        return Err(SourceError::Incomplete(format!(
            "native workspace exceeds {MAX_FILES} files"
        )));
    }
    Ok(())
}

fn raw_git_blobs(
    root: &std::path::Path,
    entries: &BTreeMap<RepoPath, TreeEntry>,
) -> Result<BTreeMap<RepoPath, NativeBlob>, SourceError> {
    git_blobs_from_objects_bounded(root, entries.iter().collect(), MAX_TOTAL_SOURCE_BYTES).map(
        |blobs| {
            blobs
                .into_iter()
                .map(|blob| (blob.path, NativeBlob::new(blob.bytes)))
                .collect()
        },
    )
}

fn raw_worktree_blobs(
    root: &std::path::Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<BTreeMap<RepoPath, NativeBlob>, SourceError> {
    let mut blobs = BTreeMap::new();
    let mut missing = BTreeSet::new();
    let mut total = 0usize;
    for path in paths {
        if let Some(blob) = raw_worktree_blob(root, path, &mut total)? {
            blobs.insert(path.clone(), blob);
        } else {
            missing.insert(path.clone());
        }
    }
    let sparse = sparse_paths(root, &missing)?;
    let entries = index_entries(root, &sparse)?;
    let remaining = MAX_TOTAL_SOURCE_BYTES.saturating_sub(total);
    for (path, blob) in raw_git_blobs_bounded(root, &entries, remaining)? {
        blobs.insert(path, blob);
    }
    Ok(blobs)
}

fn raw_worktree_blob(
    root: &std::path::Path,
    path: &RepoPath,
    total: &mut usize,
) -> Result<Option<NativeBlob>, SourceError> {
    match read_optional_worktree_blob(root, path)? {
        Some(bytes) => {
            add_bounded_blob_length(total, bytes.len(), path, MAX_TOTAL_SOURCE_BYTES)?;
            Ok(Some(NativeBlob::new(bytes)))
        }
        None => Ok(None),
    }
}

fn raw_git_blobs_bounded(
    root: &std::path::Path,
    entries: &BTreeMap<RepoPath, TreeEntry>,
    total_limit: usize,
) -> Result<BTreeMap<RepoPath, NativeBlob>, SourceError> {
    git_blobs_from_objects_bounded(root, entries.iter().collect(), total_limit).map(|blobs| {
        blobs
            .into_iter()
            .map(|blob| (blob.path, NativeBlob::new(blob.bytes)))
            .collect()
    })
}

fn build_capture(
    mut before: BTreeMap<RepoPath, NativeBlob>,
    mut after: BTreeMap<RepoPath, NativeBlob>,
    sentinel: NativeSentinel,
    roots: Vec<RepoPath>,
    filter: super::NativeCaptureFilter,
) -> GitNativeCapture {
    let mut all_paths = before.keys().cloned().collect::<BTreeSet<_>>();
    all_paths.extend(after.keys().cloned());
    let mut changed_paths = BTreeSet::new();
    let mut states = BTreeMap::new();
    for path in all_paths {
        let before_blob = before.remove(&path);
        let mut after_blob = after.remove(&path);
        if let (Some(left), Some(right)) = (&before_blob, &mut after_blob)
            && left.blob_id == right.blob_id
        {
            right.bytes = Arc::clone(&left.bytes);
        }
        if before_blob.as_ref().map(|blob| &blob.blob_id)
            != after_blob.as_ref().map(|blob| &blob.blob_id)
        {
            changed_paths.insert(path.clone());
        }
        states.insert(
            path,
            NativePathState {
                before: before_blob,
                after: after_blob,
            },
        );
    }
    let before_view = content_view_digest("git-native-view/v1", &states, |state| {
        state.before.as_ref().map(|blob| blob.blob_id.as_bytes())
    });
    let after_view = content_view_digest("git-native-view/v1", &states, |state| {
        state.after.as_ref().map(|blob| blob.blob_id.as_bytes())
    });
    let baseline_tree = match &sentinel {
        NativeSentinel::Worktree { head_tree, .. }
        | NativeSentinel::Staged { head_tree, .. }
        | NativeSentinel::Tree { head_tree, .. } => head_tree,
    };
    let kind = if matches!(sentinel, NativeSentinel::Staged { .. }) {
        "git-native-index"
    } else if matches!(sentinel, NativeSentinel::Tree { .. }) {
        "git-native-tree"
    } else {
        "git-native-worktree"
    };
    GitNativeCapture {
        baseline_rev: format!("git:tree:{baseline_tree}"),
        paths: states,
        changed_paths,
        valid_as_of: serde_json::json!({
            "kind": kind,
            "headTree": baseline_tree,
            "beforeView": before_view,
            "afterView": after_view,
        })
        .to_string(),
        roots,
        filter,
        sentinel,
        base_ref: None,
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use super::*;
    use crate::source::git::git_at;

    fn initialize_repository(root: &Path) {
        fs::create_dir_all(root.join("src")).unwrap();
        git_at(root, ["init", "-q"]).unwrap();
        for (key, value) in [
            ("user.name", "Native Capture Test"),
            ("user.email", "native-capture@example.com"),
        ] {
            git_at(root, ["config", key, value]).unwrap();
        }
        fs::write(
            root.join("Cargo.toml"),
            b"[package]\nname='fixture'\nversion='0.1.0'\n",
        )
        .unwrap();
        fs::write(root.join("src/lib.rs"), b"pub fn value() -> u8 { 1 }\n").unwrap();
        fs::write(root.join("data.bin"), b"before\0resource").unwrap();
        git_at(root, ["add", "."]).unwrap();
        git_at(root, ["commit", "-qm", "initial"]).unwrap();
    }

    fn write_oversized(root: &Path, name: &str) {
        let file = fs::File::create(root.join(name)).unwrap();
        file.set_len((crate::limits::MAX_SOURCE_BYTES + 1) as u64)
            .unwrap();
    }

    fn commit_and_discover(root: &Path, message: &str) -> GitRepository {
        git_at(root, ["add", "."]).unwrap();
        git_at(root, ["commit", "-qm", message]).unwrap();
        GitRepository::discover(root).unwrap()
    }

    #[test]
    fn captures_non_source_resources_and_exact_worktree_changes() {
        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        fs::write(temp.path().join("data.bin"), b"after\0resource").unwrap();
        fs::write(temp.path().join("build-input.txt"), b"new").unwrap();
        let repository = GitRepository::discover(temp.path()).unwrap();

        let capture = repository
            .capture_native_workspace(false, &[], crate::source::git::NativeCaptureFilter::full())
            .unwrap();
        let data = RepoPath::from_protocol("data.bin").unwrap();
        let added = RepoPath::from_protocol("build-input.txt").unwrap();
        assert_eq!(
            capture.paths[&data].before.as_ref().unwrap().bytes.as_ref(),
            b"before\0resource"
        );
        assert_eq!(
            capture.paths[&data].after.as_ref().unwrap().bytes.as_ref(),
            b"after\0resource"
        );
        assert!(capture.paths[&added].before.is_none());
        assert_eq!(
            capture.paths[&added].after.as_ref().unwrap().bytes.as_ref(),
            b"new"
        );
        assert!(capture.changed_paths.contains(&data));
        assert!(capture.changed_paths.contains(&added));
        assert!(repository.is_native_current(&capture).unwrap());
    }

    #[test]
    fn selected_roots_bound_capture_before_reading_unrelated_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        initialize_repository(root);
        fs::create_dir_all(root.join("selected/src")).unwrap();
        fs::write(
            root.join("selected/src/lib.rs"),
            b"pub fn selected() -> bool { true }\n",
        )
        .unwrap();
        write_oversized(root, "oversized.bin");
        git_at(root, ["add", "."]).unwrap();
        git_at(root, ["commit", "-qm", "selected root fixture"]).unwrap();

        let repository = GitRepository::discover(root).unwrap();
        let selected = RepoPath::from_protocol("selected").unwrap();
        let capture = repository
            .capture_native_workspace(
                false,
                std::slice::from_ref(&selected),
                crate::source::git::NativeCaptureFilter::full(),
            )
            .unwrap();
        assert_eq!(
            capture
                .paths
                .keys()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec!["Cargo.toml", "selected/src/lib.rs"]
        );
        assert!(
            repository
                .capture_native_workspace(
                    false,
                    &[],
                    crate::source::git::NativeCaptureFilter::full(),
                )
                .is_err()
        );

        fs::write(root.join("src/lib.rs"), b"pub fn outside() {}\n").unwrap();
        assert!(repository.is_native_current(&capture).unwrap());
        fs::write(root.join("selected/src/lib.rs"), b"pub fn selected() {}\n").unwrap();
        assert!(!repository.is_native_current(&capture).unwrap());
    }

    #[test]
    fn provider_filter_ignores_unrelated_large_assets_before_capture_bounds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        initialize_repository(root);
        fs::write(root.join("app.py"), b"value: str = 'ok'\n").unwrap();
        write_oversized(root, "rows.jsonl");
        let repository = commit_and_discover(root, "python fixture");
        let filter = crate::source::git::NativeCaptureFilter::empty()
            .with(crate::source::git::NativeCaptureKind::Python);

        let capture = repository
            .capture_native_workspace(false, &[], filter)
            .unwrap();
        assert_eq!(
            capture
                .paths
                .keys()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec!["app.py"]
        );
        assert!(repository.is_native_current(&capture).unwrap());
        fs::write(root.join("rows.jsonl"), b"irrelevant\n").unwrap();
        assert!(repository.is_native_current(&capture).unwrap());
    }

    #[test]
    fn rust_filter_keeps_workspace_inputs_but_ignores_unrelated_binary_assets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        initialize_repository(root);
        fs::create_dir_all(root.join("protocol")).unwrap();
        fs::write(root.join("protocol/value.txt"), b"compile resource\n").unwrap();
        write_oversized(root, "demo.gif");
        let repository = commit_and_discover(root, "rust fixture");
        let filter = crate::source::git::NativeCaptureFilter::empty()
            .with(crate::source::git::NativeCaptureKind::Rust);

        let capture = repository
            .capture_native_workspace(false, &[], filter)
            .unwrap();
        assert!(
            capture
                .paths
                .contains_key(&RepoPath::from_protocol("src/lib.rs").unwrap())
        );
        assert!(
            capture
                .paths
                .contains_key(&RepoPath::from_protocol("protocol/value.txt").unwrap())
        );
        assert!(
            !capture
                .paths
                .contains_key(&RepoPath::from_protocol("demo.gif").unwrap())
        );
    }

    #[test]
    fn staged_capture_ignores_dirty_and_untracked_bytes() {
        let temp = tempfile::tempdir().unwrap();
        initialize_repository(temp.path());
        fs::write(temp.path().join("data.bin"), b"staged").unwrap();
        git_at(temp.path(), ["add", "data.bin"]).unwrap();
        fs::write(temp.path().join("data.bin"), b"dirty").unwrap();
        fs::write(temp.path().join("ignored-by-stage.txt"), b"untracked").unwrap();
        let repository = GitRepository::discover(temp.path()).unwrap();

        let capture = repository
            .capture_native_workspace(true, &[], crate::source::git::NativeCaptureFilter::full())
            .unwrap();
        let data = RepoPath::from_protocol("data.bin").unwrap();
        assert_eq!(
            capture.paths[&data].after.as_ref().unwrap().bytes.as_ref(),
            b"staged"
        );
        assert!(
            !capture
                .paths
                .contains_key(&RepoPath::from_protocol("ignored-by-stage.txt").unwrap())
        );
        assert!(repository.is_native_current(&capture).unwrap());
    }

    #[test]
    fn ignores_gitlinks_and_untracked_embedded_repositories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let dependency = temp.path().join("dependency");
        initialize_repository(&root);
        initialize_repository(&dependency);
        fs::create_dir_all(root.join("vendor")).unwrap();
        git_at(
            &root,
            [
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                dependency.to_str().unwrap(),
                "vendor/dependency",
            ],
        )
        .unwrap();
        git_at(&root, ["commit", "-qam", "add gitlink"]).unwrap();

        let embedded = root.join(".claude/worktrees/embedded");
        initialize_repository(&embedded);
        let listed = git_at(
            &root,
            ["ls-files", "--others", "--exclude-standard", "-z", "--"],
        )
        .unwrap();
        assert!(
            listed
                .split(|byte| *byte == 0)
                .any(|path| path == b".claude/worktrees/embedded/")
        );

        let repository = GitRepository::discover(&root).unwrap();
        let capture = repository
            .capture_native_workspace(false, &[], crate::source::git::NativeCaptureFilter::full())
            .unwrap();
        assert!(
            !capture
                .paths
                .contains_key(&RepoPath::from_protocol("vendor/dependency").unwrap())
        );
        assert!(
            capture
                .paths
                .keys()
                .all(|path| { !path.as_bytes().starts_with(b".claude/worktrees/embedded") })
        );
        assert!(repository.is_native_current(&capture).unwrap());
    }
}
