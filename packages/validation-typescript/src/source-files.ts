import type { ValidationCheckContext, ValidationFileView } from "@the-open-engine/lattice-validation";
import { normalizeValidationFileViewPath } from "@the-open-engine/lattice-validation";
import ts from "typescript";

export const typeScriptSourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"] as const;
const jsonModuleExtension = ".json";

export interface TypeScriptMaterializedSourceFile {
  path: string;
  content: string;
}

export interface TypeScriptRelativeImport {
  fromPath: string;
  specifier: string;
  resolvedPath: string;
}

export interface TypeScriptMaterializedSourceSet {
  rootPaths: readonly string[];
  paths: readonly string[];
  files: readonly TypeScriptMaterializedSourceFile[];
  sourceFileByPath: ReadonlyMap<string, TypeScriptMaterializedSourceFile>;
  relativeImports: readonly TypeScriptRelativeImport[];
}

export interface MaterializeTypeScriptSourceOptions {
  compilerOptions?: ts.CompilerOptions;
}

const sourceSetCache = new WeakMap<ValidationFileView, Map<string, Promise<TypeScriptMaterializedSourceSet>>>();
const extensionlessCandidates = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".d.ts"] as const;

export function isTypeScriptSourcePath(path: string): boolean {
  return typeScriptSourceExtensions.some((extension) => path.endsWith(extension));
}

export function toFileNodeId(path: string): string {
  return `file:${path}`;
}

export async function readOptionalRepoFile(context: ValidationCheckContext, path: string): Promise<string | undefined> {
  const result = await context.fileView.readAfter(path);
  return result.status === "found" ? result.content : undefined;
}

