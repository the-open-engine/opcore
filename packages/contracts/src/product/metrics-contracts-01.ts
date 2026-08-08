import type { CommandTimingProcessState } from "../command/vocabulary.js";
import type { GraphProviderMode, GraphProviderStatusState } from "../graph/vocabulary-01.js";
import type { PythonProjectContext } from "../validation/python-project-contracts-02.js";
import type { ValidationResultStatus } from "../validation/vocabulary-01.js";
import type { OpcoreRepoStatePayload, OpcoreValidationPolicySummary } from "./status-contracts.js";

interface OpcoreMetricEvidence {
  source: string;
  path: string;
  message: string;
  checkId?: string;
  code?: string;
  line?: number;
  column?: number;
}

export type { OpcoreMetricEvidence };

interface OpcoreMetricSignal {
  id: string;
  title: string;
  category: "coverage" | "typescript" | "rust" | "graph" | (string & {});
  severity: "info" | "warning" | "error";
  count: number;
  evidence: readonly OpcoreMetricEvidence[];
}

export type { OpcoreMetricSignal };

interface OpcoreMetricDegradation {
  id: string;
  title: string;
  source: string;
  severity: "info" | "warning" | "error";
  message: string;
  checkId?: string;
  requiredTool?: string;
}

export type { OpcoreMetricDegradation };

interface OpcoreMetricReport {
  schemaVersion: 1;
  kind: "opcore_metric_report";
  generatedAt: string;
  repo: {
    root: string;
    requestedPath: string;
    git: OpcoreRepoStatePayload["repo"]["git"];
  };
  coverage: OpcoreRepoStatePayload["coverage"];
  graph: {
    state: GraphProviderStatusState;
    mode: GraphProviderMode;
    provider: string;
  };
  validation: {
    status?: ValidationResultStatus;
    diagnosticCount: number;
    checkCount: number;
    policy?: OpcoreValidationPolicySummary;
    pythonProjectContexts?: readonly PythonProjectContext[];
  };
  signals: readonly OpcoreMetricSignal[];
  degradations: readonly OpcoreMetricDegradation[];
  warnings: readonly string[];
  nextActions: readonly string[];
}

export type { OpcoreMetricReport };

interface OpcoreMetricHistoryEntry {
  schemaVersion: 1;
  kind: "opcore_metric_history_entry";
  recordedAt: string;
  report: OpcoreMetricReport;
}

export type { OpcoreMetricHistoryEntry };

interface OpcoreMeasureSignalCount {
  id: string;
  title: string;
  count: number;
}

export type { OpcoreMeasureSignalCount };

interface OpcoreMeasureSignalDelta {
  id: string;
  title: string;
  currentCount: number;
  comparisonCount: number;
  delta: number;
}

export type { OpcoreMeasureSignalDelta };

const opcoreMeasureLatencyStatuses = ["ok", "slower", "over_budget"] as const;

export { opcoreMeasureLatencyStatuses };

type OpcoreMeasureLatencyStatus = (typeof opcoreMeasureLatencyStatuses)[number];

export type { OpcoreMeasureLatencyStatus };

const opcoreMeasureLatencyFindingStatuses = ["slower", "over_budget"] as const;

export { opcoreMeasureLatencyFindingStatuses };

type OpcoreMeasureLatencyFindingStatus = (typeof opcoreMeasureLatencyFindingStatuses)[number];

export type { OpcoreMeasureLatencyFindingStatus };

interface OpcoreMeasureLatencyPhase {
  phase: string;
  durationMs: number;
}

export type { OpcoreMeasureLatencyPhase };

interface OpcoreMeasureLatencyFinding {
  canonicalCommand: readonly string[];
  repoShapeBucket: string;
  processState: CommandTimingProcessState;
  status: OpcoreMeasureLatencyFindingStatus;
  currentDurationMs: number;
  dominantPhase?: OpcoreMeasureLatencyPhase;
  baselineDurationMs?: number;
  previousDurationMs?: number;
  baselineDeltaMs?: number;
  previousDeltaMs?: number;
  budgetMs?: number;
  overBudgetMs?: number;
}

export type { OpcoreMeasureLatencyFinding };

interface OpcoreMeasureLatencyReport {
  kind: "opcore_latency_report";
  recordCount: number;
  budgetCount: number;
  findings: readonly OpcoreMeasureLatencyFinding[];
}

export type { OpcoreMeasureLatencyReport };

interface OpcoreMeasureComparison {
  recordedAt: string;
  generatedAt: string;
  coverage: OpcoreMetricReport["coverage"];
  signals: readonly OpcoreMeasureSignalCount[];
  deltas: readonly OpcoreMeasureSignalDelta[];
}

export type { OpcoreMeasureComparison };

interface OpcoreMeasureDelta {
  schemaVersion: 1;
  kind: "opcore_measure_delta";
  generatedAt: string;
  current: {
    generatedAt: string;
    coverage: OpcoreMetricReport["coverage"];
    signals: readonly OpcoreMeasureSignalCount[];
  };
  latency?: OpcoreMeasureLatencyReport;
  baseline?: OpcoreMeasureComparison;
  previous?: OpcoreMeasureComparison;
  warnings: readonly string[];
  degradations: readonly OpcoreMetricDegradation[];
  nextActions: readonly string[];
}

export type { OpcoreMeasureDelta };
