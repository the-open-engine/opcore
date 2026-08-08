import {
  includesString,
  validateArray,
  validateObject,
  validateOptional,
  validateRequiredObject,
} from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateStringArray,
  validateValidationCheckId,
} from "../shared/validators-01.js";
import type {
  PythonRuffValidationCapabilityRun,
  PythonValidationCapabilityInvocation,
} from "./diagnostic-contracts.js";
import { pythonProjectExecutableSources } from "./python-project-contracts-01.js";
import { validateSha256Identity } from "./python-project-validators-02.js";
import { validatePortablePythonCapabilityExecutable } from "./python-pytest-validators-02.js";
import {
  containsHostAbsolutePath,
  validateExactObjectKeys,
  validatePythonCapabilityRunSchema,
} from "./python-validator-primitives.js";
import { validateRuffCapabilityRun } from "./python-ruff-validators-02.js";
import { validatePortablePythonCapabilityArgv, validateRuffTerminationEvidence } from "./python-ruff-validators-03.js";
import { pythonValidationCapabilityStates, pythonValidationCapabilityTerminations } from "./vocabulary-02.js";

function validatePythonRuffValidationCapabilityRun(
  run: PythonRuffValidationCapabilityRun,
): PythonRuffValidationCapabilityRun {
  validateObject(run, "Python validation capability run");
  validatePythonRuffRunHeader(run);
  validatePythonRuffRunIdentity(run);
  validatePythonRuffRunProcess(run);
  validatePythonRuffRunInvocations(run);
  validatePythonRuffRunOutcome(run);
  validateRuffCapabilityRun(run);
  return run;
}

export { validatePythonRuffValidationCapabilityRun };

function validatePythonRuffRunHeader(run: PythonRuffValidationCapabilityRun): void {
  validateExactObjectKeys(
    run,
    [
      "schemaId",
      "schemaVersion",
      "checkId",
      "capability",
      "state",
      "projectKey",
      "contextFingerprint",
      "afterStateManifestFingerprint",
      "sourcePaths",
      "configPaths",
      "executable",
      "command",
      "argv",
      "cwd",
      "configPath",
      "toolVersion",
      "toolSource",
      "termination",
      "exitCode",
      "signal",
      "invocations",
      "durationMs",
      "diagnosticCount",
      "failureMessage",
    ],
    "Python Ruff validation capability run",
  );
  validatePythonCapabilityRunSchema(run);
  validateValidationCheckId(run.checkId, "Python validation capability run checkId");
  if (!includesString(["ruff_lint", "ruff_format"] as const, run.capability)) {
    throw new Error(`Unknown Python Ruff validation capability: ${String(run.capability)}`);
  }
  if (!includesString(pythonValidationCapabilityStates, run.state)) {
    throw new Error(`Unknown Python validation capability state: ${String(run.state)}`);
  }
}

export { validatePythonRuffRunHeader };

function validatePythonRuffRunIdentity(run: PythonRuffValidationCapabilityRun): void {
  validateOptional(run.projectKey, (value) =>
    validateSha256Identity(value, "Python validation capability run projectKey"),
  );
  validateOptional(run.contextFingerprint, (value) =>
    validateSha256Identity(value, "Python validation capability run contextFingerprint"),
  );
  validateOptional(run.afterStateManifestFingerprint, (value) =>
    validateSha256Identity(value, "Python validation capability run afterStateManifestFingerprint"),
  );
  validateOptional(run.sourcePaths, (paths) => validatePythonRuffPaths(paths, "sourcePaths"));
  validateOptional(run.configPaths, (paths) => validatePythonRuffPaths(paths, "configPaths"));
}

export { validatePythonRuffRunIdentity };

function validatePythonRuffPaths(paths: readonly string[], label: string): void {
  validateStringArray(paths, `Python validation capability run ${label}`, { allowEmpty: true });
  for (const path of paths) validateRepoRelativePath(path);
}

export { validatePythonRuffPaths };

function validatePythonRuffRunProcess(run: PythonRuffValidationCapabilityRun): void {
  validateOptional(run.executable, validatePortablePythonCapabilityExecutable);
  validateOptional(run.command, (command) =>
    validateNonEmptyString(command, "Python validation capability run command"),
  );
  validateOptional(run.argv, (argv) => {
    validateStringArray(run.argv, "Python validation capability run argv", {
      allowEmpty: false,
    });
    validatePortablePythonCapabilityArgv(argv);
  });
  validateOptional(run.cwd, (cwd) => validateNonEmptyString(cwd, "Python validation capability run cwd"));
  validateOptional(run.configPath, validateRepoRelativePath);
  validatePythonRuffTool(run);
  validateOptional(run.termination, (termination) => {
    if (!includesString(pythonValidationCapabilityTerminations, termination)) {
      throw new Error(`Unknown Python validation capability termination: ${String(termination)}`);
    }
  });
  validateOptional(run.exitCode, (exitCode) =>
    validateNonNegativeInteger(exitCode, "Python validation capability run exitCode"),
  );
  validateOptional(run.signal, (signal) => validateNonEmptyString(signal, "Python validation capability run signal"));
}

