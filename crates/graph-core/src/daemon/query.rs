use super::session::{SessionCache, SessionChangeDetection};
use super::{
    empty_parts, missing_query_result, query_failure_parts, query_repo_root, request_watch_paths,
    status_state_is_failure, store_error_status, ResponseParts,
};
use crate::extraction::{collect_source_file_hashes, ExtractionOptions};
use crate::protocol::{
    query_failed_status, required_missing_status, unsupported_mode_status, GraphDaemonRequest,
    GraphDetectChangesResult, GraphFactQueryRequest, GraphFactQueryResult, GraphImpactRequest,
    GraphImpactResult, GraphNamedQueryRequest, GraphNamedQueryResult, GraphProviderStatus,
    GraphReviewContextResult, GraphSearchRequest, GraphSearchResult,
};
use crate::store::{StoreError, StoreQueryOutput, StoreSearchOutput};

struct ChangeQueryResources {
    status: GraphProviderStatus,
    stored_hashes: Vec<crate::extraction::SourceFileHash>,
    current_hashes: Vec<crate::extraction::SourceFileHash>,
}

pub(super) fn query_result(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
) -> ResponseParts {
    let Some(repo_root) = query_repo_root(request) else {
        let status = required_missing_status("GraphProvider query requires repo.repoRoot");
        return query_failure_parts(request, status);
    };
    if request.changes.is_some() || request.review_context.is_some() {
        return change_query_result(session_cache, request, &repo_root);
    }
    let status = match query_status(session_cache, request, &repo_root) {
        Ok(status) => status,
        Err(status) => return query_failure_parts(request, *status),
    };
    dispatch_query_result(session_cache, request, &repo_root, status)
}

fn query_status(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
    repo_root: &str,
) -> Result<GraphProviderStatus, Box<GraphProviderStatus>> {
    let status = session_cache
        .status_for_repo(repo_root, &request_watch_paths(request))
        .map_err(|error| Box::new(store_error_status(error)))?;
    if status_state_is_failure(&status) {
        return Err(Box::new(status));
    }
    Ok(status)
}

fn dispatch_query_result(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
    repo_root: &str,
    status: GraphProviderStatus,
) -> ResponseParts {
    if let Some(parts) = fact_query_parts(session_cache, request, repo_root, &status) {
        return parts;
    }
    if let Some(parts) = search_query_parts(session_cache, request, repo_root, &status) {
        return parts;
    }
    if let Some(parts) = named_query_parts(session_cache, request, repo_root, &status) {
        return parts;
    }
    if let Some(parts) = impact_query_parts(session_cache, request, repo_root, &status) {
        return parts;
    }
    missing_query_result(request)
}

fn fact_query_parts(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
    repo_root: &str,
    status: &GraphProviderStatus,
) -> Option<ResponseParts> {
    let query_request = request.query.as_ref()?;
    Some(
        match session_cache.query(repo_root, &query_request.selector) {
            Ok(output) => fact_query_response(status, query_request, output),
            Err(StoreError::UnsupportedMode(message)) => {
                query_failure_parts(request, unsupported_mode_status(message))
            }
            Err(error) => query_failure_parts(request, store_error_status(error)),
        },
    )
}

fn search_query_parts(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
    repo_root: &str,
    status: &GraphProviderStatus,
) -> Option<ResponseParts> {
    let search_request = request.search.as_ref()?;
    Some(match session_cache.search(repo_root, search_request) {
        Ok(output) => search_response(status, search_request, output),
        Err(StoreError::UnsupportedMode(message)) => {
            query_failure_parts(request, unsupported_mode_status(message))
        }
        Err(error) => query_failure_parts(request, store_error_status(error)),
    })
}

fn named_query_parts(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
    repo_root: &str,
    status: &GraphProviderStatus,
) -> Option<ResponseParts> {
    let named_request = request.named_query.as_ref()?;
    Some(match session_cache.named_query(repo_root, named_request) {
        Ok(output) => named_query_response(status, named_request, output),
        Err(StoreError::UnsupportedMode(message)) => {
            query_failure_parts(request, unsupported_mode_status(message))
        }
        Err(error) => query_failure_parts(request, store_error_status(error)),
    })
}

fn impact_query_parts(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
    repo_root: &str,
    status: &GraphProviderStatus,
) -> Option<ResponseParts> {
    let impact_request = request.impact.as_ref()?;
    if impact_request.files.is_empty() {
        return Some(query_failure_parts(
            request,
            unsupported_mode_status("Graph impact requires at least one --files path"),
        ));
    }
    Some(match session_cache.impact(repo_root, impact_request) {
        Ok(output) => impact_response(status, impact_request, output),
        Err(StoreError::UnsupportedMode(message)) => {
            query_failure_parts(request, unsupported_mode_status(message))
        }
        Err(error) => query_failure_parts(request, store_error_status(error)),
    })
}

fn fact_query_response(
    status: &GraphProviderStatus,
    request: &GraphFactQueryRequest,
    output: StoreQueryOutput,
) -> ResponseParts {
    ResponseParts {
        status: status.clone(),
        result: Some(GraphFactQueryResult::Available {
            request_id: request.request_id.clone(),
            status: Box::new(status.clone()),
            metadata: Box::new(output.metadata),
            nodes: output.nodes,
            edges: output.edges,
            diagnostics: output.diagnostics,
        }),
        ..empty_parts()
    }
}

