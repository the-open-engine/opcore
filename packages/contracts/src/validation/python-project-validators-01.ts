import { includesString } from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString, validateNonNegativeInteger, validateStringArray } from "../shared/validators-01.js";
import { validateArray, validateObject, validateOptional } from "../shared/validators-02.js";
import type {
  PythonCapabilityCleanupEvidence,
  PythonCapabilityCounts,
  PythonCapabilityInvocation} from "./capability-contracts.js";
import {
  pythonCapabilityProcessTerminations,
  pythonPytestSelectionModes,
} from "./capability-contracts.js";
import {
  PYTHON_PROJECT_CONTEXT_SCHEMA_ID,
  pythonProjectContextOutcomes,
  pythonProjectContextReasonCodes,
  pythonProjectLayoutKinds,
  pythonProjectManagerKinds,
  pythonProjectToolKinds,
} from "./python-project-contracts-01.js";
import type { PythonProjectContext } from "./python-project-contracts-02.js";
import { validateExactObjectKeys } from "./python-validator-primitives.js";
import {
  validateExactEnumArray,
  validatePythonExecutableProvenance,
  validatePythonInterpreterProvenance,
  validatePythonProjectRoot,
  validatePythonProjectRoots,
  validatePythonProjectTarget,
  validateRepoPathArray,
  validateSha256Identity,
} from "./python-project-validators-02.js";

function validatePythonProjectContext(context: PythonProjectContext): PythonProjectContext {
  validateObject(context, "Python project context");
  validatePythonProjectContextIdentity(context);
  validatePythonProjectLayout(context);
  validatePythonProjectEvidence(context);
  validatePythonProjectTarget(context.targetRuntime);
  validatePythonProjectManagers(context.managers);
  validateOptional(context.buildSystem, validatePythonProjectBuildSystem);
  validateOptional(context.interpreter, validatePythonInterpreterProvenance);
  validatePythonProjectTools(context.tools);
  validatePythonProjectOutcome(context);
  return context;
}

export { validatePythonProjectContext };

function validatePythonProjectContextIdentity(context: PythonProjectContext): void {
  validateExactObjectKeys(
    context,
    [
      "schemaId",
      "schemaVersion",
      "target",
      "repositoryRoot",
      "projectRoot",
      "projectBoundary",
      "sourceRoots",
      "layout",
      "evidence",
      "targetRuntime",
      "managers",
      "buildSystem",
      "interpreter",
      "tools",
      "projectKey",
      "contextFingerprint",
      "outcome",
      "reasons",
    ],
    "Python project context",
  );
  if (context.schemaId !== PYTHON_PROJECT_CONTEXT_SCHEMA_ID) {
    throw new Error(`Python project context schemaId must be ${PYTHON_PROJECT_CONTEXT_SCHEMA_ID}`);
  }
  if (context.schemaVersion !== 1) throw new Error("Python project context schemaVersion must be 1");
  validateRepoRelativePath(context.target);
  if (!/\.pyi?$/u.test(context.target)) throw new Error("Python project context target must be a .py or .pyi path");
  validateNonEmptyString(context.repositoryRoot, "Python project context repositoryRoot");
  validatePythonProjectRoot(context.projectRoot, "Python project context projectRoot");
  validatePythonProjectRoot(context.projectBoundary, "Python project context projectBoundary");
  validatePythonProjectRoots(context.sourceRoots, "Python project context sourceRoots");
}

export { validatePythonProjectContextIdentity };

function validatePythonProjectLayout(context: PythonProjectContext): void {
  validateObject(context.layout, "Python project context layout");
  validateExactObjectKeys(context.layout, ["kinds", "paths"], "Python project context layout");
  validateExactEnumArray(context.layout.kinds, pythonProjectLayoutKinds, "Python project context layout kinds", false);
  validatePythonProjectRoots(context.layout.paths, "Python project context layout paths");
}

export { validatePythonProjectLayout };

