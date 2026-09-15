use super::{
    BTreeMap, BTreeSet, ContentId, MAX_SOURCE_BYTES, MAX_TOTAL_AUXILIARY_BYTES,
    MAX_TOTAL_SOURCE_BYTES, MetadataExt, OpenOptions, OpenOptionsExt, Path, Read, RepoPath,
    SourceError, SourceFile, add_bounded_blob_length, detect_language, fs,
    git_blobs_from_objects_bounded, hash_domain, index_entries, io_error, sparse_paths,
};

pub(super) fn current_worktree_state(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<([u8; 32], [u8; 32]), SourceError> {
    current_worktree_state_with(root, paths, MAX_TOTAL_SOURCE_BYTES, |path| {
        detect_language(path).is_some()
    })
}

pub(super) fn current_exact_worktree_state(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<([u8; 32], [u8; 32]), SourceError> {
    current_worktree_state_with(root, paths, MAX_TOTAL_AUXILIARY_BYTES, |_| true)
}

pub(super) fn current_native_worktree_state(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<([u8; 32], [u8; 32]), SourceError> {
    current_worktree_state_with(root, paths, MAX_TOTAL_SOURCE_BYTES, |_| true)
}

pub(super) fn read_optional_worktree_blob(
    root: &Path,
    path: &RepoPath,
) -> Result<Option<Vec<u8>>, SourceError> {
    match fs::symlink_metadata(root.join(path.to_path_buf())) {
        Ok(_) => read_regular_no_follow(root, path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

fn current_worktree_state_with(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
    total_limit: usize,
    include: fn(&RepoPath) -> bool,
) -> Result<([u8; 32], [u8; 32]), SourceError> {
    let mut manifest = collect_worktree_manifest(root, paths, total_limit, include)?;
    let remaining = total_limit.saturating_sub(manifest.total_bytes);
    merge_sparse_contents(root, &manifest.missing, &mut manifest.contents, remaining)?;
    Ok((
        worktree_state(paths, &manifest.contents, include),
        generation_state(manifest.generations),
    ))
}

#[derive(Default)]
struct WorktreeManifest {
    contents: BTreeMap<RepoPath, ContentId>,
    generations: BTreeMap<RepoPath, [u8; 56]>,
    missing: BTreeSet<RepoPath>,
    total_bytes: usize,
}

fn collect_worktree_manifest(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
    total_limit: usize,
    include: fn(&RepoPath) -> bool,
) -> Result<WorktreeManifest, SourceError> {
    let mut manifest = WorktreeManifest::default();
    for path in paths {
        if !include(path) {
            continue;
        }
        scan_worktree_manifest_path(root, path, &mut manifest, total_limit)?;
    }
    Ok(manifest)
}

fn scan_worktree_manifest_path(
    root: &Path,
    path: &RepoPath,
    manifest: &mut WorktreeManifest,
    total_limit: usize,
) -> Result<(), SourceError> {
    let absolute = root.join(path.to_path_buf());
    match fs::symlink_metadata(&absolute) {
        Ok(_) => {
            let bytes = read_regular_no_follow(root, path)?;
            add_bounded_blob_length(&mut manifest.total_bytes, bytes.len(), path, total_limit)?;
            manifest
                .contents
                .insert(path.clone(), ContentId::of(&bytes));
            let metadata = fs::metadata(&absolute).map_err(io_error)?;
            manifest
                .generations
                .insert(path.clone(), metadata_state(&metadata));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            manifest.missing.insert(path.clone());
            manifest.generations.insert(path.clone(), [0; 56]);
        }
        Err(error) => return Err(io_error(error)),
    }
    Ok(())
}

fn merge_sparse_contents(
    root: &Path,
    missing: &BTreeSet<RepoPath>,
    contents: &mut BTreeMap<RepoPath, ContentId>,
    total_limit: usize,
) -> Result<(), SourceError> {
    let sparse = sparse_paths(root, missing)?;
    let entries = index_entries(root, &sparse)?;
    let selected = entries.iter().collect::<Vec<_>>();
    for blob in git_blobs_from_objects_bounded(root, selected, total_limit)? {
        contents.insert(blob.path, ContentId::of(&blob.bytes));
    }
    Ok(())
}

pub(super) fn generation_state(generations: BTreeMap<RepoPath, [u8; 56]>) -> [u8; 32] {
    let mut generation_manifest = Vec::new();
    for (path, state) in generations {
        generation_manifest.extend_from_slice(&(path.as_bytes().len() as u64).to_be_bytes());
        generation_manifest.extend_from_slice(path.as_bytes());
        generation_manifest.extend_from_slice(&state);
    }
    hash_domain("git-worktree-generation/v1", &[&generation_manifest])
}

pub(super) fn captured_worktree_state(
    paths: &BTreeSet<RepoPath>,
    files: &[SourceFile],
) -> [u8; 32] {
    let contents = files
        .iter()
        .map(|file| (file.path.clone(), file.content_id))
        .collect();
    worktree_state(paths, &contents, |path| detect_language(path).is_some())
}

pub(super) fn worktree_state(
    paths: &BTreeSet<RepoPath>,
    contents: &BTreeMap<RepoPath, ContentId>,
    include: fn(&RepoPath) -> bool,
) -> [u8; 32] {
    let mut manifest = Vec::new();
    for path in paths {
        manifest.extend_from_slice(&(path.as_bytes().len() as u64).to_be_bytes());
        manifest.extend_from_slice(path.as_bytes());
        if !include(path) {
            manifest.push(0);
        } else if let Some(content) = contents.get(path) {
            manifest.push(1);
            manifest.extend_from_slice(content.as_bytes());
        } else {
            manifest.push(2);
        }
    }
    hash_domain("git-worktree-content/v1", &[&manifest])
}

pub(super) fn file_state(path: &Path) -> std::io::Result<[u8; 32]> {
    let bytes = fs::read(path)?;
    let metadata = fs::metadata(path)?;
    Ok(hash_domain(
        "git-file-state/v1",
        &[&bytes, &metadata_state(&metadata)],
    ))
}

pub(super) fn metadata_state(metadata: &fs::Metadata) -> [u8; 56] {
    let mut state = [0; 56];
    state[0..8].copy_from_slice(&metadata.dev().to_be_bytes());
    state[8..16].copy_from_slice(&metadata.ino().to_be_bytes());
    state[16..24].copy_from_slice(&metadata.len().to_be_bytes());
    state[24..32].copy_from_slice(&metadata.mtime().to_be_bytes());
    state[32..40].copy_from_slice(&metadata.mtime_nsec().to_be_bytes());
    state[40..48].copy_from_slice(&metadata.ctime().to_be_bytes());
    state[48..56].copy_from_slice(&metadata.ctime_nsec().to_be_bytes());
    state
}

pub(super) fn read_regular_no_follow(root: &Path, path: &RepoPath) -> Result<Vec<u8>, SourceError> {
    let relative = path.to_path_buf();
    validate_parent_components(root, &relative, path)?;
    let absolute = root.join(relative);
    let before = fs::symlink_metadata(&absolute).map_err(io_error)?;
    validate_regular_metadata(&before, path)?;
    let file = open_no_follow(&absolute)?;
    let opened = file.metadata().map_err(io_error)?;
    ensure_same_file(&before, &opened, path)?;
    let bytes = read_bounded_file(file, &opened, path)?;
    let after = fs::metadata(&absolute).map_err(io_error)?;
    ensure_read_stable(&opened, &after, path)?;
    Ok(bytes)
}

fn validate_parent_components(
    root: &Path,
    relative: &Path,
    path: &RepoPath,
) -> Result<(), SourceError> {
    let mut parent = root.to_path_buf();
    if let Some(components) = relative.parent() {
        for component in components.components() {
            parent.push(component);
            let metadata = fs::symlink_metadata(&parent).map_err(io_error)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(SourceError::Denied(format!(
                    "symlinked or non-directory parent for {path}"
                )));
            }
        }
    }
    Ok(())
}

fn validate_regular_metadata(metadata: &fs::Metadata, path: &RepoPath) -> Result<(), SourceError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SourceError::Denied(format!("{path} is not a regular file")));
    }
    if metadata.len() > MAX_SOURCE_BYTES as u64 {
        return Err(SourceError::Incomplete(format!(
            "{path} exceeds {MAX_SOURCE_BYTES} bytes"
        )));
    }
    Ok(())
}

fn open_no_follow(path: &Path) -> Result<fs::File, SourceError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(io_error)
}

fn ensure_same_file(
    before: &fs::Metadata,
    opened: &fs::Metadata,
    path: &RepoPath,
) -> Result<(), SourceError> {
    if (before.dev(), before.ino()) != (opened.dev(), opened.ino()) {
        return Err(SourceError::Changed(format!("{path} changed before open")));
    }
    Ok(())
}

fn read_bounded_file(
    file: fs::File,
    metadata: &fs::Metadata,
    path: &RepoPath,
) -> Result<Vec<u8>, SourceError> {
    let capacity = usize::try_from(metadata.len()).map_err(|_| {
        SourceError::Incomplete(format!("{path} size is not representable on this platform"))
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take((MAX_SOURCE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(SourceError::Incomplete(format!(
            "{path} exceeds {MAX_SOURCE_BYTES} bytes"
        )));
    }
    Ok(bytes)
}

fn ensure_read_stable(
    opened: &fs::Metadata,
    after: &fs::Metadata,
    path: &RepoPath,
) -> Result<(), SourceError> {
    if read_state(opened) != read_state(after) {
        return Err(SourceError::Changed(format!("{path} changed while read")));
    }
    Ok(())
}

fn read_state(metadata: &fs::Metadata) -> (u64, u64, u64, i64, i64) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
    )
}
