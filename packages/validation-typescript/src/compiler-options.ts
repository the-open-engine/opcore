import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import {
  joinRepoRelativePaths,
  normalizeValidationFileViewPath,
  repoPathGlobToRegex,
  repoPathHasGlobSyntax,
  uniqueSortedStrings
} from "@the-open-engine/opcore-validation";
import ts from "typescript";
import { isTypeScriptSourcePath, readOptionalRepoFile } from "./source-files.js";

export interface ResolvedTypeScriptCompilerOptions {
  options: ts.CompilerOptions;
  diagnostics: readonly ts.Diagnostic[];
}

export interface ResolvedTypeScriptCompilerProject extends ResolvedTypeScriptCompilerOptions {
  rootPaths: readonly string[];
  supportPaths: readonly string[];
  configPath?: string;
}

const optionsCache = new WeakMap<object, Promise<ResolvedTypeScriptCompilerOptions>>();
const projectsCache = new WeakMap<object, Promise<readonly ResolvedTypeScriptCompilerProject[]>>();

const defaultCompilerOptions = {
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  forceConsistentCasingInFileNames: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022
} as const satisfies ts.CompilerOptions;

const validationInvariantCompilerOptions = {
  noEmit: true
} as const satisfies ts.CompilerOptions;

export async function resolveTypeScriptCompilerOptions(
  context: ValidationCheckContext
): Promise<ResolvedTypeScriptCompilerOptions> {
  const cached = optionsCache.get(context.fileView);
  if (cached !== undefined) return cached;
  const promise = resolveTypeScriptCompilerOptionsUncached(context);
  optionsCache.set(context.fileView, promise);
  return promise;
}

export async function resolveTypeScriptCompilerProjects(
  context: ValidationCheckContext
): Promise<readonly ResolvedTypeScriptCompilerProject[]> {
  const cached = projectsCache.get(context.fileView);
  if (cached !== undefined) return cached;
  const promise = resolveTypeScriptCompilerProjectsUncached(context);
  projectsCache.set(context.fileView, promise);
  return promise;
}

async function resolveTypeScriptCompilerOptionsUncached(
  context: ValidationCheckContext
): Promise<ResolvedTypeScriptCompilerOptions> {
  const diagnostics: ts.Diagnostic[] = [];
  const configOptions: ts.CompilerOptions[] = [];
  for (const configPath of configPaths(context)) {
    const content = await readOptionalRepoFile(context, configPath);
    if (content === undefined) continue;
    const parsed = ts.parseConfigFileTextToJson(configPath, content);
    if (parsed.error !== undefined) {
      diagnostics.push(parsed.error);
      continue;
    }
    const converted = ts.convertCompilerOptionsFromJson(parsed.config?.compilerOptions ?? {}, configBasePath(configPath), configPath);
    diagnostics.push(...converted.errors);
    configOptions.push(converted.options);
  }
  return {
    options: mergeCompilerOptions(...configOptions),
    diagnostics
  };
}

async function resolveTypeScriptCompilerProjectsUncached(
  context: ValidationCheckContext
): Promise<readonly ResolvedTypeScriptCompilerProject[]> {
  const rootPaths = scopedTypeScriptPaths(context);
  if (rootPaths.length === 0) {
    return [
      {
        rootPaths: [],
        supportPaths: [],
        options: mergeCompilerOptions(),
        diagnostics: []
      }
    ];
  }

  const parsedConfigs = await parseTypeScriptConfigs(context, candidateConfigPaths(context, rootPaths));
  const grouped = new Map<string, { config?: ParsedTypeScriptConfig; rootPaths: string[] }>();
  for (const rootPath of rootPaths) {
    const config = selectConfigForPath(parsedConfigs, rootPath);
    const key = config?.path ?? syntheticProjectKey(rootPath);
    const group = grouped.get(key) ?? { config, rootPaths: [] };
    group.rootPaths.push(rootPath);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((group): ResolvedTypeScriptCompilerProject => ({
      rootPaths: uniqueSortedStrings(group.rootPaths),
      supportPaths: group.config === undefined ? [] : ambientDeclarationPaths(context, group.config),
      ...(group.config?.path === undefined ? {} : { configPath: group.config.path }),
      options: group.config?.options ?? mergeCompilerOptions(),
      diagnostics: group.config?.diagnostics ?? []
    }))
    .sort((left, right) => (left.configPath ?? "").localeCompare(right.configPath ?? ""));
}

function configPaths(context: ValidationCheckContext): readonly string[] {
  const paths = ["tsconfig.json"];
  if (context.scope.kind === "package" && context.scope.packageRoot !== undefined) {
    paths.push(`${context.scope.packageRoot}/tsconfig.json`);
  }
  return [...new Set(paths)];
}

function configBasePath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.length === 0 ? "." : parts.join("/");
}

