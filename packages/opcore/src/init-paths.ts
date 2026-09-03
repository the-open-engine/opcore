import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { errorMessage } from "./init-data.js";
import { isMissingPathError, resolveRepoPath } from "./repo-paths.js";

export { resolveRepoPath } from "./repo-paths.js";

interface ExistingPathRequest {
  root: string;
  absolute: string;
  displayPath: string;
  label: string;
  expected: "file" | "directory";
}

export function assertMutationPath(root: string, path: string, label: string): string {
  const absolute = resolveRepoPath(root, path);
  assertExistingAncestorInsideRepo(root, absolute, path, label);
  if (lstatIfExists(absolute)) assertExistingRepoPath(root, path, label, "file");
  return absolute;
}

export function assertExistingRepoPath(
  root: string,
  path: string,
  label: string,
  expected: "file" | "directory"
): string {
  const absolute = resolveRepoPath(root, path);
  assertExistingAncestorInsideRepo(root, absolute, path, label);
  return assertExistingAbsolutePath({ root, absolute, displayPath: path, label, expected });
}

function assertExistingAbsolutePath(request: ExistingPathRequest): string {
  const lstat = lstatIfExists(request.absolute);
  if (!lstat) throw new Error(`${request.label} does not exist: ${request.displayPath}`);
  if (lstat.isSymbolicLink()) throw new Error(`${request.label} must not be a symlink: ${request.displayPath}`);
  let realPath: string;
  try {
    realPath = realpathSync(request.absolute);
  } catch (error) {
    throw new Error(`${request.label} symlink cannot be resolved for ${request.displayPath}: ${errorMessage(error)}`);
  }
  if (!isInsideRoot(request.root, realPath)) {
    throw new Error(`${request.label} resolves outside repository through a symlink: ${request.displayPath}`);
  }
  const stat = statSync(request.absolute);
  if (request.expected === "file" && !stat.isFile()) {
    throw new Error(`${request.label} is not a file: ${request.displayPath}`);
  }
  if (request.expected === "directory" && !stat.isDirectory()) {
    throw new Error(`${request.label} is not a directory: ${request.displayPath}`);
  }
  return request.absolute;
}

function assertExistingAncestorInsideRepo(root: string, absolute: string, path: string, label: string): void {
  const parent = relative(resolve(root), dirname(absolute));
  if (parent === "") return;
  if (parent.startsWith("..") || isAbsolute(parent)) {
    throw new Error(`${label} parent cannot be resolved inside repository: ${path}`);
  }
  let current = resolve(root);
  for (const segment of parent.split(sep)) {
    if (!segment) continue;
    current = resolve(current, segment);
    if (!lstatIfExists(current)) return;
    const displayPath = relative(resolve(root), current) || ".";
    assertExistingAbsolutePath({
      root, absolute: current, displayPath, label: `${label} parent`, expected: "directory"
    });
  }
}

export function repoPathExists(root: string, path: string): boolean {
  return lstatIfExists(resolveRepoPath(root, path)) !== undefined;
}

export function isLinkedGitWorktree(root: string): boolean {
  return lstatIfExists(resolveRepoPath(root, ".git"))?.isFile() === true;
}

export function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isInsideRoot(root: string, path: string): boolean {
  const normalized = relative(resolve(root), resolve(path));
  return normalized === "" || (!normalized.startsWith("..") && !isAbsolute(normalized));
}