fn search_response(
    status: &GraphProviderStatus,
    request: &GraphSearchRequest,
    output: StoreSearchOutput,
) -> ResponseParts {
    ResponseParts {
        status: status.clone(),
        search: Some(GraphSearchResult::Available {
            request_id: request.request_id.clone(),
            status: Box::new(status.clone()),
            metadata: Box::new(output.metadata),
            query: output.search.query,
            search_mode: output.search.search_mode,
            summary: output.search.summary,
            results: output.search.results,
            hints: output.search.hints,
            diagnostics: output.diagnostics,
        }),
        ..empty_parts()
    }
}

fn named_query_response(
    status: &GraphProviderStatus,
    request: &GraphNamedQueryRequest,
    output: crate::query::GraphNamedQueryOutput,
) -> ResponseParts {
    ResponseParts {
        status: status.clone(),
        named_query: Some(GraphNamedQueryResult::Available {
            request_id: request.request_id.clone(),
            status: Box::new(status.clone()),
            metadata: Box::new(output.metadata),
            query_kind: output.query_kind,
            target: output.target,
            nodes: output.nodes,
            edges: output.edges,
            traversal: output.traversal,
            diagnostics: output.diagnostics,
        }),
        ..empty_parts()
    }
}

fn impact_response(
    status: &GraphProviderStatus,
    request: &GraphImpactRequest,
    output: crate::query::GraphImpactOutput,
) -> ResponseParts {
    ResponseParts {
        status: status.clone(),
        impact: Some(GraphImpactResult::Available {
            request_id: request.request_id.clone(),
            status: Box::new(status.clone()),
            metadata: Box::new(output.metadata),
            changed_files: output.changed_files,
            impacted_files: output.impacted_files,
            impacted_symbols: output.impacted_symbols,
            tests: output.tests,
            nodes: output.nodes,
            edges: output.edges,
            traversal: output.traversal,
            diagnostics: output.diagnostics,
        }),
        ..empty_parts()
    }
}

fn change_query_result(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
    repo_root: &str,
) -> ResponseParts {
    let resources = match change_query_resources(session_cache, request, repo_root) {
        Ok(resources) => resources,
        Err(status) => return query_failure_parts(request, *status),
    };
    if let Some(changes_request) = request.changes.as_ref() {
        let output = match session_cache.detect_changes(
            repo_root,
            SessionChangeDetection {
                stored_hashes: &resources.stored_hashes,
                current_hashes: &resources.current_hashes,
                request: changes_request,
            },
        ) {
            Ok(output) => output,
            Err(error) => return query_failure_parts(request, store_error_status(error)),
        };
        return detect_changes_response(changes_request, resources.status, output);
    }
    if let Some(review_request) = request.review_context.as_ref() {
        let output = match session_cache.review_context(
            repo_root,
            crate::query::GraphReviewContextHashes {
                stored: &resources.stored_hashes,
                current: &resources.current_hashes,
            },
            review_request,
        ) {
            Ok(output) => output,
            Err(error) => return query_failure_parts(request, store_error_status(error)),
        };
        return review_context_response(review_request, resources.status, output);
    }
    missing_query_result(request)
}

fn change_query_resources(
    session_cache: &mut SessionCache,
    request: &GraphDaemonRequest,
    repo_root: &str,
) -> Result<ChangeQueryResources, Box<GraphProviderStatus>> {
    let status = session_cache
        .status_for_repo(repo_root, &request_watch_paths(request))
        .map_err(|error| Box::new(store_error_status(error)))?;
    if status_state_is_failure(&status) {
        return Err(Box::new(status));
    }
    let stored_hashes = session_cache
        .file_hashes(repo_root)
        .map_err(|error| Box::new(store_error_status(error)))?;
    let discovered = collect_source_file_hashes(ExtractionOptions::new(repo_root));
    if source_hash_failed(&discovered.diagnostics) {
        return Err(Box::new(query_failed_status(
            "source hash discovery failed",
            discovered.diagnostics,
        )));
    }
    Ok(ChangeQueryResources {
        status,
        stored_hashes,
        current_hashes: discovered.file_hashes,
    })
}

fn source_hash_failed(diagnostics: &[crate::protocol::GraphExtractionDiagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == crate::protocol::GraphExtractionDiagnosticSeverity::Error
    })
}

fn detect_changes_response(
    request: &crate::protocol::GraphDetectChangesRequest,
    status: GraphProviderStatus,
    output: crate::query::GraphChangesOutput,
) -> ResponseParts {
    ResponseParts {
        status: status.clone(),
        changes: Some(GraphDetectChangesResult::Available {
            request_id: request.request_id.clone(),
            status: Box::new(status),
            metadata: Box::new(output.metadata),
            changed_files: output.changed_files,
            deleted_files: output.deleted_files,
            renamed_files: output.renamed_files,
            diagnostics: output.diagnostics,
        }),
        ..empty_parts()
    }
}

fn review_context_response(
    request: &crate::protocol::GraphReviewContextRequest,
    status: GraphProviderStatus,
    output: crate::query::GraphReviewContextOutput,
) -> ResponseParts {
    ResponseParts {
        status: status.clone(),
        review_context: Some(GraphReviewContextResult::Available {
            request_id: request.request_id.clone(),
            status: Box::new(status),
            metadata: Box::new(output.metadata),
            changed_files: output.changed_files,
            deleted_files: output.deleted_files,
            renamed_files: output.renamed_files,
            impacted_files: output.impacted_files,
            impacted_symbols: output.impacted_symbols,
            tests: output.tests,
            nodes: output.nodes,
            edges: output.edges,
            traversal: output.traversal,
            diagnostics: output.diagnostics,
        }),
        ..empty_parts()
    }
}
