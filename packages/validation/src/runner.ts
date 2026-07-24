import type {
  GraphProviderStatus,
  ValidationCheckOutcome,
  ValidationCheckRunStatus,
  ValidationCheckRunSummary,
  ValidationDiagnostic,
  ValidationFailure,
  ValidationFailureCategory,
  ValidationRequest,
  ValidationResult,
  PythonValidationCapabilityRun,
  PythonProjectContext,
  ValidationScopeKind,
  ValidationSkippedCheck
} from "@the-open-engine/opcore-contracts";
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
  selectDefaultValidationChecksForScope,
  selectValidationChecks,
  ValidationCheckRegistryError,
  type ValidationCheckDefinition,
  type ValidationCheckRegistry,
  type ValidationCheckResult,
  type ValidationRuntimePolicy
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
  runtime?: ValidationRuntimePolicy;
  failFast?: boolean;
  onCheckComplete?: ValidationCheckCompleteHandler;
}

export interface ValidationCheckCompleteEvent {
  schemaVersion: 1;
  kind: "validation.check";
  checkId: string;
  status: ValidationCheckRunStatus;
  diagnostics: readonly ValidationDiagnostic[];
  run?: ValidationCheckRunSummary;
  skippedCheck?: ValidationSkippedCheck;
  pythonCapabilityRuns?: readonly PythonValidationCapabilityRun[];
}

export type ValidationCheckCompleteHandler = (event: ValidationCheckCompleteEvent) => void | Promise<void>;

export interface ValidationRunner {
  runValidation: (request: ValidationRequest) => Promise<ValidationResult>;
}

const systemClock: ValidationClock = {
  nowMs: () => Date.now(),
  isoNow: () => new Date().toISOString()
};

const defaultRuntimePolicy: ValidationRuntimePolicy = {
  persistentCaches: "enabled"
};

type RunnerRuntimeOptions = Required<Pick<CreateValidationRunnerOptions, "workspace" | "registry" | "clock">> &
  Pick<CreateValidationRunnerOptions, "graphProviderClient" | "graphSessionFactory" | "onCheckComplete"> & {
    runtime: ValidationRuntimePolicy;
    failFast: boolean;
  };

interface CheckExecution {
  runs: ValidationCheckRunSummary[];
  diagnostics: ValidationDiagnostic[];
  diagnosticsByCheck: Map<string, ValidationDiagnostic[]>;
  skippedChecks: ValidationSkippedCheck[];
  pythonProjectContexts: PythonProjectContext[];
  pythonCapabilityRuns: PythonValidationCapabilityRun[];
  failureResult?: ValidationResult;
}

interface ExecuteChecksArgs {
  request: ValidationRequest;
  scope: ResolvedValidationScope;
  graph: ValidationGraphQuerySession;
  fileView: ValidationFileView;
  activeCheckIds: readonly string[];
  selectedChecks: readonly ValidationCheckDefinition[];
  inactiveChecks: readonly ValidationCheckDefinition[];
  totalStartedAt: number;
  clock: ValidationClock;
  runtime: ValidationRuntimePolicy;
  failFast: boolean;
  onCheckComplete?: ValidationCheckCompleteHandler;
}

interface PreparedValidationArgs {
  request: ValidationRequest;
  scope: ResolvedValidationScope;
  graph: ValidationGraphQuerySession;
  selectedChecks: readonly ValidationCheckDefinition[];
  inactiveChecks: readonly ValidationCheckDefinition[];
  totalStartedAt: number;
  options: RunnerRuntimeOptions;
}

interface ExecuteValidationRequestArgs extends PreparedValidationArgs {
  defaultReadState?: "before";
}

interface SingleCheckOutcome {
  run?: ValidationCheckRunSummary;
  diagnostics: readonly ValidationDiagnostic[];
  failureMessage?: string;
  failureStatus?: Extract<ValidationCheckRunStatus, "infrastructure_failure" | "provider_failure" | "unsupported_request">;
  providerError?: ValidationGraphProviderError;
  pythonProjectContexts: readonly PythonProjectContext[];
  pythonCapabilityRuns: readonly PythonValidationCapabilityRun[];
}

