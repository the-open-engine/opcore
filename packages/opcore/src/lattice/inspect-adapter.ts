import { isAbsolute, relative, resolve } from "node:path";
import type {
  CommandAdapter,
  CommandAdapterRequest,
  CommandRouterResult,
  CommandRouteStatus,
  GraphFactQuerySelector,
  GraphFactQueryResult,
  GraphProviderStatus,
  InspectFailureCategory,
  InspectRouteFailure,
  InspectRouteResult,
  InspectSymbolTarget,
  RepoIdentity
} from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult } from "@the-open-engine/opcore-contracts";
import {
  graphProviderQuery,
  graphProviderSearch
} from "@the-open-engine/opcore-graph";
import {
  isSupportedInspectImplementationSourcePath,
  isSupportedInspectSourcePath,
  resolveInspectImplementations,
  resolveInspectReferences,
  resolveInspectSignatures
} from "./inspect-language-service.js";

declare const process: {
  cwd(): string;
};

export const inspectCommandAdapter: CommandAdapter = (request) => {
  try {
    const options = parseInspectOptions(request.args);
    if (options.route === "symbols") return inspectSymbolsResult(request, options);
    if (options.route === "definition") return inspectDefinitionResult(request, options);
    if (options.route === "references") return inspectReferencesResult(request, options);
    if (options.route === "signature") return inspectSignatureResult(request, options);
    if (options.route === "implementations") return inspectImplementationsResult(request, options);
    if (options.route === "search") return inspectSearchResult(request, options);
    return createCommandRouterResult({
      bin: request.bin,
      argv: request.argv,
      canonicalCommand: request.canonicalCommand,
      owner: "inspect",
      status: "unsupported",
      json: request.json,
      message: `${request.canonicalCommand.join(" ")} is not a supported inspect route.`
    });
  } catch (error) {
    return createCommandRouterResult({
      bin: request.bin,
      argv: request.argv,
      canonicalCommand: request.canonicalCommand,
      owner: "inspect",
      status: "error",
      json: request.json,
      message: errorMessage(error)
    });
  }
};

interface InspectOptions {
  route?: string;
  repo: RepoIdentity;
  repoRoot: string;
  target?: string;
  query?: string;
  referenceParts: readonly string[];
  files?: readonly string[];
  limit?: number;
  line?: number;
  column?: number;
  malformedTarget?: string;
}

function inspectSymbolsResult(request: CommandAdapterRequest, options: InspectOptions): CommandRouterResult {
  const selector: GraphFactQuerySelector = {
    kind: "symbols",
    ...(options.target ? { text: options.target } : {}),
    ...(options.limit ? { limit: options.limit } : {})
  };
  const graphQuery = graphProviderQuery(options.repo, selector);
  return inspectQueryResult(request, graphQuery.status, "symbols", { graphQuery });
}

function inspectDefinitionResult(request: CommandAdapterRequest, options: InspectOptions): CommandRouterResult {
  if (!options.target) throw new Error("lattice inspect definition requires a target");
  const selector: GraphFactQuerySelector = symbolTargetSelector(options.target, options.limit ?? 1);
  const graphQuery = graphProviderQuery(options.repo, selector);
  return inspectQueryResult(request, graphQuery.status, "definition", { graphQuery });
}

function inspectReferencesResult(request: CommandAdapterRequest, options: InspectOptions): CommandRouterResult {
  const target = parseInspectSymbolTarget(options, "references");
  if (!target.ok) return inspectFailureResult(request, "references", "malformed_target", target.message);
  if (target.target.kind === "node") return inspectNodeReferencesResult(request, options, target.target);
  return inspectFileSymbolReferencesResult(request, options, target.target);
}

function inspectSignatureResult(request: CommandAdapterRequest, options: InspectOptions): CommandRouterResult {
  const target = parseInspectSymbolTarget(options, "signature");
  if (!target.ok) return inspectFailureResult(request, "signature", "malformed_target", target.message);
  if (target.target.kind === "node") return inspectNodeSignatureResult(request, options, target.target);
  return inspectFileSymbolSignatureResult(request, options, target.target);
}

