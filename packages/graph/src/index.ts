#!/usr/bin/env node
import type {
  CommandAdapterRequest,
  CommandRouterResult,
  CommandRouteStatus,
  GraphDaemonRequest,
  GraphDaemonResponse,
  GraphFactQuerySelector,
  GraphFactQueryResult,
  GraphImpactResult,
  GraphNamedQueryKind,
  GraphNamedQueryResult,
  GraphPipelineResult,
  GraphProviderFailureStatus,
  RepoIdentity,
  GraphProviderStatus,
  GraphDetectChangesResult,
  GraphReviewContextResult,
  GraphSearchResult
} from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult, graphNamedQueryKinds } from "@the-open-engine/opcore-contracts";
import { providerFailureStatus } from "./artifact.js";
import { graphServeRouterResult, isServeTransportArgv, runGraphServeCli } from "./serve.js";
import { invokeGraphCoreSidecar } from "./sidecar.js";

declare const process: {
  argv: string[];
  exitCode?: number;
  cwd(): string;
};

export { resolveGraphCoreArtifact, resolveGraphCoreArtifactForTarget } from "./artifact.js";
export {
  graphCoreNativePackageNameForTarget,
  graphCoreNativePackageNamesByTarget,
  graphCoreSupportedTargets,
  isSupportedGraphCoreTarget,
  type GraphCoreNativePackageName,
  type GraphCoreSupportedTarget
} from "./native-targets.js";
export { invokeGraphCoreSidecar } from "./sidecar.js";
export { graphServeRouterResult, isServeTransportArgv, runGraphServeCli } from "./serve.js";
export type { GraphServeFrameTimingEvent, GraphServeTelemetry } from "./serve.js";

export const graphProviderName = "opcore-graph";
export const graphProviderSchemaVersion = 1;

export function graphProviderStatus(
  repo: RepoIdentity | string = { repoRoot: process.cwd() },
  options: { paths?: readonly string[]; watchPaths?: readonly string[] } = {}
): GraphProviderStatus {
  const identity = repoIdentity(repo);
  return invokeGraphCoreSidecar({
    protocol: "opcore.graph.daemon",
    requestId: "graph-status",
    schemaVersion: graphProviderSchemaVersion,
    operation: "status",
    repo: identity,
    paths: options.paths,
    watchPaths: options.watchPaths
  }).status;
}

export function graphProviderBuild(
  repo: RepoIdentity | string = { repoRoot: process.cwd() },
  options: { paths?: readonly string[]; maxWalBytes?: number } = {}
): GraphPipelineResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    protocol: "opcore.graph.daemon",
    requestId: "graph-build",
    schemaVersion: graphProviderSchemaVersion,
    operation: "build",
    repo: identity,
    paths: options.paths,
    maxWalBytes: options.maxWalBytes
  });
  return requirePipeline("build", response);
}

export function graphProviderUpdate(
  repo: RepoIdentity | string = { repoRoot: process.cwd() },
  baseRef?: string,
  options: { paths?: readonly string[]; maxWalBytes?: number } = {}
): GraphPipelineResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    protocol: "opcore.graph.daemon",
    requestId: "graph-update",
    schemaVersion: graphProviderSchemaVersion,
    operation: "update",
    repo: identity,
    baseRef,
    paths: options.paths,
    maxWalBytes: options.maxWalBytes
  });
  return requirePipeline("update", response);
}

export function graphProviderWatch(
  repo: RepoIdentity | string = { repoRoot: process.cwd() },
  options: {
    watchPaths?: readonly string[];
    pollIntervalMs?: number;
    idleTimeoutMs?: number;
    once?: boolean;
    maxWalBytes?: number;
  } = {}
): GraphPipelineResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    protocol: "opcore.graph.daemon",
    requestId: "graph-watch",
    schemaVersion: graphProviderSchemaVersion,
    operation: "watch",
    repo: identity,
    watchPaths: options.watchPaths,
    pollIntervalMs: options.pollIntervalMs,
    idleTimeoutMs: options.idleTimeoutMs,
    once: options.once,
    maxWalBytes: options.maxWalBytes
  });
  return requirePipeline("watch", response);
}