export function createValidationRunner(options: CreateValidationRunnerOptions): ValidationRunner {
  const registry = options.registry ?? createValidationCheckRegistry(options.checks ?? []);
  const clock = options.clock ?? systemClock;
  const runtime = options.runtime ?? defaultRuntimePolicy;
  const failFast = options.failFast === true;
  return {
    runValidation: (request) => runValidation(request, {
      ...options,
      registry,
      clock,
      runtime,
      failFast
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
    const scope = await resolveValidationScope(request, options.workspace);
    selectedChecks =
      request.checks === undefined
        ? selectDefaultValidationChecksForScope(options.registry, scope.kind)
        : selectValidationChecks(options.registry, request.checks);
    if (request.checks === undefined && selectedChecks.length === 0 && options.registry.checks.length > 0) {
      const defaultUnsupportedResult = unsupportedScopeResult(options.registry.checks, scope.kind, totalStartedAt, options.clock);
      if (defaultUnsupportedResult !== undefined) return defaultUnsupportedResult;
    }
    const unsupportedResult = unsupportedScopeResult(selectedChecks, scope.kind, totalStartedAt, options.clock);
    if (unsupportedResult !== undefined) return unsupportedResult;
    const inactiveChecks = selectInactiveValidationChecks(options.registry, selectedChecks, scope.kind);
    const graph = await resolveGraphSession(request, selectedChecks, options);
    const graphFailure = requiredGraphFailureResult(request, graph.status, selectedChecks, totalStartedAt, options.clock);
    if (graphFailure !== undefined) return graphFailure;
    if (request.reportMode === "introduced") {
      return await runIntroducedValidation({
        request,
        scope,
        graph,
        selectedChecks,
        inactiveChecks,
        totalStartedAt,
        options
      });
    }
    return await runCurrentValidation({
      request,
      scope,
      graph,
      selectedChecks,
      inactiveChecks,
      totalStartedAt,
      options
    });
  } catch (error) {
    return mapValidationRunError(error, options.clock, totalStartedAt, selectedChecks);
  }
}

async function runCurrentValidation(args: PreparedValidationArgs): Promise<ValidationResult> {
  const execution = await executeValidationRequest(args);
  if (execution.failureResult !== undefined) return execution.failureResult;
  return finalValidationResult(args.selectedChecks, execution, args.graph.status, args.totalStartedAt, args.options.clock);
}

async function runIntroducedValidation(args: PreparedValidationArgs): Promise<ValidationResult> {
  if (args.options.failFast || args.options.onCheckComplete !== undefined) {
    return runIntroducedValidationIncremental(args);
  }
  const beforeRequest: ValidationRequest = {
    ...args.request,
    overlays: []
  };
  const beforeExecution = await executeValidationRequest({
    ...args,
    request: beforeRequest,
    defaultReadState: "before"
  });
  if (beforeExecution.failureResult !== undefined) return beforeExecution.failureResult;
  const execution = await executeValidationRequest(args);
  if (execution.failureResult !== undefined) return execution.failureResult;
  return finalValidationResult(
    args.selectedChecks,
    introducedExecution(beforeExecution, execution),
    args.graph.status,
    args.totalStartedAt,
    args.options.clock
  );
}

async function runIntroducedValidationIncremental(args: PreparedValidationArgs): Promise<ValidationResult> {
  const execution: CheckExecution = {
    runs: [],
    diagnostics: [],
    diagnosticsByCheck: new Map(),
    skippedChecks: [],
    pythonProjectContexts: [],
    pythonCapabilityRuns: []
  };
  const quietOptions = withoutCheckCompleteOptions(args.options);
  for (const check of args.selectedChecks) {
    const selectedChecks = [check];
    const beforeExecution = await executeValidationRequest({
      ...args,
      request: {
        ...args.request,
        overlays: []
      },
      selectedChecks,
      defaultReadState: "before",
      options: quietOptions
    });
    if (beforeExecution.failureResult !== undefined) return beforeExecution.failureResult;
    const afterExecution = await executeValidationRequest({
      ...args,
      selectedChecks,
      options: quietOptions
    });
    if (afterExecution.failureResult !== undefined) return afterExecution.failureResult;
    const introduced = introducedExecution(beforeExecution, afterExecution);
    mergeCheckExecution(execution, introduced);
    await emitIntroducedCheckComplete(args, check, introduced);
    if (args.options.failFast && introduced.runs.some((run) => run.status === "policy_failure")) {
      break;
    }
  }
  return finalValidationResult(args.selectedChecks, execution, args.graph.status, args.totalStartedAt, args.options.clock);
}

function withoutCheckCompleteOptions(options: RunnerRuntimeOptions): RunnerRuntimeOptions {
  const { onCheckComplete: _onCheckComplete, ...rest } = options;
  return {
    ...rest,
    failFast: false
  };
}

function mergeCheckExecution(target: CheckExecution, source: CheckExecution): void {
  target.runs.push(...source.runs);
  target.diagnostics.push(...source.diagnostics);
  target.skippedChecks.push(...source.skippedChecks);
  mergePythonProjectContexts(target.pythonProjectContexts, source.pythonProjectContexts);
  mergePythonCapabilityRuns(target.pythonCapabilityRuns, source.pythonCapabilityRuns);
  for (const [checkId, diagnostics] of source.diagnosticsByCheck) {
    target.diagnosticsByCheck.set(checkId, diagnostics);
  }
}

async function emitIntroducedCheckComplete(
  args: PreparedValidationArgs,
  check: ValidationCheckDefinition,
  execution: CheckExecution
): Promise<void> {
  if (args.options.onCheckComplete === undefined) return;
  const run = execution.runs.find((entry) => entry.checkId === check.id);
  if (run !== undefined) {
    await args.options.onCheckComplete({
      schemaVersion: 1,
      kind: "validation.check",
      checkId: check.id,
      status: run.status,
      diagnostics: execution.diagnosticsByCheck.get(check.id) ?? [],
      run
    });
    return;
  }
  const skippedCheck = execution.skippedChecks.find((entry) => entry.checkId === check.id);
  if (skippedCheck !== undefined) {
    await args.options.onCheckComplete({
      schemaVersion: 1,
      kind: "validation.check",
      checkId: check.id,
      status: "skipped",
      diagnostics: [],
      skippedCheck
    });
  }
}

async function executeValidationRequest(args: ExecuteValidationRequestArgs): Promise<CheckExecution> {
  const fileView = await createValidationFileView({
    request: args.request,
    scope: args.scope,
    workspace: args.options.workspace,
    ...(args.defaultReadState === undefined ? {} : { defaultReadState: args.defaultReadState })
  });
  return executeSelectedChecks({
    request: args.request,
    scope: args.scope,
    graph: args.graph,
    fileView,
    activeCheckIds: args.selectedChecks.map((check) => check.id),
    selectedChecks: args.selectedChecks,
    inactiveChecks: args.inactiveChecks,
    totalStartedAt: args.totalStartedAt,
    clock: args.options.clock,
    runtime: args.options.runtime,
    failFast: args.options.failFast,
    onCheckComplete: args.options.onCheckComplete
  });
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
  const execution = emptyCheckExecution();
  try {
    for (const check of args.selectedChecks) {
      const loopAction = await executeSelectedCheck(check, args, execution);
      if (loopAction === "return") return execution;
      if (loopAction === "break") break;
    }
    await executeInactiveChecks(args, execution);
    return execution;
  } finally {
    aggregateExecutionFailure(args, execution);
  }
}

function emptyCheckExecution(): CheckExecution {
  return {
    runs: [],
    diagnostics: [],
    diagnosticsByCheck: new Map(),
    skippedChecks: [],
    pythonProjectContexts: [],
    pythonCapabilityRuns: []
  };
}

async function executeSelectedCheck(
  check: ValidationCheckDefinition,
  args: ExecuteChecksArgs,
  execution: CheckExecution
): Promise<"continue" | "break" | "return"> {
  const skippedCheck = skippedGraphCheck(check, args.graph.status);
  if (skippedCheck !== undefined) {
    await recordSkippedCheck(args, execution, check.id, skippedCheck);
    return "continue";
  }
  const preloadResult = await handlePreloadFailure(check, args, execution);
  if (preloadResult !== undefined) return preloadResult;
  const outcome = await runSingleCheck(check, args);
  const providerResult = await handleProviderError(check, args, execution, outcome);
  if (providerResult !== undefined) return providerResult;
  await recordCheckOutcome(args, execution, check, outcome);
  if (outcome.failureStatus !== undefined && outcome.failureMessage !== undefined) {
    execution.failureResult = checkRunFailureResult(check, args, execution, outcome.failureStatus, outcome.failureMessage);
    return "return";
  }
  return args.failFast && outcome.run?.status === "policy_failure" ? "break" : "continue";
}

async function handlePreloadFailure(
  check: ValidationCheckDefinition,
  args: ExecuteChecksArgs,
  execution: CheckExecution
): Promise<"continue" | "return" | undefined> {
  const preloadFailure = await preloadCheckGraphRequirements(check, args, execution);
  if (preloadFailure === undefined) return undefined;
  if ("status" in preloadFailure) {
    execution.failureResult = preloadFailure;
    await emitCheckComplete(args, failureCheckCompleteEvent(check, preloadFailure, execution.diagnostics));
    return "return";
  }
  await recordSkippedCheck(args, execution, check.id, preloadFailure);
  return "continue";
}

async function handleProviderError(
  check: ValidationCheckDefinition,
  args: ExecuteChecksArgs,
  execution: CheckExecution,
  outcome: SingleCheckOutcome
): Promise<"continue" | "return" | undefined> {
  if (outcome.providerError === undefined) return undefined;
  if (args.request.graph.mode === "required") {
    if (outcome.run !== undefined) execution.runs.push(outcome.run);
    execution.failureResult = checkProviderFailureResult(check, args, execution, outcome.providerError);
    await emitCheckComplete(args, outcomeCheckCompleteEvent(check, outcome));
    return "return";
  }
  await recordSkippedCheck(args, execution, check.id, skippedGraphProviderError(check, outcome.providerError));
  return "continue";
}

async function recordSkippedCheck(
  args: ExecuteChecksArgs,
  execution: CheckExecution,
  checkId: string,
  skippedCheck: ValidationSkippedCheck
): Promise<void> {
  execution.skippedChecks.push(skippedCheck);
  await emitCheckComplete(args, {
    schemaVersion: 1,
    kind: "validation.check",
    checkId,
    status: "skipped",
    diagnostics: [],
    skippedCheck
  });
}

async function recordCheckOutcome(
  args: ExecuteChecksArgs,
  execution: CheckExecution,
  check: ValidationCheckDefinition,
  outcome: SingleCheckOutcome
): Promise<void> {
  if (outcome.run !== undefined) execution.runs.push(outcome.run);
  mergePythonProjectContexts(execution.pythonProjectContexts, outcome.pythonProjectContexts);
  mergePythonCapabilityRuns(execution.pythonCapabilityRuns, outcome.pythonCapabilityRuns);
  execution.diagnosticsByCheck.set(check.id, [...outcome.diagnostics]);
  execution.diagnostics.push(...outcome.diagnostics);
  await emitCheckComplete(args, outcomeCheckCompleteEvent(check, outcome));
}

function aggregateExecutionFailure(args: ExecuteChecksArgs, execution: CheckExecution): void {
  if (execution.failureResult === undefined) return;
  const failure = execution.failureResult;
  execution.failureResult = aggregateForChecks(args.selectedChecks, {
    runs: execution.runs,
    skippedChecks: execution.skippedChecks,
    diagnostics: execution.diagnostics,
    pythonProjectContexts: execution.pythonProjectContexts,
    pythonCapabilityRuns: execution.pythonCapabilityRuns,
    generatedAt: args.clock.isoNow(),
    durationMs: elapsed(args.totalStartedAt, args.clock.nowMs()),
    ...(failure.graphStatus === undefined ? {} : { graphStatus: failure.graphStatus }),
    status: failure.status,
    ...(failure.failure === undefined ? {} : { failure: failure.failure }),
    ...(failure.refusal === undefined ? {} : { refusal: failure.refusal })
  });
}

function outcomeCheckCompleteEvent(check: ValidationCheckDefinition, outcome: SingleCheckOutcome): ValidationCheckCompleteEvent {
  return {
    schemaVersion: 1,
    kind: "validation.check",
    checkId: check.id,
    status: outcome.run?.status ?? "passed",
    diagnostics: outcome.diagnostics,
    ...(outcome.run === undefined ? {} : { run: outcome.run }),
    ...(outcome.pythonCapabilityRuns.length === 0 ? {} : { pythonCapabilityRuns: outcome.pythonCapabilityRuns })
  };
}

function failureCheckCompleteEvent(
  check: ValidationCheckDefinition,
  result: ValidationResult,
  diagnostics: readonly ValidationDiagnostic[]
): ValidationCheckCompleteEvent {
  const status = result.status === "invalid_payload" || result.status === "refused" ? "infrastructure_failure" : result.status;
  return {
    schemaVersion: 1,
    kind: "validation.check",
    checkId: check.id,
    status,
    diagnostics
  };
}

async function emitCheckComplete(args: ExecuteChecksArgs, event: ValidationCheckCompleteEvent): Promise<void> {
  if (args.onCheckComplete === undefined) return;
  await args.onCheckComplete(event);
}

function introducedExecution(before: CheckExecution, after: CheckExecution): CheckExecution {
  const diagnosticsByCheck = new Map<string, ValidationDiagnostic[]>();
  const diagnostics: ValidationDiagnostic[] = [];
  for (const [checkId, afterDiagnostics] of after.diagnosticsByCheck) {
    const beforeFingerprints = new Set((before.diagnosticsByCheck.get(checkId) ?? []).map(diagnosticFingerprint));
    const introduced = afterDiagnostics.filter((diagnostic) => !beforeFingerprints.has(diagnosticFingerprint(diagnostic)));
    diagnosticsByCheck.set(checkId, introduced);
    diagnostics.push(...introduced);
  }
  return {
    runs: after.runs.map((run) => introducedRun(run, diagnosticsByCheck.get(run.checkId) ?? [])),
    diagnostics,
    diagnosticsByCheck,
    skippedChecks: after.skippedChecks,
    pythonProjectContexts: after.pythonProjectContexts,
    pythonCapabilityRuns: after.pythonCapabilityRuns,
    failureResult: after.failureResult
  };
}

function introducedRun(run: ValidationCheckRunSummary, diagnostics: readonly ValidationDiagnostic[]): ValidationCheckRunSummary {
  const status =
    run.status === "policy_failure"
      ? diagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? "policy_failure"
        : "passed"
      : run.status;
  const next: ValidationCheckRunSummary = {
    ...run,
    status,
    ...(run.outcome === "findings" && status === "passed" ? { outcome: "passed" as const } : {}),
    diagnosticCount: diagnostics.length
  };
  if (status === "passed") delete next.failureMessage;
  return next;
}

function diagnosticFingerprint(diagnostic: ValidationDiagnostic): string {
  return JSON.stringify({
    category: diagnostic.category,
    path: diagnostic.path ?? "",
    severity: diagnostic.severity,
    code: diagnostic.code ?? "",
    line: diagnostic.line ?? null,
    column: diagnostic.column ?? null,
    endLine: diagnostic.endLine ?? null,
    endColumn: diagnostic.endColumn ?? null,
    message: stableDiagnosticMessage(diagnostic)
  });
}

function stableDiagnosticMessage(diagnostic: ValidationDiagnostic): string {
  if (diagnostic.code === "TS_FILE_LINES") return "";
  return diagnostic.message;
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
    const status = normalized.status ?? statusForOutcome(normalized.outcome) ??
      (diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "policy_failure" : "passed");
    const failureStatus = failureStatusForCheckRun(status);
    const failureMessage =
      normalized.failureMessage ?? (failureStatus === undefined ? undefined : `Validation check returned ${status}`);
    return {
      diagnostics,
      pythonProjectContexts: normalized.pythonProjectContexts ?? [],
      pythonCapabilityRuns: normalized.pythonCapabilityRuns ?? [],
      failureMessage,
      failureStatus,
      run: {
        checkId: check.id,
        status,
        ...(normalized.outcome === undefined ? {} : { outcome: normalized.outcome }),
        durationMs: elapsed(checkStartedAt, args.clock.nowMs()),
        diagnosticCount: diagnostics.length,
        ...(failureMessage === undefined ? {} : { failureMessage })
      }
    };
  } catch (error) {
    if (error instanceof ValidationGraphProviderError) {
      return {
        diagnostics: [],
        pythonProjectContexts: [],
        pythonCapabilityRuns: [],
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
      pythonProjectContexts: [],
      pythonCapabilityRuns: [],
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

async function executeInactiveChecks(args: ExecuteChecksArgs, execution: CheckExecution): Promise<void> {
  for (const check of args.inactiveChecks) {
    if (check.inactiveResult === undefined || check.inactiveStateWhenUnselected === undefined) continue;
    const result = await check.inactiveResult(checkContext(args), check.inactiveStateWhenUnselected);
    const normalized = normalizeCheckResult(result);
    mergePythonProjectContexts(execution.pythonProjectContexts, normalized.pythonProjectContexts ?? []);
    mergePythonCapabilityRuns(execution.pythonCapabilityRuns, normalized.pythonCapabilityRuns ?? []);
  }
}

function checkContext(args: ExecuteChecksArgs) {
  return {
    request: args.request,
    selectedCheckIds: args.activeCheckIds,
    scope: args.scope,
    graphStatus: args.graph.status,
    graph: args.graph,
    fileView: args.fileView,
    runtime: args.runtime
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
    pythonProjectContexts: execution.pythonProjectContexts,
    pythonCapabilityRuns: execution.pythonCapabilityRuns,
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
    pythonProjectContexts: execution.pythonProjectContexts,
    pythonCapabilityRuns: execution.pythonCapabilityRuns,
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
    pythonProjectContexts: execution.pythonProjectContexts,
    pythonCapabilityRuns: execution.pythonCapabilityRuns,
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
    pythonProjectContexts: execution.pythonProjectContexts,
    pythonCapabilityRuns: execution.pythonCapabilityRuns,
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
  if (isValidationDiagnosticArray(result)) return { diagnostics: result };
  return {
    diagnostics: result.diagnostics ?? [],
    status: result.status,
    outcome: result.outcome,
    failureMessage: result.failureMessage,
    pythonProjectContexts: result.pythonProjectContexts,
    pythonCapabilityRuns: result.pythonCapabilityRuns
  };
}

function mergePythonProjectContexts(target: PythonProjectContext[], source: readonly PythonProjectContext[]): void {
  const byTarget = new Map(target.map((context) => [context.target, context]));
  for (const context of source) byTarget.set(context.target, context);
  target.splice(0, target.length, ...[...byTarget.values()].sort((left, right) => left.target.localeCompare(right.target)));
}

function mergePythonCapabilityRuns(target: PythonValidationCapabilityRun[], source: readonly PythonValidationCapabilityRun[]): void {
  const byFingerprint = new Map<string, PythonValidationCapabilityRun>(target.map((run) => [JSON.stringify(run), run]));
  for (const run of source) byFingerprint.set(JSON.stringify(run), run);
  target.splice(0, target.length, ...[...byFingerprint.values()]);
}

function selectInactiveValidationChecks(
  registry: ValidationCheckRegistry,
  selectedChecks: readonly ValidationCheckDefinition[],
  scopeKind: ValidationScopeKind
): readonly ValidationCheckDefinition[] {
  const selectedIds = new Set(selectedChecks.map((check) => check.id));
  return registry.checks.filter((check) =>
    !selectedIds.has(check.id) &&
    check.supportedScopes.includes(scopeKind) &&
    check.inactiveResult !== undefined &&
    check.inactiveStateWhenUnselected !== undefined
  );
}

function isValidationDiagnosticArray(
  result: ValidationCheckResult | readonly ValidationDiagnostic[]
): result is readonly ValidationDiagnostic[] {
  return Array.isArray(result);
}

function statusForOutcome(outcome: ValidationCheckOutcome | undefined): ValidationCheckRunStatus | undefined {
  if (outcome === undefined) return undefined;
  if (outcome === "passed") return "passed";
  if (outcome === "findings") return "policy_failure";
  if (outcome === "tool_unavailable" || outcome === "invalid_config" || outcome === "unsupported_target") {
    return "unsupported_request";
  }
  return "infrastructure_failure";
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
