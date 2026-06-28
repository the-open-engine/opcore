import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { EditRefusal, RepoRelativeChange } from "@the-open-engine/opcore-contracts";
import { decodeTextContent } from "./content-policy.js";
import { Node, Project, SyntaxKind, ts, type SourceFile, type Symbol as MorphSymbol } from "ts-morph";
import { calculateEditChecksum } from "./hash.js";
import { normalizeEditRepoRelativePath } from "./path-policy.js";
import type { MoveSymbolEditRequest, RenameSymbolEditRequest, SignatureParameterChange, SignatureSymbolEditRequest, SymbolEditTarget } from "./symbol-requests.js";

export type SymbolMaterializationResult =
  | {
      ok: true;
      changes: readonly RepoRelativeChange[];
      affectedChecksums: readonly AffectedChecksum[];
      afterState?: Readonly<Record<string, string | null>>;
    }
  | { ok: false; refusal: EditRefusal };

export interface AffectedChecksum {
  path: string;
  checksumBefore?: string;
  checksumAfter?: string;
}

export type SymbolEditLanguageServiceProjectScope = "import_closure" | "whole_repo";

export interface SymbolEditLanguageServiceOptions {
  project?: Project;
  projectScope?: SymbolEditLanguageServiceProjectScope;
  projectTsconfigPath?: string;
  snapshotProject?: (project: Project) => unknown;
  revertProject?: (project: Project, snapshot: unknown) => void;
}

const symbolEditProjectScopes = new WeakMap<Project, SymbolEditLanguageServiceProjectScope>();

const sourceFileExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const extensionlessImportCandidates = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"] as const;
const excludedDirectories = new Set(["node_modules", "dist", "build", ".git", ".lattice"]);

export function isSupportedSymbolSourcePath(path: string): boolean {
  return sourceFileExtensions.has(extname(path).toLowerCase());
}

export function materializeRenameSymbolEdit(
  repoRoot: string,
  request: RenameSymbolEditRequest,
  options: SymbolEditLanguageServiceOptions = {}
): SymbolMaterializationResult {
  const supported = requireSupportedSource(request.target.path);
  if (!supported.ok) return supported;
  const changeSets: RepoRelativeChange[][] = [];
  const contexts = createProjectContextsResult(repoRoot, request.target.path, options);
  if (!contexts.ok) return contexts;
  for (const context of contexts.value) {
    const result = withProjectSnapshot(context, (): { ok: true; changes: readonly RepoRelativeChange[] } | { ok: false; refusal: EditRefusal } => {
      const sourceFile = sourceFileForTarget(context.project, repoRoot, request.target.path);
      if (!sourceFile.ok) return sourceFile;
      const target = findIdentifierTarget(sourceFile.value, request.target);
      if (!target.ok) return target;
      const snapshots = snapshotProjectFiles(repoRoot, context.project);
      if (!snapshots.ok) return snapshots;
      try {
        renameTarget(target.value, request.newName);
      } catch (error) {
        return refused("unsafe_edit", `Rename failed for ${request.target.name}: ${errorMessage(error)}`, request.target.path);
      }
      const changes = collectModifiedProjectChanges(repoRoot, context.project, snapshots.value);
      if (!changes.ok) return changes;
      return { ok: true, changes: changes.value };
    });
    if (!result.ok) return result;
    changeSets.push([...result.changes]);
  }
  return mergedChangesResult(changeSets);
}

export function materializeMoveSymbolEdit(
  repoRoot: string,
  request: MoveSymbolEditRequest,
  options: SymbolEditLanguageServiceOptions = {}
): SymbolMaterializationResult {
  const fromAbs = resolve(repoRoot, request.fromPath);
  const toAbs = resolve(repoRoot, request.toPath);
  if (!isInside(repoRoot, fromAbs) || !isInside(repoRoot, toAbs)) {
    return refused("parent_directory", "Move source and target must stay inside the repository");
  }
  if (!existsSync(fromAbs)) return refused("unsafe_edit", `Move source does not exist: ${request.fromPath}`, request.fromPath);
  const fromSource = validateExistingPathInsideRepoSync(repoRoot, fromAbs, request.fromPath, "Move source", "file_or_directory");
  if (!fromSource.ok) return fromSource;
  if (statSync(fromAbs).isDirectory() && isInside(fromAbs, toAbs)) {
    return refused("conflict", `Move target must not be inside move source: ${request.toPath}`, request.toPath);
  }
  const context = createProjectResult(repoRoot, request.fromPath, options);
  if (!context.ok) return context;
  return withProjectSnapshot(context.value, () => materializeMoveSymbolEditInProject(repoRoot, context.value, fromAbs, toAbs));
}

function materializeMoveSymbolEditInProject(repoRoot: string, context: ProjectContext, fromAbs: string, toAbs: string): SymbolMaterializationResult {
  const movePlan = buildMovePlan(context.project, fromAbs, toAbs);
  if (!movePlan.ok) return movePlan;
  const targetConflict = firstTargetConflict(movePlan.value);
  if (targetConflict) return targetConflict;

  const snapshots = snapshotProjectFiles(repoRoot, context.project);
  if (!snapshots.ok) return snapshots;
  const changedImporters = rewriteImportSpecifiersForMoves(context.project, movePlan.value.sourceMoves);
  const importerChanges = collectImporterMoveChanges(repoRoot, context.project, snapshots.value, changedImporters, movePlan.value.sourceMoves);
  if (!importerChanges.ok) return importerChanges;
  const sourceChanges = collectSourceMoveChanges(repoRoot, snapshots.value, movePlan.value.sourceMoves);
  if (!sourceChanges.ok) return sourceChanges;
  const extraChanges = collectExtraMoveChanges(repoRoot, movePlan.value.extraMoves);
  if (!extraChanges.ok) return extraChanges;

  return successFromChanges([...importerChanges.value, ...sourceChanges.value, ...extraChanges.value.changes], afterStateFromEntries(extraChanges.value.afterStateEntries));
}

