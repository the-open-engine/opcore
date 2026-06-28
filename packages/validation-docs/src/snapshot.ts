import {
  requiredContextDocPolicy,
  validateRequiredContextDocPolicy,
  type RequiredContextDocPolicy
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationFileView } from "@the-open-engine/opcore-validation";
import { normalizeValidationFileViewPath } from "@the-open-engine/opcore-validation";

export interface DocsPolicyOptions {
  policy?: RequiredContextDocPolicy;
}

export interface DocsDocument {
  path: string;
  content: string;
  source: "workspace" | "overlay";
  requiredContext: boolean;
}

export interface RequiredContextDocLocation {
  root: string;
  candidates: readonly string[];
  found: readonly string[];
}

export interface DocsSnapshot {
  policy: RequiredContextDocPolicy;
  docs: readonly DocsDocument[];
  requiredLocations: readonly RequiredContextDocLocation[];
  scopeFiles: readonly string[];
  hasOverlays: boolean;
}

const snapshotCache = new WeakMap<ValidationFileView, Map<string, Promise<DocsSnapshot>>>();
const textDocExtensions = [".md", ".mdx", ".txt", ".rst", ".adoc"] as const;
const policyConfigExtensions = [".md", ".mdx", ".txt", ".rst", ".adoc", ".json", ".jsonc", ".yaml", ".yml", ".toml"] as const;
const commonRootDocBasenames = ["readme.md", "readme.mdx", "readme.txt", "contributing.md", "contributing.mdx"] as const;
const docsDirectorySegments = ["docs", "documentation"] as const;
const policyConfigSegments = ["policy", "policies", "config", "configs"] as const;

export async function materializeDocsSnapshot(
  context: ValidationCheckContext,
  options: DocsPolicyOptions = {}
): Promise<DocsSnapshot> {
  const policy = validateRequiredContextDocPolicy(options.policy ?? requiredContextDocPolicy);
  const cacheKey = JSON.stringify(policy);
  let cache = snapshotCache.get(context.fileView);
  if (cache === undefined) {
    cache = new Map();
    snapshotCache.set(context.fileView, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const promise = materializeDocsSnapshotUncached(context, policy);
  cache.set(cacheKey, promise);
  return promise;
}

export function isDocsPath(path: string, policy: RequiredContextDocPolicy = requiredContextDocPolicy): boolean {
  const normalized = normalizeValidationFileViewPath(path);
  const basename = pathBasename(normalized);
  const lower = normalized.toLowerCase();
  return (
    isRequiredContextDocBasename(basename, policy) ||
    commonRootDocBasenames.includes(basename.toLowerCase() as (typeof commonRootDocBasenames)[number]) ||
    isKnownDocsDirectoryPath(lower) ||
    isGithubTextDocPath(lower) ||
    isPolicyConfigDocPath(lower)
  );
}

export function isRequiredContextDocPath(path: string, policy: RequiredContextDocPolicy = requiredContextDocPolicy): boolean {
  return policy.filenames.includes(pathBasename(normalizeValidationFileViewPath(path)));
}

export function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function pathBasename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function materializeRequiredLocations(
  context: ValidationCheckContext,
  policy: RequiredContextDocPolicy
): readonly RequiredContextDocLocation[] {
  const packageRoot = context.scope.kind === "package" ? context.scope.packageRoot : undefined;
  const roots = packageRoot !== undefined
    ? policy.requiredPaths.map((path) => joinRepoPath(packageRoot, path))
    : policy.requiredPaths.map((path) => (path === "." ? "." : normalizeValidationFileViewPath(path)));
  return uniqueSorted(roots).map((root) => ({
    root,
    candidates: policy.filenames.map((filename) => joinRepoPath(root, filename)),
    found: []
  }));
}

async function materializeDocsSnapshotUncached(
  context: ValidationCheckContext,
  policy: RequiredContextDocPolicy
): Promise<DocsSnapshot> {
  const requiredLocations = materializeRequiredLocations(context, policy);
  const requiredCandidates = requiredLocations.flatMap((location) => location.candidates);
  const scopeFiles = uniqueSorted([
    ...context.fileView.scopeFiles.map((path) => normalizeValidationFileViewPath(path)),
    ...context.fileView.overlays.map((overlay) => normalizeValidationFileViewPath(overlay.path))
  ]);
  const candidatePaths = uniqueSorted([...scopeFiles.filter((path) => isDocsPath(path, policy)), ...requiredCandidates]);
  const docs: DocsDocument[] = [];

  for (const path of candidatePaths) {
    const result = await context.fileView.readAfter(path);
    if (result.status !== "found") continue;
    docs.push({
      path,
      content: result.content,
      source: result.sourceMetadata.source,
      requiredContext: isRequiredContextDocPath(path, policy)
    });
  }

  const foundRequired = new Set(docs.filter((doc) => doc.requiredContext).map((doc) => doc.path));
  return {
    policy,
    docs: docs.sort((left, right) => left.path.localeCompare(right.path)),
    requiredLocations: requiredLocations.map((location) => ({
      ...location,
      found: location.candidates.filter((candidate) => foundRequired.has(candidate))
    })),
    scopeFiles,
    hasOverlays: context.fileView.overlays.length > 0
  };
}

function joinRepoPath(...parts: readonly string[]): string {
  const joined = parts
    .flatMap((part) => part.split("/"))
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  return normalizeValidationFileViewPath(joined);
}

function hasExtension(path: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => path.endsWith(extension));
}

function isRequiredContextDocBasename(basename: string, policy: RequiredContextDocPolicy): boolean {
  return policy.filenames.includes(basename);
}

function isKnownDocsDirectoryPath(path: string): boolean {
  return hasExtension(path, textDocExtensions) && hasAnyPathSegment(path, docsDirectorySegments);
}

function isGithubTextDocPath(path: string): boolean {
  return path.startsWith(".github/") && hasExtension(path, textDocExtensions);
}

function isPolicyConfigDocPath(path: string): boolean {
  return hasExtension(path, policyConfigExtensions) && hasAnyPathSegment(path, policyConfigSegments);
}

function hasAnyPathSegment(path: string, segments: readonly string[]): boolean {
  const pathSegments = path.split("/");
  return segments.some((segment) => pathSegments.includes(segment));
}
