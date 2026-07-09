import type {
  ValidationCheckContext,
  ValidationFileReadResult,
  ValidationFileView
} from "@the-open-engine/opcore-validation";
import { normalizeRepoRelativePath, repoPathGlobToRegex, repoPathHasGlobSyntax } from "@the-open-engine/opcore-validation";
import type { OpcorePathPolicy } from "./types.js";

export function pathPolicyIncludes(path: string, policy: OpcorePathPolicy | undefined): boolean {
  const normalized = normalizePolicyPath(path);
  if (normalized === undefined) return false;
  const include = policy?.include ?? [];
  const exclude = policy?.exclude ?? [];
  const included = include.length === 0 || include.some((pattern) => patternMatchesPath(pattern, normalized));
  return included && !exclude.some((pattern) => patternMatchesPath(pattern, normalized));
}

export function withFilteredFileView<T extends Pick<ValidationCheckContext, "fileView">>(context: T, policy: OpcorePathPolicy): T {
  const fileView = context.fileView;
  const filteredOverlays = fileView.overlays.filter((overlay) => pathPolicyIncludes(overlay.path, policy));
  let filteredVisibleFilesPromise: Promise<readonly string[]> | undefined;
  const listVisibleFiles = (): Promise<readonly string[]> => {
    filteredVisibleFilesPromise ??= fileView.listVisibleFiles().then((paths) => paths.filter((path) => pathPolicyIncludes(path, policy)));
    return filteredVisibleFilesPromise;
  };
  const filteredFileView: ValidationFileView = {
    ...fileView,
    scopeFiles: fileView.scopeFiles.filter((path) => pathPolicyIncludes(path, policy)),
    listVisibleFiles,
    overlays: filteredOverlays,
    readFile: (path, options) =>
      pathPolicyIncludes(path, policy) ? fileView.readFile(path, options) : Promise.resolve(missingRead(path, options?.state ?? "after")),
    readBefore: (path) =>
      pathPolicyIncludes(path, policy) ? fileView.readBefore(path) : Promise.resolve(missingRead(path, "before")),
    readAfter: (path) =>
      pathPolicyIncludes(path, policy) ? fileView.readAfter(path) : Promise.resolve(missingRead(path, "after")),
    exists: (path, options) => pathPolicyIncludes(path, policy) ? fileView.exists(path, options) : Promise.resolve(false),
    hasOverlay: (path) => pathPolicyIncludes(path, policy) && fileView.hasOverlay(path),
    overlayFor: (path) => pathPolicyIncludes(path, policy)
      ? filteredOverlays.find((overlay) => normalizePolicyPath(overlay.path) === normalizePolicyPath(path))
      : undefined
  };
  return { ...context, fileView: filteredFileView };
}

function missingRead(path: string, state: "before" | "after"): ValidationFileReadResult {
  const normalized = normalizePolicyPath(path) ?? path;
  return {
    path: normalized,
    state,
    status: "missing",
    source: "workspace",
    sourceMetadata: { source: "workspace", path: normalized }
  };
}

function patternMatchesPath(pattern: string, path: string): boolean {
  const normalizedPattern = normalizePolicyPath(pattern);
  if (normalizedPattern === undefined) return false;
  if (normalizedPattern.endsWith("/")) return path.startsWith(normalizedPattern);
  if (repoPathHasGlobSyntax(normalizedPattern)) return repoPathGlobToRegex(normalizedPattern).test(path);
  return path === normalizedPattern || path.startsWith(`${normalizedPattern}/`);
}

function normalizePolicyPath(path: string): string | undefined {
  return normalizeRepoRelativePath(path, { emptyPath: "" });
}
