//! Exact, request-local Git source capture for the CLI adapter.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};

use crate::{
    identity::{ContentId, RepositoryId, hash_domain},
    limits::{MAX_FILES, MAX_SOURCE_BYTES, MAX_TOTAL_AUXILIARY_BYTES, MAX_TOTAL_SOURCE_BYTES},
    model::SourceFile,
    path::RepoPath,
    source::{SourceError, snapshot::SourceSnapshot},
};

mod auxiliary;
mod native;
mod objects;
mod paths;
mod state;
mod workspace;

pub use super::languages::{detect_language, is_source_candidate, resolve_language};
pub(crate) use super::languages::{
    has_extension, is_dependency_capture_candidate, is_dependency_source_candidate,
    is_go_module_file,
};
#[cfg(test)]
pub(crate) use auxiliary::AuxiliaryBlob;
pub use auxiliary::{AuxiliaryPathState, GitAuxiliaryCapture};
pub(crate) use native::{GitNativeCapture, NativePathState};
#[cfg(test)]
use objects::read_cat_blobs;
use objects::{
    add_bounded_blob_length, bounded_git_output, files_from_git_objects, git_at,
    git_blobs_from_objects_bounded, git_command, head_tree_or_empty, index_entries,
    reject_unmerged, resolve_tree, tree_entries,
};
use paths::{
    native_index_paths, native_tree_paths, native_worktree_paths, raw_scope_paths,
    special_index_paths,
};
use state::{
    captured_worktree_state, current_exact_worktree_state, current_native_worktree_state,
    current_worktree_state, file_state, generation_state, metadata_state,
    read_optional_worktree_blob, read_regular_no_follow, worktree_state,
};
pub use workspace::GitWorkspaceCapture;

const CAPTURE_ATTEMPTS: usize = 2;
const PATH_ARGUMENT_BATCH: usize = 256;

fn stable_capture<S, T>(
    mut before: impl FnMut() -> Result<S, SourceError>,
    mut capture: impl FnMut(&S) -> Result<T, SourceError>,
    mut after: impl FnMut(&S) -> Result<S, SourceError>,
    changed_detail: &str,
    unstable_detail: &str,
) -> Result<T, SourceError>
where
    S: PartialEq,
{
    let mut last_error = None;
    for _ in 0..CAPTURE_ATTEMPTS {
        let sentinel = before()?;
        match capture(&sentinel) {
            Ok(value) if sentinel == after(&sentinel)? => return Ok(value),
            Ok(_) => last_error = Some(changed_detail.to_owned()),
            Err(error @ SourceError::Changed(_)) => last_error = Some(error.to_string()),
            Err(error) => return Err(error),
        }
    }
    Err(SourceError::Changed(
        last_error.unwrap_or_else(|| unstable_detail.to_owned()),
    ))
}

