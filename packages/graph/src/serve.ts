import type {
  CommandAdapterRequest,
  CommandRouteStatus,
  CommandRouterResult,
  CommandTiming,
  CommandTimingProcessState,
  GraphDaemonOperation,
  GraphDaemonRequest,
  GraphDaemonResponse,
  GraphProviderArtifactMetadata,
  GraphProviderStatus,
  GraphServeTransportStatus,
  JsonValue,
  RepoIdentity
} from "@the-open-engine/opcore-contracts";
import {
  createCommandRouterResult,
  validateGraphDaemonRequest,
  validateGraphDaemonResponse,
  validateGraphServeTransportStatus
} from "@the-open-engine/opcore-contracts";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { providerFailureStatus, resolveGraphCoreArtifact, schemaMismatchStatus } from "./artifact.js";
import { normalizeGraphCoreResponseArtifacts } from "./sidecar.js";

type Writer = {
  write(text: string): void;
};

type Readable = {
  on(event: "data", listener: (chunk: { toString(encoding?: string): string } | string) => void): Readable;
  on(event: "end", listener: () => void): Readable;
  on(event: "error", listener: (error: Error) => void): Readable;
};

type SpawnFactory = typeof spawn;
type GraphCoreChild = ReturnType<SpawnFactory>;

interface GraphServeTransportRuntime {
  artifact: GraphServeResolvedArtifact;
  repo: RepoIdentity;
  child: GraphCoreChild;
  pending: PendingFrame[];
  stdout: Writer;
  telemetry?: GraphServeTelemetry;
  resolveExit: (exitCode: number) => void;
  state: {
    firstTimedFrame: boolean;
    inputEnded: boolean;
    resolved: boolean;
    shutdownForwarded: boolean;
    stderrText: string;
  };
}

export interface GraphServeResolvedArtifact extends GraphProviderArtifactMetadata {
  executablePath: string;
  metadataPath: string;
}

export type GraphServeArtifactResolution =
  | {
      ok: true;
      artifact: GraphServeResolvedArtifact;
    }
  | {
      ok: false;
      status: GraphProviderStatus;
    };

export interface GraphServeCliOptions {
  argv: readonly string[];
  bin: "opcore" | string;
  cwd?: string;
  stdin?: Readable;
  stdout?: Writer;
  stderr?: Writer;
  telemetry?: GraphServeTelemetry;
  resolveArtifact?: () => GraphServeArtifactResolution;
  spawnGraphCore?: SpawnFactory;
}

export interface GraphServeFrameTimingEvent {
  repo: RepoIdentity;
  request: GraphDaemonRequest;
  response: GraphDaemonResponse;
  canonicalCommand: readonly string[];
  owner: "graph";
  status: CommandRouteStatus;
  exitCode: number;
  timing: CommandTiming;
}

export interface GraphServeTelemetry {
  recordFrameTiming(event: GraphServeFrameTimingEvent): void;
}

declare const process: {
  cwd(): string;
  pid: number;
  stdin: Readable;
  stdout: Writer;
  stderr: Writer;
};

const serveHelpArgs = new Set(["--help", "-h", "help"]);
const pipelineServeOperations = new Set<GraphDaemonOperation>(["build", "update", "watch"]);
const statusLikeServeOperations = new Set<GraphDaemonOperation>(["ping", "health", "status", "shutdown"]);
const graphServeCapabilities = {
  operations: ["ping", "status", "query", "search", "shutdown"],
  jsonlProtocol: "opcore.graph.daemon",
  mcpMethods: [
    "initialize",
    "opcore.graph/ping",
    "opcore.graph/status",
    "opcore.graph/query",
    "opcore.graph/search",
    "opcore.graph/shutdown"
  ]
} as const;

export function isServeTransportArgv(argv: readonly string[]): boolean {
  return firstRouteArg(argv) === "serve" && !argv.includes("--json") && !argv.some((arg) => serveHelpArgs.has(arg));
}