export function materializeSignatureSymbolEdit(
  repoRoot: string,
  request: SignatureSymbolEditRequest,
  options: SymbolEditLanguageServiceOptions = {}
): SymbolMaterializationResult {
  const supported = requireSupportedSource(request.target.path);
  if (!supported.ok) return supported;
  for (const change of request.changes) {
    if (change.action === "add" && change.defaultValue === undefined && change.optional !== true) {
      return refused("unsupported_change", `Adding parameter ${change.name} requires defaultValue or optional=true`, request.target.path);
    }
  }

  const changeSets: RepoRelativeChange[][] = [];
  const contexts = createProjectContextsResult(repoRoot, request.target.path, options);
  if (!contexts.ok) return contexts;
  for (const context of contexts.value) {
    const result = withProjectSnapshot(context, (): { ok: true; changes: readonly RepoRelativeChange[] } | { ok: false; refusal: EditRefusal } => {
      const sourceFile = sourceFileForTarget(context.project, repoRoot, request.target.path);
      if (!sourceFile.ok) return sourceFile;
      const target = findFunctionTarget(sourceFile.value, request.target);
      if (!target.ok) return target;
      const snapshots = snapshotProjectFiles(repoRoot, context.project);
      if (!snapshots.ok) return snapshots;
      const removalSafety = refuseUnsafeParameterRemovals(target.value, request.changes, request.target.path);
      if (!removalSafety.ok) return removalSafety;
      const callSites = collectCallSites(context.project, target.value);
      const originalParameterNames = target.value.getParameters().map((parameter: { getName: () => string }) => parameter.getName());

      try {
        applyCallSiteSignatureChanges(callSites, originalParameterNames, request.changes);
        applyDeclarationSignatureChanges(target.value, request.changes);
      } catch (error) {
        return refused("unsafe_edit", `Signature change failed for ${request.target.name}: ${errorMessage(error)}`, request.target.path);
      }
      const changes = collectModifiedProjectChanges(repoRoot, context.project, snapshots.value);
      if (!changes.ok) return changes;
      return { ok: true, changes: changes.value };
    });
    if (!result.ok) return result;
    changeSets.push([...result.changes]);
  }
  return mergedChangesResult(changeSets);
}

function createProject(repoRoot: string, preferredRepoPath: string | undefined, options: SymbolEditLanguageServiceOptions): ProjectContext {
  const rawTsconfigPath = join(repoRoot, "tsconfig.json");
  const preferredAbsolutePath = preferredRepoPath === undefined ? undefined : resolve(repoRoot, preferredRepoPath);
  const tsconfigPath = resolveSymbolEditTsconfigPath(repoRoot, options.projectTsconfigPath) ?? resolveTsconfigPath(repoRoot, rawTsconfigPath, preferredAbsolutePath);
  const projectScope = options.projectScope ?? "import_closure";
  if (options.project !== undefined && canUseInjectedProject(options.project, projectScope)) {
    if (projectScope === "import_closure" && preferredRepoPath !== undefined) {
      addScopedSourceFilesToProject(repoRoot, tsconfigPath, options.project, [preferredRepoPath]);
    }
    return {
      project: options.project,
      ...(options.projectTsconfigPath ? { tsconfigPath: options.projectTsconfigPath } : {}),
      ...(options.snapshotProject ? { snapshotProject: options.snapshotProject } : {}),
      ...(options.revertProject ? { revertProject: options.revertProject } : {})
    };
  }
  return {
    project: createProjectForTsconfig(repoRoot, tsconfigPath, preferredRepoPath, projectScope),
    ...(tsconfigPath ? { tsconfigPath } : {})
  };
}

type ProjectContext = {
  project: Project;
  tsconfigPath?: string;
  snapshotProject?: (project: Project) => unknown;
  revertProject?: (project: Project, snapshot: unknown) => void;
};

function createProjectResult(
  repoRoot: string,
  preferredRepoPath: string | undefined,
  options: SymbolEditLanguageServiceOptions
): { ok: true; value: ProjectContext } | { ok: false; refusal: EditRefusal } {
  try {
    return { ok: true, value: createProject(repoRoot, preferredRepoPath, options) };
  } catch (error) {
    return projectConfigurationRefusal(error, preferredRepoPath);
  }
}

function createProjectContextsResult(
  repoRoot: string,
  preferredRepoPath: string | undefined,
  options: SymbolEditLanguageServiceOptions
): { ok: true; value: ProjectContext[] } | { ok: false; refusal: EditRefusal } {
  try {
    return { ok: true, value: createProjectContexts(repoRoot, preferredRepoPath, options) };
  } catch (error) {
    return projectConfigurationRefusal(error, preferredRepoPath);
  }
}

function createProjectContexts(repoRoot: string, preferredRepoPath: string | undefined, options: SymbolEditLanguageServiceOptions): ProjectContext[] {
  if (options.project !== undefined) return [createProject(repoRoot, preferredRepoPath, options)];
  const rawTsconfigPath = join(repoRoot, "tsconfig.json");
  const preferredAbsolutePath = preferredRepoPath === undefined ? undefined : resolve(repoRoot, preferredRepoPath);
  const preferredTsconfigPath = resolveSymbolEditTsconfigPath(repoRoot, options.projectTsconfigPath) ?? resolveTsconfigPath(repoRoot, rawTsconfigPath, preferredAbsolutePath);
  const projectScope = options.projectScope ?? "import_closure";
  const orderedPaths: string[] = [];
  if (preferredTsconfigPath !== undefined) orderedPaths.push(resolve(preferredTsconfigPath));
  for (const tsconfigPath of collectProjectTsconfigPaths(repoRoot)) {
    if (!orderedPaths.includes(tsconfigPath)) orderedPaths.push(tsconfigPath);
  }
  if (orderedPaths.length === 0) return [{ project: createProjectForTsconfig(repoRoot, undefined, preferredRepoPath, projectScope) }];
  return orderedPaths.map((tsconfigPath) => ({
    project: createProjectForTsconfig(repoRoot, tsconfigPath, preferredRepoPath, projectScope),
    tsconfigPath
  }));
}

function canUseInjectedProject(project: Project, requiredScope: SymbolEditLanguageServiceProjectScope): boolean {
  return requiredScope !== "whole_repo" || symbolEditProjectScopes.get(project) === "whole_repo";
}

function projectConfigurationRefusal(error: unknown, path?: string): { ok: false; refusal: EditRefusal } {
  return refused("unsafe_edit", `TypeScript project configuration cannot be loaded for symbol edit: ${errorMessage(error)}`, path);
}

export function createSymbolEditLanguageServiceProject(
  repoRoot: string,
  preferredRepoPath?: string,
  options: SymbolEditLanguageServiceOptions = {}
): Project {
  return createProject(repoRoot, preferredRepoPath, options).project;
}

function withProjectSnapshot<T>(context: ProjectContext, run: () => T): T {
  if (context.snapshotProject === undefined || context.revertProject === undefined) return run();
  const snapshot = context.snapshotProject(context.project);
  try {
    return run();
  } finally {
    context.revertProject(context.project, snapshot);
  }
}

