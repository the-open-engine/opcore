import { validateRepoRelativePath } from "../shared/path-validators.js";
import type { PythonRuffValidationCapabilityRun } from "./diagnostic-contracts.js";
import { validateRuffTerminationEvidence } from "./python-ruff-validators-03.js";

function validateRuffCapabilityRun(run: PythonRuffValidationCapabilityRun): void {
  if (!validateRuffCapabilityIdentity(run)) return;
  if (run.state === "not_applicable" || run.state === "disabled") return;
  validateActivatedRuffExactState(run);
  validateRuffCapabilityState(run);
}

export { validateRuffCapabilityRun };

function validateRuffCapabilityIdentity(run: PythonRuffValidationCapabilityRun): boolean {
  const expectedCheckId = expectedRuffCheckId(run.capability);
  if (expectedCheckId === undefined) return false;
  if (run.checkId !== expectedCheckId) {
    throw new Error(`Python validation capability ${run.capability} requires checkId ${expectedCheckId}`);
  }
  return true;
}

export { validateRuffCapabilityIdentity };

function validateRuffCapabilityState(run: PythonRuffValidationCapabilityRun): void {
  switch (run.state) {
    case "tool_unavailable":
    case "unsupported_target":
      return validateUnavailableRuffCapability(run);
    case "timeout":
      return validateTimeoutRuffCapability(run);
    case "invalid_config":
      return validateInvalidConfigRuffCapability(run);
    case "tool_failure":
      return validateFailedRuffCapability(run);
    case "passed":
    case "findings":
      return validateCompletedRuffCapability(run);
  }
}

export { validateRuffCapabilityState };

function expectedRuffCheckId(
  capability: PythonRuffValidationCapabilityRun["capability"],
): "python.ruff-lint" | "python.ruff-format" | undefined {
  if (capability === "ruff_lint") return "python.ruff-lint";
  if (capability === "ruff_format") return "python.ruff-format";
  return undefined;
}

export { expectedRuffCheckId };

function validateActivatedRuffExactState(run: PythonRuffValidationCapabilityRun): void {
  const exactStateFields: readonly (keyof PythonRuffValidationCapabilityRun)[] = [
    "projectKey",
    "contextFingerprint",
    "afterStateManifestFingerprint",
    "sourcePaths",
    "configPaths",
    "cwd",
  ];
  for (const field of exactStateFields) {
    if (run[field] === undefined) {
      throw new Error(`Activated Ruff capability run requires ${field}`);
    }
  }
  if ((run.sourcePaths?.length ?? 0) === 0) {
    throw new Error("Activated Ruff capability run requires at least one source path");
  }
  if (run.cwd !== "." && run.cwd !== undefined) validateRepoRelativePath(run.cwd);
}

export { validateActivatedRuffExactState };

function validateUnavailableRuffCapability(run: PythonRuffValidationCapabilityRun): void {
  requireRuffFailureMessage(run);
  rejectRuffProcessEvidence(run);
}

export { validateUnavailableRuffCapability };

function validateTimeoutRuffCapability(run: PythonRuffValidationCapabilityRun): void {
  requireRuffFailureMessage(run);
  requireExecutedRuffCapability(run);
  if (run.termination !== "timeout") {
    throw new Error("Ruff capability timeout requires timeout termination");
  }
  validateExecutedRuffCapabilityCoherence(run);
}

export { validateTimeoutRuffCapability };

function validateInvalidConfigRuffCapability(run: PythonRuffValidationCapabilityRun): void {
  requireRuffFailureMessage(run);
  if (!hasRuffProcessEvidence(run)) return;
  requireExecutedRuffCapability(run);
  if (run.termination !== "exited" || run.exitCode !== 2) {
    throw new Error("Executed Ruff capability invalid_config requires exited configuration-rejection evidence");
  }
  validateExecutedRuffCapabilityCoherence(run);
}

export { validateInvalidConfigRuffCapability };

function validateFailedRuffCapability(run: PythonRuffValidationCapabilityRun): void {
  requireRuffFailureMessage(run);
  if (!hasRuffProcessEvidence(run)) return;
  requireExecutedRuffCapability(run);
  if (run.termination === "timeout") {
    throw new Error("Executed Ruff capability tool_failure must not use timeout termination");
  }
  validateExecutedRuffCapabilityCoherence(run);
}

export { validateFailedRuffCapability };

