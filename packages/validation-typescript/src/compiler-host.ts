import type { ValidationCheckContext, ValidationFileView } from "@the-open-engine/opcore-validation";
import ts from "typescript";
import { resolveTypeScriptCompilerProjects, type ResolvedTypeScriptCompilerProject } from "./compiler-options.js";
import { materializeTypeScriptSources, type TypeScriptMaterializedSourceSet } from "./source-files.js";

export interface OverlayAwareTypeScriptProgram {
  program: ts.Program;
  builderProgram?: ts.BuilderProgram;
  repoRoot: string;
  sourceSet: TypeScriptMaterializedSourceSet;
  configDiagnostics: readonly ts.Diagnostic[];
  buildInfoPath?: string;
}

interface CreateOverlayAwareCompilerHostArgs {
  options: ts.CompilerOptions;
  repoRoot: string;
  sourceSet: TypeScriptMaterializedSourceSet;
  incrementalBuildInfoPath?: string;
}

interface OverlayAwareCompilerHostState {
  repoRoot: string;
  sourceByPath: ReadonlyMap<string, string>;
  sourcePaths: readonly string[];
  normalizedBuildInfoPath?: string;
}

interface WriteIncrementalBuildInfoArgs {
  fileName: string;
  data: string;
  writeByteOrderMark?: boolean;
  onError?: (message: string) => void;
  state: OverlayAwareCompilerHostState;
}

const virtualRepoRoot = "/__lattice_repo__";
const typeScriptBuildInfoDirectory = ".opcore/typescript-build-info";
const programCache = new WeakMap<ValidationFileView, Promise<readonly OverlayAwareTypeScriptProgram[]>>();

interface BuildInfoEmitter {
  emitBuildInfo: () => void;
}

export async function createOverlayAwareTypeScriptProgram(
  context: ValidationCheckContext
): Promise<OverlayAwareTypeScriptProgram> {
  const programs = await createOverlayAwareTypeScriptPrograms(context);
  return programs[0] ?? emptyOverlayAwareTypeScriptProgram(context);
}

export async function createOverlayAwareTypeScriptPrograms(
  context: ValidationCheckContext
): Promise<readonly OverlayAwareTypeScriptProgram[]> {
  const cached = programCache.get(context.fileView);
  if (cached !== undefined) return cached;
  const promise = createOverlayAwareTypeScriptProgramsUncached(context);
  programCache.set(context.fileView, promise);
  return promise;
}

export async function* createOverlayAwareTypeScriptProgramIterator(
  context: ValidationCheckContext
): AsyncGenerator<OverlayAwareTypeScriptProgram> {
  for (const program of await createOverlayAwareTypeScriptPrograms(context)) {
    yield program;
  }
}

export function emitTypeScriptProgramBuildInfo(bundle: OverlayAwareTypeScriptProgram): void {
  if (bundle.builderProgram === undefined || bundle.buildInfoPath === undefined) return;
  if (!hasBuildInfoEmitter(bundle.builderProgram)) return;
  try {
    bundle.builderProgram.emitBuildInfo();
  } catch {
    // Build-info persistence is an optimization; diagnostics must not depend on cache writability.
  }
}

async function createOverlayAwareTypeScriptProgramsUncached(
  context: ValidationCheckContext
): Promise<readonly OverlayAwareTypeScriptProgram[]> {
  const compilerProjects = await resolveTypeScriptCompilerProjects(context);
  const repoRoot = compilerRepoRoot(context);
  const programs: OverlayAwareTypeScriptProgram[] = [];
  for (const compilerOptions of compilerProjects) {
    const sourceSet = await materializeTypeScriptSources(context, {
      compilerOptions: compilerOptions.options,
      rootPaths: compilerOptions.rootPaths,
      supportPaths: compilerOptions.supportPaths
    });
    const buildInfoPath = typeScriptBuildInfoPath(context, repoRoot, compilerOptions, sourceSet);
    const programOptions =
      buildInfoPath === undefined
        ? compilerOptions.options
        : {
            ...compilerOptions.options,
            incremental: true,
            tsBuildInfoFile: buildInfoPath
          };
    const host = createOverlayAwareCompilerHost({
      options: programOptions,
      repoRoot,
      sourceSet,
      ...(buildInfoPath === undefined ? {} : { incrementalBuildInfoPath: buildInfoPath })
    });
    const rootNames = sourceSet.files.map((file) => toCompilerFileName(file.path, repoRoot));
    programs.push(
      createProgramBundle({
        rootNames,
        options: programOptions,
        fallbackOptions: compilerOptions.options,
        repoRoot,
        sourceSet,
        configDiagnostics: compilerOptions.diagnostics,
        buildInfoPath,
        host
      })
    );
  }
  return programs;
}

