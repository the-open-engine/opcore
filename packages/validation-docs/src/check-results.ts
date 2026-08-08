import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";

export function skippedDocsResult(message: string): ValidationCheckResult {
  return {
    status: "skipped",
    diagnostics: [],
    failureMessage: message
  };
}

export function skippedHistoryUnavailableResult(message: string): ValidationCheckResult {
  return skippedDocsResult(
    message.startsWith("Git history is unavailable")
      ? message
      : `Git history is unavailable: ${message}`
  );
}