function inspectNodeReferencesResult(request: CommandAdapterRequest, options: InspectOptions, target: InspectSymbolTarget): CommandRouterResult {
  const nodeId = target.nodeId;
  if (!nodeId) return inspectFailureResult(request, "references", "malformed_target", "lattice inspect references node target requires nodeId");
  const graphQuery = graphProviderQuery(options.repo, {
    kind: "symbols",
    ids: [nodeId],
    limit: options.limit ?? 1
  });
  if (graphQuery.status.state !== "available") {
    return inspectFailureResult(
      request,
      "references",
      "graph_unavailable",
      graphQuery.status.message ?? `Graph provider is ${graphQuery.status.state}`,
      graphQuery.status,
      target,
      graphQuery
    );
  }
  if (!("nodes" in graphQuery) || graphQuery.nodes.length === 0) {
    return inspectFailureResult(request, "references", "target_not_found", `Inspect references node target not found: ${nodeId}`, graphQuery.status, target, graphQuery);
  }
  const candidate = graphQuery.nodes[0];
  const parsed = graphNodeTarget(candidate.id, candidate.path, candidate.name);
  if (!parsed) {
    return inspectFailureResult(request, "references", "target_not_found", `Inspect references node target is not a supported class/function/type node: ${nodeId}`, graphQuery.status, target, graphQuery);
  }
  if (!isSupportedInspectSourcePath(parsed.path)) {
    return inspectFailureResult(request, "references", "unsupported_language", `Unsupported inspect references target language: ${parsed.path}`, graphQuery.status, target, graphQuery);
  }
  const resolution = resolveInspectReferences(options.repoRoot, {
    path: parsed.path,
    symbolName: parsed.symbolName,
    line: options.line,
    column: options.column,
    limit: options.limit,
    graphTargetOnly: true,
    graphNodeIds: [candidate.id],
    graphCandidates: [candidate],
    graphKind: candidate.kind,
    graphSymbolName: candidate.name ?? parsed.symbolName
  });
  if (!resolution.ok) {
    return inspectFailureResult(request, "references", resolution.category, resolution.message, graphQuery.status, resolution.target ?? target, graphQuery, {
      candidates: resolution.candidates
    });
  }
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: request.json,
    message: "lattice inspect references: language service returned read-only references.",
    providerStatus: graphQuery.status,
    graphQuery,
    inspectResult: {
      route: "references",
      status: "ok",
      target: resolution.target,
      providerStatus: graphQuery.status,
      references: resolution.references
    }
  });
}

function inspectFileSymbolReferencesResult(
  request: CommandAdapterRequest,
  options: InspectOptions,
  target: InspectSymbolTarget
): CommandRouterResult {
  const graphQuery = graphProviderQuery(options.repo, { kind: "symbols" });
  if (graphQuery.status.state !== "available") {
    return inspectFailureResult(
      request,
      "references",
      "graph_unavailable",
      graphQuery.status.message ?? `Graph provider is ${graphQuery.status.state}`,
      graphQuery.status,
      target,
      graphQuery
    );
  }
  if (!target.path || !target.symbolName) {
    return inspectFailureResult(request, "references", "malformed_target", "lattice inspect references requires <file> <symbol>");
  }
  if (!isSupportedInspectSourcePath(target.path)) {
    return inspectFailureResult(request, "references", "unsupported_language", `Unsupported inspect references target language: ${target.path}`, graphQuery.status, target, graphQuery);
  }
  if (!("nodes" in graphQuery)) {
    return inspectFailureResult(request, "references", "graph_unavailable", "Graph provider returned no symbol nodes", graphQuery.status, target, graphQuery);
  }
  const resolution = resolveInspectReferences(options.repoRoot, {
    path: target.path,
    symbolName: target.symbolName,
    line: options.line,
    column: options.column,
    limit: options.limit,
    graphNodeIds: graphQuery.nodes.map((node) => node.id),
    graphCandidates: graphQuery.nodes
  });
  if (!resolution.ok) {
    return inspectFailureResult(request, "references", resolution.category, resolution.message, graphQuery.status, resolution.target ?? target, graphQuery, {
      candidates: resolution.candidates
    });
  }
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: request.json,
    message: "lattice inspect references: language service returned read-only references.",
    providerStatus: graphQuery.status,
    graphQuery,
    inspectResult: {
      route: "references",
      status: "ok",
      target: resolution.target,
      providerStatus: graphQuery.status,
      references: resolution.references
    }
  });
}