interface CreateProgramBundleArgs {
  rootNames: readonly string[];
  options: ts.CompilerOptions;
  fallbackOptions: ts.CompilerOptions;
  repoRoot: string;
  sourceSet: TypeScriptMaterializedSourceSet;
  configDiagnostics: readonly ts.Diagnostic[];
  buildInfoPath?: string;
  host: ts.CompilerHost;
}

function createProgramBundle(args: CreateProgramBundleArgs): OverlayAwareTypeScriptProgram {
  if (args.buildInfoPath !== undefined) {
    try {
      const builderProgram = ts.createIncrementalProgram({
        rootNames: args.rootNames,
        options: args.options,
        host: args.host
      });
      return {
        program: builderProgram.getProgram(),
        builderProgram,
        repoRoot: args.repoRoot,
        sourceSet: args.sourceSet,
        configDiagnostics: args.configDiagnostics,
        buildInfoPath: args.buildInfoPath
      };
    } catch {
      const fallbackHost = createOverlayAwareCompilerHost({
        options: args.fallbackOptions,
        repoRoot: args.repoRoot,
        sourceSet: args.sourceSet
      });
      return {
        program: ts.createProgram({
          rootNames: args.rootNames,
          options: args.fallbackOptions,
          host: fallbackHost
        }),
        repoRoot: args.repoRoot,
        sourceSet: args.sourceSet,
        configDiagnostics: args.configDiagnostics
      };
    }
  }

  return {
    program: ts.createProgram({
      rootNames: args.rootNames,
      options: args.options,
      host: args.host
    }),
    repoRoot: args.repoRoot,
    sourceSet: args.sourceSet,
    configDiagnostics: args.configDiagnostics
  };
}

export function repoSourceFiles(bundle: OverlayAwareTypeScriptProgram): readonly ts.SourceFile[] {
  return bundle.sourceSet.files
    .map((file) => bundle.program.getSourceFile(toCompilerFileName(file.path, bundle.repoRoot)))
    .filter((sourceFile): sourceFile is ts.SourceFile => sourceFile !== undefined);
}

export function compilerRepoRoot(context: ValidationCheckContext): string {
  const repoRoot = context.request.repo.repoRoot;
  if (repoRoot === undefined || repoRoot.length === 0) return virtualRepoRoot;
  const normalized = normalizePath(repoRoot);
  return normalized.startsWith("/") ? stripTrailingSlash(normalized) : virtualRepoRoot;
}

export function toCompilerFileName(repoPath: string, repoRoot: string): string {
  return `${stripTrailingSlash(repoRoot)}/${repoPath}`;
}

export function toRepoRelativeCompilerPath(fileName: string, repoRoot: string): string | undefined {
  if (isTypeScriptLibraryFile(fileName)) return undefined;
  const normalizedRoot = stripTrailingSlash(normalizePath(repoRoot));
  const normalizedFile = normalizePath(fileName.startsWith("/") ? fileName : `${normalizedRoot}/${fileName}`);
  if (normalizedFile === normalizedRoot) return "";
  if (!normalizedFile.startsWith(`${normalizedRoot}/`)) return undefined;
  const relative = normalizedFile.slice(normalizedRoot.length + 1);
  return relative.length === 0 || relative.startsWith("../") ? undefined : relative;
}

function createOverlayAwareCompilerHost(args: CreateOverlayAwareCompilerHostArgs): ts.CompilerHost {
  const state: OverlayAwareCompilerHostState = {
    repoRoot: stripTrailingSlash(args.repoRoot),
    sourceByPath: new Map(args.sourceSet.files.map((file) => [file.path, file.content])),
    sourcePaths: args.sourceSet.files.map((file) => file.path),
    ...(args.incrementalBuildInfoPath === undefined
      ? {}
      : { normalizedBuildInfoPath: normalizePath(args.incrementalBuildInfoPath) })
  };
  const defaultHost =
    args.incrementalBuildInfoPath === undefined
      ? ts.createCompilerHost(args.options, true)
      : ts.createIncrementalCompilerHost(args.options, ts.sys);
  const host: ts.CompilerHost = {
    ...defaultHost,
    getCurrentDirectory: () => state.repoRoot,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getCanonicalFileName: (fileName) => normalizePath(fileName),
    useCaseSensitiveFileNames: () => true,
    fileExists: (fileName) => overlayFileExists(fileName, state),
    readFile: (fileName) => readOverlayFile(fileName, state),
    directoryExists: (directoryName) => overlayDirectoryExists(directoryName, state),
    getDirectories: (directoryName) => overlayDirectories(directoryName, state),
    readDirectory: (directoryName, extensions) => readOverlayDirectory(directoryName, extensions, state),
    getSourceFile: (fileName, languageVersion) => createOverlaySourceFile(fileName, languageVersion, host),
    resolveModuleNames: (moduleNames, containingFile, _reusedNames, _redirectedReference, options) =>
      moduleNames.map((moduleName) => ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule),
    writeFile: (fileName, data, writeByteOrderMark, onError) =>
      writeIncrementalBuildInfo({ fileName, data, writeByteOrderMark, onError, state })
  };
  return host;
}

