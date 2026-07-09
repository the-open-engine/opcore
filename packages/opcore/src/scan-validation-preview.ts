import type { ValidationResult } from "@the-open-engine/opcore-contracts";

export const scanDiagnosticPreviewLimit = 50;

const fullDiagnosticsCommand = "opcore check --all --json";

export function compactScanValidationResult(
  result: ValidationResult,
  maxDiagnostics = scanDiagnosticPreviewLimit
): ValidationResult {
  const compact: ValidationResult = {
    ok: result.ok,
    status: result.status,
    diagnostics: result.diagnostics.slice(0, maxDiagnostics)
  };
  if (result.graphStatus !== undefined) compact.graphStatus = result.graphStatus;
  if (result.failure !== undefined) compact.failure = result.failure;
  if (result.refusal !== undefined) compact.refusal = result.refusal;
  if (result.manifest !== undefined) {
    compact.manifest = {
      schemaVersion: result.manifest.schemaVersion,
      checks: [...result.manifest.checks],
      generatedAt: result.manifest.generatedAt
    };
    if (result.manifest.durationMs !== undefined) compact.manifest.durationMs = result.manifest.durationMs;
    if (result.manifest.runs !== undefined) compact.manifest.runs = [...result.manifest.runs];
    if (result.manifest.skippedChecks !== undefined) compact.manifest.skippedChecks = [...result.manifest.skippedChecks];
  }
  return compact;
}

export function scanValidationDiagnosticTotal(result: ValidationResult): number {
  const runCounts = (result.manifest?.runs ?? [])
    .map((run) => run.diagnosticCount)
    .filter((count): count is number => count !== undefined);
  if (runCounts.length === 0) return result.diagnostics.length;
  return runCounts.reduce((total, count) => total + count, 0);
}

export function scanValidationPreviewCount(result: ValidationResult): number {
  return result.diagnostics.length;
}

export function scanValidationDiagnosticsTruncated(result: ValidationResult): boolean {
  return scanValidationDiagnosticTotal(result) > scanValidationPreviewCount(result);
}

export function scanValidationTruncationMessage(): string {
  return `showing first ${scanDiagnosticPreviewLimit} diagnostics; run ${fullDiagnosticsCommand} for full diagnostics`;
}
