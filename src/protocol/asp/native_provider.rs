use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read as _, Write as _},
    os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use sha2::Digest as _;

use crate::{
    cancel::CancelToken,
    limits::{MAX_ASSESSMENT_BYTES, MAX_FILES, MAX_SOURCE_BYTES},
    path::RepoPath,
    protocol::native::{
        NativeCheckRequest, NativeCheckResult, NativeExecutionIdentity, NativeLimits,
        NativeSeverity, NativeStatus, applicable as native_applicable, evaluate as evaluate_native,
        not_applicable as native_not_applicable,
    },
};

use super::{
    AspHost, AspSession, Comparison, NormalizedParams, ProviderProfile, RequestDeadline,
    RpcFailure, Scope, WorkspaceFailure, build_digest, workspace::prepare_native_views,
};

const CLEANUP_RESERVE: Duration = Duration::from_secs(1);
const MATERIALIZE_CHUNK_BYTES: usize = 64 * 1024;
const MAX_MATERIALIZED_ENTRIES: usize = MAX_FILES * 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
}

impl DirectoryIdentity {
    fn capture(path: &Path) -> Result<Self, RpcFailure> {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            RpcFailure::unavailable(format!("inspect native workspace root: {error}"))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(changed_materialization(path));
        }
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    fn verify(self, path: &Path) -> Result<(), RpcFailure> {
        if Self::capture(path)? != self {
            return Err(changed_materialization(path));
        }
        Ok(())
    }
}

pub(super) struct NativeEvaluation<'host> {
    pub(super) params: NormalizedParams,
    pub(super) session: AspSession,
    pub(super) profile: ProviderProfile,
    pub(super) host: &'host dyn AspHost,
    pub(super) cancel: CancelToken,
    pub(super) deadline: RequestDeadline,
    pub(super) project_root: Option<RepoPath>,
}

pub(super) async fn evaluate(input: NativeEvaluation<'_>) -> Result<Value, RpcFailure> {
    if let Some(detail) = request_support(&input.params, input.profile) {
        return Ok(unsupported_assessment(
            &input.params,
            &input.session,
            input.profile,
            detail,
        ));
    }
    evaluate_supported(input).await
}

async fn evaluate_supported(input: NativeEvaluation<'_>) -> Result<Value, RpcFailure> {
    let NativeEvaluation {
        params,
        session,
        profile,
        host,
        cancel,
        deadline,
        project_root,
    } = input;
    let prepared = match prepare_native_views(&params, &session, host, &cancel, deadline).await {
        Ok(prepared) => prepared,
        Err(WorkspaceFailure::Rpc(failure)) => return Err(failure),
        Err(WorkspaceFailure::Coverage(gap)) => {
            return Ok(super::workspace_gap_assessment(
                &params, &session, profile, &gap,
            ));
        }
    };
    require_active(&cancel)?;
    if !native_applicable(profile, &prepared.after) {
        return Ok(native_assessment(NativeAssessment {
            candidate: native_not_applicable(profile),
            baseline: None,
            params: &params,
            read_ids: &prepared.read_ids,
            session: &session,
            profile,
        }));
    }
    let runner = NativeRunner::new(profile, cancel, deadline, project_root).await?;
    let (candidate, comparison) = runner
        .run_comparison(params.comparison, prepared.before, prepared.after)
        .await?;
    Ok(native_assessment(NativeAssessment {
        candidate,
        baseline: comparison,
        params: &params,
        read_ids: &prepared.read_ids,
        session: &session,
        profile,
    }))
}

struct NativeRunner {
    profile: ProviderProfile,
    tool: PathBuf,
    identity: NativeExecutionIdentity,
    scratch_root: PathBuf,
    cancel: CancelToken,
    deadline: RequestDeadline,
    project_root: Option<RepoPath>,
}

