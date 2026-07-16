import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckResult, ValidationFileView } from "@the-open-engine/opcore-validation";
import { normalizeValidationFileViewPath } from "@the-open-engine/opcore-validation";
import {
  requirePythonImportAnalyzer,
  validatePythonImportEdges,
  type PythonImportAnalyzer,
  type PythonImportEdge,
  type PythonImportSourceFile
} from "./import-analysis.js";
import { resolvePythonProjectContexts, type ResolvePythonProjectContextsOptions } from "./project-context.js";
import { createValidationFileViewPythonWorkspace, type PythonProjectWorkspace } from "./project-workspace.js";

export const pythonSourceExtensions = [".py", ".pyi"] as const;

export type PythonMaterializedSourceFile = PythonImportSourceFile;

export interface PythonMaterializedSourceSet {
  rootPaths: readonly string[];
  paths: readonly string[];
  files: readonly PythonMaterializedSourceFile[];
  sourceFileByPath: ReadonlyMap<string, PythonMaterializedSourceFile>;
  repoImports: readonly PythonImportEdge[];
}

export type PythonProjectContextResolver = (
  context: ValidationCheckContext,
  targets?: readonly string[]
) => Promise<readonly PythonProjectContext[]>;
export type PythonSourceRootResolver = (context: ValidationCheckContext) => Promise<readonly string[]>;
export type PythonSourceSetResolver = (context: ValidationCheckContext) => Promise<PythonMaterializedSourceSet>;

export function createPythonProjectContextResolver(
  options: Omit<ResolvePythonProjectContextsOptions, "repoRoot" | "targets" | "workspace"> & {
    nodeWorkspace?: PythonProjectWorkspace;
  } = {}
): PythonProjectContextResolver {
  const cache = new WeakMap<ValidationFileView, PythonProjectContextCache>();
  return async (context, requestedTargets) => {
    let cached = cache.get(context.fileView);
    if (cached === undefined) {
      cached = { contexts: new Map() };
      cache.set(context.fileView, cached);
    }
    const targets = requestedTargets === undefined
      ? await (cached.inputTargets ??= readPythonAfterSources(context).then((sources) => sources.map((source) => source.path)))
      : uniqueSorted(requestedTargets.map(normalizeValidationFileViewPath).filter(isPythonSourcePath));
    while (true) {
      const missing = targets.filter((target) => !cached.contexts.has(target));
      if (missing.length === 0) return targets.map((target) => requiredProjectContext(cached.contexts, target));
      if (cached.pending !== undefined) {
        await cached.pending;
        continue;
      }
      const pending = resolvePythonProjectContexts({
        repoRoot: context.request.repo.repoRoot ?? process.cwd(),
        targets: missing,
        workspace: createValidationFileViewPythonWorkspace(context.fileView, undefined, options.nodeWorkspace),
        ...withoutNodeWorkspace(options)
      }).then((contexts) => {
        for (const projectContext of contexts) cached.contexts.set(projectContext.target, projectContext);
      });
      cached.pending = pending;
      try {
        await pending;
      } finally {
        delete cached.pending;
      }
    }
  };
}

interface PythonProjectContextCache {
  contexts: Map<string, PythonProjectContext>;
  inputTargets?: Promise<readonly string[]>;
  pending?: Promise<void>;
}

function requiredProjectContext(
  contexts: ReadonlyMap<string, PythonProjectContext>,
  target: string
): PythonProjectContext {
  const projectContext = contexts.get(target);
  if (projectContext === undefined) throw new Error(`Python project context resolution omitted target ${target}`);
  return projectContext;
}

function withoutNodeWorkspace(
  options: Omit<ResolvePythonProjectContextsOptions, "repoRoot" | "targets" | "workspace"> & {
    nodeWorkspace?: PythonProjectWorkspace;
  }
): Omit<ResolvePythonProjectContextsOptions, "repoRoot" | "targets" | "workspace"> {
  const { nodeWorkspace: _nodeWorkspace, ...resolverOptions } = options;
  return resolverOptions;
}

export function isPythonSourcePath(path: string): boolean {
  return pythonSourceExtensions.some((extension) => path.endsWith(extension));
}

export function toFileNodeId(path: string): string {
  return `file:${path}`;
}

