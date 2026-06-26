import type {
  GraphProviderStatus,
  ValidationCheckRunStatus,
  ValidationCheckRunSummary,
  ValidationDiagnostic,
  ValidationFailure,
  ValidationFailureCategory,
  ValidationRequest,
  ValidationResult,
  ValidationScopeKind,
  ValidationSkippedCheck
} from "@the-open-engine/lattice-contracts";
import { aggregateValidationResults, type AggregateValidationResultsArgs } from "./aggregation.js";
import {
  createValidationGraphQuerySession,
  ValidationGraphProviderError,
  ValidationGraphRequirementError,
  type ValidationGraphProviderClient,
  type ValidationGraphQuerySession,
  type ValidationGraphSessionFactory
} from "./graph-client.js";
import { createValidationFileView, ValidationOverlayConflictError, type ValidationFileView } from "./overlays.js";
import {
  createValidationCheckManifest,
  createValidationCheckRegistry,
  selectValidationChecks,
  ValidationCheckRegistryError,
  type ValidationCheckDefinition,
  type ValidationCheckRegistry,
  type ValidationCheckResult
} from "./registry.js";
import { defaultValidationGraphProvider, missingGraphStatus, normalizeValidationRequest } from "./request.js";
import {
  resolveValidationScope,
  ValidationScopeResolutionError,
  type ResolvedValidationScope,
  type ValidationWorkspace
} from "./scope.js";

export interface ValidationClock {
  nowMs: () => number;
  isoNow: () => string;
}

export interface CreateValidationRunnerOptions {
  workspace: ValidationWorkspace;
  checks?: readonly ValidationCheckDefinition[];
  registry?: ValidationCheckRegistry;
  graphProviderClient?: ValidationGraphProviderClient;
  graphSessionFactory?: ValidationGraphSessionFactory;
  clock?: ValidationClock;
}

export interface ValidationRunner {
  runValidation: (request: ValidationRequest) => Promise<ValidationResult>;
}

const systemClock: ValidationClock = {
  nowMs: () => Date.now(),
  isoNow: () => new Date().toISOString()
};

type RunnerRuntimeOptions = Required<Pick<CreateValidationRunnerOptions, "workspace" | "registry" | "clock">> &
  Pick<CreateValidationRunnerOptions, "graphProviderClient" | "graphSessionFactory">;

interface CheckExecution {
  runs: ValidationCheckRunSummary[];
  diagnostics: ValidationDiagnostic[];
  skippedChecks: ValidationSkippedCheck[];
  failureResult?: ValidationResult;
}

interface ExecuteChecksArgs {
  request: ValidationRequest;
  scope: ResolvedValidationScope;
  graph: ValidationGraphQuerySession;
  fileView: ValidationFileView;
  selectedChecks: readonly ValidationCheckDefinition[];
  totalStartedAt: number;
  clock: ValidationClock;
}

interface SingleCheckOutcome {
  run?: ValidationCheckRunSummary;
  diagnostics: readonly ValidationDiagnostic[];
  failureMessage?: string;
  failureStatus?: Extract<ValidationCheckRunStatus, "infrastructure_failure" | "provider_failure" | "unsupported_request">;
  providerError?: ValidationGraphProviderError;
}

export function createValidationRunner(options: CreateValidationRunnerOptions): ValidationRunner {
  const registry = options.registry ?? createValidationCheckRegistry(options.checks ?? []);
  const clock = options.clock ?? systemClock;
  return {
    runValidation: (request) => runValidation(request, {
      ...options,
      registry,
      clock
    })
  };
}

async function runValidation(
  rawRequest: ValidationRequest,
  options: RunnerRuntimeOptions
): Promise<ValidationResult> {
  let request: ValidationRequest;
  try {
    request = normalizeValidationRequest(rawRequest);
  } catch (error) {
    return failureResult("invalid_payload", "Validation request payload is invalid", error, undefined, options.clock);
  }
  const totalStartedAt = options.clock.nowMs();
  return runPreparedValidation(request, options, totalStartedAt);
}

