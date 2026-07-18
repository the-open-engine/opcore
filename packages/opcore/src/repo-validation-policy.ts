import {
  createBuiltInValidationChecks,
  validationChecksForRepoPolicy as validationChecksForSharedRepoPolicy,
  validationChecksForRepoPolicyAndCoverage as validationChecksForSharedRepoPolicyAndCoverage
} from "@the-open-engine/opcore-validation-policy";
import { graphPythonImportAnalyzer } from "@the-open-engine/opcore-graph";
import { invokeCloneAnalysis } from "./clone-invoker.js";
import { createNodePythonProjectWorkspace } from "@the-open-engine/opcore-validation-python";

const opcoreValidationPolicyOptions = {
  pythonImportAnalyzer: graphPythonImportAnalyzer,
  clone: {
    invoke: invokeCloneAnalysis
  }
} as const;

export const defaultValidationChecks = createBuiltInValidationChecks(undefined, opcoreValidationPolicyOptions);

export function validationChecksForRepoPolicy(repoRoot: string) {
  return validationChecksForSharedRepoPolicy(repoRoot, {
    ...opcoreValidationPolicyOptions,
    pythonWorkspace: createNodePythonProjectWorkspace(repoRoot)
  });
}

export function validationChecksForRepoPolicyAndCoverage(repoRoot: string, adapters: ReadonlySet<string>) {
  return validationChecksForSharedRepoPolicyAndCoverage(repoRoot, adapters, {
    ...opcoreValidationPolicyOptions,
    pythonWorkspace: createNodePythonProjectWorkspace(repoRoot)
  });
}
