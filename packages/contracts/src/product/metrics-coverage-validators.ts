import { validateRequiredObject } from "../shared/validators-02.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateStringArray,
} from "../shared/validators-01.js";
import { validateOpcoreCoverageCounts } from "./metrics-validators-05.js";
import type { OpcoreRepoStatePayload } from "./status-contracts.js";

function validateOpcoreMetricCoverage(coverage: OpcoreRepoStatePayload["coverage"], label: string): void {
  validateRequiredObject(coverage, `${label} is required`);
  validateNonNegativeInteger(coverage.totalFiles, `${label} totalFiles`);
  validateOpcoreCoverageLanguages(coverage.languages, label);
  validateOpcoreCoverageCounts(coverage.graph, "graph");
  validateOpcoreCoverageCounts(coverage.validation, "validation");
  validateNonNegativeInteger(coverage.validation.retainedFiles, `${label} validation retainedFiles`);
  validateOpcoreUnsupportedSection(coverage.unsupported, label);
}

export { validateOpcoreMetricCoverage };

function validateOpcoreCoverageLanguages(
  languages: OpcoreRepoStatePayload["coverage"]["languages"],
  label: string,
): void {
  if (!Array.isArray(languages)) {
    throw new Error(`${label} languages must be an array`);
  }
  for (const language of languages) {
    validateNonEmptyString(language.language, `${label} language`);
    validateNonNegativeInteger(language.files, `${label} language files`);
    if (typeof language.graphSupported !== "boolean" || typeof language.validationSupported !== "boolean") {
      throw new Error(`${label} language support flags must be boolean`);
    }
  }
}

export { validateOpcoreCoverageLanguages };

function validateOpcoreUnsupportedSection(
  unsupported: OpcoreRepoStatePayload["coverage"]["unsupported"],
  label: string,
): void {
  validateRequiredObject(unsupported, `${label} unsupported is required`);
  validateNonNegativeInteger(unsupported.totalFiles, `${label} unsupported totalFiles`);
  validateOpcoreUnsupportedStacks(unsupported.stacks, label);
}

export { validateOpcoreUnsupportedSection };

function validateOpcoreUnsupportedStacks(
  stacks: OpcoreRepoStatePayload["coverage"]["unsupported"]["stacks"],
  label: string,
): void {
  if (!Array.isArray(stacks)) {
    throw new Error(`${label} unsupported stacks must be an array`);
  }
  for (const stack of stacks) {
    validateNonEmptyString(stack.extension, `${label} unsupported extension`);
    validateNonEmptyString(stack.language, `${label} unsupported language`);
    validateNonNegativeInteger(stack.count, `${label} unsupported count`);
    validateStringArray(stack.examples, `${label} unsupported examples`, {
      allowEmpty: true,
    });
  }
}

export { validateOpcoreUnsupportedStacks };