impl NativeRunner {
    async fn new(
        profile: ProviderProfile,
        cancel: CancelToken,
        deadline: RequestDeadline,
        project_root: Option<RepoPath>,
    ) -> Result<Self, RpcFailure> {
        let remaining = deadline.remaining()?;
        let worker_cancel = cancel.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            let tool = resolve_tool(profile)?;
            let identity = NativeExecutionIdentity::capture(
                profile,
                &tool,
                &worker_cancel,
                deadline.instant(),
            )?;
            let scratch_root = private_scratch_root()?;
            Ok::<_, String>((tool, identity, scratch_root))
        });
        let (tool, identity, scratch_root) = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(RpcFailure::cancelled()),
            () = tokio::time::sleep(remaining) => {
                return Err(RpcFailure::unavailable(
                    "native tool identity capture exceeded the evaluation wallclock grant",
                ));
            }
            result = &mut worker => result
                .map_err(|_| RpcFailure::unavailable("native tool identity worker failed"))?
                .map_err(RpcFailure::unavailable)?,
        };
        Ok(Self {
            profile,
            tool,
            identity,
            scratch_root,
            cancel,
            deadline,
            project_root,
        })
    }

    async fn run_view(
        &self,
        name: &str,
        files: BTreeMap<RepoPath, Arc<[u8]>>,
    ) -> Result<NativeCheckResult, RpcFailure> {
        let scratch = tempfile::Builder::new()
            .prefix(&format!("opcore-native-{name}-"))
            .tempdir_in(&self.scratch_root)
            .map_err(|error| {
                RpcFailure::unavailable(format!("allocate native scratch: {error}"))
            })?;
        let root = scratch.path().join("workspace");
        let root_identity = materialize_view(
            root.clone(),
            files.clone(),
            self.cancel.clone(),
            self.deadline,
        )
        .await?;
        let timeout = self.deadline.work_timeout(CLEANUP_RESERVE)?;
        let limits = NativeLimits::bounded(timeout, MAX_ASSESSMENT_BYTES).ok_or_else(|| {
            RpcFailure::policy("native resource grant is outside provider bounds")
        })?;
        let mut result = self.run_native(root.clone(), files.clone(), limits).await?;
        let generated_lock_digest = verify_materialized_view(
            MaterializedView {
                root,
                root_identity,
                files,
                allow_generated_lock: self.profile == ProviderProfile::RustNative,
            },
            self.cancel.clone(),
            self.deadline,
        )
        .await?;
        if let Some(digest) = generated_lock_digest
            && let Some(evidence) = result.evidence.as_object_mut()
        {
            evidence.insert("generatedLockDigest".into(), Value::String(digest));
        }
        drop(scratch);
        Ok(result)
    }

    async fn run_comparison(
        &self,
        comparison: Comparison,
        before: BTreeMap<RepoPath, Arc<[u8]>>,
        after: BTreeMap<RepoPath, Arc<[u8]>>,
    ) -> Result<(NativeCheckResult, Option<NativeCheckResult>), RpcFailure> {
        let candidate = self.run_view("candidate", after).await?;
        require_active(&self.cancel)?;
        let baseline = self
            .run_baseline(comparison, candidate.status, before)
            .await?;
        require_active(&self.cancel)?;
        Ok((candidate, baseline))
    }

    async fn run_native(
        &self,
        workspace: PathBuf,
        source_files: BTreeMap<RepoPath, Arc<[u8]>>,
        limits: NativeLimits,
    ) -> Result<NativeCheckResult, RpcFailure> {
        let cancel = self.cancel.clone();
        let worker_cancel = cancel.clone();
        let profile = self.profile;
        let tool = self.tool.clone();
        let identity = self.identity.clone();
        let project_root = self.project_root.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            let mut request = NativeCheckRequest {
                profile,
                workspace_root: &workspace,
                project_root: project_root.as_ref(),
                source_files: &source_files,
                tool_program: &tool,
                identity: &identity,
                cancel: &worker_cancel,
                limits: NativeLimits::default(),
            };
            request.limits = limits;
            evaluate_native(&request)
        });
        tokio::select! {
            result = &mut worker => result
                .map_err(|_| RpcFailure::unavailable("native execution worker failed")),
            () = cancel.cancelled() => {
                let _ = worker.await;
                Err(RpcFailure::cancelled())
            },
        }
    }

    async fn run_baseline(
        &self,
        comparison: Comparison,
        candidate: NativeStatus,
        files: BTreeMap<RepoPath, Arc<[u8]>>,
    ) -> Result<Option<NativeCheckResult>, RpcFailure> {
        if comparison != Comparison::Introduced || candidate != NativeStatus::Findings {
            return Ok(None);
        }
        self.run_view("baseline", files).await.map(Some)
    }
}

fn require_active(cancel: &CancelToken) -> Result<(), RpcFailure> {
    if cancel.is_cancelled() {
        return Err(RpcFailure::cancelled());
    }
    Ok(())
}

fn request_support(params: &NormalizedParams, profile: ProviderProfile) -> Option<&'static str> {
    if !matches!(params.scope, Scope::Workspace) {
        return Some("native checks support workspace scope only");
    }
    if params
        .requested_sources
        .iter()
        .any(|source| source != profile.provider_id())
    {
        return Some("requested diagnostic source is not owned by this native provider");
    }
    if params
        .requested_rules
        .iter()
        .any(|rule| rule != profile.rule())
    {
        return Some("requested rule is not owned by this native provider");
    }
    None
}