function validateCompletedRuffCapability(run: PythonRuffValidationCapabilityRun): void {
  requireExecutedRuffCapability(run);
  if (run.termination !== "exited") {
    throw new Error("Executed Ruff capability run requires exited termination");
  }
  validateCompletedRuffInvocations(run);
  validateExecutedRuffCapabilityCoherence(run);
  validateCompletedRuffResult(run);
}

export { validateCompletedRuffCapability };

function validateCompletedRuffInvocations(run: PythonRuffValidationCapabilityRun): void {
  for (const invocation of requireRuffInvocations(run)) {
    if (invocation.termination !== "exited" || (invocation.exitCode !== 0 && invocation.exitCode !== 1)) {
      throw new Error("Executed Ruff capability invocation requires exited Ruff result code 0 or 1");
    }
  }
}

export { validateCompletedRuffInvocations };

function validateCompletedRuffResult(run: PythonRuffValidationCapabilityRun): void {
  const expectedExitCode = run.state === "passed" ? 0 : 1;
  if (run.exitCode !== expectedExitCode) {
    throw new Error(`Executed Ruff capability state ${run.state} requires exitCode ${expectedExitCode}`);
  }
  if (run.state === "passed" && run.diagnosticCount !== 0) {
    throw new Error("Passed Ruff capability run requires zero diagnostics");
  }
  if (run.state === "findings" && run.diagnosticCount <= 0) {
    throw new Error("Ruff findings capability run requires positive diagnosticCount");
  }
}

export { validateCompletedRuffResult };

function requireRuffFailureMessage(run: PythonRuffValidationCapabilityRun): void {
  if (run.failureMessage === undefined) {
    throw new Error(`Ruff capability state ${run.state} requires failureMessage`);
  }
}

export { requireRuffFailureMessage };

function hasRuffProcessEvidence(run: PythonRuffValidationCapabilityRun): boolean {
  return (
    run.command !== undefined ||
    run.argv !== undefined ||
    run.termination !== undefined ||
    run.exitCode !== undefined ||
    run.signal !== undefined ||
    run.invocations !== undefined
  );
}

export { hasRuffProcessEvidence };

function rejectRuffProcessEvidence(run: PythonRuffValidationCapabilityRun): void {
  if (hasRuffProcessEvidence(run)) {
    throw new Error(`Ruff capability state ${run.state} must not record process evidence`);
  }
}

export { rejectRuffProcessEvidence };

function requireExecutedRuffCapability(run: PythonRuffValidationCapabilityRun): void {
  const executionFields: readonly (keyof PythonRuffValidationCapabilityRun)[] = [
    "executable",
    "command",
    "argv",
    "toolVersion",
    "toolSource",
    "termination",
    "invocations",
  ];
  for (const field of executionFields) {
    if (run[field] === undefined) {
      throw new Error(`Executed Ruff capability run requires ${field}`);
    }
  }
  if (run.durationMs <= 0) {
    throw new Error("Executed Ruff capability run requires positive durationMs");
  }
  if (run.argv?.[0] !== run.executable) {
    throw new Error("Executed Ruff capability run argv must start with executable");
  }
  if (run.command !== run.argv?.join(" ")) {
    throw new Error("Executed Ruff capability run command must match argv");
  }
  validateRuffTerminationEvidence(run, "Executed Ruff capability run");
  for (const invocation of requireRuffInvocations(run)) {
    if (invocation.argv[0] !== run.executable) {
      throw new Error("Executed Ruff capability invocation argv must start with executable");
    }
    if (invocation.durationMs <= 0) {
      throw new Error("Executed Ruff capability invocation requires positive durationMs");
    }
  }
}

export { requireExecutedRuffCapability };

function requireRuffInvocations(
  run: PythonRuffValidationCapabilityRun,
): NonNullable<PythonRuffValidationCapabilityRun["invocations"]> {
  if (run.invocations === undefined) {
    throw new Error("Executed Ruff capability run requires invocations");
  }
  return run.invocations;
}

function validateExecutedRuffCapabilityCoherence(run: PythonRuffValidationCapabilityRun): void {
  const matchingInvocation = run.invocations?.some(
    (invocation) =>
      invocation.termination === run.termination &&
      invocation.exitCode === run.exitCode &&
      invocation.signal === run.signal &&
      invocation.argv.length === run.argv?.length &&
      invocation.argv.every((argument, index) => argument === run.argv?.[index]),
  );
  if (matchingInvocation !== true) {
    throw new Error("Executed Ruff capability run requires an invocation matching its argv and termination evidence");
  }
}

export { validateExecutedRuffCapabilityCoherence };
