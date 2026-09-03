import { validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString, validatePositiveInteger, validateStringArray } from "../shared/validators-01.js";
import { pythonProjectExecutableSources } from "./python-project-contracts-01.js";
import type {
  PythonInterpreterProvenance,
  PythonProjectExecutableProvenance,
  PythonProjectTarget,
} from "./python-project-contracts-02.js";
import {
  validateContextDocFilename,
  validateContextDocRequiredPath,
  validateExactObjectKeys,
} from "./python-validator-primitives.js";
import type { RequiredContextDocPolicy } from "./status-contracts.js";

function validatePythonProjectTarget(target: PythonProjectTarget): void {
  if (!target || typeof target !== "object") throw new Error("Python project targetRuntime is required");
  validateExactObjectKeys(
    target,
    ["requiresPython", "version", "platform", "implementation", "conflicts"],
    "Python project targetRuntime",
  );
  for (const [key, value] of Object.entries(target)) {
    if (key === "conflicts") continue;
    if (value !== undefined) validateNonEmptyString(value, `Python project targetRuntime ${key}`);
  }
  validateStringArray(target.conflicts, "Python project targetRuntime conflicts", { allowEmpty: true });
}

export { validatePythonProjectTarget };

function validatePythonExecutableProvenance(value: PythonProjectExecutableProvenance, label: string): void {
  if (!value || typeof value !== "object") throw new Error(`${label} provenance is required`);
  validateNonEmptyString(value.executable, `${label} executable`);
  validateStringArray(value.argv, `${label} argv`, { allowEmpty: false });
  if (value.argv[0] !== value.executable) throw new Error(`${label} argv must start with executable`);
  validateNonEmptyString(value.cwd, `${label} cwd`);
  if (!includesString(pythonProjectExecutableSources, value.source))
    throw new Error(`Unknown ${label} source: ${String(value.source)}`);
  if (value.version !== undefined) {
    validateNonEmptyString(value.version, `${label} version`);
    if (!/^[0-9]+\.[0-9][-+._A-Za-z0-9]*$/u.test(value.version)) {
      throw new Error(`${label} version must be exact version provenance`);
    }
  }
  if (value.configFile !== undefined) validateRepoRelativePath(value.configFile);
}

export { validatePythonExecutableProvenance };

function validatePythonInterpreterProvenance(value: PythonInterpreterProvenance): void {
  validateExactObjectKeys(
    value,
    [
      "executable",
      "argv",
      "cwd",
      "source",
      "version",
      "configFile",
      "implementation",
      "platform",
      "architecture",
      "abi",
      "soabi",
    ],
    "Python interpreter provenance",
  );
  validatePythonExecutableProvenance(value, "Python interpreter");
  if (!/^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?(?:\+[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)?$/u.test(value.version)) {
    throw new Error("Python interpreter version must be an exact Python version");
  }
  for (const [key, field] of [
    ["implementation", value.implementation],
    ["platform", value.platform],
    ["architecture", value.architecture],
    ["abi", value.abi],
    ["soabi", value.soabi],
  ] as const) {
    validateNonEmptyString(field, `Python interpreter ${key}`);
  }
}

export { validatePythonInterpreterProvenance };

function validatePythonProjectRoot(value: string, label: string): void {
  validateNonEmptyString(label, "Python project root label");
  if (value === ".") return;
  validateRepoRelativePath(value);
}

export { validatePythonProjectRoot };

function validatePythonProjectRoots(values: readonly string[], label: string): void {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be a non-empty array`);
  for (const value of values) validatePythonProjectRoot(value, label);
}

export { validatePythonProjectRoots };

function validateRepoPathArray(values: readonly string[], label: string): void {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  for (const value of values) validateRepoRelativePath(value);
}

export { validateRepoPathArray };

function validateExactEnumArray<T extends string>(
  values: readonly T[],
  allowed: readonly T[],
  label: string,
  requireAll: boolean,
): void {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be a non-empty array`);
  const seen = new Set<string>();
  for (const value of values) {
    if (!includesString(allowed, value)) throw new Error(`Unknown ${label} value: ${String(value)}`);
    if (seen.has(value)) throw new Error(`${label} must not contain duplicates`);
    seen.add(value);
  }
  if (requireAll && seen.size !== allowed.length) throw new Error(`${label} must contain every supported value`);
}

export { validateExactEnumArray };

function validateSha256Identity(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a sha256 identity`);
}

export { validateSha256Identity };

function validateRequiredContextDocPolicy(policy: RequiredContextDocPolicy): RequiredContextDocPolicy {
  validateRequiredObject(policy, "Required context doc policy is required");
  validateStringArray(policy.filenames, "Required context doc policy filenames", { allowEmpty: false });
  for (const filename of policy.filenames) validateContextDocFilename(filename);
  validateStringArray(policy.requiredPaths, "Required context doc policy requiredPaths", { allowEmpty: false });
  for (const path of policy.requiredPaths) validateContextDocRequiredPath(path);
  if (policy.requireRoot !== undefined && typeof policy.requireRoot !== "boolean") {
    throw new Error("Required context doc policy requireRoot must be boolean");
  }
  if (!Number.isInteger(policy.minimumContentLength) || policy.minimumContentLength < 1) {
    throw new Error("Required context doc policy minimumContentLength must be a positive integer");
  }
  if (policy.maxLines !== undefined) validatePositiveInteger(policy.maxLines, "Required context doc policy maxLines");
  if (policy.maxSectionLines !== undefined) {
    validatePositiveInteger(policy.maxSectionLines, "Required context doc policy maxSectionLines");
  }
  return policy;
}

export { validateRequiredContextDocPolicy };
