use super::*;

pub(super) struct PreparedViews {
    pub(super) before: Arc<SourceSnapshot>,
    pub(super) after: Arc<SourceSnapshot>,
    pub(super) paths: BTreeSet<RepoPath>,
    pub(super) read_ids: Vec<String>,
}

pub(super) struct PreparedNativeViews {
    pub(super) before: BTreeMap<RepoPath, Arc<[u8]>>,
    pub(super) after: BTreeMap<RepoPath, Arc<[u8]>>,
    pub(super) read_ids: Vec<String>,
}

pub(super) enum WorkspaceFailure {
    Rpc(RpcFailure),
    Coverage(WorkspaceGap),
}

pub(super) struct WorkspaceGap {
    pub(super) status: &'static str,
    pub(super) detail: String,
    pub(super) truncated: bool,
}

impl From<RpcFailure> for WorkspaceFailure {
    fn from(failure: RpcFailure) -> Self {
        Self::Rpc(failure)
    }
}

type WorkspaceResult<T> = Result<T, WorkspaceFailure>;

#[derive(Clone)]
struct TreeState {
    entries: BTreeMap<RepoPath, String>,
    kinds: BTreeMap<RepoPath, EntryKind>,
}

struct WorkspaceReader<'a> {
    session: &'a AspSession,
    host: &'a dyn AspHost,
    cancel: &'a CancelToken,
    deadline: RequestDeadline,
}

impl<'a> WorkspaceReader<'a> {
    const fn new(
        session: &'a AspSession,
        host: &'a dyn AspHost,
        cancel: &'a CancelToken,
        deadline: RequestDeadline,
    ) -> Self {
        Self {
            session,
            host,
            cancel,
            deadline,
        }
    }

    async fn list_tree(
        &self,
        scope: &Scope,
        paths: ListingPaths<'_>,
    ) -> Result<ListTreeResult, RpcFailure> {
        let mut list_params = serde_json::Map::new();
        list_params.insert("baseline".into(), self.session.baseline.clone());
        if !matches!(scope, Scope::Workspace) {
            list_params.insert("paths".into(), listing_path_value(paths)?);
        }
        let value = self
            .host
            .request(
                "workspace/listTree",
                Value::Object(list_params),
                self.deadline.remaining_ms()?,
                self.cancel,
            )
            .await?;
        serde_json::from_value(value).map_err(|error| {
            RpcFailure::contract(format!("malformed workspace/listTree result: {error}"))
        })
    }

    async fn read_blobs(
        &self,
        ids: &BTreeSet<String>,
    ) -> Result<BTreeMap<String, Arc<[u8]>>, RpcFailure> {
        let mut blobs = BTreeMap::new();
        let mut total = 0usize;
        for id in ids {
            let blob = self.read_blob(id).await?;
            let bytes = decode_blob(&blob)?;
            total = total.saturating_add(bytes.len());
            if total > MAX_TOTAL_SOURCE_BYTES {
                return Err(RpcFailure::unavailable(
                    "read blobs exceed the total request byte bound",
                ));
            }
            verify_blob(&blob.id, &bytes).map_err(|failure| {
                RpcFailure::contract(format!(
                    "workspace/readBlob returned bytes inconsistent with their id: {}",
                    failure.detail
                ))
            })?;
            blobs.insert(blob.id, Arc::<[u8]>::from(bytes));
        }
        Ok(blobs)
    }

