import type {
  CommandAdapter,
  CommandAdapterRequest,
  CommandRouterResult,
  PreWriteValidationReceipt,
  ValidationFailure,
  ValidationRequest,
  ValidationResult
} from "@the-open-engine/opcore-contracts";
import {
  createCommandRouterResult,
  validatePreWriteValidationReceipt,
  validateValidationRequestPayload
} from "@the-open-engine/opcore-contracts";
import { aggregateValidationResults } from "./aggregation.js";
import {
  DEFAULT_PRE_WRITE_TIMEOUT_MS,
  parseCheckCommandOptions,
  parseValidateCommandOptions,
  ValidationCommandOptionsError,
  type ParsedValidationCommandOptions
} from "./command-options.js";
import { createValidationCheckManifest, createValidationCheckRegistry, type ValidationCheckDefinition, type ValidationCheckRegistry } from "./registry.js";
import { defaultValidationGraphProvider, normalizeValidationRequest } from "./request.js";
import { createValidationRunner, type CreateValidationRunnerOptions, type ValidationClock } from "./runner.js";
import { createNodeValidationWorkspace } from "./workspace.js";
import type { ValidationGraphProviderClient } from "./graph-client.js";
import type { ValidationWorkspace } from "./scope.js";
import { readFile } from "node:fs/promises";

declare const process: {
  cwd(): string;
};

export interface ValidationCommandAdapterOptions {
  checks?: readonly ValidationCheckDefinition[];
  registry?: ValidationCheckRegistry;
  workspace?: ValidationWorkspace;
  workspaceFactory?: (repoRoot: string) => ValidationWorkspace;
  graphProviderClient?: ValidationGraphProviderClient;
  clock?: ValidationClock;
  defaultRepoRoot?: string;
}

export function createCheckCommandAdapter(options: ValidationCommandAdapterOptions = {}): CommandAdapter {
  return async (request) => {
    try {
      const parsed = parseCheckCommandOptions(request.args);
      if (parsed.route === "manifest") return manifestCommandResult(request, registryChecks(options), "check manifest");
      const validationRequest = normalizeValidationRequest(
        {
          repo: {
            repoRoot: repoRootForCommand(parsed, options)
          },
          scope: requireScope(parsed),
          graph: {
            mode: parsed.graphMode,
            provider: defaultValidationGraphProvider
          },
          overlays: [],
          checks: parsed.checks
        },
        {
          provider: defaultValidationGraphProvider
        }
      );
      return validationCommandResult(request, await runRequest(validationRequest, parsed, options));
    } catch (error) {
      return validationCommandResult(request, invalidPayloadResult(errorMessage(error)));
    }
  };
}

export function createValidateCommandAdapter(options: ValidationCommandAdapterOptions = {}): CommandAdapter {
  return async (request) => {
    try {
      const parsed = parseValidateCommandOptions(request.args);
      if (parsed.route === "manifest") return manifestCommandResult(request, registryChecks(options), "validate manifest");
      if (parsed.route === "pre-write") return preWriteValidationCommandResult(request, parsed, options);
      const payload = await readRequestPayload(parsed.requestFile);
      const validatedPayload = validateValidationRequestPayload(payload);
      const validationRequest = normalizeValidationRequest(
        applyValidateCommandOverrides(validatedPayload, parsed),
        {
          provider: defaultValidationGraphProvider
        }
      );
      return validationCommandResult(request, await runRequest(validationRequest, parsed, options));
    } catch (error) {
      return validationCommandResult(request, invalidPayloadResult(errorMessage(error)));
    }
  };
}

async function preWriteValidationCommandResult(
  request: CommandAdapterRequest,
  parsed: ParsedValidationCommandOptions,
  options: ValidationCommandAdapterOptions
): Promise<CommandRouterResult> {
  const startedAt = commandNowMs(options);
  const timeoutMs = parsed.timeoutMs ?? DEFAULT_PRE_WRITE_TIMEOUT_MS;
  let validationRequest: ValidationRequest | undefined;
  let result: ValidationResult;
  try {
    const payload = await readRequestPayload(parsed.requestFile);
    const validatedPayload = validateValidationRequestPayload(payload);
    validationRequest = normalizeValidationRequest(validatedPayload, {
      provider: defaultValidationGraphProvider
    });
    result = await runRequestWithTimeout(validationRequest, parsed, options, timeoutMs);
  } catch (error) {
    result = invalidPayloadResult(errorMessage(error));
  }
  const receipt = buildPreWriteReceipt({
    routerRequest: request,
    validationRequest,
    result,
    startedAt,
    timeoutMs,
    options
  });
  return validationCommandResult(request, result, receipt);
}

