import type { GraphFactEdge, GraphFactNode } from "@the-open-engine/opcore-contracts";
import {
  graphFactNodePath,
  graphFactSymbolAliases,
  normalizeValidationFileViewPath,
  uniqueSortedStrings
} from "@the-open-engine/opcore-validation";

export interface TypeScriptDeadCodeOptions {
  entrypoints?: readonly string[];
}

export interface TypeScriptDeadCodeEntrypointReachability {
  readonly configured: boolean;
  readonly entrypointPaths: readonly string[];
  readonly reachableFileAliases: ReadonlySet<string>;
  readonly reachableSymbolAliases: ReadonlySet<string>;
}

const fileReachabilityEdgeKinds = new Set(["IMPORTS_FROM"]);
const symbolReachabilityEdgeKinds = new Set(["CALLS", "INHERITS", "IMPLEMENTS"]);

export function deadCodeEntrypointReachability(
  options: TypeScriptDeadCodeOptions | undefined,
  nodes: readonly GraphFactNode[],
  edges: readonly GraphFactEdge[]
): TypeScriptDeadCodeEntrypointReachability {
  const entrypointPaths = uniqueSortedStrings(
    (options?.entrypoints ?? [])
      .map((entrypoint) => normalizeEntrypointPath(entrypoint))
      .filter((entrypoint): entrypoint is string => entrypoint !== undefined)
  );
  const fileNodesByAlias = mapFileNodeAliases(nodes);
  const symbolNodesByAlias = mapSymbolNodeAliases(nodes);
  const fileImports = fileImportAdjacency(edges, fileNodesByAlias);
  const contains = fileContainsAdjacency(edges, fileNodesByAlias, symbolNodesByAlias);
  const symbolReferences = symbolReferenceAdjacency(edges, symbolNodesByAlias);
  const fileReachability = collectReachableFiles(entrypointPaths, fileNodesByAlias, fileImports, contains);
  const reachableSymbolAliases = collectReachableSymbols(fileReachability.pendingSymbols, symbolNodesByAlias, symbolReferences);

  return {
    configured: entrypointPaths.length > 0,
    entrypointPaths,
    reachableFileAliases: fileReachability.reachableFileAliases,
    reachableSymbolAliases
  };
}

function collectReachableFiles(
  entrypointPaths: readonly string[],
  fileNodesByAlias: ReadonlyMap<string, string>,
  fileImports: ReadonlyMap<string, readonly string[]>,
  contains: ReadonlyMap<string, readonly string[]>
): { readonly reachableFileAliases: ReadonlySet<string>; readonly pendingSymbols: readonly string[] } {
  const reachableFileAliases = new Set<string>();
  const pendingFiles = [...entrypointPaths.flatMap((path) => fileAliases(path, fileNodesByAlias.get(path)))];
  const pendingSymbols: string[] = [];
  while (pendingFiles.length > 0) {
    const alias = pendingFiles.shift();
    if (alias === undefined || reachableFileAliases.has(alias)) continue;
    reachableFileAliases.add(alias);
    enqueueFileAliases(alias, fileNodesByAlias, reachableFileAliases, pendingFiles);
    for (const symbolAlias of contains.get(alias) ?? []) pendingSymbols.push(symbolAlias);
    for (const target of fileImports.get(alias) ?? []) pendingFiles.push(target);
  }
  return { reachableFileAliases, pendingSymbols };
}

function enqueueFileAliases(
  alias: string,
  fileNodesByAlias: ReadonlyMap<string, string>,
  reachableFileAliases: ReadonlySet<string>,
  pendingFiles: string[]
): void {
  const filePath = filePathFromAlias(alias) ?? fileNodesByAlias.get(alias);
  if (filePath === undefined) return;
  for (const fileAlias of fileAliases(filePath, fileNodesByAlias.get(filePath))) {
    if (!reachableFileAliases.has(fileAlias)) pendingFiles.push(fileAlias);
  }
}

function collectReachableSymbols(
  initialSymbols: readonly string[],
  symbolNodesByAlias: ReadonlyMap<string, GraphFactNode>,
  symbolReferences: ReadonlyMap<string, readonly string[]>
): ReadonlySet<string> {
  const reachableSymbolAliases = new Set<string>();
  const pendingSymbols = [...initialSymbols];
  while (pendingSymbols.length > 0) {
    const alias = pendingSymbols.shift();
    if (alias === undefined || reachableSymbolAliases.has(alias)) continue;
    reachableSymbolAliases.add(alias);
    const node = symbolNodesByAlias.get(alias);
    if (node !== undefined) {
      for (const nodeAlias of symbolAliases(node)) {
        if (!reachableSymbolAliases.has(nodeAlias)) pendingSymbols.push(nodeAlias);
      }
    }
    for (const target of symbolReferences.get(alias) ?? []) pendingSymbols.push(target);
  }
  return reachableSymbolAliases;
}

