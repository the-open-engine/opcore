//! Strict validation for bundled-provider initialization and assessments.

use std::collections::BTreeSet;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    limits::MAX_DIAGNOSTICS,
    path::RepoPath,
    protocol::asp::{CAPABILITY_VERSION, ProviderProfile, build_digest, is_rfc3339_timestamp},
};

use super::{HostRequest, exact_object};

pub(super) fn validate_initialize_result(result: &Value, profile: ProviderProfile) -> Result<()> {
    required_object(
        result,
        &[
            "serverInfo",
            "capabilityFamilies",
            "roles",
            "capabilities",
            "requestedPermissions",
            "provenance",
        ],
        &[
            "serverInfo",
            "capabilityFamilies",
            "capabilities",
            "requestedPermissions",
        ],
        "provider initialize result",
    )?;
    validate_server_info(result, profile)?;
    require_exact_strings(
        result.get("capabilityFamilies"),
        &["check"],
        "provider capabilityFamilies",
    )?;
    validate_check_capability(result, profile)?;
    validate_requested_permissions(result)?;
    validate_initialize_metadata(result)
}

fn validate_initialize_metadata(result: &Value) -> Result<()> {
    if let Some(roles) = result.get("roles") {
        require_exact_strings(Some(roles), &["judge"], "provider roles")?;
    }
    if let Some(provenance) = result.get("provenance") {
        let provenance = required_object(
            provenance,
            &["publisher", "signature"],
            &[],
            "provider provenance",
        )?;
        if let Some(publisher) = provenance.get("publisher") {
            require_equal_string(Some(publisher), "the-open-engine", "provider publisher")?;
        }
        if let Some(signature) = provenance.get("signature") {
            require_nonempty_string(Some(signature), "provider signature")?;
        }
    }
    Ok(())
}

fn validate_server_info(result: &Value, profile: ProviderProfile) -> Result<()> {
    let info = required_object(
        result.get("serverInfo").unwrap_or(&Value::Null),
        &["name", "version", "fingerprint"],
        &["name", "version", "fingerprint"],
        "provider serverInfo",
    )?;
    require_equal_string(info.get("name"), profile.provider_id(), "provider name")?;
    require_equal_string(
        info.get("version"),
        env!("CARGO_PKG_VERSION"),
        "provider version",
    )?;
    require_equal_string(
        info.get("fingerprint"),
        &build_digest(),
        "provider build fingerprint",
    )
}

fn validate_check_capability(result: &Value, profile: ProviderProfile) -> Result<()> {
    let check = check_capability(result)?;
    validate_check_identity(check, profile)?;
    validate_check_behavior(check)
}

fn check_capability(result: &Value) -> Result<&serde_json::Map<String, Value>> {
    let capabilities = required_object(
        result.get("capabilities").unwrap_or(&Value::Null),
        &["check", "transport"],
        &["check", "transport"],
        "provider capabilities",
    )?;
    let check = required_object(
        capabilities.get("check").unwrap_or(&Value::Null),
        &[
            "capabilityVersion",
            "diagnosticSources",
            "scopes",
            "comparisons",
            "partialResults",
            "incremental",
            "unsupportedReporting",
            "fixes",
        ],
        &[
            "capabilityVersion",
            "diagnosticSources",
            "scopes",
            "comparisons",
            "partialResults",
            "incremental",
            "unsupportedReporting",
        ],
        "provider check capability",
    )?;
    require_exact_strings(
        capabilities.get("transport"),
        &["stdio"],
        "provider transports",
    )?;
    Ok(check)
}

fn validate_check_identity(
    check: &serde_json::Map<String, Value>,
    profile: ProviderProfile,
) -> Result<()> {
    require_equal_string(
        check.get("capabilityVersion"),
        CAPABILITY_VERSION,
        "provider capability version",
    )?;
    require_exact_strings(
        check.get("diagnosticSources"),
        &[profile.provider_id()],
        "provider diagnostic sources",
    )?;
    let scopes = match profile {
        ProviderProfile::Fast => &["changeset", "workspace"][..],
        ProviderProfile::RustNative
        | ProviderProfile::NodeNative
        | ProviderProfile::PythonNative => &["workspace"][..],
    };
    require_exact_strings(check.get("scopes"), scopes, "provider scopes")
}