function createProjectForTsconfig(
  repoRoot: string,
  tsconfigPath: string | undefined,
  preferredRepoPath: string | undefined,
  scope: SymbolEditLanguageServiceProjectScope
): Project {
  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false
    }
  });
  const sourceFiles = scope === "whole_repo" || preferredRepoPath === undefined
    ? listSourceFiles(repoRoot)
    : scopedSourceFiles(repoRoot, tsconfigPath, [preferredRepoPath], { includeDependents: true });
  for (const filePath of sourceFiles) {
    if (!project.getSourceFile(filePath)) project.addSourceFileAtPath(filePath);
  }
  symbolEditProjectScopes.set(project, scope);
  return project;
}

function addScopedSourceFilesToProject(
  repoRoot: string,
  tsconfigPath: string | undefined,
  project: Project,
  rootRepoPaths: readonly string[]
): void {
  for (const filePath of scopedSourceFiles(repoRoot, tsconfigPath, rootRepoPaths, { includeDependents: true })) {
    if (project.getSourceFile(filePath) === undefined) project.addSourceFileAtPath(filePath);
  }
}

function collectProjectTsconfigPaths(repoRoot: string): string[] {
  const discovered = new Set<string>();
  const queue = [join(repoRoot, "tsconfig.json"), ...listTsconfigJsonPaths(repoRoot)];
  for (let index = 0; index < queue.length; index += 1) {
    const tsconfigPath = resolve(queue[index]);
    if (discovered.has(tsconfigPath) || !isSafeExistingFileInsideRepo(repoRoot, tsconfigPath)) continue;
    discovered.add(tsconfigPath);
    try {
      const config = parseTsconfig(tsconfigPath);
      for (const referencePath of referencedTsconfigPaths(repoRoot, tsconfigPath, config)) queue.push(referencePath);
    } catch {
      // Ignore malformed auxiliary configs here; the preferred project path keeps existing behavior.
    }
  }
  return [...discovered].sort();
}

function listTsconfigJsonPaths(repoRoot: string): string[] {
  const paths: string[] = [];
  visit(repoRoot);
  return paths.sort();

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(path);
      } else if (entry.isFile() && entry.name === "tsconfig.json" && isSafeExistingFileInsideRepo(repoRoot, path)) {
        paths.push(resolve(path));
      }
    }
  }
}

function resolveTsconfigPath(repoRoot: string, tsconfigPath: string, preferredAbsolutePath?: string): string | undefined {
  return resolveTsconfigPathInternal(repoRoot, tsconfigPath, preferredAbsolutePath, new Set());
}

function resolveTsconfigPathInternal(repoRoot: string, tsconfigPath: string, preferredAbsolutePath: string | undefined, seen: Set<string>): string | undefined {
  if (!isSafeExistingFileInsideRepo(repoRoot, tsconfigPath)) return undefined;
  const normalizedTsconfigPath = resolve(tsconfigPath);
  if (seen.has(normalizedTsconfigPath)) return undefined;
  seen.add(normalizedTsconfigPath);
  try {
    const config = parseTsconfig(tsconfigPath);
    const referenceOnly = Array.isArray(config.references) && config.references.length > 0 && Array.isArray(config.files) && config.files.length === 0 && config.include === undefined;
    if (!referenceOnly) return tsconfigPath;
    const candidates = referencedTsconfigPaths(repoRoot, tsconfigPath, config);
    if (preferredAbsolutePath !== undefined) {
      const ownedCandidates = candidates
        .flatMap((candidate) => {
          const resolvedCandidate = resolveTsconfigPathInternal(repoRoot, candidate, preferredAbsolutePath, new Set(seen));
          return resolvedCandidate === undefined ? [] : [resolvedCandidate];
        })
        .filter((candidate, index, values) => values.indexOf(candidate) === index)
        .filter((candidate) => isInside(dirname(candidate), preferredAbsolutePath))
        .sort((left, right) => dirname(right).length - dirname(left).length || left.localeCompare(right));
      if (ownedCandidates.length > 0) return ownedCandidates[0];
    }
    return candidates[0] ?? tsconfigPath;
  } catch {
    return tsconfigPath;
  }
}

type TsconfigJson = {
  references?: readonly { path?: string }[];
  files?: readonly string[];
  include?: readonly string[];
  compilerOptions?: {
    baseUrl?: unknown;
    paths?: unknown;
  };
};

function parseTsconfig(tsconfigPath: string): TsconfigJson {
  const parsed = ts.parseConfigFileTextToJson(tsconfigPath, readFileSync(tsconfigPath, "utf8"));
  if (parsed.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  return parsed.config as TsconfigJson;
}

function referencedTsconfigPaths(repoRoot: string, tsconfigPath: string, config: TsconfigJson): string[] {
  const candidates: string[] = [];
  for (const reference of config.references ?? []) {
    if (!reference.path) continue;
    const candidate = reference.path.endsWith(".json")
      ? resolve(dirname(tsconfigPath), reference.path)
      : resolve(dirname(tsconfigPath), reference.path, "tsconfig.json");
    if (isSafeExistingFileInsideRepo(repoRoot, candidate)) candidates.push(candidate);
  }
  return candidates;
}

interface ImportResolutionOptions {
  baseUrl: string;
  hasBaseUrl: boolean;
  paths: Readonly<Record<string, readonly string[]>>;
}

function scopedSourceFiles(
  repoRoot: string,
  tsconfigPath: string | undefined,
  rootRepoPaths: readonly string[],
  options: { includeDependents: boolean }
): string[] {
  const importOptions = importResolutionOptions(repoRoot, tsconfigPath);
  const importTargetsByFile = new Map<string, readonly string[]>();
  const allSourceFiles = options.includeDependents ? listSourceFiles(repoRoot) : [];
  const roots = rootSourceFiles(repoRoot, rootRepoPaths);
  const reverseTargets = new Set(roots);
  const selected = new Set<string>();
  addForwardClosure(roots, selected);

  if (options.includeDependents) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const filePath of allSourceFiles) {
        if (selected.has(filePath)) continue;
        const importsReverseTarget = importTargets(filePath).some((importedPath) => reverseTargets.has(importedPath));
        if (!importsReverseTarget) continue;
        const beforeSize = selected.size;
        addForwardClosure([filePath], selected);
        reverseTargets.add(filePath);
        if (selected.size !== beforeSize) changed = true;
      }
    }
  }

  return [...selected].sort();

  function addForwardClosure(rootFiles: readonly string[], selectedFiles: Set<string>): void {
    const pending = [...rootFiles].sort();
    for (let index = 0; index < pending.length; index += 1) {
      const filePath = pending[index];
      if (selectedFiles.has(filePath)) continue;
      selectedFiles.add(filePath);
      for (const importedPath of importTargets(filePath)) {
        if (!selectedFiles.has(importedPath) && !pending.includes(importedPath)) pending.push(importedPath);
      }
    }
  }

  function importTargets(filePath: string): readonly string[] {
    const cached = importTargetsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const resolvedTargets = moduleImportSpecifiers(readFileSync(filePath, "utf8"))
      .flatMap((specifier) => {
        const resolvedImport = resolveImportSpecifier(repoRoot, filePath, specifier, importOptions);
        return resolvedImport === undefined ? [] : [resolvedImport];
      })
      .sort();
    importTargetsByFile.set(filePath, resolvedTargets);
    return resolvedTargets;
  }
}