function overlayFileExists(fileName: string, state: OverlayAwareCompilerHostState): boolean {
  if (isIncrementalBuildInfoFile(fileName, state.normalizedBuildInfoPath)) return ts.sys.fileExists(fileName);
  if (isTypeScriptLibraryFile(fileName)) return ts.sys.fileExists(fileName);
  const repoPath = toRepoRelativeCompilerPath(fileName, state.repoRoot);
  if (repoPath !== undefined) {
    if (state.sourceByPath.has(repoPath)) return true;
    return isDeterministicExternalRepoFile(repoPath) && ts.sys.fileExists(fileName);
  }
  return ts.sys.fileExists(fileName);
}

function readOverlayFile(fileName: string, state: OverlayAwareCompilerHostState): string | undefined {
  if (isIncrementalBuildInfoFile(fileName, state.normalizedBuildInfoPath)) return ts.sys.readFile(fileName);
  if (isTypeScriptLibraryFile(fileName)) return ts.sys.readFile(fileName);
  const repoPath = toRepoRelativeCompilerPath(fileName, state.repoRoot);
  if (repoPath === undefined) return ts.sys.readFile(fileName);
  const sourceContent = state.sourceByPath.get(repoPath);
  if (sourceContent !== undefined) return sourceContent;
  return isDeterministicExternalRepoFile(repoPath) ? ts.sys.readFile(fileName) : undefined;
}

function overlayDirectoryExists(directoryName: string, state: OverlayAwareCompilerHostState): boolean {
  const repoPath = toRepoRelativeCompilerPath(directoryName, state.repoRoot);
  if (repoPath === undefined) return ts.sys.directoryExists?.(directoryName) ?? false;
  if (repoPath.length === 0 || state.sourcePaths.some((path) => path.startsWith(`${repoPath}/`))) return true;
  return isDeterministicExternalRepoDirectory(repoPath) && (ts.sys.directoryExists?.(directoryName) ?? false);
}

function overlayDirectories(directoryName: string, state: OverlayAwareCompilerHostState): string[] {
  const repoPath = toRepoRelativeCompilerPath(directoryName, state.repoRoot);
  if (repoPath === undefined) return ts.sys.getDirectories?.(directoryName) ?? [];
  if (isDeterministicExternalRepoDirectory(repoPath)) return ts.sys.getDirectories?.(directoryName) ?? [];
  const prefix = repoPath.length === 0 ? "" : `${repoPath}/`;
  const children = new Set<string>();
  for (const path of state.sourcePaths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const child = rest.split("/", 1)[0];
    if (child !== undefined && rest.includes("/")) children.add(child);
  }
  return [...children].sort();
}

function readOverlayDirectory(
  directoryName: string,
  extensions: readonly string[] | undefined,
  state: OverlayAwareCompilerHostState
): string[] {
  const repoPath = toRepoRelativeCompilerPath(directoryName, state.repoRoot);
  if (repoPath === undefined) return ts.sys.readDirectory(directoryName, extensions);
  if (isDeterministicExternalRepoDirectory(repoPath)) return ts.sys.readDirectory(directoryName, extensions);
  const prefix = repoPath.length === 0 ? "" : `${repoPath}/`;
  const allowedExtensions = new Set(extensions ?? [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".json"]);
  return state.sourcePaths
    .filter((path) => path.startsWith(prefix) && [...allowedExtensions].some((extension) => path.endsWith(extension)))
    .map((path) => toCompilerFileName(path, state.repoRoot))
    .sort();
}

function createOverlaySourceFile(
  fileName: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
  host: ts.CompilerHost
): ts.SourceFile | undefined {
  const content = host.readFile(fileName);
  return content === undefined
    ? undefined
    : versionSourceFile(
        ts.createSourceFile(fileName, content, languageVersion, true, scriptKindForCompilerFileName(fileName)),
        content
      );
}

function writeIncrementalBuildInfo(args: WriteIncrementalBuildInfoArgs): void {
  const { fileName, data, writeByteOrderMark, onError, state } = args;
  if (!isIncrementalBuildInfoFile(fileName, state.normalizedBuildInfoPath)) return;
  try {
    ensureDirectory(parentDirectory(fileName));
    ts.sys.writeFile(fileName, data, writeByteOrderMark);
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error));
  }
}

