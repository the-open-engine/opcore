import { validateOptional, validateRequiredObject } from "../shared/validators-02.js";
import { commandTimingProcessStates } from "../command/vocabulary.js";
import { includesString } from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateValidationCheckId,
} from "../shared/validators-01.js";
import type {
  OpcoreMeasureComparison,
  OpcoreMeasureLatencyFinding,
  OpcoreMeasureLatencyPhase,
  OpcoreMeasureLatencyReport,
  OpcoreMeasureSignalCount,
  OpcoreMeasureSignalDelta,
  OpcoreMetricDegradation,
  OpcoreMetricEvidence,
  OpcoreMetricSignal} from "./metrics-contracts-01.js";
import {
  opcoreMeasureLatencyFindingStatuses,
} from "./metrics-contracts-01.js";
import { validateOpcoreMetricCoverage } from "./metrics-coverage-validators.js";
import {
  assertNoOpaqueScoreFields,
  assertNoTelemetrySourceFields,
  validateLatencyCanonicalCommand,
  validateLatencyStableId,
} from "./metrics-validators-05.js";

function validateOpcoreMetricSignal(signal: OpcoreMetricSignal): OpcoreMetricSignal {
  validateRequiredObject(signal, "Opcore metric signal is required");
  validateNonEmptyString(signal.id, "Opcore metric signal id");
  validateNonEmptyString(signal.title, "Opcore metric signal title");
  validateNonEmptyString(signal.category, "Opcore metric signal category");
  if (!includesString(["info", "warning", "error"] as const, signal.severity)) {
    throw new Error(`Unknown Opcore metric signal severity: ${String(signal.severity)}`);
  }
  if (!Number.isInteger(signal.count) || signal.count <= 0) {
    throw new Error("Opcore metric signal count must be a positive integer");
  }
  if (!Array.isArray(signal.evidence) || signal.evidence.length === 0) {
    throw new Error("Opcore metric signal evidence must be a non-empty array");
  }
  for (const evidence of signal.evidence) validateOpcoreMetricEvidence(evidence);
  return signal;
}

export { validateOpcoreMetricSignal };

function validateOpcoreMetricEvidence(evidence: OpcoreMetricEvidence): OpcoreMetricEvidence {
  validateRequiredObject(evidence, "Opcore metric evidence is required");
  validateNonEmptyString(evidence.source, "Opcore metric evidence source");
  validateRepoRelativePath(validateNonEmptyString(evidence.path, "Opcore metric evidence path"));
  validateNonEmptyString(evidence.message, "Opcore metric evidence message");
  if (evidence.checkId !== undefined) validateValidationCheckId(evidence.checkId, "Opcore metric evidence checkId");
  if (evidence.code !== undefined) validateNonEmptyString(evidence.code, "Opcore metric evidence code");
  if (evidence.line !== undefined && (!Number.isInteger(evidence.line) || evidence.line < 1)) {
    throw new Error("Opcore metric evidence line must be a positive integer");
  }
  if (evidence.column !== undefined && (!Number.isInteger(evidence.column) || evidence.column < 1)) {
    throw new Error("Opcore metric evidence column must be a positive integer");
  }
  return evidence;
}

export { validateOpcoreMetricEvidence };

function validateOpcoreMetricDegradation(degradation: OpcoreMetricDegradation): OpcoreMetricDegradation {
  validateRequiredObject(degradation, "Opcore metric degradation is required");
  validateNonEmptyString(degradation.id, "Opcore metric degradation id");
  validateNonEmptyString(degradation.title, "Opcore metric degradation title");
  validateNonEmptyString(degradation.source, "Opcore metric degradation source");
  if (!includesString(["info", "warning", "error"] as const, degradation.severity)) {
    throw new Error(`Unknown Opcore metric degradation severity: ${String(degradation.severity)}`);
  }
  validateNonEmptyString(degradation.message, "Opcore metric degradation message");
  if (degradation.checkId !== undefined)
    validateValidationCheckId(degradation.checkId, "Opcore metric degradation checkId");
  if (degradation.requiredTool !== undefined) {
    validateNonEmptyString(degradation.requiredTool, "Opcore metric degradation requiredTool");
  }
  return degradation;
}

export { validateOpcoreMetricDegradation };

function validateOpcoreMeasureLatencyReport(report: OpcoreMeasureLatencyReport): OpcoreMeasureLatencyReport {
  assertNoOpaqueScoreFields(report, "Opcore measure latency report");
  assertNoTelemetrySourceFields(report, "Opcore measure latency report");
  validateRequiredObject(report, "Opcore measure latency report is required");
  if (report.kind !== "opcore_latency_report") {
    throw new Error("Opcore measure latency report kind must be opcore_latency_report");
  }
  validateNonNegativeInteger(report.recordCount, "Opcore measure latency report recordCount");
  validateNonNegativeInteger(report.budgetCount, "Opcore measure latency report budgetCount");
  if (!Array.isArray(report.findings)) {
    throw new Error("Opcore measure latency report findings must be an array");
  }
  for (const finding of report.findings) validateOpcoreMeasureLatencyFinding(finding);
  return report;
}

export { validateOpcoreMeasureLatencyReport };