export function graphProviderQuery(
  repo: RepoIdentity | string = { repoRoot: process.cwd() },
  selector: GraphFactQuerySelector = {
    kind: "nodes"
  }
): GraphFactQueryResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    protocol: "opcore.graph.daemon",
    requestId: "graph-query",
    schemaVersion: graphProviderSchemaVersion,
    operation: "query",
    repo: identity,
    query: {
      requestId: "graph-query",
      repo: identity,
      schemaVersion: graphProviderSchemaVersion,
      mode: "required",
      selector
    }
  });

  return response.result ?? {
    requestId: "graph-query",
    status: failureStatusFromResponse(response, "graph-core query returned no result")
  };
}

export function graphProviderNamedQuery(
  repo: RepoIdentity | string,
  options: { queryKind: GraphNamedQueryKind; target: string; maxDepth?: number; limit?: number }
): GraphNamedQueryResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    ...baseDaemonRequest("graph-named-query", "query", identity),
    namedQuery: {
      requestId: "graph-named-query",
      repo: identity,
      schemaVersion: graphProviderSchemaVersion,
      mode: "required",
      queryKind: options.queryKind,
      target: options.target,
      maxDepth: options.maxDepth,
      limit: options.limit
    }
  });
  return response.namedQuery ?? {
    requestId: "graph-named-query",
    status: failureStatusFromResponse(response, "graph-core named query returned no result")
  };
}

export function graphProviderImpact(
  repo: RepoIdentity | string,
  options: { files: readonly string[]; baseRef?: string; maxDepth?: number; limit?: number }
): GraphImpactResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    ...baseDaemonRequest("graph-impact", "query", identity),
    impact: {
      requestId: "graph-impact",
      repo: identity,
      schemaVersion: graphProviderSchemaVersion,
      mode: "required",
      files: options.files,
      baseRef: options.baseRef,
      maxDepth: options.maxDepth,
      limit: options.limit
    }
  });
  return response.impact ?? {
    requestId: "graph-impact",
    status: failureStatusFromResponse(response, "graph-core impact returned no result")
  };
}

export function graphProviderDetectChanges(
  repo: RepoIdentity | string,
  options: { files?: readonly string[]; baseRef?: string } = {}
): GraphDetectChangesResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    ...baseDaemonRequest("graph-detect-changes", "query", identity),
    changes: {
      requestId: "graph-detect-changes",
      repo: identity,
      schemaVersion: graphProviderSchemaVersion,
      mode: "required",
      files: options.files,
      baseRef: options.baseRef
    }
  });
  return response.changes ?? {
    requestId: "graph-detect-changes",
    status: failureStatusFromResponse(response, "graph-core detect-changes returned no result")
  };
}

export function graphProviderReviewContext(
  repo: RepoIdentity | string,
  options: { files?: readonly string[]; baseRef?: string; maxDepth?: number; limit?: number } = {}
): GraphReviewContextResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    ...baseDaemonRequest("graph-review-context", "query", identity),
    reviewContext: {
      requestId: "graph-review-context",
      repo: identity,
      schemaVersion: graphProviderSchemaVersion,
      mode: "required",
      files: options.files,
      baseRef: options.baseRef,
      maxDepth: options.maxDepth,
      limit: options.limit
    }
  });
  return response.reviewContext ?? {
    requestId: "graph-review-context",
    status: failureStatusFromResponse(response, "graph-core review-context returned no result")
  };
}

export function graphProviderSearch(
  repo: RepoIdentity | string,
  options: { query: string; files?: readonly string[]; limit?: number }
): GraphSearchResult {
  const identity = repoIdentity(repo);
  const response = invokeGraphCoreSidecar({
    ...baseDaemonRequest("graph-search", "query", identity),
    search: {
      requestId: "graph-search",
      repo: identity,
      schemaVersion: graphProviderSchemaVersion,
      mode: "required",
      query: options.query,
      files: options.files,
      limit: options.limit
    }
  });
  return response.search ?? {
    requestId: "graph-search",
    status: failureStatusFromResponse(response, "graph-core search returned no result")
  };
}

