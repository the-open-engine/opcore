import type {
  EditRefusal,
  GraphProviderStatus,
  ValidationCheckManifestEntry,
  ValidationCheckRunStatus,
  ValidationCheckRunSummary,
  ValidationDiagnostic,
  ValidationFailure,
  ValidationResult,
  ValidationResultManifest,
  ValidationResultStatus,
  ValidationSkippedCheck
} from "@the-open-engine/lattice-contracts";
import { GRAPH_SCHEMA_VERSION, validateValidationResultPayload } from "@the-open-engine/lattice-contracts";

export interface CreateValidationManifestArgs {
  checks: readonly string[];
  generatedAt: string;
  durationMs?: number;
  entries?: readonly ValidationCheckManifestEntry[];
  runs?: readonly ValidationCheckRunSummary[];
  skippedChecks?: readonly ValidationSkippedCheck[];
}

export interface AggregateValidationResultsArgs extends CreateValidationManifestArgs {
  diagnostics?: readonly ValidationDiagnostic[];
  graphStatus?: GraphProviderStatus;
  status?: ValidationResultStatus;
  failure?: ValidationFailure;
  refusal?: EditRefusal;
}

const failureStatusPriority: readonly ValidationCheckRunStatus[] = [
  "infrastructure_failure",
  "provider_failure",
  "unsupported_request",
  "policy_failure"
];

export function createValidationManifest(args: CreateValidationManifestArgs): ValidationResultManifest {
  const manifest: ValidationResultManifest = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    checks: [...args.checks],
    generatedAt: args.generatedAt
  };
  if (args.durationMs !== undefined) manifest.durationMs = args.durationMs;
  if (args.entries !== undefined) manifest.entries = [...args.entries];
  if (args.runs !== undefined) manifest.runs = sortRuns(args.runs, args.checks);
  if (args.skippedChecks !== undefined) manifest.skippedChecks = sortSkipped(args.skippedChecks, args.checks);
  return manifest;
}

export function aggregateValidationResults(args: AggregateValidationResultsArgs): ValidationResult {
  const diagnostics = sortDiagnostics(args.diagnostics ?? []);
  const status = args.status ?? deriveStatus(diagnostics, args.runs ?? [], args.skippedChecks ?? []);
  const result: ValidationResult = {
    ok: status === "passed",
    status,
    diagnostics,
    manifest: createValidationManifest(args)
  };
  if (args.graphStatus !== undefined) result.graphStatus = args.graphStatus;
  if (args.refusal !== undefined) result.refusal = args.refusal;
  const failure = args.failure ?? failureForStatus(status);
  if (failure !== undefined) result.failure = failure;
  return validateValidationResultPayload(result);
}

function deriveStatus(
  diagnostics: readonly ValidationDiagnostic[],
  runs: readonly ValidationCheckRunSummary[],
  skippedChecks: readonly ValidationSkippedCheck[]
): ValidationResultStatus {
  for (const status of failureStatusPriority) {
    if (runs.some((run) => run.status === status)) return status;
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return "policy_failure";
  if (runs.every((run) => run.status === "skipped")) return "skipped";
  return "passed";
}

function failureForStatus(status: ValidationResultStatus): ValidationFailure | undefined {
  if (status === "passed" || status === "refused") return undefined;
  return {
    category: status,
    message:
      status === "policy_failure"
        ? "Validation checks reported error diagnostics"
        : status === "skipped"
          ? "No validation checks ran"
          : "Validation runner did not complete successfully"
  };
}

function sortRuns(
  runs: readonly ValidationCheckRunSummary[],
  checks: readonly string[]
): readonly ValidationCheckRunSummary[] {
  const order = orderByCheck(checks);
  return [...runs].sort((left, right) => compareByCheck(left.checkId, right.checkId, order));
}

function sortSkipped(
  skippedChecks: readonly ValidationSkippedCheck[],
  checks: readonly string[]
): readonly ValidationSkippedCheck[] {
  const order = orderByCheck(checks);
  return [...skippedChecks].sort((left, right) => compareByCheck(left.checkId, right.checkId, order));
}

function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    [
      (left.path ?? "").localeCompare(right.path ?? ""),
      left.category.localeCompare(right.category),
      left.severity.localeCompare(right.severity),
      (left.code ?? "").localeCompare(right.code ?? ""),
      left.message.localeCompare(right.message)
    ].find((comparison) => comparison !== 0) ?? 0
  );
}

function orderByCheck(checks: readonly string[]): ReadonlyMap<string, number> {
  return new Map(checks.map((check, index) => [check, index]));
}

function compareByCheck(left: string, right: string, order: ReadonlyMap<string, number>): number {
  const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.localeCompare(right);
}