function mapFileNodeAliases(nodes: readonly GraphFactNode[]): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const node of nodes.filter(isFileNode)) {
    const path = fileNodePath(node);
    if (path === undefined) continue;
    for (const alias of fileAliases(path, node.id)) aliases.set(alias, path);
  }
  return aliases;
}

function mapSymbolNodeAliases(nodes: readonly GraphFactNode[]): ReadonlyMap<string, GraphFactNode> {
  const aliases = new Map<string, GraphFactNode>();
  for (const node of nodes.filter((node) => !isFileNode(node))) {
    for (const alias of symbolAliases(node)) aliases.set(alias, node);
  }
  return aliases;
}

function fileImportAdjacency(
  edges: readonly GraphFactEdge[],
  fileNodesByAlias: ReadonlyMap<string, string>
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges.filter((edge) => fileReachabilityEdgeKinds.has(edge.kind))) {
    const fromAliases = endpointFileAliases(edge.from, fileNodesByAlias);
    const toAliases = endpointFileAliases(edge.to, fileNodesByAlias);
    for (const from of fromAliases) {
      const targets = adjacency.get(from) ?? new Set<string>();
      for (const to of toAliases) targets.add(to);
      adjacency.set(from, targets);
    }
  }
  return freezeAdjacency(adjacency);
}

function fileContainsAdjacency(
  edges: readonly GraphFactEdge[],
  fileNodesByAlias: ReadonlyMap<string, string>,
  symbolNodesByAlias: ReadonlyMap<string, GraphFactNode>
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges.filter((edge) => edge.kind === "CONTAINS")) {
    const fromAliases = endpointFileAliases(edge.from, fileNodesByAlias);
    const toAliases = endpointSymbolAliases(edge.to, symbolNodesByAlias);
    for (const from of fromAliases) {
      const targets = adjacency.get(from) ?? new Set<string>();
      for (const to of toAliases) targets.add(to);
      adjacency.set(from, targets);
    }
  }
  return freezeAdjacency(adjacency);
}

function symbolReferenceAdjacency(
  edges: readonly GraphFactEdge[],
  symbolNodesByAlias: ReadonlyMap<string, GraphFactNode>
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges.filter((edge) => symbolReachabilityEdgeKinds.has(edge.kind))) {
    const fromAliases = endpointSymbolAliases(edge.from, symbolNodesByAlias);
    const toAliases = endpointSymbolAliases(edge.to, symbolNodesByAlias);
    for (const from of fromAliases) {
      const targets = adjacency.get(from) ?? new Set<string>();
      for (const to of toAliases) targets.add(to);
      adjacency.set(from, targets);
    }
  }
  return freezeAdjacency(adjacency);
}

function endpointFileAliases(endpoint: string, fileNodesByAlias: ReadonlyMap<string, string>): readonly string[] {
  const mappedPath = fileNodesByAlias.get(endpoint);
  const parsedPath = filePathFromAlias(endpoint);
  const path = mappedPath ?? parsedPath;
  return path === undefined ? [endpoint] : fileAliases(path, endpoint);
}

function endpointSymbolAliases(endpoint: string, symbolNodesByAlias: ReadonlyMap<string, GraphFactNode>): readonly string[] {
  const node = symbolNodesByAlias.get(endpoint);
  return node === undefined ? [endpoint] : symbolAliases(node);
}

function fileAliases(path: string, nodeId: string | undefined): readonly string[] {
  return uniqueSortedStrings([path, `file:${path}`, ...(nodeId === undefined ? [] : [nodeId])]);
}

function symbolAliases(node: GraphFactNode): readonly string[] {
  return graphFactSymbolAliases(node);
}

function filePathFromAlias(alias: string): string | undefined {
  const prefixed = /^file:(.+)$/.exec(alias);
  if (prefixed !== null) return prefixed[1];
  return /\.[cm]?[tj]sx?$/.test(alias) ? alias : undefined;
}

function fileNodePath(node: GraphFactNode): string | undefined {
  return graphFactNodePath(node);
}

function isFileNode(node: GraphFactNode): boolean {
  return node.kind === "File" || node.kind === "file";
}

function normalizeEntrypointPath(entrypoint: string): string | undefined {
  try {
    return normalizeValidationFileViewPath(entrypoint);
  } catch {
    return undefined;
  }
}

function freezeAdjacency(adjacency: Map<string, Set<string>>): ReadonlyMap<string, readonly string[]> {
  return new Map([...adjacency.entries()].map(([key, values]) => [key, uniqueSortedStrings([...values].filter((value) => value.length > 0))]));
}