    async fn read_blob(&self, id: &str) -> Result<BlobResult, RpcFailure> {
        let value = self
            .host
            .request(
                "workspace/readBlob",
                json!({ "blobs": [id] }),
                self.deadline.remaining_ms()?,
                self.cancel,
            )
            .await?;
        let mut result: ReadBlobResult = serde_json::from_value(value).map_err(|error| {
            RpcFailure::contract(format!("malformed workspace/readBlob result: {error}"))
        })?;
        if result.blobs.len() != 1 {
            return Err(RpcFailure::contract(format!(
                "workspace/readBlob did not return exactly one result for {id}"
            )));
        }
        let blob = result
            .blobs
            .pop()
            .ok_or_else(|| RpcFailure::contract(format!("workspace/readBlob omitted {id}")))?;
        if blob.id != id {
            return Err(RpcFailure::contract(format!(
                "workspace/readBlob returned {} while requesting {id}",
                blob.id
            )));
        }
        Ok(blob)
    }
}

pub(super) async fn prepare_views(
    params: &NormalizedParams,
    session: &AspSession,
    host: &dyn AspHost,
    cancel: &CancelToken,
    deadline: RequestDeadline,
) -> WorkspaceResult<PreparedViews> {
    let reader = WorkspaceReader::new(session, host, cancel, deadline);
    let affected = affected_source_paths(&params.changeset);
    let requested_paths = requested_paths(&params.scope, &affected);
    let preconditions =
        scoped_change_precondition_paths(&params.changeset, &params.scope, &requested_paths);
    let listing_paths = ListingPaths {
        preconditions: &preconditions,
        requested: &requested_paths,
    };
    let listing = reader.list_tree(&params.scope, listing_paths).await?;
    require_complete_listing(&listing)?;
    let baseline = tree_from_listing(listing, &params.scope, &preconditions, &requested_paths)?;
    validate_change_preconditions(
        &params.changeset,
        &params.scope,
        &requested_paths,
        &baseline.entries,
    )?;
    let after = apply_changes(&baseline, &params.changeset)?;
    let paths = assessment_paths(&params.scope, &requested_paths, &baseline, &after);
    reject_source_symlinks(&paths, &baseline, &after)?;
    let read_ids = required_blob_ids(&paths, &baseline, &after);
    let blobs = reader.read_blobs(&read_ids).await?;
    let before_files = materialize_files(&paths, &baseline.entries, &baseline.kinds, &blobs)?;
    let after_files = materialize_files(&paths, &after.entries, &after.kinds, &blobs)?;
    Ok(PreparedViews {
        before: Arc::new(SourceSnapshot::new(before_files)),
        after: Arc::new(SourceSnapshot::new(after_files)),
        paths,
        read_ids: read_ids.into_iter().collect(),
    })
}

pub(super) async fn prepare_native_views(
    params: &NormalizedParams,
    session: &AspSession,
    host: &dyn AspHost,
    cancel: &CancelToken,
    deadline: RequestDeadline,
) -> WorkspaceResult<PreparedNativeViews> {
    let reader = WorkspaceReader::new(session, host, cancel, deadline);
    let empty = BTreeSet::new();
    let listing = reader
        .list_tree(
            &Scope::Workspace,
            ListingPaths {
                preconditions: &empty,
                requested: &empty,
            },
        )
        .await?;
    require_complete_listing(&listing)?;
    let (baseline, after) = validated_native_trees(params, listing, &empty)?;
    reject_native_symlinks(&baseline, &after)?;
    let read_ids = native_blob_ids(&baseline, &after)?;
    let blobs = reader.read_blobs(&read_ids).await?;
    Ok(PreparedNativeViews {
        before: native_files(&baseline, &blobs)?,
        after: native_files(&after, &blobs)?,
        read_ids: read_ids.into_iter().collect(),
    })
}

fn require_complete_listing(listing: &ListTreeResult) -> WorkspaceResult<()> {
    if listing.truncated {
        return Err(WorkspaceFailure::Coverage(WorkspaceGap {
            status: "incomplete",
            detail: "workspace/listTree truncated required coverage".into(),
            truncated: true,
        }));
    }
    Ok(())
}

