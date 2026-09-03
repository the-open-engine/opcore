import type { GraphDaemonOperation, GraphWalCheckpointSummary, GraphWatchLifecycle } from "./pipeline-contracts.js";
import type { GraphProviderQueryKind } from "./query-contracts-01.js";
import type {
  GraphEdgeKind,
  GraphNodeKind,
  GraphProviderErrorFailureCategory,
  GraphProviderMode,
  GraphProviderStatusState,
  ProviderFailureCategory,
} from "./vocabulary-01.js";
import type { GraphExtractionDiagnosticCategory } from "./vocabulary-02.js";

interface RepoIdentity {
  repoId?: string;
  repoRoot?: string;
  remoteUrl?: string;
  commitSha?: string;
}

export type { RepoIdentity };

interface GraphFreshness {
  generatedAt: string;
  ageMs: number;
  maxAgeMs?: number;
  stale: boolean;
  reason?: string;
}

export type { GraphFreshness };

interface GraphProviderArtifactMetadata {
  artifactName: "opcore-graph-core" | (string & {});
  artifactVersion: string;
  targetPlatform: string;
  binaryPath: string;
  checksumPath: string;
  checksumSha256: string;
  buildProfile: string;
}

export type { GraphProviderArtifactMetadata };

interface GraphProviderCapabilityHandshake {
  provider: "opcore-graph" | (string & {});
  graphSchemaVersion: number;
  artifactName: "opcore-graph-core" | (string & {});
  artifactVersion: string;
  targetPlatform: string;
  supportedOperations: readonly GraphDaemonOperation[];
  nodeKinds: readonly GraphNodeKind[];
  edgeKinds: readonly GraphEdgeKind[];
  queryKinds: readonly GraphProviderQueryKind[];
  artifact: GraphProviderArtifactMetadata;
}

export type { GraphProviderCapabilityHandshake };

interface ProviderFailure {
  category: ProviderFailureCategory;
  message: string;
  retryable?: boolean;
  cause?: string;
}

export type { ProviderFailure };

type ProviderFailureWithCategory<Category extends ProviderFailureCategory> = ProviderFailure & { category: Category };

export type { ProviderFailureWithCategory };

interface GraphExtractionDiagnostic {
  category: GraphExtractionDiagnosticCategory;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
  language?: string;
}

export type { GraphExtractionDiagnostic };

interface GraphProviderStatusBase {
  state: GraphProviderStatusState;
  mode: GraphProviderMode;
  provider: string;
  schemaVersion: number;
  message?: string;
}

export type { GraphProviderStatusBase };

interface GraphProviderAvailableStatus extends GraphProviderStatusBase {
  state: "available";
  repo: RepoIdentity;
  freshness: GraphFreshness;
  dbPath?: string;
  nodes_by_kind: Readonly<Record<string, number>>;
  edges_by_kind: Readonly<Record<string, number>>;
  capabilities?: readonly string[];
  handshake?: GraphProviderCapabilityHandshake;
  walCheckpoint?: GraphWalCheckpointSummary;
}

export type { GraphProviderAvailableStatus };

interface GraphProviderWarmingStatus extends GraphProviderStatusBase {
  state: "warming";
  repo: RepoIdentity;
  freshness: GraphFreshness;
  lifecycle?: GraphWatchLifecycle;
}

export type { GraphProviderWarmingStatus };

interface GraphProviderSkippedStatus extends GraphProviderStatusBase {
  state: "skipped";
  mode: "optional";
  failure: ProviderFailureWithCategory<"provider_missing">;
}

export type { GraphProviderSkippedStatus };

interface GraphProviderRequiredMissingStatus extends GraphProviderStatusBase {
  state: "required_missing";
  mode: "required";
  failure: ProviderFailureWithCategory<"provider_missing">;
}

export type { GraphProviderRequiredMissingStatus };

interface GraphProviderStaleStatus extends GraphProviderStatusBase {
  state: "stale";
  repo: RepoIdentity;
  freshness: GraphFreshness;
  failure: ProviderFailureWithCategory<"stale_snapshot">;
}

export type { GraphProviderStaleStatus };

interface GraphProviderSchemaMismatchStatus extends GraphProviderStatusBase {
  state: "schema_mismatch";
  expectedSchemaVersion: number;
  actualSchemaVersion: number;
  failure: ProviderFailureWithCategory<"schema_mismatch">;
}

export type { GraphProviderSchemaMismatchStatus };

interface GraphProviderDaemonUnavailableStatus extends GraphProviderStatusBase {
  state: "daemon_unavailable";
  failure: ProviderFailureWithCategory<"daemon_unavailable">;
}

export type { GraphProviderDaemonUnavailableStatus };

interface GraphProviderErrorStatus extends GraphProviderStatusBase {
  state: "error";
  failure: ProviderFailureWithCategory<GraphProviderErrorFailureCategory>;
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type { GraphProviderErrorStatus };