fn validate_check_behavior(check: &serde_json::Map<String, Value>) -> Result<()> {
    require_exact_strings(
        check.get("comparisons"),
        &["introduced", "all"],
        "provider comparisons",
    )?;
    require_equal_bool(check.get("partialResults"), false, "partialResults")?;
    require_equal_bool(check.get("incremental"), false, "incremental")?;
    require_equal_string(
        check.get("unsupportedReporting"),
        "assessment-status",
        "unsupported reporting",
    )?;
    require_equal_bool(check.get("fixes"), false, "fixes")?;
    Ok(())
}

fn validate_requested_permissions(result: &Value) -> Result<()> {
    let permissions = required_object(
        result.get("requestedPermissions").unwrap_or(&Value::Null),
        &["read", "write", "network"],
        &["read", "write", "network"],
        "provider requestedPermissions",
    )?;
    require_exact_strings(
        permissions.get("read"),
        &["**/*"],
        "provider requested read paths",
    )?;
    require_equal_bool(permissions.get("write"), false, "requested write")?;
    require_equal_bool(permissions.get("network"), false, "requested network")
}

pub(super) fn validate_assessment(
    mut assessment: Value,
    request: &HostRequest,
    profile: ProviderProfile,
    read_blobs: &BTreeSet<String>,
) -> Result<Value> {
    {
        let object = assessment_object(&assessment)?;
        if contains_host_owned_field(&assessment) {
            bail!("provider assessment contains a host-owned field");
        }
        validate_assessment_content(object, request, profile)?;
        validate_assessment_metadata(object, request, profile, read_blobs)?;
    }
    stamp_diagnostic_sources(&mut assessment, profile.provider_id());
    Ok(assessment)
}

fn assessment_object(value: &Value) -> Result<&serde_json::Map<String, Value>> {
    required_object(
        value,
        &[
            "status",
            "diagnostics",
            "evidence",
            "coverage",
            "validAsOf",
            "provider",
            "timing",
            "cache",
        ],
        &[
            "status",
            "diagnostics",
            "coverage",
            "validAsOf",
            "provider",
            "timing",
            "cache",
        ],
        "provider assessment",
    )
}

fn validate_assessment_content(
    object: &serde_json::Map<String, Value>,
    request: &HostRequest,
    profile: ProviderProfile,
) -> Result<()> {
    let status = assessment_status(object.get("status"))?;
    let expected_coverage = expected_coverage_part(request, profile)?;
    let diagnostic_paths = requested_diagnostic_paths(request)?;
    validate_diagnostics(
        object.get("diagnostics"),
        profile,
        &expected_coverage["comparison"],
        &diagnostic_paths,
    )?;
    validate_evidence(object.get("evidence"))?;
    validate_coverage(
        object.get("coverage"),
        status,
        &expected_coverage,
        profile.provider_id(),
    )?;
    Ok(())
}

fn validate_assessment_metadata(
    object: &serde_json::Map<String, Value>,
    request: &HostRequest,
    profile: ProviderProfile,
    read_blobs: &BTreeSet<String>,
) -> Result<()> {
    validate_freshness(object.get("validAsOf"), request, read_blobs)?;
    validate_provider(object.get("provider"), profile, request)?;
    validate_timing(object.get("timing"))?;
    validate_cache(object.get("cache"))?;
    Ok(())
}

fn assessment_status(value: Option<&Value>) -> Result<&str> {
    let status = value
        .and_then(Value::as_str)
        .context("provider assessment status must be a string")?;
    if ![
        "complete",
        "incomplete",
        "unsupported",
        "error",
        "cancelled",
    ]
    .contains(&status)
    {
        bail!("provider assessment status is unknown");
    }
    Ok(status)
}

fn expected_coverage_part(request: &HostRequest, profile: ProviderProfile) -> Result<Value> {
    let params = request
        .evaluation_params
        .as_object()
        .context("check/evaluate params must remain an object")?;
    let sources = request_strings(
        params.get("diagnosticSources"),
        profile.provider_id(),
        "requested diagnosticSources",
    )?;
    let rules = request_strings(params.get("rules"), profile.rule(), "requested rules")?;
    let scope = params
        .get("scope")
        .context("check/evaluate scope is missing")?;
    let comparison = params
        .get("comparison")
        .context("check/evaluate comparison is missing")?;
    Ok(json!({
        "scope": scope,
        "diagnosticSources": sources,
        "rules": rules,
        "comparison": comparison
    }))
}

