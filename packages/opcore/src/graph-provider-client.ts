import type {
  GraphDetectChangesRequest,
  GraphDetectChangesResult,
  GraphFactQueryRequest,
  GraphFactQueryResult,
  GraphImpactRequest,
  GraphImpactResult,
  GraphNamedQueryRequest,
  GraphNamedQueryResult,
  GraphProviderAvailableStatus,
  GraphProviderFailureStatus,
  GraphProviderMode,
  GraphProviderRequiredMissingStatus,
  GraphProviderSkippedStatus,
  GraphProviderStatus,
  GraphReviewContextRequest,
  GraphReviewContextResult,
  RepoIdentity
} from "@the-open-engine/opcore-contracts";
import { GRAPH_SCHEMA_VERSION, validateProviderStatus } from "@the-open-engine/opcore-contracts";
import {
  graphProviderDetectChanges,
  graphProviderImpact,
  graphProviderNamedQuery,
  graphProviderQuery,
  graphProviderReviewContext,
  graphProviderStatus
} from "@the-open-engine/opcore-graph";

const graphProviderName = "opcore-graph";

export function opcoreGraphStatus(repo: RepoIdentity, mode: GraphProviderMode): GraphProviderStatus {
  try {
    return coerceGraphStatusMode(graphProviderStatus(repo), mode);
  } catch (error) {
    return providerErrorStatus(mode, error);
  }
}

export function opcoreGraphFactQuery(request: GraphFactQueryRequest): GraphFactQueryResult {
  const result = graphProviderQuery(request.repo, request.selector);
  const status = coerceGraphResultStatusMode(result.status, request.mode);
  return status.state === "available" ? ({ ...result, status } as GraphFactQueryResult) : { requestId: result.requestId, status };
}

export function opcoreGraphNamedQuery(request: GraphNamedQueryRequest): GraphNamedQueryResult {
  const result = graphProviderNamedQuery(request.repo, {
    queryKind: request.queryKind,
    target: request.target,
    maxDepth: request.maxDepth,
    limit: request.limit
  });
  const status = coerceGraphResultStatusMode(result.status, request.mode);
  return status.state === "available" ? ({ ...result, status } as GraphNamedQueryResult) : { requestId: result.requestId, status };
}

export function opcoreGraphImpact(request: GraphImpactRequest): GraphImpactResult {
  const result = graphProviderImpact(request.repo, {
    files: request.files,
    baseRef: request.baseRef,
    maxDepth: request.maxDepth,
    limit: request.limit
  });
  const status = coerceGraphResultStatusMode(result.status, request.mode);
  return status.state === "available" ? ({ ...result, status } as GraphImpactResult) : { requestId: result.requestId, status };
}

export function opcoreGraphReviewContext(request: GraphReviewContextRequest): GraphReviewContextResult {
  const result = graphProviderReviewContext(request.repo, {
    files: request.files,
    baseRef: request.baseRef,
    maxDepth: request.maxDepth,
    limit: request.limit
  });
  const status = coerceGraphResultStatusMode(result.status, request.mode);
  return status.state === "available" ? ({ ...result, status } as GraphReviewContextResult) : { requestId: result.requestId, status };
}

export function opcoreGraphDetectChanges(request: GraphDetectChangesRequest): GraphDetectChangesResult {
  const result = graphProviderDetectChanges(request.repo, {
    files: request.files,
    baseRef: request.baseRef
  });
  const status = coerceGraphResultStatusMode(result.status, request.mode);
  return status.state === "available" ? ({ ...result, status } as GraphDetectChangesResult) : { requestId: result.requestId, status };
}

function coerceGraphResultStatusMode(
  status: GraphProviderStatus,
  mode: GraphProviderMode
): GraphProviderAvailableStatus | GraphProviderFailureStatus {
  const coerced = coerceGraphStatusMode(status, mode);
  if (coerced.state === "warming") return providerErrorStatus(mode, "Graph provider is warming") as GraphProviderFailureStatus;
  return coerced as GraphProviderAvailableStatus | GraphProviderFailureStatus;
}

function coerceGraphStatusMode(status: GraphProviderStatus, mode: GraphProviderMode): GraphProviderStatus {
  const provider = status.provider || graphProviderName;
  if (status.mode === mode) return validateProviderStatus({ ...status, provider });
  if (mode === "optional" && status.state === "required_missing") return graphOptionalSkipStatus(status, provider);
  if (mode === "required" && status.state === "skipped") return graphRequiredMissingStatus(status, provider);
  return validateProviderStatus({ ...status, mode, provider } as GraphProviderStatus);
}

function graphOptionalSkipStatus(status: GraphProviderRequiredMissingStatus, provider: string): GraphProviderStatus {
  return validateProviderStatus({
    state: "skipped",
    mode: "optional",
    provider,
    schemaVersion: status.schemaVersion,
    message: status.message,
    failure: status.failure
  });
}

function graphRequiredMissingStatus(status: GraphProviderSkippedStatus, provider: string): GraphProviderStatus {
  return validateProviderStatus({
    state: "required_missing",
    mode: "required",
    provider,
    schemaVersion: status.schemaVersion,
    message: status.message,
    failure: status.failure
  });
}

function providerErrorStatus(mode: GraphProviderMode, error: unknown): GraphProviderStatus {
  const message = `Graph provider status failed: ${error instanceof Error ? error.message : String(error)}`;
  return validateProviderStatus({
    state: "error",
    mode,
    provider: graphProviderName,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    message,
    failure: {
      category: "query_failed",
      message
    }
  });
}
