import type {
  ValidationWorkspace,
  ValidationWorkspaceFile,
  ValidationWorkspaceFileSet,
  ValidationWorkspaceListFilesContext,
  ValidationWorkspaceReadContext,
  ValidationWorkspaceReadFileResult
} from "./scope.js";
import { validateRepoRelativePath } from "@the-open-engine/opcore-contracts";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface CreateNodeValidationWorkspaceOptions {
  repoRoot: string;
  skippedPathSegments?: readonly string[];
}

export function createNodeValidationWorkspace(options: CreateNodeValidationWorkspaceOptions): ValidationWorkspace {
  const repoRoot = resolve(options.repoRoot);
  const skippedPathSegments = new Set(options.skippedPathSegments ?? []);
  return {
    readFile: (path, context) => readWorkspaceFile(repoRoot, path, context),
    listFiles: (context) => filterFileSet(listWorkspaceFiles(repoRoot, context, skippedPathSegments), skippedPathSegments),
    listChangedFiles: (baseRef) => filterFileSet(listChangedFiles(repoRoot, baseRef), skippedPathSegments),
    listTreeFiles: (treeRef, changedFrom) => filterFileSet(listTreeFiles(repoRoot, treeRef, changedFrom), skippedPathSegments),
    listStagedFiles: () =>
      filterFileSet(listDiffFiles(repoRoot, ["diff", "--cached", "--name-status", "-z", "--find-renames", "--"]), skippedPathSegments),
    listRepoFiles: () => filterFileSet(listRepoFiles(repoRoot), skippedPathSegments),
    listPackageFiles: async (_packageName, packageRoot) => {
      const files = filterFileSet(await listRepoFiles(repoRoot), skippedPathSegments);
      if (files.unavailable) return files;
      const root = validateRepoRelativePath(packageRoot);
      const prefix = `${root}/`;
      return {
        files: files.files.filter((file) => {
          const path = typeof file === "string" ? file : file.path;
          return path === root || path.startsWith(prefix);
        })
      };
    }
  };
}

async function readWorkspaceFile(
  repoRoot: string,
  path: string,
  context?: ValidationWorkspaceReadContext
): Promise<ValidationWorkspaceReadFileResult> {
  const beforeRef = beforeStateTreeRef(repoRoot, context);
  if (beforeRef !== undefined) return readTreeFile(repoRoot, beforeRef, path);
  if (context?.scope.kind === "tree" && context.scope.treeRef !== undefined) {
    return readTreeFile(repoRoot, context.scope.treeRef, path);
  }
  if (context?.scope.kind === "staged") return readStagedFile(repoRoot, path);
  return readDiskFile(repoRoot, path);
}

function beforeStateTreeRef(repoRoot: string, context?: ValidationWorkspaceReadContext): string | undefined {
  if (context?.state !== "before") return undefined;
  if (context.scope.kind === "changed" && context.scope.baseRef !== undefined) {
    const base = resolveChangedBase(repoRoot, context.scope.baseRef);
    if (!base.ok) throw new Error(`${base.message}: ${base.cause}`);
    return base.diffBase;
  }
  if (context.scope.kind === "tree" && context.scope.changedFrom !== undefined) return context.scope.changedFrom;
  return undefined;
}

async function readDiskFile(repoRoot: string, path: string): Promise<ValidationWorkspaceReadFileResult> {
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
}

function filterFileSet(fileSet: ValidationWorkspaceFileSet, skippedPathSegments: ReadonlySet<string>): ValidationWorkspaceFileSet {
  if (skippedPathSegments.size === 0 || fileSet.unavailable) return fileSet;
  return {
    ...fileSet,
    files: fileSet.files.filter((file) => {
      const path = typeof file === "string" ? file : file.path;
      return !hasSkippedSegment(path, skippedPathSegments);
    })
  };
}

