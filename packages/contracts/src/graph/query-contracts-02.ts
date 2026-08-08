import type { GraphExtractionDiagnostic, GraphProviderAvailableStatus, RepoIdentity } from "./provider-contracts-01.js";
import type {
  GraphFactEdge,
  GraphFactNode,
  GraphProviderFailureStatus,
  GraphSnapshotMetadata,
} from "./provider-contracts-02.js";
import type { GraphImpactAvailableResult, GraphTraversalMetadata } from "./query-contracts-01.js";
import type { GraphProviderMode } from "./vocabulary-01.js";

interface GraphImpactFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type { GraphImpactFailureResult };

type GraphImpactResult = GraphImpactAvailableResult | GraphImpactFailureResult;

export type { GraphImpactResult };

interface GraphRenamedFile {
  fromPath: string;
  toPath: string;
  checksumBefore?: string;
  checksumAfter?: string;
}

export type { GraphRenamedFile };

interface GraphDetectChangesRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  files?: readonly string[];
  baseRef?: string;
}

export type { GraphDetectChangesRequest };

interface GraphDetectChangesAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  changedFiles: readonly string[];
  deletedFiles: readonly string[];
  renamedFiles: readonly GraphRenamedFile[];
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type { GraphDetectChangesAvailableResult };

interface GraphDetectChangesFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type { GraphDetectChangesFailureResult };

type GraphDetectChangesResult = GraphDetectChangesAvailableResult | GraphDetectChangesFailureResult;

export type { GraphDetectChangesResult };

interface GraphReviewContextRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  files?: readonly string[];
  baseRef?: string;
  maxDepth?: number;
  limit?: number;
}

export type { GraphReviewContextRequest };

interface GraphReviewContextAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  changedFiles: readonly string[];
  deletedFiles: readonly string[];
  renamedFiles: readonly GraphRenamedFile[];
  impactedFiles: readonly string[];
  impactedSymbols: readonly string[];
  tests: readonly string[];
  nodes: readonly GraphFactNode[];
  edges: readonly GraphFactEdge[];
  traversal: GraphTraversalMetadata;
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type { GraphReviewContextAvailableResult };

interface GraphReviewContextFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type { GraphReviewContextFailureResult };

type GraphReviewContextResult = GraphReviewContextAvailableResult | GraphReviewContextFailureResult;

export type { GraphReviewContextResult };
