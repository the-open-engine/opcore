import {
  validateBoolean,
  validateExactValue,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateProviderStatus } from "../graph/provider-validators.js";
import { graphProviderModes } from "../graph/vocabulary-01.js";
import { validateRepoIdentity } from "../shared/path-validators.js";
import {
  validateExactStringSet,
  validateNonEmptyString,
  validateNonNegativeNumber,
  validateStringArray,
  validateValidationChecks,
} from "../shared/validators-01.js";
import {
  validateValidationAdapterDegradedCheckStatus,
  validateValidationAdapterToolchainStatus,
} from "./prewrite-status-validators-02.js";
import { validateValidationScope } from "./request-validators-01.js";
import {
  validatePreWriteValidationFailureSummary,
  validatePreWriteValidationGraph,
  validatePreWriteValidationOverlaySummary,
  validateValidationCheckManifestEntry,
} from "./request-validators-02.js";
import type {
  PreWriteValidationReceipt,
  ValidationAdapterRuntimeStatus,
  ValidationStatusPayload} from "./status-contracts.js";
import {
  validationAdapterRuntimeStates,
  validationDaemonReadinessStates,
} from "./status-contracts.js";
import { validationResultStatuses } from "./vocabulary-01.js";

function validatePreWriteValidationReceipt(receipt: PreWriteValidationReceipt): PreWriteValidationReceipt {
  validateRequiredObject(receipt, "Pre-write validation receipt is required");
  validateExactValue(receipt.schemaVersion, 1, "Pre-write validation receipt schemaVersion must be 1");
  validateExactValue(
    receipt.kind,
    "pre_write_validation",
    "Pre-write validation receipt kind must be pre_write_validation",
  );
  validateExactValue(
    receipt.route,
    "validate.pre-write",
    "Pre-write validation receipt route must be validate.pre-write",
  );
  validateStringArray(receipt.canonicalCommand, "Pre-write validation receipt canonicalCommand", { allowEmpty: false });
  validateNonEmptyString(receipt.generatedAt, "Pre-write validation receipt generatedAt");
  validateNonNegativeNumber(receipt.durationMs, "Pre-write validation receipt durationMs");
  if (!Number.isInteger(receipt.timeoutMs) || receipt.timeoutMs < 1) {
    throw new Error("Pre-write validation receipt timeoutMs must be a positive integer");
  }
  validateBoolean(receipt.ok, "Pre-write validation receipt ok");
  validatePreWriteValidationReceiptOptionals(receipt);
  if (!includesString(validationResultStatuses, receipt.validationStatus)) {
    throw new Error(`Unknown pre-write validation receipt status: ${String(receipt.validationStatus)}`);
  }
  if (!Number.isInteger(receipt.diagnosticCount) || receipt.diagnosticCount < 0) {
    throw new Error("Pre-write validation receipt diagnosticCount must be a non-negative integer");
  }
  validatePreWriteValidationReceiptOutcome(receipt);
  return receipt;
}

export { validatePreWriteValidationReceipt };

function validatePreWriteValidationReceiptOptionals(receipt: PreWriteValidationReceipt): void {
  validateOptional(receipt.requestId, (value) =>
    validateNonEmptyString(value, "Pre-write validation receipt requestId"),
  );
  validateOptional(receipt.repo, validateRepoIdentity);
  validateOptional(receipt.scope, validateValidationScope);
  validateOptional(receipt.checks, (value) =>
    validateValidationChecks(value, "Pre-write validation receipt checks"),
  );
  validateOptional(receipt.graph, validatePreWriteValidationGraph);
  validateOptional(receipt.overlays, validatePreWriteValidationOverlaySummary);
  validateOptional(receipt.failureSummary, validatePreWriteValidationFailureSummary);
}

function validatePreWriteValidationReceiptOutcome(receipt: PreWriteValidationReceipt): void {
  if (!receipt.ok) {
    if (receipt.validationStatus === "passed") {
      throw new Error("Pre-write validation failure receipt must not use passed validationStatus");
    }
    if (receipt.failureSummary === undefined) {
      throw new Error("Pre-write validation failure receipt must include failureSummary");
    }
    return;
  }
  if (receipt.validationStatus !== "passed") {
    throw new Error("Pre-write validation pass receipt must use passed validationStatus");
  }
  const requiredEvidence = [receipt.repo, receipt.scope, receipt.checks, receipt.graph, receipt.overlays];
  if (requiredEvidence.some((value) => value === undefined)) {
    throw new Error("Pre-write validation pass receipt must include repo, scope, checks, graph, and overlays");
  }
  if (receipt.failureSummary !== undefined) {
    throw new Error("Pre-write validation pass receipt must not include failureSummary");
  }
}