function rootSourceFiles(repoRoot: string, rootRepoPaths: readonly string[]): string[] {
  const files: string[] = [];
  for (const rootRepoPath of rootRepoPaths) {
    const absolutePath = resolve(repoRoot, rootRepoPath);
    if (isSupportedSymbolSourcePath(absolutePath) && isSafeExistingFileInsideRepo(repoRoot, absolutePath)) {
      files.push(resolve(absolutePath));
      continue;
    }
    if (!isSafeExistingDirectoryInsideRepo(repoRoot, absolutePath)) continue;
    const directoryRoot = resolve(absolutePath);
    files.push(...listSourceFiles(repoRoot).filter((filePath) => isInside(directoryRoot, filePath)));
  }
  return uniqueSorted(files);
}

function moduleImportSpecifiers(text: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gu)) {
    if (match[1]) specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/<reference\s+path=["']([^"']+)["']/gu)) {
    if (match[1]) specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu)) {
    if (match[1]) specifiers.add(match[1]);
  }
  return [...specifiers].filter(isRepoResolvableSpecifier).sort();
}

function resolveImportSpecifier(
  repoRoot: string,
  fromPath: string,
  specifier: string,
  options: ImportResolutionOptions
): string | undefined {
  if (isRelativeSpecifier(specifier)) return resolveModulePathFromBase(repoRoot, resolve(dirname(fromPath), specifier));
  for (const [pattern, targets] of sortedPathMappings(options.paths)) {
    const wildcard = matchPathPattern(pattern, specifier);
    if (wildcard === undefined) continue;
    for (const target of targets) {
      const resolved = resolveModulePathFromBase(repoRoot, resolve(options.baseUrl, applyPathMappingTarget(target, wildcard)));
      if (resolved !== undefined) return resolved;
    }
  }
  return options.hasBaseUrl ? resolveModulePathFromBase(repoRoot, resolve(options.baseUrl, specifier)) : undefined;
}

function resolveModulePathFromBase(repoRoot: string, basePath: string): string | undefined {
  for (const candidate of modulePathCandidates(basePath)) {
    if (isSupportedSymbolSourcePath(candidate) && isSafeExistingFileInsideRepo(repoRoot, candidate)) return resolve(candidate);
  }
  return undefined;
}

function modulePathCandidates(basePath: string): readonly string[] {
  const extension = sourceExtension(basePath);
  if (extension === ".js" || extension === ".jsx") {
    const candidates = extension === ".jsx"
      ? [replaceImportExtension(basePath, ".tsx"), replaceImportExtension(basePath, ".ts")]
      : [replaceImportExtension(basePath, ".ts"), replaceImportExtension(basePath, ".tsx")];
    return unique([...candidates, replaceImportExtension(basePath, ".d.ts"), basePath, replaceImportExtension(basePath, extension === ".js" ? ".jsx" : ".js")]);
  }
  if (extension !== undefined) return [basePath];
  return unique([
    ...extensionlessImportCandidates.map((candidateExtension) => `${basePath}${candidateExtension}`),
    ...extensionlessImportCandidates.map((candidateExtension) => join(basePath, `index${candidateExtension}`))
  ]);
}

function importResolutionOptions(repoRoot: string, tsconfigPath: string | undefined): ImportResolutionOptions {
  const configDirectory = tsconfigPath === undefined ? repoRoot : dirname(tsconfigPath);
  const config = tsconfigPath === undefined ? undefined : parseTsconfig(tsconfigPath);
  const compilerOptions = config?.compilerOptions;
  const baseUrl = typeof compilerOptions?.baseUrl === "string" && compilerOptions.baseUrl.length > 0
    ? resolve(configDirectory, compilerOptions.baseUrl)
    : configDirectory;
  return {
    baseUrl,
    hasBaseUrl: typeof compilerOptions?.baseUrl === "string" && compilerOptions.baseUrl.length > 0,
    paths: normalizePathMappings(compilerOptions?.paths)
  };
}

function normalizePathMappings(paths: unknown): Readonly<Record<string, readonly string[]>> {
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) return {};
  const normalized: Record<string, readonly string[]> = {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (Array.isArray(targets)) normalized[pattern] = targets.filter((target): target is string => typeof target === "string");
  }
  return normalized;
}

function sortedPathMappings(paths: Readonly<Record<string, readonly string[]>>): readonly [string, readonly string[]][] {
  return Object.entries(paths)
    .filter((entry): entry is [string, readonly string[]] => entry[1].length > 0)
    .sort((left, right) => pathPatternRank(right[0]) - pathPatternRank(left[0]));
}

function pathPatternRank(pattern: string): number {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) return pattern.length * 2 + 1;
  return pattern.length - 1;
}

function matchPathPattern(pattern: string, specifier: string): string | undefined {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyPathMappingTarget(target: string, wildcard: string): string {
  return target.includes("*") ? target.replaceAll("*", wildcard) : target;
}

function listSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  visit(repoRoot);
  return files.sort();

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(path);
      } else if (entry.isFile() && isSupportedSymbolSourcePath(path)) {
        const repoPath = normalizeModulePath(relative(repoRoot, path));
        if (validateExistingPathInsideRepoSync(repoRoot, path, repoPath, "Source file", "file").ok) files.push(path);
      }
    }
  }
}

function resolveSymbolEditTsconfigPath(repoRoot: string, tsconfigPath: string | undefined): string | undefined {
  if (tsconfigPath === undefined) return undefined;
  const absolutePath = resolve(repoRoot, tsconfigPath);
  return isSafeExistingFileInsideRepo(repoRoot, absolutePath) ? absolutePath : undefined;
}

