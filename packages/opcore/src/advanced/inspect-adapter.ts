import { isAbsolute, relative, resolve } from "node:path";
import type {
  CommandAdapter,
  CommandAdapterRequest,
  CommandRouterResult,
  CommandRouteStatus,
  GraphFactEdge,
  GraphFactNode,
  GraphFactQuerySelector,
  GraphFactQueryResult,
  GraphProviderStatus,
  InspectFailureCategory,
  InspectReferenceEntry,
  InspectRouteFailure,
  InspectRouteResult,
  InspectSymbolTarget,
  InspectTextSpan,
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
  if (!options.target) throw new Error("opcore inspect definition requires a target");
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
  if (!nodeId) return inspectFailureResult(request, "references", "malformed_target", "opcore inspect references node target requires nodeId");
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
  if (isRustInspectSourcePath(parsed.path)) {
    return inspectRustGraphReferencesResult(request, options, target, candidate);
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
    message: "opcore inspect references: language service returned read-only references.",
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
  if (!target.path || !target.symbolName) {
    return inspectFailureResult(request, "references", "malformed_target", "opcore inspect references requires <file> <symbol>");
  }
  if (isRustInspectSourcePath(target.path)) {
    if (graphQuery.status.state !== "available") {
      return inspectFailureResult(
        request,
        "references",
        "graph_unavailable",
        graphUnavailableMessage(graphQuery.status),
        graphQuery.status,
        target,
        graphQuery
      );
    }
    return inspectRustFileSymbolReferencesResult(request, options, target, graphQuery);
  }
  if (!isSupportedInspectSourcePath(target.path)) {
    return inspectFailureResult(request, "references", "unsupported_language", `Unsupported inspect references target language: ${target.path}`, graphQuery.status, target, graphQuery);
  }
  if (graphQuery.status.state !== "available") {
    return inspectGraphlessReferencesResult({ request, options, target, graphQuery, degradationMessage: graphUnavailableMessage(graphQuery.status) });
  }
  if (!("nodes" in graphQuery)) {
    return inspectGraphlessReferencesResult({ request, options, target, graphQuery, degradationMessage: "Graph provider returned no symbol nodes" });
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
    message: "opcore inspect references: language service returned read-only references.",
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
  if (!nodeId) return inspectFailureResult(request, "signature", "malformed_target", "opcore inspect signature node target requires nodeId");
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
  if (isRustInspectSourcePath(parsed.path)) {
    return inspectUnsupportedRouteResult(
      request,
      "signature",
      "Rust inspect signature requires language-service materialization and is not supported yet.",
      graphQuery.status,
      graphTargetForNode(target, candidate),
      graphQuery
    );
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
    message: "opcore inspect signature: language service returned read-only signatures.",
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
  if (!target.path || !target.symbolName) {
    return inspectFailureResult(request, "signature", "malformed_target", "opcore inspect signature requires <file> <symbol>");
  }
  if (isRustInspectSourcePath(target.path)) {
    if (graphQuery.status.state !== "available") {
      return inspectFailureResult(
        request,
        "signature",
        "graph_unavailable",
        graphUnavailableMessage(graphQuery.status),
        graphQuery.status,
        target,
        graphQuery
      );
    }
    return inspectUnsupportedRouteResult(
      request,
      "signature",
      "Rust inspect signature requires language-service materialization and is not supported yet.",
      graphQuery.status,
      rustGraphCandidateForFileSymbol(graphQuery, target) ?? target,
      graphQuery
    );
  }
  if (!isSupportedInspectSourcePath(target.path)) {
    return inspectFailureResult(request, "signature", "unsupported_language", `Unsupported inspect signature target language: ${target.path}`, graphQuery.status, target, graphQuery);
  }
  if (graphQuery.status.state !== "available") {
    return inspectGraphlessSignatureResult({ request, options, target, graphQuery, degradationMessage: graphUnavailableMessage(graphQuery.status) });
  }
  if (!("nodes" in graphQuery)) {
    return inspectGraphlessSignatureResult({ request, options, target, graphQuery, degradationMessage: "Graph provider returned no symbol nodes" });
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
    message: "opcore inspect signature: language service returned read-only signatures.",
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
  if (target.target.kind === "file_symbol" && (!target.target.path || !target.target.symbolName)) {
    return inspectFailureResult(request, "implementations", "malformed_target", "opcore inspect implementations requires <file> <symbol>");
  }
  if (target.target.kind === "file_symbol" && target.target.path && isRustInspectSourcePath(target.target.path)) {
    if (graphQuery.status.state !== "available") {
      return inspectFailureResult(
        request,
        "implementations",
        "graph_unavailable",
        graphUnavailableMessage(graphQuery.status),
        graphQuery.status,
        target.target,
        graphQuery
      );
    }
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
  if (graphQuery.status.state !== "available") {
    if (target.target.kind === "file_symbol") {
      return inspectGraphlessImplementationsResult({ request, options, target: target.target, graphQuery, degradationMessage: graphUnavailableMessage(graphQuery.status) });
    }
    return inspectFailureResult(
      request,
      "implementations",
      "graph_unavailable",
      graphUnavailableMessage(graphQuery.status),
      graphQuery.status,
      target.target,
      graphQuery
    );
  }
  if (!("nodes" in graphQuery) || !("edges" in graphQuery)) {
    if (target.target.kind === "file_symbol") {
      return inspectGraphlessImplementationsResult({ request, options, target: target.target, graphQuery, degradationMessage: "Graph provider returned no symbol facts" });
    }
    return inspectFailureResult(request, "implementations", "graph_unavailable", "Graph provider returned no symbol facts", graphQuery.status, target.target, graphQuery);
  }
  const implementationNodeTarget =
    target.target.kind === "node" ? graphQuery.nodes.find((node) => node.id === target.target.nodeId) : undefined;
  if (implementationNodeTarget?.path && isRustInspectSourcePath(implementationNodeTarget.path)) {
    return inspectUnsupportedRouteResult(
      request,
      "implementations",
      "Rust inspect implementations requires language-service materialization and is not supported yet.",
      graphQuery.status,
      graphTargetForNode(target.target, implementationNodeTarget),
      graphQuery
    );
  }
  if (target.target.kind === "file_symbol" && target.target.path && isRustInspectSourcePath(target.target.path)) {
    return inspectUnsupportedRouteResult(
      request,
      "implementations",
      "Rust inspect implementations requires language-service materialization and is not supported yet.",
      graphQuery.status,
      rustGraphCandidateForFileSymbol(graphQuery, target.target) ?? target.target,
      graphQuery
    );
  }
  if (!graphQuery.metadata.edgeKinds.includes("IMPLEMENTS") || !graphQuery.metadata.edgeKinds.includes("INHERITS")) {
    if (target.target.kind === "file_symbol") {
      return inspectGraphlessImplementationsResult({
        request,
        options,
        target: target.target,
        graphQuery,
        degradationMessage: "Graph provider does not advertise IMPLEMENTS and INHERITS facts required for inspect implementations"
      });
    }
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
    message: "opcore inspect implementations: language service returned read-only implementation evidence.",
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
  if (!options.query) throw new Error("opcore inspect search requires query text");
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
        ? `opcore inspect ${route}: graph provider returned read-only results.`
        : (providerStatus.message ?? `opcore inspect ${route}: graph provider returned ${providerStatus.state}.`),
    providerStatus,
    ...payload
  });
}

interface GraphlessInspectArgs {
  request: CommandAdapterRequest;
  options: InspectOptions;
  target: InspectSymbolTarget;
  graphQuery: GraphFactQueryResult;
  degradationMessage: string;
}

function inspectGraphlessReferencesResult(args: GraphlessInspectArgs): CommandRouterResult {
  const resolution = resolveInspectReferences(args.options.repoRoot, {
    path: args.target.path ?? "",
    symbolName: args.target.symbolName ?? "",
    line: args.options.line,
    column: args.options.column,
    limit: args.options.limit,
    allowGraphless: true,
    graphNodeIds: [],
    graphCandidates: []
  });
  if (!resolution.ok) {
    return inspectFailureResult(args.request, "references", resolution.category, resolution.message, args.graphQuery.status, resolution.target ?? args.target, args.graphQuery, {
      candidates: resolution.candidates
    });
  }
  return createCommandRouterResult({
    bin: args.request.bin,
    argv: args.request.argv,
    canonicalCommand: args.request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: args.request.json,
    message: "opcore inspect references: language service returned degraded read-only references without fresh graph facts.",
    providerStatus: args.graphQuery.status,
    graphQuery: args.graphQuery,
    inspectResult: {
      route: "references",
      status: "degraded",
      target: resolution.target,
      providerStatus: args.graphQuery.status,
      failure: graphUnavailableFailure(args.degradationMessage),
      references: resolution.references
    }
  });
}

function inspectGraphlessSignatureResult(args: GraphlessInspectArgs): CommandRouterResult {
  const resolution = resolveInspectSignatures(args.options.repoRoot, {
    path: args.target.path ?? "",
    symbolName: args.target.symbolName ?? "",
    line: args.options.line,
    column: args.options.column,
    limit: args.options.limit,
    allowGraphless: true,
    graphNodeIds: [],
    graphCandidates: []
  });
  if (!resolution.ok) {
    return inspectFailureResult(args.request, "signature", resolution.category, resolution.message, args.graphQuery.status, resolution.target ?? args.target, args.graphQuery, {
      candidates: resolution.candidates
    });
  }
  return createCommandRouterResult({
    bin: args.request.bin,
    argv: args.request.argv,
    canonicalCommand: args.request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: args.request.json,
    message: "opcore inspect signature: language service returned degraded read-only signatures without fresh graph facts.",
    providerStatus: args.graphQuery.status,
    graphQuery: args.graphQuery,
    inspectResult: {
      route: "signature",
      status: "degraded",
      target: resolution.target,
      providerStatus: args.graphQuery.status,
      failure: graphUnavailableFailure(args.degradationMessage),
      signatures: resolution.signatures
    }
  });
}

function inspectGraphlessImplementationsResult(args: GraphlessInspectArgs): CommandRouterResult {
  const resolution = resolveInspectImplementations(args.options.repoRoot, {
    target: args.target,
    allowGraphless: true,
    graphCandidates: [],
    graphEdges: [],
    limit: args.options.limit
  });
  if (!resolution.ok) {
    return inspectFailureResult(args.request, "implementations", resolution.category, resolution.message, args.graphQuery.status, resolution.target ?? args.target, args.graphQuery, {
      candidates: resolution.candidates
    });
  }
  const result = createCommandRouterResult({
    bin: args.request.bin,
    argv: args.request.argv,
    canonicalCommand: args.request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: args.request.json,
    message: "opcore inspect implementations: language service returned degraded read-only implementation evidence without fresh graph facts.",
    providerStatus: args.graphQuery.status,
    graphQuery: args.graphQuery,
    inspectResult: {
      route: "implementations",
      status: "degraded",
      target: resolution.target,
      providerStatus: args.graphQuery.status,
      failure: graphUnavailableFailure(args.degradationMessage),
      implementations: resolution.implementations
    }
  });
  delete result.editPlan;
  delete result.editResult;
  delete result.validationResult;
  delete result.receipt;
  return result;
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

function graphUnavailableMessage(providerStatus: GraphProviderStatus): string {
  return providerStatus.message ?? `Graph provider is ${providerStatus.state}`;
}

function graphUnavailableFailure(message: string): InspectRouteFailure {
  return {
    category: "graph_unavailable",
    message
  };
}

function inspectUnsupportedRouteResult(
  request: CommandAdapterRequest,
  route: InspectRouteResult["route"],
  message: string,
  providerStatus?: GraphProviderStatus,
  target?: InspectSymbolTarget,
  graphQuery?: GraphFactQueryResult
): CommandRouterResult {
  const failure: InspectRouteFailure = {
    category: "unsupported_route",
    message
  };
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: "unsupported",
    json: request.json,
    message,
    providerStatus,
    graphQuery,
    inspectResult: {
      route,
      status: "degraded",
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

function inspectRustGraphReferencesResult(
  request: CommandAdapterRequest,
  options: InspectOptions,
  target: InspectSymbolTarget,
  candidate: GraphFactNode
): CommandRouterResult {
  const graphQuery = graphProviderQuery(options.repo, {
    kind: "neighbors",
    ids: [candidate.id],
    edgeKinds: ["CALLS", "TESTED_BY"],
    limit: options.limit ?? 100
  });
  if (graphQuery.status.state !== "available") {
    return inspectFailureResult(
      request,
      "references",
      "graph_unavailable",
      graphQuery.status.message ?? `Graph provider is ${graphQuery.status.state}`,
      graphQuery.status,
      graphTargetForNode(target, candidate),
      graphQuery
    );
  }
  if (!("nodes" in graphQuery) || !("edges" in graphQuery)) {
    return inspectFailureResult(
      request,
      "references",
      "graph_unavailable",
      "Graph provider returned no Rust reference facts",
      graphQuery.status,
      graphTargetForNode(target, candidate),
      graphQuery
    );
  }
  const references = rustGraphReferences(candidate, graphQuery.nodes, graphQuery.edges, options.limit);
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "inspect",
    status: "ok",
    json: request.json,
    message: "opcore inspect references: graph provider returned read-only Rust references.",
    providerStatus: graphQuery.status,
    graphQuery,
    inspectResult: {
      route: "references",
      status: "ok",
      target: graphTargetForNode(target, candidate),
      providerStatus: graphQuery.status,
      references
    }
  });
}

function inspectRustFileSymbolReferencesResult(
  request: CommandAdapterRequest,
  options: InspectOptions,
  target: InspectSymbolTarget,
  graphQuery: GraphFactQueryResult
): CommandRouterResult {
  if (!("nodes" in graphQuery)) {
    return inspectFailureResult(request, "references", "graph_unavailable", "Graph provider returned no symbol nodes", graphQuery.status, target, graphQuery);
  }
  const candidates = rustGraphCandidatesForFileSymbol(graphQuery, target);
  if (candidates.length === 0) {
    return inspectFailureResult(
      request,
      "references",
      "target_not_found",
      `Inspect references Rust target not found in graph facts: ${target.path ?? ""} ${target.symbolName ?? ""}`.trim(),
      graphQuery.status,
      target,
      graphQuery
    );
  }
  if (candidates.length > 1) {
    return inspectFailureResult(
      request,
      "references",
      "target_ambiguous",
      `Ambiguous inspect references Rust target "${target.symbolName ?? ""}" in ${target.path ?? ""}`,
      graphQuery.status,
      target,
      graphQuery,
      { candidates: candidates.map((candidate) => graphTargetForNode(target, candidate)) }
    );
  }
  return inspectRustGraphReferencesResult(request, options, target, candidates[0]);
}

function rustGraphReferences(
  target: GraphFactNode,
  nodes: readonly GraphFactNode[],
  edges: readonly GraphFactEdge[],
  limit: number | undefined
): readonly InspectReferenceEntry[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  nodesById.set(target.id, target);
  const targetSymbol = inspectSymbolSummary(target);
  const entries: InspectReferenceEntry[] = [inspectReferenceEntry(target, targetSymbol, [target.id], true)];
  const seen = new Set([target.id]);
  for (const edge of [...edges].sort(compareGraphReferenceEdges)) {
    const referenceNodeId =
      edge.kind === "CALLS" && edge.to === target.id
        ? edge.from
        : edge.kind === "TESTED_BY" && edge.from === target.id
          ? edge.to
          : undefined;
    if (!referenceNodeId || seen.has(referenceNodeId)) continue;
    const referenceNode = nodesById.get(referenceNodeId);
    if (!referenceNode) continue;
    seen.add(referenceNodeId);
    entries.push(inspectReferenceEntry(referenceNode, targetSymbol, [target.id, referenceNode.id], false));
  }
  return limit === undefined ? entries : entries.slice(0, limit);
}

function inspectReferenceEntry(
  node: GraphFactNode,
  symbol: InspectReferenceEntry["symbol"],
  graphNodeIds: readonly string[],
  isDefinition: boolean
): InspectReferenceEntry {
  const span = spanFromGraphNode(node);
  return {
    file: node.path ?? pathFromGraphNodeId(node.id),
    line: span.startLine,
    column: span.startColumn,
    text: node.name ?? node.id,
    span,
    symbol,
    isDefinition,
    isDeclaration: true,
    evidence: {
      graphNodeIds,
      resolver: "graph"
    }
  };
}

function spanFromGraphNode(node: GraphFactNode): InspectTextSpan {
  const attributes = graphNodeAttributes(node);
  const startLine = positiveAttribute(attributes, "lineStart", 1);
  const startColumn = positiveAttribute(attributes, "columnStart", 0) + 1;
  const endLine = positiveAttribute(attributes, "lineEnd", startLine);
  const rawEndColumn = positiveAttribute(attributes, "columnEnd", startColumn - 1) + 1;
  const endColumn = endLine === startLine && rawEndColumn < startColumn ? startColumn : rawEndColumn;
  return {
    startLine,
    startColumn,
    endLine,
    endColumn
  };
}

function graphNodeAttributes(node: GraphFactNode): Record<string, unknown> {
  return node.attributes && typeof node.attributes === "object" && !Array.isArray(node.attributes)
    ? (node.attributes as Record<string, unknown>)
    : {};
}

function positiveAttribute(attributes: Record<string, unknown>, key: string, fallback: number): number {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function inspectSymbolSummary(node: GraphFactNode): InspectReferenceEntry["symbol"] {
  return {
    id: node.id,
    name: node.name ?? node.id,
    kind: node.kind
  };
}

function graphTargetForNode(base: InspectSymbolTarget, node: GraphFactNode): InspectSymbolTarget {
  if (base.kind === "node") {
    return {
      kind: "node",
      nodeId: node.id
    };
  }
  return {
    ...base,
    nodeId: node.id,
    path: node.path ?? base.path,
    symbolName: node.name ?? base.symbolName
  };
}

function rustGraphCandidateForFileSymbol(
  graphQuery: GraphFactQueryResult,
  target: InspectSymbolTarget
): InspectSymbolTarget | undefined {
  if (!("nodes" in graphQuery)) return undefined;
  const [candidate] = rustGraphCandidatesForFileSymbol(graphQuery, target);
  return candidate ? graphTargetForNode(target, candidate) : undefined;
}

function rustGraphCandidatesForFileSymbol(graphQuery: GraphFactQueryResult, target: InspectSymbolTarget): GraphFactNode[] {
  if (!("nodes" in graphQuery) || !target.path || !target.symbolName) return [];
  return graphQuery.nodes
    .filter((node) => node.path === target.path)
    .filter((node) => node.name === target.symbolName || graphNodeQualifiedName(node) === target.symbolName)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function graphNodeQualifiedName(node: GraphFactNode): string | undefined {
  const attributes = graphNodeAttributes(node);
  const qualifiedName = attributes.qualifiedName;
  if (typeof qualifiedName === "string") return qualifiedName;
  return node.id.split("#").at(1);
}

function pathFromGraphNodeId(nodeId: string): string {
  const afterKind = nodeId.split(":").slice(1).join(":");
  return afterKind.split("#")[0] || nodeId;
}

function compareGraphReferenceEdges(left: GraphFactEdge, right: GraphFactEdge): number {
  return left.kind.localeCompare(right.kind) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function isRustInspectSourcePath(path: string): boolean {
  return path.toLowerCase().endsWith(".rs");
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
    message: `opcore inspect ${route} requires <node-id> or <file> <symbol> with optional --line and --column`
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
  if (column !== undefined && line === undefined) malformedTarget = `--column requires --line for opcore inspect ${route ?? "references"}`;
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
