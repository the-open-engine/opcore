import { validateRequiredObject } from "../shared/validators-02.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString } from "../shared/validators-01.js";
import type { GraphExtractionDiagnostic } from "./provider-contracts-01.js";
import type { GraphFactEdge, GraphFactNode } from "./provider-contracts-02.js";
import { validateGraphExtractionDiagnostics } from "./protocol-validators.js";
import { validateProviderStatus } from "./provider-validators.js";
import type { GraphFactQueryResult, GraphNamedQueryResult } from "./query-contracts-01.js";
import type {
  GraphDetectChangesResult,
  GraphImpactResult,
  GraphRenamedFile,
  GraphReviewContextResult,
} from "./query-contracts-02.js";

function validateGraphPayloadResult(
  result: GraphNamedQueryResult | GraphImpactResult | GraphDetectChangesResult | GraphReviewContextResult,
  label: string,
  validatePayload: (payload: Record<string, unknown>) => void,
): void {
  if (!result || typeof result !== "object") throw new Error(`${label} is required`);
  if (result.requestId !== undefined) validateNonEmptyString(result.requestId, `${label} requestId`);
  const status = validateProviderStatus(result.status);
  const payload: Record<string, unknown> = { ...result };
  const payloadKeys = Object.keys(payload).filter((key) => key !== "requestId" && key !== "status");
  if (status.state !== "available") {
    if (payloadKeys.length > 0) throw new Error(`${label} ${status.state} result must not include graph data`);
    return;
  }
  validatePayload(payload);
  if (payload.diagnostics !== undefined) {
    validateGraphExtractionDiagnostics(payload.diagnostics as readonly GraphExtractionDiagnostic[]);
  }
}

export { validateGraphPayloadResult };


function validateRenamedFiles(renamedFiles: readonly GraphRenamedFile[]): void {
  if (!Array.isArray(renamedFiles)) throw new Error("Graph renamedFiles must be an array");
  for (const renamed of renamedFiles) {
    validateRepoRelativePath(renamed.fromPath);
    validateRepoRelativePath(renamed.toPath);
  }
}

export { validateRenamedFiles };

function isNamedQueryResult(result: GraphFactQueryResult | GraphNamedQueryResult): result is GraphNamedQueryResult {
  return Object.hasOwn(result, "queryKind") || Object.hasOwn(result, "traversal");
}

export { isNamedQueryResult };

function validateGraphFactNode(node: GraphFactNode): GraphFactNode {
  validateRequiredObject(node, "Graph fact node is required");
  validateNonEmptyString(node.id, "Graph fact node id");
  validateNonEmptyString(node.kind, "Graph fact node kind");
  if (node.path !== undefined) validateRepoRelativePath(node.path);
  if (node.name !== undefined) validateNonEmptyString(node.name, "Graph fact node name");
  return node;
}

export { validateGraphFactNode };

function validateGraphFactEdge(edge: GraphFactEdge): GraphFactEdge {
  validateRequiredObject(edge, "Graph fact edge is required");
  if (edge.id !== undefined) validateNonEmptyString(edge.id, "Graph fact edge id");
  validateNonEmptyString(edge.kind, "Graph fact edge kind");
  validateNonEmptyString(edge.from, "Graph fact edge from");
  validateNonEmptyString(edge.to, "Graph fact edge to");
  return edge;
}

export { validateGraphFactEdge };