async fn materialize_view(
    root: PathBuf,
    files: BTreeMap<RepoPath, Arc<[u8]>>,
    cancel: CancelToken,
    deadline: RequestDeadline,
) -> Result<DirectoryIdentity, RpcFailure> {
    tokio::task::spawn_blocking(move || materialize_view_blocking(&root, &files, &cancel, deadline))
        .await
        .map_err(|_| RpcFailure::unavailable("native materialization worker failed"))?
}

fn materialize_view_blocking(
    root: &Path,
    files: &BTreeMap<RepoPath, Arc<[u8]>>,
    cancel: &CancelToken,
    deadline: RequestDeadline,
) -> Result<DirectoryIdentity, RpcFailure> {
    fs::create_dir(root)
        .map_err(|error| RpcFailure::unavailable(format!("create native workspace: {error}")))?;
    let identity = DirectoryIdentity::capture(root)?;
    for (path, bytes) in files {
        materialize_file(root, path, bytes, cancel, deadline)?;
    }
    Ok(identity)
}

fn materialize_file(
    root: &Path,
    path: &RepoPath,
    bytes: &[u8],
    cancel: &CancelToken,
    deadline: RequestDeadline,
) -> Result<(), RpcFailure> {
    require_active(cancel)?;
    deadline.remaining()?;
    let target = root.join(path.to_path_buf());
    let parent = target
        .parent()
        .ok_or_else(|| RpcFailure::unavailable(format!("native path has no parent: {path}")))?;
    fs::create_dir_all(parent).map_err(|error| {
        RpcFailure::unavailable(format!("create native parent for {path}: {error}"))
    })?;
    let mut file = create_materialized_file(&target, path)?;
    write_materialized_bytes(&mut file, bytes, path, cancel, deadline)?;
    drop(file);
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).map_err(|error| {
        RpcFailure::unavailable(format!("set native file mode for {path}: {error}"))
    })
}

fn create_materialized_file(target: &Path, path: &RepoPath) -> Result<fs::File, RpcFailure> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| RpcFailure::unavailable(format!("create native file {path}: {error}")))
}

fn write_materialized_bytes(
    file: &mut fs::File,
    bytes: &[u8],
    path: &RepoPath,
    cancel: &CancelToken,
    deadline: RequestDeadline,
) -> Result<(), RpcFailure> {
    for chunk in bytes.chunks(MATERIALIZE_CHUNK_BYTES) {
        require_active(cancel)?;
        deadline.remaining()?;
        file.write_all(chunk).map_err(|error| {
            RpcFailure::unavailable(format!("write native file {path}: {error}"))
        })?;
    }
    Ok(())
}

struct MaterializedView {
    root: PathBuf,
    root_identity: DirectoryIdentity,
    files: BTreeMap<RepoPath, Arc<[u8]>>,
    allow_generated_lock: bool,
}

async fn verify_materialized_view(
    view: MaterializedView,
    cancel: CancelToken,
    deadline: RequestDeadline,
) -> Result<Option<String>, RpcFailure> {
    tokio::task::spawn_blocking(move || verify_materialized_view_blocking(&view, &cancel, deadline))
        .await
        .map_err(|_| RpcFailure::unavailable("native verification worker failed"))?
}

fn verify_materialized_view_blocking(
    view: &MaterializedView,
    cancel: &CancelToken,
    deadline: RequestDeadline,
) -> Result<Option<String>, RpcFailure> {
    MaterializedVerifier::new(view, cancel, deadline)?.verify()
}

struct MaterializedVerifier<'a> {
    root: &'a Path,
    root_identity: DirectoryIdentity,
    expected: BTreeMap<PathBuf, &'a [u8]>,
    expected_dirs: BTreeSet<PathBuf>,
    pending: Vec<PathBuf>,
    seen: BTreeSet<PathBuf>,
    generated_lock: Option<String>,
    allow_generated_lock: bool,
    entries: usize,
    cancel: &'a CancelToken,
    deadline: RequestDeadline,
}

