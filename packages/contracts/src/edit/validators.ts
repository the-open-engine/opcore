import {
  validateBoolean,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import {
  validateRepoIdentity,
  validateRepoRelativePath,
  validateRepoRelativePaths,
} from "../shared/path-validators.js";
import { validateNonEmptyString, validateNonNegativeInteger } from "../shared/validators-01.js";
import { validateValidationRequestPayload, validateValidationResultPayload } from "../validation/result-validator.js";
import type { EditCommandResult, EditPlan, EditPlanRollbackState, RepoRelativeChange } from "./contracts.js";
import { validateEditRefusal } from "./refusal-validator.js";

function validateEditPlanPayload(plan: EditPlan): EditPlan {
  validateRequiredObject(plan, "Edit plan is required");
  validateNonEmptyString(plan.planId, "Edit plan planId");
  validateRepoIdentity(plan.repo);
  if (!Array.isArray(plan.changes)) {
    throw new Error("Edit plan changes must be an array");
  }
  for (const change of plan.changes) validateRepoRelativeChange(change);
  validateRequiredObject(plan.atomic, "Edit plan atomic metadata is required");
  if (plan.atomic.strategy !== "all_or_nothing") {
    throw new Error("Edit plan atomic strategy must be all_or_nothing");
  }
  if (plan.atomic.planHash !== undefined) validateNonEmptyString(plan.atomic.planHash, "Edit plan planHash");
  if (plan.atomic.expectedBaseSha !== undefined)
    validateNonEmptyString(plan.atomic.expectedBaseSha, "Edit plan expectedBaseSha");
  validateRequiredObject(plan.validation, "Edit plan validation requirement is required");
  if (typeof plan.validation.required !== "boolean") {
    throw new Error("Edit plan validation required must be boolean");
  }
  validateValidationRequestPayload(plan.validation.request);
  return plan;
}

export { validateEditPlanPayload };

function validateEditCommandResult(result: EditCommandResult): EditCommandResult {
  validateRequiredObject(result, "Edit command result is required");
  validateBoolean(result.ok, "Edit command result ok");
  validateBoolean(result.applied, "Edit command result applied");
  validateOptional(result.planId, (value) => validateNonEmptyString(value, "Edit command result planId"));
  validateOptional(result.planHash, (value) => validateNonEmptyString(value, "Edit command result planHash"));
  validateOptional(result.appliedAt, (value) => validateNonEmptyString(value, "Edit command result appliedAt"));
  validateOptional(result.matchCount, (value) =>
    validateNonNegativeInteger(value, "Edit command result matchCount"),
  );
  validateOptional(result.afterState, validateEditAfterState);
  validateOptional(result.validationRequest, validateValidationRequestPayload);
  validateOptional(result.validation, validateValidationResultPayload);
  validateOptional(result.refusal, validateEditRefusal);
  validateOptional(result.rollback, validateEditPlanRollbackState);
  if (!result.ok && result.refusal === undefined) {
    throw new Error("Edit command result refusal is required when ok=false");
  }
  if (result.ok && result.refusal !== undefined) {
    throw new Error("Edit command result ok=true must not include refusal");
  }
  return result;
}

export { validateEditCommandResult };

function validateEditPlanRollbackState(rollback: EditPlanRollbackState): EditPlanRollbackState {
  validateRequiredObject(rollback, "Edit rollback state is required");
  if (typeof rollback.completed !== "boolean") {
    throw new Error("Edit rollback completed must be boolean");
  }
  validateRepoRelativePaths(rollback.restoredPaths, "Edit rollback restoredPaths");
  validateRepoRelativePaths(rollback.failedPaths, "Edit rollback failedPaths");
  if (!Array.isArray(rollback.cleanupFailedPaths)) {
    throw new Error("Edit rollback cleanupFailedPaths must be an array");
  }
  for (const path of rollback.cleanupFailedPaths) {
    validateNonEmptyString(path, "Edit rollback cleanupFailedPaths path");
  }
  return rollback;
}

export { validateEditPlanRollbackState };

function validateRepoRelativeChange(change: RepoRelativeChange): RepoRelativeChange {
  validateRequiredObject(change, "Repo-relative change is required");
  if (change.kind === "create" || change.kind === "replace") {
    validateRepoRelativePath(change.path);
    if (typeof change.content !== "string") throw new Error("Repo-relative write change content must be string");
    if (change.checksumBefore !== undefined)
      validateNonEmptyString(change.checksumBefore, "Repo-relative change checksumBefore");
    if (change.checksumAfter !== undefined)
      validateNonEmptyString(change.checksumAfter, "Repo-relative change checksumAfter");
    return change;
  }
  if (change.kind === "delete") {
    validateRepoRelativePath(change.path);
    if (change.checksumBefore !== undefined)
      validateNonEmptyString(change.checksumBefore, "Repo-relative change checksumBefore");
    return change;
  }
  if (change.kind === "rename") {
    validateRepoRelativePath(change.path);
    validateRepoRelativePath(change.toPath);
    if (change.checksumBefore !== undefined)
      validateNonEmptyString(change.checksumBefore, "Repo-relative change checksumBefore");
    return change;
  }
  throw new Error(`Unknown repo-relative change kind: ${String((change as { kind?: unknown }).kind)}`);
}

export { validateRepoRelativeChange };

function validateEditAfterState(afterState: Readonly<Record<string, string | null>>): void {
  if (!afterState || typeof afterState !== "object" || Array.isArray(afterState)) {
    throw new Error("Edit command result afterState must be an object");
  }
  for (const [path, content] of Object.entries(afterState)) {
    validateRepoRelativePath(path);
    if (typeof content !== "string" && content !== null) {
      throw new Error(`Edit command result afterState for ${path} must be string or null`);
    }
  }
}

export { validateEditAfterState };