function validatePythonProjectEvidence(context: PythonProjectContext): void {
  validateArray(context.evidence, "Python project context evidence");
  for (const entry of context.evidence) {
    validateExactObjectKeys(entry, ["path", "role"], "Python project context evidence");
    validateRepoRelativePath(entry.path);
    if (!includesString(["boundary", "config", "lock", "requirements", "build", "layout"] as const, entry.role)) {
      throw new Error(`Unknown Python project evidence role: ${String(entry.role)}`);
    }
  }
}

export { validatePythonProjectEvidence };

function validatePythonProjectManagers(managers: PythonProjectContext["managers"]): void {
  validateArray(managers, "Python project context managers");
  for (const manager of managers) {
    validateExactObjectKeys(manager, ["kind", "configFiles", "lockFiles"], "Python project manager evidence");
    if (!includesString(pythonProjectManagerKinds, manager.kind)) {
      throw new Error(`Unknown Python project manager kind: ${String(manager.kind)}`);
    }
    validateRepoPathArray(manager.configFiles, "Python project manager configFiles");
    validateRepoPathArray(manager.lockFiles, "Python project manager lockFiles");
  }
}

export { validatePythonProjectManagers };

function validatePythonProjectBuildSystem(buildSystem: NonNullable<PythonProjectContext["buildSystem"]>): void {
  validateExactObjectKeys(buildSystem, ["configFile", "backend", "requires"], "Python project buildSystem");
  validateRepoRelativePath(buildSystem.configFile);
  validateOptional(buildSystem.backend, (backend) =>
    validateNonEmptyString(backend, "Python project buildSystem backend"),
  );
  validateStringArray(buildSystem.requires, "Python project buildSystem requires", { allowEmpty: true });
}

export { validatePythonProjectBuildSystem };

function validatePythonProjectTools(tools: PythonProjectContext["tools"]): void {
  validateArray(tools, "Python project context tools");
  for (const tool of tools) {
    validateExactObjectKeys(
      tool,
      ["tool", "available", "executable", "argv", "cwd", "source", "version", "configFile"],
      "Python project tool provenance",
    );
    if (!includesString(pythonProjectToolKinds, tool.tool))
      throw new Error(`Unknown Python project tool: ${String(tool.tool)}`);
    if (typeof tool.available !== "boolean") throw new Error("Python project tool available must be boolean");
    validatePythonExecutableProvenance(tool, `Python project tool ${tool.tool}`);
    if (tool.available && tool.version === undefined) {
      throw new Error(`Available Python project tool ${tool.tool} must include version provenance`);
    }
  }
}

export { validatePythonProjectTools };

function validatePythonProjectOutcome(context: PythonProjectContext): void {
  validateSha256Identity(context.projectKey, "Python project context projectKey");
  validateSha256Identity(context.contextFingerprint, "Python project context contextFingerprint");
  if (!includesString(pythonProjectContextOutcomes, context.outcome)) {
    throw new Error(`Unknown Python project context outcome: ${String(context.outcome)}`);
  }
  validateArray(context.reasons, "Python project context reasons");
  for (const reason of context.reasons) {
    validateExactObjectKeys(reason, ["code", "message", "path", "tool"], "Python project context reason");
    if (!includesString(pythonProjectContextReasonCodes, reason.code)) {
      throw new Error(`Unknown Python project context reason: ${String(reason.code)}`);
    }
    validateNonEmptyString(reason.message, "Python project context reason message");
    validateOptional(reason.path, validateRepoRelativePath);
    validateOptional(reason.tool, (tool) => validateNonEmptyString(tool, "Python project context reason tool"));
  }
  if (context.outcome === "resolved" && context.reasons.length > 0) {
    throw new Error("Resolved Python project context must not include reasons");
  }
  if (context.outcome !== "resolved" && context.reasons.length === 0) {
    throw new Error("Non-resolved Python project context must include reasons");
  }
}

export { validatePythonProjectOutcome };

function validatePythonProjectContexts(contexts: readonly PythonProjectContext[]): readonly PythonProjectContext[] {
  if (!Array.isArray(contexts)) throw new Error("Python project contexts must be an array");
  const targets = new Set<string>();
  for (const context of contexts) {
    validatePythonProjectContext(context);
    if (targets.has(context.target)) throw new Error(`Duplicate Python project context target: ${context.target}`);
    targets.add(context.target);
  }
  return contexts;
}

