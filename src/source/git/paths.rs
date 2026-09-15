use std::{collections::BTreeSet, ffi::OsString, fs, path::Path};

use super::{GitScope, RepoPath, Sentinel, SourceError, git_at, io_error};

pub(super) fn raw_scope_paths(
    root: &Path,
    scope: GitScope,
    explicit: &[RepoPath],
    sentinel: &Sentinel,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    if scope == GitScope::Tree {
        return tree_scope_paths(root, sentinel, selected);
    }
    match scope {
        GitScope::Committed => committed_paths(
            root,
            sentinel.target_tree.as_ref().unwrap_or(&sentinel.base_tree),
            selected,
        ),
        GitScope::Explicit => Ok(explicit
            .iter()
            .filter(|path| selected(path))
            .cloned()
            .collect()),
        GitScope::Staged => staged_paths_filtered(root, &sentinel.base_tree, selected),
        GitScope::StagedAll => super::objects::names_from_git_filtered(
            root,
            ["ls-files", "--cached", "-z", "--"],
            selected,
        ),
        GitScope::Changed => changed_paths_filtered(root, &sentinel.base_tree, selected),
        GitScope::All => all_paths_filtered(root, selected),
        GitScope::Tree => tree_scope_paths(root, sentinel, selected),
    }
}

fn tree_scope_paths(
    root: &Path,
    sentinel: &Sentinel,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let target = sentinel
        .target_tree
        .as_deref()
        .ok_or_else(|| SourceError::Invalid("tree sentinel has no target".into()))?;
    if sentinel.compare_tree {
        tree_changed_paths_filtered(root, &sentinel.base_tree, target, selected)
    } else {
        committed_paths(root, target, selected)
    }
}

pub(super) fn committed_paths(
    root: &Path,
    head_tree: &str,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    super::objects::names_from_git_filtered(
        root,
        ["ls-tree", "-rz", "--name-only", "-r", head_tree],
        selected,
    )
}

pub(super) fn staged_paths_filtered(
    root: &Path,
    head_tree: &str,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    diff_paths(root, head_tree, DiffTarget::Index, selected)
}

pub(super) fn changed_paths_filtered(
    root: &Path,
    head_tree: &str,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let mut paths = diff_paths(root, head_tree, DiffTarget::Worktree, selected)?;
    paths.extend(untracked_paths(root, selected)?);
    Ok(paths)
}

fn tree_changed_paths_filtered(
    root: &Path,
    before_tree: &str,
    after_tree: &str,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    diff_paths(root, before_tree, DiffTarget::Tree(after_tree), selected)
}

#[derive(Clone, Copy)]
enum DiffTarget<'a> {
    Worktree,
    Index,
    Tree(&'a str),
}

fn diff_paths(
    root: &Path,
    before: &str,
    target: DiffTarget<'_>,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let mut args: Vec<OsString> = [
        "diff",
        "--name-only",
        "-z",
        "--diff-filter=ACDMRTUXB",
        "--no-ext-diff",
        "--no-renames",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    if matches!(target, DiffTarget::Index) {
        args.push("--cached".into());
    }
    args.push(before.into());
    if let DiffTarget::Tree(tree) = target {
        args.push(tree.into());
    }
    args.push("--".into());
    super::objects::names_from_git_filtered(root, args, selected)
}

pub(super) fn all_paths_filtered(
    root: &Path,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let mut paths = super::objects::names_from_git_filtered(
        root,
        ["ls-files", "--cached", "-z", "--"],
        selected,
    )?;
    paths.extend(untracked_paths(root, selected)?);
    Ok(paths)
}

pub(super) fn special_index_paths(
    root: &Path,
    candidate: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let output = git_at(root, ["ls-files", "-v", "-z", "--"])?;
    output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| flagged_index_path(record, candidate))
        .collect()
}

