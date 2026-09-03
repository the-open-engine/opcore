import { validateOptional, validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import {
  validateRepoIdentity,
  validateRepoRelativePath,
  validateRepoRelativePaths,
} from "../shared/path-validators.js";
import { validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import { validateGraphSnapshotMetadata } from "../shared/validators-02.js";
import {
  validateGraphFactQueryKind,
  validateGraphNamedQueryKind,
  validateGraphQueryRequestBase,
  validateGraphTraversalMetadata,
  validateTraversalOptions,
} from "./helper-validators.js";
import {
  validateGraphFactEdge,
  validateGraphFactNode,
  validateGraphPayloadResult,
  validateRenamedFiles,
} from "./payload-validators.js";
import { validateGraphExtractionDiagnostics } from "./protocol-validators.js";
import type { GraphExtractionDiagnostic } from "./provider-contracts-01.js";
import type { GraphFactEdge, GraphFactNode, GraphSnapshotMetadata } from "./provider-contracts-02.js";
import { validateProviderStatus } from "./provider-validators.js";
import type {
  GraphFactQueryRequest,
  GraphFactQueryResult,
  GraphImpactRequest,
  GraphNamedQueryRequest,
  GraphNamedQueryResult,
  GraphTraversalMetadata,
} from "./query-contracts-01.js";
import type {
  GraphDetectChangesRequest,
  GraphDetectChangesResult,
  GraphImpactResult,
  GraphRenamedFile,
  GraphReviewContextRequest,
  GraphReviewContextResult,
} from "./query-contracts-02.js";
import { GRAPH_SCHEMA_VERSION, graphProviderModes } from "./vocabulary-01.js";

function validateGraphFactQueryRequest(request: GraphFactQueryRequest): GraphFactQueryRequest {
  validateRequiredObject(request, "Graph fact query request is required");
  if (request.requestId !== undefined) validateNonEmptyString(request.requestId, "Graph fact query request requestId");
  validateRepoIdentity(request.repo);
  if (request.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(`Graph fact query request schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  }
  if (!includesString(graphProviderModes, request.mode)) {
    throw new Error(`Unknown graph fact query request mode: ${String(request.mode)}`);
  }
  validateRequiredObject(request.selector, "Graph fact query request selector is required");
  validateGraphFactQueryKind(request.selector.kind);
  if (request.selector.nodeKinds !== undefined) {
    validateStringArray(request.selector.nodeKinds, "Graph fact query selector nodeKinds", { allowEmpty: true });
  }
  if (request.selector.edgeKinds !== undefined) {
    validateStringArray(request.selector.edgeKinds, "Graph fact query selector edgeKinds", { allowEmpty: true });
  }
  if (request.selector.ids !== undefined) {
    validateStringArray(request.selector.ids, "Graph fact query selector ids", {
      allowEmpty: true,
    });
  }
  if (
    request.selector.limit !== undefined &&
    (typeof request.selector.limit !== "number" || request.selector.limit < 1)
  ) {
    throw new Error("Graph fact query selector limit must be a positive number");
  }
  return request;
}

export { validateGraphFactQueryRequest };

function validateGraphFactQueryResult(result: GraphFactQueryResult): GraphFactQueryResult {
  validateRequiredObject(result, "Graph fact query result is required");
  validateOptional(result.requestId, (value) => validateNonEmptyString(value, "Graph fact query result requestId"));
  const status = validateProviderStatus(result.status);
  const payload = result as {
    metadata?: unknown;
    nodes?: unknown;
    edges?: unknown;
    diagnostics?: unknown;
  };
  if (status.state !== "available") {
    validateUnavailableGraphFactQueryPayload(payload, status.state);
    return result;
  }
  validateAvailableGraphFactQueryPayload(payload);
  return result;
}

export { validateGraphFactQueryResult };

interface GraphFactQueryPayload {
  metadata?: unknown;
  nodes?: unknown;
  edges?: unknown;
  diagnostics?: unknown;
}

function validateUnavailableGraphFactQueryPayload(
  payload: GraphFactQueryPayload,
  state: string,
): void {
  const hasGraphData =
    Object.hasOwn(payload, "metadata") || Object.hasOwn(payload, "nodes") || Object.hasOwn(payload, "edges");
  if (hasGraphData) throw new Error(`Graph query ${state} result must not include graph data`);
}

function validateAvailableGraphFactQueryPayload(payload: GraphFactQueryPayload): void {
  if (!payload.metadata || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    throw new Error("Available graph query result must include metadata, nodes, and edges");
  }
  validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
  for (const node of payload.nodes) validateGraphFactNode(node as GraphFactNode);
  for (const edge of payload.edges) validateGraphFactEdge(edge as GraphFactEdge);
  validateOptional(payload.diagnostics, (value) =>
    validateGraphExtractionDiagnostics(value as readonly GraphExtractionDiagnostic[]),
  );
}

function validateGraphNamedQueryRequest(request: GraphNamedQueryRequest): GraphNamedQueryRequest {
  validateGraphQueryRequestBase(request, "Graph named query request");
  validateGraphNamedQueryKind(request.queryKind);
  validateNonEmptyString(request.target, "Graph named query request target");
  validateTraversalOptions(request.maxDepth, request.limit, "Graph named query request");
  return request;
}

export { validateGraphNamedQueryRequest };

function validateGraphNamedQueryResult(result: GraphNamedQueryResult): GraphNamedQueryResult {
  validateGraphPayloadResult(result, "Graph named query result", (payload) => {
    validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
    validateGraphNamedQueryKind(payload.queryKind);
    validateNonEmptyString(payload.target, "Graph named query result target");
    for (const node of payload.nodes as readonly GraphFactNode[]) validateGraphFactNode(node);
    for (const edge of payload.edges as readonly GraphFactEdge[]) validateGraphFactEdge(edge);
    validateGraphTraversalMetadata(payload.traversal as GraphTraversalMetadata);
  });
  return result;
}

export { validateGraphNamedQueryResult };

function validateGraphImpactRequest(request: GraphImpactRequest): GraphImpactRequest {
  validateGraphQueryRequestBase(request, "Graph impact request");
  validateStringArray(request.files, "Graph impact request files", {
    allowEmpty: false,
  });
  for (const file of request.files) validateRepoRelativePath(file);
  if (request.baseRef !== undefined) validateNonEmptyString(request.baseRef, "Graph impact request baseRef");
  validateTraversalOptions(request.maxDepth, request.limit, "Graph impact request");
  return request;
}

export { validateGraphImpactRequest };

function validateGraphImpactResult(result: GraphImpactResult): GraphImpactResult {
  validateGraphPayloadResult(result, "Graph impact result", (payload) => {
    validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
    validateRepoRelativePaths(payload.changedFiles, "Graph impact result changedFiles");
    validateRepoRelativePaths(payload.impactedFiles, "Graph impact result impactedFiles");
    validateStringArray(payload.impactedSymbols as readonly string[], "Graph impact result impactedSymbols", {
      allowEmpty: true,
    });
    validateRepoRelativePaths(payload.tests, "Graph impact result tests");
    for (const node of payload.nodes as readonly GraphFactNode[]) validateGraphFactNode(node);
    for (const edge of payload.edges as readonly GraphFactEdge[]) validateGraphFactEdge(edge);
    validateGraphTraversalMetadata(payload.traversal as GraphTraversalMetadata);
  });
  return result;
}

export { validateGraphImpactResult };

function validateGraphDetectChangesRequest(request: GraphDetectChangesRequest): GraphDetectChangesRequest {
  validateGraphQueryRequestBase(request, "Graph detect-changes request");
  if (request.files !== undefined) validateRepoRelativePaths(request.files, "Graph detect-changes request files");
  if (request.baseRef !== undefined) validateNonEmptyString(request.baseRef, "Graph detect-changes request baseRef");
  return request;
}

export { validateGraphDetectChangesRequest };

function validateGraphDetectChangesResult(result: GraphDetectChangesResult): GraphDetectChangesResult {
  validateGraphPayloadResult(result, "Graph detect-changes result", (payload) => {
    validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
    validateRepoRelativePaths(payload.changedFiles, "Graph detect-changes result changedFiles");
    validateRepoRelativePaths(payload.deletedFiles, "Graph detect-changes result deletedFiles");
    validateRenamedFiles(payload.renamedFiles as readonly GraphRenamedFile[]);
  });
  return result;
}

export { validateGraphDetectChangesResult };

function validateGraphReviewContextRequest(request: GraphReviewContextRequest): GraphReviewContextRequest {
  validateGraphQueryRequestBase(request, "Graph review-context request");
  if (request.files !== undefined) validateRepoRelativePaths(request.files, "Graph review-context request files");
  if (request.baseRef !== undefined) validateNonEmptyString(request.baseRef, "Graph review-context request baseRef");
  validateTraversalOptions(request.maxDepth, request.limit, "Graph review-context request");
  return request;
}

export { validateGraphReviewContextRequest };

function validateGraphReviewContextResult(result: GraphReviewContextResult): GraphReviewContextResult {
  validateGraphPayloadResult(result, "Graph review-context result", (payload) => {
    validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
    validateRepoRelativePaths(payload.changedFiles, "Graph review-context result changedFiles");
    validateRepoRelativePaths(payload.deletedFiles, "Graph review-context result deletedFiles");
    validateRenamedFiles(payload.renamedFiles as readonly GraphRenamedFile[]);
    validateRepoRelativePaths(payload.impactedFiles, "Graph review-context result impactedFiles");
    validateStringArray(payload.impactedSymbols as readonly string[], "Graph review-context result impactedSymbols", {
      allowEmpty: true,
    });
    validateRepoRelativePaths(payload.tests, "Graph review-context result tests");
    for (const node of payload.nodes as readonly GraphFactNode[]) validateGraphFactNode(node);
    for (const edge of payload.edges as readonly GraphFactEdge[]) validateGraphFactEdge(edge);
    validateGraphTraversalMetadata(payload.traversal as GraphTraversalMetadata);
  });
  return result;
}

export { validateGraphReviewContextResult };