fn request_strings(value: Option<&Value>, default: &str, label: &str) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(vec![default.to_owned()]);
    };
    let values = string_set(Some(value), label)?;
    if values.is_empty() {
        Ok(vec![default.to_owned()])
    } else {
        Ok(values.into_iter().collect())
    }
}

fn validate_diagnostics(
    value: Option<&Value>,
    profile: ProviderProfile,
    comparison: &Value,
    allowed_paths: &BTreeSet<RepoPath>,
) -> Result<()> {
    let diagnostics = value
        .and_then(Value::as_array)
        .context("provider diagnostics must be an array")?;
    if diagnostics.len() > MAX_DIAGNOSTICS {
        bail!("provider diagnostics exceed {MAX_DIAGNOSTICS} findings");
    }
    for diagnostic in diagnostics {
        validate_diagnostic(diagnostic, profile, comparison, allowed_paths)?;
    }
    Ok(())
}

fn validate_diagnostic(
    value: &Value,
    profile: ProviderProfile,
    comparison: &Value,
    allowed_paths: &BTreeSet<RepoPath>,
) -> Result<()> {
    let diagnostic = required_object(
        value,
        &[
            "code",
            "severity",
            "source",
            "message",
            "location",
            "fingerprint",
            "introduced",
            "help",
            "codeDescription",
        ],
        &[
            "code",
            "severity",
            "source",
            "message",
            "location",
            "fingerprint",
        ],
        "provider diagnostic",
    )?;
    validate_diagnostic_identity(diagnostic, profile)?;
    validate_diagnostic_message(diagnostic)?;
    validate_location(diagnostic.get("location"), allowed_paths)?;
    validate_diagnostic_options(diagnostic)?;
    validate_introduced(diagnostic.get("introduced"), comparison)
}

fn validate_diagnostic_identity(
    diagnostic: &serde_json::Map<String, Value>,
    profile: ProviderProfile,
) -> Result<()> {
    require_prefixed_string(
        diagnostic.get("code"),
        &format!("{}/", profile.provider_id()),
        "diagnostic code",
    )?;
    require_equal_string(
        diagnostic.get("source"),
        profile.provider_id(),
        "diagnostic source",
    )?;
    require_one_of_strings(
        diagnostic.get("severity"),
        &["error", "warning", "info"],
        "diagnostic severity",
    )
}

fn validate_diagnostic_message(diagnostic: &serde_json::Map<String, Value>) -> Result<()> {
    require_nonempty_string(diagnostic.get("message"), "diagnostic message")?;
    require_nonempty_string(diagnostic.get("fingerprint"), "diagnostic fingerprint")
}

fn validate_diagnostic_options(diagnostic: &serde_json::Map<String, Value>) -> Result<()> {
    if let Some(help) = diagnostic.get("help") {
        require_nonempty_string(Some(help), "diagnostic help")?;
    }
    if let Some(description) = diagnostic.get("codeDescription") {
        let description =
            required_object(description, &["href"], &[], "diagnostic codeDescription")?;
        if let Some(href) = description.get("href") {
            require_nonempty_string(Some(href), "diagnostic codeDescription href")?;
        }
    }
    Ok(())
}

fn validate_introduced(value: Option<&Value>, comparison: &Value) -> Result<()> {
    match comparison.as_str() {
        Some("introduced") if value.and_then(Value::as_bool) == Some(true) => Ok(()),
        Some("introduced") => bail!("introduced diagnostic must be marked introduced"),
        Some("all") if value.is_none() || value.and_then(Value::as_bool) == Some(false) => Ok(()),
        Some("all") => bail!("all-comparison diagnostic cannot be marked introduced"),
        Some("resolved") => bail!("unsupported resolved assessment cannot contain diagnostics"),
        _ => bail!("provider assessment comparison is invalid"),
    }
}

