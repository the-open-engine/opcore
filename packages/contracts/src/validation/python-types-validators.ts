import { includesString } from "../shared/primitives.js";
import { validateNonNegativeInteger } from "../shared/validators-01.js";
import type { PythonValidationCapabilityRun } from "./diagnostic-contracts.js";
import type { PythonTypesValidationCapabilityRun } from "./python-project-contracts-02.js";
import {
  validatePythonProjectRoot,
  validateSha256Identity,
} from "./python-project-validators-02.js";
import {
  validatePythonPytestValidationCapabilityRun,
  validatePythonValidationCapabilityTool,
} from "./python-pytest-validators-01.js";
import {
  validatePythonValidationCapabilityExecution,
  validateSortedUniqueRepoPaths,
} from "./python-pytest-validators-02.js";
import { validatePythonRuffValidationCapabilityRun } from "./python-ruff-validators-01.js";
import {
  validateExactObjectKeys,
  validatePythonCapabilityRunSchema,
} from "./python-validator-primitives.js";
import { pythonValidationAuthorities, pythonValidationCapabilityRunStatuses } from "./vocabulary-01.js";
import { pythonValidationAuthoritySources } from "./vocabulary-02.js";

function validatePythonValidationCapabilityRun(run: PythonValidationCapabilityRun): PythonValidationCapabilityRun {
  if (run.capability === "types") return validatePythonTypesValidationCapabilityRun(run);
  if (run.capability === "pytest") return validatePythonPytestValidationCapabilityRun(run);
  return validatePythonRuffValidationCapabilityRun(run);
}

export { validatePythonValidationCapabilityRun };

function validatePythonTypesValidationCapabilityRun(
  run: PythonTypesValidationCapabilityRun,
): PythonTypesValidationCapabilityRun {
  if (!run || typeof run !== "object") throw new Error("Python validation capability run is required");
  validatePythonCapabilityRunShape(run);
  validatePythonCapabilityRunIdentity(run);
  validatePythonCapabilityRunCounts(run);
  if (run.tool !== undefined) validatePythonValidationCapabilityTool(run.tool, run);
  if (run.execution !== undefined) validatePythonValidationCapabilityExecution(run.execution);
  validatePythonCapabilityRunStatus(run);
  return run;
}

export { validatePythonTypesValidationCapabilityRun };

function validatePythonCapabilityRunShape(run: PythonTypesValidationCapabilityRun): void {
  validateExactObjectKeys(
    run,
    [
      "schemaId",
      "schemaVersion",
      "capability",
      "checkId",
      "projectKey",
      "contextFingerprint",
      "projectRoot",
      "targets",
      "selectedSourcePaths",
      "selectedConfigPaths",
      "afterStateManifestFingerprint",
      "authority",
      "authoritySource",
      "status",
      "tool",
      "execution",
      "durationMs",
      "diagnosticCount",
      "errorCount",
      "warningCount",
      "noteCount",
    ],
    "Python validation capability run",
  );
  validatePythonCapabilityRunSchema(run);
  if (run.capability !== "types" || run.checkId !== "python.types") {
    throw new Error("Python validation capability run must describe python.types");
  }
}

export { validatePythonCapabilityRunShape };

function validatePythonCapabilityRunIdentity(run: PythonTypesValidationCapabilityRun): void {
  validateSha256Identity(run.projectKey, "Python validation capability run projectKey");
  validateSha256Identity(run.contextFingerprint, "Python validation capability run contextFingerprint");
  validatePythonProjectRoot(run.projectRoot, "Python validation capability run projectRoot");
  validateSortedUniqueRepoPaths(run.targets, "Python validation capability run targets", false);
  validateSortedUniqueRepoPaths(run.selectedSourcePaths, "Python validation capability run selectedSourcePaths", false);
  validateSortedUniqueRepoPaths(run.selectedConfigPaths, "Python validation capability run selectedConfigPaths", true);
  validatePythonCapabilityRunTargets(run);
  validateSha256Identity(
    run.afterStateManifestFingerprint,
    "Python validation capability run afterStateManifestFingerprint",
  );
  validatePythonCapabilityRunAuthority(run);
  if (!includesString(pythonValidationCapabilityRunStatuses, run.status)) {
    throw new Error(`Unknown Python validation capability run status: ${String(run.status)}`);
  }
}

export { validatePythonCapabilityRunIdentity };

function validatePythonCapabilityRunTargets(run: PythonTypesValidationCapabilityRun): void {
  for (const target of run.targets) {
    if (!run.selectedSourcePaths.includes(target)) {
      throw new Error("Python validation capability run targets must be selected source paths");
    }
  }
}

function validatePythonCapabilityRunAuthority(run: PythonTypesValidationCapabilityRun): void {
  if (run.authority !== undefined && !includesString(pythonValidationAuthorities, run.authority)) {
    throw new Error(`Unknown Python validation authority: ${String(run.authority)}`);
  }
  if (run.authoritySource !== undefined && !includesString(pythonValidationAuthoritySources, run.authoritySource)) {
    throw new Error(`Unknown Python validation authority source: ${String(run.authoritySource)}`);
  }
  if ((run.authority === undefined) !== (run.authoritySource === undefined)) {
    throw new Error("Python validation capability authority and authoritySource must be present together");
  }
  const permitsMissingAuthority = run.status === "invalid_config" || run.status === "unsupported_target";
  if (run.authority === undefined && !permitsMissingAuthority) {
    throw new Error(`Python validation capability run ${run.status} requires selected authority evidence`);
  }
}

