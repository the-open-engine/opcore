import { validateRequiredObject } from "./primitives.js";
import { validateStringArray } from "./validators-01.js";
import type { RepoIdentity } from "../graph/provider-contracts-01.js";

function validateRepoRelativePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Repo-relative path must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new Error(`Repo-relative path contains a null byte: ${path}`);
  }
  if (/^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`Repo-relative path must not be absolute: ${path}`);
  }
  const normalized = path.replaceAll("\\", "/");
  if (repoPathEscapesRoot(normalized)) {
    throw new Error(`Repo-relative path must not escape the repository: ${path}`);
  }
  return normalized;
}

export { validateRepoRelativePath };

function validateRepoRelativePaths(paths: unknown, label: string): readonly string[] {
  validateStringArray(paths as readonly string[] | undefined, label, {
    allowEmpty: true,
  });
  for (const path of paths as readonly string[]) validateRepoRelativePath(path);
  return paths as readonly string[];
}

export { validateRepoRelativePaths };

function repoPathEscapesRoot(path: string): boolean {
  return (
    path === "." ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../") ||
    path.endsWith("/..")
  );
}

function validateHomeRelativePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Home-relative path must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new Error(`Home-relative path contains a null byte: ${path}`);
  }
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.startsWith("~/")) {
    throw new Error(`Home-relative path must start with ~/: ${path}`);
  }
  if (
    normalized === "~/" ||
    normalized === "~/." ||
    normalized.includes("/../") ||
    normalized.endsWith("/..") ||
    normalized.includes("//")
  ) {
    throw new Error(`Home-relative path must not escape the home directory: ${path}`);
  }
  return normalized;
}

export { validateHomeRelativePath };

function validateRepoIdentity(repo: RepoIdentity): RepoIdentity {
  validateRequiredObject(repo, "Repo identity is required");
  if (repo.repoId && repo.repoRoot) {
    throw new Error("Repo identity is ambiguous: use repoId or repoRoot, not both");
  }
  if (!repo.repoId && !repo.repoRoot && !repo.remoteUrl) {
    throw new Error("Repo identity must include repoId, repoRoot, or remoteUrl");
  }
  return repo;
}

export { validateRepoIdentity };
