import type {
  OpcoreRepoStatePayload,
  ValidationCheckRunStatus,
  ValidationCheckRunSummary,
  ValidationResult
} from "@the-open-engine/opcore-contracts";

type Coverage = OpcoreRepoStatePayload["coverage"];
type DegradedToolchain = OpcoreRepoStatePayload["validation"]["degradedToolchains"][number];

const failingRunStatuses = new Set<ValidationCheckRunStatus>([
  "policy_failure",
  "infrastructure_failure",
  "provider_failure",
  "unsupported_request"
]);

const typeScriptValidationKinds = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const rustActiveValidationKinds = new Set([".rs", ".inc", "Cargo.toml"]);
const pythonValidationKinds = new Set([".py", ".pyi"]);
const cloneValidationKinds = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".pyi", ".rs"]);

export const SCAN_DIAGNOSTIC_PREVIEW_LIMIT = 50;

export function failedValidationRuns(validationResult: ValidationResult): readonly ValidationCheckRunSummary[] {
  return (validationResult.manifest?.runs ?? []).filter((run) => isFailedValidationRunStatus(run.status));
}

export function failedValidationCheckIds(validationResult: ValidationResult): readonly string[] {
  return failedValidationRuns(validationResult).map((run) => run.checkId);
}

export function isFailedValidationRunStatus(status: ValidationCheckRunStatus): boolean {
  return failingRunStatuses.has(status);
}

export function activeValidationAdaptersForCoverage(coverage: Coverage): ReadonlySet<string> {
  const kinds = new Set(coverage.validation.extensions.map((entry) => entry.extension));
  const adapters = new Set<string>();
  if (hasAny(kinds, typeScriptValidationKinds)) adapters.add("typescript");
  if (hasAny(kinds, rustActiveValidationKinds)) adapters.add("rust");
  if (hasAny(kinds, pythonValidationKinds)) adapters.add("python");
  if (hasAny(kinds, cloneValidationKinds)) adapters.add("clone");
  return adapters;
}

export function relevantDegradedToolchainsForCoverage(
  coverage: Coverage,
  toolchains: readonly DegradedToolchain[]
): readonly DegradedToolchain[] {
  const activeAdapters = activeValidationAdaptersForCoverage(coverage);
  return toolchains.filter((tool) => activeAdapters.has(tool.adapter));
}

export function validationDiagnosticTotal(validationResult: ValidationResult): number {
  const runTotal = (validationResult.manifest?.runs ?? []).reduce(
    (total, run) => total + (run.diagnosticCount ?? 0),
    0
  );
  return Math.max(runTotal, validationResult.diagnostics.length);
}

export function isScanValidationResultTruncated(validationResult: ValidationResult): boolean {
  return validationDiagnosticTotal(validationResult) > validationResult.diagnostics.length;
}

function hasAny(values: ReadonlySet<string>, candidates: ReadonlySet<string>): boolean {
  for (const candidate of candidates) {
    if (values.has(candidate)) return true;
  }
  return false;
}