impl<'a> MaterializedVerifier<'a> {
    fn new(
        view: &'a MaterializedView,
        cancel: &'a CancelToken,
        deadline: RequestDeadline,
    ) -> Result<Self, RpcFailure> {
        let expected = view
            .files
            .iter()
            .map(|(path, bytes)| (path.to_path_buf(), bytes.as_ref()))
            .collect::<BTreeMap<_, _>>();
        let expected_dirs = expected_directories(expected.keys())?;
        Ok(Self {
            root: &view.root,
            root_identity: view.root_identity,
            expected,
            expected_dirs,
            pending: vec![view.root.clone()],
            seen: BTreeSet::new(),
            generated_lock: None,
            allow_generated_lock: view.allow_generated_lock,
            entries: 0,
            cancel,
            deadline,
        })
    }

    fn verify(mut self) -> Result<Option<String>, RpcFailure> {
        self.root_identity.verify(self.root)?;
        let traversal = self.traverse();
        self.root_identity.verify(self.root)?;
        traversal?;
        self.finish()
    }

    fn traverse(&mut self) -> Result<(), RpcFailure> {
        while let Some(directory) = self.pending.pop() {
            require_active(self.cancel)?;
            self.deadline.remaining()?;
            self.inspect_directory(&directory)?;
        }
        Ok(())
    }

    fn inspect_directory(&mut self, directory: &Path) -> Result<(), RpcFailure> {
        let entries = fs::read_dir(directory).map_err(|error| {
            RpcFailure::unavailable(format!("inspect native workspace: {error}"))
        })?;
        for entry in entries {
            require_active(self.cancel)?;
            let entry = entry.map_err(|error| {
                RpcFailure::unavailable(format!("inspect native workspace entry: {error}"))
            })?;
            self.inspect_entry(&entry)?;
        }
        Ok(())
    }

    fn inspect_entry(&mut self, entry: &fs::DirEntry) -> Result<(), RpcFailure> {
        self.record_entry()?;
        let path = entry.path();
        let relative = path.strip_prefix(self.root).map_err(|_| {
            RpcFailure::unavailable("native workspace entry escaped its private root")
        })?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            RpcFailure::unavailable(format!("inspect native workspace entry: {error}"))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(changed_materialization(relative));
        }
        if metadata.is_dir() {
            return self.inspect_subdirectory(&path, relative);
        }
        if !metadata.is_file() {
            return Err(changed_materialization(relative));
        }
        self.inspect_file(&path, relative)
    }

    fn record_entry(&mut self) -> Result<(), RpcFailure> {
        self.entries = self.entries.saturating_add(1);
        if self.entries > MAX_MATERIALIZED_ENTRIES {
            return Err(RpcFailure::unavailable(
                "native workspace layout exceeded its verification bound",
            ));
        }
        Ok(())
    }

    fn inspect_subdirectory(&mut self, path: &Path, relative: &Path) -> Result<(), RpcFailure> {
        if !self.expected_dirs.contains(relative) {
            return Err(changed_materialization(relative));
        }
        self.pending.push(path.to_path_buf());
        Ok(())
    }

    fn inspect_file(&mut self, path: &Path, relative: &Path) -> Result<(), RpcFailure> {
        if let Some(expected_bytes) = self.expected.get(relative) {
            if read_materialized_file(path)? != *expected_bytes {
                return Err(changed_materialization(relative));
            }
            self.seen.insert(relative.to_path_buf());
            return Ok(());
        }
        if self.is_generated_lock(relative) {
            let bytes = read_materialized_file(path)?;
            self.generated_lock = Some(format!(
                "sha256:{}",
                hex::encode(sha2::Sha256::digest(bytes))
            ));
            return Ok(());
        }
        Err(changed_materialization(relative))
    }

    fn is_generated_lock(&self, relative: &Path) -> bool {
        self.allow_generated_lock
            && relative == Path::new("Cargo.lock")
            && !self.expected.contains_key(Path::new("Cargo.lock"))
    }

    fn finish(self) -> Result<Option<String>, RpcFailure> {
        if self.seen.len() != self.expected.len() {
            return Err(RpcFailure::unavailable(
                "native tool or repository code removed a materialized callback file",
            ));
        }
        Ok(self.generated_lock)
    }
}

fn expected_directories<'a>(
    paths: impl Iterator<Item = &'a PathBuf>,
) -> Result<BTreeSet<PathBuf>, RpcFailure> {
    let mut directories = BTreeSet::new();
    for path in paths {
        let mut parent = path.parent();
        while let Some(directory) = parent.filter(|directory| !directory.as_os_str().is_empty()) {
            directories.insert(directory.to_path_buf());
            if directories.len() > MAX_MATERIALIZED_ENTRIES {
                return Err(RpcFailure::unavailable(
                    "native workspace directory layout exceeds its bound",
                ));
            }
            parent = directory.parent();
        }
    }
    Ok(directories)
}

