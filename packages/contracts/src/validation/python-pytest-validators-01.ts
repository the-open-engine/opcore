import { includesString } from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateStringArray,
} from "../shared/validators-01.js";
import {
  validateExactValue,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import type {
  PythonCapabilityCleanupEvidence,
  PythonCapabilityCounts,
  PythonCapabilityInvocation,
  PythonPytestValidationCapabilityRun} from "./capability-contracts.js";
import {
  pythonCapabilityActivations,
  pythonPytestSelectionModes,
} from "./capability-contracts.js";
import { pythonProjectExecutableSources } from "./python-project-contracts-01.js";
import type {
  PythonTypesValidationCapabilityRun,
  PythonValidationCapabilityToolProvenance,
} from "./python-project-contracts-02.js";
import { validateExactObjectKeys } from "./python-validator-primitives.js";
import {
  validatePythonProjectRoot,
  validateRepoPathArray,
  validateSha256Identity,
} from "./python-project-validators-02.js";
import { validatePythonCapabilityInvocationWithDuration } from "./python-project-validators-01.js";
import { containsHostAbsolutePath } from "./python-validator-primitives.js";
import { validatePortablePythonCapabilityExecutable } from "./python-pytest-validators-02.js";

function validatePythonPytestValidationCapabilityRun(
  run: PythonPytestValidationCapabilityRun,
): PythonPytestValidationCapabilityRun {
  validateRequiredObject(run, "Python pytest capability run is required");
  validateExactObjectKeys(
    run,
    [
      "capability",
      "checkId",
      "activation",
      "outcome",
      "message",
      "projectKey",
      "projectRoot",
      "configFile",
      "targetCount",
      "candidatePaths",
      "collectedNodeIds",
      "afterStateFingerprint",
      "selectionMode",
      "selectionDigest",
      "counts",
      "collection",
      "execution",
      "cleanup",
    ],
    "Python pytest capability run",
  );
  if (run.capability !== "pytest" || run.checkId !== "python.pytest") {
    throw new Error("Python pytest capability run must describe python.pytest");
  }
  if (!includesString(pythonCapabilityActivations, run.activation)) {
    throw new Error(`Unknown Python pytest capability activation: ${String(run.activation)}`);
  }
  validateNonEmptyString(run.outcome, "Python pytest capability run outcome");
  validateNonEmptyString(run.message, "Python pytest capability run message");
  validatePythonPytestCapabilityIdentity(run);
  validatePythonPytestCapabilityExecutionEvidence(run);
  return run;
}

export { validatePythonPytestValidationCapabilityRun };

function validatePythonPytestCapabilityIdentity(run: PythonPytestValidationCapabilityRun): void {
  validateOptional(run.projectKey, (value) =>
    validateSha256Identity(value, "Python pytest capability run projectKey"),
  );
  validateOptional(run.projectRoot, (value) =>
    validatePythonProjectRoot(value, "Python pytest capability run projectRoot"),
  );
  validateOptional(run.configFile, validateRepoRelativePath);
  validateOptional(run.targetCount, (value) =>
    validateNonNegativeInteger(value, "Python pytest capability run targetCount"),
  );
  validateOptional(run.candidatePaths, (value) =>
    validateRepoPathArray(value, "Python pytest capability run candidatePaths"),
  );
  validateOptional(run.collectedNodeIds, (value) => {
    validateStringArray(value, "Python pytest capability run collectedNodeIds", { allowEmpty: true });
  });
  validateOptional(run.afterStateFingerprint, (value) =>
    validateSha256Identity(value, "Python pytest capability run afterStateFingerprint"),
  );
  if (run.selectionMode !== undefined && !includesString(pythonPytestSelectionModes, run.selectionMode)) {
    throw new Error(`Unknown Python pytest capability selection mode: ${String(run.selectionMode)}`);
  }
  validateOptional(run.selectionDigest, (value) =>
    validateSha256Identity(value, "Python pytest capability run selectionDigest"),
  );
}

function validatePythonPytestCapabilityExecutionEvidence(run: PythonPytestValidationCapabilityRun): void {
  validateOptional(run.counts, validatePythonPytestCapabilityCounts);
  validateOptional(run.collection, (value) =>
    validatePythonPytestCapabilityInvocation(value, "Python pytest capability collection"),
  );
  validateOptional(run.execution, (value) =>
    validatePythonPytestCapabilityInvocation(value, "Python pytest capability execution"),
  );
  validateOptional(run.cleanup, validatePythonPytestCapabilityCleanupEvidence);
}

function validatePythonPytestCapabilityCounts(counts: PythonCapabilityCounts): void {
  if (!counts || typeof counts !== "object") throw new Error("Python pytest capability counts are required");
  validateExactObjectKeys(
    counts,
    [
      "candidateCount",
      "collectedCount",
      "executedCount",
      "passedCount",
      "failedCount",
      "skippedCount",
      "xfailedCount",
      "xpassedCount",
      "errorCount",
    ],
    "Python pytest capability counts",
  );
  for (const key of Object.keys(counts) as (keyof PythonCapabilityCounts)[]) {
    validateNonNegativeInteger(counts[key], `Python pytest capability counts ${key}`);
  }
}

export { validatePythonPytestCapabilityCounts };

function validatePythonPytestCapabilityInvocation(invocation: PythonCapabilityInvocation, label: string): void {
  validatePythonCapabilityInvocationWithDuration(
    invocation,
    label,
    (value, durationLabel) => validateNonNegativeNumber(value, durationLabel),
  );
}

export { validatePythonPytestCapabilityInvocation };

function validatePythonPytestCapabilityCleanupEvidence(cleanup: PythonCapabilityCleanupEvidence): void {
  if (!cleanup || typeof cleanup !== "object") throw new Error("Python pytest capability cleanup evidence is required");
  validateExactObjectKeys(cleanup, ["attempted", "ok", "failureMessage"], "Python pytest capability cleanup evidence");
  if (typeof cleanup.attempted !== "boolean")
    throw new Error("Python pytest capability cleanup attempted must be boolean");
  if (typeof cleanup.ok !== "boolean") throw new Error("Python pytest capability cleanup ok must be boolean");
  if (cleanup.failureMessage !== undefined) {
    validateNonEmptyString(cleanup.failureMessage, "Python pytest capability cleanup failureMessage");
  }
}

export { validatePythonPytestCapabilityCleanupEvidence };

function validatePythonValidationCapabilityTool(
  tool: PythonValidationCapabilityToolProvenance,
  run: PythonTypesValidationCapabilityRun,
): void {
  validateExactObjectKeys(
    tool,
    ["name", "executable", "argv", "cwd", "source", "version", "configFile"],
    "Python validation capability tool",
  );
  validateExactValue(tool.name, run.authority, "Python validation capability tool must match authority");
  validatePortablePythonCapabilityExecutable(tool.executable);
  validateStringArray(tool.argv, "Python validation capability tool argv", {
    allowEmpty: false,
  });
  validateExactValue(
    tool.argv[0],
    tool.executable,
    "Python validation capability tool argv must start with executable",
  );
  for (const argument of tool.argv) {
    if (containsHostAbsolutePath(argument)) {
      throw new Error("Python validation capability tool requires portable argv without host-absolute paths");
    }
  }
  validatePythonProjectRoot(tool.cwd, "Python validation capability tool cwd");
  validateExactValue(tool.cwd, run.projectRoot, "Python validation capability tool cwd must equal projectRoot");
  if (!includesString(pythonProjectExecutableSources, tool.source)) {
    throw new Error(`Unknown Python validation capability tool source: ${String(tool.source)}`);
  }
  validateOptional(tool.version, (version) => {
    validateNonEmptyString(tool.version, "Python validation capability tool version");
    if (!/^[0-9]+\.[0-9][-+._A-Za-z0-9]*$/u.test(version)) {
      throw new Error("Python validation capability tool version must be exact version provenance");
    }
  });
  validateOptional(tool.configFile, (configFile) => {
    validateRepoRelativePath(configFile);
    if (!run.selectedConfigPaths.includes(configFile)) {
      throw new Error("Python validation capability tool configFile must be a selected config path");
    }
  });
}

export { validatePythonValidationCapabilityTool };
