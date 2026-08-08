import { includesString } from "../shared/primitives.js";
import {
  validateRepoIdentity,
  validateRepoRelativePath,
  validateRepoRelativePaths,
} from "../shared/path-validators.js";
import { validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import type { GraphDaemonOperation} from "./pipeline-contracts.js";
import { graphDaemonOperations } from "./pipeline-contracts.js";
import type { RepoIdentity } from "./provider-contracts-01.js";
import type {
  GraphFactQuerySelector,
  GraphNamedQueryKind,
  GraphProviderQueryKind,
  GraphTraversalMetadata} from "./query-contracts-01.js";
import {
  graphFactQueryKinds,
  graphNamedQueryKinds,
} from "./query-contracts-01.js";
import type { GraphSearchMode, GraphSearchResultEntry, GraphSearchSummary } from "./search-contracts.js";
import type { GraphProviderMode} from "./vocabulary-01.js";
import { GRAPH_SCHEMA_VERSION, graphProviderModes } from "./vocabulary-01.js";

function validateGraphDaemonOperation(operation: unknown): GraphDaemonOperation {
  if (!includesString(graphDaemonOperations, operation)) {
    throw new Error(`Unknown graph daemon operation: ${String(operation)}`);
  }
  return operation;
}

export { validateGraphDaemonOperation };

function validateGraphFactQueryKind(kind: unknown): GraphFactQuerySelector["kind"] {
  if (!includesString(graphFactQueryKinds, kind)) {
    throw new Error(`Unknown graph fact query kind: ${String(kind)}`);
  }
  return kind;
}

export { validateGraphFactQueryKind };

function validateGraphNamedQueryKind(kind: unknown): GraphNamedQueryKind {
  if (!includesString(graphNamedQueryKinds, kind)) {
    throw new Error(`Unknown graph named query kind: ${String(kind)}`);
  }
  return kind;
}

export { validateGraphNamedQueryKind };

function validateGraphProviderQueryKind(kind: unknown): GraphProviderQueryKind {
  if (
    !includesString(graphFactQueryKinds, kind) &&
    !includesString(graphNamedQueryKinds, kind) &&
    kind !== "review_context" &&
    kind !== "detect_changes" &&
    kind !== "search"
  ) {
    throw new Error(`Unknown graph provider query kind: ${String(kind)}`);
  }
  return kind;
}

export { validateGraphProviderQueryKind };

function validateGraphQueryRequestBase(
  request: {
    requestId?: string;
    repo: RepoIdentity;
    schemaVersion: number;
    mode: GraphProviderMode;
  },
  label: string,
): void {
  if (!request || typeof request !== "object") throw new Error(`${label} is required`);
  if (request.requestId !== undefined) validateNonEmptyString(request.requestId, `${label} requestId`);
  validateRepoIdentity(request.repo);
  if (request.schemaVersion !== GRAPH_SCHEMA_VERSION)
    throw new Error(`${label} schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  if (!includesString(graphProviderModes, request.mode))
    throw new Error(`Unknown ${label} mode: ${String(request.mode)}`);
}

export { validateGraphQueryRequestBase };

function validateTraversalOptions(maxDepth: number | undefined, limit: number | undefined, label: string): void {
  if (maxDepth !== undefined && (!Number.isFinite(maxDepth) || maxDepth < 0)) {
    throw new Error(`${label} maxDepth must be a non-negative number`);
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`${label} limit must be a positive number`);
  }
}

export { validateTraversalOptions };

function validateGraphTraversalMetadata(metadata: GraphTraversalMetadata): GraphTraversalMetadata {
  if (!metadata || typeof metadata !== "object") throw new Error("Graph traversal metadata is required");
  if (typeof metadata.maxDepth !== "number" || metadata.maxDepth < 0) {
    throw new Error("Graph traversal metadata maxDepth must be non-negative");
  }
  if (typeof metadata.truncated !== "boolean") throw new Error("Graph traversal metadata truncated must be boolean");
  if (typeof metadata.total !== "number" || metadata.total < 0)
    throw new Error("Graph traversal metadata total must be non-negative");
  if (typeof metadata.empty !== "boolean") throw new Error("Graph traversal metadata empty must be boolean");
  return metadata;
}

export { validateGraphTraversalMetadata };

function validateGraphSearchMode(mode: GraphSearchMode): GraphSearchMode {
  if (!mode || typeof mode !== "object") throw new Error("Graph search mode is required");
  validateNonEmptyString(mode.engine, "Graph search mode engine");
  validateNonEmptyString(mode.querySyntax, "Graph search mode querySyntax");
  if (!Number.isFinite(mode.limit) || mode.limit < 1)
    throw new Error("Graph search mode limit must be a positive number");
  validateRepoRelativePaths(mode.contextFiles, "Graph search mode contextFiles");
  return mode;
}

export { validateGraphSearchMode };

function validateGraphSearchSummary(summary: GraphSearchSummary): GraphSearchSummary {
  if (!summary || typeof summary !== "object") throw new Error("Graph search summary is required");
  validateNonEmptyString(summary.query, "Graph search summary query");
  for (const key of ["total", "returned", "limit"] as const) {
    if (!Number.isFinite(summary[key]) || summary[key] < (key === "limit" ? 1 : 0)) {
      throw new Error(`Graph search summary ${key} must be a non-negative number`);
    }
  }
  validateStringArray(summary.indexedNodeKinds, "Graph search summary indexedNodeKinds", { allowEmpty: true });
  validateRepoRelativePaths(summary.contextFiles, "Graph search summary contextFiles");
  return summary;
}

export { validateGraphSearchSummary };

function validateGraphSearchResultEntry(entry: GraphSearchResultEntry): GraphSearchResultEntry {
  if (!entry || typeof entry !== "object") throw new Error("Graph search result entry is required");
  validateNonEmptyString(entry.nodeId, "Graph search result entry nodeId");
  validateNonEmptyString(entry.kind, "Graph search result entry kind");
  if (entry.path !== undefined) validateRepoRelativePath(entry.path);
  if (entry.name !== undefined) validateNonEmptyString(entry.name, "Graph search result entry name");
  validateNonEmptyString(entry.qualifiedName, "Graph search result entry qualifiedName");
  if (entry.filePath !== undefined) validateRepoRelativePath(entry.filePath);
  validateNonEmptyString(entry.signature, "Graph search result entry signature");
  if (!Number.isFinite(entry.score)) throw new Error("Graph search result entry score must be numeric");
  if (!Number.isFinite(entry.rank) || entry.rank < 1)
    throw new Error("Graph search result entry rank must be a positive number");
  validateStringArray(entry.matches, "Graph search result entry matches", {
    allowEmpty: true,
  });
  return entry;
}

export { validateGraphSearchResultEntry };