function inspectNodeSignatureResult(request: CommandAdapterRequest, options: InspectOptions, target: InspectSymbolTarget): CommandRouterResult {
  const nodeId = target.nodeId;
  if (!nodeId) return inspectFailureResult(request, "signature", "malformed_target", "lattice inspect signature node target requires nodeId");
  const graphQuery = graphProviderQuery(options.repo, {
    kind: "symbols",
    ids: [nodeId],
    limit: options.limit ?? 1
  });
  if (graphQuery.status.state !== "available") {
    return inspectFailureResult(
      request,
      "signature",
      "graph_unavailable",
      graphQuery.status.message ?? `Graph provider is ${graphQuery.status.state}`,
      graphQuery.status,
      target,
      graphQuery
    );
  }
  if (!("nodes" in graphQuery) || graphQuery.nodes.length === 0) {
    return inspectFailureResult(request, "signature", "target_not_found", `Inspect signature node target not found: ${nodeId}`, graphQuery.status, target, graphQuery);
  }
  const candidate = graphQuery.nodes[0];
  const parsed = graphNodeTarget(candidate.id, candidate.path, candidate.name);
  if (!parsed) {
    return inspectFailureResult(request, "signature", "target_not_found", `Inspect signature node target is not a supported class/function/type node: ${nodeId}`, graphQuery.status, target, graphQuery);
  }
  if (!isSupportedInspectSourcePath(parsed.path)) {
    return inspectFailureResult(request, "signature", "unsupported_language", `Unsupported inspect signature target language: ${parsed.path}`, graphQuery.status, target, graphQuery);
  }
  const resolution = resolveInspectSignatures(options.repoRoot, {
    path: parsed.path,
    symbolName: parsed.symbolName,
    limit: options.limit,
    graphTargetOnly: true,
    graphNodeIds: [candidate.id],
    graphCandidates: [candidate],
    graphKind: candidate.kind,
    graphSymbolName: candidate.name ?? parsed.symbolName
  });
  if (!resolution.ok) {
    return inspectFailureResult(request, "signature", resolution.category, resolution.message, graphQuery.status, target, graphQuery, {
      candidates: resolution.candidates
    });
  }
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: request.json,
    message: "lattice inspect signature: language service returned read-only signatures.",
    providerStatus: graphQuery.status,
    graphQuery,
    inspectResult: {
      route: "signature",
      status: "ok",
      target,
      providerStatus: graphQuery.status,
      signatures: resolution.signatures
    }
  });
}

function inspectFileSymbolSignatureResult(
  request: CommandAdapterRequest,
  options: InspectOptions,
  target: InspectSymbolTarget
): CommandRouterResult {
  const graphQuery = graphProviderQuery(options.repo, { kind: "symbols" });
  if (graphQuery.status.state !== "available") {
    return inspectFailureResult(
      request,
      "signature",
      "graph_unavailable",
      graphQuery.status.message ?? `Graph provider is ${graphQuery.status.state}`,
      graphQuery.status,
      target,
      graphQuery
    );
  }
  if (!target.path || !target.symbolName) {
    return inspectFailureResult(request, "signature", "malformed_target", "lattice inspect signature requires <file> <symbol>");
  }
  if (!isSupportedInspectSourcePath(target.path)) {
    return inspectFailureResult(request, "signature", "unsupported_language", `Unsupported inspect signature target language: ${target.path}`, graphQuery.status, target, graphQuery);
  }
  if (!("nodes" in graphQuery)) {
    return inspectFailureResult(request, "signature", "graph_unavailable", "Graph provider returned no symbol nodes", graphQuery.status, target, graphQuery);
  }
  const resolution = resolveInspectSignatures(options.repoRoot, {
    path: target.path,
    symbolName: target.symbolName,
    line: options.line,
    column: options.column,
    limit: options.limit,
    graphNodeIds: graphQuery.nodes.map((node) => node.id),
    graphCandidates: graphQuery.nodes
  });
  if (!resolution.ok) {
    return inspectFailureResult(request, "signature", resolution.category, resolution.message, graphQuery.status, resolution.target ?? target, graphQuery, {
      candidates: resolution.candidates
    });
  }
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: request.json,
    message: "lattice inspect signature: language service returned read-only signatures.",
    providerStatus: graphQuery.status,
    graphQuery,
    inspectResult: {
      route: "signature",
      status: "ok",
      target: resolution.target,
      providerStatus: graphQuery.status,
      signatures: resolution.signatures
    }
  });
}