function failureStatusFromResponse(response: GraphDaemonResponse, message: string): GraphProviderFailureStatus {
  return response.status.state === "available"
    ? (unavailableStatus(message) as GraphProviderFailureStatus)
    : (response.status as GraphProviderFailureStatus);
}

function repoIdentity(repo: RepoIdentity | string): RepoIdentity {
  return typeof repo === "string" ? { repoRoot: repo } : repo;
}

export function unavailableStatus(message: string): GraphProviderStatus {
  return {
    state: "required_missing",
    mode: "required",
    provider: graphProviderName,
    schemaVersion: graphProviderSchemaVersion,
    message,
    failure: {
      category: "provider_missing",
      message
    }
  };
}

export function graphCommandAdapter(request: CommandAdapterRequest): CommandRouterResult {
  try {
    const route = firstRouteArg(request.args);
    if (route === "build") return graphPipelineResult(request, "build");
    if (route === "update") return graphPipelineResult(request, "update");
    if (route === "watch") return graphPipelineResult(request, "watch");
    if (route === "status") return graphStatusResult(request);
    if (route === "query") return graphQueryResult(request);
    if (route === "serve") return graphServeRouterResult(request);
    if (route === "impact") return graphImpactResult(request);
    if (route === "review-context") return graphReviewContextResult(request);
    if (route === "detect-changes") return graphDetectChangesResult(request);
    if (route === "search") return graphSearchResult(request);
    return graphNotImplementedResult(request);
  } catch (error) {
    return graphAdapterErrorResult(request, errorMessage(error));
  }
}

function graphStatusResult(request: CommandAdapterRequest): CommandRouterResult {
  const options = parseGraphOptions(request.args);
  const providerStatus = graphProviderStatus(options.repo, {
    paths: options.paths,
    watchPaths: options.paths
  });
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: statusCommandStatus(providerStatus),
    json: request.json,
    message: statusMessage(providerStatus),
    providerStatus
  });
}

function graphAdapterErrorResult(request: CommandAdapterRequest, message: string): CommandRouterResult {
  const providerStatus = providerFailureStatus("error", "unknown", message, "required");
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: "error",
    json: request.json,
    message,
    providerStatus
  });
}

function graphPipelineResult(
  request: CommandAdapterRequest,
  operation: "build" | "update" | "watch"
): CommandRouterResult {
  const options = parseGraphOptions(request.args);
  const response = invokeGraphCoreSidecar({
    ...baseDaemonRequest(`graph-${operation}`, operation, options.repo),
    baseRef: options.baseRef,
    paths: options.paths,
    watchPaths: options.paths,
    pollIntervalMs: options.pollIntervalMs,
    idleTimeoutMs: options.idleTimeoutMs,
    once: options.once,
    maxWalBytes: options.maxWalBytes
  });
  const graphPipeline = response.pipeline;
  const providerStatus = graphPipeline?.status ?? response.status;
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: pipelineCommandStatus(providerStatus),
    json: request.json,
    message: pipelineMessage(operation, providerStatus),
    providerStatus,
    graphPipeline
  });
}

function graphQueryResult(request: CommandAdapterRequest): CommandRouterResult {
  const options = parseGraphOptions(request.args);
  const result = options.namedQuery
    ? graphProviderNamedQuery(options.repo, options.namedQuery)
    : graphProviderQuery(options.repo, options.selector);
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: queryCommandStatus(result.status),
    json: request.json,
    message: queryMessage(result.status),
    providerStatus: result.status,
    graphQuery: result
  });
}

function graphImpactResult(request: CommandAdapterRequest): CommandRouterResult {
  const options = parseGraphOptions(request.args);
  const result = graphProviderImpact(options.repo, {
    files: options.files,
    baseRef: options.baseRef,
    maxDepth: options.maxDepth,
    limit: options.limit
  });
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: queryCommandStatus(result.status),
    json: request.json,
    message: impactMessage(result.status),
    providerStatus: result.status,
    graphImpact: result
  });
}

