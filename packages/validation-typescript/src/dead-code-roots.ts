import type { GraphFactNode } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import {
  graphFactNodePath,
  isPlainObject,
  joinRepoRelativePaths,
  uniqueSortedStrings
} from "@the-open-engine/opcore-validation";
import ts from "typescript";
import type { TypeScriptDeadCodeOptions } from "./dead-code-entrypoints.js";
import { isTypeScriptSourcePath, type TypeScriptMaterializedSourceSet } from "./source-files.js";

interface TypeScriptOutputMapping {
  readonly rootDir: string;
  readonly outDir: string;
}

interface PackageEntrypointResolution {
  readonly context: ValidationCheckContext;
  readonly packageRoot: string;
  readonly target: string;
  readonly sourcePaths: ReadonlySet<string>;
  readonly outputMapping: TypeScriptOutputMapping | undefined;
}

export async function discoverTypeScriptDeadCodeRoots(
  context: ValidationCheckContext,
  options: TypeScriptDeadCodeOptions,
  sourceSet: TypeScriptMaterializedSourceSet,
  nodes: readonly GraphFactNode[]
): Promise<readonly string[]> {
  if (options.entrypoints !== undefined) return [];
  const sourcePaths = knownSourcePaths(sourceSet, nodes);
  const testRoots = sourcePaths.filter((path) => isConventionalTestPath(path));
  const graphTestRoots = nodes.filter(isGraphTestNode).map(graphFactNodePath).filter(isDefined);
  const packageRoots = await discoverPackageEntrypoints(context, sourcePaths);
  return uniqueSortedStrings([...testRoots, ...graphTestRoots, ...packageRoots]);
}

function knownSourcePaths(
  sourceSet: TypeScriptMaterializedSourceSet,
  nodes: readonly GraphFactNode[]
): readonly string[] {
  return uniqueSortedStrings([
    ...sourceSet.paths,
    ...nodes.map(graphFactNodePath).filter(isDefined).filter(isTypeScriptSourcePath)
  ]);
}

async function discoverPackageEntrypoints(
  context: ValidationCheckContext,
  sourcePaths: readonly string[]
): Promise<readonly string[]> {
  const sourcePathSet = new Set(sourcePaths);
  const entrypoints: string[] = [];
  for (const packageRoot of candidatePackageRoots(sourcePaths)) {
    const manifest = await readPackageManifest(context, packageRoot);
    if (manifest === undefined) continue;
    const outputMapping = await readTypeScriptOutputMapping(context, packageRoot);
    for (const target of packageEntrypointTargets(manifest)) {
      const entrypoint = await resolvePackageEntrypoint({
        context,
        packageRoot,
        target,
        sourcePaths: sourcePathSet,
        outputMapping
      });
      if (entrypoint !== undefined) entrypoints.push(entrypoint);
    }
  }
  return uniqueSortedStrings(entrypoints);
}

