import type { GraphProviderArtifactMetadata, ProviderFailure, RepoIdentity } from "./provider-contracts-01.js";
import type { GraphProviderStatus } from "./provider-contracts-02.js";
import type {
  GraphFactQueryRequest,
  GraphFactQueryResult,
  GraphImpactRequest,
  GraphNamedQueryRequest,
  GraphNamedQueryResult,
} from "./query-contracts-01.js";
import type {
  GraphDetectChangesRequest,
  GraphDetectChangesResult,
  GraphImpactResult,
  GraphReviewContextRequest,
  GraphReviewContextResult,
} from "./query-contracts-02.js";
import type { GraphSearchRequest, GraphSearchResult } from "./search-contracts.js";

type GraphPipelineOperation = "build" | "update" | "watch";

export type { GraphPipelineOperation };

interface GraphPipelinePhaseTiming {
  phase: "discovery" | "extraction" | "store" | "watch" | "status" | (string & {});
  startedAt: string;
  completedAt: string;
  durationMs: number;
  fileCount?: number;
}

export type { GraphPipelinePhaseTiming };

interface GraphWalCheckpointSummary {
  walPath: string;
  bytesBefore: number;
  bytesAfter: number;
  budgetBytes: number;
  checkpointed: boolean;
}

export type { GraphWalCheckpointSummary };

interface GraphPipelineSummary {
  operation: GraphPipelineOperation;
  repo: RepoIdentity;
  storePath?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  discoveredFiles: number;
  parsedFiles: number;
  changedFiles: readonly string[];
  deletedFiles: readonly string[];
  unchangedFiles: number;
  fullRebuildRequired: boolean;
  diagnosticsCount: number;
  phaseTimings: readonly GraphPipelinePhaseTiming[];
  baseRef?: string;
  watchPaths?: readonly string[];
  walCheckpoint?: GraphWalCheckpointSummary;
}

export type { GraphPipelineSummary };

interface GraphWatchLifecycle {
  state: "warming" | "available" | "error" | "stopped";
  pid?: number;
  startedAt: string;
  updatedAt: string;
  pidPath: string;
  statePath: string;
  logPath: string;
  pollIntervalMs: number;
  idleTimeoutMs: number;
  watchPaths?: readonly string[];
  message?: string;
}

export type { GraphWatchLifecycle };

interface GraphServeTransportStatus {
  schemaVersion: 1;
  protocol: "opcore.graph.daemon";
  transport: "stdio";
  state: "ready" | "error" | "stopped";
  repo: RepoIdentity;
  provider: "opcore-graph" | (string & {});
  pid?: number;
  artifact?: GraphProviderArtifactMetadata;
  failure?: ProviderFailure;
  message?: string;
}

export type { GraphServeTransportStatus };

interface GraphPipelineResult {
  summary: GraphPipelineSummary;
  status: GraphProviderStatus;
  lifecycle?: GraphWatchLifecycle;
}

export type { GraphPipelineResult };

type GraphDaemonOperation = "build" | "update" | "watch" | "status" | "query" | "ping" | "health" | "shutdown";

export type { GraphDaemonOperation };

const graphDaemonOperations = ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"] as const;

export { graphDaemonOperations };

interface GraphDaemonRequest {
  protocol: "opcore.graph.daemon";
  requestId: string;
  schemaVersion: number;
  operation: GraphDaemonOperation;
  repo: RepoIdentity;
  query?: GraphFactQueryRequest;
  namedQuery?: GraphNamedQueryRequest;
  impact?: GraphImpactRequest;
  reviewContext?: GraphReviewContextRequest;
  changes?: GraphDetectChangesRequest;
  search?: GraphSearchRequest;
  baseRef?: string;
  paths?: readonly string[];
  watchPaths?: readonly string[];
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  once?: boolean;
  maxWalBytes?: number;
}

export type { GraphDaemonRequest };

interface GraphDaemonResponse {
  protocol: "opcore.graph.daemon";
  requestId: string;
  schemaVersion: number;
  status: GraphProviderStatus;
  result?: GraphFactQueryResult;
  namedQuery?: GraphNamedQueryResult;
  impact?: GraphImpactResult;
  reviewContext?: GraphReviewContextResult;
  changes?: GraphDetectChangesResult;
  search?: GraphSearchResult;
  pipeline?: GraphPipelineResult;
  lifecycle?: GraphWatchLifecycle;
}

export type { GraphDaemonResponse };
