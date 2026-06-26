use super::{ResponseParts, GRAPH_DAEMON_PROTOCOL};
use crate::protocol::{
    required_missing_status, GraphDaemonOperation, GraphDaemonRequest, GraphDaemonResponse,
    GraphDetectChangesResult, GraphFactQueryResult, GraphImpactResult, GraphNamedQueryResult,
    GraphProviderStatus, GraphReviewContextResult, GraphSearchResult,
};
use crate::GRAPH_SCHEMA_VERSION;

pub(super) fn empty_parts() -> ResponseParts {
    ResponseParts {
        status: required_missing_status("GraphProvider response status was not set"),
        result: None,
        named_query: None,
        impact: None,
        review_context: None,
        changes: None,
        search: None,
        pipeline: None,
    }
}

pub(super) fn status_only(status: GraphProviderStatus) -> ResponseParts {
    ResponseParts {
        status,
        result: None,
        named_query: None,
        impact: None,
        review_context: None,
        changes: None,
        search: None,
        pipeline: None,
    }
}

pub(super) fn query_failure_parts(
    request: &GraphDaemonRequest,
    status: GraphProviderStatus,
) -> ResponseParts {
    ResponseParts {
        status: status.clone(),
        result: query_failure_result(request, &status),
        named_query: query_named_failure_result(request, &status),
        impact: query_impact_failure_result(request, &status),
        review_context: query_review_context_failure_result(request, &status),
        changes: query_changes_failure_result(request, &status),
        search: query_search_failure_result(request, &status),
        pipeline: None,
    }
}

pub(super) fn failure_response(
    request: &GraphDaemonRequest,
    status: GraphProviderStatus,
) -> GraphDaemonResponse {
    GraphDaemonResponse {
        protocol: GRAPH_DAEMON_PROTOCOL.to_string(),
        request_id: response_request_id(request),
        schema_version: GRAPH_SCHEMA_VERSION,
        result: query_failure_result(request, &status),
        named_query: query_named_failure_result(request, &status),
        impact: query_impact_failure_result(request, &status),
        review_context: query_review_context_failure_result(request, &status),
        changes: query_changes_failure_result(request, &status),
        search: query_search_failure_result(request, &status),
        status,
        pipeline: None,
        lifecycle: None,
    }
}

fn query_failure_result(
    request: &GraphDaemonRequest,
    status: &GraphProviderStatus,
) -> Option<GraphFactQueryResult> {
    if request.operation != GraphDaemonOperation::Query
        || request.named_query.is_some()
        || request.impact.is_some()
        || request.review_context.is_some()
        || request.changes.is_some()
        || request.search.is_some()
    {
        return None;
    }
    Some(GraphFactQueryResult::Failure {
        request_id: Some(query_response_request_id(request)),
        status: Box::new(status.clone()),
    })
}

fn query_named_failure_result(
    request: &GraphDaemonRequest,
    status: &GraphProviderStatus,
) -> Option<GraphNamedQueryResult> {
    if request.operation != GraphDaemonOperation::Query {
        return None;
    }
    request
        .named_query
        .as_ref()
        .map(|query| GraphNamedQueryResult::Failure {
            request_id: query.request_id.clone(),
            status: Box::new(status.clone()),
        })
}

fn query_impact_failure_result(
    request: &GraphDaemonRequest,
    status: &GraphProviderStatus,
) -> Option<GraphImpactResult> {
    if request.operation != GraphDaemonOperation::Query {
        return None;
    }
    request
        .impact
        .as_ref()
        .map(|query| GraphImpactResult::Failure {
            request_id: query.request_id.clone(),
            status: Box::new(status.clone()),
        })
}

fn query_review_context_failure_result(
    request: &GraphDaemonRequest,
    status: &GraphProviderStatus,
) -> Option<GraphReviewContextResult> {
    if request.operation != GraphDaemonOperation::Query {
        return None;
    }
    request
        .review_context
        .as_ref()
        .map(|query| GraphReviewContextResult::Failure {
            request_id: query.request_id.clone(),
            status: Box::new(status.clone()),
        })
}

fn query_changes_failure_result(
    request: &GraphDaemonRequest,
    status: &GraphProviderStatus,
) -> Option<GraphDetectChangesResult> {
    if request.operation != GraphDaemonOperation::Query {
        return None;
    }
    request
        .changes
        .as_ref()
        .map(|query| GraphDetectChangesResult::Failure {
            request_id: query.request_id.clone(),
            status: Box::new(status.clone()),
        })
}

fn query_search_failure_result(
    request: &GraphDaemonRequest,
    status: &GraphProviderStatus,
) -> Option<GraphSearchResult> {
    if request.operation != GraphDaemonOperation::Query {
        return None;
    }
    request
        .search
        .as_ref()
        .map(|query| GraphSearchResult::Failure {
            request_id: query.request_id.clone(),
            status: Box::new(status.clone()),
            hints: Vec::new(),
            diagnostics: Vec::new(),
        })
}

fn response_request_id(request: &GraphDaemonRequest) -> String {
    if request.request_id.is_empty() {
        "invalid-request".to_string()
    } else {
        request.request_id.clone()
    }
}

fn query_response_request_id(request: &GraphDaemonRequest) -> String {
    request
        .query
        .as_ref()
        .and_then(|query| query.request_id.clone())
        .filter(|request_id| !request_id.is_empty())
        .unwrap_or_else(|| response_request_id(request))
}