interface ParsedTypeScriptConfig {
  path: string;
  basePath: string;
  options: ts.CompilerOptions;
  diagnostics: readonly ts.Diagnostic[];
  files?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
}

async function parseTypeScriptConfigs(
  context: ValidationCheckContext,
  paths: readonly string[]
): Promise<readonly ParsedTypeScriptConfig[]> {
  const configs: ParsedTypeScriptConfig[] = [];
  const pending = [...paths];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    const content = await readOptionalRepoFile(context, path);
    if (content === undefined) continue;
    const diagnostics: ts.Diagnostic[] = [];
    const basePath = configBasePath(path);
    const parsed = ts.parseConfigFileTextToJson(path, content);
    if (parsed.error !== undefined) {
      diagnostics.push(parsed.error);
      configs.push({
        path,
        basePath,
        options: mergeCompilerOptions(),
        diagnostics
      });
      continue;
    }
    const converted = ts.convertCompilerOptionsFromJson(parsed.config?.compilerOptions ?? {}, basePath, path);
    const references = referencedConfigPaths(basePath, parsed.config?.references);
    diagnostics.push(...converted.errors);
    configs.push({
      path,
      basePath,
      options: mergeCompilerOptions(converted.options),
      diagnostics,
      files: stringArray(parsed.config?.files),
      include: stringArray(parsed.config?.include),
      exclude: stringArray(parsed.config?.exclude)
    });
    pending.push(...references);
  }
  return configs;
}

function mergeCompilerOptions(...configOptions: readonly ts.CompilerOptions[]): ts.CompilerOptions {
  return {
    ...defaultCompilerOptions,
    ...Object.assign({}, ...configOptions),
    ...validationInvariantCompilerOptions
  };
}

function scopedTypeScriptPaths(context: ValidationCheckContext): readonly string[] {
  return uniqueSortedStrings(
    [...context.fileView.scopeFiles, ...context.fileView.overlays.map((overlay) => overlay.path)]
      .map((path) => normalizeValidationFileViewPath(path))
      .filter(isTypeScriptSourcePath)
  );
}

function candidateConfigPaths(context: ValidationCheckContext, rootPaths: readonly string[]): readonly string[] {
  const paths = new Set(configPaths(context));
  for (const path of context.fileView.scopeFiles) {
    const normalized = normalizeValidationFileViewPath(path);
    if (isTypeScriptConfigPath(normalized)) paths.add(normalized);
  }
  for (const path of rootPaths) {
    for (const ancestor of ancestorDirectories(path)) {
      paths.add(ancestor.length === 0 ? "tsconfig.json" : `${ancestor}/tsconfig.json`);
    }
  }
  return [...paths].sort();
}

function selectConfigForPath(configs: readonly ParsedTypeScriptConfig[], path: string): ParsedTypeScriptConfig | undefined {
  const included = configs.filter((config) => configIncludesPath(config, path));
  if (included.length > 0) return mostSpecificConfig(included);
  return undefined;
}

function mostSpecificConfig(configs: readonly ParsedTypeScriptConfig[]): ParsedTypeScriptConfig | undefined {
  return [...configs].sort((left, right) => {
    const byBase = right.basePath.length - left.basePath.length;
    if (byBase !== 0) return byBase;
    return right.path.length - left.path.length;
  })[0];
}

function configIncludesPath(config: ParsedTypeScriptConfig, path: string): boolean {
  if (config.files !== undefined) return config.files.map((file) => joinRepoPaths(config.basePath, file)).includes(path);
  const includes = config.include ?? [];
  if (includes.length === 0) return isInsideConfigBase(config.basePath, path);
  if (config.exclude?.some((pattern) => matchesConfigPattern(config.basePath, pattern, path)) === true) return false;
  return includes.some((pattern) => matchesConfigPattern(config.basePath, pattern, path));
}

