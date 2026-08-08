import { includesString } from "../shared/primitives.js";
import { validateNonEmptyString } from "../shared/validators-01.js";
import { inspectFailureCategories } from "./contracts-01.js";
import type { InspectRouteFailure } from "./contracts-02.js";
import { validateInspectSymbolTarget } from "./helper-validators-01.js";

function validateInspectRouteFailure(failure: InspectRouteFailure): InspectRouteFailure {
  if (!failure || typeof failure !== "object") throw new Error("Inspect route failure is required");
  if (!includesString(inspectFailureCategories, failure.category)) {
    throw new Error(`Unknown inspect route failure category: ${String(failure.category)}`);
  }
  validateNonEmptyString(failure.message, "Inspect route failure message");
  if (failure.candidates !== undefined) {
    if (!Array.isArray(failure.candidates)) throw new Error("Inspect route failure candidates must be an array");
    for (const candidate of failure.candidates)
      validateInspectSymbolTarget(candidate, "Inspect route failure candidate");
  }
  return failure;
}

export { validateInspectRouteFailure };
