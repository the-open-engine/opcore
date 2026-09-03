import {
  validateBoolean,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { latencyBudgetResultStatuses } from "../command/vocabulary.js";
import { includesString, sameStringArray } from "../shared/primitives.js";
import { graphProviderModes, graphProviderStatusStates } from "../graph/vocabulary-01.js";
import { validateHomeRelativePath, validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateStringArray,
} from "../shared/validators-01.js";
import { validatePythonProjectContexts } from "../validation/python-project-validators-01.js";
import { validationResultStatuses } from "../validation/vocabulary-01.js";
import type { OpcoreInitAction} from "./init-contracts.js";
import { opcoreInitScopes } from "./init-contracts.js";
import type { LatencyBudgetResult } from "./latency-contracts.js";
import type { OpcoreMetricReport } from "./metrics-contracts-01.js";
import { validateOpcoreMetricCoverage } from "./metrics-coverage-validators.js";
import { validateLatencyBudget } from "./metrics-validators-01.js";
import { validateOpcoreMetricDegradation, validateOpcoreMetricSignal } from "./metrics-validators-04.js";
import {
  assertNoOpaqueScoreFields,
  assertNoTelemetrySourceFields,
  resolveLatencyAppliedBudgetMs,
  validateLatencyCanonicalCommand,
  validateLatencyStableId,
} from "./metrics-validators-05.js";
import { validateOpcoreValidationPolicySummary } from "./status-validators.js";

function validateLatencyBudgetResult(result: LatencyBudgetResult): LatencyBudgetResult {
  assertNoOpaqueScoreFields(result, "Latency budget result");
  assertNoTelemetrySourceFields(result, "Latency budget result");
  validateRequiredObject(result, "Latency budget result is required");
  if (result.schemaVersion !== 1) {
    throw new Error("Latency budget result schemaVersion must be 1");
  }
  if (!includesString(latencyBudgetResultStatuses, result.status)) {
    throw new Error(`Unknown latency budget result status: ${String(result.status)}`);
  }
  const budget = validateLatencyBudget(result.budget);
  validateLatencyBudgetResultEvidence(result);
  validateLatencyBudgetResultConsistency(result, budget);
  validateLatencyBudgetResultStatus(result);
  return result;
}

export { validateLatencyBudgetResult };

function validateLatencyBudgetResultEvidence(result: LatencyBudgetResult): void {
  validateRequiredObject(result.observed, "Latency budget result observed is required");
  validateLatencyCanonicalCommand(result.observed.canonicalCommand, "Latency budget result observed canonicalCommand");
  validateLatencyStableId(result.observed.phase, "Latency budget result observed phase");
  validateNonNegativeNumber(result.observed.durationMs, "Latency budget result observed durationMs");
  validateRequiredObject(result.evidence, "Latency budget result evidence is required");
  validateLatencyCanonicalCommand(result.evidence.canonicalCommand, "Latency budget result evidence canonicalCommand");
  validateLatencyStableId(result.evidence.phase, "Latency budget result evidence phase");
  validateLatencyStableId(result.evidence.repoShapeBucket, "Latency budget result evidence repoShapeBucket");
  validateNonNegativeNumber(result.evidence.observedMs, "Latency budget result evidence observedMs");
  validateNonNegativeNumber(result.evidence.budgetMs, "Latency budget result evidence budgetMs");
  validateNonNegativeNumber(result.evidence.overByMs, "Latency budget result evidence overByMs");
}

function validateLatencyBudgetResultConsistency(
  result: LatencyBudgetResult,
  budget: ReturnType<typeof validateLatencyBudget>,
): void {
  if (!sameStringArray(result.observed.canonicalCommand, result.evidence.canonicalCommand)) {
    throw new Error("Latency budget result observed and evidence commands must match");
  }
  if (!sameStringArray(budget.canonicalCommand, result.evidence.canonicalCommand)) {
    throw new Error("Latency budget result evidence command must match budget command");
  }
  if (result.observed.phase !== result.evidence.phase) {
    throw new Error("Latency budget result observed and evidence phases must match");
  }
  if (budget.repoShapeBucket !== result.evidence.repoShapeBucket) {
    throw new Error("Latency budget result evidence bucket must match budget bucket");
  }
  if (result.observed.durationMs !== result.evidence.observedMs) {
    throw new Error("Latency budget result observed duration must match evidence observedMs");
  }
  const appliedBudgetMs = resolveLatencyAppliedBudgetMs(budget, result.evidence.phase);
  if (result.evidence.budgetMs !== appliedBudgetMs) {
    throw new Error("Latency budget result evidence budgetMs must match the applied budget");
  }
  const computedOverByMs = Math.max(0, result.evidence.observedMs - appliedBudgetMs);
  if (result.evidence.overByMs !== computedOverByMs) {
    throw new Error("Latency budget result overByMs must equal observedMs over budgetMs");
  }
}

function validateLatencyBudgetResultStatus(result: LatencyBudgetResult): void {
  if (result.status === "pass" && result.evidence.overByMs !== 0) {
    throw new Error("Latency budget pass result must not exceed budget");
  }
  if (result.status === "over" && result.evidence.overByMs <= 0) {
    throw new Error("Latency budget over result must exceed budget");
  }
}

function validateOpcoreInitAction(action: OpcoreInitAction): OpcoreInitAction {
  validateRequiredObject(action, "Opcore init action is required");
  if (
    !includesString(["write", "upsert_block", "create_hook", "wire_harness", "restore", "remove"] as const, action.kind)
  ) {
    throw new Error(`Unknown Opcore init action kind: ${String(action.kind)}`);
  }
  if (!includesString(opcoreInitScopes, action.targetScope)) {
    throw new Error(`Unknown Opcore init action targetScope: ${String(action.targetScope)}`);
  }
  const rawPath = validateNonEmptyString(action.path, "Opcore init action path");
  const path = action.targetScope === "global" ? validateHomeRelativePath(rawPath) : validateRepoRelativePath(rawPath);
  validateNonEmptyString(action.summary, "Opcore init action summary");
  validateBoolean(action.requiresApproval, "Opcore init action requiresApproval");
  validateBoolean(action.outsideOpcore, "Opcore init action outsideOpcore");
  const insideOpcore = isOpcoreInitPath(action.targetScope, path);
  if (action.outsideOpcore === insideOpcore) {
    throw new Error("Opcore init action outsideOpcore must match action path");
  }
  if (action.outsideOpcore && !action.requiresApproval) {
    throw new Error("Opcore init action outside .opcore requires approval");
  }
  return action;
}

export { validateOpcoreInitAction };

function isOpcoreInitPath(scope: OpcoreInitAction["targetScope"], path: string): boolean {
  if (scope === "global") return path === "~/.opcore" || path.startsWith("~/.opcore/");
  return path === ".opcore" || path.startsWith(".opcore/");
}

function validateOpcoreMetricReport(report: OpcoreMetricReport): OpcoreMetricReport {
  assertNoOpaqueScoreFields(report, "Opcore metric report");
  validateRequiredObject(report, "Opcore metric report is required");
  if (report.schemaVersion !== 1) {
    throw new Error("Opcore metric report schemaVersion must be 1");
  }
  if (report.kind !== "opcore_metric_report") {
    throw new Error("Opcore metric report kind must be opcore_metric_report");
  }
  validateNonEmptyString(report.generatedAt, "Opcore metric report generatedAt");
  validateOpcoreMetricReportRepo(report);
  validateOpcoreMetricCoverage(report.coverage, "Opcore metric report coverage");
  validateOpcoreMetricReportGraph(report);
  validateOpcoreMetricReportValidation(report);
  validateOpcoreMetricReportFindings(report);
  validateStringArray(report.warnings, "Opcore metric report warnings", {
    allowEmpty: true,
  });
  validateStringArray(report.nextActions, "Opcore metric report nextActions", {
    allowEmpty: false,
  });
  return report;
}

export { validateOpcoreMetricReport };

function validateOpcoreMetricReportRepo(report: OpcoreMetricReport): void {
  validateRequiredObject(report.repo, "Opcore metric report repo is required");
  validateNonEmptyString(report.repo.root, "Opcore metric report repo root");
  validateNonEmptyString(report.repo.requestedPath, "Opcore metric report repo requestedPath");
  validateRequiredObject(report.repo.git, "Opcore metric report repo git is required");
  validateBoolean(report.repo.git.available, "Opcore metric report repo git available");
  validateOptional(report.repo.git.branch, (value) =>
    validateNonEmptyString(value, "Opcore metric report git branch"),
  );
  for (const [key, value] of Object.entries(report.repo.git)) {
    if (key === "available" || key === "branch" || key === "clean") continue;
    validateNonNegativeInteger(value, `Opcore metric report git ${key}`);
  }
  validateOptional(report.repo.git.clean, (value) => validateBoolean(value, "Opcore metric report git clean"));
}

function validateOpcoreMetricReportGraph(report: OpcoreMetricReport): void {
  validateRequiredObject(report.graph, "Opcore metric report graph is required");
  if (!includesString(graphProviderStatusStates, report.graph.state)) {
    throw new Error(`Unknown Opcore metric graph state: ${String(report.graph.state)}`);
  }
  if (!includesString(graphProviderModes, report.graph.mode)) {
    throw new Error(`Unknown Opcore metric graph mode: ${String(report.graph.mode)}`);
  }
  validateNonEmptyString(report.graph.provider, "Opcore metric report graph provider");
}

function validateOpcoreMetricReportValidation(report: OpcoreMetricReport): void {
  validateRequiredObject(report.validation, "Opcore metric report validation is required");
  if (report.validation.status !== undefined && !includesString(validationResultStatuses, report.validation.status)) {
    throw new Error(`Unknown Opcore metric validation status: ${String(report.validation.status)}`);
  }
  validateNonNegativeInteger(report.validation.diagnosticCount, "Opcore metric report diagnosticCount");
  validateNonNegativeInteger(report.validation.checkCount, "Opcore metric report checkCount");
  validateOptional(report.validation.policy, (value) =>
    validateOpcoreValidationPolicySummary(value, "Opcore metric report validation policy"),
  );
  validateOptional(report.validation.pythonProjectContexts, validatePythonProjectContexts);
}

function validateOpcoreMetricReportFindings(report: OpcoreMetricReport): void {
  if (!Array.isArray(report.signals)) {
    throw new Error("Opcore metric report signals must be an array");
  }
  for (const signal of report.signals) validateOpcoreMetricSignal(signal);
  if (!Array.isArray(report.degradations)) {
    throw new Error("Opcore metric report degradations must be an array");
  }
  for (const degradation of report.degradations) validateOpcoreMetricDegradation(degradation);
}