fn flagged_index_path(
    record: &[u8],
    candidate: &dyn Fn(&RepoPath) -> bool,
) -> Option<Result<RepoPath, SourceError>> {
    if record.len() < 3 || record[1] != b' ' {
        return Some(Err(SourceError::Invalid(
            "malformed Git index flag record".into(),
        )));
    }
    if record[0] != b'S' && !record[0].is_ascii_lowercase() {
        return None;
    }
    let path = RepoPath::new(record[2..].to_vec())
        .map_err(|error| SourceError::Invalid(error.to_string()));
    match path {
        Ok(path) if candidate(&path) => Some(Ok(path)),
        Ok(_) => None,
        Err(error) => Some(Err(error)),
    }
}

fn untracked_paths(
    root: &Path,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let output = git_at(
        root,
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    )?;
    let mut paths = BTreeSet::new();
    for raw in nul_records(&output) {
        if raw.ends_with(b"/") {
            continue;
        }
        let path = parse_path(raw)?;
        if selected(&path) {
            insert_native_path(&mut paths, path, "Git source paths")?;
        }
    }
    Ok(paths)
}

pub(super) fn native_tree_paths(
    root: &Path,
    tree: &str,
    roots: &[RepoPath],
    filter: super::NativeCaptureFilter,
    targets: &crate::policy::TargetPolicy,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let output = git_at(root, ["ls-tree", "-rz", "--full-tree", "-r", tree])?;
    filtered_native_paths(&output, roots, filter, targets, parse_native_tree_path)
}

pub(super) fn native_index_paths(
    root: &Path,
    roots: &[RepoPath],
    filter: super::NativeCaptureFilter,
    targets: &crate::policy::TargetPolicy,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let output = git_at(root, ["ls-files", "--stage", "-z", "--"])?;
    filtered_native_paths(&output, roots, filter, targets, parse_native_index_path)
}

fn filtered_native_paths(
    output: &[u8],
    roots: &[RepoPath],
    filter: super::NativeCaptureFilter,
    targets: &crate::policy::TargetPolicy,
    parse: fn(&[u8]) -> Result<Option<RepoPath>, SourceError>,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let selection = NativeSelection {
        roots,
        filter,
        targets,
    };
    let mut paths = BTreeSet::new();
    for record in nul_records(output) {
        if let Some(path) = parse(record)? {
            selection.insert(&mut paths, path)?;
        }
    }
    Ok(paths)
}

pub(super) fn native_worktree_paths(
    root: &Path,
    roots: &[RepoPath],
    filter: super::NativeCaptureFilter,
    targets: &crate::policy::TargetPolicy,
) -> Result<BTreeSet<RepoPath>, SourceError> {
    let mut paths = native_index_paths(root, roots, filter, targets)?;
    let output = git_at(
        root,
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    )?;
    let selection = NativeSelection {
        roots,
        filter,
        targets,
    };
    for raw in nul_records(&output) {
        if let Some(path) = native_untracked_path(root, raw)? {
            selection.insert(&mut paths, path)?;
        }
    }
    Ok(paths)
}

struct NativeSelection<'a> {
    roots: &'a [RepoPath],
    filter: super::NativeCaptureFilter,
    targets: &'a crate::policy::TargetPolicy,
}

impl NativeSelection<'_> {
    fn insert(&self, paths: &mut BTreeSet<RepoPath>, path: RepoPath) -> Result<(), SourceError> {
        let allowed = !self.filter.is_fast_only() || self.targets.includes(&path);
        if allowed
            && self.filter.includes(&path)
            && native_path_in_roots(&path, self.roots, self.filter)
        {
            insert_native_path(paths, path, "native workspace")?;
        }
        Ok(())
    }
}

fn native_path_in_roots(
    path: &RepoPath,
    roots: &[RepoPath],
    filter: super::NativeCaptureFilter,
) -> bool {
    roots.is_empty()
        || roots.iter().any(|root| {
            path.as_bytes()
                .strip_prefix(root.as_bytes())
                .is_some_and(|suffix| suffix.starts_with(b"/"))
                || (filter.includes_as_ancestor_context(path)
                    && path_parent(path).is_some_and(|parent| {
                        parent.is_empty()
                            || root
                                .as_bytes()
                                .strip_prefix(parent)
                                .is_some_and(|suffix| suffix.starts_with(b"/"))
                    }))
        })
}

