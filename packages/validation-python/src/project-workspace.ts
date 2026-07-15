import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { validateRepoRelativePath } from "@the-open-engine/opcore-contracts";
import type { ValidationFileView } from "@the-open-engine/opcore-validation";

export interface PythonProjectWorkspaceRealpath {
  path: string;
  symlink: boolean;
  unavailable?: boolean;
}

export interface PythonProjectWorkspace {
  read(path: string): Promise<string | undefined>;
  list(): Promise<readonly string[]>;
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<PythonProjectWorkspaceRealpath>;
  executableExists(path: string): Promise<boolean>;
}

export function createValidationFileViewPythonWorkspace(
  fileView: ValidationFileView,
  executableExists: PythonProjectWorkspace["executableExists"] = nodeExecutableExists,
  fullWorkspace?: PythonProjectWorkspace
): PythonProjectWorkspace {
  return {
    read: async (path) => {
      const result = await fileView.readAfter(validateRepoRelativePath(path));
      return result.status === "found" ? result.content : undefined;
    },
    list: async () => {
      const candidates = [...new Set([
        ...await fileView.listVisibleFiles(),
        ...(fullWorkspace === undefined ? [] : await fullWorkspace.list())
      ])].sort();
      const visible: string[] = [];
      for (const path of candidates) {
        if (await fileView.exists(path)) visible.push(path);
      }
      return visible;
    },
    exists: (path) => fileView.exists(validateRepoRelativePath(path)),
    realpath: async (path) => {
      const normalized = validateRepoRelativePath(path);
      if (fullWorkspace === undefined) return { path: normalized, symlink: false, unavailable: true };
      const baseline = await fullWorkspace.realpath(normalized);
      if (!fileView.hasOverlay(normalized)) return baseline;
      if (baseline.symlink) return baseline;
      if (baseline.unavailable && await fullWorkspace.exists(normalized)) return baseline;
      return { path: normalized, symlink: false };
    },
    executableExists
  };
}

export function createNodePythonProjectWorkspace(repoRoot: string): PythonProjectWorkspace {
  const canonicalRoot = realpathSync(resolve(repoRoot));
  let listed: Promise<readonly string[]> | undefined;
  return {
    read: async (path) => {
      const absolute = resolveRepoPath(canonicalRoot, path);
      try {
        return await readFile(absolute, "utf8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    list: () => {
      listed ??= listNodeWorkspace(canonicalRoot);
      return listed;
    },
    exists: async (path) => {
      try {
        await access(resolveRepoPath(canonicalRoot, path));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    realpath: async (path) => {
      const normalized = validateRepoRelativePath(path);
      const absolute = resolveRepoPath(canonicalRoot, normalized);
      try {
        const info = await lstat(absolute);
        const resolved = await realpath(absolute);
        const relativePath = repoRelativeOrUndefined(canonicalRoot, resolved);
        if (relativePath === undefined) return { path: normalized, symlink: true };
        return { path: relativePath, symlink: info.isSymbolicLink() || relativePath !== normalized };
      } catch (error) {
        if (isMissing(error)) return { path: normalized, symlink: false };
        throw error;
      }
    },
    executableExists: nodeExecutableExists
  };
}

async function listNodeWorkspace(repoRoot: string): Promise<readonly string[]> {
  const entries = await readdir(repoRoot, { recursive: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const normalized = String(entry).replaceAll("\\", "/");
    if (skipPath(normalized)) continue;
    const absolute = resolve(repoRoot, normalized);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (info.isFile() || info.isSymbolicLink()) paths.push(validateRepoRelativePath(normalized));
  }
  return [...new Set(paths)].sort();
}

async function nodeExecutableExists(path: string): Promise<boolean> {
  if (!isPathLike(path)) return true;
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function resolveRepoPath(repoRoot: string, path: string): string {
  const normalized = validateRepoRelativePath(path);
  const absolute = resolve(repoRoot, normalized);
  toRepoRelative(repoRoot, absolute);
  return absolute;
}

function toRepoRelative(repoRoot: string, absolute: string): string {
  const value = repoRelativeOrUndefined(repoRoot, absolute);
  if (value === undefined) {
    throw new Error(`Python project workspace path escapes repository: ${absolute}`);
  }
  return value;
}

function repoRelativeOrUndefined(repoRoot: string, absolute: string): string | undefined {
  const value = relative(repoRoot, absolute);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`)) return undefined;
  return validateRepoRelativePath(value.replaceAll("\\", "/"));
}

function skipPath(path: string): boolean {
  const skipped = new Set([
    ".git", "node_modules", "target", "dist", ".ace", ".agents", ".claude", ".codex", ".gemini",
    ".opencode", ".rox-cache", ".robustness-engine-cache", ".venv", "venv", "env", "__pycache__",
    ".eggs", "build", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages"
  ]);
  return path.split("/").some((segment) => skipped.has(segment) || segment.endsWith(".egg-info") || segment.endsWith(".dist-info"));
}

function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\") || /^[A-Za-z]:/u.test(command);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