fn reject_source_symlinks(
    paths: &BTreeSet<RepoPath>,
    before: &TreeState,
    after: &TreeState,
) -> WorkspaceResult<()> {
    let unsupported = paths.iter().find(|path| {
        before.kinds.get(*path) == Some(&EntryKind::Symlink)
            || after.kinds.get(*path) == Some(&EntryKind::Symlink)
    });
    if let Some(path) = unsupported {
        return Err(WorkspaceFailure::Coverage(WorkspaceGap {
            status: "unsupported",
            detail: format!("source symlink {path} is outside fast Check coverage"),
            truncated: false,
        }));
    }
    Ok(())
}

fn reject_native_symlinks(before: &TreeState, after: &TreeState) -> WorkspaceResult<()> {
    let unsupported = before
        .kinds
        .iter()
        .chain(&after.kinds)
        .find(|(_, kind)| **kind == EntryKind::Symlink);
    if let Some((path, _)) = unsupported {
        return Err(WorkspaceFailure::Coverage(WorkspaceGap {
            status: "unsupported",
            detail: format!("workspace symlink {path} is outside native callback coverage"),
            truncated: false,
        }));
    }
    Ok(())
}

fn validated_native_trees(
    params: &NormalizedParams,
    listing: ListTreeResult,
    empty: &BTreeSet<RepoPath>,
) -> Result<(TreeState, TreeState), RpcFailure> {
    let baseline = tree_from_listing(listing, &Scope::Workspace, empty, empty)?;
    validate_all_change_preconditions(&params.changeset, &baseline.entries)?;
    let after = apply_changes(&baseline, &params.changeset)?;
    validate_native_tree(&baseline)?;
    validate_native_tree(&after)?;
    Ok((baseline, after))
}

fn listing_path_value(paths: ListingPaths<'_>) -> Result<Value, RpcFailure> {
    let mut metadata_paths = paths.requested.clone();
    metadata_paths.extend(paths.preconditions.iter().cloned());
    serde_json::to_value(metadata_paths)
        .map_err(|error| RpcFailure::input(format!("cannot serialize requested paths: {error}")))
}

#[derive(Clone, Copy)]
struct ListingPaths<'a> {
    preconditions: &'a BTreeSet<RepoPath>,
    requested: &'a BTreeSet<RepoPath>,
}

fn validate_native_tree(tree: &TreeState) -> Result<(), RpcFailure> {
    if tree.entries.len() > MAX_FILES {
        return Err(RpcFailure::unavailable(format!(
            "native workspace exceeds {MAX_FILES} materialized files"
        )));
    }
    Ok(())
}

fn validate_all_change_preconditions(
    changeset: &ChangeSet,
    baseline: &BTreeMap<RepoPath, String>,
) -> Result<(), RpcFailure> {
    for change in &changeset.changes {
        validate_change_precondition(change, baseline)?;
    }
    Ok(())
}

fn native_blob_ids(before: &TreeState, after: &TreeState) -> Result<BTreeSet<String>, RpcFailure> {
    let mut ids = BTreeSet::new();
    collect_native_blob_ids(before, &mut ids)?;
    collect_native_blob_ids(after, &mut ids)?;
    Ok(ids)
}

fn collect_native_blob_ids(tree: &TreeState, ids: &mut BTreeSet<String>) -> Result<(), RpcFailure> {
    for (path, id) in &tree.entries {
        match tree.kinds.get(path) {
            Some(EntryKind::File) => {
                ids.insert(id.clone());
            }
            Some(EntryKind::Dir) => {}
            Some(EntryKind::Symlink) | None => {
                return Err(RpcFailure::unavailable(format!(
                    "native workspace entry {path} has an invalid file kind"
                )));
            }
        }
    }
    Ok(())
}

