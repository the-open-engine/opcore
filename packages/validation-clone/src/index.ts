import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import {
  createCloneDuplicationCheck,
  type CreateCloneDuplicationCheckOptions
} from "./clone-check.js";

export {
  CLONE_DUPLICATION_CHECK_ID,
  cloneValidationCheckIds,
  type CloneValidationCheckId
} from "./check-ids.js";
export { validationCloneAdapterName } from "./check-constants.js";
export {
  createCloneDuplicationCheck,
  type CloneNativeInvoker,
  type CreateCloneDuplicationCheckOptions
} from "./clone-check.js";
export { isCloneSourcePath } from "./source-files.js";

export interface CreateCloneValidationChecksOptions extends CreateCloneDuplicationCheckOptions {}

export function createCloneValidationChecks(
  options: CreateCloneValidationChecksOptions = {}
): readonly ValidationCheckDefinition[] {
  return [createCloneDuplicationCheck(options)];
}