function validatePythonCapabilityRunCounts(run: PythonTypesValidationCapabilityRun): void {
  for (const [key, value] of [
    ["durationMs", run.durationMs],
    ["diagnosticCount", run.diagnosticCount],
    ["errorCount", run.errorCount],
    ["warningCount", run.warningCount],
    ["noteCount", run.noteCount],
  ] as const)
    validateNonNegativeInteger(value, `Python validation capability run ${key}`);
  if (run.diagnosticCount !== run.errorCount + run.warningCount + run.noteCount) {
    throw new Error("Python validation capability run diagnosticCount must equal severity counts");
  }
}

export { validatePythonCapabilityRunCounts };

function validatePythonCapabilityRunStatus(run: PythonTypesValidationCapabilityRun): void {
  if (run.status === "passed") validatePassedPythonCapability(run);
  if (run.status === "findings") validateFindingsPythonCapability(run);
  if (run.status === "timeout") validateTimeoutPythonCapability(run);
  if (run.status === "invalid_config") validateInvalidPythonCapability(run);
  if (run.status === "unsupported_target") validateUnexecutedPythonCapability(run);
  if (run.status === "tool_unavailable") validateUnavailablePythonCapability(run);
  if (run.status === "tool_failure") validateFailedPythonCapability(run);
}

export { validatePythonCapabilityRunStatus };

function validatePassedPythonCapability(run: PythonTypesValidationCapabilityRun): void {
  requireExitedPythonCapability(run);
  if (run.execution?.exitCode !== 0 || run.errorCount !== 0) {
    throw new Error("Passed Python validation capability run requires exit 0 and zero errors");
  }
}

export { validatePassedPythonCapability };

function validateFindingsPythonCapability(run: PythonTypesValidationCapabilityRun): void {
  requireExitedPythonCapability(run);
  if (run.execution?.exitCode !== 1 || run.diagnosticCount === 0) {
    throw new Error("Findings Python validation capability run requires exit 1 and diagnostics");
  }
  if (run.errorCount + run.warningCount === 0) {
    throw new Error("Findings Python validation capability run requires an error or warning");
  }
}

export { validateFindingsPythonCapability };

function requireExitedPythonCapability(run: PythonTypesValidationCapabilityRun): void {
  if (run.tool === undefined || run.execution?.termination !== "exited") {
    throw new Error(`Python validation capability run ${run.status} requires exited tool evidence`);
  }
}

export { requireExitedPythonCapability };

function validateTimeoutPythonCapability(run: PythonTypesValidationCapabilityRun): void {
  if (
    run.tool === undefined ||
    run.execution?.termination !== "timeout" ||
    run.execution.failureSummary === undefined
  ) {
    throw new Error("Timeout Python validation capability run requires tool and timeout failure evidence");
  }
}

export { validateTimeoutPythonCapability };

function validateInvalidPythonCapability(run: PythonTypesValidationCapabilityRun): void {
  if (run.authority === undefined && (run.tool !== undefined || run.execution !== undefined)) {
    throw new Error(
      "Unselected invalid-config Python validation capability run must not include tool or execution evidence",
    );
  }
  if (run.execution === undefined) return;
  if (run.tool === undefined || run.execution.termination !== "exited" || run.execution.failureSummary === undefined) {
    throw new Error("Executed invalid-config Python validation capability run requires exited tool failure evidence");
  }
}

export { validateInvalidPythonCapability };

function validateUnexecutedPythonCapability(run: PythonTypesValidationCapabilityRun): void {
  if (run.execution !== undefined)
    throw new Error(`${run.status} Python validation capability run must not include execution evidence`);
}

export { validateUnexecutedPythonCapability };

function validateUnavailablePythonCapability(run: PythonTypesValidationCapabilityRun): void {
  if (run.tool === undefined || run.execution !== undefined) {
    throw new Error("Tool-unavailable Python validation capability run requires tool provenance without execution");
  }
}

export { validateUnavailablePythonCapability };

function validateFailedPythonCapability(run: PythonTypesValidationCapabilityRun): void {
  if (
    run.tool === undefined ||
    run.execution === undefined ||
    run.execution.termination === "timeout" ||
    run.execution.failureSummary === undefined
  ) {
    throw new Error("Tool-failure Python validation capability run requires non-timeout tool failure evidence");
  }
}

export { validateFailedPythonCapability };

function validatePythonValidationCapabilityRuns(
  runs: readonly PythonValidationCapabilityRun[],
): readonly PythonValidationCapabilityRun[] {
  if (!Array.isArray(runs)) throw new Error("Python validation capability runs must be an array");
  for (const run of runs) validatePythonValidationCapabilityRun(run);
  return runs;
}

export { validatePythonValidationCapabilityRuns };