export async function materializeTypeScriptSources(
  context: ValidationCheckContext,
  options: MaterializeTypeScriptSourceOptions = {}
): Promise<TypeScriptMaterializedSourceSet> {
  const cacheKey = sourceMaterializationCacheKey(options.compilerOptions);
  let cache = sourceSetCache.get(context.fileView);
  if (cache === undefined) {
    cache = new Map<string, Promise<TypeScriptMaterializedSourceSet>>();
    sourceSetCache.set(context.fileView, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const promise = materializeTypeScriptSourcesUncached(context, options.compilerOptions ?? {});
  cache.set(cacheKey, promise);
  return promise;
}

async function materializeTypeScriptSourcesUncached(
  context: ValidationCheckContext,
  compilerOptions: ts.CompilerOptions
): Promise<TypeScriptMaterializedSourceSet> {
  const initialPaths = uniqueSorted(
    [...context.fileView.scopeFiles, ...context.fileView.overlays.map((overlay) => overlay.path)]
      .map((path) => normalizeValidationFileViewPath(path))
      .filter(isTypeScriptSourcePath)
  );
  const rootPaths: string[] = [];
  const pending = [...initialPaths];
  const visited = new Set<string>();
  const sourceFileByPath = new Map<string, TypeScriptMaterializedSourceFile>();
  const relativeImports: TypeScriptRelativeImport[] = [];

  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);

    const result = await context.fileView.readAfter(path);
    if (result.status !== "found") continue;
    const sourceFile = { path, content: result.content };
    sourceFileByPath.set(path, sourceFile);
    if (initialPaths.includes(path)) rootPaths.push(path);

    for (const specifier of moduleImportSpecifiers(path, result.content)) {
      const resolvedPath = await resolveRepoImport(context, path, specifier, compilerOptions);
      if (resolvedPath === undefined) continue;
      if (isRelativeSpecifier(specifier)) relativeImports.push({ fromPath: path, specifier, resolvedPath });
      if (!visited.has(resolvedPath) && !sourceFileByPath.has(resolvedPath)) pending.push(resolvedPath);
    }
  }

  const files = [...sourceFileByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  return {
    rootPaths: uniqueSorted(rootPaths),
    paths: files.map((file) => file.path),
    files,
    sourceFileByPath,
    relativeImports: relativeImports.sort((left, right) =>
      `${left.fromPath}\0${left.resolvedPath}\0${left.specifier}`.localeCompare(
        `${right.fromPath}\0${right.resolvedPath}\0${right.specifier}`
      )
    )
  };
}

function moduleImportSpecifiers(path: string, content: string): readonly string[] {
  const preprocessed = ts.preProcessFile(content, true, true);
  return uniqueSorted(
    [...preprocessed.importedFiles, ...preprocessed.referencedFiles]
      .map((entry) => entry.fileName)
      .filter((specifier) => isRelativeSpecifier(specifier) || isPathMappableSpecifier(specifier))
  );
}

async function resolveRepoImport(
  context: ValidationCheckContext,
  fromPath: string,
  specifier: string,
  compilerOptions: ts.CompilerOptions
): Promise<string | undefined> {
  if (isRelativeSpecifier(specifier)) return resolveRelativeImport(context, fromPath, specifier, compilerOptions);
  return (
    (await resolvePathMappedImport(context, specifier, compilerOptions)) ??
    (await resolveBaseUrlImport(context, specifier, compilerOptions))
  );
}

async function resolveRelativeImport(
  context: ValidationCheckContext,
  fromPath: string,
  specifier: string,
  compilerOptions: ts.CompilerOptions
): Promise<string | undefined> {
  const basePath = relativeBasePath(fromPath, specifier);
  if (basePath === undefined) return undefined;
  for (const candidate of relativeImportCandidates(basePath, compilerOptions)) {
    const normalized = normalizeValidationFileViewPath(candidate);
    if (!isImportableRepoModulePath(normalized, compilerOptions)) continue;
    if (await context.fileView.exists(normalized)) return normalized;
  }
  return undefined;
}

async function resolvePathMappedImport(
  context: ValidationCheckContext,
  specifier: string,
  compilerOptions: ts.CompilerOptions
): Promise<string | undefined> {
  const paths = compilerOptions.paths;
  if (paths === undefined) return undefined;
  const basePath = compilerOptionBasePath(compilerOptions);
  for (const [pattern, targets] of sortedPathMappings(paths)) {
    const wildcard = matchPathPattern(pattern, specifier);
    if (wildcard === undefined) continue;
    for (const target of targets) {
      const mappedTarget = applyPathMappingTarget(target, wildcard);
      const candidateBase = joinRepoPaths(basePath, mappedTarget);
      if (candidateBase === undefined) continue;
      const resolved = await resolveModulePathFromBase(context, candidateBase, compilerOptions);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

async function resolveBaseUrlImport(
  context: ValidationCheckContext,
  specifier: string,
  compilerOptions: ts.CompilerOptions
): Promise<string | undefined> {
  if (compilerOptions.baseUrl === undefined) return undefined;
  const candidateBase = joinRepoPaths(compilerOptionBasePath(compilerOptions), specifier);
  return candidateBase === undefined ? undefined : resolveModulePathFromBase(context, candidateBase, compilerOptions);
}

async function resolveModulePathFromBase(
  context: ValidationCheckContext,
  basePath: string,
  compilerOptions: ts.CompilerOptions
): Promise<string | undefined> {
  for (const candidate of relativeImportCandidates(basePath, compilerOptions)) {
    let normalized: string;
    try {
      normalized = normalizeValidationFileViewPath(candidate);
    } catch {
      continue;
    }
    if (!isImportableRepoModulePath(normalized, compilerOptions)) continue;
    if (await context.fileView.exists(normalized)) return normalized;
  }
  return undefined;
}

function relativeImportCandidates(basePath: string, compilerOptions: ts.CompilerOptions): readonly string[] {
  const candidates: string[] = [];
  const extension = sourceExtension(basePath);
  if (extension === jsonModuleExtension) return jsonModulesEnabled(compilerOptions) ? [basePath] : [];
  if (extension === ".js" || extension === ".jsx") {
    if (extension === ".jsx") candidates.push(replaceExtension(basePath, ".tsx"), replaceExtension(basePath, ".ts"));
    else candidates.push(replaceExtension(basePath, ".ts"), replaceExtension(basePath, ".tsx"));
    candidates.push(replaceExtension(basePath, ".d.ts"), basePath);
    candidates.push(replaceExtension(basePath, extension === ".js" ? ".jsx" : ".js"));
    return unique(candidates);
  }
  if (extension === ".mjs") return unique([replaceExtension(basePath, ".mts"), replaceExtension(basePath, ".d.mts"), basePath]);
  if (extension === ".cjs") return unique([replaceExtension(basePath, ".cts"), replaceExtension(basePath, ".d.cts"), basePath]);
  candidates.push(basePath);
  if (extension === undefined) {
    for (const candidateExtension of extensionlessCandidates) candidates.push(`${basePath}${candidateExtension}`);
    if (jsonModulesEnabled(compilerOptions)) candidates.push(`${basePath}${jsonModuleExtension}`);
    for (const candidateExtension of extensionlessCandidates) candidates.push(`${basePath}/index${candidateExtension}`);
    if (jsonModulesEnabled(compilerOptions)) candidates.push(`${basePath}/index${jsonModuleExtension}`);
  }
  return unique(candidates);
}

function isImportableRepoModulePath(path: string, compilerOptions: ts.CompilerOptions): boolean {
  return isTypeScriptSourcePath(path) || (jsonModulesEnabled(compilerOptions) && path.endsWith(jsonModuleExtension));
}

function jsonModulesEnabled(compilerOptions: ts.CompilerOptions): boolean {
  return compilerOptions.resolveJsonModule === true;
}

function relativeBasePath(fromPath: string, specifier: string): string | undefined {
  const fromParts = fromPath.split("/");
  fromParts.pop();
  const parts = [...fromParts, ...specifier.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return undefined;
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.length === 0 ? undefined : normalized.join("/");
}

function sourceExtension(path: string): string | undefined {
  if (path.endsWith(".d.ts")) return ".d.ts";
  const match = /\.[^.\/]+$/.exec(path);
  return match?.[0];
}

function replaceExtension(path: string, extension: string): string {
  return path.endsWith(".d.ts") ? `${path.slice(0, -".d.ts".length)}${extension}` : path.replace(/\.[^.\/]+$/, extension);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isPathMappableSpecifier(specifier: string): boolean {
  return specifier.length > 0 && !specifier.startsWith("/") && !specifier.includes("://");
}

function sortedPathMappings(paths: ts.MapLike<string[]>): readonly [string, readonly string[]][] {
  return Object.entries(paths)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
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

function compilerOptionBasePath(options: ts.CompilerOptions): string {
  if (typeof options.baseUrl === "string" && options.baseUrl.length > 0) return options.baseUrl;
  if (typeof options.configFilePath === "string" && options.configFilePath.length > 0) {
    const parts = options.configFilePath.split("/");
    parts.pop();
    return parts.length === 0 ? "." : parts.join("/");
  }
  return ".";
}

function joinRepoPaths(...paths: readonly string[]): string | undefined {
  const normalized: string[] = [];
  for (const path of paths) {
    if (path.startsWith("/")) return undefined;
    for (const part of path.split("/")) {
      if (part.length === 0 || part === ".") continue;
      if (part === "..") {
        if (normalized.length === 0) return undefined;
        normalized.pop();
        continue;
      }
      normalized.push(part);
    }
  }
  return normalized.length === 0 ? "." : normalized.join("/");
}

function sourceMaterializationCacheKey(options: ts.CompilerOptions | undefined): string {
  if (options === undefined) return "";
  return JSON.stringify({
    baseUrl: options.baseUrl,
    configFilePath: options.configFilePath,
    paths: options.paths
  });
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
