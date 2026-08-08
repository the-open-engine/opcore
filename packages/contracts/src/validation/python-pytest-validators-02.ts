import { includesString } from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString, validateNonNegativeInteger } from "../shared/validators-01.js";
import type { PythonValidationCapabilityExecution } from "./python-project-contracts-02.js";
import {
  containsHostAbsolutePath,
  validateExactObjectKeys,
} from "./python-validator-primitives.js";
import { pythonValidationCapabilityTerminationKinds } from "./vocabulary-02.js";

function validatePortablePythonCapabilityExecutable(executable: string): void {
  validateNonEmptyString(executable, "Python validation capability tool executable");
  const match = /^(repo|project|path|external):(.+)$/u.exec(executable);
  if (match === null) throw new Error("Python validation capability tool requires a portable executable locator");
  const [, kind, value] = match;
  if (kind === "repo" || kind === "project") {
    try {
      validateRepoRelativePath(value);
    } catch {
      throw new Error("Python validation capability tool requires a portable executable locator");
    }
    return;
  }
  if (!/^[A-Za-z0-9_.+-]+$/u.test(value)) {
    throw new Error("Python validation capability tool requires a portable executable locator");
  }
}

export { validatePortablePythonCapabilityExecutable };

function validatePythonValidationCapabilityExecution(execution: PythonValidationCapabilityExecution): void {
  validateExactObjectKeys(
    execution,
    ["termination", "exitCode", "signal", "failureSummary"],
    "Python validation capability execution",
  );
  if (!includesString(pythonValidationCapabilityTerminationKinds, execution.termination)) {
    throw new Error(`Unknown Python validation capability termination: ${String(execution.termination)}`);
  }
  validatePythonCapabilityExit(execution);
  validatePythonCapabilitySignal(execution);
  validatePythonCapabilityFailureSummary(execution);
}

export { validatePythonValidationCapabilityExecution };

function validatePythonCapabilityExit(execution: PythonValidationCapabilityExecution): void {
  if (execution.exitCode !== undefined)
    validateNonNegativeInteger(execution.exitCode, "Python validation capability execution exitCode");
  if (execution.termination === "exited" && execution.exitCode === undefined) {
    throw new Error("Exited Python validation capability execution requires exitCode");
  }
  if (execution.termination !== "exited" && execution.exitCode !== undefined) {
    throw new Error("Non-exited Python validation capability execution must not include exitCode");
  }
}

export { validatePythonCapabilityExit };

function validatePythonCapabilitySignal(execution: PythonValidationCapabilityExecution): void {
  if (execution.termination === "signal" && execution.signal === undefined) {
    throw new Error("Signaled Python validation capability execution requires signal");
  }
  if (execution.termination !== "signal" && execution.signal !== undefined) {
    throw new Error("Non-signaled Python validation capability execution must not include signal");
  }
  if (execution.signal !== undefined)
    validateNonEmptyString(execution.signal, "Python validation capability execution signal");
}

export { validatePythonCapabilitySignal };

function validatePythonCapabilityFailureSummary(execution: PythonValidationCapabilityExecution): void {
  if (execution.failureSummary !== undefined) {
    validateNonEmptyString(execution.failureSummary, "Python validation capability execution failureSummary");
    if (execution.failureSummary.length > 1024)
      throw new Error("Python validation capability execution failureSummary is too long");
    if (containsHostAbsolutePath(execution.failureSummary)) {
      throw new Error("Python validation capability execution failureSummary must not contain host-absolute paths");
    }
  }
  if (execution.termination !== "exited" && execution.failureSummary === undefined) {
    throw new Error("Non-exited Python validation capability execution requires failureSummary");
  }
}

export { validatePythonCapabilityFailureSummary };

function validateSortedUniqueRepoPaths(values: readonly string[], label: string, allowEmpty: boolean): void {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  for (const value of values) validateRepoRelativePath(value);
  const sorted = [...new Set(values)].sort();
  if (sorted.length !== values.length || sorted.some((value, index) => value !== values[index])) {
    throw new Error(`${label} must be sorted and unique`);
  }
}

export { validateSortedUniqueRepoPaths };
