import type {
  CommandOwner,
  CommandRouteStatus,
  CommandTimingDegradationReason,
  CommandTimingProcessState,
  LatencyBudgetResultStatus,
} from "../command/vocabulary.js";
import type { GraphPipelinePhaseTiming } from "../graph/pipeline-contracts.js";

type CommandTimingPhase = Pick<GraphPipelinePhaseTiming, "phase" | "durationMs" | "fileCount">;

export type { CommandTimingPhase };

interface CommandTiming {
  durationMs: number;
  phases: readonly CommandTimingPhase[];
  processState: CommandTimingProcessState;
  degradations?: readonly CommandTimingDegradationReason[];
}

export type { CommandTiming };

interface RepoShapeFingerprint {
  totalFiles: number;
  languages: readonly {
    language: string;
    files: number;
  }[];
  graph: {
    supportedFiles: number;
    unsupportedFiles: number;
  };
  git: {
    available: boolean;
    clean?: boolean;
  };
}

export type { RepoShapeFingerprint };

interface CommandLatencyRecord {
  schemaVersion: 1;
  recordedAt: string;
  bin: string;
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  exitCode: number;
  repo: RepoShapeFingerprint;
  timing: CommandTiming;
  opcoreVersion: string;
}

export type { CommandLatencyRecord };

interface LatencyPhaseBudget {
  phase: string;
  budgetMs: number;
}

export type { LatencyPhaseBudget };

interface LatencyBudget {
  schemaVersion: 1;
  canonicalCommand: readonly string[];
  scope: string;
  repoShapeBucket: string;
  budgetMs: number;
  phaseBudgets?: readonly LatencyPhaseBudget[];
}

export type { LatencyBudget };

interface LatencyBudgetResult {
  schemaVersion: 1;
  status: LatencyBudgetResultStatus;
  budget: LatencyBudget;
  observed: {
    canonicalCommand: readonly string[];
    phase: string;
    durationMs: number;
  };
  evidence: {
    canonicalCommand: readonly string[];
    phase: string;
    repoShapeBucket: string;
    observedMs: number;
    budgetMs: number;
    overByMs: number;
  };
}

export type { LatencyBudgetResult };
