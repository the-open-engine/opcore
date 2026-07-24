import type { PythonProjectContext, PythonValidationCapabilityRun, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { PYTHON_PYTEST_CHECK_ID } from "./check-ids.js";
import { diagnostic } from "./diagnostics.js";
import type { CleanupState, ProjectRunResult, PytestRunOutcome } from "./pytest-types.js";

export function pytestDiagnostic(code: string, message: string, path: string | undefined): ValidationDiagnostic {
  return diagnostic({
    category: "test",
    severity: "warning",
    code,
    message,
    ...(path === undefined ? {} : { path })
  });
}

export function notApplicableRun(message: string): ValidationCheckResult {
  return {
    diagnostics: [],
    outcome: "passed",
    pythonCapabilityRuns: [{
      capability: "pytest",
      checkId: PYTHON_PYTEST_CHECK_ID,
      activation: "not_applicable",
      outcome: "not_applicable",
      message
    }]
  };
}

export function disabledPytestRun(message = "python.pytest is disabled by repo policy."): ValidationCheckResult {
  return {
    diagnostics: [],
    outcome: "passed",
    pythonCapabilityRuns: [{
      capability: "pytest",
      checkId: PYTHON_PYTEST_CHECK_ID,
      activation: "disabled",
      outcome: "disabled",
      message,
      selectionMode: "none"
    }]
  };
}

export function unsupportedRun(context: PythonProjectContext, message: string): ValidationCheckResult {
  return {
    diagnostics: [pytestDiagnostic("PYTHON_PYTEST_CONTEXT_UNSUPPORTED", message, context.target)],
    outcome: "unsupported_target",
    pythonProjectContexts: [context],
    pythonCapabilityRuns: [{
      capability: "pytest",
      checkId: PYTHON_PYTEST_CHECK_ID,
      activation: "enabled",
      outcome: "unsupported_target",
      message,
      projectKey: context.projectKey,
      projectRoot: context.projectRoot
    }]
  };
}

export function unsupportedPytestTool(context: PythonProjectContext, candidatePaths: readonly string[]): ValidationCheckResult {
  return {
    diagnostics: [pytestDiagnostic("PYTHON_PYTEST_UNSUPPORTED", `pytest is unavailable for project ${context.projectRoot}.`, context.target)],
    outcome: "tool_unavailable",
    pythonProjectContexts: [context],
    pythonCapabilityRuns: [{
      capability: "pytest",
      checkId: PYTHON_PYTEST_CHECK_ID,
      activation: "enabled",
      outcome: "tool_unavailable",
      message: `pytest is unavailable for project ${context.projectRoot}.`,
      projectKey: context.projectKey,
      projectRoot: context.projectRoot,
      candidatePaths
    }]
  };
}

export function candidateFailure(
  contexts: readonly PythonProjectContext[],
  candidatePaths: readonly string[],
  message: string
): ValidationCheckResult {
  return {
    diagnostics: [pytestDiagnostic("PYTHON_PYTEST_NO_CANDIDATES", message, contexts[0]?.target)],
    outcome: "findings",
    pythonProjectContexts: contexts,
    pythonCapabilityRuns: [{
      capability: "pytest",
      checkId: PYTHON_PYTEST_CHECK_ID,
      activation: "enabled",
      outcome: "no_candidates",
      message,
      candidatePaths
    }]
  };
}

export function failureRun(
  code: string,
  message: string,
  outcome: Extract<PytestRunOutcome, "tool_failure" | "findings">,
  contexts: readonly PythonProjectContext[] = [],
  candidatePaths: readonly string[] = []
): ValidationCheckResult {
  return {
    diagnostics: [pytestDiagnostic(code, message, contexts[0]?.target)],
    outcome,
    pythonProjectContexts: contexts,
    pythonCapabilityRuns: [{
      capability: "pytest",
      checkId: PYTHON_PYTEST_CHECK_ID,
      activation: "enabled",
      outcome,
      message,
      candidatePaths
    }]
  };
}

export function createCleanupState(): CleanupState {
  return { attempted: false, ok: true, failureMessages: [] };
}

export function recordCleanup(cleanup: CleanupState, action: () => void): void {
  cleanup.attempted = true;
  try {
    action();
  } catch (error) {
    cleanup.ok = false;
    cleanup.failureMessages.push(errorMessage(error));
  }
}

export function cleanupFailureMessage(cleanup: CleanupState): string {
  return cleanup.failureMessages.length === 0
    ? "Pytest temporary workspace cleanup failed."
    : `Pytest temporary workspace cleanup failed: ${cleanup.failureMessages.join("; ")}`;
}

export function finalizeCapabilityRun(cleanup: CleanupState, result: ProjectRunResult): ProjectRunResult {
  const cleanupEvidence: NonNullable<PythonValidationCapabilityRun["cleanup"]> = {
    attempted: cleanup.attempted,
    ok: cleanup.ok,
    ...(cleanup.ok || cleanup.failureMessages.length === 0 ? {} : { failureMessage: cleanup.failureMessages.join("; ") })
  };
  if (cleanup.ok) {
    return { ...result, capabilityRun: { ...result.capabilityRun, cleanup: cleanupEvidence } };
  }
  const cleanupMessage = cleanupFailureMessage(cleanup);
  return {
    outcome: "tool_failure",
    diagnostics: [
      ...result.diagnostics,
      pytestDiagnostic("PYTHON_PYTEST_CLEANUP_FAILED", cleanupMessage, result.diagnostics[0]?.path ?? result.capabilityRun.projectRoot)
    ],
    capabilityRun: {
      ...result.capabilityRun,
      outcome: "tool_failure",
      message: result.outcome === "passed" ? cleanupMessage : `${result.capabilityRun.message} Cleanup also failed.`,
      cleanup: cleanupEvidence
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
