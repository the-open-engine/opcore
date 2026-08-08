import { validateRequiredObject } from "../shared/validators-02.js";
import { validateCommandOwner, validateCommandRouteStatus } from "../command/helper-validators.js";
import {
  validateExitCodeForStatus,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateStringArray,
} from "../shared/validators-01.js";
import type { OpcoreMeasureDelta, OpcoreMetricHistoryEntry } from "./metrics-contracts-01.js";
import type {
  OpcoreTryCommandSummary,
  OpcoreTryPayload,
  OpcoreTryScenario,
  OpcoreTrySignalSummary,
} from "./metrics-contracts-02.js";
import { validateOpcoreMetricCoverage } from "./metrics-coverage-validators.js";
import { validateOpcoreMetricReport } from "./metrics-validators-02.js";
import {
  validateOpcoreMeasureComparison,
  validateOpcoreMeasureLatencyReport,
  validateOpcoreMeasureSignalCounts,
  validateOpcoreMetricDegradation,
} from "./metrics-validators-04.js";
import { assertNoOpaqueScoreFields } from "./metrics-validators-05.js";

function validateOpcoreMetricHistoryEntry(entry: OpcoreMetricHistoryEntry): OpcoreMetricHistoryEntry {
  assertNoOpaqueScoreFields(entry, "Opcore metric history entry");
  validateRequiredObject(entry, "Opcore metric history entry is required");
  if (entry.schemaVersion !== 1) {
    throw new Error("Opcore metric history entry schemaVersion must be 1");
  }
  if (entry.kind !== "opcore_metric_history_entry") {
    throw new Error("Opcore metric history entry kind must be opcore_metric_history_entry");
  }
  validateNonEmptyString(entry.recordedAt, "Opcore metric history entry recordedAt");
  validateOpcoreMetricReport(entry.report);
  return entry;
}

export { validateOpcoreMetricHistoryEntry };

function validateOpcoreMeasureDelta(delta: OpcoreMeasureDelta): OpcoreMeasureDelta {
  assertNoOpaqueScoreFields(delta, "Opcore measure delta");
  validateRequiredObject(delta, "Opcore measure delta is required");
  if (delta.schemaVersion !== 1) {
    throw new Error("Opcore measure delta schemaVersion must be 1");
  }
  if (delta.kind !== "opcore_measure_delta") {
    throw new Error("Opcore measure delta kind must be opcore_measure_delta");
  }
  validateNonEmptyString(delta.generatedAt, "Opcore measure delta generatedAt");
  validateRequiredObject(delta.current, "Opcore measure delta current is required");
  validateNonEmptyString(delta.current.generatedAt, "Opcore measure delta current generatedAt");
  validateOpcoreMetricCoverage(delta.current.coverage, "Opcore measure delta current coverage");
  validateOpcoreMeasureSignalCounts(delta.current.signals, "Opcore measure delta current signals");
  if (delta.latency !== undefined) validateOpcoreMeasureLatencyReport(delta.latency);
  if (delta.baseline !== undefined) validateOpcoreMeasureComparison(delta.baseline, "baseline");
  if (delta.previous !== undefined) validateOpcoreMeasureComparison(delta.previous, "previous");
  validateStringArray(delta.warnings, "Opcore measure delta warnings", {
    allowEmpty: true,
  });
  if (!Array.isArray(delta.degradations)) {
    throw new Error("Opcore measure delta degradations must be an array");
  }
  for (const degradation of delta.degradations) validateOpcoreMetricDegradation(degradation);
  validateStringArray(delta.nextActions, "Opcore measure delta nextActions", {
    allowEmpty: false,
  });
  return delta;
}

export { validateOpcoreMeasureDelta };

function validateOpcoreTryPayload(payload: OpcoreTryPayload): OpcoreTryPayload {
  assertNoOpaqueScoreFields(payload, "Opcore try payload");
  validateRequiredObject(payload, "Opcore try payload is required");
  if (payload.schemaVersion !== 1) {
    throw new Error("Opcore try payload schemaVersion must be 1");
  }
  validateNonEmptyString(payload.sampleRoot, "Opcore try sampleRoot");
  if (payload.published !== false) {
    throw new Error("Opcore try published must be false");
  }
  validateNonEmptyArray(payload.scenarios, "Opcore try scenarios");
  for (const scenario of payload.scenarios) validateOpcoreTryScenario(scenario);
  validateNonEmptyArray(payload.commands, "Opcore try commands");
  for (const command of payload.commands) validateOpcoreTryCommand(command);
  return payload;
}

export { validateOpcoreTryPayload };

function validateOpcoreTryScenario(scenario: OpcoreTryScenario): OpcoreTryScenario {
  validateRequiredObject(scenario, "Opcore try scenario is required");
  validateNonEmptyString(scenario.id, "Opcore try scenario id");
  validateNonEmptyString(scenario.repoRoot, "Opcore try scenario repoRoot");
  validateNonEmptyString(scenario.title, "Opcore try scenario title");
  validateStringArray(scenario.commands, "Opcore try scenario commands", {
    allowEmpty: false,
  });
  validateRequiredObject(scenario.coverage, "Opcore try scenario coverage is required");
  validateNonNegativeInteger(scenario.coverage.totalFiles, "Opcore try scenario totalFiles");
  validateNonNegativeInteger(
    scenario.coverage.validationSupportedFiles,
    "Opcore try scenario validationSupportedFiles",
  );
  validateNonNegativeInteger(scenario.coverage.unsupportedFiles, "Opcore try scenario unsupportedFiles");
  if (!Array.isArray(scenario.signals)) {
    throw new Error("Opcore try scenario signals must be an array");
  }
  for (const signal of scenario.signals) validateOpcoreTrySignal(signal);
  return scenario;
}

export { validateOpcoreTryScenario };

function validateOpcoreTrySignal(signal: OpcoreTrySignalSummary): OpcoreTrySignalSummary {
  validateRequiredObject(signal, "Opcore try signal is required");
  validateNonEmptyString(signal.id, "Opcore try signal id");
  validateNonEmptyString(signal.title, "Opcore try signal title");
  validateNonNegativeInteger(signal.count, "Opcore try signal count");
  if (!Number.isInteger(signal.delta)) {
    throw new Error("Opcore try signal delta must be an integer");
  }
  return signal;
}

export { validateOpcoreTrySignal };

function validateOpcoreTryCommand(command: OpcoreTryCommandSummary): OpcoreTryCommandSummary {
  validateRequiredObject(command, "Opcore try command is required");
  validateNonEmptyString(command.scenarioId, "Opcore try command scenarioId");
  validateStringArray(command.command, "Opcore try command", {
    allowEmpty: false,
  });
  validateStringArray(command.canonicalCommand, "Opcore try command canonicalCommand", { allowEmpty: false });
  validateCommandOwner(command.owner);
  validateCommandRouteStatus(command.status);
  validateExitCodeForStatus(command.exitCode, command.status);
  return command;
}

export { validateOpcoreTryCommand };