function graphReviewContextResult(request: CommandAdapterRequest): CommandRouterResult {
  const options = parseGraphOptions(request.args);
  const result = graphProviderReviewContext(options.repo, {
    files: options.files.length > 0 ? options.files : undefined,
    baseRef: options.baseRef,
    maxDepth: options.maxDepth,
    limit: options.limit
  });
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: queryCommandStatus(result.status),
    json: request.json,
    message: reviewContextMessage(result.status),
    providerStatus: result.status,
    graphReviewContext: result
  });
}

function graphDetectChangesResult(request: CommandAdapterRequest): CommandRouterResult {
  const options = parseGraphOptions(request.args);
  const result = graphProviderDetectChanges(options.repo, {
    files: options.files.length > 0 ? options.files : undefined,
    baseRef: options.baseRef
  });
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: queryCommandStatus(result.status),
    json: request.json,
    message: detectChangesMessage(result.status),
    providerStatus: result.status,
    graphChanges: result
  });
}

function graphSearchResult(request: CommandAdapterRequest): CommandRouterResult {
  const options = parseGraphOptions(request.args);
  if (!options.searchQuery) throw new Error("opcore graph search requires query text");
  const result = graphProviderSearch(options.repo, {
    query: options.searchQuery,
    files: options.files.length > 0 ? options.files : undefined,
    limit: options.limit
  });
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: queryCommandStatus(result.status),
    json: request.json,
    message: searchMessage(result.status),
    providerStatus: result.status,
    graphSearch: result
  });
}

function graphNotImplementedResult(request: CommandAdapterRequest): CommandRouterResult {
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "graph",
    status: "not_implemented",
    json: request.json,
    message: `${request.canonicalCommand.join(" ")} is routed to graph ownership and is not implemented in this package yet.`
  });
}

function statusMessage(status: GraphProviderStatus): string {
  if (status.state === "available") return "opcore graph status: graph-core sidecar available.";
  if (status.state === "warming") return "opcore graph status: graph-core pipeline warming.";
  if (status.state === "stale") return "opcore graph status: graph is stale. Run `opcore graph build`.";
  if (status.state === "schema_mismatch") return "opcore graph status: graph metadata needs rebuild. Run `opcore graph build`.";
  if (status.state === "required_missing" || status.state === "skipped") {
    return "opcore graph status: graph store is missing. Run `opcore graph build`.";
  }
  return status.message ?? "opcore graph status: graph-core sidecar unavailable.";
}

function pipelineMessage(operation: "build" | "update" | "watch", status: GraphProviderStatus): string {
  if (status.state === "available") return `opcore graph ${operation}: GraphProvider ${operation} complete.`;
  if (status.state === "warming") return `opcore graph ${operation}: GraphProvider warming.`;
  return status.message ?? `opcore graph ${operation}: GraphProvider returned ${status.state}.`;
}

function queryMessage(status: GraphProviderStatus): string {
  if (status.state === "available") {
    return "opcore graph query: graph-core returned graph data.";
  }
  return status.message ?? "opcore graph query: graph-core sidecar unavailable.";
}

function impactMessage(status: GraphProviderStatus): string {
  if (status.state === "available") return "opcore graph impact: graph-core returned impact data.";
  return status.message ?? "opcore graph impact: graph-core sidecar unavailable.";
}

function reviewContextMessage(status: GraphProviderStatus): string {
  if (status.state === "available") return "opcore graph review-context: graph-core returned review context.";
  return status.message ?? "opcore graph review-context: graph-core sidecar unavailable.";
}

function detectChangesMessage(status: GraphProviderStatus): string {
  if (status.state === "available") return "opcore graph detect-changes: graph-core returned change data.";
  return status.message ?? "opcore graph detect-changes: graph-core sidecar unavailable.";
}