async function runPreparedValidation(
  request: ValidationRequest,
  options: RunnerRuntimeOptions,
  totalStartedAt: number
): Promise<ValidationResult> {
  let selectedChecks: readonly ValidationCheckDefinition[] | undefined;
  try {
    selectedChecks = selectValidationChecks(options.registry, request.checks);
    const scope = await resolveValidationScope(request, options.workspace);
    const unsupportedResult = unsupportedScopeResult(selectedChecks, scope.kind, totalStartedAt, options.clock);
    if (unsupportedResult !== undefined) return unsupportedResult;
    const fileView = await createValidationFileView({ request, scope, workspace: options.workspace });
    const graph = await resolveGraphSession(request, selectedChecks, options);
    const graphFailure = requiredGraphFailureResult(request, graph.status, selectedChecks, totalStartedAt, options.clock);
    if (graphFailure !== undefined) return graphFailure;
    const execution = await executeSelectedChecks({
      request,
      scope,
      graph,
      fileView,
      selectedChecks,
      totalStartedAt,
      clock: options.clock
    });
    if (execution.failureResult !== undefined) return execution.failureResult;
    return finalValidationResult(selectedChecks, execution, graph.status, totalStartedAt, options.clock);
  } catch (error) {
    return mapValidationRunError(error, options.clock, totalStartedAt, selectedChecks);
  }
}

function unsupportedScopeResult(
  selectedChecks: readonly ValidationCheckDefinition[],
  scopeKind: ValidationScopeKind,
  totalStartedAt: number,
  clock: ValidationClock
): ValidationResult | undefined {
  const unsupportedCheck = selectedChecks.find((check) => !check.supportedScopes.includes(scopeKind));
  if (unsupportedCheck === undefined) return undefined;
  return aggregateForChecks(selectedChecks, {
    generatedAt: clock.isoNow(),
    durationMs: elapsed(totalStartedAt, clock.nowMs()),
    status: "unsupported_request",
    failure: {
      category: "unsupported_request",
      message: `Validation check does not support ${scopeKind} scope: ${unsupportedCheck.id}`
    }
  });
}

function requiredGraphFailureResult(
  request: ValidationRequest,
  graphStatus: GraphProviderStatus,
  selectedChecks: readonly ValidationCheckDefinition[],
  totalStartedAt: number,
  clock: ValidationClock
): ValidationResult | undefined {
  if (request.graph.mode !== "required" || graphStatus.state === "available") return undefined;
  return aggregateForChecks(selectedChecks, {
    generatedAt: clock.isoNow(),
    durationMs: elapsed(totalStartedAt, clock.nowMs()),
    graphStatus,
    status: "provider_failure",
    failure: {
      category: "provider_failure",
      message: graphFailureMessage(graphStatus),
      cause: graphFailureCause(graphStatus)
    }
  });
}

async function executeSelectedChecks(args: ExecuteChecksArgs): Promise<CheckExecution> {
  const execution: CheckExecution = {
    runs: [],
    diagnostics: [],
    skippedChecks: []
  };
  for (const check of args.selectedChecks) {
    const skippedCheck = skippedGraphCheck(check, args.graph.status);
    if (skippedCheck !== undefined) {
      execution.skippedChecks.push(skippedCheck);
      continue;
    }
    const preloadFailure = await preloadCheckGraphRequirements(check, args, execution);
    if (preloadFailure !== undefined) {
      if ("status" in preloadFailure) {
        execution.failureResult = preloadFailure;
        return execution;
      }
      execution.skippedChecks.push(preloadFailure);
      continue;
    }
    const outcome = await runSingleCheck(check, args);
    if (outcome.providerError !== undefined) {
      if (args.request.graph.mode === "required") {
        if (outcome.run !== undefined) execution.runs.push(outcome.run);
        execution.failureResult = checkProviderFailureResult(check, args, execution, outcome.providerError);
        return execution;
      }
      execution.skippedChecks.push(skippedGraphProviderError(check, outcome.providerError));
      continue;
    }
    if (outcome.run !== undefined) execution.runs.push(outcome.run);
    execution.diagnostics.push(...outcome.diagnostics);
    if (outcome.failureStatus !== undefined && outcome.failureMessage !== undefined) {
      execution.failureResult = checkRunFailureResult(check, args, execution, outcome.failureStatus, outcome.failureMessage);
      return execution;
    }
  }
  return execution;
}