fn native_files(
    tree: &TreeState,
    blobs: &BTreeMap<String, Arc<[u8]>>,
) -> Result<BTreeMap<RepoPath, Arc<[u8]>>, RpcFailure> {
    let mut total = 0usize;
    let mut files = BTreeMap::new();
    for (path, id) in &tree.entries {
        if tree.kinds.get(path) == Some(&EntryKind::Dir) {
            continue;
        }
        let bytes = blobs.get(id).cloned().ok_or_else(|| {
            RpcFailure::unavailable(format!("missing materialized blob {id} for {path}"))
        })?;
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| RpcFailure::unavailable("native materialized byte count overflowed"))?;
        if total > MAX_TOTAL_SOURCE_BYTES {
            return Err(RpcFailure::unavailable(format!(
                "native workspace exceeds {MAX_TOTAL_SOURCE_BYTES} materialized bytes"
            )));
        }
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}

fn affected_source_paths(changeset: &ChangeSet) -> BTreeSet<RepoPath> {
    all_change_paths(changeset)
        .into_iter()
        .filter(is_source_candidate)
        .collect()
}

fn scoped_change_precondition_paths(
    changeset: &ChangeSet,
    scope: &Scope,
    requested: &BTreeSet<RepoPath>,
) -> BTreeSet<RepoPath> {
    let mut paths = BTreeSet::new();
    for change in &changeset.changes {
        if !change_is_in_scope(change, scope, requested) {
            continue;
        }
        paths.insert(change.path.clone());
        paths.extend(change.from.iter().cloned());
    }
    paths
}

fn change_is_source_relevant(change: &Change) -> bool {
    is_source_candidate(&change.path) || change.from.as_ref().is_some_and(is_source_candidate)
}

fn change_is_in_scope(change: &Change, scope: &Scope, requested: &BTreeSet<RepoPath>) -> bool {
    match scope {
        Scope::Paths { .. } => {
            requested.contains(&change.path)
                || change
                    .from
                    .as_ref()
                    .is_some_and(|path| requested.contains(path))
        }
        Scope::Changeset | Scope::Workspace => change_is_source_relevant(change),
    }
}

fn requested_paths(scope: &Scope, affected: &BTreeSet<RepoPath>) -> BTreeSet<RepoPath> {
    match scope {
        Scope::Changeset => affected.clone(),
        Scope::Paths { paths } => paths.iter().cloned().collect(),
        Scope::Workspace => BTreeSet::new(),
    }
}

fn tree_from_listing(
    listing: ListTreeResult,
    scope: &Scope,
    preconditions: &BTreeSet<RepoPath>,
    requested: &BTreeSet<RepoPath>,
) -> Result<TreeState, RpcFailure> {
    if listing.entries.len() > MAX_FILES {
        return Err(RpcFailure::unavailable(format!(
            "workspace listing exceeds {MAX_FILES} entries"
        )));
    }
    let allowed = allowed_listing_paths(scope, preconditions, requested);
    let mut tree = TreeState {
        entries: BTreeMap::new(),
        kinds: BTreeMap::new(),
    };
    for entry in listing.entries {
        if allowed
            .as_ref()
            .is_some_and(|allowed| !allowed.contains(&entry.path))
        {
            return Err(RpcFailure::contract(format!(
                "workspace/listTree returned unrequested path {}",
                entry.path
            )));
        }
        validate_blob_ref(&entry.blob_id).map_err(|failure| {
            RpcFailure::contract(format!(
                "workspace/listTree returned an invalid blob ref: {}",
                failure.detail
            ))
        })?;
        if tree
            .entries
            .insert(entry.path.clone(), entry.blob_id)
            .is_some()
        {
            return Err(RpcFailure::contract(format!(
                "workspace/listTree returned duplicate path {}",
                entry.path
            )));
        }
        tree.kinds.insert(entry.path, entry.kind);
    }
    Ok(tree)
}

fn allowed_listing_paths(
    scope: &Scope,
    preconditions: &BTreeSet<RepoPath>,
    requested: &BTreeSet<RepoPath>,
) -> Option<BTreeSet<RepoPath>> {
    if matches!(scope, Scope::Workspace) {
        return None;
    }
    let mut paths = requested.clone();
    paths.extend(preconditions.iter().cloned());
    Some(paths)
}