export function graphServeRouterResult(request: CommandAdapterRequest): CommandRouterResult {
  try {
    const options = parseServeOptions(request.args, process.cwd());
    const resolution = resolveGraphCoreArtifact();
    const graphServe = graphServeStatusFromResolution(options.repo, resolution);
    return createCommandRouterResult({
      bin: request.bin,
      argv: request.argv,
      canonicalCommand: request.canonicalCommand,
      owner: "graph",
      status: graphServe.state === "ready" ? "ok" : "error",
      json: request.json,
      message:
        graphServe.state === "ready"
          ? "opcore graph serve: stdio transport ready."
          : (graphServe.message ?? "opcore graph serve: stdio transport unavailable."),
      providerStatus: resolution.ok ? undefined : resolution.status,
      graphServe
    });
  } catch (error) {
    const status = providerFailureStatus("error", "unknown", errorMessage(error), "required");
    return createCommandRouterResult({
      bin: request.bin,
      argv: request.argv,
      canonicalCommand: request.canonicalCommand,
      owner: "graph",
      status: "error",
      json: request.json,
      message: errorMessage(error),
      providerStatus: status,
      graphServe: graphServeErrorStatus({ repoRoot: process.cwd() }, status)
    });
  }
}

export async function runGraphServeCli(options: GraphServeCliOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const cwd = options.cwd ?? process.cwd();
  let serveOptions: { repo: RepoIdentity };
  try {
    serveOptions = parseServeOptions(options.argv, cwd);
  } catch (error) {
    writeDaemonFrame(stdout, failureResponse("graph-serve-startup", providerFailureStatus("error", "unknown", errorMessage(error), "required")));
    return 1;
  }

  const resolution = (options.resolveArtifact ?? resolveGraphCoreArtifact)();
  if (!resolution.ok) {
    writeDaemonFrame(stdout, failureResponse("graph-serve-startup", resolution.status));
    return 1;
  }

  return runGraphServeTransport({
    artifact: resolution.artifact,
    repo: serveOptions.repo,
    stdin,
    stdout,
    telemetry: options.telemetry,
    spawnGraphCore: options.spawnGraphCore ?? spawn
  });
}

function runGraphServeTransport(options: {
  artifact: GraphServeResolvedArtifact;
  repo: RepoIdentity;
  stdin: Readable;
  stdout: Writer;
  telemetry?: GraphServeTelemetry;
  spawnGraphCore: SpawnFactory;
}): Promise<number> {
  return new Promise((resolveExit) => {
    const runtime = createTransportRuntime(options, resolveExit);
    attachChildLifecycle(runtime);
    attachChildResponseForwarding(runtime);
    attachStdinForwarding(runtime, options.stdin);
  });
}

function createTransportRuntime(
  options: {
    artifact: GraphServeResolvedArtifact;
    repo: RepoIdentity;
    stdout: Writer;
    telemetry?: GraphServeTelemetry;
    spawnGraphCore: SpawnFactory;
  },
  resolveExit: (exitCode: number) => void
): GraphServeTransportRuntime {
  return {
    artifact: options.artifact,
    repo: options.repo,
    child: options.spawnGraphCore(options.artifact.executablePath, [], {
      stdio: ["pipe", "pipe", "pipe"]
    }),
    pending: [],
    stdout: options.stdout,
    telemetry: options.telemetry,
    resolveExit,
    state: {
      firstTimedFrame: true,
      inputEnded: false,
      resolved: false,
      shutdownForwarded: false,
      stderrText: ""
    }
  };
}

function attachChildLifecycle(runtime: GraphServeTransportRuntime): void {
  runtime.child.on("error", (error) => {
    failNextPending(runtime, providerFailureStatus("daemon_unavailable", "daemon_unavailable", error.message, "required"));
    finishTransport(runtime, 1);
  });
  runtime.child.on("close", (code) => {
    failOutstandingPending(runtime);
    finishTransport(runtime, code === 0 ? 0 : 1);
  });
  runtime.child.stderr.on("data", (chunk) => {
    runtime.state.stderrText += chunk.toString("utf8");
  });
}

function attachChildResponseForwarding(runtime: GraphServeTransportRuntime): void {
  readLines(
    runtime.child.stdout,
    (line) => forwardChildResponse(runtime, line),
    () => undefined,
    (error) => {
      failNextPending(runtime, providerFailureStatus("daemon_unavailable", "daemon_unavailable", error.message, "required"));
    }
  );
}

