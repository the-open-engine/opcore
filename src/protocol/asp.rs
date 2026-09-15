use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    cancel::CancelToken,
    engine::Engine,
    engine::EvaluationRequest,
    limits::{MAX_FILES, MAX_SOURCE_BYTES, MAX_TOTAL_SOURCE_BYTES},
    model::{Assessment, AssessmentStatus, Comparison, CoverageStatus, Scope, SourceFile},
    path::RepoPath,
    source::{
        git::{detect_language, is_source_candidate, resolve_language},
        snapshot::SourceSnapshot,
    },
};

mod assessment;
mod configuration;
mod native_provider;
mod prior;
mod profile;
mod workspace;

#[cfg(test)]
use assessment::AspCoverage;
use assessment::to_asp_assessment;
pub(crate) use configuration::expected_digest as configuration_digest;
use workspace::{WorkspaceFailure, WorkspaceGap, prepare_views};

pub use profile::{
    CAPABILITY_VERSION, CORE_RULE, MANIFEST_VERSION, NODE_NATIVE_PROVIDER_ID, NODE_NATIVE_RULE,
    PROTOCOL_VERSION, PROVIDER_ID, PYTHON_NATIVE_PROVIDER_ID, PYTHON_NATIVE_RULE, ProviderProfile,
};

#[derive(Clone, Debug)]
pub struct AspSession {
    pub baseline: Value,
    pub wallclock_ms: u64,
    pub initialized_grant: Value,
}

#[derive(Clone, Debug)]
pub struct RpcFailure {
    pub code: i64,
    pub message: &'static str,
    pub fail_class: &'static str,
    pub retryable: bool,
    pub detail: String,
}

impl RpcFailure {
    pub fn input(detail: impl Into<String>) -> Self {
        Self {
            code: -32013,
            message: "invalid-input",
            fail_class: "input",
            retryable: false,
            detail: detail.into(),
        }
    }

    pub fn health(detail: impl Into<String>) -> Self {
        Self {
            code: -32011,
            message: "stale-or-unhealthy",
            fail_class: "health",
            retryable: true,
            detail: detail.into(),
        }
    }

    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            code: -32015,
            message: "unavailable",
            fail_class: "health",
            retryable: true,
            detail: detail.into(),
        }
    }

    pub fn contract(detail: impl Into<String>) -> Self {
        Self {
            code: -32014,
            message: "protocol-contract-failure",
            fail_class: "contract",
            retryable: false,
            detail: detail.into(),
        }
    }

    #[must_use]
    pub fn provider_not_initialized() -> Self {
        Self {
            code: -32010,
            message: "provider-not-initialized",
            fail_class: "health",
            retryable: true,
            detail: "check/evaluate requires a completed initialized grant".into(),
        }
    }

    pub fn policy(detail: impl Into<String>) -> Self {
        Self {
            code: -32012,
            message: "policy-denied",
            fail_class: "policy",
            retryable: false,
            detail: detail.into(),
        }
    }

    #[must_use]
    pub fn cancelled() -> Self {
        Self {
            code: -32016,
            message: "cancelled",
            fail_class: "health",
            retryable: true,
            detail: "evaluation was cancelled".into(),
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "code": self.code,
            "message": self.message,
            "data": { "failClass": self.fail_class, "retryable": self.retryable, "detail": self.detail }
        })
    }
}

#[async_trait]
pub trait AspHost: Send + Sync {
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        cancel: &CancelToken,
    ) -> Result<Value, RpcFailure>;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Baseline {
    rev: String,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    dirty: Option<String>,
    #[serde(
        rename = "stampedAt",
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    stamped_at: Option<String>,
}