fn validate_location(value: Option<&Value>, allowed_paths: &BTreeSet<RepoPath>) -> Result<()> {
    let location = required_object(
        value.unwrap_or(&Value::Null),
        &["path", "range"],
        &["path"],
        "diagnostic location",
    )?;
    let path = location
        .get("path")
        .and_then(Value::as_str)
        .context("diagnostic location path must be a string")?;
    let path = RepoPath::from_protocol(path).context("diagnostic location path is invalid")?;
    if !allowed_paths.contains(&path) {
        bail!("diagnostic location is outside the requested candidate scope");
    }
    if let Some(range) = location.get("range") {
        validate_range(range)?;
    }
    Ok(())
}

fn requested_diagnostic_paths(request: &HostRequest) -> Result<BTreeSet<RepoPath>> {
    let mut candidate = request
        .workspace
        .entries
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let changes = request
        .evaluation_params
        .pointer("/changeset/changes")
        .and_then(Value::as_array)
        .context("check/evaluate changes must be an array")?;
    let mut changed_after = BTreeSet::new();
    for change in changes {
        apply_candidate_change(change, &mut candidate, &mut changed_after)?;
    }
    select_requested_paths(
        request.evaluation_params.get("scope"),
        candidate,
        changed_after,
    )
}

fn apply_candidate_change(
    change: &Value,
    candidate: &mut BTreeSet<RepoPath>,
    changed_after: &mut BTreeSet<RepoPath>,
) -> Result<()> {
    let (object, path, kind) = parse_candidate_change(change)?;
    match kind {
        "create" | "modify" => add_candidate_path(candidate, changed_after, path),
        "delete" => {
            candidate.remove(&path);
        }
        "rename" => apply_candidate_rename(object, candidate, changed_after, path)?,
        _ => bail!("check/evaluate change kind is invalid"),
    }
    Ok(())
}

fn parse_candidate_change(
    change: &Value,
) -> Result<(&serde_json::Map<String, Value>, RepoPath, &str)> {
    let object = change
        .as_object()
        .context("check/evaluate change must be an object")?;
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .context("check/evaluate change path must be a string")?;
    let path = RepoPath::from_protocol(path).context("check/evaluate change path is invalid")?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .context("check/evaluate change kind is invalid")?;
    Ok((object, path, kind))
}

fn add_candidate_path(
    candidate: &mut BTreeSet<RepoPath>,
    changed_after: &mut BTreeSet<RepoPath>,
    path: RepoPath,
) {
    candidate.insert(path.clone());
    changed_after.insert(path);
}

fn apply_candidate_rename(
    object: &serde_json::Map<String, Value>,
    candidate: &mut BTreeSet<RepoPath>,
    changed_after: &mut BTreeSet<RepoPath>,
    path: RepoPath,
) -> Result<()> {
    let from = object
        .get("from")
        .and_then(Value::as_str)
        .context("rename change requires from")?;
    let from = RepoPath::from_protocol(from).context("rename source path is invalid")?;
    candidate.remove(&from);
    add_candidate_path(candidate, changed_after, path);
    Ok(())
}

fn select_requested_paths(
    scope: Option<&Value>,
    candidate: BTreeSet<RepoPath>,
    changed_after: BTreeSet<RepoPath>,
) -> Result<BTreeSet<RepoPath>> {
    match scope {
        Some(Value::String(scope)) if scope == "workspace" => Ok(candidate),
        Some(Value::String(scope)) if scope == "changeset" => Ok(changed_after),
        Some(Value::Object(scope)) => requested_path_subset(scope, &candidate),
        _ => bail!("check/evaluate scope is invalid"),
    }
}

fn requested_path_subset(
    scope: &serde_json::Map<String, Value>,
    candidate: &BTreeSet<RepoPath>,
) -> Result<BTreeSet<RepoPath>> {
    let paths = scope
        .get("paths")
        .and_then(Value::as_array)
        .context("path scope requires paths")?;
    let mut allowed = BTreeSet::new();
    for path in paths {
        let path = path
            .as_str()
            .context("path scope entries must be strings")?;
        let path = RepoPath::from_protocol(path).context("path scope entry is invalid")?;
        if candidate.contains(&path) {
            allowed.insert(path);
        }
    }
    Ok(allowed)
}