function isInsideConfigBase(basePath: string, path: string): boolean {
  return basePath === "." || path === basePath || path.startsWith(`${basePath}/`);
}

function syntheticProjectKey(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 1) return "synthetic:.";
  return `synthetic:${parts[0]}`;
}

function matchesConfigPattern(basePath: string, pattern: string, path: string): boolean {
  const target = joinRepoPaths(basePath, pattern);
  if (target === undefined) return false;
  if (target.endsWith("/**/*")) {
    const prefix = target.slice(0, -"/**/*".length);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (target.endsWith("/**")) {
    const prefix = target.slice(0, -"/**".length);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (!repoPathHasGlobSyntax(target, true)) return path === target || path.startsWith(`${target}/`);
  return repoPathGlobToRegex(target, { matchDescendants: true, optionalGlobstarSlash: true }).test(path);
}

function ancestorDirectories(path: string): readonly string[] {
  const parts = path.split("/");
  parts.pop();
  const ancestors = [parts.join("/")];
  while (parts.length > 0) {
    parts.pop();
    ancestors.push(parts.join("/"));
  }
  return ancestors;
}

function isTypeScriptConfigPath(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return /^tsconfig(?:\.[^/]+)?\.json$/u.test(name);
}

function referencedConfigPaths(basePath: string, value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const referencePath = (entry as { path?: unknown }).path;
    if (typeof referencePath !== "string" || referencePath.trim().length === 0) continue;
    const normalizedReference = referencePath.trim().replaceAll("\\", "/");
    const joined = joinRepoPaths(basePath, normalizedReference);
    if (joined === undefined) continue;
    const configPath = isTypeScriptConfigPath(joined) ? joined : joinRepoPaths(joined, "tsconfig.json");
    if (configPath !== undefined) paths.push(configPath);
  }
  return uniqueSortedStrings(paths);
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function joinRepoPaths(basePath: string, path: string): string | undefined {
  return joinRepoRelativePaths([basePath, path], { emptyPath: "" });
}

function ambientDeclarationPaths(context: ValidationCheckContext, config: ParsedTypeScriptConfig): readonly string[] {
  const scopedAmbientPaths = context.scope.files
    .map((path) => normalizeValidationFileViewPath(path))
    .filter((path) => isAmbientDeclarationPath(path) && configIncludesPath(config, path));
  const repoAmbientPaths = ambientDeclarationPathsFromRepoRoot(context, config);
  return uniqueSortedStrings([...scopedAmbientPaths, ...repoAmbientPaths]);
}

function ambientDeclarationPathsFromRepoRoot(context: ValidationCheckContext, config: ParsedTypeScriptConfig): readonly string[] {
  const repoRoot = normalizedRepoRoot(context.request.repo.repoRoot);
  if (repoRoot === undefined || ts.sys.readDirectory === undefined) return [];
  const basePath = config.basePath === "." ? repoRoot : `${repoRoot}/${config.basePath}`;
  const paths = ts.sys
    .readDirectory(basePath, [".d.ts"], config.exclude, ["**/*"])
    .map((path) => repoRelativePath(repoRoot, path))
    .filter((path): path is string => path !== undefined)
    .filter((path) => configIncludesPath(config, path));
  return uniqueSortedStrings(paths);
}

function normalizedRepoRoot(repoRoot: string | undefined): string | undefined {
  if (repoRoot === undefined || repoRoot.length === 0) return undefined;
  return repoRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function repoRelativePath(repoRoot: string, path: string): string | undefined {
  const normalizedPath = path.replaceAll("\\", "/");
  if (normalizedPath === repoRoot) return "";
  if (!normalizedPath.startsWith(`${repoRoot}/`)) return undefined;
  const relativePath = normalizedPath.slice(repoRoot.length + 1);
  return relativePath.length === 0 ? undefined : relativePath;
}

function isAmbientDeclarationPath(path: string): boolean {
  return path.endsWith(".d.ts");
}
