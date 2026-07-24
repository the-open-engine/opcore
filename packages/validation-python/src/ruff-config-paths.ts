import {
  isAbsolutePortablePath,
  normalizePortablePath,
  portableDirname
} from "./python-execution-workspace.js";

export function resolveRuffExtendPath(
  configPath: string,
  extend: string,
  repositoryRoot: string
): { status: "resolved"; path: string; rewrite: boolean } | { status: "invalid"; message: string } {
  const normalized = extend.replaceAll("\\", "/");
  if (isAbsolutePortablePath(normalized)) {
    try {
      return {
        status: "resolved",
        path: repoRelativeConfigPath(normalized, repositoryRoot),
        rewrite: true
      };
    } catch (error) {
      return {
        status: "invalid",
        message: `Ruff configuration ${configPath} extends a path outside the after-state repository: ${
          error instanceof Error ? error.message : String(error)
        }`
      };
    }
  }
  const path = resolvePortableRepoPath(portableDirname(configPath), normalized);
  return path === undefined
    ? {
        status: "invalid",
        message: `Ruff configuration ${configPath} has an extend path that escapes the after-state repository: ${extend}`
      }
    : { status: "resolved", path, rewrite: false };
}

function resolvePortableRepoPath(directory: string, path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const segments: string[] = directory === "." ? [] : directory.split("/").filter(Boolean);
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join("/");
}

export function repoRelativeConfigPath(path: string, repositoryRoot: string): string {
  const normalizedPath = normalizePortablePath(path);
  if (!isAbsolutePortablePath(normalizedPath)) {
    const resolved = resolvePortableRepoPath(".", normalizedPath);
    if (resolved === undefined) {
      throw new Error(`configuration path is not repo-relative: ${path}`);
    }
    return resolved;
  }
  const normalizedRoot = normalizePortablePath(repositoryRoot);
  const caseInsensitive = /^[A-Za-z]:\//u.test(normalizedRoot);
  const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!comparablePath.startsWith(`${comparableRoot}/`)) {
    throw new Error(`absolute path is outside ${repositoryRoot}`);
  }
  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  const resolved = resolvePortableRepoPath(".", relativePath);
  if (resolved === undefined) throw new Error(`absolute path does not identify a repository file: ${path}`);
  return resolved;
}

export function portableRelativePath(fromDirectory: string, toPath: string): string {
  const from = fromDirectory === "." ? [] : fromDirectory.split("/").filter(Boolean);
  const to = toPath.split("/").filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  const relativePath = [...Array(from.length - shared).fill(".."), ...to.slice(shared)].join("/");
  return relativePath.length === 0 ? "." : relativePath;
}

export function isPyprojectConfig(path: string): boolean {
  return normalizePortablePath(path).split("/").at(-1)?.toLowerCase() === "pyproject.toml";
}