fn validate_range(value: &Value) -> Result<()> {
    let range = required_object(
        value,
        &["start", "end"],
        &["start", "end"],
        "diagnostic range",
    )?;
    validate_position(range.get("start"), "diagnostic range start")?;
    validate_position(range.get("end"), "diagnostic range end")
}

fn validate_position(value: Option<&Value>, label: &str) -> Result<()> {
    let position = required_object(
        value.unwrap_or(&Value::Null),
        &["line", "char"],
        &["line", "char"],
        label,
    )?;
    if position.get("line").and_then(Value::as_u64).is_none()
        || position.get("char").and_then(Value::as_u64).is_none()
    {
        bail!("{label} line and char must be non-negative integers");
    }
    Ok(())
}

fn validate_evidence(value: Option<&Value>) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let evidence = value
        .as_array()
        .context("provider evidence must be an array")?;
    for item in evidence {
        let item = required_object(
            item,
            &["kind", "id", "digest", "uri", "message", "data"],
            &["kind"],
            "provider evidence item",
        )?;
        require_one_of_strings(
            item.get("kind"),
            &["trace", "artifact", "metric", "message", "reference"],
            "provider evidence kind",
        )?;
        for field in ["id", "digest", "uri", "message"] {
            if let Some(value) = item.get(field) {
                require_nonempty_string(Some(value), "provider evidence string")?;
            }
        }
        if item.get("data").is_some_and(|data| !data.is_object()) {
            bail!("provider evidence data must be an object");
        }
    }
    Ok(())
}

fn validate_coverage(
    value: Option<&Value>,
    status: &str,
    expected: &Value,
    provider_id: &str,
) -> Result<()> {
    let coverage = coverage_object(value)?;
    validate_coverage_claims(coverage, expected, provider_id)?;
    let (exhaustive, truncated) = coverage_flags(coverage)?;
    validate_coverage_status(coverage, expected, status, exhaustive, truncated)
}

fn coverage_object(value: Option<&Value>) -> Result<&serde_json::Map<String, Value>> {
    required_object(
        value.unwrap_or(&Value::Null),
        &[
            "requested",
            "covered",
            "degraded",
            "unsupported",
            "exhaustive",
            "truncated",
        ],
        &[
            "requested",
            "covered",
            "degraded",
            "unsupported",
            "exhaustive",
            "truncated",
        ],
        "provider coverage",
    )
}

fn validate_coverage_claims(
    coverage: &serde_json::Map<String, Value>,
    expected: &Value,
    provider_id: &str,
) -> Result<()> {
    validate_coverage_part(coverage.get("requested"), "requested coverage")?;
    validate_coverage_part(coverage.get("covered"), "covered coverage")?;
    if coverage.get("requested") != Some(expected) {
        bail!("provider requested coverage does not echo the host request");
    }
    validate_degradations(coverage.get("degraded"), "coverage degraded", provider_id)?;
    validate_degradations(
        coverage.get("unsupported"),
        "coverage unsupported",
        provider_id,
    )?;
    Ok(())
}

fn coverage_flags(coverage: &serde_json::Map<String, Value>) -> Result<(bool, bool)> {
    let exhaustive = coverage
        .get("exhaustive")
        .and_then(Value::as_bool)
        .context("coverage exhaustive must be a boolean")?;
    let truncated = coverage
        .get("truncated")
        .and_then(Value::as_bool)
        .context("coverage truncated must be a boolean")?;
    Ok((exhaustive, truncated))
}

fn validate_coverage_status(
    coverage: &serde_json::Map<String, Value>,
    expected: &Value,
    status: &str,
    exhaustive: bool,
    truncated: bool,
) -> Result<()> {
    if status == "complete" {
        validate_complete_coverage(coverage, expected, exhaustive, truncated)?;
    } else if exhaustive {
        bail!("non-complete assessment cannot claim exhaustive coverage");
    }
    Ok(())
}

fn validate_complete_coverage(
    coverage: &serde_json::Map<String, Value>,
    expected: &Value,
    exhaustive: bool,
    truncated: bool,
) -> Result<()> {
    if !exhaustive || truncated || coverage.get("covered") != Some(expected) {
        bail!("complete assessment did not cover the exact requested scope");
    }
    for field in ["degraded", "unsupported"] {
        if !coverage
            .get(field)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            bail!("complete assessment contains degraded coverage");
        }
    }
    Ok(())
}