function validateValidationStatusPayload(payload: ValidationStatusPayload): ValidationStatusPayload {
  validateRequiredObject(payload, "Validation status payload is required");
  validateExactValue(payload.schemaVersion, 1, "Validation status payload schemaVersion must be 1");
  validateBoolean(payload.ready, "Validation status payload ready");
  validateNonEmptyString(payload.generatedAt, "Validation status payload generatedAt");
  validateValidationStatusAdapterRegistry(payload);
  validateValidationStatusGraph(payload);
  validateOptional(payload.daemon, validateValidationDaemonStatus);
  return payload;
}

export { validateValidationStatusPayload };

function validateValidationStatusAdapterRegistry(payload: ValidationStatusPayload): void {
  validateRequiredObject(payload.adapterRegistry, "Validation status payload adapterRegistry is required");
  validateExactStringSet(
    payload.adapterRegistry.checkRoutes,
    ["files", "staged", "changed", "tree", "all", "manifest"],
    "Validation status payload checkRoutes",
  );
  validateExactStringSet(
    payload.adapterRegistry.validateRoutes,
    ["request", "hypothetical", "pre-write", "manifest"],
    "Validation status payload validateRoutes",
  );
  validateValidationChecks(payload.adapterRegistry.checkIds, "Validation status payload checkIds");
  if (!Array.isArray(payload.adapterRegistry.entries)) {
    throw new Error("Validation status payload entries must be an array");
  }
  for (const entry of payload.adapterRegistry.entries) validateValidationCheckManifestEntry(entry);
  validateOptional(payload.adapterRegistry.adapters, (adapters) => {
    if (!Array.isArray(payload.adapterRegistry.adapters)) {
      throw new Error("Validation status payload adapters must be an array");
    }
    for (const adapter of adapters) validateValidationAdapterRuntimeStatus(adapter);
  });
}

function validateValidationStatusGraph(payload: ValidationStatusPayload): void {
  validateRequiredObject(payload.graph, "Validation status payload graph is required");
  if (!includesString(graphProviderModes, payload.graph.mode)) {
    throw new Error(`Unknown validation status graph mode: ${String(payload.graph.mode)}`);
  }
  const graphStatus = validateProviderStatus(payload.graph.status);
  if (graphStatus.mode !== payload.graph.mode) {
    throw new Error("Validation status graph status mode must match graph mode");
  }
}

function validateValidationDaemonStatus(daemon: NonNullable<ValidationStatusPayload["daemon"]>): void {
  validateRequiredObject(daemon, "Validation status daemon must be an object");
  if (!includesString(validationDaemonReadinessStates, daemon.state)) {
    throw new Error(`Unknown validation daemon readiness state: ${String(daemon.state)}`);
  }
  validateOptional(daemon.message, (value) => validateNonEmptyString(value, "Validation status daemon message"));
}

function validateValidationAdapterRuntimeStatus(
  status: ValidationAdapterRuntimeStatus,
): ValidationAdapterRuntimeStatus {
  validateRequiredObject(status, "Validation adapter runtime status is required");
  validateNonEmptyString(status.adapter, "Validation adapter runtime status adapter");
  if (!includesString(validationAdapterRuntimeStates, status.status)) {
    throw new Error(`Unknown validation adapter runtime status: ${String(status.status)}`);
  }
  validateValidationChecks(status.checkIds, "Validation adapter runtime status checkIds");
  if (status.toolchain !== undefined) {
    if (!Array.isArray(status.toolchain)) {
      throw new Error("Validation adapter runtime status toolchain must be an array");
    }
    for (const tool of status.toolchain) validateValidationAdapterToolchainStatus(tool);
  }
  if (status.degradedChecks !== undefined) {
    if (!Array.isArray(status.degradedChecks)) {
      throw new Error("Validation adapter runtime status degradedChecks must be an array");
    }
    for (const degradedCheck of status.degradedChecks) validateValidationAdapterDegradedCheckStatus(degradedCheck);
  }
  if (status.tempWorkspaceRequired !== undefined && typeof status.tempWorkspaceRequired !== "boolean") {
    throw new Error("Validation adapter runtime status tempWorkspaceRequired must be boolean");
  }
  return status;
}

export { validateValidationAdapterRuntimeStatus };