fn apply_changes(baseline: &TreeState, changeset: &ChangeSet) -> Result<TreeState, RpcFailure> {
    let mut after = baseline.clone();
    for change in &changeset.changes {
        apply_change(&mut after, change)?;
    }
    Ok(after)
}

fn apply_change(tree: &mut TreeState, change: &Change) -> Result<(), RpcFailure> {
    match change.kind {
        ChangeKind::Create | ChangeKind::Modify => {
            let Some(after) = change.after.clone() else {
                return Err(illegal_change(change));
            };
            tree.entries.insert(change.path.clone(), after);
            tree.kinds.insert(change.path.clone(), EntryKind::File);
        }
        ChangeKind::Delete => remove_tree_path(tree, &change.path),
        ChangeKind::Rename => apply_rename(tree, change)?,
    }
    Ok(())
}

fn remove_tree_path(tree: &mut TreeState, path: &RepoPath) {
    tree.entries.remove(path);
    tree.kinds.remove(path);
}

fn apply_rename(tree: &mut TreeState, change: &Change) -> Result<(), RpcFailure> {
    let Some(from) = change.from.as_ref() else {
        return Err(illegal_change(change));
    };
    remove_tree_path(tree, from);
    let Some(blob) = change.after.clone().or_else(|| change.before.clone()) else {
        return Err(illegal_change(change));
    };
    tree.entries.insert(change.path.clone(), blob);
    tree.kinds.insert(change.path.clone(), EntryKind::File);
    Ok(())
}

fn assessment_paths(
    scope: &Scope,
    requested: &BTreeSet<RepoPath>,
    baseline: &TreeState,
    after: &TreeState,
) -> BTreeSet<RepoPath> {
    if matches!(scope, Scope::Workspace) {
        let mut paths: BTreeSet<_> = baseline.entries.keys().cloned().collect();
        paths.extend(after.entries.keys().cloned());
        paths.retain(|path| {
            is_source_candidate(path)
                && (matches!(
                    baseline.kinds.get(path),
                    Some(EntryKind::File | EntryKind::Symlink)
                ) || matches!(
                    after.kinds.get(path),
                    Some(EntryKind::File | EntryKind::Symlink)
                ))
        });
        paths
    } else {
        requested.clone()
    }
}

fn required_blob_ids(
    paths: &BTreeSet<RepoPath>,
    baseline: &TreeState,
    after: &TreeState,
) -> BTreeSet<String> {
    let mut read_ids = BTreeSet::new();
    for path in paths {
        if detect_language(path).is_none() {
            continue;
        }
        insert_blob_id(&mut read_ids, path, baseline);
        insert_blob_id(&mut read_ids, path, after);
    }
    read_ids
}

fn insert_blob_id(ids: &mut BTreeSet<String>, path: &RepoPath, tree: &TreeState) {
    if tree.kinds.get(path) == Some(&EntryKind::File)
        && let Some(id) = tree.entries.get(path)
    {
        ids.insert(id.clone());
    }
}

fn all_change_paths(changeset: &ChangeSet) -> BTreeSet<RepoPath> {
    let mut paths = BTreeSet::new();
    for change in &changeset.changes {
        paths.insert(change.path.clone());
        if let Some(from) = &change.from {
            paths.insert(from.clone());
        }
    }
    paths
}

fn validate_change_preconditions(
    changeset: &ChangeSet,
    scope: &Scope,
    requested: &BTreeSet<RepoPath>,
    baseline: &BTreeMap<RepoPath, String>,
) -> Result<(), RpcFailure> {
    for change in &changeset.changes {
        if !change_is_in_scope(change, scope, requested) {
            continue;
        }
        validate_change_precondition(change, baseline)?;
    }
    Ok(())
}