fn validate_coverage_part(value: Option<&Value>, label: &str) -> Result<()> {
    let part = required_object(
        value.unwrap_or(&Value::Null),
        &["scope", "diagnosticSources", "rules", "comparison"],
        &["scope", "diagnosticSources", "rules", "comparison"],
        label,
    )?;
    validate_scope(part.get("scope"), label)?;
    string_set(part.get("diagnosticSources"), label)?;
    string_set(part.get("rules"), label)?;
    require_one_of_strings(
        part.get("comparison"),
        &["introduced", "all", "resolved"],
        label,
    )
}

fn validate_scope(value: Option<&Value>, label: &str) -> Result<()> {
    if value
        .and_then(Value::as_str)
        .is_some_and(|scope| matches!(scope, "changeset" | "workspace"))
    {
        return Ok(());
    }
    let scope = required_object(value.unwrap_or(&Value::Null), &["paths"], &["paths"], label)?;
    let paths = scope
        .get("paths")
        .and_then(Value::as_array)
        .context("path scope paths must be an array")?;
    if paths.is_empty() {
        bail!("path scope must not be empty");
    }
    let mut unique = BTreeSet::new();
    for path in paths {
        let path = path.as_str().context("path scope entry must be a string")?;
        let path = RepoPath::from_protocol(path).context("path scope entry is invalid")?;
        if !unique.insert(path) {
            bail!("path scope contains a duplicate path");
        }
    }
    Ok(())
}

fn validate_degradations(value: Option<&Value>, label: &str, provider_id: &str) -> Result<()> {
    let items = value
        .and_then(Value::as_array)
        .with_context(|| format!("{label} must be an array"))?;
    for item in items {
        validate_degradation(item, label, provider_id)?;
    }
    Ok(())
}

fn validate_degradation(value: &Value, label: &str, provider_id: &str) -> Result<()> {
    let item = required_object(
        value,
        &[
            "source",
            "reason",
            "requirement",
            "detail",
            "capability",
            "providerState",
        ],
        &["source", "reason", "detail"],
        label,
    )?;
    require_equal_string(item.get("source"), provider_id, label)?;
    require_one_of_strings(item.get("reason"), DEGRADATION_REASONS, label)?;
    require_nonempty_string(item.get("detail"), label)?;
    validate_degradation_options(item, label)
}

const DEGRADATION_REASONS: &[&str] = &[
    "fail-open",
    "quarantined",
    "crashed",
    "skewed",
    "missing",
    "stale",
    "missing-required-provider",
    "stale-baseline",
    "blocking-diagnostic",
    "missing-authority",
    "insufficient-assurance",
    "incomplete",
    "unsupported",
    "error",
    "cancelled",
    "malformed",
    "timed-out",
    "optional-degraded",
    "unavailable",
    "incompatible",
    "unsupported-assurance",
    "policy-self-authorization",
    "direct-write-risk",
    "lattice-fast-path",
];

fn validate_degradation_options(item: &serde_json::Map<String, Value>, label: &str) -> Result<()> {
    if let Some(capability) = item.get("capability") {
        require_one_of_strings(Some(capability), &["inspect", "check", "edit"], label)?;
    }
    if let Some(requirement) = item.get("requirement") {
        require_nonempty_string(Some(requirement), label)?;
    }
    if let Some(state) = item.get("providerState") {
        require_one_of_strings(Some(state), PROVIDER_STATES, label)?;
    }
    Ok(())
}

const PROVIDER_STATES: &[&str] = &[
    "launched",
    "initializing",
    "initialized",
    "active",
    "cancelled",
    "shutting-down",
    "exited",
    "crashed",
    "timed-out",
    "incompatible",
    "malformed",
    "unavailable",
    "quarantined",
    "degraded",
];

