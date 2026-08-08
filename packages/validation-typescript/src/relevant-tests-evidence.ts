import type { GraphFactEdge } from "@the-open-engine/opcore-contracts";
import { graphFactPathFromEndpoint } from "@the-open-engine/opcore-validation";

const maxRelevantTestTraversalFiles = 10_000;

export function createRelevantTestEvidence(
  importsFrom: readonly GraphFactEdge[],
  testedBy: readonly GraphFactEdge[]
): (path: string) => readonly string[] {
  const reverseImporters = collectReverseImporters(importsFrom);
  return (path) => relevantTestEvidence(path, testedBy, reverseImporters);
}

function relevantTestEvidence(
  path: string,
  testedBy: readonly GraphFactEdge[],
  reverseImporters: ReadonlyMap<string, readonly string[]>
): readonly string[] {
  const direct = directTestEndpoints(path, testedBy);
  if (direct.length > 0) return direct;

  const discovered = new Set([path]);
  const pending: string[] = [];
  const initialImporters = reverseImporters.get(path);
  if (initialImporters !== undefined) appendUnseenPaths(pending, discovered, initialImporters);
  const evidence = new Set<string>();
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const importer = pending[cursor];
    if (importer === undefined) continue;
    for (const endpoint of directTestEndpoints(importer, testedBy)) evidence.add(`${importer} -> ${endpoint}`);
    const nextImporters = reverseImporters.get(importer);
    if (nextImporters !== undefined) appendUnseenPaths(pending, discovered, nextImporters);
  }
  return [...evidence].sort();
}

function appendUnseenPaths(pending: string[], discovered: Set<string>, paths: readonly string[]): void {
  for (const path of paths) {
    if (discovered.size >= maxRelevantTestTraversalFiles) return;
    if (discovered.has(path)) continue;
    discovered.add(path);
    pending.push(path);
  }
}

function collectReverseImporters(edges: readonly GraphFactEdge[]): ReadonlyMap<string, readonly string[]> {
  const collected = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "IMPORTS_FROM") continue;
    const importer = graphFactPathFromEndpoint(edge.from);
    const imported = graphFactPathFromEndpoint(edge.to);
    if (importer === undefined || imported === undefined) continue;
    const importers = collected.get(imported) ?? new Set<string>();
    importers.add(importer);
    collected.set(imported, importers);
  }
  return new Map(
    [...collected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, importers]) => [path, [...importers].sort()])
  );
}

function directTestEndpoints(path: string, testedBy: readonly GraphFactEdge[]): readonly string[] {
  const endpoints = new Set<string>();
  for (const edge of testedBy) {
    const fromPath = graphFactPathFromEndpoint(edge.from);
    const toPath = graphFactPathFromEndpoint(edge.to);
    const referencesPath = edge.from === path || edge.from === `file:${path}` || fromPath === path ||
      edge.to === path || edge.to === `file:${path}` || toPath === path;
    if (referencesPath) endpoints.add(toPath ?? edge.to);
  }
  return [...endpoints].sort();
}