fn validate_change_precondition(
    change: &Change,
    baseline: &BTreeMap<RepoPath, String>,
) -> Result<(), RpcFailure> {
    match change.kind {
        ChangeKind::Create => require_absent(baseline, &change.path, "create destination"),
        ChangeKind::Modify | ChangeKind::Delete => require_before(
            baseline,
            &change.path,
            change.before.as_ref(),
            "before blob",
        ),
        ChangeKind::Rename => validate_rename_precondition(change, baseline),
    }
}

fn validate_rename_precondition(
    change: &Change,
    baseline: &BTreeMap<RepoPath, String>,
) -> Result<(), RpcFailure> {
    let Some(from) = change.from.as_ref() else {
        return Err(illegal_change(change));
    };
    require_before(baseline, from, change.before.as_ref(), "rename before blob")?;
    require_absent(baseline, &change.path, "rename destination")
}

fn require_before(
    baseline: &BTreeMap<RepoPath, String>,
    path: &RepoPath,
    expected: Option<&String>,
    label: &str,
) -> Result<(), RpcFailure> {
    if baseline.get(path) != expected {
        return Err(RpcFailure::health(format!(
            "{label} does not match baseline for {path}"
        )));
    }
    Ok(())
}

fn require_absent(
    baseline: &BTreeMap<RepoPath, String>,
    path: &RepoPath,
    label: &str,
) -> Result<(), RpcFailure> {
    if baseline.contains_key(path) {
        return Err(RpcFailure::input(format!("{label} already exists: {path}")));
    }
    Ok(())
}

fn decode_blob(blob: &BlobResult) -> Result<Vec<u8>, RpcFailure> {
    let bytes = match blob.encoding {
        BlobEncoding::Utf8 => blob.bytes.as_bytes().to_vec(),
        BlobEncoding::Base64 => base64::engine::general_purpose::STANDARD
            .decode(&blob.bytes)
            .map_err(|error| {
                RpcFailure::contract(format!("invalid base64 blob {}: {error}", blob.id))
            })?,
    };
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(RpcFailure::unavailable(format!(
            "blob {} exceeds {MAX_SOURCE_BYTES} bytes",
            blob.id
        )));
    }
    Ok(bytes)
}

fn materialize_files(
    paths: &BTreeSet<RepoPath>,
    entries: &BTreeMap<RepoPath, String>,
    kinds: &BTreeMap<RepoPath, EntryKind>,
    blobs: &BTreeMap<String, Arc<[u8]>>,
) -> Result<Vec<SourceFile>, RpcFailure> {
    let mut files = Vec::new();
    for path in paths {
        if detect_language(path).is_none() {
            continue;
        }
        let Some(id) = entries.get(path) else {
            continue;
        };
        if kinds.get(path) != Some(&EntryKind::File) {
            continue;
        }
        let bytes = blobs
            .get(id)
            .ok_or_else(|| RpcFailure::unavailable(format!("missing materialized blob {id}")))?;
        let Some((language, mode)) = resolve_language(path, bytes) else {
            continue;
        };
        files.push(SourceFile::new(
            path.clone(),
            Arc::clone(bytes),
            language,
            mode,
        ));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_materialized_bytes_are_charged_per_path() {
        let bytes = Arc::<[u8]>::from(vec![0_u8; MAX_SOURCE_BYTES]);
        let mut tree = TreeState {
            entries: BTreeMap::new(),
            kinds: BTreeMap::new(),
        };
        for index in 0..=(MAX_TOTAL_SOURCE_BYTES / MAX_SOURCE_BYTES) {
            let path = RepoPath::from_protocol(&format!("data/{index}.bin")).unwrap();
            tree.entries.insert(path.clone(), "blob:shared".into());
            tree.kinds.insert(path, EntryKind::File);
        }
        let blobs = BTreeMap::from([("blob:shared".into(), bytes)]);

        assert!(native_files(&tree, &blobs).is_err());
    }
}