function hasSkippedSegment(path: string, skippedPathSegments: ReadonlySet<string>): boolean {
  return path.split(/[\\/]+/).some((segment) => skippedPathSegments.has(segment));
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

function listWorkspaceFiles(
  repoRoot: string,
  context: ValidationWorkspaceListFilesContext,
  skippedPathSegments: ReadonlySet<string>
): ValidationWorkspaceFileSet {
  const state = context.state ?? "after";
  const beforeRef = beforeStateTreeRef(repoRoot, { scope: context.scope, state });
  if (beforeRef !== undefined) return mergeFileSets(listTreeSnapshotFiles(repoRoot, beforeRef), listRepoFiles(repoRoot));
  if (state === "after" && context.scope.kind === "tree" && context.scope.treeRef !== undefined) {
    return mergeFileSets(listTreeSnapshotFiles(repoRoot, context.scope.treeRef), listRepoFiles(repoRoot));
  }
  if (context.scope.kind === "package" && context.scope.packageRoot !== undefined) {
    const files = repoFilesOrDiskFiles(repoRoot, skippedPathSegments);
    return filterPackageFileSet(files, context.scope.packageRoot);
  }
  return repoFilesOrDiskFiles(repoRoot, skippedPathSegments);
}

function repoFilesOrDiskFiles(repoRoot: string, skippedPathSegments: ReadonlySet<string>): ValidationWorkspaceFileSet {
  const tracked = listRepoFiles(repoRoot);
  return tracked.unavailable ? listDiskFiles(repoRoot, skippedPathSegments) : tracked;
}

function listDiskFiles(repoRoot: string, skippedPathSegments: ReadonlySet<string>): ValidationWorkspaceFileSet {
  const files: string[] = [];
  try {
    const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
      for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
        if (skippedPathSegments.has(entry.name)) continue;
        const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
        const absolutePath = resolve(absoluteDirectory, entry.name);
        if (entry.isDirectory()) visit(absolutePath, relativePath);
        else if (entry.isFile()) files.push(validateRepoRelativePath(relativePath));
        else if (entry.isSymbolicLink()) throw new Error(`Disk validation listing does not follow symlink: ${relativePath}`);
      }
    };
    visit(repoRoot, "");
    return { files: files.sort() };
  } catch (error) {
    return {
      files: [],
      unavailable: true,
      message: "Disk validation file listing is unavailable",
      cause: error instanceof Error ? error.message : String(error)
    };
  }
}

function listTreeSnapshotFiles(repoRoot: string, treeRef: string): ValidationWorkspaceFileSet {
  const tree = resolveTreeish(repoRoot, treeRef);
  if (!tree.ok) return unavailable(tree);
  const result = git(repoRoot, ["ls-tree", "-r", "-z", "--name-only", tree.treeSha, "--"]);
  if (!result.ok) return unavailable(result);
  return {
    files: parseNulRecords(result.stdout).map(normalizeGitPath)
  };
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

function filterPackageFileSet(fileSet: ValidationWorkspaceFileSet, packageRoot: string): ValidationWorkspaceFileSet {
  if (fileSet.unavailable) return fileSet;
  const root = validateRepoRelativePath(packageRoot);
  const prefix = `${root}/`;
  return {
    ...fileSet,
    files: fileSet.files.filter((file) => {
      const path = typeof file === "string" ? file : file.path;
      return path === root || path.startsWith(prefix);
    })
  };
}

function mergeFileSets(...fileSets: readonly ValidationWorkspaceFileSet[]): ValidationWorkspaceFileSet {
  const unavailableSet = fileSets.find((fileSet) => fileSet.unavailable);
  if (unavailableSet !== undefined) return unavailableSet;
  return {
    files: [
      ...new Map(
        fileSets.flatMap((fileSet) => fileSet.files).map((file) => {
          const path = typeof file === "string" ? normalizeGitPath(file) : normalizeGitPath(file.path);
          return [path, typeof file === "string" ? path : { ...file, path }] as const;
        })
      ).values()
    ]
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
