import type { GraphExtractionDiagnostic, GraphProviderAvailableStatus, RepoIdentity } from "./provider-contracts-01.js";
import type {
  GraphFactEdge,
  GraphFactNode,
  GraphProviderFailureStatus,
  GraphSnapshotMetadata,
} from "./provider-contracts-02.js";
import type { GraphEdgeKind, GraphNodeKind, GraphProviderMode } from "./vocabulary-01.js";

interface GraphFactQuerySelector {
  kind: "nodes" | "edges" | "neighbors" | "symbols" | "impact";
  nodeKinds?: readonly GraphNodeKind[];
  edgeKinds?: readonly GraphEdgeKind[];
  ids?: readonly string[];
  text?: string;
  limit?: number;
}

export type { GraphFactQuerySelector };

const graphFactQueryKinds = ["nodes", "edges", "neighbors", "symbols", "impact"] as const;

export { graphFactQueryKinds };

const graphNamedQueryKinds = [
  "callers_of",
  "callees_of",
  "importers_of",
  "imports_of",
  "tests_for",
  "inheritors_of",
  "children_of",
  "file_summary",
] as const;

export { graphNamedQueryKinds };

type GraphNamedQueryKind = (typeof graphNamedQueryKinds)[number];

export type { GraphNamedQueryKind };

type GraphProviderQueryKind =
  | GraphFactQuerySelector["kind"]
  | GraphNamedQueryKind
  | "review_context"
  | "detect_changes"
  | "search";

export type { GraphProviderQueryKind };

interface GraphFactQueryRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  selector: GraphFactQuerySelector;
}

export type { GraphFactQueryRequest };

interface GraphFactQueryAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  nodes: readonly GraphFactNode[];
  edges: readonly GraphFactEdge[];
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type { GraphFactQueryAvailableResult };

interface GraphFactQueryFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type { GraphFactQueryFailureResult };

type GraphFactQueryResult = GraphFactQueryAvailableResult | GraphFactQueryFailureResult;

export type { GraphFactQueryResult };

interface GraphTraversalMetadata {
  maxDepth: number;
  truncated: boolean;
  total: number;
  empty: boolean;
}

export type { GraphTraversalMetadata };

interface GraphNamedQueryRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  queryKind: GraphNamedQueryKind;
  target: string;
  maxDepth?: number;
  limit?: number;
}

export type { GraphNamedQueryRequest };

interface GraphNamedQueryAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  queryKind: GraphNamedQueryKind;
  target: string;
  nodes: readonly GraphFactNode[];
  edges: readonly GraphFactEdge[];
  traversal: GraphTraversalMetadata;
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type { GraphNamedQueryAvailableResult };

interface GraphNamedQueryFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type { GraphNamedQueryFailureResult };

type GraphNamedQueryResult = GraphNamedQueryAvailableResult | GraphNamedQueryFailureResult;

export type { GraphNamedQueryResult };

interface GraphImpactRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  files: readonly string[];
  baseRef?: string;
  maxDepth?: number;
  limit?: number;
}

export type { GraphImpactRequest };

interface GraphImpactAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  changedFiles: readonly string[];
  impactedFiles: readonly string[];
  impactedSymbols: readonly string[];
  tests: readonly string[];
  nodes: readonly GraphFactNode[];
  edges: readonly GraphFactEdge[];
  traversal: GraphTraversalMetadata;
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type { GraphImpactAvailableResult };
