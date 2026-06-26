import type {
  EditRefusal,
  ValidationFailureCategory,
  ValidationRequest,
  ValidationResult
} from "@the-open-engine/lattice-contracts";
import {
  validateValidationRequestPayload,
  validateValidationResultPayload
} from "@the-open-engine/lattice-contracts";

export interface EditValidationRunner {
  runValidation(request: ValidationRequest): Promise<ValidationResult>;
}

export const defaultEditValidationTimeoutMs = 30_000;

export async function runEditValidation(
  request: ValidationRequest,
  runner: EditValidationRunner | undefined,
  timeoutMs: number = defaultEditValidationTimeoutMs
): Promise<ValidationResult> {
  try {
    validateValidationRequestPayload(request);
  } catch (error) {
    return validationFailureResult("invalid_payload", "Edit validation request payload is invalid", error);
  }
  if (runner === undefined || typeof runner.runValidation !== "function") {
    return validationFailureResult("infrastructure_failure", "Edit validation runner is unavailable");
  }

  try {
    const result = await withTimeout(
      runner.runValidation(request),
      timeoutMs,
      () => validationFailureResult("infrastructure_failure", `Edit validation timed out after ${timeoutMs}ms`)
    );
    try {
      return validateValidationResultPayload(result);
    } catch (error) {
      return validationFailureResult("invalid_payload", "Edit validation result payload is invalid", error);
    }
  } catch (error) {
    if (isValidationResult(error)) return error;
    return validationFailureResult("infrastructure_failure", "Edit validation runner failed", error);
  }
}

export function editRefusalFromValidationResult(result: ValidationResult): EditRefusal | undefined {
  const validated = validateValidationResultPayload(result);
  if (validated.status === "passed") return undefined;
  if (validated.graphStatus?.state === "required_missing") {
    return {
      category: "provider_required_missing",
      message: validationResultMessage(validated)
    };
  }
  if (validated.graphStatus?.state === "schema_mismatch") {
    return {
      category: "schema_mismatch",
      message: validationResultMessage(validated)
    };
  }
  if (validated.status === "refused" && validated.refusal !== undefined) {
    return validated.refusal;
  }
  return {
    category: "validation_failed",
    message: validationResultMessage(validated)
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(onTimeout()), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function validationFailureResult(
  category: Extract<ValidationFailureCategory, "infrastructure_failure" | "invalid_payload">,
  message: string,
  error?: unknown
): ValidationResult {
  const cause = errorCause(error);
  const failure = {
    category,
    message
  };
  const result: ValidationResult = {
    ok: false,
    status: category,
    diagnostics: [
      {
        category: category === "invalid_payload" ? "edit_safety" : "infrastructure",
        message,
        severity: "error"
      }
    ],
    failure: cause === undefined ? failure : { ...failure, cause }
  };
  return validateValidationResultPayload(result);
}

function validationResultMessage(result: ValidationResult): string {
  return result.refusal?.message
    ?? result.failure?.message
    ?? (result.graphStatus !== undefined && "failure" in result.graphStatus ? result.graphStatus.failure.message : undefined)
    ?? result.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message
    ?? `Edit validation failed with status ${result.status}`;
}

function isValidationResult(value: unknown): value is ValidationResult {
  try {
    validateValidationResultPayload(value as ValidationResult);
    return true;
  } catch {
    return false;
  }
}

function errorCause(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