function inspectImplementationsResult(request: CommandAdapterRequest, options: InspectOptions): CommandRouterResult {
  const target = parseInspectSymbolTarget(options, "implementations");
  if (!target.ok) return inspectFailureResult(request, "implementations", "malformed_target", target.message);
  const graphQuery = graphProviderQuery(options.repo, { kind: "symbols" });
  if (graphQuery.status.state !== "available") {
    return inspectFailureResult(
      request,
      "implementations",
      "graph_unavailable",
      graphQuery.status.message ?? `Graph provider is ${graphQuery.status.state}`,
      graphQuery.status,
      target.target,
      graphQuery
    );
  }
  if (!("nodes" in graphQuery) || !("edges" in graphQuery)) {
    return inspectFailureResult(request, "implementations", "graph_unavailable", "Graph provider returned no symbol facts", graphQuery.status, target.target, graphQuery);
  }
  if (!graphQuery.metadata.edgeKinds.includes("IMPLEMENTS") || !graphQuery.metadata.edgeKinds.includes("INHERITS")) {
    return inspectFailureResult(
      request,
      "implementations",
      "graph_unavailable",
      "Graph provider does not advertise IMPLEMENTS and INHERITS facts required for inspect implementations",
      graphQuery.status,
      target.target,
      graphQuery
    );
  }
  if (target.target.kind === "file_symbol" && target.target.path && !isSupportedInspectImplementationSourcePath(target.target.path)) {
    return inspectFailureResult(
      request,
      "implementations",
      "unsupported_language",
      `Unsupported inspect implementations target language: ${target.target.path}`,
      graphQuery.status,
      target.target,
      graphQuery
    );
  }
  const resolution = resolveInspectImplementations(options.repoRoot, {
    target: target.target,
    graphCandidates: graphQuery.nodes,
    graphEdges: graphQuery.edges,
    limit: options.limit
  });
  if (!resolution.ok) {
    return inspectFailureResult(request, "implementations", resolution.category, resolution.message, graphQuery.status, resolution.target ?? target.target, graphQuery, {
      candidates: resolution.candidates
    });
  }
  const result = createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: request.json,
    message: "lattice inspect implementations: language service returned read-only implementation evidence.",
    providerStatus: graphQuery.status,
    graphQuery,
    inspectResult: {
      route: "implementations",
      status: "ok",
      target: resolution.target,
      providerStatus: graphQuery.status,
      implementations: resolution.implementations
    }
  });
  delete result.editPlan;
  delete result.editResult;
  delete result.validationResult;
  delete result.receipt;
  return result;
}

function inspectSearchResult(request: CommandAdapterRequest, options: InspectOptions): CommandRouterResult {
  if (!options.query) throw new Error("lattice inspect search requires query text");
  const graphSearch = graphProviderSearch(options.repo, {
    query: options.query,
    files: options.files,
    limit: options.limit
  });
  return inspectQueryResult(request, graphSearch.status, "search", { graphSearch });
}

function inspectQueryResult(
  request: CommandAdapterRequest,
  providerStatus: GraphProviderStatus,
  route: string,
  payload: Pick<CommandRouterResult, "graphQuery" | "graphSearch">
): CommandRouterResult {
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: inspectStatus(providerStatus),
    json: request.json,
    message:
      providerStatus.state === "available"
        ? `lattice inspect ${route}: graph provider returned read-only results.`
        : (providerStatus.message ?? `lattice inspect ${route}: graph provider returned ${providerStatus.state}.`),
    providerStatus,
    ...payload
  });
}

function inspectFailureResult(
  request: CommandAdapterRequest,
  route: InspectRouteResult["route"],
  category: InspectFailureCategory,
  message: string,
  providerStatus?: GraphProviderStatus,
  target?: InspectSymbolTarget,
  graphQuery?: GraphFactQueryResult,
  options: { candidates?: readonly InspectSymbolTarget[] } = {}
): CommandRouterResult {
  const failure: InspectRouteFailure = {
    category,
    message,
    ...(options.candidates ? { candidates: options.candidates } : {})
  };
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: "error",
    json: request.json,
    message,
    providerStatus,
    graphQuery,
    inspectResult: {
      route,
      status: "error",
      ...(target ? { target } : {}),
      ...(providerStatus ? { providerStatus } : {}),
      failure
    }
  });
}

function inspectStatus(status: GraphProviderStatus): CommandRouteStatus {
  return status.state === "available" ? "ok" : "error";
}

function symbolTargetSelector(target: string, limit: number): GraphFactQuerySelector {
  if (target.includes(":") && target.includes("#")) {
    return {
      kind: "symbols",
      ids: [target],
      limit
    };
  }
  return {
    kind: "symbols",
    text: target,
    limit
  };
}

