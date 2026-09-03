import {
  validateBoolean,
  validateExactValue,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { validateRepoIdentity, validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import { validateGraphDaemonOperation } from "./helper-validators.js";
import {
  validateGraphWalCheckpointSummary,
  validateGraphWatchLifecycle,
} from "./protocol-validators.js";
import type {
  GraphDaemonRequest,
  GraphDaemonResponse,
  GraphPipelinePhaseTiming,
  GraphPipelineResult,
  GraphPipelineSummary,
} from "./pipeline-contracts.js";
import { validateProviderStatus } from "./provider-validators.js";
import {
  validateGraphDetectChangesRequest,
  validateGraphDetectChangesResult,
  validateGraphFactQueryRequest,
  validateGraphFactQueryResult,
  validateGraphImpactRequest,
  validateGraphImpactResult,
  validateGraphNamedQueryRequest,
  validateGraphNamedQueryResult,
  validateGraphReviewContextRequest,
  validateGraphReviewContextResult,
} from "./query-validators.js";
import { validateGraphSearchRequest, validateGraphSearchResult } from "./search-validators.js";
import { GRAPH_SCHEMA_VERSION } from "./vocabulary-01.js";

function validateGraphDaemonRequest(request: GraphDaemonRequest): GraphDaemonRequest {
  validateRequiredObject(request, "Graph daemon request is required");
  validateExactValue(
    request.protocol,
    "opcore.graph.daemon",
    "Graph daemon request protocol must be opcore.graph.daemon",
  );
  validateNonEmptyString(request.requestId, "Graph daemon request requestId");
  validateExactValue(
    request.schemaVersion,
    GRAPH_SCHEMA_VERSION,
    `Graph daemon request schemaVersion must be ${GRAPH_SCHEMA_VERSION}`,
  );
  validateGraphDaemonOperation(request.operation);
  validateRepoIdentity(request.repo);
  validateGraphDaemonQueryRequest(request);
  validateGraphDaemonRequestOptions(request);
  return request;
}

export { validateGraphDaemonRequest };

function validateGraphDaemonQueryRequest(request: GraphDaemonRequest): void {
  validateOptional(request.query, validateGraphFactQueryRequest);
  validateOptional(request.namedQuery, validateGraphNamedQueryRequest);
  validateOptional(request.impact, validateGraphImpactRequest);
  validateOptional(request.reviewContext, validateGraphReviewContextRequest);
  validateOptional(request.changes, validateGraphDetectChangesRequest);
  validateOptional(request.search, validateGraphSearchRequest);
  if (request.operation !== "query" || request.query !== undefined) return;
  const envelopes = [request.namedQuery, request.impact, request.reviewContext, request.changes, request.search];
  if (!envelopes.some((value) => value !== undefined)) {
    throw new Error("Graph daemon query request must include query");
  }
}

function validateGraphDaemonRequestOptions(request: GraphDaemonRequest): void {
  validateOptional(request.baseRef, (value) => validateNonEmptyString(value, "Graph daemon request baseRef"));
  validateOptional(request.paths, (value) => validateGraphDaemonPaths(value, "paths"));
  validateOptional(request.watchPaths, (value) => validateGraphDaemonPaths(value, "watchPaths"));
  validateOptional(request.pollIntervalMs, (value) =>
    validateFiniteNumberAtLeast(value, 1, "Graph daemon request pollIntervalMs must be positive"),
  );
  validateOptional(request.idleTimeoutMs, (value) =>
    validateFiniteNumberAtLeast(
      value,
      0,
      "Graph daemon request idleTimeoutMs must be a non-negative number",
    ),
  );
  validateOptional(request.once, (value) => validateBoolean(value, "Graph daemon request once"));
  validateOptional(request.maxWalBytes, (value) =>
    validateFiniteNumberAtLeast(value, 1, "Graph daemon request maxWalBytes must be positive"),
  );
}

function validateGraphDaemonPaths(paths: readonly string[], field: "paths" | "watchPaths"): void {
  validateStringArray(paths, `Graph daemon request ${field}`, { allowEmpty: true });
  for (const path of paths) validateRepoRelativePath(path);
}

function validateFiniteNumberAtLeast(value: number, minimum: number, message: string): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(message);
}

function validateGraphDaemonResponse(response: GraphDaemonResponse): GraphDaemonResponse {
  validateRequiredObject(response, "Graph daemon response is required");
  validateExactValue(
    response.protocol,
    "opcore.graph.daemon",
    "Graph daemon response protocol must be opcore.graph.daemon",
  );
  validateNonEmptyString(response.requestId, "Graph daemon response requestId");
  validateExactValue(
    response.schemaVersion,
    GRAPH_SCHEMA_VERSION,
    `Graph daemon response schemaVersion must be ${GRAPH_SCHEMA_VERSION}`,
  );
  validateProviderStatus(response.status);
  validateOptional(response.result, validateGraphFactQueryResult);
  validateOptional(response.namedQuery, validateGraphNamedQueryResult);
  validateOptional(response.impact, validateGraphImpactResult);
  validateOptional(response.reviewContext, validateGraphReviewContextResult);
  validateOptional(response.changes, validateGraphDetectChangesResult);
  validateOptional(response.search, validateGraphSearchResult);
  validateOptional(response.pipeline, validateGraphPipelineResult);
  validateOptional(response.lifecycle, validateGraphWatchLifecycle);
  return response;
}

export { validateGraphDaemonResponse };

function validateGraphPipelineResult(result: GraphPipelineResult): GraphPipelineResult {
  validateRequiredObject(result, "Graph pipeline result is required");
  validateGraphPipelineSummary(result.summary);
  validateProviderStatus(result.status);
  if (result.lifecycle !== undefined) validateGraphWatchLifecycle(result.lifecycle);
  return result;
}

export { validateGraphPipelineResult };

function validateGraphPipelineSummary(summary: GraphPipelineSummary): GraphPipelineSummary {
  validateRequiredObject(summary, "Graph pipeline summary is required");
  if (!["build", "update", "watch"].includes(summary.operation)) {
    throw new Error(`Unknown graph pipeline operation: ${String(summary.operation)}`);
  }
  validateRepoIdentity(summary.repo);
  validateOptional(summary.storePath, (value) => validateNonEmptyString(value, "Graph pipeline summary storePath"));
  validateNonEmptyString(summary.startedAt, "Graph pipeline summary startedAt");
  validateNonEmptyString(summary.completedAt, "Graph pipeline summary completedAt");
  validateGraphPipelineCounts(summary);
  validateStringArray(summary.changedFiles, "Graph pipeline summary changedFiles", { allowEmpty: true });
  validateStringArray(summary.deletedFiles, "Graph pipeline summary deletedFiles", { allowEmpty: true });
  for (const path of summary.changedFiles) validateRepoRelativePath(path);
  for (const path of summary.deletedFiles) validateRepoRelativePath(path);
  validateBoolean(summary.fullRebuildRequired, "Graph pipeline summary fullRebuildRequired");
  if (!Array.isArray(summary.phaseTimings) || summary.phaseTimings.length === 0) {
    throw new Error("Graph pipeline summary phaseTimings must be non-empty");
  }
  for (const timing of summary.phaseTimings) validateGraphPipelinePhaseTiming(timing);
  validateOptional(summary.baseRef, (value) => validateNonEmptyString(value, "Graph pipeline summary baseRef"));
  validateOptional(summary.watchPaths, validateGraphPipelineWatchPaths);
  validateOptional(summary.walCheckpoint, validateGraphWalCheckpointSummary);
  return summary;
}

export { validateGraphPipelineSummary };

function validateGraphPipelineCounts(summary: GraphPipelineSummary): void {
  for (const key of ["durationMs", "discoveredFiles", "parsedFiles", "unchangedFiles", "diagnosticsCount"] as const) {
    if (typeof summary[key] !== "number" || summary[key] < 0) {
      throw new Error(`Graph pipeline summary ${key} must be a non-negative number`);
    }
  }
}

function validateGraphPipelineWatchPaths(paths: readonly string[]): void {
  validateStringArray(paths, "Graph pipeline summary watchPaths", { allowEmpty: true });
  for (const path of paths) validateRepoRelativePath(path);
}

function validateGraphPipelinePhaseTiming(timing: GraphPipelinePhaseTiming): GraphPipelinePhaseTiming {
  validateRequiredObject(timing, "Graph pipeline phase timing is required");
  validateNonEmptyString(timing.phase, "Graph pipeline phase timing phase");
  validateNonEmptyString(timing.startedAt, "Graph pipeline phase timing startedAt");
  validateNonEmptyString(timing.completedAt, "Graph pipeline phase timing completedAt");
  if (typeof timing.durationMs !== "number" || timing.durationMs < 0) {
    throw new Error("Graph pipeline phase timing durationMs must be non-negative");
  }
  if (timing.fileCount !== undefined && (typeof timing.fileCount !== "number" || timing.fileCount < 0)) {
    throw new Error("Graph pipeline phase timing fileCount must be non-negative");
  }
  return timing;
}

export { validateGraphPipelinePhaseTiming };