function sourceFileForTarget(project: Project, repoRoot: string, repoPath: string): { ok: true; value: SourceFile } | { ok: false; refusal: EditRefusal } {
  const absolutePath = resolve(repoRoot, repoPath);
  const target = validateExistingPathInsideRepoSync(repoRoot, absolutePath, repoPath, "Source file", "file");
  if (!target.ok) return target;
  const sourceFile = project.getSourceFile(absolutePath) ?? project.addSourceFileAtPath(absolutePath);
  return { ok: true, value: sourceFile };
}

function findIdentifierTarget(sourceFile: SourceFile, target: SymbolEditTarget): { ok: true; value: Node } | { ok: false; refusal: EditRefusal } {
  const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).filter((identifier) => {
    if (identifier.getText() !== target.name) return false;
    const position = sourceFile.getLineAndColumnAtPos(identifier.getStart());
    if (target.line !== undefined && position.line !== target.line) return false;
    if (target.column !== undefined && !(position.column <= target.column && target.column <= position.column + target.name.length)) return false;
    return true;
  });
  if (identifiers.length === 0) {
    return refused("unsafe_edit", `Symbol "${target.name}" not found in ${target.path}${target.line ? ` at line ${target.line}` : ""}`, target.path);
  }
  const bySymbol = new Map<string, Node>();
  for (const identifier of identifiers) bySymbol.set(symbolIdentity(identifier), identifier);
  if (bySymbol.size > 1) return refused("unsafe_edit", `Ambiguous symbol target "${target.name}" in ${target.path}`, target.path);
  return { ok: true, value: [...bySymbol.values()][0] };
}

function findFunctionTarget(sourceFile: SourceFile, target: SymbolEditTarget): { ok: true; value: FunctionLikeNode } | { ok: false; refusal: EditRefusal } {
  const candidates: FunctionLikeNode[] = [
    ...sourceFile.getFunctions().filter((fn) => fn.getName() === target.name),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration).filter((method) => method.getName() === target.name)
  ] as FunctionLikeNode[];
  const filtered = candidates.filter((candidate) => target.line === undefined || candidate.getStartLineNumber() === target.line);
  if (filtered.length === 0) return refused("unsafe_edit", `Function/method "${target.name}" not found in ${target.path}`, target.path);
  if (filtered.length > 1) return refused("unsafe_edit", `Ambiguous function/method target "${target.name}" in ${target.path}`, target.path);
  return { ok: true, value: filtered[0] };
}

function renameTarget(node: Node, newName: string): void {
  if ("rename" in node && typeof (node as { rename?: unknown }).rename === "function") {
    (node as { rename: (name: string) => void }).rename(newName);
    return;
  }
  const declaration = node.getSymbol()?.getDeclarations()[0];
  if (declaration && "rename" in declaration && typeof (declaration as { rename?: unknown }).rename === "function") {
    (declaration as { rename: (name: string) => void }).rename(newName);
    return;
  }
  throw new Error(`Symbol does not support rename: ${node.getText()}`);
}

function symbolIdentity(node: Node): string {
  const declaration = symbolDeclaration(node.getSymbol()) ?? node;
  return nodeIdentity(declaration);
}

function resolvedSymbolIdentity(node: Node): string | undefined {
  const declaration = symbolDeclaration(node.getSymbol());
  return declaration ? nodeIdentity(declaration) : undefined;
}

function symbolDeclaration(symbol: MorphSymbol | undefined): Node | undefined {
  const resolved = symbol?.getAliasedSymbol() ?? symbol;
  return resolved?.getValueDeclaration() ?? resolved?.getDeclarations()[0];
}

function nodeIdentity(declaration: Node): string {
  return `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}:${declaration.getKindName()}`;
}

function snapshotProjectFiles(repoRoot: string, project: Project): { ok: true; value: Map<string, string | null> } | { ok: false; refusal: EditRefusal } {
  const snapshots = new Map<string, string | null>();
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = resolve(sourceFile.getFilePath());
    if (!isInside(repoRoot, filePath)) continue;
    const repoPath = normalizeModulePath(relative(repoRoot, filePath));
    if (!existsSync(filePath)) {
      snapshots.set(filePath, null);
      continue;
    }
    const safe = validateExistingPathInsideRepoSync(repoRoot, filePath, repoPath, "Source file", "file");
    if (!safe.ok) return safe;
    snapshots.set(filePath, readFileSync(filePath, "utf8"));
  }
  return { ok: true, value: snapshots };
}

function changesFromModifiedProject(repoRoot: string, project: Project, snapshots: Map<string, string | null>): SymbolMaterializationResult {
  const changes = collectModifiedProjectChanges(repoRoot, project, snapshots);
  if (!changes.ok) return changes;
  if (changes.value.length === 0) return refused("unsafe_edit", "Symbol edit produced no changes");
  return successFromChanges(changes.value);
}

function collectModifiedProjectChanges(
  repoRoot: string,
  project: Project,
  snapshots: Map<string, string | null>
): { ok: true; value: RepoRelativeChange[] } | { ok: false; refusal: EditRefusal } {
  const changes: RepoRelativeChange[] = [];
  for (const sourceFile of project.getSourceFiles().sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()))) {
    const absolutePath = resolve(sourceFile.getFilePath());
    if (!isInside(repoRoot, absolutePath)) continue;
    const before = snapshots.get(absolutePath);
    if (before === undefined || before === null) continue;
    const repoPath = normalizeModulePath(relative(repoRoot, absolutePath));
    const safe = validateExistingPathInsideRepoSync(repoRoot, absolutePath, repoPath, "Source file", "file");
    if (!safe.ok) return safe;
    const after = sourceFile.getFullText();
    if (before === after) continue;
    const path = toRepoPath(repoRoot, absolutePath);
    if (!path.ok) return path;
    changes.push(replaceChange(path.value, before, after));
  }
  return { ok: true, value: changes };
}

function mergedChangesResult(changeSets: readonly RepoRelativeChange[][]): SymbolMaterializationResult {
  const merged = new Map<string, RepoRelativeChange>();
  for (const changes of changeSets) {
    for (const change of changes) {
      const key = changeKey(change);
      const previous = merged.get(key);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(change)) {
        return refused("unsafe_edit", `Conflicting symbol edits for ${change.path}`, change.path);
      }
      merged.set(key, change);
    }
  }
  if (merged.size === 0) return refused("unsafe_edit", "Symbol edit produced no changes");
  return successFromChanges([...merged.values()]);
}

type SourceFileMove = { fromPath: string; sourceFile: SourceFile; toPath: string };
type FileSystemMove = { fromPath: string; toPath: string };
type MovePlan = { sourceMoves: SourceFileMove[]; extraMoves: FileSystemMove[] };
type MoveChangeResult = { ok: true; value: RepoRelativeChange[] } | { ok: false; refusal: EditRefusal };
type ExtraMoveChangeResult = { ok: true; value: { changes: RepoRelativeChange[]; afterStateEntries: [string, string | null][] } } | { ok: false; refusal: EditRefusal };