function attachStdinForwarding(runtime: GraphServeTransportRuntime, stdin: Readable): void {
  readLines(
    stdin,
    (line) => forwardStdinFrame(runtime, line),
    () => closeChildInput(runtime),
    (error) => handleStdinError(runtime, error)
  );
}

function forwardChildResponse(runtime: GraphServeTransportRuntime, line: string): void {
  const frame = runtime.pending.shift();
  const response = decodeChildResponse(frame?.requestId ?? "graph-serve-response", line, runtime.artifact);
  writeFrame(runtime, frame, response);
}

function forwardStdinFrame(runtime: GraphServeTransportRuntime, line: string): void {
  const frame = parseServeFrame(line, runtime.repo);
  if ("noResponse" in frame) return;
  if ("directResponse" in frame) {
    writeRawFrame(runtime.stdout, frame.directResponse);
    return;
  }
  runtime.pending.push(timedPendingFrame(runtime, frame.pending, frame.request));
  runtime.child.stdin.write(`${JSON.stringify(frame.request)}\n`);
  if (frame.request.operation === "shutdown") runtime.state.shutdownForwarded = true;
}

function handleStdinError(runtime: GraphServeTransportRuntime, error: Error): void {
  const status = providerFailureStatus("daemon_unavailable", "daemon_unavailable", error.message, "required");
  writeDaemonFrame(runtime.stdout, failureResponse("graph-serve-stdin", status));
  if (!runtime.state.inputEnded) runtime.child.stdin.end();
}

function closeChildInput(runtime: GraphServeTransportRuntime): void {
  runtime.state.inputEnded = true;
  if (!runtime.state.shutdownForwarded) runtime.child.stdin.end();
}

function finishTransport(runtime: GraphServeTransportRuntime, exitCode: number): void {
  if (runtime.state.resolved) return;
  runtime.state.resolved = true;
  runtime.resolveExit(exitCode);
}

function failOutstandingPending(runtime: GraphServeTransportRuntime): void {
  if (runtime.pending.length === 0) return;
  const message = `graph-core sidecar closed before ${runtime.pending.length} response(s)${runtime.state.stderrText ? `: ${runtime.state.stderrText}` : ""}`;
  const status = providerFailureStatus("daemon_unavailable", "daemon_unavailable", message, "required");
  while (runtime.pending.length > 0) failNextPending(runtime, status);
}

function failNextPending(runtime: GraphServeTransportRuntime, status: GraphProviderStatus): void {
  const frame = runtime.pending.shift();
  const response = failureResponse(frame?.requestId ?? "graph-serve-child", status);
  writeFrame(runtime, frame, response);
}

type PendingFrameBase = {
  request: GraphDaemonRequest;
  startedAt: number;
  processState: CommandTimingProcessState;
};

type PendingFrame = PendingFrameBase &
  (
    | {
        kind: "daemon";
        requestId: string;
      }
    | {
        kind: "mcp";
        requestId: string;
        id: JsonValue | undefined;
      }
  );

type PendingFrameEnvelope =
  | {
      kind: "daemon";
      requestId: string;
    }
  | {
      kind: "mcp";
      requestId: string;
      id: JsonValue | undefined;
    };

type ParsedServeFrame =
  | {
      pending: PendingFrameEnvelope;
      request: GraphDaemonRequest;
    }
  | {
      directResponse: unknown;
    }
  | {
      noResponse: true;
    };

function parseServeFrame(line: string, repo: RepoIdentity): ParsedServeFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      directResponse: failureResponse("invalid-frame", schemaMismatchStatus(`graph serve frame JSON parse failed: ${errorMessage(error)}`))
    };
  }
  if (isJsonRpcRequest(parsed)) return parseMcpFrame(parsed, repo);
  if (isRecord(parsed) && parsed.protocol === "opcore.graph.daemon") {
    return daemonFrame(parsed, repo);
  }
  return {
    directResponse: failureResponse("invalid-frame", schemaMismatchStatus("graph serve frame must be GraphDaemonRequest or JSON-RPC request"))
  };
}

