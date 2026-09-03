import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";

export function appendPythonCapabilityRuns(
  result: ValidationCheckResult,
  priorRuns: NonNullable<ValidationCheckResult["pythonCapabilityRuns"]>
): ValidationCheckResult {
  if (priorRuns.length === 0) return result;
  return {
    ...result,
    pythonCapabilityRuns: [...priorRuns, ...(result.pythonCapabilityRuns ?? [])]
  };
}