fn validate_freshness(
    value: Option<&Value>,
    request: &HostRequest,
    read_blobs: &BTreeSet<String>,
) -> Result<()> {
    let freshness = required_object(
        value.unwrap_or(&Value::Null),
        &["baseline", "changesetDigest", "blobs"],
        &["baseline", "changesetDigest", "blobs"],
        "provider validAsOf",
    )?;
    if freshness.get("baseline") != Some(request.workspace.baseline()) {
        bail!("provider assessment echoed a stale baseline");
    }
    let changeset = request
        .evaluation_params
        .get("changeset")
        .context("check/evaluate changeset is missing")?;
    let expected_digest = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(changeset)?))
    );
    require_equal_string(
        freshness.get("changesetDigest"),
        &expected_digest,
        "assessment changeset digest",
    )?;
    let cited = string_set(freshness.get("blobs"), "assessment blob read set")?;
    if &cited != read_blobs {
        bail!("provider assessment blob read set does not match host callbacks");
    }
    Ok(())
}

fn validate_provider(
    value: Option<&Value>,
    profile: ProviderProfile,
    request: &HostRequest,
) -> Result<()> {
    let provider = required_object(
        value.unwrap_or(&Value::Null),
        &[
            "id",
            "version",
            "configDigest",
            "capabilityVersion",
            "buildDigest",
            "artifactDigest",
            "capabilityFamily",
        ],
        &["id", "version", "configDigest", "capabilityVersion"],
        "assessment provider",
    )?;
    validate_provider_identity(provider, profile)?;
    validate_provider_digests(provider)?;
    let expected = crate::protocol::asp::configuration_digest(
        request.evaluation_params.get("configuration"),
        profile,
    )
    .map_err(|error| anyhow::anyhow!(error.detail))?;
    require_equal_string(
        provider.get("configDigest"),
        &expected,
        "assessment config digest",
    )?;
    validate_provider_options(provider)
}

fn validate_provider_identity(
    provider: &serde_json::Map<String, Value>,
    profile: ProviderProfile,
) -> Result<()> {
    require_equal_string(
        provider.get("id"),
        profile.provider_id(),
        "assessment provider id",
    )?;
    require_equal_string(
        provider.get("version"),
        env!("CARGO_PKG_VERSION"),
        "assessment provider version",
    )?;
    require_equal_string(
        provider.get("capabilityVersion"),
        CAPABILITY_VERSION,
        "assessment capability version",
    )
}

fn validate_provider_digests(provider: &serde_json::Map<String, Value>) -> Result<()> {
    require_nonempty_string(provider.get("configDigest"), "assessment config digest")?;
    require_equal_string(
        provider.get("buildDigest"),
        &build_digest(),
        "assessment build digest",
    )
}

fn validate_provider_options(provider: &serde_json::Map<String, Value>) -> Result<()> {
    if let Some(family) = provider.get("capabilityFamily") {
        require_equal_string(Some(family), "check", "assessment capability family")?;
    }
    if let Some(digest) = provider.get("artifactDigest") {
        require_nonempty_string(Some(digest), "assessment artifact digest")?;
    }
    Ok(())
}

pub(super) fn validate_timing(value: Option<&Value>) -> Result<()> {
    let timing = required_object(
        value.unwrap_or(&Value::Null),
        &["startedAt", "endedAt", "elapsedMs"],
        &[],
        "assessment timing",
    )?;
    let has_elapsed = if let Some(elapsed) = timing.get("elapsedMs") {
        if elapsed.as_u64().is_none() {
            bail!("assessment elapsedMs must be a non-negative integer");
        }
        true
    } else {
        false
    };
    for field in ["startedAt", "endedAt"] {
        if let Some(value) = timing.get(field) {
            require_timestamp(Some(value), "assessment timestamp")?;
        }
    }
    if has_elapsed {
        return Ok(());
    }
    require_timestamp(timing.get("startedAt"), "assessment startedAt")?;
    require_timestamp(timing.get("endedAt"), "assessment endedAt")
}

pub(super) fn validate_cache(value: Option<&Value>) -> Result<()> {
    let cache = required_object(
        value.unwrap_or(&Value::Null),
        &["status", "key", "digest", "refreshedAt"],
        &["status"],
        "assessment cache",
    )?;
    require_one_of_strings(
        cache.get("status"),
        &["hit", "miss", "stale", "disabled"],
        "assessment cache status",
    )?;
    for field in ["key", "digest"] {
        if let Some(value) = cache.get(field) {
            require_nonempty_string(Some(value), "assessment cache field")?;
        }
    }
    if let Some(value) = cache.get("refreshedAt") {
        require_timestamp(Some(value), "assessment cache refreshedAt")?;
    }
    Ok(())
}

