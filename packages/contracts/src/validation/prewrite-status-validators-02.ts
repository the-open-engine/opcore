import { validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateNonEmptyString, validateValidationCheckId } from "../shared/validators-01.js";
import type { ValidationAdapterDegradedCheckStatus, ValidationAdapterToolchainStatus } from "./status-contracts.js";
import { validationCheckRunStatuses } from "./vocabulary-01.js";

function validateValidationAdapterToolchainStatus(
  status: ValidationAdapterToolchainStatus,
): ValidationAdapterToolchainStatus {
  validateRequiredObject(status, "Validation adapter toolchain status is required");
  validateNonEmptyString(status.tool, "Validation adapter toolchain status tool");
  if (typeof status.available !== "boolean") {
    throw new Error("Validation adapter toolchain status available must be boolean");
  }
  if (status.command !== undefined)
    validateNonEmptyString(status.command, "Validation adapter toolchain status command");
  if (status.version !== undefined)
    validateNonEmptyString(status.version, "Validation adapter toolchain status version");
  if (status.failureMessage !== undefined) {
    validateNonEmptyString(status.failureMessage, "Validation adapter toolchain status failureMessage");
  }
  if (status.cwd !== undefined) validateNonEmptyString(status.cwd, "Validation adapter toolchain status cwd");
  if (status.configFile !== undefined) {
    validateNonEmptyString(status.configFile, "Validation adapter toolchain status configFile");
  }
  if (status.source !== undefined) validateNonEmptyString(status.source, "Validation adapter toolchain status source");
  return status;
}

export { validateValidationAdapterToolchainStatus };

function validateValidationAdapterDegradedCheckStatus(
  status: ValidationAdapterDegradedCheckStatus,
): ValidationAdapterDegradedCheckStatus {
  validateRequiredObject(status, "Validation adapter degraded check status is required");
  validateValidationCheckId(status.checkId, "Validation adapter degraded check status checkId");
  if (!includesString(validationCheckRunStatuses, status.status)) {
    throw new Error(`Unknown validation adapter degraded check status: ${String(status.status)}`);
  }
  validateNonEmptyString(status.reason, "Validation adapter degraded check status reason");
  validateNonEmptyString(status.message, "Validation adapter degraded check status message");
  if (status.requiredTool !== undefined) {
    validateNonEmptyString(status.requiredTool, "Validation adapter degraded check status requiredTool");
  }
  if (status.retainedCompatibility !== undefined && typeof status.retainedCompatibility !== "boolean") {
    throw new Error("Validation adapter degraded check status retainedCompatibility must be boolean");
  }
  if (status.followUpIssue !== undefined) {
    validateNonEmptyString(status.followUpIssue, "Validation adapter degraded check status followUpIssue");
  }
  if (status.currentUsage !== undefined) {
    validateValidationAdapterCurrentUsage(status.currentUsage);
  }
  return status;
}

export { validateValidationAdapterDegradedCheckStatus };

function validateValidationAdapterCurrentUsage(
  currentUsage: ValidationAdapterDegradedCheckStatus["currentUsage"],
): NonNullable<ValidationAdapterDegradedCheckStatus["currentUsage"]> {
  validateRequiredObject(
    currentUsage,
    "Validation adapter degraded check status currentUsage is required when present",
  );
  for (const key of ["opcore", "orchestra", "covibes", "gateway"] as const) {
    if (typeof currentUsage[key] !== "boolean") {
      throw new Error(`Validation adapter degraded check status currentUsage.${key} must be boolean`);
    }
  }
  return currentUsage;
}

export { validateValidationAdapterCurrentUsage };