function buildMovePlan(project: Project, fromPath: string, toPath: string): { ok: true; value: MovePlan } | { ok: false; refusal: EditRefusal } {
  const sourceFilesByPath = new Map(project.getSourceFiles().map((sourceFile) => [resolve(sourceFile.getFilePath()), sourceFile] as const));
  const stat = statSync(fromPath);
  if (stat.isDirectory()) {
    const moves = listFilesRecursively(fromPath).map((filePath) => ({ fromPath: filePath, toPath: join(toPath, relative(fromPath, filePath)) }));
    if (moves.length === 0) return refused("unsupported_change", `Move source directory is empty: ${fromPath}`);
    const sourceMoves: SourceFileMove[] = [];
    const extraMoves: FileSystemMove[] = [];
    for (const move of moves) {
      const sourceFile = sourceFilesByPath.get(resolve(move.fromPath));
      if (sourceFile && isSupportedSymbolSourcePath(move.fromPath)) sourceMoves.push({ ...move, sourceFile });
      else extraMoves.push(move);
    }
    return { ok: true, value: { sourceMoves, extraMoves } };
  }
  const sourceFile = sourceFilesByPath.get(resolve(fromPath));
  if (sourceFile && isSupportedSymbolSourcePath(fromPath)) return { ok: true, value: { sourceMoves: [{ fromPath, toPath, sourceFile }], extraMoves: [] } };
  return { ok: true, value: { sourceMoves: [], extraMoves: [{ fromPath, toPath }] } };
}

function firstTargetConflict(plan: MovePlan): { ok: false; refusal: EditRefusal } | undefined {
  const sources = new Set([...plan.sourceMoves.map((move) => resolve(move.fromPath)), ...plan.extraMoves.map((move) => resolve(move.fromPath))]);
  for (const target of [...plan.sourceMoves.map((move) => move.toPath), ...plan.extraMoves.map((move) => move.toPath)]) {
    if (existsSync(target) && !sources.has(resolve(target))) {
      return refused("conflict", `Move target already exists: ${target}`);
    }
  }
  return undefined;
}

function collectImporterMoveChanges(
  repoRoot: string,
  project: Project,
  snapshots: Map<string, string | null>,
  changedImporters: ReadonlySet<string>,
  sourceMoves: readonly SourceFileMove[]
): MoveChangeResult {
  const changes: RepoRelativeChange[] = [];
  const sourceMovePaths = new Set(sourceMoves.map((move) => move.fromPath));
  for (const importerPath of [...changedImporters].sort()) {
    if (sourceMovePaths.has(importerPath)) continue;
    const sourceFile = project.getSourceFile(importerPath);
    const before = snapshots.get(importerPath);
    if (!sourceFile || before === undefined || before === null) continue;
    const after = sourceFile.getFullText();
    if (after === before) continue;
    const path = toRepoPath(repoRoot, importerPath);
    if (!path.ok) return path;
    changes.push(replaceChange(path.value, before, after));
  }
  return { ok: true, value: changes };
}

function collectSourceMoveChanges(repoRoot: string, snapshots: Map<string, string | null>, sourceMoves: readonly SourceFileMove[]): MoveChangeResult {
  const changes: RepoRelativeChange[] = [];
  for (const move of [...sourceMoves].sort(compareSourceMoves)) {
    const fromPath = toRepoPath(repoRoot, move.fromPath);
    if (!fromPath.ok) return fromPath;
    const toPath = toRepoPath(repoRoot, move.toPath);
    if (!toPath.ok) return toPath;
    const before = snapshots.get(move.fromPath);
    if (before === undefined || before === null) return refused("unsafe_edit", `Move source could not be read: ${fromPath.value}`, fromPath.value);
    changes.push(deleteChange(fromPath.value, before));
    changes.push(createChange(toPath.value, move.sourceFile.getFullText()));
  }
  return { ok: true, value: changes };
}

function collectExtraMoveChanges(repoRoot: string, extraMoves: readonly FileSystemMove[]): ExtraMoveChangeResult {
  const changes: RepoRelativeChange[] = [];
  const afterStateEntries: [string, string | null][] = [];
  for (const move of [...extraMoves].sort(compareFileMoves)) {
    const fromPath = toRepoPath(repoRoot, move.fromPath);
    if (!fromPath.ok) return fromPath;
    const toPath = toRepoPath(repoRoot, move.toPath);
    if (!toPath.ok) return toPath;
    const source = validateExistingPathInsideRepoSync(repoRoot, move.fromPath, fromPath.value, "Move source", "file");
    if (!source.ok) return source;
    const decoded = decodeTextContent(readFileSync(move.fromPath), fromPath.value, "non-source move source");
    if (!decoded.ok) return decoded;
    changes.push({ kind: "rename", path: fromPath.value, toPath: toPath.value, checksumBefore: decoded.value.checksum });
    afterStateEntries.push([fromPath.value, null], [toPath.value, decoded.value.content]);
  }
  return { ok: true, value: { changes, afterStateEntries } };
}

