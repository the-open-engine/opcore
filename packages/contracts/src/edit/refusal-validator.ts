import { includesString, validateRequiredObject } from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString } from "../shared/validators-01.js";
import type { EditRefusal } from "./contracts.js";
import { editRefusalCategories } from "./vocabulary.js";

function validateEditRefusal(refusal: EditRefusal): EditRefusal {
  validateRequiredObject(refusal, "Edit refusal is required");
  if (!includesString(editRefusalCategories, refusal.category)) {
    throw new Error(`Unknown edit refusal category: ${String(refusal.category)}`);
  }
  validateNonEmptyString(refusal.message, "Edit refusal message");
  if (refusal.path !== undefined) validateRepoRelativePath(refusal.path);
  return refusal;
}

export { validateEditRefusal };
