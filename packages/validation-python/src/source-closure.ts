import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import type { PythonImportEdge } from "./import-analysis.js";
import type {
  PythonMaterializedSourceFile,
  PythonProjectContextResolver
} from "./source-types.js";

interface PythonSourceClosureArgs {
  context: ValidationCheckContext,
  rootPaths: readonly string[],
  edges: readonly PythonImportEdge[],
  sourceByPath: ReadonlyMap<string, PythonMaterializedSourceFile>,
  resolveContexts: PythonProjectContextResolver
}

export async function expandPythonSourceClosure({
  context,
  rootPaths,
  edges,
  sourceByPath,
  resolveContexts
}: PythonSourceClosureArgs): Promise<readonly string[]> {
  const projectContexts = new Map<string, PythonProjectContext>();
  let selected = transitiveSourcePaths(rootPaths, edges);
  while (true) {
    const unresolvedTargets = selected.filter((path) => !projectContexts.has(path));
    if (unresolvedTargets.length > 0) {
      for (const projectContext of await resolveContexts(
        context,
        unresolvedTargets,
        projectToolKinds(context.selectedCheckIds ?? context.request.checks ?? [])
      )) {
        projectContexts.set(projectContext.target, projectContext);
      }
    }
    const expanded = transitiveSourcePaths(
      includePackageInitializers(selected, sourceByPath, [...projectContexts.values()]),
      edges
    );
    if (expanded.length === selected.length && expanded.every((path, index) => path === selected[index])) return expanded;
    selected = expanded;
  }
}

function projectToolKinds(
  selectedCheckIds: readonly string[]
): readonly ("mypy" | "pyright" | "ruff" | "pytest")[] {
  const kinds = new Set<"mypy" | "pyright" | "ruff" | "pytest">();
  if (selectedCheckIds.includes("python.types")) {
    kinds.add("mypy");
    kinds.add("pyright");
  }
  if (
    selectedCheckIds.includes("python.ruff-lint") ||
    selectedCheckIds.includes("python.ruff-format")
  ) {
    kinds.add("ruff");
  }
  if (selectedCheckIds.includes("python.relevant-tests")) kinds.add("pytest");
  return [...kinds];
}

function includePackageInitializers(
  selectedPaths: readonly string[],
  sourceByPath: ReadonlyMap<string, PythonMaterializedSourceFile>,
  projectContexts: readonly PythonProjectContext[]
): readonly string[] {
  const expanded = new Set(selectedPaths);
  for (const path of selectedPaths) {
    const sourceRoot = owningSourceRoot(path, projectContexts);
    if (sourceRoot === undefined) continue;
    let directory = path.slice(0, path.lastIndexOf("/"));
    while (directory.length > 0 && directory !== sourceRoot && pathWithinRoot(directory, sourceRoot)) {
      const initializers = [`${directory}/__init__.py`, `${directory}/__init__.pyi`]
        .filter((candidate) => sourceByPath.has(candidate));
      if (initializers.length === 0) {
        const separator = directory.lastIndexOf("/");
        if (separator < 0) break;
        directory = directory.slice(0, separator);
        continue;
      }
      // Package markers are structural type-checker inputs, not import expectations.
      for (const initializer of initializers) expanded.add(initializer);
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
