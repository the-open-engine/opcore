import {
  createBuiltInValidationChecks,
  validationChecksForRepoPolicy as validationChecksForSharedRepoPolicy,
  validationChecksForRepoPolicyAndCoverage as validationChecksForSharedRepoPolicyAndCoverage
} from "@the-open-engine/opcore-validation-policy";
import { invokeCloneAnalysis } from "./clone-invoker.js";

const opcoreValidationPolicyOptions = {
  clone: {
    invoke: invokeCloneAnalysis
  }
} as const;

export const defaultValidationChecks = createBuiltInValidationChecks(undefined, opcoreValidationPolicyOptions);

export function validationChecksForRepoPolicy(repoRoot: string) {
  return validationChecksForSharedRepoPolicy(repoRoot, opcoreValidationPolicyOptions);
}

export function validationChecksForRepoPolicyAndCoverage(repoRoot: string, adapters: ReadonlySet<string>) {
  return validationChecksForSharedRepoPolicyAndCoverage(repoRoot, adapters, opcoreValidationPolicyOptions);
}