async function preloadCheckGraphRequirements(
  check: ValidationCheckDefinition,
  args: ExecuteChecksArgs,
  execution: CheckExecution
): Promise<ValidationResult | ValidationSkippedCheck | undefined> {
  if (check.requiresGraph !== true || check.graphRequirements === undefined) return undefined;
  try {
    const requirements = await check.graphRequirements(checkContext(args));
    if (!Array.isArray(requirements)) {
      throw new ValidationGraphRequirementError("Validation check graphRequirements must return an array");
    }
    await args.graph.preload(requirements);
    return undefined;
  } catch (error) {
    if (error instanceof ValidationGraphRequirementError) {
      return graphRequirementFailureResult(check, args, execution, error);
    }
    if (error instanceof ValidationGraphProviderError) {
      if (args.request.graph.mode === "required") {
        return checkProviderFailureResult(check, args, execution, error);
      }
      return skippedGraphProviderError(check, error);
    }
    return checkRunFailureResult(check, args, execution, "infrastructure_failure", errorMessage(error));
  }
}

async function runSingleCheck(check: ValidationCheckDefinition, args: ExecuteChecksArgs): Promise<SingleCheckOutcome> {
  const checkStartedAt = args.clock.nowMs();
  try {
    const result = await check.run(checkContext(args));
    const normalized = normalizeCheckResult(result);
    const diagnostics = normalized.diagnostics ?? [];
    const status =
      normalized.status ??
      (diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "policy_failure" : "passed");
    const failureStatus = failureStatusForCheckRun(status);
    const failureMessage =
      normalized.failureMessage ?? (failureStatus === undefined ? undefined : `Validation check returned ${status}`);
    return {
      diagnostics,
      failureMessage,
      failureStatus,
      run: {
        checkId: check.id,
        status,
        durationMs: elapsed(checkStartedAt, args.clock.nowMs()),
        diagnosticCount: diagnostics.length,
        ...(failureMessage === undefined ? {} : { failureMessage })
      }
    };
  } catch (error) {
    if (error instanceof ValidationGraphProviderError) {
      return {
        diagnostics: [],
        providerError: error,
        run: {
          checkId: check.id,
          status: "provider_failure",
          durationMs: elapsed(checkStartedAt, args.clock.nowMs()),
          diagnosticCount: 0,
          failureMessage: error.message
        }
      };
    }
    return {
      diagnostics: [],
      failureMessage: errorMessage(error),
      failureStatus: "infrastructure_failure",
      run: {
        checkId: check.id,
        status: "infrastructure_failure",
        durationMs: elapsed(checkStartedAt, args.clock.nowMs()),
        diagnosticCount: 0,
        failureMessage: errorMessage(error)
      }
    };
  }
}

function checkContext(args: ExecuteChecksArgs) {
  return {
    request: args.request,
    scope: args.scope,
    graphStatus: args.graph.status,
    graph: args.graph,
    fileView: args.fileView
  };
}

function skippedGraphCheck(
  check: ValidationCheckDefinition,
  graphStatus: GraphProviderStatus
): ValidationSkippedCheck | undefined {
  if (check.requiresGraph !== true || graphStatus.state === "available") return undefined;
  return {
    checkId: check.id,
    reason: "graph_unavailable",
    message: graphFailureMessage(graphStatus)
  };
}