fn read_materialized_file(path: &Path) -> Result<Vec<u8>, RpcFailure> {
    let before = fs::symlink_metadata(path)
        .map_err(|error| RpcFailure::unavailable(format!("inspect native file: {error}")))?;
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.len() > MAX_SOURCE_BYTES as u64
    {
        return Err(changed_materialization(path));
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| RpcFailure::unavailable(format!("open native file: {error}")))?;
    let opened = file
        .metadata()
        .map_err(|error| RpcFailure::unavailable(format!("inspect open native file: {error}")))?;
    if (before.dev(), before.ino()) != (opened.dev(), opened.ino()) {
        return Err(changed_materialization(path));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(opened.len()).unwrap_or(MAX_SOURCE_BYTES));
    file.take((MAX_SOURCE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| RpcFailure::unavailable(format!("read native file: {error}")))?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(changed_materialization(path));
    }
    Ok(bytes)
}

fn changed_materialization(path: &Path) -> RpcFailure {
    RpcFailure::unavailable(format!(
        "native tool or repository code changed the private callback materialization at {}",
        path.display()
    ))
}

fn resolve_tool(profile: ProviderProfile) -> Result<PathBuf, String> {
    let (variable, executable, label) = match profile {
        ProviderProfile::RustNative => ("OPCORE_CARGO", "cargo", "Cargo"),
        ProviderProfile::NodeNative => ("OPCORE_NPM", "npm", "npm"),
        ProviderProfile::PythonNative => {
            if let Some(configured) = std::env::var_os("OPCORE_PYRIGHT") {
                return canonical_tool(&PathBuf::from(configured), "OPCORE_PYRIGHT");
            }
            if let Some(path) = find_on_path("pyright") {
                return canonical_tool(&path, "pyright");
            }
            ("OPCORE_MYPY", "mypy", "Pyright or mypy")
        }
        ProviderProfile::Fast => return Err("fast checks have no native tool".into()),
    };
    if let Some(configured) = std::env::var_os(variable) {
        return canonical_tool(&PathBuf::from(configured), variable);
    }
    if let Some(path) = find_on_path(executable) {
        return canonical_tool(&path, executable);
    }
    Err(format!(
        "{label} is unavailable; install it or set {variable} to an absolute executable"
    ))
}

fn find_on_path(executable: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(if cfg!(windows) {
            format!("{executable}.exe")
        } else {
            executable.to_owned()
        });
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn private_scratch_root() -> Result<PathBuf, String> {
    let root = std::env::current_dir()
        .map_err(|error| format!("locate provider-private scratch: {error}"))?
        .canonicalize()
        .map_err(|error| format!("resolve provider-private scratch: {error}"))?;
    let metadata = fs::symlink_metadata(&root)
        .map_err(|error| format!("inspect provider-private scratch: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("provider-private scratch root is not a real directory".into());
    }
    Ok(root)
}

fn canonical_tool(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{label} must resolve to an absolute path"));
    }
    if !path.is_file() {
        return Err(format!(
            "configured {label} executable is not a regular file"
        ));
    }
    Ok(path.to_path_buf())
}

struct NativeAssessment<'input> {
    candidate: NativeCheckResult,
    baseline: Option<NativeCheckResult>,
    params: &'input NormalizedParams,
    read_ids: &'input [String],
    session: &'input AspSession,
    profile: ProviderProfile,
}

