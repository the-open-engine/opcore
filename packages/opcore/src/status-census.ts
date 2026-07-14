import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { commonSkippedPathSegments } from "./source-policy.js";
import { errorCode, errorMessage } from "./status-errors.js";
import { gitFailureMessage, parseGitStatus, runGit, type GitState } from "./status-git.js";
import type { RepoResolution } from "./status-repo.js";

const skippedPathSegments = new Set<string>([
  ...commonSkippedPathSegments,
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".eggs",
  "build",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "site-packages"
]);
const skippedPathSegmentSuffixes = [".egg-info", ".dist-info"];

export interface CensusTraversalFailure {
  path: string;
  message: string;
}

export interface FileCensus {
  files: readonly string[];
  git: GitState;
  traversalFailures: readonly CensusTraversalFailure[];
}

interface RecursiveCensus {
  root: string;
  files: string[];
  traversalFailures: CensusTraversalFailure[];
  stack: string[];
}

export function readRepoCensus(resolution: RepoResolution): FileCensus {
  if (!resolution.git) return nonGitCensus(resolution.root);
  const traversalFailures: CensusTraversalFailure[] = [];
  const statusResult = runGit(resolution.root, ["status", "--porcelain=v1", "--branch"]);
  const git = statusResult.status === 0 ? parseGitStatus(statusResult.stdout) : { available: true };
  if (statusResult.status !== 0) {
    traversalFailures.push({ path: ".", message: `git status failed: ${gitFailureMessage(statusResult)}` });
  }
  const filesResult = runGit(resolution.root, ["ls-files", "-co", "--exclude-standard"]);
  if (filesResult.status !== 0) {
    traversalFailures.push({ path: ".", message: `git file census failed: ${gitFailureMessage(filesResult)}` });
  }
  const files = filesResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !hasSkippedSegment(line))
    .filter((file) => fileExistsForCensus(resolution.root, file, traversalFailures));
  return { files, git, traversalFailures: uniqueTraversalFailures(traversalFailures) };
}

export function formatTraversalFailurePaths(failures: readonly CensusTraversalFailure[]): string {
  const paths = [...new Set(failures.map((failure) => failure.path))].sort();
  const visible = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${visible}, +${paths.length - 5} more` : visible;
}

function nonGitCensus(root: string): FileCensus {
  const census = readFilesRecursive(root);
  return {
    files: census.files,
    git: { available: false },
    traversalFailures: uniqueTraversalFailures(census.traversalFailures)
  };
}

function readFilesRecursive(root: string): { files: string[]; traversalFailures: CensusTraversalFailure[] } {
  const census: RecursiveCensus = { root, files: [], traversalFailures: [], stack: [root] };
  while (census.stack.length > 0) {
    const current = census.stack.pop();
    if (current) scanDirectory(census, current);
  }
  return { files: census.files.sort(), traversalFailures: census.traversalFailures };
}

function scanDirectory(census: RecursiveCensus, current: string): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch (error) {
    census.traversalFailures.push(traversalFailure(census.root, current, error));
    return;
  }
  for (const entry of entries) scanDirectoryEntry(census, current, entry);
}

function scanDirectoryEntry(
  census: RecursiveCensus,
  current: string,
  entry: ReturnType<typeof readdirSync>[number]
): void {
  if (isSkippedPathSegment(entry.name)) return;
  const absolute = join(current, entry.name);
  const relative = absolute.slice(census.root.length + 1).split(sep).join("/");
  if (hasSkippedSegment(relative)) return;
  if (entry.isDirectory()) census.stack.push(absolute);
  else if (entry.isFile()) census.files.push(relative);
}

function fileExistsForCensus(
  root: string,
  file: string,
  traversalFailures: CensusTraversalFailure[]
): boolean {
  try {
    return statSync(join(root, file)).isFile();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      traversalFailures.push({ path: file, message: errorMessage(error) });
    }
    return false;
  }
}

function traversalFailure(root: string, absolutePath: string, error: unknown): CensusTraversalFailure {
  const relativePath = absolutePath === root ? "." : absolutePath.slice(root.length + 1).split(sep).join("/");
  return { path: relativePath, message: errorMessage(error) };
}

function uniqueTraversalFailures(failures: readonly CensusTraversalFailure[]): CensusTraversalFailure[] {
  const seen = new Set<string>();
  const unique: CensusTraversalFailure[] = [];
  for (const failure of failures) {
    const key = `${failure.path}\0${failure.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(failure);
  }
  return unique;
}

function hasSkippedSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => isSkippedPathSegment(segment));
}

function isSkippedPathSegment(segment: string): boolean {
  return skippedPathSegments.has(segment) || skippedPathSegmentSuffixes.some((suffix) => segment.endsWith(suffix));
}