function searchMessage(status: GraphProviderStatus): string {
  if (status.state === "available") return "opcore graph search: graph-core returned search results.";
  return status.message ?? "opcore graph search: graph-core sidecar unavailable.";
}

function firstRouteArg(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function baseDaemonRequest(
  requestId: string,
  operation: GraphDaemonRequest["operation"],
  repo: RepoIdentity
): GraphDaemonRequest {
  return {
    protocol: "opcore.graph.daemon",
    requestId,
    schemaVersion: graphProviderSchemaVersion,
    operation,
    repo
  };
}

function parseGraphOptions(args: readonly string[]): {
  repo: RepoIdentity;
  baseRef?: string;
  paths?: readonly string[];
  files: readonly string[];
  selector: GraphFactQuerySelector;
  namedQuery?: { queryKind: GraphNamedQueryKind; target: string; maxDepth?: number; limit?: number };
  searchQuery?: string;
  maxDepth?: number;
  limit?: number;
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  maxWalBytes?: number;
  once?: boolean;
} {
  const options: {
    repoRoot?: string;
    baseRef?: string;
    paths: string[];
    files: string[];
    selector: GraphFactQuerySelector;
    positionals: string[];
    maxDepth?: number;
    limit?: number;
    pollIntervalMs?: number;
    idleTimeoutMs?: number;
    maxWalBytes?: number;
    once?: boolean;
  } = { paths: [], files: [], selector: { kind: "nodes" }, positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") options.repoRoot = requiredValue(args, ++index, "--repo");
    else if (arg.startsWith("--repo=")) options.repoRoot = inlineValue(arg, "--repo");
    else if (arg === "--base") options.baseRef = requiredValue(args, ++index, "--base");
    else if (arg.startsWith("--base=")) options.baseRef = inlineValue(arg, "--base");
    else if (arg === "--paths") options.paths.push(...splitPaths(requiredValue(args, ++index, "--paths")));
    else if (arg.startsWith("--paths=")) options.paths.push(...splitPaths(inlineValue(arg, "--paths")));
    else if (arg === "--files") options.files.push(...splitPaths(requiredValue(args, ++index, "--files")));
    else if (arg.startsWith("--files=")) options.files.push(...splitPaths(inlineValue(arg, "--files")));
    else if (arg === "--kind") options.selector.kind = graphFactQueryKind(requiredValue(args, ++index, "--kind"));
    else if (arg.startsWith("--kind=")) options.selector.kind = graphFactQueryKind(inlineValue(arg, "--kind"));
    else if (arg === "--ids") options.selector.ids = splitPaths(requiredValue(args, ++index, "--ids"));
    else if (arg.startsWith("--ids=")) options.selector.ids = splitPaths(inlineValue(arg, "--ids"));
    else if (arg === "--edge-kinds") options.selector.edgeKinds = splitPaths(requiredValue(args, ++index, "--edge-kinds"));
    else if (arg.startsWith("--edge-kinds=")) options.selector.edgeKinds = splitPaths(inlineValue(arg, "--edge-kinds"));
    else if (arg === "--node-kinds") options.selector.nodeKinds = splitPaths(requiredValue(args, ++index, "--node-kinds"));
    else if (arg.startsWith("--node-kinds=")) options.selector.nodeKinds = splitPaths(inlineValue(arg, "--node-kinds"));
    else if (arg === "--text") options.selector.text = requiredValue(args, ++index, "--text");
    else if (arg.startsWith("--text=")) options.selector.text = inlineValue(arg, "--text");
    else if (arg === "--max-depth") options.maxDepth = nonNegativeNumber(requiredValue(args, ++index, "--max-depth"), "--max-depth");
    else if (arg.startsWith("--max-depth=")) options.maxDepth = nonNegativeNumber(inlineValue(arg, "--max-depth"), "--max-depth");
    else if (arg === "--limit") options.limit = positiveNumber(requiredValue(args, ++index, "--limit"), "--limit");
    else if (arg.startsWith("--limit=")) options.limit = positiveNumber(inlineValue(arg, "--limit"), "--limit");
    else if (arg === "--poll-interval-ms")
      options.pollIntervalMs = positiveNumber(requiredValue(args, ++index, "--poll-interval-ms"), "--poll-interval-ms");
    else if (arg.startsWith("--poll-interval-ms="))
      options.pollIntervalMs = positiveNumber(inlineValue(arg, "--poll-interval-ms"), "--poll-interval-ms");
    else if (arg === "--idle-timeout-ms")
      options.idleTimeoutMs = nonNegativeNumber(requiredValue(args, ++index, "--idle-timeout-ms"), "--idle-timeout-ms");
    else if (arg.startsWith("--idle-timeout-ms="))
      options.idleTimeoutMs = nonNegativeNumber(inlineValue(arg, "--idle-timeout-ms"), "--idle-timeout-ms");
    else if (arg === "--max-wal-bytes")
      options.maxWalBytes = positiveNumber(requiredValue(args, ++index, "--max-wal-bytes"), "--max-wal-bytes");
    else if (arg.startsWith("--max-wal-bytes="))
      options.maxWalBytes = positiveNumber(inlineValue(arg, "--max-wal-bytes"), "--max-wal-bytes");
    else if (arg === "--once") options.once = true;
    else if (!arg.startsWith("-")) options.positionals.push(arg);
    else if (arg.startsWith("--")) throw new Error(`unsupported graph option: ${arg}`);
  }
  if (options.limit !== undefined) options.selector.limit = options.limit;
  const [route, queryKind, target] = options.positionals;
  const searchQuery = route === "search" ? options.positionals.slice(1).join(" ").trim() : undefined;
  const namedQuery =
    route === "query" && isGraphNamedQueryKind(queryKind)
      ? {
          queryKind,
          target: target ?? "",
          maxDepth: options.maxDepth,
          limit: options.limit
        }
      : undefined;
  if (route === "query" && queryKind !== undefined && !namedQuery) {
    throw new Error(`unsupported graph named query: ${queryKind}`);
  }
  if (namedQuery && namedQuery.target.length === 0) throw new Error(`opcore graph query ${queryKind} requires a target`);
  return {
    repo: options.repoRoot ? { repoRoot: options.repoRoot } : { repoRoot: process.cwd() },
    baseRef: options.baseRef,
    paths: options.paths.length > 0 ? options.paths : undefined,
    files: options.files,
    selector: options.selector,
    namedQuery,
    searchQuery,
    maxDepth: options.maxDepth,
    limit: options.limit,
    pollIntervalMs: options.pollIntervalMs,
    idleTimeoutMs: options.idleTimeoutMs,
    maxWalBytes: options.maxWalBytes,
    once: options.once
  };
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

function positiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

function nonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

function graphFactQueryKind(value: string): GraphFactQuerySelector["kind"] {
  if (["nodes", "edges", "neighbors", "symbols", "impact"].includes(value)) {
    return value as GraphFactQuerySelector["kind"];
  }
  throw new Error(`unsupported graph fact query kind: ${value}`);
}

function isGraphNamedQueryKind(value: string | undefined): value is GraphNamedQueryKind {
  return typeof value === "string" && (graphNamedQueryKinds as readonly string[]).includes(value);
}

function splitPaths(value: string): string[] {
  return value
    .split(/[,:]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requirePipeline(operation: "build" | "update" | "watch", response: GraphDaemonResponse): GraphPipelineResult {
  if (response.pipeline) return response.pipeline;
  const message = response.status.message ?? `GraphProvider ${operation} returned ${response.status.state}`;
  throw new Error(message);
}

function pipelineCommandStatus(status: GraphProviderStatus): CommandRouteStatus {
  if (status.state === "available" || status.state === "warming") return "ok";
  return "error";
}

function statusCommandStatus(status: GraphProviderStatus): CommandRouteStatus {
  if (status.state === "available" || status.state === "warming" || status.state === "stale") return "ok";
  return "error";
}

function queryCommandStatus(status: GraphProviderStatus): CommandRouteStatus {
  return status.state === "available" ? "ok" : "error";
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
