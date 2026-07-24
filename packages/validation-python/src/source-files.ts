import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckResult, ValidationFileView } from "@the-open-engine/opcore-validation";
import { normalizeValidationFileViewPath } from "@the-open-engine/opcore-validation";
import {
  pythonImportEdgesFromGraph,
  requirePythonImportAnalyzer,
  validatePythonImportEdges,
  type PythonImportAnalyzer,
  type PythonImportEdge
} from "./import-analysis.js";
import { resolvePythonProjectContexts, type ResolvePythonProjectContextsOptions } from "./project-context.js";
import { createValidationFileViewPythonWorkspace, type PythonProjectWorkspace } from "./project-workspace.js";
import { expandPythonSourceClosure } from "./source-closure.js";
import type {
  PythonMaterializedSourceFile,
  PythonMaterializedSourceSet,
  PythonProjectContextResolver,
  PythonSourceRootResolver,
  PythonSourceSetResolver
} from "./source-types.js";

export const pythonSourceExtensions = [".py", ".pyi"] as const;
const allPythonProjectToolKinds = ["mypy", "pyright", "ruff", "pytest"] as const;

export type {
  PythonMaterializedSourceFile,
  PythonMaterializedSourceSet,
  PythonProjectContextResolver,
  PythonSourceRootResolver,
  PythonSourceSetResolver
} from "./source-types.js";

export async function selectPythonSourceFilesForTargets(
  context: ValidationCheckContext,
  sourceSet: PythonMaterializedSourceSet,
  resolveContexts: PythonProjectContextResolver,
  rootPaths: readonly string[]
): Promise<readonly PythonMaterializedSourceFile[]> {
  if (sourceSet.files.length === 0 || rootPaths.length === 0) return [];
  const selectedPaths = await expandPythonSourceClosure({
    context,
    rootPaths: uniqueSorted(rootPaths.map(normalizeValidationFileViewPath).filter((path) => sourceSet.sourceFileByPath.has(path))),
    edges: sourceSet.repoImports,
    sourceByPath: sourceSet.sourceFileByPath,
    resolveContexts
  });
  return selectedPaths.map((path) => sourceSet.sourceFileByPath.get(path)).filter(isDefined);
}

export function createPythonProjectContextResolver(
  options: Omit<ResolvePythonProjectContextsOptions, "repoRoot" | "targets" | "workspace"> & {
    nodeWorkspace?: PythonProjectWorkspace;
  } = {}
): PythonProjectContextResolver {
  const cache = new WeakMap<ValidationFileView, PythonProjectContextCache>();
  return async (context, requestedTargets, requestedToolKinds) => {
    let cached = cache.get(context.fileView);
    if (cached === undefined) {
      cached = { contexts: new Map(), pending: new Map() };
      cache.set(context.fileView, cached);
    }
    const targets = requestedTargets === undefined
      ? await (cached.inputTargets ??= readPythonAfterSources(context).then((sources) => sources.map((source) => source.path)))
      : uniqueSorted(requestedTargets.map(normalizeValidationFileViewPath).filter(isPythonSourcePath));
    const normalizedToolKinds = normalizeToolKinds(requestedToolKinds);
    const toolKey = normalizedToolKinds.join(",");
    while (true) {
      const missing = targets.filter((target) => !cached.contexts.has(cacheKey(target, toolKey)));
      if (missing.length === 0) return targets.map((target) => requiredProjectContext(cached.contexts, cacheKey(target, toolKey)));
      const pending = cached.pending.get(toolKey);
      if (pending !== undefined) {
        await pending;
        continue;
      }
      const nextPending = resolvePythonProjectContexts({
        repoRoot: context.request.repo.repoRoot ?? process.cwd(),
        targets: missing,
        workspace: createValidationFileViewPythonWorkspace(context.fileView, undefined, options.nodeWorkspace),
        ...(normalizedToolKinds.length === allPythonProjectToolKinds.length ? {} : { toolKinds: normalizedToolKinds }),
        ...withoutNodeWorkspace(options)
      }).then((contexts) => {
        for (const projectContext of contexts) cached.contexts.set(cacheKey(projectContext.target, toolKey), projectContext);
      });
      cached.pending.set(toolKey, nextPending);
      try {
        await nextPending;
      } finally {
        cached.pending.delete(toolKey);
      }
    }
  };
}

interface PythonProjectContextCache {
  contexts: Map<string, PythonProjectContext>;
  inputTargets?: Promise<readonly string[]>;
  pending: Map<string, Promise<void>>;
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

function normalizeToolKinds(
  toolKinds: readonly (typeof allPythonProjectToolKinds)[number][] | undefined
): readonly (typeof allPythonProjectToolKinds)[number][] {
  if (toolKinds === undefined) return [...allPythonProjectToolKinds];
  return uniqueSorted(
    toolKinds.filter((tool): tool is (typeof allPythonProjectToolKinds)[number] => allPythonProjectToolKinds.includes(tool))
  ) as readonly (typeof allPythonProjectToolKinds)[number][];
}

function cacheKey(target: string, toolKey: string): string {
  return `${toolKey}\0${target}`;
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

  const repoImports = validatePythonImportEdges(
    context.graph?.identity.kind === "exact"
      ? pythonImportEdgesFromGraph(await context.graph.importsFrom(), new Set(allSourceByPath.keys()))
      : await requirePythonImportAnalyzer(importAnalyzer).analyze(allSources),
    new Set(allSourceByPath.keys())
  );
  const selectedPaths = await expandPythonSourceClosure({
    context,
    rootPaths,
    edges: repoImports,
    sourceByPath: allSourceByPath,
    resolveContexts
  });
  const files = selectedPaths
    .map((path) => allSourceByPath.get(path))
    .filter((file): file is PythonMaterializedSourceFile => file !== undefined);
  const sourceFileByPath = new Map(files.map((file) => [file.path, file]));
  const selectedPathSet = new Set(selectedPaths);
  return {
    rootPaths,
    paths: selectedPaths,
    allPaths: [...allSourceByPath.keys()].sort(),
    files,
    sourceFileByPath,
    repoImports: repoImports.filter((edge) => selectedPathSet.has(edge.fromPath) && selectedPathSet.has(edge.toPath)),
    allRepoImports: repoImports
  };
}

function emptySourceSet(): PythonMaterializedSourceSet {
  return {
    rootPaths: [],
    paths: [],
    allPaths: [],
    files: [],
    sourceFileByPath: new Map(),
    repoImports: [],
    allRepoImports: []
  };
}

export function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
