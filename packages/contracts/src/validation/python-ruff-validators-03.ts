import { validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateNonEmptyString, validateValidationCheckId } from "../shared/validators-01.js";
import type {
  PythonRuffValidationCapabilityRun,
  PythonValidationCapabilityInvocation,
  ValidationSkippedCheck,
} from "./diagnostic-contracts.js";
import { containsHostAbsolutePath } from "./python-validator-primitives.js";
import type { ValidationFailure } from "./request-contracts.js";
import { validationFailureCategories } from "./vocabulary-01.js";
import { validationSkippedCheckReasons } from "./vocabulary-02.js";

function validateRuffTerminationEvidence(
  evidence: Pick<
    PythonRuffValidationCapabilityRun | PythonValidationCapabilityInvocation,
    "termination" | "exitCode" | "signal"
  >,
  label: string,
): void {
  if (evidence.termination === "exited") {
    if (evidence.exitCode === undefined || evidence.signal !== undefined) {
      throw new Error(`${label} exited termination requires exitCode without signal`);
    }
    return;
  }
  if (evidence.termination === "signal") {
    if (evidence.signal === undefined || evidence.exitCode !== undefined) {
      throw new Error(`${label} signal termination requires signal without exitCode`);
    }
    return;
  }
  if (evidence.exitCode !== undefined || evidence.signal !== undefined) {
    throw new Error(`${label} ${String(evidence.termination)} termination must not record exitCode or signal`);
  }
}

export { validateRuffTerminationEvidence };

function validatePortablePythonCapabilityArgv(argv: readonly string[]): void {
  for (const argument of argv) {
    if (containsHostAbsolutePath(argument)) {
      throw new Error("Python validation capability run requires portable argv without host-absolute paths");
    }
  }
}

export { validatePortablePythonCapabilityArgv };

function validateValidationSkippedCheck(skippedCheck: ValidationSkippedCheck): ValidationSkippedCheck {
  validateRequiredObject(skippedCheck, "Validation skipped check is required");
  validateValidationCheckId(skippedCheck.checkId, "Validation skipped check checkId");
  if (!includesString(validationSkippedCheckReasons, skippedCheck.reason)) {
    throw new Error(`Unknown validation skipped reason: ${String(skippedCheck.reason)}`);
  }
  validateNonEmptyString(skippedCheck.message, "Validation skipped check message");
  return skippedCheck;
}

export { validateValidationSkippedCheck };

function validateValidationFailure(failure: ValidationFailure): ValidationFailure {
  validateRequiredObject(failure, "Validation failure is required");
  if (!includesString(validationFailureCategories, failure.category)) {
    throw new Error(`Unknown validation failure category: ${String(failure.category)}`);
  }
  validateNonEmptyString(failure.message, "Validation failure message");
  if (failure.retryable !== undefined && typeof failure.retryable !== "boolean") {
    throw new Error("Validation failure retryable must be boolean");
  }
  if (failure.cause !== undefined) validateNonEmptyString(failure.cause, "Validation failure cause");
  return failure;
}

export { validateValidationFailure };