fn content_view_digest<T>(
    domain: &str,
    paths: &BTreeMap<RepoPath, T>,
    select: for<'a> fn(&'a T) -> Option<&'a [u8]>,
) -> String {
    let mut manifest = Vec::new();
    for (path, state) in paths {
        manifest.extend_from_slice(&(path.as_bytes().len() as u64).to_be_bytes());
        manifest.extend_from_slice(path.as_bytes());
        if let Some(identity) = select(state) {
            manifest.push(1);
            manifest.extend_from_slice(identity);
        } else {
            manifest.push(0);
        }
    }
    hex::encode(hash_domain(domain, &[&manifest]))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitScope {
    Committed,
    Changed,
    Staged,
    Tree,
    All,
    StagedAll,
    Explicit,
}

/// Provider-aware path envelope for private native workspace capture.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct NativeCaptureFilter {
    mask: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeCaptureKind {
    Fast,
    Rust,
    Node,
    Python,
}

impl NativeCaptureFilter {
    const FAST: u8 = 1 << 0;
    const RUST: u8 = 1 << 1;
    const NODE: u8 = 1 << 2;
    const PYTHON: u8 = 1 << 3;

    #[cfg(test)]
    pub(crate) const fn full() -> Self {
        Self { mask: u8::MAX }
    }

    pub(crate) const fn empty() -> Self {
        Self { mask: 0 }
    }

    pub(crate) const fn with(mut self, kind: NativeCaptureKind) -> Self {
        self.mask |= match kind {
            NativeCaptureKind::Fast => Self::FAST,
            NativeCaptureKind::Rust => Self::RUST,
            NativeCaptureKind::Node => Self::NODE,
            NativeCaptureKind::Python => Self::PYTHON,
        };
        self
    }

    pub(crate) const fn is_fast_only(self) -> bool {
        self.mask == Self::FAST
    }

    pub(crate) fn includes(self, path: &RepoPath) -> bool {
        self.mask == u8::MAX
            || (self.mask & Self::FAST != 0 && is_source_candidate(path))
            || (self.mask & Self::RUST != 0 && rust_native_path(path))
            || (self.mask & Self::NODE != 0 && node_native_path(path))
            || (self.mask & Self::PYTHON != 0 && python_native_path(path))
    }

    pub(crate) fn includes_as_ancestor_context(self, path: &RepoPath) -> bool {
        (self.mask & Self::RUST != 0 && rust_control_path(path))
            || (self.mask & Self::NODE != 0 && node_context_path(path))
            || (self.mask & Self::PYTHON != 0 && python_context_path(path))
    }
}

fn filename(path: &RepoPath) -> &[u8] {
    path.as_bytes()
        .rsplit(|byte| *byte == b'/')
        .next()
        .unwrap_or(path.as_bytes())
}

fn rust_control_path(path: &RepoPath) -> bool {
    matches!(
        filename(path),
        b"Cargo.toml" | b"Cargo.lock" | b"build.rs" | b"rust-toolchain" | b"rust-toolchain.toml"
    ) || path.as_bytes().starts_with(b".cargo/")
        || path
            .as_bytes()
            .windows(b"/.cargo/".len())
            .any(|part| part == b"/.cargo/")
}

fn rust_native_path(path: &RepoPath) -> bool {
    rust_control_path(path)
        || [
            b".rs".as_slice(),
            b".c",
            b".cc",
            b".cpp",
            b".cxx",
            b".h",
            b".hh",
            b".hpp",
            b".hxx",
            b".m",
            b".mm",
            b".s",
            b".asm",
            b".ld",
            b".proto",
            b".capnp",
            b".fbs",
            b".wit",
            b".wat",
            b".json",
            b".toml",
            b".yaml",
            b".yml",
            b".txt",
            b".md",
            b".rst",
            b".sql",
            b".graphql",
            b".gql",
            b".html",
            b".css",
            b".xml",
            b".ron",
            b".snap",
            b".stderr",
            b".pem",
            b".crt",
            b".key",
            b".svg",
        ]
        .iter()
        .any(|suffix| has_extension(path.as_bytes(), suffix))
        || matches!(filename(path), b"LICENSE" | b"NOTICE")
}

fn node_native_path(path: &RepoPath) -> bool {
    let name = filename(path);
    is_node_source(path)
        || path.as_bytes().ends_with(b".json")
        || matches!(
            name,
            b"package.json" | b"package-lock.json" | b"npm-shrinkwrap.json" | b".npmrc"
        )
}

fn node_context_path(path: &RepoPath) -> bool {
    let name = filename(path);
    matches!(
        name,
        b"package.json" | b"package-lock.json" | b"npm-shrinkwrap.json" | b".npmrc"
    ) || (name.starts_with(b"tsconfig") && name.ends_with(b".json"))
}

fn is_node_source(path: &RepoPath) -> bool {
    [
        b".js".as_slice(),
        b".jsx",
        b".mjs",
        b".cjs",
        b".ts",
        b".tsx",
        b".mts",
        b".cts",
    ]
    .iter()
    .any(|suffix| has_extension(path.as_bytes(), suffix))
}

fn python_native_path(path: &RepoPath) -> bool {
    has_extension(path.as_bytes(), b".py")
        || has_extension(path.as_bytes(), b".pyi")
        || python_context_path(path)
}

fn python_context_path(path: &RepoPath) -> bool {
    matches!(
        filename(path),
        b"pyproject.toml" | b"pyrightconfig.json" | b"mypy.ini" | b"setup.cfg" | b"tox.ini"
    )
}

#[derive(Clone, Debug)]
pub struct GitRepository {
    targets: crate::policy::TargetPolicy,
    root: PathBuf,
    common_dir: PathBuf,
    index_path: PathBuf,
    repository_id: RepositoryId,
}

pub struct GitCapture {
    pub before: Arc<SourceSnapshot>,
    pub after: Arc<SourceSnapshot>,
    pub paths: BTreeSet<RepoPath>,
    pub valid_as_of: String,
    sentinel: Sentinel,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Sentinel {
    base_tree: String,
    target_tree: Option<String>,
    compare_tree: bool,
    index_hash: [u8; 32],
    scope_state: [u8; 32],
    worktree_paths: BTreeSet<RepoPath>,
    worktree_state: Option<[u8; 32]>,
}

#[derive(Clone, Eq, PartialEq)]
struct TreeEntry {
    mode: String,
    oid: String,
}

struct GitBlob {
    path: RepoPath,
    bytes: Vec<u8>,
}

impl GitRepository {
    pub fn discover(path: &Path) -> Result<Self, SourceError> {
        let invocation = path.canonicalize().map_err(io_error)?;
        let root = discover_root(&invocation)?;
        let common_raw =
            path_from_output(&git_at(&invocation, ["rev-parse", "--git-common-dir"])?)?;
        let index_raw =
            path_from_output(&git_at(&invocation, ["rev-parse", "--git-path", "index"])?)?;
        let root = root.canonicalize().map_err(io_error)?;
        let common_dir = resolve_git_path(&invocation, common_raw)
            .canonicalize()
            .map_err(io_error)?;
        let index_path = resolve_git_path(&invocation, index_raw);
        let repository_id = RepositoryId::from_bytes(hash_domain(
            "git-common-dir/v1",
            &[common_dir.as_os_str().as_bytes()],
        ));
        Ok(Self {
            targets: crate::policy::TargetPolicy::default(),
            root,
            common_dir,
            index_path,
            repository_id,
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn common_dir(&self) -> &Path {
        &self.common_dir
    }

    #[must_use]
    pub const fn repository_id(&self) -> RepositoryId {
        self.repository_id
    }

    pub fn with_targets(&self, targets: &crate::policy::TargetPolicy) -> Self {
        let mut repository = self.clone();
        repository.targets = targets.clone();
        repository
    }

    fn dependency_candidate(&self, path: &RepoPath) -> bool {
        is_dependency_capture_candidate(path)
            && (is_go_module_file(path) || self.targets.includes(path))
    }

    /// Observes selected source and exact auxiliary generations without reading their contents.
    pub fn observation_with_auxiliary(
        &self,
        view: &crate::policy::ConfigView,
        base_ref: Option<&str>,
        auxiliary: &BTreeSet<RepoPath>,
    ) -> Result<String, SourceError> {
        let head = head_tree_or_empty(&self.root)?;
        let base = base_ref
            .map(|reference| resolve_tree(&self.root, reference))
            .transpose()?;
        let target = match view {
            crate::policy::ConfigView::Tree(reference) => {
                Some(resolve_tree(&self.root, reference)?)
            }
            _ => None,
        };
        let index = if target.is_none() {
            Some(hex::encode(sentinel_index_hash(
                GitScope::Staged,
                &self.index_path,
            )?))
        } else {
            None
        };
        let generations = self.observed_generations(view, auxiliary)?;
        Ok(
            serde_json::json!({"headTree":head,"baseTree":base,"targetTree":target,
            "index":index,"generations":generations})
            .to_string(),
        )
    }

    fn observed_generations(
        &self,
        view: &crate::policy::ConfigView,
        auxiliary: &BTreeSet<RepoPath>,
    ) -> Result<Option<String>, SourceError> {
        if !matches!(view, crate::policy::ConfigView::Worktree) {
            return Ok(None);
        }
        let mut paths =
            paths::all_paths_filtered(&self.root, &|path| self.dependency_candidate(path))?;
        paths.extend(auxiliary.iter().cloned());
        Ok(Some(hex::encode(workspace::workspace_generation_state(
            &self.root, &paths,
        )?)))
    }

    pub fn capture_from(
        &self,
        scope: GitScope,
        explicit: &[RepoPath],
        base_ref: Option<&str>,
        tree_ref: Option<&str>,
    ) -> Result<GitCapture, SourceError> {
        stable_capture(
            || self.sentinel(scope, explicit, base_ref, tree_ref),
            |sentinel| self.capture_once(scope, explicit, sentinel),
            |_| self.sentinel(scope, explicit, base_ref, tree_ref),
            "Git refs, index, or working tree changed while files were read",
            "capture did not stabilize",
        )
    }

    pub fn is_current_from(
        &self,
        capture: &GitCapture,
        scope: GitScope,
        explicit: &[RepoPath],
        base_ref: Option<&str>,
        tree_ref: Option<&str>,
    ) -> Result<bool, SourceError> {
        Ok(capture.sentinel == self.sentinel(scope, explicit, base_ref, tree_ref)?)
    }

    fn capture_once(
        &self,
        scope: GitScope,
        explicit: &[RepoPath],
        sentinel: &Sentinel,
    ) -> Result<GitCapture, SourceError> {
        if !matches!(scope, GitScope::Tree | GitScope::Committed) {
            reject_unmerged(&self.root)?;
        }
        let paths = self.capture_paths(scope, explicit, sentinel)?;
        let (before_files, after_files) = self.capture_files(scope, sentinel, &paths)?;
        verify_captured_worktree(sentinel, &after_files)?;
        validate_explicit_paths(scope, &paths, &before_files, &after_files)?;
        Ok(build_capture(paths, before_files, after_files, sentinel))
    }

    fn capture_paths(
        &self,
        scope: GitScope,
        explicit: &[RepoPath],
        sentinel: &Sentinel,
    ) -> Result<BTreeSet<RepoPath>, SourceError> {
        let paths = if scope == GitScope::Changed {
            sentinel.worktree_paths.clone()
        } else {
            self.scope_paths(scope, explicit, sentinel)?
        };
        if paths.len() > MAX_FILES {
            return Err(SourceError::Incomplete(format!(
                "{} paths exceed limit {MAX_FILES}",
                paths.len()
            )));
        }
        Ok(paths)
    }

    fn capture_files(
        &self,
        scope: GitScope,
        sentinel: &Sentinel,
        paths: &BTreeSet<RepoPath>,
    ) -> Result<(Vec<SourceFile>, Vec<SourceFile>), SourceError> {
        match scope {
            GitScope::Committed => self.capture_committed(sentinel, paths),
            GitScope::Staged | GitScope::StagedAll => self.capture_staged(sentinel, paths),
            GitScope::Tree => self.capture_tree(sentinel, paths),
            GitScope::Changed | GitScope::Explicit => self.capture_worktree(sentinel, paths),
            GitScope::All => Ok((Vec::new(), self.read_worktree_files(paths)?)),
        }
    }

    fn capture_committed(
        &self,
        sentinel: &Sentinel,
        paths: &BTreeSet<RepoPath>,
    ) -> Result<(Vec<SourceFile>, Vec<SourceFile>), SourceError> {
        let tree = sentinel.target_tree.as_ref().unwrap_or(&sentinel.base_tree);
        let entries = tree_entries(&self.root, tree, paths)?;
        let files = files_from_git_objects(&self.root, &entries)?;
        Ok((files.clone(), files))
    }

    fn capture_staged(
        &self,
        sentinel: &Sentinel,
        paths: &BTreeSet<RepoPath>,
    ) -> Result<(Vec<SourceFile>, Vec<SourceFile>), SourceError> {
        let baseline = tree_entries(&self.root, &sentinel.base_tree, paths)?;
        let before = files_from_git_objects(&self.root, &baseline)?;
        let after = files_from_git_objects(&self.root, &index_entries(&self.root, paths)?)?;
        Ok((before, after))
    }

    fn capture_worktree(
        &self,
        sentinel: &Sentinel,
        paths: &BTreeSet<RepoPath>,
    ) -> Result<(Vec<SourceFile>, Vec<SourceFile>), SourceError> {
        let baseline = tree_entries(&self.root, &sentinel.base_tree, paths)?;
        let before = files_from_git_objects(&self.root, &baseline)?;
        Ok((before, self.read_worktree_files(paths)?))
    }

    fn capture_tree(
        &self,
        sentinel: &Sentinel,
        paths: &BTreeSet<RepoPath>,
    ) -> Result<(Vec<SourceFile>, Vec<SourceFile>), SourceError> {
        let target = sentinel
            .target_tree
            .as_deref()
            .ok_or_else(|| SourceError::Invalid("tree capture requires a target tree".into()))?;
        let after = files_from_git_objects(&self.root, &tree_entries(&self.root, target, paths)?)?;
        if !sentinel.compare_tree {
            return Ok((after.clone(), after));
        }
        let before = files_from_git_objects(
            &self.root,
            &tree_entries(&self.root, &sentinel.base_tree, paths)?,
        )?;
        Ok((before, after))
    }

    fn scope_paths(
        &self,
        scope: GitScope,
        explicit: &[RepoPath],
        sentinel: &Sentinel,
    ) -> Result<BTreeSet<RepoPath>, SourceError> {
        let mut paths = raw_scope_paths(&self.root, scope, explicit, sentinel, &|path| {
            self.targets.includes(path)
                && (scope == GitScope::Explicit || is_source_candidate(path))
        })?;
        if scope != GitScope::Explicit {
            paths.retain(is_source_candidate);
        }
        Ok(paths)
    }

    fn sentinel(
        &self,
        scope: GitScope,
        explicit: &[RepoPath],
        base_ref: Option<&str>,
        tree_ref: Option<&str>,
    ) -> Result<Sentinel, SourceError> {
        self.sentinel_with(scope, explicit, is_source_candidate, base_ref, tree_ref)
    }

    fn dependency_sentinel(&self) -> Result<Sentinel, SourceError> {
        self.sentinel_with(
            GitScope::All,
            &[],
            is_dependency_capture_candidate,
            None,
            None,
        )
    }

    fn sentinel_with(
        &self,
        scope: GitScope,
        explicit: &[RepoPath],
        candidate: fn(&RepoPath) -> bool,
        base_ref: Option<&str>,
        tree_ref: Option<&str>,
    ) -> Result<Sentinel, SourceError> {
        let head_tree = head_tree_or_empty(&self.root)?;
        let base_tree = base_ref.map_or_else(
            || Ok(head_tree.clone()),
            |reference| resolve_tree(&self.root, reference),
        )?;
        let target_tree = target_tree(&self.root, scope, tree_ref, head_tree)?;
        let index_hash = sentinel_index_hash(scope, &self.index_path)?;
        let scoped = sentinel_scope_state(
            &self.root,
            SentinelScopeRequest {
                scope,
                explicit,
                base_tree: &base_tree,
                candidate: &|path| {
                    candidate(path) && (is_go_module_file(path) || self.targets.includes(path))
                },
                explicit_base: base_ref.is_some(),
            },
        )?;
        Ok(sentinel_from_scope(
            base_tree,
            target_tree,
            scope == GitScope::Tree && base_ref.is_some(),
            index_hash,
            scoped,
        ))
    }

    fn read_worktree_files(
        &self,
        paths: &BTreeSet<RepoPath>,
    ) -> Result<Vec<SourceFile>, SourceError> {
        let (mut batch, missing) = read_present_worktree_files(&self.root, paths)?;
        append_sparse_files(&self.root, &missing, &mut batch)?;
        Ok(batch.files)
    }
}

fn target_tree(
    root: &Path,
    scope: GitScope,
    tree_ref: Option<&str>,
    head_tree: String,
) -> Result<Option<String>, SourceError> {
    match scope {
        GitScope::Tree => tree_ref
            .ok_or_else(|| SourceError::Invalid("tree scope requires --tree".into()))
            .and_then(|reference| resolve_tree(root, reference))
            .map(Some),
        GitScope::Committed => Ok(Some(head_tree)),
        _ => Ok(None),
    }
}

fn sentinel_from_scope(
    base_tree: String,
    target_tree: Option<String>,
    compare_tree: bool,
    index_hash: [u8; 32],
    scoped: SentinelScope,
) -> Sentinel {
    Sentinel {
        base_tree,
        target_tree,
        compare_tree,
        index_hash,
        scope_state: Sha256::digest(scoped.state).into(),
        worktree_paths: scoped.worktree_paths,
        worktree_state: scoped.worktree_state,
    }
}

fn discover_root(invocation: &Path) -> Result<PathBuf, SourceError> {
    let output =
        bounded_git_output(git_command(invocation).args(["rev-parse", "--show-toplevel"]))?;
    if output.status.success() {
        return path_from_output(&output.stdout);
    }
    // Git has no distinct exit code for a missing repository. Only its C-locale discovery
    // diagnostic, with no nearby Git metadata to indicate a damaged worktree, permits a skip.
    if output.status.code() == Some(128)
        && output.stdout.is_empty()
        && output
            .stderr
            .starts_with(b"fatal: not a git repository (or any ")
        && !has_git_entry(invocation)?
    {
        return Err(SourceError::NotRepository);
    }
    Err(SourceError::Io(format!(
        "Git repository discovery failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    )))
}

fn has_git_entry(invocation: &Path) -> Result<bool, SourceError> {
    for ancestor in invocation.ancestors() {
        if git_entry_has_state(&ancestor.join(".git"))? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn git_entry_has_state(entry: &Path) -> Result<bool, SourceError> {
    match fs::symlink_metadata(entry) {
        Ok(metadata) if metadata.is_dir() => {
            // An empty .git directory contains no repository state. Inspect only its first
            // entry; any metadata or read failure still prevents a silent skip.
            Ok(fs::read_dir(entry)
                .map_err(io_error)?
                .next()
                .transpose()
                .map_err(io_error)?
                .is_some())
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn resolve_git_path(root: &Path, path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn verify_captured_worktree(
    sentinel: &Sentinel,
    after_files: &[SourceFile],
) -> Result<(), SourceError> {
    let Some(expected) = sentinel.worktree_state else {
        return Ok(());
    };
    let captured = captured_worktree_state(&sentinel.worktree_paths, after_files);
    if captured != expected {
        return Err(SourceError::Changed(
            "working tree changed while files were captured".into(),
        ));
    }
    Ok(())
}

fn validate_explicit_paths(
    scope: GitScope,
    paths: &BTreeSet<RepoPath>,
    before: &[SourceFile],
    after: &[SourceFile],
) -> Result<(), SourceError> {
    if scope != GitScope::Explicit {
        return Ok(());
    }
    let visible: BTreeSet<_> = before
        .iter()
        .chain(after)
        .map(|file| file.path.clone())
        .collect();
    let missing = paths
        .iter()
        .find(|path| detect_language(path).is_some() && !visible.contains(*path));
    if let Some(path) = missing {
        return Err(SourceError::NotFound(path.clone()));
    }
    Ok(())
}

fn build_capture(
    paths: BTreeSet<RepoPath>,
    before_files: Vec<SourceFile>,
    after_files: Vec<SourceFile>,
    sentinel: &Sentinel,
) -> GitCapture {
    let before = Arc::new(SourceSnapshot::new(before_files));
    let after = Arc::new(SourceSnapshot::new(after_files));
    let valid_as_of = source_valid_as_of("git", sentinel, &before, &after);
    GitCapture {
        before,
        after,
        paths,
        valid_as_of,
        sentinel: sentinel.clone(),
    }
}

fn source_valid_as_of(
    kind: &str,
    sentinel: &Sentinel,
    before: &SourceSnapshot,
    after: &SourceSnapshot,
) -> String {
    serde_json::json!({
        "kind": kind,
        "baseTree": sentinel.base_tree,
        "targetTree": sentinel.target_tree,
        "index": hex::encode(sentinel.index_hash),
        "scopeState": hex::encode(sentinel.scope_state),
        "beforeView": before.id(),
        "afterView": after.id(),
    })
    .to_string()
}

struct SentinelScope {
    state: Vec<u8>,
    worktree_paths: BTreeSet<RepoPath>,
    worktree_state: Option<[u8; 32]>,
}

#[derive(Clone, Copy)]
struct SentinelScopeRequest<'a> {
    scope: GitScope,
    explicit: &'a [RepoPath],
    base_tree: &'a str,
    candidate: &'a dyn Fn(&RepoPath) -> bool,
    explicit_base: bool,
}

fn sentinel_index_hash(scope: GitScope, index_path: &Path) -> Result<[u8; 32], SourceError> {
    if matches!(scope, GitScope::Committed | GitScope::Tree) {
        return Ok(Sha256::digest([]).into());
    }
    match file_state(index_path) {
        Ok(state) => Ok(state),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Sha256::digest([]).into()),
        Err(error) => Err(io_error(error)),
    }
}

fn sentinel_scope_state(
    root: &Path,
    request: SentinelScopeRequest<'_>,
) -> Result<SentinelScope, SourceError> {
    match request.scope {
        GitScope::Committed | GitScope::Tree => Ok(empty_sentinel_scope()),
        GitScope::Staged | GitScope::StagedAll => staged_sentinel_scope(root, request.base_tree),
        GitScope::Changed if request.explicit_base => {
            comparison_worktree_sentinel_scope(root, request.base_tree, request.candidate)
        }
        GitScope::Changed | GitScope::All => worktree_sentinel_scope(root, request.candidate),
        GitScope::Explicit => {
            let selected = request
                .explicit
                .iter()
                .filter(|path| (request.candidate)(path))
                .cloned()
                .collect::<Vec<_>>();
            explicit_sentinel_scope(root, &selected)
        }
    }
}

fn empty_sentinel_scope() -> SentinelScope {
    SentinelScope {
        state: Vec::new(),
        worktree_paths: BTreeSet::new(),
        worktree_state: None,
    }
}

fn staged_sentinel_scope(root: &Path, head_tree: &str) -> Result<SentinelScope, SourceError> {
    let args: Vec<std::ffi::OsString> = vec![
        "diff".into(),
        "--cached".into(),
        "--raw".into(),
        "-z".into(),
        "--no-ext-diff".into(),
        head_tree.into(),
        "--".into(),
    ];
    Ok(SentinelScope {
        state: git_at(root, args)?,
        ..empty_sentinel_scope()
    })
}

fn worktree_sentinel_scope(
    root: &Path,
    candidate: &dyn Fn(&RepoPath) -> bool,
) -> Result<SentinelScope, SourceError> {
    let status = git_at(
        root,
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--",
        ],
    )?;
    let worktree_paths = paths_from_porcelain_v1(&status, candidate)?;
    let (worktree_state, generation) = current_worktree_state(root, &worktree_paths)?;
    let state = hash_domain("git-worktree-state/v3", &[&worktree_state, &generation]).to_vec();
    Ok(SentinelScope {
        state,
        worktree_paths,
        worktree_state: Some(worktree_state),
    })
}

fn comparison_worktree_sentinel_scope(
    root: &Path,
    base_tree: &str,
    candidate: &dyn Fn(&RepoPath) -> bool,
) -> Result<SentinelScope, SourceError> {
    let mut worktree_paths = paths::changed_paths_filtered(root, base_tree, candidate)?;
    worktree_paths.retain(candidate);
    worktree_paths.extend(special_index_paths(root, candidate)?);
    let (worktree_state, generation) = current_worktree_state(root, &worktree_paths)?;
    let state = hash_domain(
        "git-comparison-worktree-state/v1",
        &[base_tree.as_bytes(), &worktree_state, &generation],
    )
    .to_vec();
    Ok(SentinelScope {
        state,
        worktree_paths,
        worktree_state: Some(worktree_state),
    })
}

fn explicit_sentinel_scope(
    root: &Path,
    explicit: &[RepoPath],
) -> Result<SentinelScope, SourceError> {
    let worktree_paths = explicit.iter().cloned().collect::<BTreeSet<_>>();
    let (worktree_state, generation) = current_worktree_state(root, &worktree_paths)?;
    let state = hash_domain("git-explicit-state/v2", &[&worktree_state, &generation]).to_vec();
    Ok(SentinelScope {
        state,
        worktree_paths,
        worktree_state: Some(worktree_state),
    })
}

fn exact_explicit_sentinel_scope(
    root: &Path,
    explicit: &[RepoPath],
) -> Result<SentinelScope, SourceError> {
    let worktree_paths = explicit.iter().cloned().collect::<BTreeSet<_>>();
    let (worktree_state, generation) = current_exact_worktree_state(root, &worktree_paths)?;
    let state = hash_domain("git-explicit-state/v2", &[&worktree_state, &generation]).to_vec();
    Ok(SentinelScope {
        state,
        worktree_paths,
        worktree_state: Some(worktree_state),
    })
}

#[derive(Default)]
struct SourceBatch {
    files: Vec<SourceFile>,
    total: usize,
}

impl SourceBatch {
    fn push(&mut self, file: SourceFile) -> Result<(), SourceError> {
        self.total = self.total.saturating_add(file.bytes.len());
        if self.total > MAX_TOTAL_SOURCE_BYTES {
            return Err(SourceError::Incomplete(format!(
                "source exceeds {MAX_TOTAL_SOURCE_BYTES} bytes"
            )));
        }
        self.files.push(file);
        Ok(())
    }
}

enum WorktreePath {
    File(SourceFile),
    Missing,
    Ignored,
}

fn read_worktree_path(root: &Path, path: &RepoPath) -> Result<WorktreePath, SourceError> {
    let absolute = root.join(path.to_path_buf());
    match fs::symlink_metadata(&absolute) {
        Ok(_) => Ok(
            source_file(path.clone(), read_regular_no_follow(root, path)?)
                .map_or(WorktreePath::Ignored, WorktreePath::File),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if detect_language(path).is_some() {
                Ok(WorktreePath::Missing)
            } else {
                Ok(WorktreePath::Ignored)
            }
        }
        Err(error) => Err(io_error(error)),
    }
}

fn read_present_worktree_files(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<(SourceBatch, BTreeSet<RepoPath>), SourceError> {
    let mut batch = SourceBatch::default();
    let mut missing = BTreeSet::new();
    for path in paths {
        match read_worktree_path(root, path)? {
            WorktreePath::File(file) => batch.push(file)?,
            WorktreePath::Missing => {
                missing.insert(path.clone());
            }
            WorktreePath::Ignored => {}
        }
    }
    Ok((batch, missing))
}

fn append_sparse_files(
    root: &Path,
    missing: &BTreeSet<RepoPath>,
    batch: &mut SourceBatch,
) -> Result<(), SourceError> {
    let sparse = sparse_paths(root, missing)?;
    let entries = index_entries(root, &sparse)?;
    for file in files_from_git_objects(root, &entries)? {
        batch.push(file)?;
    }
    Ok(())
}

fn sparse_paths(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    if paths.is_empty() {
        return Ok(BTreeSet::new());
    }
    let mut sparse = BTreeSet::new();
    for chunk in paths.iter().collect::<Vec<_>>().chunks(PATH_ARGUMENT_BATCH) {
        let mut command = git_command(root);
        command.args(["ls-files", "-t", "-z", "--"]);
        for path in chunk {
            command.arg(path.to_path_buf());
        }
        let output = bounded_git_output(&mut command)?;
        if !output.status.success() {
            return Err(SourceError::Io(
                String::from_utf8_lossy(&output.stderr).trim().into(),
            ));
        }
        for record in output.stdout.split(|byte| *byte == 0) {
            if record.starts_with(b"S ") {
                let path = RepoPath::new(record[2..].to_vec())
                    .map_err(|error| SourceError::Invalid(error.to_string()))?;
                if paths.contains(&path) {
                    sparse.insert(path);
                }
            }
        }
    }
    Ok(sparse)
}

fn paths_from_porcelain_v1(
    output: &[u8],
    candidate: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            if record.len() < 4 || record[2] != b' ' {
                return Some(Err(SourceError::Invalid(
                    "malformed Git porcelain status record".into(),
                )));
            }
            let raw_path = &record[3..];
            if raw_path.ends_with(b"/") {
                return None;
            }
            Some(
                RepoPath::new(raw_path.to_vec())
                    .map_err(|error| SourceError::Invalid(error.to_string())),
            )
        })
        .filter_map(|path| match path {
            Ok(path) if candidate(&path) => Some(Ok(path)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn source_file(path: RepoPath, bytes: Vec<u8>) -> Option<SourceFile> {
    let (language, mode) = resolve_language(&path, &bytes)?;
    Some(SourceFile::new(
        path,
        Arc::<[u8]>::from(bytes),
        language,
        mode,
    ))
}

fn path_from_output(output: &[u8]) -> Result<PathBuf, SourceError> {
    let bytes = output.strip_suffix(b"\n").unwrap_or(output);
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    if bytes.is_empty() {
        return Err(SourceError::Invalid("Git returned an empty path".into()));
    }
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

fn trim_ascii(output: &[u8]) -> Result<String, SourceError> {
    std::str::from_utf8(output)
        .map(str::trim)
        .map(str::to_owned)
        .map_err(|_| SourceError::Invalid("Git returned non-UTF-8 metadata".into()))
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err adapters must accept the owned io::Error"
)]
fn io_error(error: std::io::Error) -> SourceError {
    SourceError::Io(error.to_string())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod selection_tests;