export function pythonInputSet(context: ValidationCheckContext): readonly string[] {
  return uniqueSorted(
    [...context.fileView.scopeFiles, ...context.fileView.overlays.map((overlay) => overlay.path)]
      .map((path) => normalizeValidationFileViewPath(path))
      .filter(isPythonSourcePath)
  );
}

export async function readPythonAfterSources(context: ValidationCheckContext): Promise<readonly PythonMaterializedSourceFile[]> {
  const files: PythonMaterializedSourceFile[] = [];
  for (const path of pythonInputSet(context)) {
    const result = await context.fileView.readAfter(path);
    if (result.status === "found") files.push({ path, content: result.content });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function createPythonSourceRootResolver(): PythonSourceRootResolver {
  const cache = new WeakMap<ValidationFileView, Promise<readonly string[]>>();
  return (context) => {
    const existing = cache.get(context.fileView);
    if (existing !== undefined) return existing;
    const promise = readPythonAfterSources(context).then((sources) => sources.map((source) => source.path));
    cache.set(context.fileView, promise);
    return promise;
  };
}

export function skippedPythonInputResult(context: ValidationCheckContext): ValidationCheckResult | undefined {
  if (pythonInputSet(context).length > 0) return undefined;
  return {
    status: "skipped",
    diagnostics: [],
    failureMessage: "No Python-owned files were selected."
  };
}

export function createPythonSourceSetResolver(
  importAnalyzer: PythonImportAnalyzer | undefined,
  resolveContexts: PythonProjectContextResolver
): PythonSourceSetResolver {
  const cache = new WeakMap<ValidationFileView, Promise<PythonMaterializedSourceSet>>();
  return (context) => {
    const existing = cache.get(context.fileView);
    if (existing !== undefined) return existing;
    const promise = materializePythonSourcesUncached(context, importAnalyzer, resolveContexts);
    cache.set(context.fileView, promise);
    return promise;
  };
}

async function materializePythonSourcesUncached(
  context: ValidationCheckContext,
  importAnalyzer: PythonImportAnalyzer | undefined,
  resolveContexts: PythonProjectContextResolver
): Promise<PythonMaterializedSourceSet> {
  const visiblePaths = uniqueSorted(
    (await context.fileView.listVisibleFiles())
      .map(normalizeValidationFileViewPath)
      .filter(isPythonSourcePath)
  );
  const allSources: PythonMaterializedSourceFile[] = [];
  for (const path of visiblePaths) {
    const result = await context.fileView.readAfter(path);
    if (result.status === "found") allSources.push({ path, content: result.content });
  }

  const allSourceByPath = new Map(allSources.map((source) => [source.path, source]));
  const rootPaths = pythonInputSet(context).filter((path) => allSourceByPath.has(path));
  if (rootPaths.length === 0) return emptySourceSet();

  const analyzer = requirePythonImportAnalyzer(importAnalyzer);
  const repoImports = validatePythonImportEdges(
    await analyzer.analyze(allSources),
    new Set(allSourceByPath.keys())
  );
  const selectedPaths = await expandSourceClosure(context, rootPaths, repoImports, allSourceByPath, resolveContexts);
  const files = selectedPaths.map((path) => allSourceByPath.get(path)).filter(isDefined);
  const sourceFileByPath = new Map(files.map((file) => [file.path, file]));
  const selectedPathSet = new Set(selectedPaths);
  return {
    rootPaths,
    paths: selectedPaths,
    files,
    sourceFileByPath,
    repoImports: repoImports.filter((edge) => selectedPathSet.has(edge.fromPath) && selectedPathSet.has(edge.toPath))
  };
}

async function expandSourceClosure(
  context: ValidationCheckContext,
  rootPaths: readonly string[],
  edges: readonly PythonImportEdge[],
  sourceByPath: ReadonlyMap<string, PythonMaterializedSourceFile>,
  resolveContexts: PythonProjectContextResolver
): Promise<readonly string[]> {
  const projectContexts = new Map<string, PythonProjectContext>();
  let selected = transitiveSourcePaths(rootPaths, edges);
  while (true) {
    const unresolvedTargets = selected.filter((path) => !projectContexts.has(path));
    if (unresolvedTargets.length > 0) {
      for (const projectContext of await resolveContexts(context, unresolvedTargets)) {
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

function emptySourceSet(): PythonMaterializedSourceSet {
  return {
    rootPaths: [],
    paths: [],
    files: [],
    sourceFileByPath: new Map(),
    repoImports: []
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