fn native_assessment(input: NativeAssessment<'_>) -> Value {
    let NativeAssessment {
        mut candidate,
        baseline,
        params,
        read_ids,
        session,
        profile,
    } = input;
    let baseline_status = baseline.as_ref().map(|result| result.status);
    let comparison_complete =
        subtract_baseline(&mut candidate, baseline.as_ref(), params.comparison);
    let status = assessment_status(candidate.status, baseline_status, comparison_complete);
    let detail = assessment_detail(&candidate, baseline.as_ref(), comparison_complete, profile);
    let config_digest = &params.configuration.digest;
    let diagnostics = if status == "complete" {
        diagnostic_values(candidate.diagnostics, params.comparison)
    } else {
        Vec::new()
    };
    let complete = status == "complete";
    let notice =
        (!complete).then(|| super::coverage_notice(profile.provider_id(), status, &detail));
    let unsupported = if status == "unsupported" {
        vec![super::coverage_notice(
            profile.provider_id(),
            "unsupported",
            &detail,
        )]
    } else {
        Vec::new()
    };
    let degraded = notice.into_iter().collect::<Vec<_>>();
    let requested = coverage_part(params, true);
    let covered = coverage_part(params, complete);
    let elapsed_ms = evidence_elapsed_ms(&candidate.evidence).saturating_add(
        baseline
            .as_ref()
            .map_or(0, |result| evidence_elapsed_ms(&result.evidence)),
    );
    let provider_message = match profile {
        ProviderProfile::RustNative => {
            "Cargo Check ran on a provider-private materialization; evidence does not grant host authority."
        }
        ProviderProfile::NodeNative => {
            "TypeScript checking ran on a provider-private materialization; evidence does not grant host authority."
        }
        ProviderProfile::PythonNative => {
            "Python type checking ran on a provider-private materialization; evidence does not grant host authority."
        }
        ProviderProfile::Fast => "Native provider dispatch was invalid.",
    };
    json!({
        "status": status,
        "diagnostics": diagnostics,
        "evidence": [{
            "kind": "metric",
            "message": provider_message,
            "data": {
                "candidate": candidate.evidence,
                "baseline": baseline.map(|result| result.evidence),
                "initializedGrant": session.initialized_grant,
                "comparisonComplete": comparison_complete
            }
        }],
        "coverage": {
            "requested": requested,
            "covered": covered,
            "degraded": degraded,
            "unsupported": unsupported,
            "exhaustive": complete,
            "truncated": status == "incomplete"
        },
        "validAsOf": {
            "baseline": session.baseline,
            "changesetDigest": params.changeset_digest,
            "blobs": read_ids
        },
        "provider": {
            "id": profile.provider_id(),
            "version": env!("CARGO_PKG_VERSION"),
            "configDigest": config_digest,
            "capabilityVersion": super::CAPABILITY_VERSION,
            "buildDigest": build_digest(),
            "capabilityFamily": "check"
        },
        "timing": { "elapsedMs": elapsed_ms },
        "cache": { "status": "disabled" }
    })
}

fn subtract_baseline(
    candidate: &mut NativeCheckResult,
    baseline: Option<&NativeCheckResult>,
    comparison: Comparison,
) -> bool {
    if comparison != Comparison::Introduced || candidate.status != NativeStatus::Findings {
        return true;
    }
    let Some(baseline) = baseline else {
        return false;
    };
    match baseline.status {
        // A newly added root manifest has an empty before-set for this provider.
        NativeStatus::NotApplicable => return true,
        // A failed compiler run may stop before other crates or targets. Its diagnostics are not
        // an exhaustive before-set, so it cannot safely discharge an introduced comparison.
        NativeStatus::Clean | NativeStatus::Findings if baseline.comparison_safe => {}
        _ => return false,
    }
    let prior = baseline
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.fingerprint.as_str())
        .collect::<BTreeSet<_>>();
    candidate
        .diagnostics
        .retain(|diagnostic| !prior.contains(diagnostic.fingerprint.as_str()));
    true
}

fn assessment_status(
    candidate: NativeStatus,
    baseline: Option<NativeStatus>,
    comparison_complete: bool,
) -> &'static str {
    match candidate {
        NativeStatus::Clean => "complete",
        NativeStatus::Findings => findings_status(baseline, comparison_complete),
        NativeStatus::NotApplicable => "unsupported",
        NativeStatus::Unavailable => "error",
        NativeStatus::Cancelled => "cancelled",
        NativeStatus::Incomplete => "incomplete",
    }
}

fn findings_status(baseline: Option<NativeStatus>, comparison_complete: bool) -> &'static str {
    if comparison_complete {
        return "complete";
    }
    match baseline {
        Some(NativeStatus::Unavailable) => "error",
        Some(NativeStatus::Cancelled) => "cancelled",
        _ => "incomplete",
    }
}

fn assessment_detail(
    candidate: &NativeCheckResult,
    baseline: Option<&NativeCheckResult>,
    comparison_complete: bool,
    profile: ProviderProfile,
) -> String {
    if !comparison_complete {
        if let Some(result) = baseline.filter(|result| result.status == NativeStatus::Findings) {
            return failed_baseline_detail(result, profile);
        }
        return baseline
            .and_then(|result| result.detail.clone())
            .unwrap_or_else(|| baseline_comparison_detail(profile).into());
    }
    candidate
        .detail
        .clone()
        .unwrap_or_else(|| incomplete_detail(profile).into())
}

