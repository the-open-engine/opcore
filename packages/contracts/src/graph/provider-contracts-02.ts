import type { JsonValue } from "../shared/json.js";
import type {
  GraphFreshness,
  GraphProviderAvailableStatus,
  GraphProviderDaemonUnavailableStatus,
  GraphProviderErrorStatus,
  GraphProviderRequiredMissingStatus,
  GraphProviderSchemaMismatchStatus,
  GraphProviderSkippedStatus,
  GraphProviderStaleStatus,
  GraphProviderWarmingStatus,
  RepoIdentity,
} from "./provider-contracts-01.js";
import type { GraphEdgeKind, GraphNodeKind } from "./vocabulary-01.js";

type GraphProviderStatus =
  | GraphProviderAvailableStatus
  | GraphProviderWarmingStatus
  | GraphProviderSkippedStatus
  | GraphProviderRequiredMissingStatus
  | GraphProviderStaleStatus
  | GraphProviderSchemaMismatchStatus
  | GraphProviderDaemonUnavailableStatus
  | GraphProviderErrorStatus;

export type { GraphProviderStatus };

type GraphProviderFailureStatus = Exclude<
  GraphProviderStatus,
  GraphProviderAvailableStatus | GraphProviderWarmingStatus
>;

export type { GraphProviderFailureStatus };

type GraphProviderNonAvailableStatus = Exclude<GraphProviderStatus, GraphProviderAvailableStatus>;

export type { GraphProviderNonAvailableStatus };

interface GraphFactNode {
  id: string;
  kind: GraphNodeKind;
  path?: string;
  name?: string;
  attributes?: Record<string, JsonValue>;
}

export type { GraphFactNode };

interface GraphFactEdge {
  id?: string;
  kind: GraphEdgeKind;
  from: string;
  to: string;
  attributes?: Record<string, JsonValue>;
}

export type { GraphFactEdge };

interface GraphSnapshotMetadata {
  schemaVersion: number;
  provider: string;
  repo: RepoIdentity;
  generatedAt: string;
  freshness: GraphFreshness;
  nodeKinds: readonly GraphNodeKind[];
  edgeKinds: readonly GraphEdgeKind[];
}

export type { GraphSnapshotMetadata };