fn contains_host_owned_field(value: &Value) -> bool {
    const FORBIDDEN: &[&str] = &[
        "authority",
        "assurance",
        "apply",
        "decision",
        "disposition",
        "fail",
        "pass",
        "transactionGuarantee",
        "transaction",
        "verdict",
        "applyReceipt",
        "receipt",
        "policy",
        "policyDigest",
        "policyRef",
        "policyReference",
        "authorityEvidence",
        "hostDecision",
        "applyAttempt",
        "applyResult",
    ];
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            FORBIDDEN.contains(&key.as_str()) || contains_host_owned_field(value)
        }),
        Value::Array(values) => values.iter().any(contains_host_owned_field),
        _ => false,
    }
}

fn stamp_diagnostic_sources(assessment: &mut Value, provider_id: &str) {
    if let Some(diagnostics) = assessment
        .get_mut("diagnostics")
        .and_then(Value::as_array_mut)
    {
        for diagnostic in diagnostics {
            diagnostic["source"] = json!(provider_id);
        }
    }
}

fn required_object<'a>(
    value: &'a Value,
    allowed: &[&str],
    required: &[&str],
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>> {
    let object = exact_object(value, allowed, label)?;
    if let Some(field) = required.iter().find(|field| !object.contains_key(**field)) {
        bail!("{label} omitted required field {field}");
    }
    Ok(object)
}

fn string_set(value: Option<&Value>, label: &str) -> Result<BTreeSet<String>> {
    let values = value
        .and_then(Value::as_array)
        .with_context(|| format!("{label} must be an array"))?;
    let mut unique = BTreeSet::new();
    for value in values {
        let value = value
            .as_str()
            .with_context(|| format!("{label} entries must be strings"))?;
        if value.is_empty() {
            bail!("{label} entries must not be empty");
        }
        if !unique.insert(value.to_owned()) {
            bail!("{label} contains a duplicate entry");
        }
    }
    Ok(unique)
}

fn require_exact_strings(value: Option<&Value>, expected: &[&str], label: &str) -> Result<()> {
    let actual = string_set(value, label)?;
    let expected = expected
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<BTreeSet<_>>();
    if actual != expected {
        bail!("{label} does not match the bundled profile");
    }
    Ok(())
}

fn require_nonempty_string(value: Option<&Value>, label: &str) -> Result<()> {
    if value.and_then(Value::as_str).is_none_or(str::is_empty) {
        bail!("{label} must be a non-empty string");
    }
    Ok(())
}

fn require_timestamp(value: Option<&Value>, label: &str) -> Result<()> {
    let timestamp = value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("{label} must be a non-empty string"))?;
    if !is_rfc3339_timestamp(timestamp) {
        bail!("{label} must be an RFC 3339 date-time");
    }
    Ok(())
}

fn require_equal_string(value: Option<&Value>, expected: &str, label: &str) -> Result<()> {
    if value.and_then(Value::as_str) != Some(expected) {
        bail!("{label} does not match the expected value");
    }
    Ok(())
}

fn require_prefixed_string(value: Option<&Value>, prefix: &str, label: &str) -> Result<()> {
    if !value
        .and_then(Value::as_str)
        .is_some_and(|value| value.starts_with(prefix) && value.len() > prefix.len())
    {
        bail!("{label} is outside the provider namespace");
    }
    Ok(())
}

fn require_one_of_strings(value: Option<&Value>, expected: &[&str], label: &str) -> Result<()> {
    if !value
        .and_then(Value::as_str)
        .is_some_and(|value| expected.contains(&value))
    {
        bail!("{label} is invalid");
    }
    Ok(())
}

fn require_equal_bool(value: Option<&Value>, expected: bool, label: &str) -> Result<()> {
    if value.and_then(Value::as_bool) != Some(expected) {
        bail!("{label} does not match the expected value");
    }
    Ok(())
}
