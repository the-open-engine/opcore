import type { ValidationCheckContext } from "@the-open-engine/lattice-validation";
import ts from "typescript";
import { resolveTypeScriptCompilerOptions } from "./compiler-options.js";
import { materializeTypeScriptSources, type TypeScriptMaterializedSourceSet } from "./source-files.js";

export interface OverlayAwareTypeScriptProgram {
  program: ts.Program;
  repoRoot: string;
  sourceSet: TypeScriptMaterializedSourceSet;
  configDiagnostics: readonly ts.Diagnostic[];
}

interface CreateOverlayAwareCompilerHostArgs {
  options: ts.CompilerOptions;
  repoRoot: string;
  sourceSet: TypeScriptMaterializedSourceSet;
}

const virtualRepoRoot = "/__lattice_repo__";

export async function createOverlayAwareTypeScriptProgram(
  context: ValidationCheckContext
): Promise<OverlayAwareTypeScriptProgram> {
  const compilerOptions = await resolveTypeScriptCompilerOptions(context);
  const repoRoot = compilerRepoRoot(context);
  const sourceSet = await materializeTypeScriptSources(context, {
    compilerOptions: compilerOptions.options
  });
  const host = createOverlayAwareCompilerHost({
    options: compilerOptions.options,
    repoRoot,
    sourceSet
  });
  const rootNames = sourceSet.files.map((file) => toCompilerFileName(file.path, repoRoot));
  return {
    program: ts.createProgram({
      rootNames,
      options: compilerOptions.options,
      host
    }),
    repoRoot,
    sourceSet,
    configDiagnostics: compilerOptions.diagnostics
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
  const repoRoot = stripTrailingSlash(args.repoRoot);
  const sourceByPath = new Map(args.sourceSet.files.map((file) => [file.path, file.content]));
  const sourcePaths = [...sourceByPath.keys()];
  const defaultHost = ts.createCompilerHost(args.options, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    getCurrentDirectory: () => repoRoot,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getCanonicalFileName: (fileName) => normalizePath(fileName),
    useCaseSensitiveFileNames: () => true,
    fileExists: (fileName) => {
      if (isTypeScriptLibraryFile(fileName)) return ts.sys.fileExists(fileName);
      const repoPath = toRepoRelativeCompilerPath(fileName, repoRoot);
      if (repoPath !== undefined) {
        if (sourceByPath.has(repoPath)) return true;
        return isDeterministicExternalRepoFile(repoPath) && ts.sys.fileExists(fileName);
      }
      return ts.sys.fileExists(fileName);
    },
    readFile: (fileName) => {
      if (isTypeScriptLibraryFile(fileName)) return ts.sys.readFile(fileName);
      const repoPath = toRepoRelativeCompilerPath(fileName, repoRoot);
      if (repoPath !== undefined) {
        const sourceContent = sourceByPath.get(repoPath);
        if (sourceContent !== undefined) return sourceContent;
        return isDeterministicExternalRepoFile(repoPath) ? ts.sys.readFile(fileName) : undefined;
      }
      return ts.sys.readFile(fileName);
    },
    directoryExists: (directoryName) => {
      const repoPath = toRepoRelativeCompilerPath(directoryName, repoRoot);
      if (repoPath !== undefined) {
        if (repoPath.length === 0 || sourcePaths.some((path) => path.startsWith(`${repoPath}/`))) return true;
        return isDeterministicExternalRepoDirectory(repoPath) && (ts.sys.directoryExists?.(directoryName) ?? false);
      }
      return ts.sys.directoryExists?.(directoryName) ?? false;
    },
    getDirectories: (directoryName) => {
      const repoPath = toRepoRelativeCompilerPath(directoryName, repoRoot);
      if (repoPath === undefined) return ts.sys.getDirectories?.(directoryName) ?? [];
      if (isDeterministicExternalRepoDirectory(repoPath)) return ts.sys.getDirectories?.(directoryName) ?? [];
      const prefix = repoPath.length === 0 ? "" : `${repoPath}/`;
      const children = new Set<string>();
      for (const path of sourcePaths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const child = rest.split("/", 1)[0];
        if (child !== undefined && rest.includes("/")) children.add(child);
      }
      return [...children].sort();
    },
    readDirectory: (directoryName, extensions) => {
      const repoPath = toRepoRelativeCompilerPath(directoryName, repoRoot);
      if (repoPath === undefined) return ts.sys.readDirectory(directoryName, extensions);
      if (isDeterministicExternalRepoDirectory(repoPath)) return ts.sys.readDirectory(directoryName, extensions);
      const prefix = repoPath.length === 0 ? "" : `${repoPath}/`;
      const allowedExtensions = new Set(extensions ?? [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".json"]);
      return sourcePaths
        .filter((path) => path.startsWith(prefix) && [...allowedExtensions].some((extension) => path.endsWith(extension)))
        .map((path) => toCompilerFileName(path, repoRoot))
        .sort();
    },
    getSourceFile: (fileName, languageVersion) => {
      const content = host.readFile(fileName);
      return content === undefined
        ? undefined
        : ts.createSourceFile(fileName, content, languageVersion, true, scriptKindForCompilerFileName(fileName));
    },
    resolveModuleNames: (moduleNames, containingFile, _reusedNames, _redirectedReference, options) =>
      moduleNames.map((moduleName) => ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule)
  };
  return host;
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
