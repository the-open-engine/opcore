import { validateRequiredObject } from "../shared/validators-02.js";
import { validateCommandOwner, validateCommandRouteStatus } from "../command/helper-validators.js";
import { commandTimingDegradationReasons, commandTimingProcessStates } from "../command/vocabulary.js";
import { includesString } from "../shared/primitives.js";
import {
  validateExitCodeForStatus,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateStringArray,
} from "../shared/validators-01.js";
import type { CommandLatencyRecord, CommandTiming, LatencyBudget, RepoShapeFingerprint } from "./latency-contracts.js";
import {
  assertNoOpaqueScoreFields,
  assertNoTelemetrySourceFields,
  validateCommandTimingPhase,
  validateLatencyCanonicalCommand,
  validateLatencyPhaseBudget,
  validateLatencyStableId,
  validateLatencyTelemetryCommandBin,
} from "./metrics-validators-05.js";

function validateCommandTiming(timing: CommandTiming): CommandTiming {
  assertNoOpaqueScoreFields(timing, "Command timing");
  assertNoTelemetrySourceFields(timing, "Command timing");
  validateRequiredObject(timing, "Command timing is required");
  validateNonNegativeNumber(timing.durationMs, "Command timing durationMs");
  if (!Array.isArray(timing.phases)) {
    throw new Error("Command timing phases must be an array");
  }
  for (const phase of timing.phases) validateCommandTimingPhase(phase);
  if (!includesString(commandTimingProcessStates, timing.processState)) {
    throw new Error(`Unknown command timing processState: ${String(timing.processState)}`);
  }
  if (timing.degradations !== undefined) {
    validateStringArray(timing.degradations, "Command timing degradations", {
      allowEmpty: true,
    });
    for (const degradation of timing.degradations) {
      if (!includesString(commandTimingDegradationReasons, degradation)) {
        throw new Error(`Unknown command timing degradation: ${String(degradation)}`);
      }
    }
  }
  return timing;
}

export { validateCommandTiming };

function validateRepoShapeFingerprint(fingerprint: RepoShapeFingerprint): RepoShapeFingerprint {
  assertNoOpaqueScoreFields(fingerprint, "Repo shape fingerprint");
  assertNoTelemetrySourceFields(fingerprint, "Repo shape fingerprint");
  validateRequiredObject(fingerprint, "Repo shape fingerprint is required");
  validateNonNegativeInteger(fingerprint.totalFiles, "Repo shape fingerprint totalFiles");
  if (!Array.isArray(fingerprint.languages)) {
    throw new Error("Repo shape fingerprint languages must be an array");
  }
  for (const language of fingerprint.languages) {
    validateNonEmptyString(language.language, "Repo shape fingerprint language");
    validateNonNegativeInteger(language.files, "Repo shape fingerprint language files");
  }
  validateRequiredObject(fingerprint.graph, "Repo shape fingerprint graph is required");
  validateNonNegativeInteger(fingerprint.graph.supportedFiles, "Repo shape fingerprint graph supportedFiles");
  validateNonNegativeInteger(fingerprint.graph.unsupportedFiles, "Repo shape fingerprint graph unsupportedFiles");
  validateRequiredObject(fingerprint.git, "Repo shape fingerprint git is required");
  if (typeof fingerprint.git.available !== "boolean") {
    throw new Error("Repo shape fingerprint git available must be boolean");
  }
  if (fingerprint.git.clean !== undefined && typeof fingerprint.git.clean !== "boolean") {
    throw new Error("Repo shape fingerprint git clean must be boolean");
  }
  return fingerprint;
}

export { validateRepoShapeFingerprint };

function validateCommandLatencyRecord(record: CommandLatencyRecord): CommandLatencyRecord {
  assertNoOpaqueScoreFields(record, "Command latency record");
  assertNoTelemetrySourceFields(record, "Command latency record");
  validateRequiredObject(record, "Command latency record is required");
  if (record.schemaVersion !== 1) {
    throw new Error("Command latency record schemaVersion must be 1");
  }
  validateNonEmptyString(record.recordedAt, "Command latency record recordedAt");
  validateLatencyTelemetryCommandBin(record.bin, "Command latency record bin");
  validateLatencyCanonicalCommand(record.canonicalCommand, "Command latency record canonicalCommand");
  validateCommandOwner(record.owner);
  const status = validateCommandRouteStatus(record.status);
  validateExitCodeForStatus(record.exitCode, status);
  validateRepoShapeFingerprint(record.repo);
  validateCommandTiming(record.timing);
  validateNonEmptyString(record.opcoreVersion, "Command latency record opcoreVersion");
  return record;
}

export { validateCommandLatencyRecord };

function validateLatencyBudget(budget: LatencyBudget): LatencyBudget {
  assertNoOpaqueScoreFields(budget, "Latency budget");
  assertNoTelemetrySourceFields(budget, "Latency budget");
  validateRequiredObject(budget, "Latency budget is required");
  if (budget.schemaVersion !== 1) {
    throw new Error("Latency budget schemaVersion must be 1");
  }
  validateLatencyCanonicalCommand(budget.canonicalCommand, "Latency budget canonicalCommand");
  validateLatencyStableId(budget.scope, "Latency budget scope");
  validateLatencyStableId(budget.repoShapeBucket, "Latency budget repoShapeBucket");
  validateNonNegativeNumber(budget.budgetMs, "Latency budget budgetMs");
  if (budget.phaseBudgets !== undefined) {
    if (!Array.isArray(budget.phaseBudgets)) {
      throw new Error("Latency budget phaseBudgets must be an array");
    }
    const phases = new Set<string>();
    for (const phaseBudget of budget.phaseBudgets) {
      const validatedPhaseBudget = validateLatencyPhaseBudget(phaseBudget);
      if (phases.has(validatedPhaseBudget.phase)) {
        throw new Error("Latency budget phaseBudgets must not include duplicate phases");
      }
      phases.add(validatedPhaseBudget.phase);
    }
  }
  return budget;
}

export { validateLatencyBudget };
