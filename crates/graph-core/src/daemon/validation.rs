use super::GRAPH_DAEMON_PROTOCOL;
use crate::extraction::normalize_repo_relative_path;
use crate::protocol::{
    GraphDaemonOperation, GraphDaemonRequest, GraphDetectChangesRequest, GraphFactQueryRequest,
    GraphImpactRequest, GraphNamedQueryRequest, GraphProviderMode, GraphProviderStatus,
    GraphReviewContextRequest, GraphSearchRequest, ProviderFailure, ProviderFailureCategory,
    RepoIdentity,
};
use crate::{GRAPH_PROVIDER_NAME, GRAPH_SCHEMA_VERSION};

pub(super) struct RequestValidationError {
    message: String,
    actual_schema_version: u32,
}

pub(super) fn validate_request(request: &GraphDaemonRequest) -> Result<(), RequestValidationError> {
    validate_request_envelope(request)?;
    validate_repo(&request.repo, "Graph daemon request repo")?;
    validate_request_queries(request)?;
    validate_request_paths(request)?;
    validate_query_operation_shape(request)?;
    validate_daemon_options(request)?;
    Ok(())
}

fn validate_request_envelope(request: &GraphDaemonRequest) -> Result<(), RequestValidationError> {
    if request.protocol != GRAPH_DAEMON_PROTOCOL {
        return Err(validation_error(
            "Graph daemon request protocol must be lattice.graph.daemon",
            request.schema_version,
        ));
    }
    if request.request_id.is_empty() {
        return Err(validation_error(
            "Graph daemon request requestId must be non-empty",
            request.schema_version,
        ));
    }
    if request.schema_version != GRAPH_SCHEMA_VERSION {
        return Err(validation_error(
            "Graph daemon request schemaVersion mismatch",
            request.schema_version,
        ));
    }
    Ok(())
}

fn validate_request_queries(request: &GraphDaemonRequest) -> Result<(), RequestValidationError> {
    validate_optional_query(request.query.as_ref(), validate_query)?;
    validate_optional_query(request.named_query.as_ref(), validate_named_query)?;
    validate_optional_query(request.impact.as_ref(), validate_impact_query)?;
    validate_optional_query(
        request.review_context.as_ref(),
        validate_review_context_query,
    )?;
    validate_optional_query(request.changes.as_ref(), validate_changes_query)?;
    validate_optional_query(request.search.as_ref(), validate_search)
}

fn validate_optional_query<T>(
    query: Option<&T>,
    validate: fn(&T) -> Result<(), RequestValidationError>,
) -> Result<(), RequestValidationError> {
    if let Some(query) = query {
        validate(query)?;
    }
    Ok(())
}

fn validate_named_query(query: &GraphNamedQueryRequest) -> Result<(), RequestValidationError> {
    validate_query_base(
        query.request_id.as_deref(),
        &query.repo,
        query.schema_version,
        "Graph named query request",
    )?;
    if query.target.is_empty() {
        return Err(validation_error(
            "Graph named query request target must be non-empty",
            query.schema_version,
        ));
    }
    validate_positive_options(query.max_depth, query.limit, query.schema_version)
}

fn validate_impact_query(query: &GraphImpactRequest) -> Result<(), RequestValidationError> {
    validate_query_base(
        query.request_id.as_deref(),
        &query.repo,
        query.schema_version,
        "Graph impact request",
    )?;
    validate_repo_relative_strings(
        &query.files,
        "Graph impact request files",
        query.schema_version,
    )?;
    if query.files.is_empty() {
        return Err(validation_error(
            "Graph impact request files must not be empty",
            query.schema_version,
        ));
    }
    validate_positive_options(query.max_depth, query.limit, query.schema_version)
}

fn validate_review_context_query(
    query: &GraphReviewContextRequest,
) -> Result<(), RequestValidationError> {
    validate_query_base(
        query.request_id.as_deref(),
        &query.repo,
        query.schema_version,
        "Graph review-context request",
    )?;
    validate_repo_relative_strings(
        &query.files,
        "Graph review-context request files",
        query.schema_version,
    )?;
    validate_positive_options(query.max_depth, query.limit, query.schema_version)
}

fn validate_changes_query(query: &GraphDetectChangesRequest) -> Result<(), RequestValidationError> {
    validate_query_base(
        query.request_id.as_deref(),
        &query.repo,
        query.schema_version,
        "Graph detect-changes request",
    )?;
    validate_repo_relative_strings(
        &query.files,
        "Graph detect-changes request files",
        query.schema_version,
    )
}

fn validate_request_paths(request: &GraphDaemonRequest) -> Result<(), RequestValidationError> {
    validate_repo_relative_strings(
        &request.paths,
        "Graph daemon request paths",
        request.schema_version,
    )?;
    validate_repo_relative_strings(
        &request.watch_paths,
        "Graph daemon request watchPaths",
        request.schema_version,
    )?;
    Ok(())
}

fn validate_query_operation_shape(
    request: &GraphDaemonRequest,
) -> Result<(), RequestValidationError> {
    if request.operation == GraphDaemonOperation::Query
        && request.query.is_none()
        && request.named_query.is_none()
        && request.impact.is_none()
        && request.review_context.is_none()
        && request.changes.is_none()
        && request.search.is_none()
    {
        return Err(validation_error(
            "Graph daemon query request must include query",
            request.schema_version,
        ));
    }
    Ok(())
}