fn path_parent(path: &RepoPath) -> Option<&[u8]> {
    path.as_bytes()
        .iter()
        .rposition(|byte| *byte == b'/')
        .map_or(Some(&[]), |index| path.as_bytes().get(..index))
}

fn parse_native_tree_path(record: &[u8]) -> Result<Option<RepoPath>, SourceError> {
    let (header, raw_path) = split_record(record, "malformed native tree path record")?;
    let mut fields = ascii_fields(header, "non-ASCII native tree header")?;
    let mode = next_field(&mut fields, "native tree mode")?;
    let kind = next_field(&mut fields, "native tree kind")?;
    let _object = next_field(&mut fields, "native tree object")?;
    reject_extra_fields(fields, "native tree header")?;
    (kind == "blob" && is_regular_mode(mode))
        .then(|| parse_path(raw_path))
        .transpose()
}

fn parse_native_index_path(record: &[u8]) -> Result<Option<RepoPath>, SourceError> {
    let (header, raw_path) = split_record(record, "malformed native index path record")?;
    let mut fields = ascii_fields(header, "non-ASCII native index header")?;
    let mode = next_field(&mut fields, "native index mode")?;
    let _object = next_field(&mut fields, "native index object")?;
    if next_field(&mut fields, "native index stage")? != "0" {
        return Err(SourceError::Invalid("unmerged index entry".into()));
    }
    reject_extra_fields(fields, "native index header")?;
    is_regular_mode(mode)
        .then(|| parse_path(raw_path))
        .transpose()
}

fn native_untracked_path(root: &Path, raw: &[u8]) -> Result<Option<RepoPath>, SourceError> {
    if raw.ends_with(b"/") {
        return Ok(None);
    }
    let path = parse_path(raw)?;
    let metadata = match fs::symlink_metadata(root.join(path.to_path_buf())) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(SourceError::Changed(format!(
                "untracked path {path} disappeared during native discovery"
            )));
        }
        Err(error) => return Err(io_error(error)),
    };
    Ok((metadata.is_file() && !metadata.file_type().is_symlink()).then_some(path))
}

fn nul_records(output: &[u8]) -> impl Iterator<Item = &[u8]> {
    output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
}

fn split_record<'a>(record: &'a [u8], detail: &str) -> Result<(&'a [u8], &'a [u8]), SourceError> {
    let tab = record
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| SourceError::Invalid(detail.into()))?;
    Ok((&record[..tab], &record[tab + 1..]))
}

fn ascii_fields<'a>(
    header: &'a [u8],
    detail: &str,
) -> Result<impl Iterator<Item = &'a str>, SourceError> {
    Ok(std::str::from_utf8(header)
        .map_err(|_| SourceError::Invalid(detail.into()))?
        .split_ascii_whitespace())
}

fn next_field<'a>(
    fields: &mut impl Iterator<Item = &'a str>,
    detail: &str,
) -> Result<&'a str, SourceError> {
    fields
        .next()
        .ok_or_else(|| SourceError::Invalid(format!("missing {detail}")))
}

fn reject_extra_fields<'a>(
    mut fields: impl Iterator<Item = &'a str>,
    detail: &str,
) -> Result<(), SourceError> {
    if fields.next().is_some() {
        return Err(SourceError::Invalid(format!("malformed {detail}")));
    }
    Ok(())
}

fn is_regular_mode(mode: &str) -> bool {
    matches!(mode, "100644" | "100755")
}

fn parse_path(raw: &[u8]) -> Result<RepoPath, SourceError> {
    RepoPath::new(raw.to_vec()).map_err(|error| SourceError::Invalid(error.to_string()))
}

fn insert_native_path(
    paths: &mut BTreeSet<RepoPath>,
    path: RepoPath,
    label: &str,
) -> Result<(), SourceError> {
    if paths.len() >= crate::limits::MAX_FILES && !paths.contains(&path) {
        return Err(SourceError::Incomplete(format!(
            "{label} exceed the {}-file limit",
            crate::limits::MAX_FILES
        )));
    }
    paths.insert(path);
    Ok(())
}