function graphNodeTarget(
  nodeId: string,
  path: string | undefined,
  name: string | undefined
): { path: string; symbolName: string } | undefined {
  const parsed = /^(?:class|function|type):(.+)#([^#]+)$/.exec(nodeId);
  const targetPath = path ?? parsed?.[1];
  const symbolName = name ?? parsed?.[2];
  if (!targetPath || !symbolName) return undefined;
  return { path: targetPath, symbolName };
}

function parseInspectSymbolTarget(
  options: InspectOptions,
  route: "references" | "signature" | "implementations"
): { ok: true; target: InspectSymbolTarget } | { ok: false; message: string } {
  if (options.malformedTarget !== undefined) return { ok: false, message: options.malformedTarget };
  if (options.referenceParts.length === 1 && options.line === undefined && options.column === undefined) {
    return { ok: true, target: { kind: "node", nodeId: options.referenceParts[0] } };
  }
  if (options.referenceParts.length === 2) {
    const path = normalizeReferencePath(options.repoRoot, options.referenceParts[0], route);
    if (!path.ok) return path;
    return {
      ok: true,
      target: {
        kind: "file_symbol",
        path: path.value,
        symbolName: options.referenceParts[1],
        ...(options.line !== undefined ? { line: options.line } : {}),
        ...(options.column !== undefined ? { column: options.column } : {})
      }
    };
  }
  return {
    ok: false,
    message: `lattice inspect ${route} requires <node-id> or <file> <symbol> with optional --line and --column`
  };
}

function parseInspectOptions(args: readonly string[]): InspectOptions {
  const positionals: string[] = [];
  const files: string[] = [];
  let repoRoot: string | undefined;
  let limit: number | undefined;
  let line: number | undefined;
  let column: number | undefined;
  let malformedTarget: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") repoRoot = requiredValue(args, ++index, "--repo");
    else if (arg.startsWith("--repo=")) repoRoot = inlineValue(arg, "--repo");
    else if (arg === "--limit") limit = positiveNumber(requiredValue(args, ++index, "--limit"), "--limit");
    else if (arg.startsWith("--limit=")) limit = positiveNumber(inlineValue(arg, "--limit"), "--limit");
    else if (arg === "--line") line = inspectPositionNumber(requiredValue(args, ++index, "--line"), "--line", (message) => (malformedTarget = message));
    else if (arg.startsWith("--line=")) line = inspectPositionNumber(inlineValue(arg, "--line"), "--line", (message) => (malformedTarget = message));
    else if (arg === "--column") column = inspectPositionNumber(requiredValue(args, ++index, "--column"), "--column", (message) => (malformedTarget = message));
    else if (arg.startsWith("--column=")) column = inspectPositionNumber(inlineValue(arg, "--column"), "--column", (message) => (malformedTarget = message));
    else if (arg === "--files") files.push(...splitPaths(requiredValue(args, ++index, "--files")));
    else if (arg.startsWith("--files=")) files.push(...splitPaths(inlineValue(arg, "--files")));
    else if (!arg.startsWith("-")) positionals.push(arg);
    else if (arg.startsWith("--")) throw new Error(`unsupported inspect option: ${arg}`);
  }
  const [route, ...rest] = positionals;
  const text = rest.join(" ").trim();
  if (column !== undefined && line === undefined) malformedTarget = `--column requires --line for lattice inspect ${route ?? "references"}`;
  const resolvedRepoRoot = repoRoot ?? process.cwd();
  return {
    route,
    repo: { repoRoot: resolvedRepoRoot },
    repoRoot: resolvedRepoRoot,
    target: text.length > 0 ? text : undefined,
    query: text.length > 0 ? text : undefined,
    referenceParts: rest,
    files: files.length > 0 ? files : undefined,
    limit,
    line,
    column,
    malformedTarget
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

function inspectPositionNumber(value: string, flag: string, setError: (message: string) => void): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    setError(`${flag} must be a positive integer`);
    return undefined;
  }
  return parsed;
}

function normalizeReferencePath(repoRoot: string, rawPath: string, route: string): { ok: true; value: string } | { ok: false; message: string } {
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(repoRoot, rawPath);
  const normalizedRepoRoot = resolve(repoRoot);
  const relativePath = relative(normalizedRepoRoot, absolute).replaceAll("\\", "/");
  if (relativePath.length === 0 || relativePath.startsWith("../") || relativePath === ".." || /^[A-Za-z]:/.test(relativePath)) {
    return { ok: false, message: `Inspect ${route} target path escapes repository: ${rawPath}` };
  }
  return { ok: true, value: relativePath };
}

function splitPaths(value: string): string[] {
  return value
    .split(/[,:]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
