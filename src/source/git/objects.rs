use super::{
    BTreeMap, BTreeSet, BufRead, BufReader, GitBlob, MAX_SOURCE_BYTES, MAX_TOTAL_SOURCE_BYTES,
    PATH_ARGUMENT_BATCH, Path, Read, RepoPath, SourceError, SourceFile, TreeEntry, Write,
    detect_language, io_error, is_dependency_capture_candidate, source_file, trim_ascii,
};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};

use crate::limits::{MAX_GIT_ERROR_BYTES, MAX_GIT_METADATA_BYTES};

pub(super) struct GitOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub(super) fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.excludesfile=/dev/null",
        ]);
    command
}

pub(super) fn git_at<I, S>(root: &Path, args: I) -> Result<Vec<u8>, SourceError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let output = bounded_git_output(git_command(root).args(args))?;
    if !output.status.success() {
        return Err(SourceError::Io(format!(
            "git exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

pub(super) fn bounded_git_output(command: &mut Command) -> Result<GitOutput, SourceError> {
    bounded_command_output(command, MAX_GIT_METADATA_BYTES, MAX_GIT_ERROR_BYTES)
}

pub(super) fn bounded_command_output(
    command: &mut Command,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<GitOutput, SourceError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(io_error)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SourceError::Io("Git stdout pipe was unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| SourceError::Io("Git stderr pipe was unavailable".into()))?;
    let stdout = std::thread::spawn(move || read_bounded(stdout, stdout_limit));
    let stderr = std::thread::spawn(move || read_bounded(stderr, stderr_limit));
    let status = child.wait().map_err(io_error)?;
    let stdout = join_output(stdout, "stdout")?;
    let stderr = join_output(stderr, "stderr")?;
    if stdout.len() > stdout_limit || stderr.len() > stderr_limit {
        return Err(SourceError::Incomplete(
            "Git process output exceeded its hard byte limit".into(),
        ));
    }
    Ok(GitOutput {
        status,
        stdout,
        stderr,
    })
}

fn read_bounded(reader: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(u64::try_from(limit.saturating_add(1)).unwrap_or(u64::MAX))
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn join_output(
    handle: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
    stream: &str,
) -> Result<Vec<u8>, SourceError> {
    handle
        .join()
        .map_err(|_| SourceError::Io(format!("Git {stream} reader panicked")))?
        .map_err(io_error)
}

pub(super) fn head_tree_or_empty(root: &Path) -> Result<String, SourceError> {
    let output =
        bounded_git_output(git_command(root).args(["rev-parse", "--verify", "-q", "HEAD^{tree}"]))?;
    if output.status.success() {
        return trim_ascii(&output.stdout);
    }
    if output.status.code() != Some(1) {
        return Err(SourceError::Io(format!(
            "git rev-parse exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    trim_ascii(&git_at(root, ["hash-object", "-t", "tree", "--stdin"])?)
}

pub(super) fn resolve_tree(root: &Path, reference: &str) -> Result<String, SourceError> {
    if reference.trim().is_empty() {
        return Err(SourceError::Invalid(
            "Git tree reference must not be blank".into(),
        ));
    }
    let revision = format!("{reference}^{{tree}}");
    let output = bounded_git_output(git_command(root).args([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &revision,
    ]))?;
    if !output.status.success() {
        return Err(SourceError::Invalid(format!(
            "Git tree reference {reference:?} does not resolve to a tree"
        )));
    }
    trim_ascii(&output.stdout)
}

pub(super) fn names_from_git_filtered<I, S>(
    root: &Path,
    args: I,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeSet<RepoPath>, SourceError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let output = git_at(root, args)?;
    let mut paths = BTreeSet::new();
    for item in output
        .split(|byte| *byte == 0)
        .filter(|item| !item.is_empty())
    {
        let path = RepoPath::new(item.to_vec())
            .map_err(|error| SourceError::Invalid(error.to_string()))?;
        if !selected(&path) {
            continue;
        }
        if paths.len() >= crate::limits::MAX_FILES && !paths.contains(&path) {
            return Err(SourceError::Incomplete(format!(
                "Git source paths exceed the {}-file limit",
                crate::limits::MAX_FILES
            )));
        }
        paths.insert(path);
    }
    Ok(paths)
}

pub(super) fn reject_unmerged(root: &Path) -> Result<(), SourceError> {
    if !git_at(root, ["ls-files", "--unmerged", "-z", "--"])?.is_empty() {
        return Err(SourceError::Invalid(
            "unmerged index entries are not a valid source view".into(),
        ));
    }
    Ok(())
}

pub(super) fn tree_entries(
    root: &Path,
    tree: &str,
    paths: &BTreeSet<RepoPath>,
) -> Result<BTreeMap<RepoPath, TreeEntry>, SourceError> {
    if paths.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut result = BTreeMap::new();
    for chunk in paths.iter().collect::<Vec<_>>().chunks(PATH_ARGUMENT_BATCH) {
        let mut command = git_command(root);
        command.args(["ls-tree", "-rz", "--full-tree", tree, "--"]);
        for path in chunk {
            command.arg(path.to_path_buf());
        }
        let output = bounded_git_output(&mut command)?;
        if !output.status.success() {
            return Err(SourceError::Io(
                String::from_utf8_lossy(&output.stderr).trim().into(),
            ));
        }
        parse_tree_entries(&output.stdout, Some(paths), &mut result)?;
    }
    Ok(result)
}

pub(super) fn all_tree_entries_filtered(
    root: &Path,
    tree: &str,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeMap<RepoPath, TreeEntry>, SourceError> {
    let output = git_at(root, ["ls-tree", "-rz", "--full-tree", "-r", tree])?;
    let mut result = BTreeMap::new();
    parse_selected_tree_entries(&output, selected, &mut result)?;
    Ok(result)
}

pub(super) fn parse_tree_entries(
    output: &[u8],
    paths: Option<&BTreeSet<RepoPath>>,
    result: &mut BTreeMap<RepoPath, TreeEntry>,
) -> Result<(), SourceError> {
    parse_selected_tree_entries(
        output,
        &|path| {
            paths.map_or_else(
                || is_dependency_capture_candidate(path),
                |paths| paths.contains(path),
            )
        },
        result,
    )
}

fn parse_selected_tree_entries(
    output: &[u8],
    selected: &dyn Fn(&RepoPath) -> bool,
    result: &mut BTreeMap<RepoPath, TreeEntry>,
) -> Result<(), SourceError> {
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if let Some((path, entry)) = parse_tree_entry(record)?
            && selected(&path)
        {
            insert_bounded_entry(result, path, entry)?;
        }
    }
    Ok(())
}

fn parse_tree_entry(record: &[u8]) -> Result<Option<(RepoPath, TreeEntry)>, SourceError> {
    let tab = record
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| SourceError::Invalid("malformed ls-tree record".into()))?;
    let header = std::str::from_utf8(&record[..tab])
        .map_err(|_| SourceError::Invalid("non-ASCII ls-tree header".into()))?;
    let mut fields = header.split_ascii_whitespace();
    let mode = next_tree_field(&mut fields, "mode")?;
    if next_tree_field(&mut fields, "type")? != "blob" {
        return Ok(None);
    }
    let oid = next_tree_field(&mut fields, "object")?;
    let path = RepoPath::new(record[tab + 1..].to_vec())
        .map_err(|error| SourceError::Invalid(error.to_string()))?;
    Ok(Some((
        path,
        TreeEntry {
            mode: mode.into(),
            oid: oid.into(),
        },
    )))
}

fn next_tree_field<'a>(
    fields: &mut impl Iterator<Item = &'a str>,
    name: &str,
) -> Result<&'a str, SourceError> {
    fields
        .next()
        .ok_or_else(|| SourceError::Invalid(format!("missing tree {name}")))
}

fn insert_bounded_entry(
    entries: &mut BTreeMap<RepoPath, TreeEntry>,
    path: RepoPath,
    entry: TreeEntry,
) -> Result<(), SourceError> {
    if entries.len() >= crate::limits::MAX_FILES && !entries.contains_key(&path) {
        return Err(SourceError::Incomplete(format!(
            "Git source entries exceed the {}-file limit",
            crate::limits::MAX_FILES
        )));
    }
    entries.insert(path, entry);
    Ok(())
}

pub(super) fn index_entries(
    root: &Path,
    paths: &BTreeSet<RepoPath>,
) -> Result<BTreeMap<RepoPath, TreeEntry>, SourceError> {
    if paths.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut result = BTreeMap::new();
    for chunk in paths.iter().collect::<Vec<_>>().chunks(PATH_ARGUMENT_BATCH) {
        let output = index_entry_output(root, chunk.iter().copied())?;
        result.extend(parse_index_entries(&output, Some(paths))?);
    }
    Ok(result)
}

pub(super) fn all_index_entries_filtered(
    root: &Path,
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeMap<RepoPath, TreeEntry>, SourceError> {
    parse_selected_index_entries(&index_entry_output(root, std::iter::empty())?, selected)
}

fn index_entry_output<'a>(
    root: &Path,
    paths: impl IntoIterator<Item = &'a RepoPath>,
) -> Result<Vec<u8>, SourceError> {
    let mut command = git_command(root);
    command.args(["ls-files", "--stage", "-z", "--"]);
    for path in paths {
        command.arg(path.to_path_buf());
    }
    let output = bounded_git_output(&mut command)?;
    if !output.status.success() {
        return Err(SourceError::Io(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    Ok(output.stdout)
}

pub(super) fn parse_index_entries(
    output: &[u8],
    paths: Option<&BTreeSet<RepoPath>>,
) -> Result<BTreeMap<RepoPath, TreeEntry>, SourceError> {
    parse_selected_index_entries(output, &|path| {
        paths.map_or_else(
            || is_dependency_capture_candidate(path),
            |paths| paths.contains(path),
        )
    })
}

fn parse_selected_index_entries(
    output: &[u8],
    selected: &dyn Fn(&RepoPath) -> bool,
) -> Result<BTreeMap<RepoPath, TreeEntry>, SourceError> {
    let mut result = BTreeMap::new();
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let (path, entry) = parse_index_entry(record)?;
        if selected(&path) {
            insert_bounded_entry(&mut result, path, entry)?;
        }
    }
    Ok(result)
}

fn parse_index_entry(record: &[u8]) -> Result<(RepoPath, TreeEntry), SourceError> {
    let tab = record
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| SourceError::Invalid("malformed index record".into()))?;
    let header = std::str::from_utf8(&record[..tab])
        .map_err(|_| SourceError::Invalid("non-ASCII index header".into()))?;
    let mut fields = header.split_ascii_whitespace();
    let mode = next_index_field(&mut fields, "mode")?;
    let oid = next_index_field(&mut fields, "object")?;
    if next_index_field(&mut fields, "stage")? != "0" {
        return Err(SourceError::Invalid("unmerged index entry".into()));
    }
    let path = RepoPath::new(record[tab + 1..].to_vec())
        .map_err(|error| SourceError::Invalid(error.to_string()))?;
    Ok((
        path,
        TreeEntry {
            mode: mode.into(),
            oid: oid.into(),
        },
    ))
}

fn next_index_field<'a>(
    fields: &mut impl Iterator<Item = &'a str>,
    name: &str,
) -> Result<&'a str, SourceError> {
    fields
        .next()
        .ok_or_else(|| SourceError::Invalid(format!("missing index {name}")))
}

pub(super) fn files_from_git_objects(
    root: &Path,
    entries: &BTreeMap<RepoPath, TreeEntry>,
) -> Result<Vec<SourceFile>, SourceError> {
    let supported: Vec<_> = entries
        .iter()
        .filter_map(|(path, entry)| detect_language(path).map(|_| (path, entry)))
        .collect();
    git_blobs_from_objects(root, supported).map(|blobs| {
        blobs
            .into_iter()
            .filter_map(|blob| source_file(blob.path, blob.bytes))
            .collect()
    })
}

pub(super) fn git_blobs_from_objects(
    root: &Path,
    entries: Vec<(&RepoPath, &TreeEntry)>,
) -> Result<Vec<GitBlob>, SourceError> {
    git_blobs_from_objects_bounded(root, entries, MAX_TOTAL_SOURCE_BYTES)
}

pub(super) fn git_blobs_from_objects_bounded(
    root: &Path,
    entries: Vec<(&RepoPath, &TreeEntry)>,
    total_limit: usize,
) -> Result<Vec<GitBlob>, SourceError> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    validate_git_object_modes(&entries)?;
    let mut child = git_command(root)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(io_error)?;
    let object_ids = entries
        .iter()
        .map(|(_, entry)| entry.oid.clone())
        .collect::<Vec<_>>();
    let (mut stdin, stdout) = take_cat_file_pipes(&mut child)?;
    let writer = std::thread::spawn(move || -> std::io::Result<()> {
        for object_id in object_ids {
            writeln!(stdin, "{object_id}")?;
        }
        Ok(())
    });
    let mut reader = BufReader::new(stdout);
    let read_result = read_cat_blobs(&mut reader, entries, total_limit);
    drop(reader);
    let write_result = writer
        .join()
        .map_err(|_| SourceError::Io("git cat-file input writer panicked".into()))?;
    let status = child.wait().map_err(io_error)?;
    let files = read_result?;
    write_result.map_err(io_error)?;
    if !status.success() {
        return Err(SourceError::Io(format!("git cat-file exited {status}")));
    }
    Ok(files)
}

fn take_cat_file_pipes(child: &mut Child) -> Result<(ChildStdin, ChildStdout), SourceError> {
    let stdin = child.stdin.take().ok_or_else(|| {
        stop_child(child);
        SourceError::Io("git cat-file did not expose its configured stdin pipe".into())
    })?;
    let Some(stdout) = child.stdout.take() else {
        drop(stdin);
        stop_child(child);
        return Err(SourceError::Io(
            "git cat-file did not expose its configured stdout pipe".into(),
        ));
    };
    Ok((stdin, stdout))
}

fn stop_child(child: &mut Child) {
    drop(child.kill());
    drop(child.wait());
}

fn validate_git_object_modes(entries: &[(&RepoPath, &TreeEntry)]) -> Result<(), SourceError> {
    for (_, entry) in entries {
        match entry.mode.as_str() {
            "120000" => {
                return Err(SourceError::Denied(
                    "tracked symlinks are not followed".into(),
                ));
            }
            "160000" => {
                return Err(SourceError::Denied(
                    "submodule entries are not files".into(),
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

pub(super) fn read_cat_blobs<R: BufRead>(
    reader: &mut R,
    entries: Vec<(&RepoPath, &TreeEntry)>,
    total_limit: usize,
) -> Result<Vec<GitBlob>, SourceError> {
    let mut blobs = Vec::with_capacity(entries.len());
    let mut total = 0usize;
    for (path, entry) in entries {
        let length = read_cat_header(reader, path, entry)?;
        add_bounded_blob_length(&mut total, length, path, total_limit)?;
        let bytes = read_cat_body(reader, length)?;
        blobs.push(GitBlob {
            path: path.clone(),
            bytes,
        });
    }
    Ok(blobs)
}

fn read_cat_header<R: BufRead>(
    reader: &mut R,
    path: &RepoPath,
    entry: &TreeEntry,
) -> Result<usize, SourceError> {
    let mut header = String::new();
    reader.read_line(&mut header).map_err(io_error)?;
    let fields: Vec<_> = header.split_ascii_whitespace().collect();
    if fields.len() != 3 || fields[0] != entry.oid || fields[1] != "blob" {
        return Err(SourceError::Invalid(format!(
            "unexpected cat-file response for {path}"
        )));
    }
    fields[2]
        .parse()
        .map_err(|_| SourceError::Invalid("invalid blob size".into()))
}

pub(super) fn add_bounded_blob_length(
    total: &mut usize,
    length: usize,
    path: &RepoPath,
    total_limit: usize,
) -> Result<(), SourceError> {
    if length > MAX_SOURCE_BYTES {
        return Err(SourceError::Incomplete(format!(
            "{path} exceeds {MAX_SOURCE_BYTES} bytes"
        )));
    }
    *total = total.saturating_add(length);
    if *total > total_limit {
        return Err(SourceError::Incomplete(format!(
            "Git blob read exceeds {total_limit} total bytes"
        )));
    }
    Ok(())
}

fn read_cat_body<R: Read>(reader: &mut R, length: usize) -> Result<Vec<u8>, SourceError> {
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(io_error)?;
    let mut newline = [0u8; 1];
    reader.read_exact(&mut newline).map_err(io_error)?;
    if newline != *b"\n" {
        return Err(SourceError::Invalid("malformed cat-file frame".into()));
    }
    Ok(bytes)
}