function candidatePackageRoots(sourcePaths: readonly string[]): readonly string[] {
  const roots = new Set<string>();
  for (const path of sourcePaths) {
    const directoryParts = path.split("/").slice(0, -1);
    for (let length = 0; length <= directoryParts.length; length += 1) {
      roots.add(directoryParts.slice(0, length).join("/"));
    }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

async function readPackageManifest(
  context: ValidationCheckContext,
  packageRoot: string
): Promise<Record<string, unknown> | undefined> {
  const result = await context.fileView.readAfter(pathWithinRoot(packageRoot, "package.json"));
  if (result.status !== "found") return undefined;
  try {
    const parsed: unknown = JSON.parse(result.content);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function packageEntrypointTargets(manifest: Record<string, unknown>): readonly string[] {
  return uniqueSortedStrings([
    ...(typeof manifest.main === "string" ? [manifest.main] : []),
    ...stringLeaves(manifest.exports),
    ...stringLeaves(manifest.bin)
  ]);
}

function stringLeaves(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (!isPlainObject(value)) return [];
  return Object.keys(value).sort().flatMap((key) => stringLeaves(value[key]));
}

async function readTypeScriptOutputMapping(
  context: ValidationCheckContext,
  packageRoot: string
): Promise<TypeScriptOutputMapping | undefined> {
  const configPath = pathWithinRoot(packageRoot, "tsconfig.json");
  const result = await context.fileView.readAfter(configPath);
  if (result.status !== "found") return undefined;
  const parsed = ts.parseConfigFileTextToJson(configPath, result.content);
  if (parsed.error !== undefined || !isPlainObject(parsed.config)) return undefined;
  const compilerOptions = parsed.config.compilerOptions;
  if (!isPlainObject(compilerOptions)) return undefined;
  const rootDir = safePathWithinPackage(packageRoot, compilerOptions.rootDir);
  const outDir = safePathWithinPackage(packageRoot, compilerOptions.outDir);
  if (rootDir === undefined || outDir === undefined || rootDir === outDir) return undefined;
  return { rootDir, outDir };
}

async function resolvePackageEntrypoint(resolution: PackageEntrypointResolution): Promise<string | undefined> {
  const targetPath = safePathWithinPackage(resolution.packageRoot, resolution.target);
  if (targetPath === undefined) return undefined;
  const mappedSource = await resolveOutputSource(resolution.context, targetPath, resolution.outputMapping);
  if (mappedSource !== undefined) return mappedSource;
  if (!resolution.sourcePaths.has(targetPath) || !isTypeScriptSourcePath(targetPath)) return undefined;
  return (await resolution.context.fileView.exists(targetPath)) ? targetPath : undefined;
}

async function resolveOutputSource(
  context: ValidationCheckContext,
  targetPath: string,
  mapping: TypeScriptOutputMapping | undefined
): Promise<string | undefined> {
  if (mapping === undefined) return undefined;
  const relativeOutputPath = descendantPath(mapping.outDir, targetPath);
  if (relativeOutputPath === undefined) return undefined;
  const sourceBase = joinRepoRelativePaths([mapping.rootDir, relativeOutputPath]);
  if (sourceBase === undefined) return undefined;
  const matchingSources: string[] = [];
  for (const candidate of emittedSourceCandidates(sourceBase)) {
    if (await context.fileView.exists(candidate)) matchingSources.push(candidate);
  }
  return matchingSources.length === 1 ? matchingSources[0] : undefined;
}

function emittedSourceCandidates(path: string): readonly string[] {
  if (path.endsWith(".d.mts")) return [replaceSuffix(path, ".d.mts", ".mts")];
  if (path.endsWith(".d.cts")) return [replaceSuffix(path, ".d.cts", ".cts")];
  if (path.endsWith(".d.ts")) {
    return [replaceSuffix(path, ".d.ts", ".ts"), replaceSuffix(path, ".d.ts", ".tsx")];
  }
  if (path.endsWith(".mjs")) return [replaceSuffix(path, ".mjs", ".mts"), path];
  if (path.endsWith(".cjs")) return [replaceSuffix(path, ".cjs", ".cts"), path];
  if (path.endsWith(".jsx")) {
    return [replaceSuffix(path, ".jsx", ".tsx"), replaceSuffix(path, ".jsx", ".ts"), path];
  }
  if (path.endsWith(".js")) {
    return [replaceSuffix(path, ".js", ".ts"), replaceSuffix(path, ".js", ".tsx"), path];
  }
  return isTypeScriptSourcePath(path) ? [path] : [];
}

function safePathWithinPackage(packageRoot: string, value: unknown): string | undefined {
  if (!isSafePackagePathValue(value)) return undefined;
  const relativePath = value.startsWith("./") ? value.slice(2) : value;
  if (relativePath.length === 0) return undefined;
  if (relativePath.startsWith("/")) return undefined;
  if (relativePath.split("/").includes("..")) return undefined;
  return joinRepoRelativePaths([packageRoot, relativePath]);
}

function isSafePackagePathValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.trim() !== value) return false;
  return !["\\", "\0", "*", "?", "[", "]"].some((character) => value.includes(character));
}

function descendantPath(parent: string, path: string): string | undefined {
  if (path === parent) return "";
  return path.startsWith(`${parent}/`) ? path.slice(parent.length + 1) : undefined;
}

function pathWithinRoot(root: string, path: string): string {
  return root.length === 0 ? path : `${root}/${path}`;
}

function replaceSuffix(path: string, suffix: string, replacement: string): string {
  return `${path.slice(0, -suffix.length)}${replacement}`;
}

function isGraphTestNode(node: GraphFactNode): boolean {
  return node.kind === "Test" || node.attributes?.isTest === true;
}

function isConventionalTestPath(path: string): boolean {
  return /(?:^|\/)__tests__\//u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
