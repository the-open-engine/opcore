import type {
  ValidationWorkspace,
  ValidationWorkspaceFile,
  ValidationWorkspaceFileSet,
  ValidationWorkspaceReadFileResult
} from "./scope.js";
import { validateRepoRelativePath } from "@the-open-engine/opcore-contracts";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface CreateNodeValidationWorkspaceOptions {
  repoRoot: string;
}

export function createNodeValidationWorkspace(options: CreateNodeValidationWorkspaceOptions): ValidationWorkspace {
  const repoRoot = resolve(options.repoRoot);
  return {
    readFile: async (path, context) => {
      if (context?.scope.kind === "tree" && context.scope.treeRef !== undefined) {
        return readTreeFile(repoRoot, context.scope.treeRef, path);
      }
      if (context?.scope.kind === "staged") {
        return readStagedFile(repoRoot, path);
      }
      const absolutePath = resolveRepoPath(repoRoot, path);
      try {
        return {
          status: "found",
          content: await readFile(absolutePath, "utf8")
        };
      } catch (error) {
        if (isMissingFileError(error)) return { status: "missing" };
        throw error;
      }
    },
    listChangedFiles: (baseRef) => listChangedFiles(repoRoot, baseRef),
    listTreeFiles: (treeRef, changedFrom) => listTreeFiles(repoRoot, treeRef, changedFrom),
    listStagedFiles: () => listDiffFiles(repoRoot, ["diff", "--cached", "--name-status", "-z", "--find-renames", "--"]),
    listRepoFiles: () => listRepoFiles(repoRoot),
    listPackageFiles: async (_packageName, packageRoot) => {
      const files = await listRepoFiles(repoRoot);
      if (files.unavailable) return files;
      const prefix = `${validateRepoRelativePath(packageRoot)}/`;
      return {
        files: files.files.filter((file) => {
          const path = typeof file === "string" ? file : file.path;
          return path === packageRoot || path.startsWith(prefix);
        })
      };
    }
  };
}

function readStagedFile(repoRoot: string, path: string): ValidationWorkspaceReadFileResult {
  const normalized = validateRepoRelativePath(path);
  const result = git(repoRoot, ["show", `:${normalized}`]);
  if (result.ok) return { status: "found", content: result.stdout };
  if (/exists on disk, but not in|Path .* exists, but not|does not exist/.test(result.cause)) {
    return { status: "missing" };
  }
  throw new Error(`Git staged file read unavailable for ${normalized}: ${result.cause}`);
}

function listChangedFiles(repoRoot: string, baseRef: string): ValidationWorkspaceFileSet {
  const base = resolveChangedBase(repoRoot, baseRef);
  if (!base.ok) return unavailable(base);
  const diff = listDiffFiles(repoRoot, ["diff", "--name-status", "-z", "--find-renames", base.diffBase, "--"]);
  if (diff.unavailable) return diff;
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!untracked.ok) return unavailable(untracked);
  return {
    files: [
      ...diff.files,
      ...parseNulRecords(untracked.stdout).map((path) => ({
        path: normalizeGitPath(path),
        status: "added" as const
      }))
    ]
  };
}

function listTreeFiles(repoRoot: string, treeRef: string, changedFrom: string): ValidationWorkspaceFileSet {
  const tree = resolveTreeish(repoRoot, treeRef);
  if (!tree.ok) return unavailable(tree);
  const base = resolveTreeish(repoRoot, changedFrom);
  if (!base.ok) return unavailable(base);
  return listDiffFiles(repoRoot, ["diff", "--name-status", "-z", "--find-renames", base.treeSha, tree.treeSha, "--"]);
}

function listRepoFiles(repoRoot: string): ValidationWorkspaceFileSet {
  const result = git(repoRoot, ["ls-files", "-co", "--exclude-standard", "-z"]);
  if (!result.ok) return unavailable(result);
  return {
    files: parseNulRecords(result.stdout).map(normalizeGitPath)
  };
}