async function runRequest(
  request: ValidationRequest,
  parsed: ParsedValidationCommandOptions,
  options: ValidationCommandAdapterOptions
): Promise<ValidationResult> {
  const runnerOptions: CreateValidationRunnerOptions = {
    workspace: workspaceForRequest(request, parsed, options),
    registry: registryForOptions(options),
    graphProviderClient: options.graphProviderClient,
    clock: options.clock
  };
  return createValidationRunner(runnerOptions).runValidation(request);
}

async function runRequestWithTimeout(
  request: ValidationRequest,
  parsed: ParsedValidationCommandOptions,
  options: ValidationCommandAdapterOptions,
  timeoutMs: number
): Promise<ValidationResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ValidationResult>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeoutResult(request, options, timeoutMs)), timeoutMs);
    });
    return await Promise.race([runRequest(request, parsed, options), timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function timeoutResult(request: ValidationRequest, options: ValidationCommandAdapterOptions, timeoutMs: number): ValidationResult {
  const failure: ValidationFailure = {
    category: "infrastructure_failure",
    message: `Pre-write validation timed out after ${timeoutMs}ms`,
    retryable: true
  };
  return aggregateValidationResults({
    checks: request.checks ?? registryChecks(options).map((check) => check.id),
    generatedAt: commandIsoNow(options),
    durationMs: timeoutMs,
    status: "infrastructure_failure",
    failure
  });
}

interface BuildPreWriteReceiptArgs {
  routerRequest: CommandAdapterRequest;
  validationRequest?: ValidationRequest;
  result: ValidationResult;
  startedAt: number;
  timeoutMs: number;
  options: ValidationCommandAdapterOptions;
}

function buildPreWriteReceipt(args: BuildPreWriteReceiptArgs): PreWriteValidationReceipt {
  const completedAt = commandNowMs(args.options);
  const receipt: PreWriteValidationReceipt = {
    schemaVersion: 1,
    kind: "pre_write_validation",
    route: "validate.pre-write",
    canonicalCommand: args.routerRequest.canonicalCommand,
    generatedAt: commandIsoNow(args.options),
    durationMs: Math.max(0, completedAt - args.startedAt),
    timeoutMs: args.timeoutMs,
    ok: args.result.ok,
    validationStatus: args.result.status,
    diagnosticCount: args.result.diagnostics.length
  };
  if (args.validationRequest !== undefined) {
    receipt.requestId = args.validationRequest.requestId;
    receipt.repo = args.validationRequest.repo;
    receipt.scope = args.validationRequest.scope;
    receipt.checks = args.result.manifest?.checks ?? args.validationRequest.checks ?? [];
    const graph: NonNullable<PreWriteValidationReceipt["graph"]> = {
      mode: args.validationRequest.graph.mode
    };
    if (args.validationRequest.graph.provider !== undefined) graph.provider = args.validationRequest.graph.provider;
    const graphStatus = args.result.graphStatus ?? args.validationRequest.graph.status;
    if (graphStatus !== undefined) graph.status = graphStatus;
    receipt.graph = graph;
    receipt.overlays = overlaySummary(args.validationRequest);
  }
  if (!args.result.ok) {
    receipt.failureSummary = failureSummary(args.result);
  }
  return validatePreWriteValidationReceipt(receipt);
}

function overlaySummary(request: ValidationRequest): PreWriteValidationReceipt["overlays"] {
  let writeCount = 0;
  let deleteCount = 0;
  const paths: string[] = [];
  for (const overlay of request.overlays) {
    paths.push(overlay.path);
    if (overlay.action === "write") writeCount += 1;
    else deleteCount += 1;
  }
  return {
    count: paths.length,
    writeCount,
    deleteCount,
    paths
  };
}

function failureSummary(result: ValidationResult): NonNullable<PreWriteValidationReceipt["failureSummary"]> {
  if (result.failure !== undefined) {
    const summary: NonNullable<PreWriteValidationReceipt["failureSummary"]> = {
      category: result.status,
      message: result.failure.message
    };
    if (result.failure.cause !== undefined) summary.cause = result.failure.cause;
    if (result.failure.retryable !== undefined) summary.retryable = result.failure.retryable;
    return summary;
  }
  if (result.refusal !== undefined) {
    return {
      category: "refused",
      message: result.refusal.message
    };
  }
  return {
    category: result.status,
    message: "Pre-write validation failed"
  };
}

function commandNowMs(options: ValidationCommandAdapterOptions): number {
  return options.clock?.nowMs() ?? Date.now();
}

function commandIsoNow(options: ValidationCommandAdapterOptions): string {
  return options.clock?.isoNow() ?? new Date().toISOString();
}

function validationCommandResult(
  request: CommandAdapterRequest,
  result: ValidationResult,
  receipt?: PreWriteValidationReceipt
): CommandRouterResult {
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "validation",
    status: result.ok ? "ok" : "error",
    json: request.json,
    message: result.ok ? "lattice validation complete." : result.failure?.message ?? result.refusal?.message ?? "lattice validation failed.",
    validationResult: result,
    receipt
  });
}