export { validatePythonRuffRunProcess };

function validatePythonRuffTool(run: PythonRuffValidationCapabilityRun): void {
  if (run.toolVersion !== undefined) {
    validateNonEmptyString(run.toolVersion, "Python validation capability run toolVersion");
    if (!/^[0-9]+\.[0-9][-+._A-Za-z0-9]*$/u.test(run.toolVersion)) {
      throw new Error("Python validation capability run toolVersion must be exact version provenance");
    }
  }
  if (run.toolSource !== undefined && !includesString(pythonProjectExecutableSources, run.toolSource)) {
    throw new Error(`Unknown Python validation capability run toolSource: ${String(run.toolSource)}`);
  }
}

export { validatePythonRuffTool };

function validatePythonRuffRunInvocations(run: PythonRuffValidationCapabilityRun): void {
  validateOptional(run.invocations, (invocations) => {
    validateArray(invocations, "Python validation capability run invocations");
    if (invocations.length === 0) {
      throw new Error("Python validation capability run invocations must be a non-empty array");
    }
    for (const invocation of invocations) {
      validatePythonValidationCapabilityInvocation(invocation);
      if (run.executable !== undefined && invocation.argv[0] !== run.executable) {
        throw new Error("Python validation capability invocation argv must start with executable");
      }
    }
  });
}

export { validatePythonRuffRunInvocations };

function validatePythonRuffRunOutcome(run: PythonRuffValidationCapabilityRun): void {
  validateNonNegativeNumber(run.durationMs, "Python validation capability run durationMs");
  validateNonNegativeInteger(run.diagnosticCount, "Python validation capability run diagnosticCount");
  validateOptional(run.failureMessage, (failureMessage) => {
    validateNonEmptyString(failureMessage, "Python validation capability run failureMessage");
    if (containsHostAbsolutePath(failureMessage)) {
      throw new Error("Python validation capability run failureMessage must not contain host-absolute paths");
    }
  });
  validateInactivePythonRuffRun(run);
  validatePythonRuffRunTerminationFields(run);
}

export { validatePythonRuffRunOutcome };

function validateInactivePythonRuffRun(run: PythonRuffValidationCapabilityRun): void {
  if (run.state !== "not_applicable" && run.state !== "disabled") return;
  const processEvidence = [run.termination, run.exitCode, run.signal, run.command, run.argv, run.invocations];
  if (processEvidence.some((value) => value !== undefined)) {
    throw new Error(`Python validation capability state ${run.state} must not record a process invocation`);
  }
}

export { validateInactivePythonRuffRun };

function validatePythonRuffRunTerminationFields(run: PythonRuffValidationCapabilityRun): void {
  if (run.signal !== undefined && run.termination !== "signal") {
    throw new Error("Python validation capability run signal requires signal termination");
  }
  if (run.exitCode !== undefined && run.termination !== "exited") {
    throw new Error("Python validation capability run exitCode requires exited termination");
  }
}

export { validatePythonRuffRunTerminationFields };

function validatePythonValidationCapabilityInvocation(invocation: PythonValidationCapabilityInvocation): void {
  validateRequiredObject(invocation, "Python validation capability invocation is required");
  validateStringArray(invocation.argv, "Python validation capability invocation argv", { allowEmpty: false });
  validatePortablePythonCapabilityArgv(invocation.argv);
  if (!includesString(pythonValidationCapabilityTerminations, invocation.termination)) {
    throw new Error(`Unknown Python validation capability invocation termination: ${String(invocation.termination)}`);
  }
  if (invocation.exitCode !== undefined) {
    validateNonNegativeInteger(invocation.exitCode, "Python validation capability invocation exitCode");
    if (invocation.termination !== "exited") {
      throw new Error("Python validation capability invocation exitCode requires exited termination");
    }
  }
  if (invocation.signal !== undefined) {
    validateNonEmptyString(invocation.signal, "Python validation capability invocation signal");
    if (invocation.termination !== "signal") {
      throw new Error("Python validation capability invocation signal requires signal termination");
    }
  }
  validateRuffTerminationEvidence(invocation, "Python validation capability invocation");
  validateNonNegativeNumber(invocation.durationMs, "Python validation capability invocation durationMs");
}

export { validatePythonValidationCapabilityInvocation };