impl Baseline {
    fn validate_timestamp(&self) -> Result<(), RpcFailure> {
        if self
            .stamped_at
            .as_deref()
            .is_some_and(|value| !is_rfc3339_timestamp(value))
        {
            return Err(RpcFailure::input(
                "baseline stampedAt must be an RFC 3339 date-time",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ChangeSet {
    baseline: Baseline,
    changes: Vec<Change>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Change {
    path: RepoPath,
    kind: ChangeKind,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    from: Option<RepoPath>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    before: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    after: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ChangeKind {
    Create,
    Modify,
    Delete,
    Rename,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CanonicalParams {
    changeset: ChangeSet,
    scope: ScopeWire,
    comparison: WireComparison,
    #[serde(default, deserialize_with = "optional_non_null")]
    configuration: Option<Value>,
    #[serde(default)]
    diagnostic_sources: Vec<String>,
    #[serde(default)]
    rules: Vec<String>,
    #[serde(default, rename = "priorDiagnostics")]
    prior_diagnostics: Vec<prior::PriorDiagnostic>,
    #[serde(default, rename = "priorAssessments")]
    prior_assessments: Vec<prior::PriorAssessment>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum WireComparison {
    Introduced,
    All,
    Resolved,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum ScopeWire {
    Named(NamedScope),
    Paths(PathScope),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PathScope {
    paths: Vec<RepoPath>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum NamedScope {
    Changeset,
    Workspace,
}

impl ScopeWire {
    fn normalize(self) -> Result<Scope, RpcFailure> {
        match self {
            Self::Named(NamedScope::Changeset) => Ok(Scope::Changeset),
            Self::Named(NamedScope::Workspace) => Ok(Scope::Workspace),
            Self::Paths(PathScope { paths }) if paths.is_empty() => Err(RpcFailure::input(
                "path scope must contain at least one path",
            )),
            Self::Paths(PathScope { paths }) => {
                let unique: BTreeSet<_> = paths.iter().collect();
                if unique.len() != paths.len() {
                    return Err(RpcFailure::input("path scope contains duplicates"));
                }
                Ok(Scope::Paths { paths })
            }
        }
    }
}

struct NormalizedParams {
    changeset: ChangeSet,
    changeset_digest: String,
    scope: Scope,
    scope_json: Value,
    comparison: Comparison,
    requested_sources: Vec<String>,
    requested_rules: Vec<String>,
    configuration: configuration::Configuration,
}

struct UnsupportedParams {
    changeset_digest: String,
    scope_json: Value,
    comparison: WireComparison,
    requested_sources: Vec<String>,
    requested_rules: Vec<String>,
    configuration: configuration::Configuration,
}

enum NormalizedRequest {
    Supported(NormalizedParams),
    Unsupported(UnsupportedParams),
}

#[derive(Clone, Copy)]
struct RequestDeadline(Instant);

impl RequestDeadline {
    fn new(wallclock_ms: u64) -> Result<Self, RpcFailure> {
        Instant::now()
            .checked_add(Duration::from_millis(wallclock_ms))
            .map(Self)
            .ok_or_else(|| RpcFailure::policy("evaluation wallclock grant overflowed"))
    }

    fn remaining(self) -> Result<Duration, RpcFailure> {
        self.0
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| RpcFailure::unavailable("evaluation exceeded its wallclock grant"))
    }

    fn remaining_ms(self) -> Result<u64, RpcFailure> {
        let remaining = self.remaining()?;
        let millis = u64::try_from(remaining.as_millis()).unwrap_or(u64::MAX);
        Ok(millis.max(1))
    }

    fn work_timeout(self, reserve: Duration) -> Result<Duration, RpcFailure> {
        self.remaining()?
            .checked_sub(reserve)
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                RpcFailure::unavailable("insufficient wallclock remains for native cleanup")
            })
    }

    fn instant(self) -> Instant {
        self.0
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListTreeResult {
    entries: Vec<TreeEntry>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TreeEntry {
    path: RepoPath,
    blob_id: String,
    kind: EntryKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadBlobResult {
    blobs: Vec<BlobResult>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BlobResult {
    id: String,
    encoding: BlobEncoding,
    bytes: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BlobEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    Base64,
}

pub(crate) fn initialize_for(
    params: &Value,
    profile: ProviderProfile,
) -> Result<(Value, Value), RpcFailure> {
    let object = initialize_object(params)?;
    validate_initialize_host(object)?;
    let baseline_json = initialize_baseline(object)?;
    Ok((initialize_result(profile), baseline_json))
}

fn initialize_object(params: &Value) -> Result<&serde_json::Map<String, Value>, RpcFailure> {
    let object = params
        .as_object()
        .ok_or_else(|| RpcFailure::input("initialize params must be an object"))?;
    reject_keys(
        object,
        &[
            "protocolVersion",
            "host",
            "hostCapabilities",
            "workspace",
            "assuranceMode",
            "authorityMode",
            "trustTier",
        ],
    )?;
    if object.get("protocolVersion").and_then(Value::as_str) != Some(PROTOCOL_VERSION) {
        return Err(RpcFailure {
            code: -32014,
            message: "unsupported-version",
            fail_class: "contract",
            retryable: false,
            detail: format!("only {PROTOCOL_VERSION} is supported"),
        });
    }
    if object
        .get("hostCapabilities")
        .is_some_and(|value| !value.is_object())
    {
        return Err(RpcFailure::input("hostCapabilities must be an object"));
    }
    for field in ["assuranceMode", "authorityMode"] {
        if let Some(value) = object.get(field) {
            validate_enum_value(
                value,
                &["advisory", "gated", "mediated-write", "isolated"],
                field,
            )?;
        }
    }
    if let Some(value) = object.get("trustTier") {
        validate_enum_value(
            value,
            &["first-party", "certified", "untrusted"],
            "trustTier",
        )?;
    }
    Ok(object)
}

fn validate_enum_value(value: &Value, choices: &[&str], field: &str) -> Result<(), RpcFailure> {
    if value.as_str().is_some_and(|value| choices.contains(&value)) {
        Ok(())
    } else {
        Err(RpcFailure::input(format!("{field} is invalid")))
    }
}

fn validate_initialize_host(object: &serde_json::Map<String, Value>) -> Result<(), RpcFailure> {
    let host = object
        .get("host")
        .and_then(Value::as_object)
        .ok_or_else(|| RpcFailure::input("initialize.host is required"))?;
    if host.get("name").and_then(Value::as_str).is_none()
        || host.get("version").and_then(Value::as_str).is_none()
    {
        return Err(RpcFailure::input(
            "initialize.host requires name and version",
        ));
    }
    Ok(())
}

fn initialize_baseline(object: &serde_json::Map<String, Value>) -> Result<Value, RpcFailure> {
    let workspace = object
        .get("workspace")
        .and_then(Value::as_object)
        .ok_or_else(|| RpcFailure::input("initialize.workspace is required"))?;
    if workspace.get("root").and_then(Value::as_str).is_none() {
        return Err(RpcFailure::input("initialize.workspace.root is required"));
    }
    let baseline: Baseline = serde_json::from_value(
        workspace
            .get("baseline")
            .cloned()
            .ok_or_else(|| RpcFailure::input("initialize.workspace.baseline is required"))?,
    )
    .map_err(|error| RpcFailure::input(format!("invalid initialize baseline: {error}")))?;
    baseline.validate_timestamp()?;
    let baseline_json = serde_json::to_value(&baseline)
        .map_err(|error| RpcFailure::input(format!("cannot serialize baseline: {error}")))?;
    Ok(baseline_json)
}

fn initialize_result(profile: ProviderProfile) -> Value {
    let provider_id = profile.provider_id();
    let scopes = match profile {
        ProviderProfile::Fast => json!(["changeset", "workspace"]),
        ProviderProfile::RustNative
        | ProviderProfile::NodeNative
        | ProviderProfile::PythonNative => json!(["workspace"]),
    };
    json!({
        "serverInfo": { "name": provider_id, "version": env!("CARGO_PKG_VERSION"), "fingerprint": build_digest() },
        "capabilityFamilies": ["check"],
        "roles": ["judge"],
        "capabilities": {
            "check": {
                "capabilityVersion": CAPABILITY_VERSION,
                "diagnosticSources": [provider_id],
                "scopes": scopes,
                "comparisons": ["introduced", "all"],
                "partialResults": false,
                "incremental": false,
                "unsupportedReporting": "assessment-status",
                "fixes": false
            },
            "transport": ["stdio"]
        },
        "requestedPermissions": { "read": ["**/*"], "write": false, "network": false },
        "provenance": { "publisher": "the-open-engine" }
    })
}

pub fn initialized(params: &Value, expected_baseline: &Value) -> Result<AspSession, RpcFailure> {
    let object = params
        .as_object()
        .ok_or_else(|| RpcFailure::input("initialized params must be an object"))?;
    reject_keys(object, &["grantedPermissions", "baseline"])?;
    let baseline = initialized_baseline(object, expected_baseline)?;
    let permissions = object
        .get("grantedPermissions")
        .and_then(Value::as_object)
        .ok_or_else(|| RpcFailure::input("initialized.grantedPermissions is required"))?;
    validate_permissions(permissions)?;
    let wallclock_ms = granted_wallclock(permissions)?;
    Ok(AspSession {
        baseline: baseline.clone(),
        wallclock_ms,
        initialized_grant: Value::Object(permissions.clone()),
    })
}

fn initialized_baseline<'a>(
    object: &'a serde_json::Map<String, Value>,
    expected: &Value,
) -> Result<&'a Value, RpcFailure> {
    let baseline = object
        .get("baseline")
        .ok_or_else(|| RpcFailure::input("initialized.baseline is required"))?;
    let parsed: Baseline = serde_json::from_value(baseline.clone())
        .map_err(|error| RpcFailure::input(format!("invalid initialized baseline: {error}")))?;
    parsed.validate_timestamp()?;
    if canonical_json(baseline)? != canonical_json(expected)? {
        return Err(RpcFailure::health(
            "initialized baseline differs from initialize baseline",
        ));
    }
    Ok(baseline)
}

fn validate_permissions(permissions: &serde_json::Map<String, Value>) -> Result<(), RpcFailure> {
    reject_keys(
        permissions,
        &[
            "read",
            "write",
            "network",
            "networkAllowlist",
            "resourceLimits",
        ],
    )?;
    validate_denied_permission(permissions, "write")?;
    validate_denied_permission(permissions, "network")?;
    validate_network_allowlist(permissions.get("networkAllowlist"))?;
    match permissions.get("read") {
        Some(Value::Array(values)) if values.iter().all(Value::is_string) => {}
        Some(Value::Array(_)) => {
            return Err(RpcFailure::input("granted read entries must be strings"));
        }
        None => {}
        _ => {
            return Err(RpcFailure::input(
                "granted read permission must be an array",
            ));
        }
    }
    Ok(())
}

fn validate_network_allowlist(value: Option<&Value>) -> Result<(), RpcFailure> {
    let Some(value) = value else {
        return Ok(());
    };
    let entries = value
        .as_array()
        .ok_or_else(|| RpcFailure::input("networkAllowlist must be an array"))?;
    for entry in entries {
        let entry = entry
            .as_object()
            .ok_or_else(|| RpcFailure::input("networkAllowlist entries must be objects"))?;
        reject_keys(entry, &["host", "port", "proto"])?;
        if entry.get("host").and_then(Value::as_str).is_none() {
            return Err(RpcFailure::input(
                "networkAllowlist entry requires a string host",
            ));
        }
        if entry.get("port").is_some_and(|port| !port.is_i64()) {
            return Err(RpcFailure::input(
                "networkAllowlist port must be an integer",
            ));
        }
        if let Some(proto) = entry.get("proto") {
            validate_enum_value(proto, &["https", "http", "tcp"], "networkAllowlist proto")?;
        }
    }
    Ok(())
}

fn validate_denied_permission(
    permissions: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<(), RpcFailure> {
    match permissions.get(name) {
        None | Some(Value::Bool(false)) => Ok(()),
        Some(Value::Bool(true)) => Err(RpcFailure::policy(format!(
            "provider cannot accept {name} permission"
        ))),
        Some(_) => Err(RpcFailure::input(format!(
            "granted {name} permission must be a boolean"
        ))),
    }
}

fn granted_wallclock(permissions: &serde_json::Map<String, Value>) -> Result<u64, RpcFailure> {
    let limits = permissions
        .get("resourceLimits")
        .and_then(Value::as_object)
        .ok_or_else(|| RpcFailure::input("initialized resourceLimits are required"))?;
    reject_keys(limits, &["cpuPct", "memoryMb", "wallclockMs", "fd"])?;
    if limits.values().any(|value| !value.is_u64()) {
        return Err(RpcFailure::input(
            "resource limits must be non-negative integers",
        ));
    }
    let wallclock_ms = limits
        .get("wallclockMs")
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .min(300_000);
    if wallclock_ms == 0 {
        return Err(RpcFailure::policy(
            "initialized wallclockMs grant must permit at least one millisecond",
        ));
    }
    Ok(wallclock_ms)
}

pub fn baseline_changed(params: &Value) -> Result<Value, RpcFailure> {
    let object = params
        .as_object()
        .ok_or_else(|| RpcFailure::input("workspace/baselineChanged params must be an object"))?;
    reject_keys(object, &["baseline"])?;
    let baseline = object
        .get("baseline")
        .cloned()
        .ok_or_else(|| RpcFailure::input("workspace/baselineChanged.baseline is required"))?;
    let parsed: Baseline = serde_json::from_value(baseline.clone())
        .map_err(|error| RpcFailure::input(format!("invalid changed baseline: {error}")))?;
    parsed.validate_timestamp()?;
    Ok(baseline)
}

#[cfg(test)]
async fn evaluate(
    params: Value,
    session: AspSession,
    host: &dyn AspHost,
    engine: &Engine,
    cancel: CancelToken,
) -> Result<Value, RpcFailure> {
    evaluate_for(
        params,
        session,
        ProviderProfile::Fast,
        EvaluationRuntime {
            host,
            engine,
            cancel,
            project_root: None,
        },
    )
    .await
}

pub(crate) struct EvaluationRuntime<'a> {
    pub(crate) host: &'a dyn AspHost,
    pub(crate) engine: &'a Engine,
    pub(crate) cancel: CancelToken,
    pub(crate) project_root: Option<RepoPath>,
}

pub(crate) async fn evaluate_for(
    params: Value,
    session: AspSession,
    profile: ProviderProfile,
    runtime: EvaluationRuntime<'_>,
) -> Result<Value, RpcFailure> {
    let deadline = RequestDeadline::new(session.wallclock_ms)?;
    let normalized = match normalize_params_for(params, &session, profile)? {
        NormalizedRequest::Supported(params) => params,
        NormalizedRequest::Unsupported(params) => {
            return Ok(unsupported_comparison_assessment(
                &params, &session, profile,
            ));
        }
    };
    ensure_not_cancelled(&runtime.cancel)?;
    if matches!(normalized.scope, Scope::Workspace) && !has_full_workspace_read(&session) {
        return Ok(unsupported_normalized_assessment(
            &normalized,
            &session,
            profile,
            "workspace scope requires the exact full-workspace read grant",
        ));
    }
    if profile.is_native() {
        return native_provider::evaluate(native_provider::NativeEvaluation {
            params: normalized,
            session,
            profile,
            host: runtime.host,
            cancel: runtime.cancel,
            deadline,
            project_root: runtime.project_root,
        })
        .await;
    }
    evaluate_fast(normalized, &session, runtime, deadline).await
}

async fn evaluate_fast(
    normalized: NormalizedParams,
    session: &AspSession,
    runtime: EvaluationRuntime<'_>,
    deadline: RequestDeadline,
) -> Result<Value, RpcFailure> {
    let prepared = match prepare_views(
        &normalized,
        session,
        runtime.host,
        &runtime.cancel,
        deadline,
    )
    .await
    {
        Ok(prepared) => prepared,
        Err(WorkspaceFailure::Rpc(failure)) => return Err(failure),
        Err(WorkspaceFailure::Coverage(gap)) => {
            return Ok(workspace_gap_assessment(
                &normalized,
                session,
                ProviderProfile::Fast,
                &gap,
            ));
        }
    };
    ensure_not_cancelled(&runtime.cancel)?;
    let assessment = runtime
        .engine
        .evaluate(
            EvaluationRequest {
                before: Some(prepared.before),
                after: prepared.after,
                scope: normalized.scope.clone(),
                comparison: normalized.comparison,
                paths: prepared.paths,
                limits: normalized.configuration.verify,
                valid_as_of: normalized.changeset_digest.clone(),
                public_fingerprint_comparison: true,
            },
            runtime.cancel.clone(),
        )
        .await
        .map_err(|error| RpcFailure::unavailable(error.to_string()))?;
    if runtime.cancel.is_cancelled() || assessment.status == AssessmentStatus::Cancelled {
        return Err(RpcFailure::cancelled());
    }
    Ok(to_asp_assessment(
        assessment,
        &normalized,
        &prepared.read_ids,
        &session.baseline,
        &session.initialized_grant,
    ))
}

fn ensure_not_cancelled(cancel: &CancelToken) -> Result<(), RpcFailure> {
    if cancel.is_cancelled() {
        Err(RpcFailure::cancelled())
    } else {
        Ok(())
    }
}

fn has_full_workspace_read(session: &AspSession) -> bool {
    session
        .initialized_grant
        .get("read")
        .and_then(Value::as_array)
        .is_some_and(|read| read.as_slice() == [Value::String("**/*".into())])
}

#[cfg(test)]
fn normalize_params(value: Value, session: &AspSession) -> Result<NormalizedParams, RpcFailure> {
    match normalize_params_for(value, session, ProviderProfile::Fast)? {
        NormalizedRequest::Supported(params) => Ok(params),
        NormalizedRequest::Unsupported(_) => Err(RpcFailure::input(
            "comparison is unsupported by this test helper",
        )),
    }
}

fn normalize_params_for(
    value: Value,
    session: &AspSession,
    profile: ProviderProfile,
) -> Result<NormalizedRequest, RpcFailure> {
    let params = parse_canonical_params(value)?;
    let configuration = configuration::resolve(params.configuration.as_ref(), profile)?;
    let changeset = params.changeset;
    let scope = params.scope.normalize()?;
    let comparison = params.comparison;
    let sources = params.diagnostic_sources;
    let rules = params.rules;
    validate_request_inputs(&changeset, &sources, &rules, session)?;
    normalize_comparison(
        ComparisonInput {
            changeset,
            scope,
            comparison,
            sources,
            rules,
            configuration,
        },
        profile,
    )
}

fn parse_canonical_params(value: Value) -> Result<CanonicalParams, RpcFailure> {
    let params: CanonicalParams = serde_json::from_value(value)
        .map_err(|error| RpcFailure::input(format!("invalid check/evaluate request: {error}")))?;
    prior::validate(&params.prior_diagnostics, &params.prior_assessments)?;
    Ok(params)
}

fn optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn validate_request_inputs(
    changeset: &ChangeSet,
    sources: &[String],
    rules: &[String],
    session: &AspSession,
) -> Result<(), RpcFailure> {
    validate_request_names(sources, "diagnosticSources")?;
    validate_request_names(rules, "rules")?;
    validate_changeset(changeset)?;
    validate_active_baseline(&changeset.baseline, &session.baseline)
}

struct ComparisonInput {
    changeset: ChangeSet,
    scope: Scope,
    comparison: WireComparison,
    sources: Vec<String>,
    rules: Vec<String>,
    configuration: configuration::Configuration,
}

fn normalize_comparison(
    input: ComparisonInput,
    profile: ProviderProfile,
) -> Result<NormalizedRequest, RpcFailure> {
    let ComparisonInput {
        changeset,
        scope,
        comparison,
        sources,
        rules,
        configuration,
    } = input;
    let digest = digest_json(&serialize_input(&changeset, "changeset")?)?;
    let scope_json = scope_value(&scope);
    let requested_sources = default_request(sources, profile.provider_id());
    let requested_rules = default_request(rules, profile.rule());
    let comparison = match comparison {
        WireComparison::Introduced => Comparison::Introduced,
        WireComparison::All => Comparison::All,
        WireComparison::Resolved => {
            return Ok(NormalizedRequest::Unsupported(UnsupportedParams {
                changeset_digest: digest,
                scope_json,
                comparison,
                requested_sources,
                requested_rules,
                configuration,
            }));
        }
    };
    Ok(NormalizedRequest::Supported(NormalizedParams {
        changeset,
        changeset_digest: digest,
        scope,
        scope_json,
        comparison,
        requested_sources,
        requested_rules,
        configuration,
    }))
}

fn validate_request_names(values: &[String], label: &str) -> Result<(), RpcFailure> {
    if values.len() > MAX_FILES {
        return Err(RpcFailure::input(format!(
            "{label} exceeds {MAX_FILES} entries"
        )));
    }
    let unique = values.iter().collect::<BTreeSet<_>>();
    if unique.len() != values.len() {
        return Err(RpcFailure::input(format!("{label} contains duplicates")));
    }
    if values.iter().any(String::is_empty) {
        return Err(RpcFailure::input(format!(
            "{label} entries must not be empty"
        )));
    }
    Ok(())
}

fn unsupported_comparison_assessment(
    params: &UnsupportedParams,
    session: &AspSession,
    profile: ProviderProfile,
) -> Value {
    let detail = "resolved comparison is not supported by this provider";
    let config_digest = params.configuration.digest.clone();
    unsupported_for(params, session, profile, detail, config_digest)
}

fn unsupported_normalized_assessment(
    params: &NormalizedParams,
    session: &AspSession,
    profile: ProviderProfile,
    detail: &str,
) -> Value {
    let config_digest = params.configuration.digest.clone();
    unsupported_for(params, session, profile, detail, config_digest)
}

trait UnsupportedRequestView {
    fn scope_json(&self) -> &Value;
    fn comparison_json(&self) -> Value;
    fn requested_sources(&self) -> &[String];
    fn requested_rules(&self) -> &[String];
    fn changeset_digest(&self) -> &str;
}

macro_rules! impl_unsupported_request_view {
    ($params:ty) => {
        impl UnsupportedRequestView for $params {
            fn scope_json(&self) -> &Value {
                &self.scope_json
            }

            fn comparison_json(&self) -> Value {
                json!(self.comparison)
            }

            fn requested_sources(&self) -> &[String] {
                &self.requested_sources
            }

            fn requested_rules(&self) -> &[String] {
                &self.requested_rules
            }

            fn changeset_digest(&self) -> &str {
                &self.changeset_digest
            }
        }
    };
}

impl_unsupported_request_view!(UnsupportedParams);
impl_unsupported_request_view!(NormalizedParams);

fn unsupported_for<'a>(
    params: &'a impl UnsupportedRequestView,
    session: &'a AspSession,
    profile: ProviderProfile,
    detail: &'a str,
    config_digest: String,
) -> Value {
    coverage_gap_value(&CoverageGapInput {
        profile,
        session,
        scope: params.scope_json(),
        comparison: params.comparison_json(),
        requested_sources: params.requested_sources(),
        requested_rules: params.requested_rules(),
        changeset_digest: params.changeset_digest(),
        detail,
        config_digest,
        status: "unsupported",
        truncated: false,
    })
}

fn workspace_gap_assessment(
    params: &NormalizedParams,
    session: &AspSession,
    profile: ProviderProfile,
    gap: &WorkspaceGap,
) -> Value {
    let config_digest = params.configuration.digest.clone();
    coverage_gap_value(&CoverageGapInput {
        profile,
        session,
        scope: &params.scope_json,
        comparison: json!(params.comparison),
        requested_sources: &params.requested_sources,
        requested_rules: &params.requested_rules,
        changeset_digest: &params.changeset_digest,
        detail: &gap.detail,
        config_digest,
        status: gap.status,
        truncated: gap.truncated,
    })
}

struct CoverageGapInput<'a> {
    profile: ProviderProfile,
    session: &'a AspSession,
    scope: &'a Value,
    comparison: Value,
    requested_sources: &'a [String],
    requested_rules: &'a [String],
    changeset_digest: &'a str,
    detail: &'a str,
    config_digest: String,
    status: &'static str,
    truncated: bool,
}

fn coverage_gap_value(input: &CoverageGapInput<'_>) -> Value {
    let provider_id = input.profile.provider_id();
    let requested = unsupported_coverage_part(
        input.scope,
        &input.comparison,
        input.requested_sources,
        input.requested_rules,
    );
    let covered = unsupported_coverage_part(input.scope, &input.comparison, &[], &[]);
    let notice = coverage_notice(provider_id, input.status, input.detail);
    let unsupported = (input.status == "unsupported")
        .then(|| notice.clone())
        .into_iter()
        .collect::<Vec<_>>();
    json!({
        "status": input.status,
        "diagnostics": [],
        "evidence": [],
        "coverage": {
            "requested": requested,
            "covered": covered,
            "degraded": [notice.clone()],
            "unsupported": unsupported,
            "exhaustive": false,
            "truncated": input.truncated
        },
        "validAsOf": {
            "baseline": input.session.baseline,
            "changesetDigest": input.changeset_digest,
            "blobs": []
        },
        "provider": {
            "id": provider_id,
            "version": env!("CARGO_PKG_VERSION"),
            "configDigest": input.config_digest,
            "capabilityVersion": CAPABILITY_VERSION,
            "buildDigest": build_digest(),
            "capabilityFamily": "check"
        },
        "timing": { "elapsedMs": 0 },
        "cache": { "status": "disabled" }
    })
}

fn unsupported_coverage_part(
    scope: &Value,
    comparison: &Value,
    sources: &[String],
    rules: &[String],
) -> Value {
    json!({
        "scope": scope,
        "diagnosticSources": sources,
        "rules": rules,
        "comparison": comparison
    })
}

pub(super) fn coverage_notice(source: &str, reason: &str, detail: &str) -> Value {
    json!({
        "source": source,
        "reason": reason,
        "detail": detail,
        "capability": "check"
    })
}

fn validate_active_baseline(baseline: &Baseline, active: &Value) -> Result<(), RpcFailure> {
    let baseline_json = serialize_input(baseline, "baseline")?;
    if canonical_json(&baseline_json)? != canonical_json(active)? {
        return Err(RpcFailure::health(
            "request baseline differs from the active initialized baseline",
        ));
    }
    Ok(())
}

fn serialize_input<T: Serialize>(value: &T, name: &str) -> Result<Value, RpcFailure> {
    serde_json::to_value(value)
        .map_err(|error| RpcFailure::input(format!("cannot serialize {name}: {error}")))
}

fn scope_value(scope: &Scope) -> Value {
    match scope {
        Scope::Changeset => json!("changeset"),
        Scope::Workspace => json!("workspace"),
        Scope::Paths { paths } => json!({ "paths": paths }),
    }
}

fn default_request(values: Vec<String>, default: &str) -> Vec<String> {
    if values.is_empty() {
        vec![default.into()]
    } else {
        values
    }
}

fn validate_changeset(changeset: &ChangeSet) -> Result<(), RpcFailure> {
    changeset.baseline.validate_timestamp()?;
    if changeset.baseline.rev.is_empty() {
        return Err(RpcFailure::input("changeset baseline rev is empty"));
    }
    if changeset.changes.len() > MAX_FILES {
        return Err(RpcFailure::input(format!(
            "changeset exceeds {MAX_FILES} changes"
        )));
    }
    let mut destinations = BTreeSet::new();
    let mut sources = BTreeSet::new();
    for change in &changeset.changes {
        if !destinations.insert(change.path.clone()) {
            return Err(RpcFailure::input(format!(
                "duplicate change destination {}",
                change.path
            )));
        }
        validate_change(change, &mut sources)?;
    }
    if destinations.iter().any(|path| sources.contains(path)) {
        return Err(RpcFailure::input(
            "a path cannot be both a change destination and rename source",
        ));
    }
    Ok(())
}

pub(crate) fn is_rfc3339_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || !timestamp_separators(bytes) {
        return false;
    }
    let Some((year, month, day)) = timestamp_date(bytes) else {
        return false;
    };
    let Some((hour, minute, second)) = timestamp_time(bytes) else {
        return false;
    };
    valid_date(year, month, day)
        && valid_time(hour, minute, second)
        && valid_timestamp_suffix(bytes)
}

fn timestamp_separators(bytes: &[u8]) -> bool {
    bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && matches!(bytes.get(10), Some(b'T' | b't'))
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
}

fn timestamp_date(bytes: &[u8]) -> Option<(u32, u32, u32)> {
    Some((
        decimal(&bytes[0..4])?,
        decimal(&bytes[5..7])?,
        decimal(&bytes[8..10])?,
    ))
}

fn timestamp_time(bytes: &[u8]) -> Option<(u32, u32, u32)> {
    Some((
        decimal(&bytes[11..13])?,
        decimal(&bytes[14..16])?,
        decimal(&bytes[17..19])?,
    ))
}

fn valid_date(year: u32, month: u32, day: u32) -> bool {
    (1..=12).contains(&month) && day > 0 && day <= days_in_month(year, month)
}

fn valid_time(hour: u32, minute: u32, second: u32) -> bool {
    hour <= 23 && minute <= 59 && second <= 60
}

fn valid_timestamp_suffix(bytes: &[u8]) -> bool {
    let mut cursor = 19;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == fraction_start {
            return false;
        }
    }
    match bytes.get(cursor) {
        Some(b'Z' | b'z') => cursor + 1 == bytes.len(),
        Some(b'+' | b'-') if cursor + 6 == bytes.len() => {
            bytes.get(cursor + 3) == Some(&b':')
                && decimal(&bytes[cursor + 1..cursor + 3]).is_some_and(|value| value <= 23)
                && decimal(&bytes[cursor + 4..cursor + 6]).is_some_and(|value| value <= 59)
        }
        _ => false,
    }
}

fn decimal(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0_u32, |value, digit| {
        digit
            .is_ascii_digit()
            .then(|| value * 10 + u32::from(*digit - b'0'))
    })
}

const fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn validate_change(change: &Change, sources: &mut BTreeSet<RepoPath>) -> Result<(), RpcFailure> {
    let shape = (
        change.before.is_some(),
        change.after.is_some(),
        change.from.is_some(),
    );
    match (change.kind, shape) {
        (ChangeKind::Create, (false, true, false))
        | (ChangeKind::Modify, (true, true, false))
        | (ChangeKind::Delete, (true, false, false)) => {}
        (ChangeKind::Rename, (true, _, true)) => validate_rename(change, sources)?,
        _ => return Err(illegal_change(change)),
    }
    validate_optional_blob(change.before.as_deref())?;
    validate_optional_blob(change.after.as_deref())
}

fn validate_rename(change: &Change, sources: &mut BTreeSet<RepoPath>) -> Result<(), RpcFailure> {
    let Some(from) = change.from.as_ref() else {
        return Err(illegal_change(change));
    };
    if from == &change.path {
        return Err(RpcFailure::input(
            "rename source and destination are identical",
        ));
    }
    if !sources.insert(from.clone()) {
        return Err(RpcFailure::input(format!("duplicate rename source {from}")));
    }
    Ok(())
}

fn illegal_change(change: &Change) -> RpcFailure {
    RpcFailure::input(format!(
        "illegal fields for {:?} change at {}",
        change.kind, change.path
    ))
}

fn validate_optional_blob(blob: Option<&str>) -> Result<(), RpcFailure> {
    blob.map_or(Ok(()), validate_blob_ref)
}

fn validate_blob_ref(value: &str) -> Result<(), RpcFailure> {
    let Some(rest) = value.strip_prefix("blob:") else {
        return Err(RpcFailure::input(format!("invalid blob ref {value}")));
    };
    let Some((algorithm, digest)) = rest.split_once(':') else {
        return Err(RpcFailure::input(format!("invalid blob ref {value}")));
    };
    if algorithm.is_empty()
        || !algorithm
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        || digest.is_empty()
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(RpcFailure::input(format!("invalid blob ref {value}")));
    }
    Ok(())
}

fn verify_blob(reference: &str, bytes: &[u8]) -> Result<(), RpcFailure> {
    let Some(rest) = reference.strip_prefix("blob:") else {
        return Err(RpcFailure::input(format!("invalid blob ref {reference}")));
    };
    let Some((algorithm, expected)) = rest.split_once(':') else {
        return Err(RpcFailure::input(format!("invalid blob ref {reference}")));
    };
    if algorithm != "sha256" {
        return Err(RpcFailure::unavailable(format!(
            "unsupported blob digest algorithm {algorithm}"
        )));
    }
    let actual = hex::encode(Sha256::digest(bytes));
    if actual != expected {
        return Err(RpcFailure::unavailable(format!(
            "blob hash mismatch for {reference}"
        )));
    }
    Ok(())
}

fn canonical_json(value: &Value) -> Result<Vec<u8>, RpcFailure> {
    serde_json::to_vec(value)
        .map_err(|error| RpcFailure::input(format!("cannot canonicalize JSON: {error}")))
}

fn digest_json(value: &Value) -> Result<String, RpcFailure> {
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical_json(value)?))
    ))
}

#[must_use]
pub fn build_digest() -> String {
    env!("OPCORE_BUILD_DIGEST").into()
}

fn reject_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), RpcFailure> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(RpcFailure::input(format!("unsupported field {key}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