function manifestCommandResult(
  request: CommandAdapterRequest,
  checks: readonly ValidationCheckDefinition[],
  label: string
): CommandRouterResult {
  const entries = createValidationCheckManifest(checks);
  const result = aggregateValidationResults({
    checks: entries.map((entry) => entry.checkId),
    entries,
    generatedAt: new Date().toISOString(),
    status: "passed"
  });
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "validation",
    status: "ok",
    json: request.json,
    message: `lattice ${label}: validation check manifest ready.`,
    validationResult: result
  });
}

function invalidPayloadResult(message: string): ValidationResult {
  const failure: ValidationFailure = {
    category: "invalid_payload",
    message: "Validation command payload is invalid"
  };
  if (message.length > 0) failure.cause = message;
  return aggregateValidationResults({
    checks: [],
    generatedAt: new Date().toISOString(),
    status: "invalid_payload",
    failure
  });
}

function registryForOptions(options: ValidationCommandAdapterOptions): ValidationCheckRegistry {
  return options.registry ?? createValidationCheckRegistry(options.checks ?? []);
}

function registryChecks(options: ValidationCommandAdapterOptions): readonly ValidationCheckDefinition[] {
  return registryForOptions(options).checks;
}

function applyValidateCommandOverrides(
  request: ValidationRequest,
  parsed: ParsedValidationCommandOptions
): ValidationRequest {
  let next = request;
  if (parsed.repoRoot !== undefined) {
    next = {
      ...next,
      repo: repoIdentityForOverride(next.repo, parsed.repoRoot),
      graph: graphConfigWithoutStatus(next.graph)
    };
  }
  if (parsed.graphModeOverride !== undefined) {
    const graph = {
      ...next.graph,
      mode: parsed.graphModeOverride
    };
    if (graph.status !== undefined && graph.status.mode !== parsed.graphModeOverride) {
      delete graph.status;
    }
    next = {
      ...next,
      graph
    };
  }
  if (parsed.checks !== undefined) {
    next = {
      ...next,
      checks: parsed.checks
    };
  }
  return next;
}

function repoIdentityForOverride(repo: ValidationRequest["repo"], repoRoot: string): ValidationRequest["repo"] {
  const { repoId: _repoId, ...rest } = repo;
  return {
    ...rest,
    repoRoot
  };
}

function graphConfigWithoutStatus(graph: ValidationRequest["graph"]): ValidationRequest["graph"] {
  if (graph.status === undefined) return graph;
  const { status: _status, ...rest } = graph;
  return rest;
}

function workspaceForRequest(
  request: ValidationRequest,
  parsed: ParsedValidationCommandOptions,
  options: ValidationCommandAdapterOptions
): ValidationWorkspace {
  if (options.workspace !== undefined) return options.workspace;
  const repoRoot = parsed.repoRoot ?? request.repo.repoRoot ?? defaultRepoRoot(options);
  const factory = options.workspaceFactory ?? ((root: string) => createNodeValidationWorkspace({ repoRoot: root }));
  return factory(repoRoot);
}

function repoRootForCommand(parsed: ParsedValidationCommandOptions, options: ValidationCommandAdapterOptions): string {
  return parsed.repoRoot ?? defaultRepoRoot(options);
}

function defaultRepoRoot(options: ValidationCommandAdapterOptions): string {
  return options.defaultRepoRoot ?? process.cwd();
}

function requireScope(parsed: ParsedValidationCommandOptions): ValidationRequest["scope"] {
  if (parsed.scope === undefined) throw new ValidationCommandOptionsError("validation scope is required");
  return parsed.scope;
}

async function readRequestPayload(path: string | undefined): Promise<ValidationRequest> {
  if (path === undefined) throw new ValidationCommandOptionsError("--request-file requires a value");
  if (path === "-") throw new ValidationCommandOptionsError("stdin request payloads are not supported");
  try {
    return JSON.parse(await readFile(path, "utf8")) as ValidationRequest;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ValidationCommandOptionsError(`malformed JSON request payload: ${error.message}`);
    throw error;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
