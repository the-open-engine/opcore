import {
  validateBoolean,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { validateEditRefusal } from "../edit/refusal-validator.js";
import { validateProviderStatus } from "../graph/provider-validators.js";
import { validateRepoIdentity } from "../shared/path-validators.js";
import { includesString } from "../shared/primitives.js";
import { validateNonEmptyString, validateValidationChecks } from "../shared/validators-01.js";
import type { ValidationResult } from "./capability-contracts.js";
import { validatePythonProjectContexts } from "./python-project-validators-01.js";
import { validateValidationFailure } from "./python-ruff-validators-03.js";
import { validatePythonValidationCapabilityRuns } from "./python-types-validators.js";
import type { ValidationRequest } from "./request-contracts.js";
import {
  validateHypotheticalOverlays,
  validateValidationDiagnostics,
  validateValidationGraphConfig,
  validateValidationScope,
} from "./request-validators-01.js";
import { validateValidationResultManifest } from "./request-validators-02.js";
import { validationFailureCategories, validationReportModes, validationResultStatuses } from "./vocabulary-01.js";

function validateValidationRequestPayload(request: ValidationRequest): ValidationRequest {
  validateRequiredObject(request, "Validation request is required");
  if (request.requestId !== undefined) validateNonEmptyString(request.requestId, "Validation request requestId");
  validateRepoIdentity(request.repo);
  validateValidationScope(request.scope);
  validateValidationGraphConfig(request.graph);
  validateHypotheticalOverlays(request.overlays);
  if (request.checks !== undefined) validateValidationChecks(request.checks, "Validation request checks");
  if (request.reportMode !== undefined && !includesString(validationReportModes, request.reportMode)) {
    throw new Error(`Unknown validation request reportMode: ${String(request.reportMode)}`);
  }
  return request;
}

export { validateValidationRequestPayload };

function validateValidationResultPayload(result: ValidationResult): ValidationResult {
  validateRequiredObject(result, "Validation result is required");
  validateBoolean(result.ok, "Validation result ok");
  if (!includesString(validationResultStatuses, result.status)) {
    throw new Error(`Unknown validation result status: ${String(result.status)}`);
  }
  if (result.status === "passed" && !result.ok) {
    throw new Error("Validation passed result must use ok=true");
  }
  if (result.ok && result.status !== "passed") {
    throw new Error("Validation result ok=true must use passed status");
  }
  validateValidationDiagnostics(result.diagnostics);
  validateOptional(result.graphStatus, validateProviderStatus);
  validateOptional(result.failure, validateValidationFailure);
  validateOptional(result.refusal, validateEditRefusal);
  validateValidationResultRefusal(result);
  validateValidationResultFailure(result);
  validateValidationResultSuccess(result);
  validateOptional(result.manifest, validateValidationResultManifest);
  validateOptional(result.pythonProjectContexts, validatePythonProjectContexts);
  validateOptional(result.pythonCapabilityRuns, validatePythonValidationCapabilityRuns);
  return result;
}

export { validateValidationResultPayload };

function validateValidationResultRefusal(result: ValidationResult): void {
  if (result.status === "refused" && result.refusal === undefined) {
    throw new Error("Validation refused result must include refusal");
  }
  if (result.status === "refused" && result.failure !== undefined) {
    throw new Error("Validation refused result must not include failure");
  }
}

function validateValidationResultFailure(result: ValidationResult): void {
  if (includesString(validationFailureCategories, result.status) && result.failure === undefined) {
    throw new Error(`Validation ${result.status} result must include failure`);
  }
  if (includesString(validationFailureCategories, result.status)) {
    if (result.failure?.category !== result.status) {
      throw new Error("Validation failure category must match result status");
    }
    if (result.refusal !== undefined) {
      throw new Error("Validation failure result must not include refusal");
    }
  }
}

function validateValidationResultSuccess(result: ValidationResult): void {
  if (result.status === "passed" && (result.failure !== undefined || result.refusal !== undefined)) {
    throw new Error("Validation passed result must not include failure or refusal");
  }
}