function readTreeFile(repoRoot: string, treeRef: string, path: string): ValidationWorkspaceReadFileResult {
  const normalized = validateRepoRelativePath(path);
  const tree = resolveTreeish(repoRoot, treeRef);
  if (!tree.ok) {
    throw new Error(`${tree.message}: ${tree.cause}`);
  }
  const result = git(repoRoot, ["show", `${tree.treeSha}:${normalized}`]);
  if (result.ok) return { status: "found", content: result.stdout };
  if (/exists on disk, but not in|Path .* exists, but not|does not exist in/.test(result.cause)) {
    return { status: "missing" };
  }
  throw new Error(`Git tree file read unavailable for ${normalized}: ${result.cause}`);
}

function listDiffFiles(repoRoot: string, args: readonly string[]): ValidationWorkspaceFileSet {
  const result = git(repoRoot, args);
  if (!result.ok) return unavailable(result);
  return {
    files: parseNameStatus(result.stdout)
  };
}

function parseNameStatus(output: string): readonly ValidationWorkspaceFile[] {
  const records = parseNulRecords(output);
  const files: ValidationWorkspaceFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const statusCode = records[index];
    const status = statusCode[0];
    if (status === "R" || status === "C") {
      const fromPath = normalizeGitPath(records[++index]);
      const toPath = normalizeGitPath(records[++index]);
      files.push({ path: toPath, status: "renamed", fromPath, toPath });
    } else {
      const path = normalizeGitPath(records[++index]);
      files.push({
        path,
        status: status === "A" ? "added" : status === "D" ? "deleted" : "modified"
      });
    }
  }
  return files;
}

function parseNulRecords(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

function resolveTreeish(repoRoot: string, ref: string): { ok: true; treeSha: string } | { ok: false; message: string; cause: string } {
  const result = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`]);
  if (!result.ok) {
    return {
      ok: false,
      message: "Git tree state unavailable",
      cause: result.cause
    };
  }
  return { ok: true, treeSha: result.stdout.trim() };
}

function resolveChangedBase(
  repoRoot: string,
  baseRef: string
): { ok: true; diffBase: string } | { ok: false; message: string; cause: string } {
  const insideWorkTree = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== "true") {
    return {
      ok: false,
      message: "Changed validation scope requires a Git repository",
      cause: insideWorkTree.ok ? "git rev-parse --is-inside-work-tree returned false" : insideWorkTree.cause
    };
  }

  const commit = git(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`]);
  if (commit.ok && commit.stdout.trim().length > 0) return { ok: true, diffBase: baseRef };

  const isDefaultHead = baseRef === "HEAD" || baseRef === "@";
  const head = git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (isDefaultHead && !head.ok) return { ok: true, diffBase: EMPTY_TREE_SHA };

  return {
    ok: false,
    message: "Changed validation base ref is unavailable",
    cause: `Cannot resolve --base ${baseRef} to a commit`
  };
}

function resolveRepoPath(repoRoot: string, path: string): string {
  const normalized = validateRepoRelativePath(path);
  const absolutePath = resolve(repoRoot, normalized);
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.split(sep).includes("..")) {
    throw new Error(`Repo-relative path escapes repository: ${path}`);
  }
  return absolutePath;
}

function normalizeGitPath(path: string): string {
  return validateRepoRelativePath(path.replaceAll("\\", "/"));
}

function git(repoRoot: string, args: readonly string[]): { ok: true; stdout: string } | { ok: false; message: string; cause: string } {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) return { ok: true, stdout: result.stdout };
  return {
    ok: false,
    message: "Git workspace state unavailable",
    cause: [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n")
  };
}

function unavailable(result: { message: string; cause: string }): ValidationWorkspaceFileSet {
  return {
    files: [],
    unavailable: true,
    message: result.message,
    cause: result.cause
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
  );
}