function listFilesRecursively(directoryPath: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directoryPath, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

type RelativeModuleResolution =
  | { kind: "explicit"; specifierExtension: string; targetPath: string }
  | { kind: "file"; targetPath: string }
  | { kind: "index"; targetPath: string };

function rewriteImportSpecifiersForMoves(project: Project, sourceMoves: readonly SourceFileMove[]): Set<string> {
  const moveMap = new Map(sourceMoves.map((move) => [resolve(move.fromPath), resolve(move.toPath)] as const));
  const knownSourcePaths = new Set(project.getSourceFiles().map((sourceFile) => resolve(sourceFile.getFilePath())));
  const changedImporters = new Set<string>();
  for (const sourceFile of project.getSourceFiles()) {
    const importerOldPath = resolve(sourceFile.getFilePath());
    const importerNewPath = moveMap.get(importerOldPath) ?? importerOldPath;
    for (const literal of sourceFile.getImportStringLiterals()) {
      const specifier = literal.getLiteralValue();
      const resolution = resolveRelativeModuleTarget(importerOldPath, specifier, knownSourcePaths);
      if (!resolution) continue;
      const targetNewPath = moveMap.get(resolve(resolution.targetPath)) ?? resolution.targetPath;
      if (importerNewPath === importerOldPath && targetNewPath === resolution.targetPath) continue;
      const nextSpecifier = toRelativeModuleSpecifier(importerNewPath, targetNewPath, resolution);
      if (nextSpecifier !== specifier) {
        literal.setLiteralValue(nextSpecifier);
        changedImporters.add(importerOldPath);
      }
    }
  }
  return changedImporters;
}

function resolveRelativeModuleTarget(importerPath: string, specifier: string, knownSourcePaths: Set<string>): RelativeModuleResolution | null {
  if (!specifier.startsWith(".")) return null;
  const basePath = resolve(dirname(importerPath), specifier);
  const explicitExtension = extname(specifier);
  if (explicitExtension.length > 0) {
    if (knownSourcePaths.has(basePath) || existsSync(basePath)) return { kind: "explicit", specifierExtension: explicitExtension, targetPath: basePath };
    for (const sourceExtension of sourceFileExtensions) {
      const candidatePath = withExtension(basePath, sourceExtension);
      if (knownSourcePaths.has(candidatePath) || existsSync(candidatePath)) return { kind: "explicit", specifierExtension: explicitExtension, targetPath: candidatePath };
    }
    return null;
  }
  for (const sourceExtension of sourceFileExtensions) {
    const candidatePath = `${basePath}${sourceExtension}`;
    if (knownSourcePaths.has(candidatePath) || existsSync(candidatePath)) return { kind: "file", targetPath: candidatePath };
  }
  for (const sourceExtension of sourceFileExtensions) {
    const candidatePath = join(basePath, `index${sourceExtension}`);
    if (knownSourcePaths.has(candidatePath) || existsSync(candidatePath)) return { kind: "index", targetPath: candidatePath };
  }
  return null;
}

function toRelativeModuleSpecifier(importerPath: string, targetPath: string, resolution: RelativeModuleResolution): string {
  const targetSpecifierPath = resolution.kind === "index"
    ? dirname(targetPath)
    : resolution.kind === "explicit"
      ? withExtension(targetPath, resolution.specifierExtension)
      : targetPath;
  let relativePath = normalizeModulePath(relative(dirname(importerPath), targetSpecifierPath));
  if (relativePath.length === 0) relativePath = ".";
  else if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
  if (resolution.kind === "file") {
    const fileExtension = extname(targetSpecifierPath);
    if (fileExtension.length > 0 && relativePath.endsWith(fileExtension)) relativePath = relativePath.slice(0, -fileExtension.length);
  }
  return relativePath;
}

function refuseUnsafeParameterRemovals(
  target: FunctionLikeNode,
  changes: readonly SignatureParameterChange[],
  path: string
): { ok: true } | { ok: false; refusal: EditRefusal } {
  const removedNames = changes
    .filter((change): change is Extract<SignatureParameterChange, { action: "remove" }> => change.action === "remove")
    .map((change) => change.name);
  if (removedNames.length === 0) return { ok: true };

  for (const name of removedNames) {
    const parameter = target.getParameters().find((candidate: ParameterLike) => candidate.getName() === name);
    if (!parameter) return refused("unsafe_edit", `Parameter not found: ${name}`, path);
    const references = findParameterReferenceNodes(parameter);
    const unsafeReference = references.find((reference) =>
      sameSourceFile(reference, target) &&
      containsNode(target, reference) &&
      !containsNode(parameter, reference)
    );
    if (unsafeReference) {
      return refused("unsafe_edit", `Removing parameter ${name} would leave body references to ${name} in ${path}`, path);
    }
  }
  return { ok: true };
}

function findParameterReferenceNodes(parameter: ParameterLike): Node[] {
  const referenceFindable = parameter as Node & { findReferencesAsNodes?: () => Node[] };
  if (typeof referenceFindable.findReferencesAsNodes === "function") return referenceFindable.findReferencesAsNodes();
  return parameter.getProject().getLanguageService().findReferencesAsNodes(parameter);
}

function containsNode(parent: Node, child: Node): boolean {
  return sameSourceFile(parent, child) && parent.getStart() <= child.getStart() && child.getEnd() <= parent.getEnd();
}

function sameSourceFile(left: Node, right: Node): boolean {
  return resolve(left.getSourceFile().getFilePath()) === resolve(right.getSourceFile().getFilePath());
}

function applyCallSiteSignatureChanges(callSites: readonly CallExpressionLike[], originalParameterNames: readonly string[], changes: readonly SignatureParameterChange[]): void {
  const removals = changes
    .filter((change): change is Extract<SignatureParameterChange, { action: "remove" }> => change.action === "remove")
    .map((change) => originalParameterNames.indexOf(change.name))
    .filter((index) => index >= 0)
    .sort((left, right) => right - left);
  const additions = changes
    .filter((change): change is Extract<SignatureParameterChange, { action: "add" }> => change.action === "add")
    .map((change) => ({ change, index: change.position ?? originalParameterNames.length }))
    .sort((left, right) => left.index - right.index);
  for (const callSite of callSites) {
    for (const index of removals) {
      if (callSite.getArguments()[index]) callSite.removeArgument(index);
    }
    let offset = 0;
    for (const addition of additions) {
      const args = callSite.getArguments();
      const insertionIndex = Math.min(addition.index + offset, args.length);
      if (addition.change.defaultValue !== undefined) {
        callSite.insertArgument(insertionIndex, addition.change.defaultValue);
        offset += 1;
      } else if (addition.index < args.length) {
        callSite.insertArgument(insertionIndex, "undefined");
        offset += 1;
      }
    }
  }
}

function applyDeclarationSignatureChanges(target: FunctionLikeNode, changes: readonly SignatureParameterChange[]): void {
  for (const change of changes) {
    if (change.action === "remove") {
      const parameter = target.getParameters().find((candidate: ParameterLike) => candidate.getName() === change.name);
      if (!parameter) throw new Error(`Parameter not found: ${change.name}`);
      parameter.remove();
    } else if (change.action === "rename") {
      const parameter = target.getParameters().find((candidate: ParameterLike) => candidate.getName() === change.name);
      if (!parameter) throw new Error(`Parameter not found: ${change.name}`);
      parameter.rename(change.newName);
    } else {
      const structure = {
        name: change.name,
        type: change.type,
        initializer: change.defaultValue,
        hasQuestionToken: change.optional === true && change.defaultValue === undefined
      };
      if (change.position !== undefined) target.insertParameter(change.position, structure);
      else target.addParameter(structure);
    }
  }
}

function collectCallSites(project: Project, target: FunctionLikeNode): CallExpressionLike[] {
  const targetSymbolId = symbolIdentity(target);
  const calls: CallExpressionLike[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression) as CallExpressionLike[]) {
      const expression = call.getExpression();
      if (resolvedSymbolIdentity(expression) !== targetSymbolId) continue;
      calls.push(call);
    }
  }
  return calls.sort((left, right) => left.getSourceFile().getFilePath().localeCompare(right.getSourceFile().getFilePath()) || left.getStart() - right.getStart());
}

