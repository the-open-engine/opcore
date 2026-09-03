import { validateOptional, validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateProviderStatus } from "../graph/provider-validators.js";
import { GRAPH_SCHEMA_VERSION, graphProviderModes } from "../graph/vocabulary-01.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateStringArray,
  validateValidationCheckId,
  validateValidationChecks,
} from "../shared/validators-01.js";
import type {
  ValidationCheckManifestEntry,
  ValidationCheckRunSummary,
  ValidationResultManifest,
} from "./diagnostic-contracts.js";
import { validateValidationSkippedCheck } from "./python-ruff-validators-03.js";
import { validatePythonValidationCapabilityRun } from "./python-types-validators.js";
import { validationScopeKinds } from "./request-contracts.js";
import type {
  PreWriteValidationFailureSummary,
  PreWriteValidationOverlaySummary,
  PreWriteValidationReceipt,
} from "./status-contracts.js";
import type {
  ValidationCheckOutcome,
  ValidationCheckRunStatus} from "./vocabulary-01.js";
import {
  validationCheckOutcomes,
  validationCheckRunStatuses,
  validationResultStatuses,
} from "./vocabulary-01.js";

function validateValidationResultManifest(manifest: ValidationResultManifest): ValidationResultManifest {
  validateRequiredObject(manifest, "Validation result manifest is required");
  if (manifest.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(`Validation result manifest schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  }
  validateValidationChecks(manifest.checks, "Validation result manifest checks");
  validateNonEmptyString(manifest.generatedAt, "Validation result manifest generatedAt");
  validateOptional(manifest.durationMs, (value) =>
    validateNonNegativeNumber(value, "Validation result manifest durationMs"),
  );
  validateOptional(manifest.entries, validateValidationManifestEntries);
  validateOptional(manifest.runs, validateValidationManifestRuns);
  validateOptional(manifest.skippedChecks, validateValidationManifestSkippedChecks);
  return manifest;
}

export { validateValidationResultManifest };

function validateValidationManifestEntries(entries: readonly ValidationCheckManifestEntry[]): void {
  if (!Array.isArray(entries)) throw new Error("Validation result manifest entries must be an array");
  for (const entry of entries) validateValidationCheckManifestEntry(entry);
}

function validateValidationManifestRuns(runs: readonly ValidationCheckRunSummary[]): void {
  if (!Array.isArray(runs)) throw new Error("Validation result manifest runs must be an array");
  for (const run of runs) validateValidationCheckRunSummary(run);
}

function validateValidationManifestSkippedChecks(
  skippedChecks: NonNullable<ValidationResultManifest["skippedChecks"]>,
): void {
  if (!Array.isArray(skippedChecks)) throw new Error("Validation result manifest skippedChecks must be an array");
  for (const skippedCheck of skippedChecks) validateValidationSkippedCheck(skippedCheck);
}

function validatePreWriteValidationGraph(graph: PreWriteValidationReceipt["graph"]): void {
  validateRequiredObject(graph, "Pre-write validation receipt graph is required");
  if (!includesString(graphProviderModes, graph.mode)) {
    throw new Error(`Unknown pre-write validation receipt graph mode: ${String(graph.mode)}`);
  }
  if (graph.provider !== undefined)
    validateNonEmptyString(graph.provider, "Pre-write validation receipt graph provider");
  if (graph.status !== undefined) {
    validateProviderStatus(graph.status);
    if (graph.status.mode !== graph.mode) {
      throw new Error("Pre-write validation receipt graph status mode must match graph mode");
    }
    if (graph.provider !== undefined && graph.status.provider !== graph.provider) {
      throw new Error("Pre-write validation receipt graph status provider must match graph provider");
    }
  }
}

export { validatePreWriteValidationGraph };

function validatePreWriteValidationOverlaySummary(summary: PreWriteValidationOverlaySummary): void {
  validateRequiredObject(summary, "Pre-write validation receipt overlays are required");
  for (const key of ["count", "writeCount", "deleteCount"] as const) {
    if (!Number.isInteger(summary[key]) || summary[key] < 0) {
      throw new Error(`Pre-write validation receipt overlays ${key} must be a non-negative integer`);
    }
  }
  validateStringArray(summary.paths, "Pre-write validation receipt overlay paths", { allowEmpty: true });
  for (const path of summary.paths) validateRepoRelativePath(path);
  if (summary.count !== summary.writeCount + summary.deleteCount) {
    throw new Error("Pre-write validation receipt overlay count must equal writeCount plus deleteCount");
  }
  if (summary.count !== summary.paths.length) {
    throw new Error("Pre-write validation receipt overlay count must equal paths length");
  }
}

export { validatePreWriteValidationOverlaySummary };

function validatePreWriteValidationFailureSummary(summary: PreWriteValidationFailureSummary): void {
  validateRequiredObject(summary, "Pre-write validation receipt failureSummary is required");
  if (!includesString(validationResultStatuses, summary.category)) {
    throw new Error(`Unknown pre-write validation receipt failure category: ${String(summary.category)}`);
  }
  if (summary.category === "passed") {
    throw new Error("Pre-write validation receipt failure category must not be passed");
  }
  validateNonEmptyString(summary.message, "Pre-write validation receipt failureSummary message");
  if (summary.cause !== undefined)
    validateNonEmptyString(summary.cause, "Pre-write validation receipt failureSummary cause");
  if (summary.retryable !== undefined && typeof summary.retryable !== "boolean") {
    throw new Error("Pre-write validation receipt failureSummary retryable must be boolean");
  }
}

export { validatePreWriteValidationFailureSummary };

function validateValidationCheckManifestEntry(entry: ValidationCheckManifestEntry): ValidationCheckManifestEntry {
  validateRequiredObject(entry, "Validation check manifest entry is required");
  validateValidationCheckId(entry.checkId, "Validation check manifest entry checkId");
  validateNonEmptyString(entry.owner, "Validation check manifest entry owner");
  validateNonEmptyString(entry.adapter, "Validation check manifest entry adapter");
  if (!includesString(["info", "warning", "error"] as const, entry.defaultSeverity)) {
    throw new Error(`Unknown validation check manifest entry defaultSeverity: ${String(entry.defaultSeverity)}`);
  }
  if (!Array.isArray(entry.supportedScopes) || entry.supportedScopes.length === 0) {
    throw new Error("Validation check manifest entry supportedScopes must be a non-empty array");
  }
  for (const scopeKind of entry.supportedScopes) {
    if (!includesString(validationScopeKinds, scopeKind)) {
      throw new Error(`Unknown validation check manifest entry supported scope: ${String(scopeKind)}`);
    }
  }
  if (typeof entry.requiresGraph !== "boolean") {
    throw new Error("Validation check manifest entry requiresGraph must be boolean");
  }
  return entry;
}

export { validateValidationCheckManifestEntry };

function validateValidationCheckRunSummary(run: ValidationCheckRunSummary): ValidationCheckRunSummary {
  validateRequiredObject(run, "Validation check run summary is required");
  validateValidationCheckId(run.checkId, "Validation check run summary checkId");
  if (!includesString(validationCheckRunStatuses, run.status)) {
    throw new Error(`Unknown validation check run status: ${String(run.status)}`);
  }
  if (run.outcome !== undefined && !includesString(validationCheckOutcomes, run.outcome)) {
    throw new Error(`Unknown validation check outcome: ${String(run.outcome)}`);
  }
  validateValidationCheckOutcomeStatus(run);
  validateOptional(run.durationMs, (value) =>
    validateNonNegativeNumber(value, "Validation check run summary durationMs"),
  );
  validateOptional(run.diagnosticCount, (value) =>
    validateNonNegativeInteger(value, "Validation check run summary diagnosticCount"),
  );
  validateOptional(run.failureMessage, (value) =>
    validateNonEmptyString(value, "Validation check run summary failureMessage"),
  );
  if (
    includesString(["infrastructure_failure", "provider_failure", "unsupported_request"] as const, run.status) &&
    run.failureMessage === undefined
  ) {
    throw new Error("Validation check run summary failureMessage is required for failure statuses");
  }
  validateOptional(run.pythonCapabilityRuns, (runs) => {
    if (!Array.isArray(runs)) {
      throw new Error("Validation check run summary pythonCapabilityRuns must be an array");
    }
    for (const capabilityRun of runs) validatePythonValidationCapabilityRun(capabilityRun);
  });
  return run;
}

export { validateValidationCheckRunSummary };

function validateValidationCheckOutcomeStatus(run: ValidationCheckRunSummary): void {
  if (run.outcome === undefined) return;
  const expectedStatus: Record<ValidationCheckOutcome, ValidationCheckRunStatus> = {
    passed: "passed",
    findings: "policy_failure",
    tool_unavailable: "unsupported_request",
    invalid_config: "unsupported_request",
    timeout: "infrastructure_failure",
    unsupported_target: "unsupported_request",
    tool_failure: "infrastructure_failure",
  };
  if (run.status !== expectedStatus[run.outcome]) {
    throw new Error(`Validation check outcome ${run.outcome} requires status ${expectedStatus[run.outcome]}`);
  }
}

export { validateValidationCheckOutcomeStatus };