fn failed_baseline_detail(result: &NativeCheckResult, profile: ProviderProfile) -> String {
    let summary = baseline_findings_detail(profile);
    let Some(diagnostic) = result
        .diagnostics
        .iter()
        .find(|diagnostic| {
            diagnostic.severity == NativeSeverity::Error && diagnostic.location.range.is_some()
        })
        .or_else(|| {
            result
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.severity == NativeSeverity::Error)
        })
    else {
        return summary.into();
    };
    let location = diagnostic.location.range.map_or_else(
        || diagnostic.location.path.clone(),
        |range| format!("{}:{}", diagnostic.location.path, range.start.line),
    );
    let message = diagnostic.message.chars().take(512).collect::<String>();
    format!("{summary}; first baseline compiler error at {location}: {message}")
}

const fn baseline_comparison_detail(profile: ProviderProfile) -> &'static str {
    match profile {
        ProviderProfile::RustNative => {
            "baseline Cargo Check could not establish introduced findings"
        }
        ProviderProfile::NodeNative => {
            "baseline TypeScript checking could not establish introduced findings"
        }
        ProviderProfile::PythonNative => {
            "baseline Python type checking could not establish introduced findings"
        }
        ProviderProfile::Fast => "invalid native provider comparison",
    }
}

const fn baseline_findings_detail(profile: ProviderProfile) -> &'static str {
    match profile {
        ProviderProfile::RustNative => {
            "baseline Cargo Check failed, so compiler short-circuiting prevents an exact introduced comparison"
        }
        ProviderProfile::NodeNative => {
            "baseline TypeScript checking did not provide an exhaustive introduced comparison"
        }
        ProviderProfile::PythonNative => {
            "baseline Python type checking did not provide an exhaustive introduced comparison"
        }
        ProviderProfile::Fast => "invalid native provider comparison",
    }
}

const fn incomplete_detail(profile: ProviderProfile) -> &'static str {
    match profile {
        ProviderProfile::RustNative => "Rust-native Cargo Check did not complete",
        ProviderProfile::NodeNative => "Node-native TypeScript checking did not complete",
        ProviderProfile::PythonNative => "Python-native type checking did not complete",
        ProviderProfile::Fast => "invalid native provider dispatch",
    }
}

fn diagnostic_values(
    diagnostics: Vec<crate::protocol::native::NativeDiagnostic>,
    comparison: Comparison,
) -> Vec<Value> {
    diagnostics
        .into_iter()
        .filter_map(|diagnostic| serde_json::to_value(diagnostic).ok())
        .map(|mut diagnostic| {
            if comparison == Comparison::Introduced {
                diagnostic["introduced"] = json!(true);
            }
            diagnostic
        })
        .collect()
}

fn coverage_part(params: &NormalizedParams, complete: bool) -> Value {
    json!({
        "scope": params.scope_json,
        "diagnosticSources": if complete { params.requested_sources.clone() } else { Vec::new() },
        "rules": if complete { params.requested_rules.clone() } else { Vec::new() },
        "comparison": params.comparison
    })
}

fn unsupported_assessment(
    params: &NormalizedParams,
    session: &AspSession,
    profile: ProviderProfile,
    detail: &str,
) -> Value {
    super::unsupported_for(
        params,
        session,
        profile,
        detail,
        params.configuration.digest.clone(),
    )
}

