import {
  collectStrings,
  sameStringArray,
  validateRequiredObject,
} from "./primitives.js";
import type { CommandExitSemantics } from "../command/contracts.js";
import type { CommandRouteStatus } from "../command/vocabulary.js";
import type { GraphFreshness } from "../graph/provider-contracts-01.js";
import type { ReleaseReceiptPackageEvidence } from "../release/receipt-contracts-01.js";
import type { ReleaseReceiptPackageName } from "../release/vocabulary-01.js";
import { validationCheckIdRegex } from "../validation/vocabulary-02.js";

function packageEvidenceIncludesFile(
  packages: readonly ReleaseReceiptPackageEvidence[],
  packageName: ReleaseReceiptPackageName,
  path: string,
): boolean {
  return packages.find((entry) => entry.packageName === packageName)?.files.includes(path) ?? false;
}

export { packageEvidenceIncludesFile };

function validateSha256(value: unknown, label: string): string {
  const text = validateNonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error(`${label} must be a sha256 hex digest`);
  return text;
}

export { validateSha256 };

function validateExactStringSet(actual: readonly string[], expected: readonly string[], label: string): void {
  validateStringArray(actual, label, { allowEmpty: false });
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw new Error(`${label} must exactly match ${expected.join(", ")}`);
  }
}

export { validateExactStringSet };

function validateExactStringSequence(actual: readonly string[], expected: readonly string[], label: string): void {
  validateStringArray(actual, label, { allowEmpty: false });
  if (!sameStringArray(actual, expected)) {
    throw new Error(`${label} must exactly match ${expected.join(" ")}`);
  }
}

export { validateExactStringSequence };

function validateGraphReleaseSourceFreeStrings(value: unknown): void {
  const forbidden = [/tirth8205/i, /pyproject\.toml/i, /setup\.py/i, /setup\.cfg/i, /Pipfile/i, /git clone/i];
  for (const text of collectStrings(value)) {
    const pattern = forbidden.find((entry) => entry.test(text));
    if (pattern) throw new Error(`Graph release receipt contains forbidden source provenance: ${text}`);
  }
}

export { validateGraphReleaseSourceFreeStrings };

function validateCommandExitSemantics(exitSemantics: CommandExitSemantics): CommandExitSemantics {
  validateRequiredObject(exitSemantics, "Command router manifest must include exitSemantics");
  if (exitSemantics.ok !== 0) throw new Error("Command exit semantics ok must be 0");
  if (exitSemantics.error !== 1) throw new Error("Command exit semantics error must be 1");
  if (exitSemantics.notImplemented !== 2) throw new Error("Command exit semantics notImplemented must be 2");
  if (exitSemantics.unsupported !== 64) throw new Error("Command exit semantics unsupported must be 64");
  if (typeof exitSemantics.jsonStable !== "boolean") {
    throw new Error("Command exit semantics jsonStable must be boolean");
  }
  return exitSemantics;
}

export { validateCommandExitSemantics };

function validateExitCodeForStatus(exitCode: unknown, status: CommandRouteStatus): number {
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0) {
    throw new Error("Command route exitCode must be a non-negative integer");
  }
  const expected = {
    ok: { code: 0, message: "Command route ok status must use exitCode 0" },
    error: { code: 1, message: "Command route error status must use exitCode 1" },
    not_implemented: {
      code: 2,
      message: "Command route not_implemented status must use exitCode 2",
    },
    unsupported: { code: 64, message: "Command route unsupported status must use exitCode 64" },
  }[status];
  if (exitCode !== expected.code) throw new Error(expected.message);
  return exitCode;
}

export { validateExitCodeForStatus };

function validateStringArray(
  values: readonly string[] | undefined,
  label: string,
  options: { allowEmpty: boolean; allowEmptyValues?: boolean },
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }
  if (!options.allowEmpty && values.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  for (const value of values) {
    if (options.allowEmptyValues === true) {
      if (typeof value !== "string") throw new Error(`${label} must contain only strings`);
    } else {
      validateNonEmptyString(value, label);
    }
  }
  return values;
}

export { validateStringArray };

function validateValidationChecks(checks: readonly string[], label: string): readonly string[] {
  validateStringArray(checks, label, { allowEmpty: true });
  for (const check of checks) {
    if (check.trim().length === 0) {
      throw new Error(`${label} entries must include non-whitespace content`);
    }
    validateValidationCheckId(check, `${label} entry`);
  }
  return checks;
}

export { validateValidationChecks };

function validateValidationCheckId(checkId: unknown, label: string): string {
  const value = validateNonEmptyString(checkId, label);
  if (!validationCheckIdRegex.test(value)) {
    throw new Error(`${label} must be a stable validation check id`);
  }
  return value;
}

export { validateValidationCheckId };

function validateNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

export { validateNonNegativeNumber };

function validateNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

export { validateNonNegativeInteger };

function validatePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

export { validatePositiveInteger };

function validateNonEmptyArray(values: readonly unknown[] | undefined, label: string): readonly unknown[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return values;
}

export { validateNonEmptyArray };

function validateNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export { validateNonEmptyString };

function validateGraphFreshness(freshness: GraphFreshness | undefined, label: string): GraphFreshness {
  validateRequiredObject(freshness, `${label} graph provider status must include freshness`);
  if (typeof freshness.generatedAt !== "string" || freshness.generatedAt.length === 0) {
    throw new Error(`${label} graph provider freshness must include generatedAt`);
  }
  if (typeof freshness.ageMs !== "number") {
    throw new Error(`${label} graph provider freshness must include numeric ageMs`);
  }
  if (typeof freshness.stale !== "boolean") {
    throw new Error(`${label} graph provider freshness must include stale`);
  }
  return freshness;
}

export { validateGraphFreshness };
