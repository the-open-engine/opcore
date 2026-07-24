import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { diagnostic } from "./diagnostics.js";

export function missingPythonProjectContextResult(
  code: string,
  missing: readonly string[]
): ValidationCheckResult {
  const suffix = missing.length === 0 ? "" : `: ${missing.join(", ")}`;
  const message = `Canonical Python project context resolution returned no context for selected source${suffix}`;
  return {
    outcome: "tool_failure",
    failureMessage: message,
    diagnostics: [diagnostic({
      category: "infrastructure",
      code,
      message
    })]
  };
}