function typeScriptBuildInfoPath(
  context: ValidationCheckContext,
  repoRoot: string,
  compilerProject: ResolvedTypeScriptCompilerProject,
  sourceSet: TypeScriptMaterializedSourceSet
): string | undefined {
  if (context.runtime.persistentCaches !== "enabled") return undefined;
  if (context.fileView.overlays.length > 0) return undefined;
  if (repoRoot === virtualRepoRoot || !repoRoot.startsWith("/")) return undefined;
  if (sourceSet.files.length === 0 || !sourceSetMatchesDisk(repoRoot, sourceSet)) return undefined;
  const key = stableJson({
    configPath: compilerProject.configPath ?? "",
    rootPaths: compilerProject.rootPaths,
    supportPaths: compilerProject.supportPaths,
    options: compilerProject.options
  });
  return `${repoRoot}/${typeScriptBuildInfoDirectory}/project-${hashText(key)}.tsbuildinfo`;
}

function sourceSetMatchesDisk(repoRoot: string, sourceSet: TypeScriptMaterializedSourceSet): boolean {
  return sourceSet.files.every((file) => ts.sys.readFile(toCompilerFileName(file.path, repoRoot)) === file.content);
}

function isIncrementalBuildInfoFile(fileName: string, normalizedBuildInfoPath: string | undefined): boolean {
  return normalizedBuildInfoPath !== undefined && normalizePath(fileName) === normalizedBuildInfoPath;
}

function versionSourceFile(sourceFile: ts.SourceFile, content: string): ts.SourceFile & { version: string } {
  return Object.assign(sourceFile, { version: hashText(content) });
}

function hashText(content: string): string {
  return ts.sys.createHash?.(content) ?? fallbackHashText(content);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function hasBuildInfoEmitter(builderProgram: ts.BuilderProgram): builderProgram is ts.BuilderProgram & BuildInfoEmitter {
  return typeof (builderProgram as { emitBuildInfo?: unknown }).emitBuildInfo === "function";
}

function ensureDirectory(path: string): void {
  const normalized = stripTrailingSlash(path);
  if (normalized.length === 0 || ts.sys.directoryExists(normalized)) return;
  const parent = parentDirectory(normalized);
  if (parent !== normalized) ensureDirectory(parent);
  if (!ts.sys.directoryExists(normalized)) ts.sys.createDirectory(normalized);
}

function parentDirectory(path: string): string {
  const normalized = stripTrailingSlash(normalizePath(path));
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized.startsWith("/") ? "/" : "";
  return normalized.slice(0, index);
}

function fallbackHashText(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length.toString(16)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isTypeScriptLibraryFile(fileName: string): boolean {
  const normalized = normalizePath(fileName);
  return /(^|\/)node_modules\/typescript\/lib\/.+\.d\.ts$/.test(normalized);
}

function isDeterministicExternalRepoFile(repoPath: string): boolean {
  return (
    repoPath.startsWith("node_modules/") ||
    repoPath === "package.json" ||
    /^packages\/[^/]+\/package\.json$/.test(repoPath) ||
    /^packages\/[^/]+\/dist\/.+\.d\.ts$/.test(repoPath)
  );
}

function isDeterministicExternalRepoDirectory(repoPath: string): boolean {
  return (
    repoPath === "node_modules" ||
    repoPath.startsWith("node_modules/") ||
    repoPath === "packages" ||
    /^packages\/[^/]+$/.test(repoPath) ||
    /^packages\/[^/]+\/dist(?:\/|$)/.test(repoPath)
  );
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+/g, "/");
}

function stripTrailingSlash(path: string): string {
  const normalized = normalizePath(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function scriptKindForCompilerFileName(fileName: string): ts.ScriptKind {
  return normalizePath(fileName).endsWith(".json") ? ts.ScriptKind.JSON : ts.ScriptKind.Unknown;
}

function emptyOverlayAwareTypeScriptProgram(context: ValidationCheckContext): OverlayAwareTypeScriptProgram {
  const repoRoot = compilerRepoRoot(context);
  const options: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true
  };
  const sourceSet: TypeScriptMaterializedSourceSet = {
    rootPaths: [],
    supportPaths: [],
    paths: [],
    files: [],
    sourceFileByPath: new Map(),
    relativeImports: []
  };
  const host = createOverlayAwareCompilerHost({ options, repoRoot, sourceSet });
  return {
    program: ts.createProgram({
      rootNames: [],
      options,
      host
    }),
    repoRoot,
    sourceSet,
    configDiagnostics: []
  };
}
