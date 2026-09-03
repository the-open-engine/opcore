import { validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import { validateRepoRelativePaths } from "../shared/path-validators.js";
import {
  validateGraphSnapshotMetadata,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import {
  validateGraphQueryRequestBase,
  validateGraphSearchMode,
  validateGraphSearchResultEntry,
  validateGraphSearchSummary,
} from "./helper-validators.js";
import { validateGraphExtractionDiagnostics } from "./protocol-validators.js";
import type { GraphExtractionDiagnostic } from "./provider-contracts-01.js";
import type { GraphSnapshotMetadata } from "./provider-contracts-02.js";
import { validateProviderStatus } from "./provider-validators.js";
import type {
  GraphSearchMode,
  GraphSearchRequest,
  GraphSearchResult,
  GraphSearchResultEntry,
  GraphSearchSummary,
} from "./search-contracts.js";

function validateGraphSearchRequest(request: GraphSearchRequest): GraphSearchRequest {
  validateGraphQueryRequestBase(request, "Graph search request");
  validateNonEmptyString(request.query, "Graph search request query");
  if (request.query.trim().length === 0) throw new Error("Graph search request query must not be empty");
  if (request.limit !== undefined && (!Number.isFinite(request.limit) || request.limit < 1)) {
    throw new Error("Graph search request limit must be a positive number");
  }
  if (request.files !== undefined) validateRepoRelativePaths(request.files, "Graph search request files");
  return request;
}

export { validateGraphSearchRequest };

function validateGraphSearchResult(result: GraphSearchResult): GraphSearchResult {
  validateRequiredObject(result, "Graph search result is required");
  validateOptional(result.requestId, (value) => validateNonEmptyString(value, "Graph search result requestId"));
  const status = validateProviderStatus(result.status);
  const payload = result as GraphSearchPayload;
  if (status.state !== "available") {
    validateUnavailableGraphSearchPayload(payload, status.state);
    return result;
  }
  validateAvailableGraphSearchPayload(payload);
  return result;
}

export { validateGraphSearchResult };

interface GraphSearchPayload {
  metadata?: unknown;
  query?: unknown;
  searchMode?: unknown;
  summary?: unknown;
  results?: unknown;
  hints?: unknown;
  diagnostics?: unknown;
}

function validateUnavailableGraphSearchPayload(
  payload: GraphSearchPayload,
  state: GraphSearchResult["status"]["state"],
): void {
  const dataFields = ["metadata", "query", "searchMode", "summary", "results"] as const;
  if (dataFields.some((field) => Object.hasOwn(payload, field))) {
    throw new Error(`Graph search ${state} result must not include search data`);
  }
  validateGraphSearchOptionalEvidence(payload);
}

function validateAvailableGraphSearchPayload(payload: GraphSearchPayload): void {
  if (
    !payload.metadata ||
    typeof payload.query !== "string" ||
    !payload.searchMode ||
    !payload.summary ||
    !Array.isArray(payload.results)
  ) {
    throw new Error("Available graph search result must include metadata, query, searchMode, summary, and results");
  }
  validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
  validateNonEmptyString(payload.query, "Graph search result query");
  validateGraphSearchMode(payload.searchMode as GraphSearchMode);
  validateGraphSearchSummary(payload.summary as GraphSearchSummary);
  for (const entry of payload.results as readonly GraphSearchResultEntry[]) validateGraphSearchResultEntry(entry);
  validateGraphSearchOptionalEvidence(payload);
}

function validateGraphSearchOptionalEvidence(payload: GraphSearchPayload): void {
  validateOptional(payload.hints, (value) =>
    validateStringArray(value as readonly string[], "Graph search result hints", { allowEmpty: true }),
  );
  validateOptional(payload.diagnostics, (value) =>
    validateGraphExtractionDiagnostics(value as readonly GraphExtractionDiagnostic[]),
  );
}