function successFromChanges(
  changes: readonly RepoRelativeChange[],
  afterState?: Readonly<Record<string, string | null>>
): SymbolMaterializationResult {
  const sorted = [...changes].sort((left, right) => changeKey(left).localeCompare(changeKey(right)));
  const affectedChecksums = sorted.map((change): AffectedChecksum => ({
    path: change.kind === "rename" ? `${change.path}->${change.toPath}` : change.path,
    checksumBefore: change.checksumBefore,
    checksumAfter: "checksumAfter" in change ? change.checksumAfter : undefined
  }));
  return {
    ok: true,
    changes: sorted,
    affectedChecksums,
    afterState
  };
}

function afterStateFromEntries(entries: readonly [string, string | null][]): Readonly<Record<string, string | null>> | undefined {
  if (entries.length === 0) return undefined;
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function replaceChange(path: string, before: string, after: string): RepoRelativeChange {
  return {
    kind: "replace",
    path,
    content: after,
    checksumBefore: calculateEditChecksum(before),
    checksumAfter: calculateEditChecksum(after)
  };
}

function createChange(path: string, content: string): RepoRelativeChange {
  return {
    kind: "create",
    path,
    content,
    checksumAfter: calculateEditChecksum(content)
  };
}

function deleteChange(path: string, content: string): RepoRelativeChange {
  return {
    kind: "delete",
    path,
    checksumBefore: calculateEditChecksum(content)
  };
}

function toRepoPath(repoRoot: string, absolutePath: string): { ok: true; value: string } | { ok: false; refusal: EditRefusal } {
  if (!isInside(repoRoot, absolutePath)) return refused("parent_directory", `Path escapes repository: ${absolutePath}`);
  const normalized = normalizeEditRepoRelativePath(normalizeModulePath(relative(repoRoot, absolutePath)));
  return normalized.ok ? { ok: true, value: normalized.value } : normalized;
}

function isSafeExistingFileInsideRepo(repoRoot: string, absolutePath: string): boolean {
  if (!isInside(repoRoot, absolutePath) || !existsSync(absolutePath)) return false;
  try {
    return isInside(repoRoot, realpathSync(absolutePath)) && statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function isSafeExistingDirectoryInsideRepo(repoRoot: string, absolutePath: string): boolean {
  if (!isInside(repoRoot, absolutePath) || !existsSync(absolutePath)) return false;
  try {
    return isInside(repoRoot, realpathSync(absolutePath)) && statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function validateExistingPathInsideRepoSync(
  repoRoot: string,
  absolutePath: string,
  repoPath: string,
  label: string,
  kind: "file" | "directory" | "file_or_directory"
): { ok: true } | { ok: false; refusal: EditRefusal } {
  if (!isInside(repoRoot, absolutePath)) return refused("parent_directory", `Path escapes repository: ${repoPath}`, repoPath);
  let realPath: string;
  let fileStat: ReturnType<typeof statSync>;
  try {
    realPath = realpathSync(absolutePath);
    fileStat = statSync(absolutePath);
  } catch (error) {
    return refused("unsafe_edit", `${label} cannot be read for ${repoPath}: ${errorMessage(error)}`, repoPath);
  }
  if (!isInside(repoRoot, realPath)) {
    return refused("unsafe_edit", `${label} resolves outside repository through a symlink: ${repoPath}`, repoPath);
  }
  if (kind === "file" && !fileStat.isFile()) return refused("unsupported_change", `${label} is not a file: ${repoPath}`, repoPath);
  if (kind === "directory" && !fileStat.isDirectory()) return refused("unsupported_change", `${label} is not a directory: ${repoPath}`, repoPath);
  if (kind === "file_or_directory" && !fileStat.isFile() && !fileStat.isDirectory()) {
    return refused("unsupported_change", `${label} is not a file or directory: ${repoPath}`, repoPath);
  }
  return { ok: true };
}

function requireSupportedSource(path: string): { ok: true } | { ok: false; refusal: EditRefusal } {
  return isSupportedSymbolSourcePath(path) ? { ok: true } : refused("unsupported_change", `Unsupported symbol edit language for ${path}`, path);
}

function normalizeModulePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isRepoResolvableSpecifier(specifier: string): boolean {
  return specifier.length > 0 && !specifier.startsWith("/") && !specifier.includes("://");
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function sourceExtension(path: string): string | undefined {
  if (path.endsWith(".d.ts")) return ".d.ts";
  const match = /\.[^./]+$/u.exec(path);
  return match?.[0];
}

function replaceImportExtension(path: string, extension: string): string {
  if (path.endsWith(".d.ts")) return `${path.slice(0, -".d.ts".length)}${extension}`;
  return path.replace(/\.[^./]+$/u, extension);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function withExtension(filePath: string, extension: string): string {
  const current = extname(filePath);
  return current.length === 0 ? `${filePath}${extension}` : `${filePath.slice(0, -current.length)}${extension}`;
}

function isInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function compareSourceMoves(left: SourceFileMove, right: SourceFileMove): number {
  return left.fromPath.localeCompare(right.fromPath) || left.toPath.localeCompare(right.toPath);
}

function compareFileMoves(left: FileSystemMove, right: FileSystemMove): number {
  return left.fromPath.localeCompare(right.fromPath) || left.toPath.localeCompare(right.toPath);
}

function changeKey(change: RepoRelativeChange): string {
  return change.kind === "rename" ? `${change.path}\0${change.toPath}\0${change.kind}` : `${change.path}\0${change.kind}`;
}

function refused(category: EditRefusal["category"], message: string, path?: string): { ok: false; refusal: EditRefusal } {
  return {
    ok: false,
    refusal: {
      category,
      message,
      path
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ParameterLike = Node & {
  getName(): string;
  remove(): void;
  rename(name: string): void;
};

type FunctionLikeNode = Node & {
  getStartLineNumber(): number;
  getName(): string | undefined;
  getParameters(): ParameterLike[];
  addParameter(structure: unknown): void;
  insertParameter(index: number, structure: unknown): void;
};

type CallExpressionLike = Node & {
  getExpression(): Node;
  getArguments(): Node[];
  removeArgument(index: number): void;
  insertArgument(index: number, text: string): void;
};