function skippedGraphProviderError(check: ValidationCheckDefinition, error: ValidationGraphProviderError): ValidationSkippedCheck {
  return {
    checkId: check.id,
    reason: "graph_unavailable",
    message: graphFailureMessage(error.status)
  };
}

function checkRunFailureResult(
  check: ValidationCheckDefinition,
  args: ExecuteChecksArgs,
  execution: CheckExecution,
  status: Extract<ValidationCheckRunStatus, "infrastructure_failure" | "provider_failure" | "unsupported_request">,
  failureMessage: string
): ValidationResult {
  return aggregateForChecks(args.selectedChecks, {
    runs: execution.runs,
    skippedChecks: execution.skippedChecks,
    diagnostics: execution.diagnostics,
    generatedAt: args.clock.isoNow(),
    durationMs: elapsed(args.totalStartedAt, args.clock.nowMs()),
    graphStatus: args.graph.status,
    status,
    failure: {
      category: status,
      message: `Validation check failed: ${check.id}`,
      cause: failureMessage
    }
  });
}

function checkProviderFailureResult(
  check: ValidationCheckDefinition,
  args: ExecuteChecksArgs,
  execution: CheckExecution,
  error: ValidationGraphProviderError
): ValidationResult {
  return aggregateForChecks(args.selectedChecks, {
    runs: execution.runs,
    skippedChecks: execution.skippedChecks,
    diagnostics: execution.diagnostics,
    generatedAt: args.clock.isoNow(),
    durationMs: elapsed(args.totalStartedAt, args.clock.nowMs()),
    graphStatus: error.status,
    status: "provider_failure",
    failure: {
      category: "provider_failure",
      message: `Graph provider failed for validation check: ${check.id}`,
      cause: error.message
    }
  });
}

function graphRequirementFailureResult(
  check: ValidationCheckDefinition,
  args: ExecuteChecksArgs,
  execution: CheckExecution,
  error: ValidationGraphRequirementError
): ValidationResult {
  return aggregateForChecks(args.selectedChecks, {
    runs: execution.runs,
    skippedChecks: execution.skippedChecks,
    diagnostics: execution.diagnostics,
    generatedAt: args.clock.isoNow(),
    durationMs: elapsed(args.totalStartedAt, args.clock.nowMs()),
    graphStatus: args.graph.status,
    status: "unsupported_request",
    failure: {
      category: "unsupported_request",
      message: `Validation check graph requirements are invalid: ${check.id}`,
      cause: error.message
    }
  });
}

function finalValidationResult(
  selectedChecks: readonly ValidationCheckDefinition[],
  execution: CheckExecution,
  graphStatus: GraphProviderStatus,
  totalStartedAt: number,
  clock: ValidationClock
): ValidationResult {
  return aggregateForChecks(selectedChecks, {
    runs: execution.runs,
    skippedChecks: execution.skippedChecks,
    diagnostics: execution.diagnostics,
    generatedAt: clock.isoNow(),
    durationMs: elapsed(totalStartedAt, clock.nowMs()),
    graphStatus
  });
}

function aggregateForChecks(
  checks: readonly ValidationCheckDefinition[],
  args: Omit<AggregateValidationResultsArgs, "checks" | "entries">
): ValidationResult {
  return aggregateValidationResults({
    checks: checks.map((check) => check.id),
    entries: createValidationCheckManifest(checks),
    ...args
  });
}

