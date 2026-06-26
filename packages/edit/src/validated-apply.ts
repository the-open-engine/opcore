import type {
  EditCommandResult,
  EditPlan,
  EditRefusal,
  ValidationResult
} from "@the-open-engine/opcore-contracts";
import {
  applyEditPlan,
  previewEditPlan,
  type EditPlanApplySuccess,
  type EditPlanPreviewSuccess
} from "./atomic-writer.js";
import {
  editRefusalFromValidationResult,
  runEditValidation,
  type EditValidationRunner
} from "./validation.js";
import {
  editRefusalFromGraphStatus,
  graphStatusFingerprint,
  missingEditGraphStatus,
  type EditGraphProviderClient
} from "./symbol-graph.js";
import type { EditWorkspace } from "./workspace.js";

export interface EditValidationOptions {
  validationRunner?: EditValidationRunner;
  validationTimeoutMs?: number;
  graphProviderClient?: EditGraphProviderClient;
}

export interface ValidatedEditPlanPreviewSuccess {
  ok: true;
  preview: EditPlanPreviewSuccess;
  validation?: ValidationResult;
}

export interface ValidatedEditPlanPreviewRefusal {
  ok: false;
  refusal: EditRefusal;
  preview?: EditPlanPreviewSuccess;
  validation?: ValidationResult;
}

export type ValidatedEditPlanPreviewResult = ValidatedEditPlanPreviewSuccess | ValidatedEditPlanPreviewRefusal;

export type ValidatedEditPlanApplyResult =
  | (EditPlanApplySuccess & { validation?: ValidationResult })
  | {
      ok: false;
      applied: false;
      refusal: EditRefusal;
      preview?: EditPlanPreviewSuccess;
      validation?: ValidationResult;
      rollback?: EditCommandResult["rollback"];
    };

export async function previewAndValidateEditPlan(
  workspace: EditWorkspace,
  plan: EditPlan,
  options: EditValidationOptions = {}
): Promise<ValidatedEditPlanPreviewResult> {
  const preview = await previewEditPlan(workspace, plan);
  if (!preview.ok) return { ok: false, refusal: preview.refusal };
  if (plan.changes.length === 0) return { ok: true, preview };
  const bypass = validationBypassRefusal(plan);
  if (bypass !== undefined) return { ok: false, refusal: bypass, preview };
  const graphFreshness = await graphFreshnessRefusal(plan, options);
  if (graphFreshness !== undefined) return { ok: false, refusal: graphFreshness, preview };

  const validation = await runEditValidation(preview.validationRequest, options.validationRunner, options.validationTimeoutMs);
  const refusal = editRefusalFromValidationResult(validation);
  if (refusal !== undefined) return { ok: false, refusal, preview, validation };
  return { ok: true, preview, validation };
}

export async function validateAndApplyEditPlan(
  workspace: EditWorkspace,
  plan: EditPlan,
  options: EditValidationOptions = {}
): Promise<ValidatedEditPlanApplyResult> {
  const validated = await previewAndValidateEditPlan(workspace, plan, options);
  if (!validated.ok) {
    return {
      ok: false,
      applied: false,
      refusal: validated.refusal,
      preview: validated.preview,
      validation: validated.validation
    };
  }
  if (plan.changes.length === 0) {
    return {
      ok: true,
      applied: true,
      appliedAt: new Date().toISOString(),
      planId: validated.preview.planId,
      planHash: validated.preview.planHash,
      afterState: validated.preview.afterState,
      validationRequest: validated.preview.validationRequest,
      validation: validated.validation
    };
  }

  const applied = await applyEditPlan(workspace, plan);
  if (!applied.ok) {
    return {
      ok: false,
      applied: false,
      refusal: applied.refusal,
      preview: validated.preview,
      validation: validated.validation,
      rollback: applied.rollback
    };
  }
  return {
    ...applied,
    validation: validated.validation
  };
}

function validationBypassRefusal(plan: EditPlan): EditRefusal | undefined {
  if (plan.validation.required === true) return undefined;
  return {
    category: "unsupported_change",
    message: "Edit apply requires validation.required=true; validation bypass plans are refused"
  };
}

async function graphFreshnessRefusal(plan: EditPlan, options: EditValidationOptions): Promise<EditRefusal | undefined> {
  const embeddedStatus = plan.validation.request.graph.status;
  if (embeddedStatus === undefined) return undefined;
  let currentStatus;
  try {
    currentStatus = (await options.graphProviderClient?.status({
      repo: plan.repo,
      mode: plan.validation.request.graph.mode
    })) ?? missingEditGraphStatus(plan.repo, plan.validation.request.graph.mode);
  } catch (error) {
    return {
      category: "validation_failed",
      message: `GraphProvider status check failed before edit apply: ${errorMessage(error)}`
    };
  }
  const statusRefusal = editRefusalFromGraphStatus(currentStatus);
  if (statusRefusal !== undefined) return statusRefusal;
  if (graphStatusFingerprint(currentStatus) !== graphStatusFingerprint(embeddedStatus)) {
    return {
      category: "conflict",
      message: "GraphProvider freshness changed since symbol edit preview; regenerate the plan before applying"
    };
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