fn validate_daemon_options(request: &GraphDaemonRequest) -> Result<(), RequestValidationError> {
    if request.poll_interval_ms == Some(0) {
        return Err(validation_error(
            "Graph daemon request pollIntervalMs must be positive",
            request.schema_version,
        ));
    }
    if request.max_wal_bytes == Some(0) {
        return Err(validation_error(
            "Graph daemon request maxWalBytes must be positive",
            request.schema_version,
        ));
    }
    Ok(())
}

fn validate_query(query: &GraphFactQueryRequest) -> Result<(), RequestValidationError> {
    validate_query_base(
        query.request_id.as_deref(),
        &query.repo,
        query.schema_version,
        "Graph fact query request",
    )?;
    validate_strings(
        &query.selector.node_kinds,
        "Graph fact query selector nodeKinds",
        query.schema_version,
    )?;
    validate_strings(
        &query.selector.edge_kinds,
        "Graph fact query selector edgeKinds",
        query.schema_version,
    )?;
    validate_strings(
        &query.selector.ids,
        "Graph fact query selector ids",
        query.schema_version,
    )?;
    if query.selector.limit == Some(0) {
        return Err(validation_error(
            "Graph fact query selector limit must be positive",
            query.schema_version,
        ));
    }
    Ok(())
}

fn validate_search(query: &GraphSearchRequest) -> Result<(), RequestValidationError> {
    validate_query_base(
        query.request_id.as_deref(),
        &query.repo,
        query.schema_version,
        "Graph search request",
    )?;
    if query.query.trim().is_empty() {
        return Err(validation_error(
            "Graph search request query must be non-empty",
            query.schema_version,
        ));
    }
    if query.limit == Some(0) {
        return Err(validation_error(
            "Graph search request limit must be positive",
            query.schema_version,
        ));
    }
    validate_repo_relative_strings(
        &query.files,
        "Graph search request files",
        query.schema_version,
    )?;
    Ok(())
}

fn validate_query_base(
    request_id: Option<&str>,
    repo: &RepoIdentity,
    schema_version: u32,
    label: &str,
) -> Result<(), RequestValidationError> {
    if request_id == Some("") {
        return Err(validation_error(
            &format!("{label} requestId must be non-empty"),
            schema_version,
        ));
    }
    validate_repo(repo, &format!("{label} repo"))?;
    if schema_version != GRAPH_SCHEMA_VERSION {
        return Err(validation_error(
            &format!("{label} schemaVersion mismatch"),
            schema_version,
        ));
    }
    Ok(())
}

fn validate_positive_options(
    max_depth: Option<u32>,
    limit: Option<u32>,
    schema_version: u32,
) -> Result<(), RequestValidationError> {
    let _ = max_depth;
    if limit == Some(0) {
        return Err(validation_error(
            "Graph query limit must be positive",
            schema_version,
        ));
    }
    Ok(())
}

fn validate_repo(repo: &RepoIdentity, label: &str) -> Result<(), RequestValidationError> {
    let repo_id = has_text(&repo.repo_id);
    let repo_root = has_text(&repo.repo_root);
    let remote_url = has_text(&repo.remote_url);
    if repo_id && repo_root {
        return Err(validation_error(
            &format!("{label} is ambiguous"),
            GRAPH_SCHEMA_VERSION,
        ));
    }
    if !repo_id && !repo_root && !remote_url {
        return Err(validation_error(
            &format!("{label} must identify a repo"),
            GRAPH_SCHEMA_VERSION,
        ));
    }
    Ok(())
}

fn validate_strings(
    values: &[String],
    label: &str,
    actual_schema_version: u32,
) -> Result<(), RequestValidationError> {
    if values.iter().any(String::is_empty) {
        return Err(validation_error(
            &format!("{label} must contain non-empty strings"),
            actual_schema_version,
        ));
    }
    Ok(())
}

fn validate_repo_relative_strings(
    values: &[String],
    label: &str,
    actual_schema_version: u32,
) -> Result<(), RequestValidationError> {
    validate_strings(values, label, actual_schema_version)?;
    for value in values {
        validate_repo_relative_path(value, label, actual_schema_version)?;
    }
    Ok(())
}

fn validate_repo_relative_path(
    value: &str,
    label: &str,
    actual_schema_version: u32,
) -> Result<(), RequestValidationError> {
    normalize_repo_relative_path(value, label)
        .map(|_| ())
        .map_err(|message| validation_error(&message, actual_schema_version))
}

fn schema_mismatch(message: &str, actual_schema_version: u32) -> GraphProviderStatus {
    GraphProviderStatus::SchemaMismatch {
        mode: GraphProviderMode::Required,
        provider: GRAPH_PROVIDER_NAME.to_string(),
        schema_version: GRAPH_SCHEMA_VERSION,
        expected_schema_version: GRAPH_SCHEMA_VERSION,
        actual_schema_version,
        message: Some(message.to_string()),
        failure: ProviderFailure {
            category: ProviderFailureCategory::SchemaMismatch,
            message: message.to_string(),
            retryable: None,
            cause: None,
        },
    }
}

impl RequestValidationError {
    pub(super) fn status(&self) -> GraphProviderStatus {
        schema_mismatch(&self.message, self.actual_schema_version)
    }
}

fn validation_error(message: &str, actual_schema_version: u32) -> RequestValidationError {
    RequestValidationError {
        message: message.to_string(),
        actual_schema_version,
    }
}

fn has_text(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|text| !text.is_empty())
}