function mapValidationRunError(
  error: unknown,
  clock: ValidationClock,
  totalStartedAt: number,
  selectedChecks?: readonly ValidationCheckDefinition[]
): ValidationResult {
  if (error instanceof ValidationOverlayConflictError && selectedChecks !== undefined) {
    return overlayConflictResult(error, selectedChecks, totalStartedAt, clock);
  }
  if (error instanceof ValidationCheckRegistryError) {
    return failureResult("unsupported_request", error.message, error, totalStartedAt, clock);
  }
  if (error instanceof ValidationGraphRequirementError) {
    return failureResult("unsupported_request", error.message, error, totalStartedAt, clock);
  }
  if (error instanceof ValidationGraphProviderError) {
    return failureResult("provider_failure", error.message, error, totalStartedAt, clock);
  }
  if (error instanceof ValidationScopeResolutionError) {
    return failureResult(error.category, error.message, error.causeMessage ?? error.message, totalStartedAt, clock);
  }
  return failureResult("infrastructure_failure", "Validation runner infrastructure failed", error, totalStartedAt, clock);
}

function overlayConflictResult(
  error: ValidationOverlayConflictError,
  selectedChecks: readonly ValidationCheckDefinition[],
  totalStartedAt: number,
  clock: ValidationClock
): ValidationResult {
  return aggregateForChecks(selectedChecks, {
    diagnostics: [],
    generatedAt: clock.isoNow(),
    durationMs: elapsed(totalStartedAt, clock.nowMs()),
    status: "refused",
    refusal: {
      category: "conflict",
      message: error.message,
      path: error.path
    }
  });
}

async function resolveGraphSession(
  request: ValidationRequest,
  selectedChecks: readonly ValidationCheckDefinition[],
  options: RunnerRuntimeOptions
): Promise<ValidationGraphQuerySession> {
  const factory = options.graphSessionFactory ?? createValidationGraphQuerySession;
  const graph = await factory({ request, client: options.graphProviderClient });
  const hasGraphRequiredChecks = selectedChecks.some((check) => check.requiresGraph === true);
  if (hasGraphRequiredChecks && !graph.queryCapable && graph.status.state === "available") {
    return createValidationGraphQuerySession({
      request,
      status: missingGraphStatus(request.graph.mode, request.graph.provider ?? defaultValidationGraphProvider)
    });
  }
  return graph;
}

function normalizeCheckResult(result: ValidationCheckResult | readonly ValidationDiagnostic[] | void): ValidationCheckResult {
  if (result === undefined) return { diagnostics: [] };
  if (Array.isArray(result)) return { diagnostics: result as readonly ValidationDiagnostic[] };
  return {
    diagnostics: (result as ValidationCheckResult).diagnostics ?? [],
    status: (result as ValidationCheckResult).status,
    failureMessage: (result as ValidationCheckResult).failureMessage
  };
}

function failureStatusForCheckRun(
  status: ValidationCheckRunStatus
): Extract<ValidationCheckRunStatus, "infrastructure_failure" | "provider_failure" | "unsupported_request"> | undefined {
  if (status === "infrastructure_failure" || status === "provider_failure" || status === "unsupported_request") return status;
  return undefined;
}

function graphFailureMessage(status: GraphProviderStatus): string {
  if ("failure" in status) return status.failure.message;
  return status.message ?? `Graph provider is not available: ${status.state}`;
}

function graphFailureCause(status: GraphProviderStatus): string | undefined {
  if ("failure" in status) return status.failure.category;
  return undefined;
}

function failureResult(
  category: ValidationFailureCategory,
  message: string,
  cause?: unknown,
  totalStartedAt?: number,
  clock: ValidationClock = systemClock
): ValidationResult {
  const failure: ValidationFailure = {
    category,
    message
  };
  const causeMessage = errorMessage(cause);
  if (causeMessage.length > 0) failure.cause = causeMessage;
  return aggregateValidationResults({
    checks: [],
    generatedAt: clock.isoNow(),
    durationMs: totalStartedAt === undefined ? undefined : elapsed(totalStartedAt, clock.nowMs()),
    status: category,
    failure
  });
}

function elapsed(startedAt: number, completedAt: number): number {
  return Math.max(0, completedAt - startedAt);
}

function errorMessage(error: unknown): string {
  if (error === undefined) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}