fn evidence_elapsed_ms(evidence: &Value) -> u64 {
    evidence
        .get("elapsedMs")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::native::{NativeDiagnostic, NativeEvidence};

    struct MaterializedFixture {
        scratch: tempfile::TempDir,
        root: PathBuf,
        files: BTreeMap<RepoPath, Arc<[u8]>>,
        cancel: CancelToken,
        deadline: RequestDeadline,
        root_identity: DirectoryIdentity,
    }

    impl MaterializedFixture {
        fn new() -> Self {
            let scratch = tempfile::tempdir().unwrap();
            let root = scratch.path().join("workspace");
            let path = RepoPath::from_protocol("src/lib.rs").unwrap();
            let files = BTreeMap::from([(path, Arc::<[u8]>::from(b"fn clean() {}\n".as_slice()))]);
            let cancel = CancelToken::new();
            let deadline = RequestDeadline::new(5_000).unwrap();
            let root_identity =
                materialize_view_blocking(&root, &files, &cancel, deadline).unwrap();
            Self {
                scratch,
                root,
                files,
                cancel,
                deadline,
                root_identity,
            }
        }

        fn verify(&self) -> Result<Option<String>, RpcFailure> {
            let view = MaterializedView {
                root: self.root.clone(),
                root_identity: self.root_identity,
                files: self.files.clone(),
                allow_generated_lock: true,
            };
            verify_materialized_view_blocking(&view, &self.cancel, self.deadline)
        }
    }

    fn result(
        status: NativeStatus,
        exit_code: Option<i32>,
        fingerprints: &[&str],
    ) -> NativeCheckResult {
        let mut evidence = NativeEvidence::test_value();
        evidence.exit_code = exit_code;
        NativeCheckResult {
            status,
            diagnostics: fingerprints
                .iter()
                .map(|fingerprint| NativeDiagnostic::test_value(fingerprint))
                .collect(),
            detail: None,
            evidence: serde_json::to_value(evidence).unwrap(),
            comparison_safe: status == NativeStatus::NotApplicable || exit_code == Some(0),
        }
    }

    #[test]
    fn introduced_comparison_is_set_difference_after_successful_baseline() {
        let mut candidate = result(NativeStatus::Findings, Some(1), &["a", "a", "b"]);
        let baseline = result(NativeStatus::Findings, Some(0), &["a"]);
        assert!(subtract_baseline(
            &mut candidate,
            Some(&baseline),
            Comparison::Introduced
        ));
        assert_eq!(
            candidate
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.fingerprint.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );
    }

    #[test]
    fn failed_baseline_cannot_mask_an_introduced_compiler_failure() {
        let mut candidate = result(NativeStatus::Findings, Some(1), &["old"]);
        let mut baseline = result(NativeStatus::Findings, Some(1), &["old"]);
        baseline.diagnostics[0].message = "generic failure note".into();
        baseline.diagnostics.push(NativeDiagnostic {
            message: "missing test_fixture".into(),
            location: crate::protocol::native::NativeLocation {
                path: "tests/runtime_process.rs".into(),
                range: Some(crate::protocol::native::NativeRange {
                    start: crate::protocol::native::NativePosition { line: 23, char: 46 },
                    end: crate::protocol::native::NativePosition { line: 23, char: 58 },
                }),
            },
            ..NativeDiagnostic::test_value("source-error")
        });

        assert!(!subtract_baseline(
            &mut candidate,
            Some(&baseline),
            Comparison::Introduced
        ));
        assert_eq!(
            assessment_status(candidate.status, Some(baseline.status), false),
            "incomplete"
        );
        let detail = assessment_detail(
            &candidate,
            Some(&baseline),
            false,
            ProviderProfile::RustNative,
        );
        assert!(detail.contains("first baseline compiler error at tests/runtime_process.rs:23"));
        assert!(detail.contains("missing test_fixture"));
    }

    #[test]
    fn absent_baseline_project_is_an_empty_before_set() {
        let mut candidate = result(NativeStatus::Findings, Some(1), &["new"]);
        let baseline = result(NativeStatus::NotApplicable, None, &[]);

        assert!(subtract_baseline(
            &mut candidate,
            Some(&baseline),
            Comparison::Introduced
        ));
        assert_eq!(candidate.diagnostics.len(), 1);
    }

    #[test]
    fn unavailable_runtime_is_not_a_capability_gap() {
        assert_eq!(
            assessment_status(NativeStatus::Unavailable, None, true),
            "error"
        );
    }

    #[test]
    fn callback_materialization_is_revalidated_after_cargo() {
        let fixture = MaterializedFixture::new();

        std::fs::write(fixture.root.join("Cargo.lock"), b"# generated\n").unwrap();
        let generated = fixture.verify().unwrap();
        assert!(generated.is_some());

        std::fs::write(fixture.root.join("src/lib.rs"), b"fn changed() {}\n").unwrap();
        assert!(fixture.verify().is_err());
    }

    #[test]
    fn non_rust_materialization_rejects_a_generated_cargo_lock() {
        let fixture = MaterializedFixture::new();
        std::fs::write(fixture.root.join("Cargo.lock"), b"# generated\n").unwrap();
        let view = MaterializedView {
            root: fixture.root.clone(),
            root_identity: fixture.root_identity,
            files: fixture.files.clone(),
            allow_generated_lock: false,
        };
        assert!(
            verify_materialized_view_blocking(&view, &fixture.cancel, fixture.deadline).is_err()
        );
    }

    #[test]
    fn callback_materialization_rejects_a_replaced_root() {
        use std::os::unix::fs::symlink;

        let fixture = MaterializedFixture::new();
        let original = fixture.scratch.path().join("original");
        let replacement = fixture.scratch.path().join("replacement");
        std::fs::rename(&fixture.root, &original).unwrap();
        std::fs::create_dir(&replacement).unwrap();
        symlink(&replacement, &fixture.root).unwrap();

        assert!(fixture.verify().is_err());
    }
}
