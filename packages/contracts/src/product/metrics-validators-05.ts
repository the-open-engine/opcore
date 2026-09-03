import { validateRequiredObject } from "../shared/validators-02.js";
import type { CommandLatencyTelemetryBin} from "../command/vocabulary.js";
import { commandLatencyTelemetryBins } from "../command/vocabulary.js";
import { includesString } from "../shared/primitives.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateStringArray,
} from "../shared/validators-01.js";
import { latencyStableIdRegex, latencyTelemetryCommandTokenRegex } from "../validation/vocabulary-02.js";
import { latencyTelemetrySourceFileExtensionRegex } from "../validation/vocabulary-03.js";
import type { CommandTimingPhase, LatencyBudget, LatencyPhaseBudget } from "./latency-contracts.js";
import type { OpcoreRepoStatePayload } from "./status-contracts.js";

function assertNoOpaqueScoreFields(value: unknown, label: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoOpaqueScoreFields(entry, label);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "score" || key === "blendedScore") {
      throw new Error(`${label} must not include opaque score fields`);
    }
    assertNoOpaqueScoreFields(entry, label);
  }
}

export { assertNoOpaqueScoreFields };

function assertNoTelemetrySourceFields(value: unknown, label: string): void {
  const blockedKeys = new Set([
    "root",
    "requestedPath",
    "path",
    "paths",
    "examples",
    "content",
    "contents",
    "source",
    "secret",
    "secrets",
    "token",
    "tokens",
    "apiKey",
    "password",
  ]);
  visitTelemetryValue(value);

  function visitTelemetryValue(entry: unknown): void {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const item of entry) visitTelemetryValue(item);
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (blockedKeys.has(key)) {
        throw new Error(`${label} must remain source-safe and must not include ${key}`);
      }
      visitTelemetryValue(child);
    }
  }
}

export { assertNoTelemetrySourceFields };

function validateCommandTimingPhase(phase: CommandTimingPhase): CommandTimingPhase {
  validateRequiredObject(phase, "Command timing phase is required");
  validateLatencyStableId(phase.phase, "Command timing phase");
  validateNonNegativeNumber(phase.durationMs, "Command timing phase durationMs");
  if (phase.fileCount !== undefined) validateNonNegativeInteger(phase.fileCount, "Command timing phase fileCount");
  return phase;
}

export { validateCommandTimingPhase };

function validateLatencyPhaseBudget(phaseBudget: LatencyPhaseBudget): LatencyPhaseBudget {
  validateRequiredObject(phaseBudget, "Latency phase budget is required");
  validateLatencyStableId(phaseBudget.phase, "Latency phase budget phase");
  validateNonNegativeNumber(phaseBudget.budgetMs, "Latency phase budget budgetMs");
  return phaseBudget;
}

export { validateLatencyPhaseBudget };

function resolveLatencyAppliedBudgetMs(budget: LatencyBudget, phase: string): number {
  if (phase === "total") return budget.budgetMs;
  const phaseBudget = budget.phaseBudgets?.find((entry) => entry.phase === phase);
  if (!phaseBudget) {
    throw new Error("Latency budget result phase must match total or a configured phase budget");
  }
  return phaseBudget.budgetMs;
}

export { resolveLatencyAppliedBudgetMs };

function validateLatencyStableId(value: unknown, label: string): string {
  const stableId = validateNonEmptyString(value, label);
  if (!latencyStableIdRegex.test(stableId)) {
    throw new Error(`${label} must be a stable latency id`);
  }
  return stableId;
}

export { validateLatencyStableId };

function validateLatencyTelemetryCommandBin(value: unknown, label: string): CommandLatencyTelemetryBin {
  const bin = validateNonEmptyString(value, label);
  if (!includesString(commandLatencyTelemetryBins, bin)) {
    throw new Error(`${label} must be a source-safe command bin`);
  }
  return bin;
}

export { validateLatencyTelemetryCommandBin };

function validateLatencyCanonicalCommand(command: readonly string[], label: string): readonly string[] {
  const parts = validateStringArray(command, label, { allowEmpty: false });
  for (const [index, part] of parts.entries()) {
    validateLatencyCanonicalCommandToken(part, `${label} entry ${index}`);
  }
  return parts;
}

export { validateLatencyCanonicalCommand };

function validateLatencyCanonicalCommandToken(value: string, label: string): string {
  if (!latencyTelemetryCommandTokenRegex.test(value)) {
    throw new Error(`${label} must be a source-safe canonicalCommand token`);
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    value.startsWith("~") ||
    /^[A-Za-z]:/.test(value) ||
    /^file:/i.test(value) ||
    latencyTelemetrySourceFileExtensionRegex.test(value)
  ) {
    throw new Error(`${label} must be a source-safe canonicalCommand token`);
  }
  return value;
}

export { validateLatencyCanonicalCommandToken };

function validateOpcoreCoverageCounts(
  section: OpcoreRepoStatePayload["coverage"]["graph"] | OpcoreRepoStatePayload["coverage"]["validation"],
  label: string,
): void {
  validateRequiredObject(section, `Opcore repo state ${label} coverage is required`);
  validateNonNegativeInteger(section.supportedFiles, `Opcore repo state ${label} supportedFiles`);
  if (!Array.isArray(section.extensions)) {
    throw new Error(`Opcore repo state ${label} extensions must be an array`);
  }
  for (const entry of section.extensions) {
    validateNonEmptyString(entry.extension, `Opcore repo state ${label} extension`);
    validateNonNegativeInteger(entry.count, `Opcore repo state ${label} count`);
  }
}

export { validateOpcoreCoverageCounts };