function validateOpcoreMeasureLatencyFinding(finding: OpcoreMeasureLatencyFinding): OpcoreMeasureLatencyFinding {
  assertNoOpaqueScoreFields(finding, "Opcore measure latency finding");
  assertNoTelemetrySourceFields(finding, "Opcore measure latency finding");
  validateRequiredObject(finding, "Opcore measure latency finding is required");
  validateLatencyCanonicalCommand(finding.canonicalCommand, "Opcore measure latency finding canonicalCommand");
  validateLatencyStableId(finding.repoShapeBucket, "Opcore measure latency finding repoShapeBucket");
  if (!includesString(commandTimingProcessStates, finding.processState)) {
    throw new Error(`Unknown Opcore measure latency processState: ${String(finding.processState)}`);
  }
  if (!includesString(opcoreMeasureLatencyFindingStatuses, finding.status)) {
    throw new Error(`Unknown Opcore measure latency status: ${String(finding.status)}`);
  }
  validateNonNegativeNumber(finding.currentDurationMs, "Opcore measure latency finding currentDurationMs");
  validateOptional(finding.dominantPhase, validateOpcoreMeasureLatencyPhase);
  validateOptional(finding.baselineDurationMs, (value) =>
    validateNonNegativeNumber(value, "Opcore measure latency finding baselineDurationMs"),
  );
  validateOptional(finding.previousDurationMs, (value) =>
    validateNonNegativeNumber(value, "Opcore measure latency finding previousDurationMs"),
  );
  validateOptional(finding.baselineDeltaMs, (value) =>
    validateFiniteLatencyDelta(value, "baselineDeltaMs"),
  );
  validateOptional(finding.previousDeltaMs, (value) =>
    validateFiniteLatencyDelta(value, "previousDeltaMs"),
  );
  validateOptional(finding.budgetMs, (value) =>
    validateNonNegativeNumber(value, "Opcore measure latency finding budgetMs"),
  );
  validateOptional(finding.overBudgetMs, (value) =>
    validateNonNegativeNumber(value, "Opcore measure latency finding overBudgetMs"),
  );
  if (finding.status === "over_budget" && (finding.overBudgetMs ?? 0) <= 0) {
    throw new Error("Opcore measure latency over_budget finding must include overBudgetMs");
  }
  return finding;
}

export { validateOpcoreMeasureLatencyFinding };

function validateFiniteLatencyDelta(value: number, field: "baselineDeltaMs" | "previousDeltaMs"): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Opcore measure latency finding ${field} must be a finite number`);
  }
}

function validateOpcoreMeasureLatencyPhase(phase: OpcoreMeasureLatencyPhase): OpcoreMeasureLatencyPhase {
  validateRequiredObject(phase, "Opcore measure latency phase is required");
  validateLatencyStableId(phase.phase, "Opcore measure latency phase");
  validateNonNegativeNumber(phase.durationMs, "Opcore measure latency phase durationMs");
  return phase;
}

export { validateOpcoreMeasureLatencyPhase };

function validateOpcoreMeasureComparison(comparison: OpcoreMeasureComparison, label: string): OpcoreMeasureComparison {
  validateRequiredObject(comparison, `Opcore measure delta ${label} comparison is required`);
  validateNonEmptyString(comparison.recordedAt, `Opcore measure delta ${label} recordedAt`);
  validateNonEmptyString(comparison.generatedAt, `Opcore measure delta ${label} generatedAt`);
  validateOpcoreMetricCoverage(comparison.coverage, `Opcore measure delta ${label} coverage`);
  validateOpcoreMeasureSignalCounts(comparison.signals, `Opcore measure delta ${label} signals`);
  if (!Array.isArray(comparison.deltas)) {
    throw new Error(`Opcore measure delta ${label} deltas must be an array`);
  }
  for (const entry of comparison.deltas) validateOpcoreMeasureSignalDelta(entry, label);
  return comparison;
}

export { validateOpcoreMeasureComparison };

function validateOpcoreMeasureSignalCounts(counts: readonly OpcoreMeasureSignalCount[], label: string): void {
  if (!Array.isArray(counts)) {
    throw new Error(`${label} must be an array`);
  }
  for (const count of counts) {
    validateRequiredObject(count, `${label} entry is required`);
    validateNonEmptyString(count.id, `${label} id`);
    validateNonEmptyString(count.title, `${label} title`);
    validateNonNegativeInteger(count.count, `${label} count`);
  }
}

export { validateOpcoreMeasureSignalCounts };

function validateOpcoreMeasureSignalDelta(delta: OpcoreMeasureSignalDelta, label: string): OpcoreMeasureSignalDelta {
  validateRequiredObject(delta, `Opcore measure delta ${label} entry is required`);
  validateNonEmptyString(delta.id, `Opcore measure delta ${label} id`);
  validateNonEmptyString(delta.title, `Opcore measure delta ${label} title`);
  validateNonNegativeInteger(delta.currentCount, `Opcore measure delta ${label} currentCount`);
  validateNonNegativeInteger(delta.comparisonCount, `Opcore measure delta ${label} comparisonCount`);
  if (!Number.isInteger(delta.delta)) {
    throw new Error(`Opcore measure delta ${label} delta must be an integer`);
  }
  return delta;
}

export { validateOpcoreMeasureSignalDelta };
