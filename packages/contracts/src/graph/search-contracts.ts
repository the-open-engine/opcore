import type { GraphExtractionDiagnostic, GraphProviderAvailableStatus, RepoIdentity } from "./provider-contracts-01.js";
import type { GraphProviderNonAvailableStatus, GraphSnapshotMetadata } from "./provider-contracts-02.js";
import type { GraphNodeKind, GraphProviderMode } from "./vocabulary-01.js";

interface GraphSearchRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  query: string;
  limit?: number;
  files?: readonly string[];
}

export type { GraphSearchRequest };

interface GraphSearchMode {
  engine: "fts5" | (string & {});
  querySyntax: "fts5" | (string & {});
  limit: number;
  contextFiles: readonly string[];
}

export type { GraphSearchMode };

interface GraphSearchResultEntry {
  nodeId: string;
  kind: GraphNodeKind;
  path?: string;
  name?: string;
  qualifiedName: string;
  filePath?: string;
  signature: string;
  score: number;
  rank: number;
  matches: readonly string[];
}

export type { GraphSearchResultEntry };

interface GraphSearchSummary {
  query: string;
  total: number;
  returned: number;
  limit: number;
  indexedNodeKinds: readonly GraphNodeKind[];
  contextFiles: readonly string[];
}

export type { GraphSearchSummary };

interface GraphSearchAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  query: string;
  searchMode: GraphSearchMode;
  summary: GraphSearchSummary;
  results: readonly GraphSearchResultEntry[];
  hints: readonly string[];
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type { GraphSearchAvailableResult };

interface GraphSearchFailureResult {
  requestId?: string;
  status: GraphProviderNonAvailableStatus;
  hints?: readonly string[];
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type { GraphSearchFailureResult };

type GraphSearchResult = GraphSearchAvailableResult | GraphSearchFailureResult;

export type { GraphSearchResult };