export { validatePythonProjectContexts };

function validatePythonCapabilityCounts(counts: PythonCapabilityCounts): void {
  if (!counts || typeof counts !== "object") throw new Error("Python capability counts are required");
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
    "Python capability counts",
  );
  for (const key of Object.keys(counts) as (keyof PythonCapabilityCounts)[]) {
    validateNonNegativeInteger(counts[key], `Python capability counts ${key}`);
  }
}

export { validatePythonCapabilityCounts };

function validatePythonCapabilityCleanupEvidence(cleanup: PythonCapabilityCleanupEvidence): void {
  if (!cleanup || typeof cleanup !== "object") throw new Error("Python capability cleanup evidence is required");
  validateExactObjectKeys(cleanup, ["attempted", "ok", "failureMessage"], "Python capability cleanup evidence");
  if (typeof cleanup.attempted !== "boolean") throw new Error("Python capability cleanup attempted must be boolean");
  if (typeof cleanup.ok !== "boolean") throw new Error("Python capability cleanup ok must be boolean");
  if (cleanup.failureMessage !== undefined) {
    validateNonEmptyString(cleanup.failureMessage, "Python capability cleanup failureMessage");
  }
}

export { validatePythonCapabilityCleanupEvidence };

function validatePythonCapabilityInvocation(invocation: PythonCapabilityInvocation, label: string): void {
  validatePythonCapabilityInvocationWithDuration(
    invocation,
    label,
    (value, durationLabel) => validateNonNegativeInteger(value, durationLabel),
  );
}

export { validatePythonCapabilityInvocation };

type PythonCapabilityDurationValidator = (value: unknown, label: string) => number;

function validatePythonCapabilityInvocationWithDuration(
  invocation: PythonCapabilityInvocation,
  label: string,
  validateDuration: PythonCapabilityDurationValidator,
): void {
  if (!invocation || typeof invocation !== "object") throw new Error(`${label} is required`);
  validateExactObjectKeys(
    invocation,
    [
      "stage",
      "command",
      "argsDigest",
      "argCount",
      "selectionMode",
      "selectionDigest",
      "durationMs",
      "termination",
      "exitCode",
      "signal",
      "outputBytes",
      "stdoutDigest",
      "stderrDigest",
    ],
    label,
  );
  if (!includesString(["collection", "execution"] as const, invocation.stage)) {
    throw new Error(`${label} stage must be collection or execution`);
  }
  validateNonEmptyString(invocation.command, `${label} command`);
  validateSha256Identity(invocation.argsDigest, `${label} argsDigest`);
  validateNonNegativeInteger(invocation.argCount, `${label} argCount`);
  if (!includesString(pythonPytestSelectionModes, invocation.selectionMode)) {
    throw new Error(`Unknown ${label} selectionMode: ${String(invocation.selectionMode)}`);
  }
  validateOptional(invocation.selectionDigest, (value) =>
    validateSha256Identity(value, `${label} selectionDigest`),
  );
  validateDuration(invocation.durationMs, `${label} durationMs`);
  if (!includesString(pythonCapabilityProcessTerminations, invocation.termination)) {
    throw new Error(`Unknown ${label} termination: ${String(invocation.termination)}`);
  }
  validateOptional(invocation.exitCode, (value) => validateNonNegativeInteger(value, `${label} exitCode`));
  validateOptional(invocation.signal, (value) => validateNonEmptyString(value, `${label} signal`));
  validateNonNegativeInteger(invocation.outputBytes, `${label} outputBytes`);
  validateOptional(invocation.stdoutDigest, (value) =>
    validateSha256Identity(value, `${label} stdoutDigest`),
  );
  validateOptional(invocation.stderrDigest, (value) =>
    validateSha256Identity(value, `${label} stderrDigest`),
  );
}

export { validatePythonCapabilityInvocationWithDuration };
