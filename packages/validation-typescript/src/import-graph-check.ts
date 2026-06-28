import type { GraphFactEdge, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { ValidationGraphProviderError } from "@the-open-engine/opcore-validation";
import { TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { materializeTypeScriptSources, toFileNodeId, type TypeScriptRelativeImport } from "./source-files.js";

export function createImportGraphCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: false,
    run: async (context) => {
      const sourceSet = await materializeTypeScriptSources(context);
      const diagnostics = [
        ...cycleDiagnostics(sourceSet.relativeImports),
        ...(await retainedMissingEdgeDiagnostics(context, sourceSet.relativeImports))
      ].sort(compareDiagnostics);
      return { diagnostics };
    }
  };
}

async function retainedMissingEdgeDiagnostics(
  context: ValidationCheckContext,
  relativeImports: readonly TypeScriptRelativeImport[]
): Promise<readonly ValidationDiagnostic[]> {
  if (context.graphStatus.state !== "available" || !context.graph.queryCapable) return [];
  let edges: readonly GraphFactEdge[];
  try {
    edges = await context.graph.importsFrom();
  } catch (error) {
    if (error instanceof ValidationGraphProviderError && context.request.graph.mode !== "required") return [];
    throw error;
  }
  return relativeImports
    .filter((relativeImport) => !edges.some((edge) => matchesDirectedFileEdge(edge, relativeImport.fromPath, relativeImport.resolvedPath)))
    .map((relativeImport): ValidationDiagnostic => ({
      category: "graph",
      severity: "warning",
      path: relativeImport.fromPath,
      code: "TS_IMPORT_GRAPH_MISSING_EDGE",
      message: `Missing IMPORTS_FROM graph edge for ${relativeImport.fromPath} -> ${relativeImport.resolvedPath}`
    }));
}

function matchesDirectedFileEdge(edge: GraphFactEdge, fromPath: string, toPath: string): boolean {
  return endpointAliases(fromPath).has(edge.from) && endpointAliases(toPath).has(edge.to);
}

function endpointAliases(path: string): ReadonlySet<string> {
  return new Set([path, toFileNodeId(path)]);
}

interface ImportGraphEdge {
  from: string;
  to: string;
}

function cycleDiagnostics(relativeImports: readonly TypeScriptRelativeImport[]): readonly ValidationDiagnostic[] {
  return findCycles(relativeImports.map((relativeImport) => ({ from: relativeImport.fromPath, to: relativeImport.resolvedPath }))).map(
    (cycle): ValidationDiagnostic => ({
      category: "graph",
      severity: "warning",
      path: cycle[0],
      code: "TS_IMPORT_GRAPH_CYCLE",
      message: `TypeScript import cycle detected: ${cycle.join(" -> ")}`
    })
  );
}

function findCycles(edges: readonly ImportGraphEdge[]): readonly (readonly string[])[] {
  const graph = adjacencyList(edges);
  const cycles = new Map<string, readonly string[]>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      if (index !== -1) {
        const cycle = canonicalCycle([...stack.slice(index), node]);
        cycles.set(cycle.join("\0"), cycle);
      }
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) visit(target);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of graph.keys()) visit(node);
  return [...cycles.values()].sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function adjacencyList(edges: readonly ImportGraphEdge[]): ReadonlyMap<string, readonly string[]> {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targets = graph.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    graph.set(edge.from, targets);
    if (!graph.has(edge.to)) graph.set(edge.to, new Set());
  }
  return new Map(
    [...graph.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([node, targets]) => [node, [...targets].sort()] as const)
  );
}

function canonicalCycle(cycle: readonly string[]): readonly string[] {
  const nodes = cycle.slice(0, -1);
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)]);
  const [canonical] = rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return [...canonical, canonical[0]];
}

function compareDiagnostics(left: ValidationDiagnostic, right: ValidationDiagnostic): number {
  return (
    (left.path ?? "").localeCompare(right.path ?? "") ||
    (left.code ?? "").localeCompare(right.code ?? "") ||
    left.message.localeCompare(right.message)
  );
}
