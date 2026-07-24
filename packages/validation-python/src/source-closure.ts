import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import type { PythonImportEdge } from "./import-analysis.js";

interface PythonPathContent {
  path: string;
}

interface ExpandPythonSourceClosureArgs {
  context: ValidationCheckContext;
  rootPaths: readonly string[];
  edges: readonly PythonImportEdge[];
  sourceByPath: ReadonlyMap<string, PythonPathContent>;
  resolveContexts: (
    context: ValidationCheckContext,
    targets?: readonly string[]
  ) => Promise<readonly PythonProjectContext[]>;
}

export async function expandPythonSourceClosure(
  args: ExpandPythonSourceClosureArgs
): Promise<readonly string[]> {
  const projectContexts = new Map<string, PythonProjectContext>();
  let selected = transitiveSourcePaths(args.rootPaths, args.edges);
  while (true) {
    const unresolvedTargets = selected.filter((path) => !projectContexts.has(path));
    if (unresolvedTargets.length > 0) {
      for (const projectContext of await args.resolveContexts(args.context, unresolvedTargets)) {
        projectContexts.set(projectContext.target, projectContext);
      }
    }
    const expanded = transitiveSourcePaths(
      includePackageInitializers(selected, args.sourceByPath, [...projectContexts.values()]),
      args.edges
    );
    if (expanded.length === selected.length && expanded.every((path, index) => path === selected[index])) return expanded;
    selected = expanded;
  }
}

function includePackageInitializers(
  selectedPaths: readonly string[],
  sourceByPath: ReadonlyMap<string, PythonPathContent>,
  projectContexts: readonly PythonProjectContext[]
): readonly string[] {
  const expanded = new Set(selectedPaths);
  for (const path of selectedPaths) {
    const sourceRoot = owningSourceRoot(path, projectContexts);
    if (sourceRoot === undefined) continue;
    let directory = path.slice(0, path.lastIndexOf("/"));
    while (directory.length > 0 && directory !== sourceRoot && pathWithinRoot(directory, sourceRoot)) {
      for (const initializer of [`${directory}/__init__.py`, `${directory}/__init__.pyi`]) {
        if (sourceByPath.has(initializer)) expanded.add(initializer);
      }
      const separator = directory.lastIndexOf("/");
      if (separator < 0) break;
      directory = directory.slice(0, separator);
    }
  }
  return [...expanded].sort();
}

function owningSourceRoot(path: string, projectContexts: readonly PythonProjectContext[]): string | undefined {
  return projectContexts
    .flatMap((projectContext) => projectContext.sourceRoots)
    .filter((sourceRoot) => pathWithinRoot(path, sourceRoot))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
}

function pathWithinRoot(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function transitiveSourcePaths(
  rootPaths: readonly string[],
  edges: readonly PythonImportEdge[]
): readonly string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.fromPath) ?? [];
    targets.push(edge.toPath);
    outgoing.set(edge.fromPath, targets);
  }
  const selected = new Set(rootPaths);
  const pending = [...rootPaths];
  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined) continue;
    for (const target of outgoing.get(path) ?? []) {
      if (selected.has(target)) continue;
      selected.add(target);
      pending.push(target);
    }
  }
  return [...selected].sort();
}