function parseMcpFrame(request: JsonRpcRequest, repo: RepoIdentity): ParsedServeFrame {
  if (isJsonRpcNotification(request)) return { noResponse: true };
  if (request.method === "initialize") {
    return {
      directResponse: {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "opcore-graph",
            version: "0.2.0"
          },
          capabilities: graphServeCapabilities
        }
      }
    };
  }
  const method = graphMethod(request.method);
  if (!method) {
    return { directResponse: jsonRpcError(request.id, -32600, `Unsupported opcore graph MCP method: ${request.method}`) };
  }
  const params = isRecord(request.params) ? request.params : {};
  const rawRequest = isRecord(params.request)
    ? params.request
    : daemonRequestFromMethod(method, requestIdFromJsonRpc(request), params, repo);
  const parsed = daemonFrame(rawRequest, repo);
  if ("directResponse" in parsed) {
    return {
      directResponse: jsonRpcError(request.id, -32600, "Invalid opcore graph MCP request", jsonRpcErrorData(parsed.directResponse))
    };
  }
  if ("noResponse" in parsed) return parsed;
  return {
    pending: {
      kind: "mcp",
      requestId: parsed.pending.requestId,
      id: request.id
    },
    request: parsed.request
  };
}

function daemonFrame(raw: Record<string, unknown>, repo: RepoIdentity): ParsedServeFrame {
  const requestId = typeof raw.requestId === "string" && raw.requestId.length > 0 ? raw.requestId : `serve-${Date.now()}`;
  const request = {
    ...raw,
    requestId,
    schemaVersion: raw.schemaVersion ?? 1,
    repo: repoIdentityOrDefault(raw.repo, repo),
    query: withNestedRepo(raw.query, repo, requestId),
    namedQuery: withNestedRepo(raw.namedQuery, repo, requestId),
    impact: withNestedRepo(raw.impact, repo, requestId),
    reviewContext: withNestedRepo(raw.reviewContext, repo, requestId),
    changes: withNestedRepo(raw.changes, repo, requestId),
    search: withNestedRepo(raw.search, repo, requestId)
  };
  try {
    return {
      pending: {
        kind: "daemon",
        requestId
      },
      request: validateGraphDaemonRequest(request as GraphDaemonRequest)
    };
  } catch (error) {
    return {
      directResponse: failureResponse(
        requestId,
        schemaMismatchStatus(`graph serve frame rejected: ${errorMessage(error)}`, typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0)
      )
    };
  }
}

function daemonRequestFromMethod(
  method: GraphServeMethod,
  requestId: string,
  params: Record<string, unknown>,
  repo: RepoIdentity
): Record<string, unknown> {
  const operation: GraphDaemonOperation = method === "query" || method === "search" ? "query" : method;
  const base = {
    protocol: "opcore.graph.daemon",
    requestId,
    schemaVersion: 1,
    operation,
    repo: repoIdentityOrDefault(params.repo, repo)
  };
  if (method === "query") {
    return {
      ...base,
      query: isRecord(params.query)
        ? params.query
        : {
            requestId,
            repo: base.repo,
            schemaVersion: 1,
            mode: "required",
            selector: {
              kind: "nodes",
              limit: typeof params.limit === "number" ? params.limit : undefined
            }
          }
    };
  }
  if (method === "search") {
    return {
      ...base,
      search: isRecord(params.search)
        ? params.search
        : {
            requestId,
            repo: base.repo,
            schemaVersion: 1,
            mode: "required",
            query: typeof params.query === "string" ? params.query : "",
            limit: typeof params.limit === "number" ? params.limit : undefined,
            files: Array.isArray(params.files) ? params.files : undefined
          }
    };
  }
  return base;
}

function withNestedRepo(value: unknown, repo: RepoIdentity, requestId: string): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    requestId: typeof value.requestId === "string" && value.requestId.length > 0 ? value.requestId : requestId,
    schemaVersion: value.schemaVersion ?? 1,
    mode: value.mode ?? "required",
    repo: repoIdentityOrDefault(value.repo, repo)
  };
}

function repoIdentityOrDefault(value: unknown, fallback: RepoIdentity): RepoIdentity {
  return isRecord(value) && (typeof value.repoRoot === "string" || typeof value.repoId === "string" || typeof value.remoteUrl === "string")
    ? (value as unknown as RepoIdentity)
    : fallback;
}

