import type {
  EditRefusal,
  GraphProviderStatus,
  ValidationCheckManifestEntry,
  ValidationCheckRunSummary,
  ValidationDiagnostic,
  ValidationFailure,
  ValidationResult,
  ValidationResultStatus,
  ValidationSkippedCheck
} from "@the-open-engine/lattice-contracts";
import { GRAPH_SCHEMA_VERSION, validateValidationResultPayload } from "@the-open-engine/lattice-contracts";
import { createCheckCommandAdapter, createValidateCommandAdapter } from "./command-adapter.js";

export interface CreateValidationResultSkeletonArgs {
  status?: ValidationResultStatus;
  diagnostics?: readonly ValidationDiagnostic[];
  graphStatus?: GraphProviderStatus;
  failure?: ValidationFailure;
  refusal?: EditRefusal;
  checks?: readonly string[];
  generatedAt?: string;
  durationMs?: number;
  entries?: readonly ValidationCheckManifestEntry[];
  runs?: readonly ValidationCheckRunSummary[];
  skippedChecks?: readonly ValidationSkippedCheck[];
}

export function createValidationResultSkeleton(args: CreateValidationResultSkeletonArgs = {}): ValidationResult {
  const status = args.status ?? "passed";
  const result: ValidationResult = {
    ok: status === "passed",
    status,
    diagnostics: args.diagnostics ?? []
  };
  if (args.graphStatus !== undefined) result.graphStatus = args.graphStatus;
  if (args.failure !== undefined) result.failure = args.failure;
  if (args.refusal !== undefined) result.refusal = args.refusal;
  if (args.checks !== undefined) {
    result.manifest = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      checks: args.checks,
      generatedAt: args.generatedAt ?? new Date().toISOString()
    };
    if (args.durationMs !== undefined) result.manifest.durationMs = args.durationMs;
    if (args.entries !== undefined) result.manifest.entries = args.entries;
    if (args.runs !== undefined) result.manifest.runs = args.runs;
    if (args.skippedChecks !== undefined) result.manifest.skippedChecks = args.skippedChecks;
  }
  return validateValidationResultPayload(result);
}

export const checkCommandAdapter = createCheckCommandAdapter();
export const validateCommandAdapter = createValidateCommandAdapter();

export {
  createCheckCommandAdapter,
  createValidateCommandAdapter,
  type ValidationCommandAdapterOptions
} from "./command-adapter.js";
export {
  parseCheckCommandOptions,
  parseValidateCommandOptions,
  DEFAULT_PRE_WRITE_TIMEOUT_MS,
  ValidationCommandOptionsError,
  type CheckCommandRoute,
  type ParsedValidationCommandOptions,
  type ValidateCommandRoute,
  type ValidationCommandKind
} from "./command-options.js";
export { createValidationStatusPayload, type CreateValidationStatusPayloadOptions } from "./status-payload.js";
export { createNodeValidationWorkspace, type CreateNodeValidationWorkspaceOptions } from "./workspace.js";

export {
  aggregateValidationResults,
  createValidationManifest,
  type AggregateValidationResultsArgs,
  type CreateValidationManifestArgs
} from "./aggregation.js";
export {
  defaultValidationGraphProvider,
  missingGraphStatus,
  normalizeValidationRequest,
  validateValidationRequestContract,
  type NormalizeValidationRequestOptions
} from "./request.js";
export {
  createValidationGraphQuerySession,
  resolveValidationGraphProviderStatus,
  ValidationGraphProviderError,
  ValidationGraphRequirementError,
  type CreateValidationGraphQuerySessionArgs,
  type ValidationGraphDetectChangesInput,
  type ValidationGraphDetectChangesRequirement,
  type ValidationGraphFactQueryRequirement,
  type ValidationGraphFactView,
  type ValidationGraphImpactInput,
  type ValidationGraphImpactRequirement,
  type ValidationGraphNamedQueryInput,
  type ValidationGraphNamedQueryRequirement,
  type ValidationGraphOperation,
  type ValidationGraphProviderClient,
  type ValidationGraphQueryRequirement,
  type ValidationGraphQuerySession,
  type ValidationGraphReviewContextInput,
  type ValidationGraphReviewContextRequirement,
  type ValidationGraphSessionFactory
} from "./graph-client.js";
export {
  createValidationCheckManifest,
  createValidationCheckRegistry,
  registerValidationCheck,
  selectValidationChecks,
  ValidationCheckRegistryError,
  type ValidationCheckContext,
  type ValidationCheckDefinition,
  type ValidationCheckRegistry,
  type ValidationCheckResult
} from "./registry.js";
export {
  ValidationOverlayConflictError,
  calculateValidationFileChecksum,
  createValidationFileView,
  findValidationOverlayEntry,
  normalizeValidationFileViewPath,
  type CreateValidationFileViewArgs,
  type ValidationFileDeletedReadResult,
  type ValidationFileExistsOptions,
  type ValidationFileFoundReadResult,
  type ValidationFileMissingReadResult,
  type ValidationFileReadOptions,
  type ValidationFileReadResult,
  type ValidationFileReadSource,
  type ValidationFileReadState,
  type ValidationFileReadStatus,
  type ValidationFileSourceMetadata,
  type ValidationFileView,
  type ValidationOverlayEntry
} from "./overlays.js";
export {
  ValidationScopeResolutionError,
  resolveValidationScope,
  type ResolvedValidationScope,
  type ValidationWorkspace,
  type ValidationWorkspaceFile,
  type ValidationWorkspaceFileSet,
  type ValidationWorkspaceFileStatus,
  type ValidationWorkspaceReadFileResult
} from "./scope.js";
export {
  createValidationRunner,
  type CreateValidationRunnerOptions,
  type ValidationClock,
  type ValidationRunner
} from "./runner.js";
