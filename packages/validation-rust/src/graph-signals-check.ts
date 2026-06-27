import type {
  GraphEdgeKind,
  GraphFactEdge,
  GraphFactNode,
  JsonValue,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition,
  ValidationGraphQueryRequirement
} from "@the-open-engine/opcore-validation";
import { RUST_GRAPH_SIGNALS_CHECK_ID } from "./check-ids.js";
import { rustCheckAdapter, rustCheckOwner, supportedRustValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { isRustSourcePath, rustInputSet, skippedRustInputResult, uniqueSorted } from "./source-files.js";

const rustGraphSignalEdgeKinds = ["CALLS", "TESTED_BY", "IMPORTS_FROM"] as const satisfies readonly GraphEdgeKind[];

export function createGraphSignalsCheck(): ValidationCheckDefinition {
  return {
    id: RUST_GRAPH_SIGNALS_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedRustValidationScopes,
    requiresGraph: true,
    graphRequirements: rustGraphSignalRequirements,
    run: runGraphSignals
  };
}

async function rustGraphSignalRequirements(
  context: ValidationCheckContext
): Promise<readonly ValidationGraphQueryRequirement[]> {
  const sourcePaths = rustGraphSignalSourcePaths(context);
  if (sourcePaths.length === 0) return [];
  return [
    {
      operation: "factQuery",
      selector: {
        kind: "edges",
        edgeKinds: rustGraphSignalEdgeKinds
      }
    },
    {
      operation: "factQuery",
      selector: {
        kind: "nodes",
        nodeKinds: ["File", "file"],
        ids: sourcePaths.map(toFileNodeId)
      }
    },
    {
      operation: "factQuery",
      selector: {
        kind: "symbols"
      }
    }
  ];
}

async function runGraphSignals(context: ValidationCheckContext) {
  const skipped = skippedRustInputResult(context);
  if (skipped !== undefined) return skipped;
  const sourcePaths = rustGraphSignalSourcePaths(context);
  if (sourcePaths.length === 0) {
    return {
      status: "skipped" as const,
      diagnostics: [],
      failureMessage: "No Rust source files were selected."
    };
  }

  const [symbolFacts, calls, testedBy, importsFrom, fileNodes] = await Promise.all([
    context.graph.facts({ kind: "symbols" }),
    context.graph.calls(),
    context.graph.testedBy(),
    context.graph.importsFrom(),
    context.graph.fileNodes(sourcePaths)
  ]);
  const scopedPaths = new Set(sourcePaths);
  const scopedSymbols = symbolFacts.nodes.filter((node) => isScopedRustNode(node, scopedPaths));
  const publicSurface = scopedSymbols.filter(isPublicRustSurface);
  const callCoveredSurface = publicSurface.filter(hasCallUsageCoverage);
  const diagnostics: ValidationDiagnostic[] = [];

  if (!edgeKindSupported(context, "CALLS")) {
    diagnostics.push(unsupportedDiagnostic("CALLS", "dead public export"));
  } else {
    diagnostics.push(...deadPublicExportDiagnostics(callCoveredSurface, calls));
  }

  if (!edgeKindSupported(context, "TESTED_BY")) {
    diagnostics.push(unsupportedDiagnostic("TESTED_BY", "untested public surface"));
  } else {
    diagnostics.push(...untestedSurfaceDiagnostics(callCoveredSurface, testedBy));
  }

  if (!edgeKindSupported(context, "IMPORTS_FROM")) {
    diagnostics.push(unsupportedDiagnostic("IMPORTS_FROM", "module orphan and cycle"));
  } else {
    diagnostics.push(...moduleSignalDiagnostics(fileNodes, scopedSymbols, importsFrom, scopedPaths));
  }

  return { diagnostics: sortDiagnostics(diagnostics) };
}

function rustGraphSignalSourcePaths(context: ValidationCheckContext): readonly string[] {
  return uniqueSorted(rustInputSet(context).ownedPaths.filter(isRustSourcePath));
}

function deadPublicExportDiagnostics(
  publicSurface: readonly GraphFactNode[],
  calls: readonly GraphFactEdge[]
): readonly ValidationDiagnostic[] {
  return publicSurface
    .filter((node) => !hasIncomingEdgeTarget(node, calls))
    .map((node) =>
      diagnostic({
        category: "graph",
        severity: "warning",
        path: symbolFilePath(node),
        code: "RUST_GRAPH_DEAD_PUB_EXPORT",
        message: `Public Rust export has no incoming CALLS graph evidence: ${node.name ?? node.id}`
      })
    );
}

function untestedSurfaceDiagnostics(
  publicSurface: readonly GraphFactNode[],
  testedBy: readonly GraphFactEdge[]
): readonly ValidationDiagnostic[] {
  return publicSurface
    .filter((node) => !hasTestedByEdge(node, testedBy))
    .map((node) =>
      diagnostic({
        category: "test",
        severity: "info",
        path: symbolFilePath(node),
        code: "RUST_GRAPH_UNTESTED_SURFACE",
        message: `Public Rust surface has no TESTED_BY graph evidence: ${node.name ?? node.id}`
      })
    );
}

function moduleSignalDiagnostics(
  fileNodes: readonly GraphFactNode[],
  scopedSymbols: readonly GraphFactNode[],
  importsFrom: readonly GraphFactEdge[],
  scopedPaths: ReadonlySet<string>
): readonly ValidationDiagnostic[] {
  const rustFilePaths = new Set(
    fileNodes
      .filter(isRustFileNode)
      .map(symbolFilePath)
      .filter((path): path is string => path !== undefined && scopedPaths.has(path))
  );
  const rootPaths = new Set(
    scopedSymbols
      .filter(isRustRootModule)
      .map(symbolFilePath)
      .filter((path): path is string => path !== undefined)
  );
  const importedTargets = new Set(
    importsFrom
      .map((edge) => endpointFilePath(edge.to))
      .filter((path): path is string => path !== undefined && scopedPaths.has(path))
  );
  const scopedFileEdges = importsFrom
    .map((edge) => {
      const from = endpointFilePath(edge.from);
      const to = endpointFilePath(edge.to);
      return from !== undefined && to !== undefined && scopedPaths.has(from) && scopedPaths.has(to) ? { from, to } : undefined;
    })
    .filter((edge): edge is { from: string; to: string } => edge !== undefined);

  const diagnostics: ValidationDiagnostic[] = [];
  for (const path of [...rustFilePaths].sort()) {
    if (rootPaths.has(path) || importedTargets.has(path)) continue;
    diagnostics.push(
      diagnostic({
        category: "graph",
        severity: "warning",
        path,
        code: "RUST_GRAPH_MODULE_ORPHAN",
        message: `Rust module source has no incoming IMPORTS_FROM graph evidence: ${path}`
      })
    );
  }
  diagnostics.push(
    ...findCycles(scopedFileEdges).map((cycle) =>
      diagnostic({
        category: "graph",
        severity: "warning",
        path: cycle[0],
        code: "RUST_GRAPH_MODULE_CYCLE",
        message: `Rust module cycle detected from graph facts: ${cycle.join(" -> ")}`
      })
    )
  );
  return diagnostics;
}

function unsupportedDiagnostic(edgeKind: GraphEdgeKind, label: string): ValidationDiagnostic {
  return diagnostic({
    category: "graph",
    severity: "info",
    code: "RUST_GRAPH_SIGNALS_UNSUPPORTED",
    message: `Graph provider capability handshake does not include ${edgeKind} edge coverage required for Rust ${label} signals.`
  });
}

function edgeKindSupported(context: ValidationCheckContext, edgeKind: GraphEdgeKind): boolean {
  if (context.graphStatus.state !== "available" || context.graphStatus.handshake === undefined) return true;
  return context.graphStatus.handshake.edgeKinds.includes(edgeKind);
}

function hasIncomingEdgeTarget(node: GraphFactNode, edges: readonly GraphFactEdge[]): boolean {
  const aliases = symbolAliases(node);
  return edges.some((edge) => aliases.has(edge.to));
}

function hasTestedByEdge(node: GraphFactNode, edges: readonly GraphFactEdge[]): boolean {
  const aliases = symbolAliases(node);
  return edges.some((edge) => aliases.has(edge.from));
}

function isScopedRustNode(node: GraphFactNode, scopedPaths: ReadonlySet<string>): boolean {
  const path = symbolFilePath(node);
  return path !== undefined && scopedPaths.has(path) && isRustGraphNode(node);
}

function isRustFileNode(node: GraphFactNode): boolean {
  if (node.kind !== "File" && node.kind !== "file") return false;
  return isRustGraphNode(node);
}

function isRustGraphNode(node: GraphFactNode): boolean {
  if (stringAttribute(node, ["language"]) === "rust") return true;
  const path = symbolFilePath(node);
  return path !== undefined && isRustSourcePath(path);
}

function isRustRootModule(node: GraphFactNode): boolean {
  if (node.kind !== "Module") return false;
  return node.name === "crate" || stringAttribute(node, ["qualifiedName"]) === "crate";
}

function isPublicRustSurface(node: GraphFactNode): boolean {
  if (node.kind === "File" || node.kind === "file" || node.kind === "Module" || node.kind === "Impl" || node.kind === "Test") {
    return false;
  }
  return booleanAttribute(node, ["exported", "isExported", "public"]);
}

function hasCallUsageCoverage(node: GraphFactNode): boolean {
  return node.kind === "Function" || node.kind === "Method" || node.kind === "Macro";
}

function symbolAliases(node: GraphFactNode): ReadonlySet<string> {
  const aliases = new Set([node.id]);
  const stableId = stringAttribute(node, ["symbolId", "stableId", "qualifiedName"]);
  if (stableId !== undefined) aliases.add(stableId);
  return aliases;
}

function symbolFilePath(node: GraphFactNode): string | undefined {
  if (node.path !== undefined) return node.path;
  const path = stringAttribute(node, ["path", "file", "filePath", "sourcePath"]);
  if (path !== undefined) return path;
  return endpointFilePath(node.id);
}

function endpointFilePath(endpoint: string): string | undefined {
  const match = /^file:(.+)$/u.exec(endpoint) ?? /^[^:]+:([^#]+)(?:#.*)?$/u.exec(endpoint);
  return match?.[1];
}

function booleanAttribute(node: GraphFactNode, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = node.attributes?.[key];
    if (value === true || value === "true") return true;
  }
  return false;
}

function stringAttribute(node: GraphFactNode, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = node.attributes?.[key];
    if (isStringValue(value)) return value;
  }
  return undefined;
}

function isStringValue(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function toFileNodeId(path: string): string {
  return `file:${path}`;
}

function findCycles(edges: readonly { from: string; to: string }[]): readonly string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = graph.get(edge.from) ?? [];
    targets.push(edge.to);
    graph.set(edge.from, targets);
  }
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycleKeys = new Set<string>();
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    const index = stack.indexOf(node);
    if (index !== -1) {
      const cycle = [...stack.slice(index), node];
      const key = canonicalCycleKey(cycle);
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) visit(target);
    stack.pop();
  };
  for (const node of graph.keys()) visit(node);
  return cycles.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function canonicalCycleKey(cycle: readonly string[]): string {
  const nodes = cycle.length > 1 && cycle[0] === cycle[cycle.length - 1] ? cycle.slice(0, -1) : [...cycle];
  if (nodes.length === 0) return "";
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)].join("\0"));
  return rotations.sort()[0] ?? "";
}