function decodeChildResponse(requestId: string, line: string, artifact: GraphServeResolvedArtifact): GraphDaemonResponse {
  try {
    return normalizeGraphCoreResponseArtifacts(validateGraphDaemonResponse(JSON.parse(line)), artifact);
  } catch (error) {
    return failureResponse(requestId, schemaMismatchStatus(`graph-core sidecar protocol decode failed: ${errorMessage(error)}`));
  }
}

function writeFrame(runtime: GraphServeTransportRuntime, frame: PendingFrame | undefined, response: GraphDaemonResponse): void {
  recordFrameTiming(runtime, frame, response);
  if (frame?.kind === "mcp") {
    writeRawFrame(runtime.stdout, {
      jsonrpc: "2.0",
      id: frame.id,
      result: response
    });
    return;
  }
  writeDaemonFrame(runtime.stdout, response);
}

function writeDaemonFrame(stdout: Writer, response: GraphDaemonResponse): void {
  writeRawFrame(stdout, validateGraphDaemonResponse(response));
}

function writeRawFrame(stdout: Writer, value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function timedPendingFrame(
  runtime: GraphServeTransportRuntime,
  pending: PendingFrameEnvelope,
  request: GraphDaemonRequest
): PendingFrame {
  const processState: CommandTimingProcessState = runtime.state.firstTimedFrame ? "cold" : "warm";
  runtime.state.firstTimedFrame = false;
  return {
    ...pending,
    request,
    startedAt: Date.now(),
    processState
  };
}

function recordFrameTiming(
  runtime: GraphServeTransportRuntime,
  frame: PendingFrame | undefined,
  response: GraphDaemonResponse
): void {
  if (!frame || !runtime.telemetry) return;
  const durationMs = elapsedMs(frame.startedAt);
  const status = serveFrameCommandStatus(frame.request, response);
  try {
    runtime.telemetry.recordFrameTiming({
      repo: frame.request.repo,
      request: frame.request,
      response,
      canonicalCommand: ["opcore", "graph", "serve", serveFrameOperation(frame.request)],
      owner: "graph",
      status,
      exitCode: status === "ok" ? 0 : 1,
      timing: {
        durationMs,
        processState: frame.processState,
        phases: [
          {
            phase: `serve_${serveFrameOperation(frame.request).replaceAll("-", "_")}`,
            durationMs
          }
        ]
      }
    });
  } catch {
    // Serve telemetry is trend evidence only; transport responses must not depend on artifact writes.
  }
}

function serveFrameOperation(request: GraphDaemonRequest): string {
  if (request.search) return "search";
  if (request.namedQuery) return "named-query";
  if (request.impact) return "impact";
  if (request.reviewContext) return "review-context";
  if (request.changes) return "detect-changes";
  return request.operation;
}

function serveFrameCommandStatus(request: GraphDaemonRequest, response: GraphDaemonResponse): CommandRouteStatus {
  const state = responseStatusForRequest(request, response).state;
  if (pipelineServeOperations.has(request.operation)) return okWhenStateIs(state, ["available", "warming"]);
  if (statusLikeServeOperations.has(request.operation)) return okWhenStateIs(state, ["available", "warming", "stale"]);
  return okWhenStateIs(state, ["available"]);
}

function responseStatusForRequest(request: GraphDaemonRequest, response: GraphDaemonResponse): GraphProviderStatus {
  const candidateStatuses: Array<[unknown, GraphProviderStatus | undefined]> = [
    [request.search, response.search?.status],
    [request.namedQuery, response.namedQuery?.status],
    [request.impact, response.impact?.status],
    [request.reviewContext, response.reviewContext?.status],
    [request.changes, response.changes?.status],
    [request.query, response.result?.status]
  ];
  for (const [requested, status] of candidateStatuses) {
    if (requested && status) return status;
  }
  if (response.pipeline) return response.pipeline.status;
  return response.status;
}

function okWhenStateIs(state: GraphProviderStatus["state"], okStates: readonly GraphProviderStatus["state"][]): CommandRouteStatus {
  return okStates.includes(state) ? "ok" : "error";
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function failureResponse(requestId: string, status: GraphProviderStatus): GraphDaemonResponse {
  return validateGraphDaemonResponse({
    protocol: "opcore.graph.daemon",
    requestId,
    schemaVersion: 1,
    status
  });
}

function jsonRpcError(id: JsonValue | undefined, code: number, message: string, data?: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      data:
        data ??
        {
          status: schemaMismatchStatus(message)
        }
    }
  };
}

function jsonRpcErrorData(response: unknown): unknown {
  return isRecord(response) && isRecord(response.status)
    ? {
        status: response.status
      }
    : response;
}

function readLines(
  stream: Readable,
  onLine: (line: string) => void,
  onEnd: () => void,
  onError: (error: Error) => void
): void {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) onLine(line.trim());
    }
  });
  stream.on("end", () => {
    if (buffer.trim().length > 0) onLine(buffer.trim());
    onEnd();
  });
  stream.on("error", onError);
}

function parseServeOptions(args: readonly string[], cwd: string): { repo: RepoIdentity } {
  let repoRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "serve") continue;
    if (arg === "--repo") repoRoot = requiredValue(args, ++index, "--repo");
    else if (arg.startsWith("--repo=")) repoRoot = inlineValue(arg, "--repo");
    else if (arg === "--json") continue;
    else if (arg.startsWith("-")) throw new Error(`unsupported graph serve option: ${arg}`);
  }
  return {
    repo: {
      repoRoot: resolve(repoRoot ?? cwd)
    }
  };
}

function graphServeStatusFromResolution(repo: RepoIdentity, resolution: GraphServeArtifactResolution): GraphServeTransportStatus {
  if (!resolution.ok) return graphServeErrorStatus(repo, resolution.status);
  return validateGraphServeTransportStatus({
    schemaVersion: 1,
    protocol: "opcore.graph.daemon",
    transport: "stdio",
    state: "ready",
    repo,
    provider: "opcore-graph",
    pid: process.pid,
    artifact: artifactMetadata(resolution.artifact),
    message: "graph serve stdio transport ready"
  });
}

function graphServeErrorStatus(repo: RepoIdentity, providerStatus: GraphProviderStatus): GraphServeTransportStatus {
  const failure =
    "failure" in providerStatus && providerStatus.failure
      ? providerStatus.failure
      : {
          category: "unknown" as const,
          message: providerStatus.message ?? "graph serve transport unavailable"
        };
  return validateGraphServeTransportStatus({
    schemaVersion: 1,
    protocol: "opcore.graph.daemon",
    transport: "stdio",
    state: "error",
    repo,
    provider: "opcore-graph",
    failure,
    message: providerStatus.message ?? failure.message
  });
}

function artifactMetadata(artifact: GraphServeResolvedArtifact): GraphProviderArtifactMetadata {
  return {
    artifactName: artifact.artifactName,
    artifactVersion: artifact.artifactVersion,
    targetPlatform: artifact.targetPlatform,
    binaryPath: artifact.binaryPath,
    checksumPath: artifact.checksumPath,
    checksumSha256: artifact.checksumSha256,
    buildProfile: artifact.buildProfile
  };
}

type GraphServeMethod = "ping" | "status" | "query" | "search" | "shutdown";

function graphMethod(method: string): GraphServeMethod | undefined {
  const normalized = method.startsWith("opcore.graph/") ? method.slice("opcore.graph/".length) : method;
  if (["ping", "status", "query", "search", "shutdown"].includes(normalized)) return normalized as GraphServeMethod;
  return undefined;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonValue;
  method: string;
  params?: unknown;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

function isJsonRpcNotification(request: JsonRpcRequest): boolean {
  return !Object.prototype.hasOwnProperty.call(request, "id");
}

function requestIdFromJsonRpc(request: JsonRpcRequest): string {
  if (typeof request.id === "string" && request.id.length > 0) return request.id;
  if (typeof request.id === "number") return `mcp-${request.id}`;
  return `mcp-${Date.now()}`;
}

function firstRouteArg(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function inlineValue(arg: string, flag: string): string {
  const value = arg.slice(`${flag}=`.length);
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
