import { isAbsolute, relative, resolve } from "node:path";
import type { EditRefusal, RepoIdentity } from "@the-open-engine/opcore-contracts";
import { validateRepoIdentity, validateRepoRelativePath } from "@the-open-engine/opcore-contracts";
import type { EditFileStat, EditWorkspace } from "./workspace.js";
import { errorCode } from "./workspace.js";

export interface EditPathSuccess<T> {
  ok: true;
  value: T;
}

export interface EditPathRefusal {
  ok: false;
  refusal: EditRefusal;
}

export type EditPathResult<T> = EditPathSuccess<T> | EditPathRefusal;

export interface ValidatedExistingPath {
  path: string;
  absolutePath: string;
  realPath: string;
  stat: EditFileStat;
}

export interface ValidatedCreatePath {
  path: string;
  absolutePath: string;
  nearestExistingAncestor: string;
  nearestExistingAncestorRealPath: string;
}

const patchTreeForbiddenRoots = [
  ".git",
  ".ace",
  ".agents",
  ".claude",
  ".codex",
  ".gemini",
  ".opencode",
  ".code-review-graph",
  ".rox-cache",
  ".robustness-engine-cache",
  ".opcore/graph",
  "target",
  "node_modules"
] as const;

export function validateEditRepoIdentity(repo: RepoIdentity): EditPathResult<RepoIdentity> {
  try {
    return { ok: true, value: validateRepoIdentity(repo) };
  } catch (error) {
    const message = errorMessage(error);
    return refused(message.includes("ambiguous") ? "ambiguous_repo_identity" : "unsafe_edit", message);
  }
}

export async function normalizePatchTreeRepoRelativePath(workspace: EditWorkspace, path: string): Promise<EditPathResult<string>> {
  const normalized = normalizeEditRepoRelativePath(path);
  if (!normalized.ok) return normalized;
  const forbiddenRoot = patchTreeForbiddenRoots.find((root) => isSameOrChild(normalized.value, root));
  if (forbiddenRoot) {
    return refused(
      "unsupported_change",
      `Patch/tree edit target is in a generated or private root (${forbiddenRoot}): ${normalized.value}`,
      normalized.value
    );
  }
  const ignored = await isIgnoredByRootGitignore(workspace, normalized.value);
  if (ignored.ok && ignored.value) {
    return refused("unsupported_change", `Patch/tree edit target is ignored by .gitignore: ${normalized.value}`, normalized.value);
  }
  if (!ignored.ok) return ignored;
  return normalized;
}

export async function validateExistingPatchTreePath(
  workspace: EditWorkspace,
  path: string
): Promise<EditPathResult<ValidatedExistingPath>> {
  const normalized = await normalizePatchTreeRepoRelativePath(workspace, path);
  if (!normalized.ok) return normalized;
  return validateExistingPathInsideRepo(workspace, normalized.value);
}

export async function validateCreatePatchTreePath(
  workspace: EditWorkspace,
  path: string,
  options: { mustNotExist?: boolean } = {}
): Promise<EditPathResult<ValidatedCreatePath>> {
  const normalized = await normalizePatchTreeRepoRelativePath(workspace, path);
  if (!normalized.ok) return normalized;
  return validateCreatePathInsideRepo(workspace, normalized.value, options);
}

export function normalizeEditRepoRelativePath(path: string): EditPathResult<string> {
  if (typeof path !== "string") {
    return refused("unsafe_edit", "Repo-relative path must be a string");
  }
  if (/^[\\/]{2}/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path) || isAbsolute(path)) {
    return refused("absolute_path", `Repo-relative path must not be absolute: ${path}`, pathForRefusal(path));
  }
  try {
    return { ok: true, value: validateRepoRelativePath(path) };
  } catch (error) {
    const message = errorMessage(error);
    const category = message.includes("escape") || message.includes("parent") ? "parent_directory" : "unsafe_edit";
    return refused(category, message, pathForRefusal(path));
  }
}

export async function validateExistingPathInsideRepo(
  workspace: EditWorkspace,
  path: string
): Promise<EditPathResult<ValidatedExistingPath>> {
  const normalized = normalizeEditRepoRelativePath(path);
  if (!normalized.ok) return normalized;
  const absolutePath = workspace.resolveRepoPath(normalized.value);
  if (!isInside(workspace.repoRoot, absolutePath)) {
    return refused("parent_directory", `Path escapes repository: ${normalized.value}`, normalized.value);
  }

  let realPath: string;
  let fileStat: EditFileStat;
  try {
    realPath = await workspace.fileSystem.realpath(absolutePath);
    fileStat = await workspace.fileSystem.stat(absolutePath);
  } catch (error) {
    return refused(
      "unsafe_edit",
      `Existing edit target cannot be read for ${normalized.value}: ${errorMessage(error)}`,
      normalized.value
    );
  }
  if (!isInside(workspace.repoRoot, realPath)) {
    return refused(
      "unsafe_edit",
      `Existing edit target resolves outside repository through a symlink: ${normalized.value}`,
      normalized.value
    );
  }
  if (!fileStat.isFile()) {
    return refused("unsupported_change", `Existing edit target is not a file: ${normalized.value}`, normalized.value);
  }

  return {
    ok: true,
    value: {
      path: normalized.value,
      absolutePath,
      realPath,
      stat: fileStat
    }
  };
}

export async function validateCreatePathInsideRepo(
  workspace: EditWorkspace,
  path: string,
  options: { mustNotExist?: boolean } = {}
): Promise<EditPathResult<ValidatedCreatePath>> {
  const normalized = normalizeEditRepoRelativePath(path);
  if (!normalized.ok) return normalized;
  const absolutePath = workspace.resolveRepoPath(normalized.value);
  if (!isInside(workspace.repoRoot, absolutePath)) {
    return refused("parent_directory", `Path escapes repository: ${normalized.value}`, normalized.value);
  }
  if (options.mustNotExist) {
    try {
      await workspace.fileSystem.stat(absolutePath);
      return refused("conflict", `Create target already exists: ${normalized.value}`, normalized.value);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return refused("unsafe_edit", `Create target cannot be inspected for ${normalized.value}: ${errorMessage(error)}`, normalized.value);
      }
    }
  }

  let ancestor: string;
  let ancestorRealPath: string;
  try {
    ancestor = await workspace.nearestExistingAncestor(normalized.value);
    ancestorRealPath = await workspace.fileSystem.realpath(ancestor);
  } catch (error) {
    return refused("unsafe_edit", `Create target ancestor cannot be inspected for ${normalized.value}: ${errorMessage(error)}`, normalized.value);
  }
  if (!isInside(workspace.repoRoot, ancestorRealPath)) {
    return refused(
      "unsafe_edit",
      `Create target ancestor resolves outside repository through a symlink: ${normalized.value}`,
      normalized.value
    );
  }

  return {
    ok: true,
    value: {
      path: normalized.value,
      absolutePath,
      nearestExistingAncestor: ancestor,
      nearestExistingAncestorRealPath: ancestorRealPath
    }
  };
}

export function isInside(repoRoot: string, path: string): boolean {
  const relativePath = relative(resolve(repoRoot), resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function createEditPathRefusal(category: EditRefusal["category"], message: string, path?: string): EditPathRefusal {
  return refused(category, message, path);
}

function refused(category: EditRefusal["category"], message: string, path?: string): EditPathRefusal {
  return {
    ok: false,
    refusal: {
      category,
      message,
      path
    }
  };
}

async function isIgnoredByRootGitignore(workspace: EditWorkspace, path: string): Promise<EditPathResult<boolean>> {
  let raw: string;
  try {
    raw = await workspace.fileSystem.readFile(workspace.resolveRepoPath(".gitignore"), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, value: false };
    return refused("unsafe_edit", `Root .gitignore cannot be inspected: ${errorMessage(error)}`);
  }
  const candidates = ignoreCandidates(path);
  const ignoredByCandidate = new Map(candidates.map((candidate) => [candidate.path, false]));
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1).trim() : line;
    if (pattern.length === 0) continue;
    for (const candidate of candidates) {
      if (ignorePatternMatches(pattern, candidate)) ignoredByCandidate.set(candidate.path, !negated);
    }
  }
  return { ok: true, value: Array.from(ignoredByCandidate.values()).some(Boolean) };
}

interface IgnoreCandidate {
  path: string;
  isDirectory: boolean;
}

function ignoreCandidates(path: string): IgnoreCandidate[] {
  const parts = path.split("/");
  const candidates: IgnoreCandidate[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    candidates.push({ path: parts.slice(0, index).join("/"), isDirectory: true });
  }
  candidates.push({ path, isDirectory: false });
  return candidates;
}

function ignorePatternMatches(pattern: string, candidate: IgnoreCandidate): boolean {
  const normalizedRawPattern = pattern.replaceAll("\\", "/");
  const anchored = normalizedRawPattern.startsWith("/");
  const withoutLeadingSlash = normalizedRawPattern.replace(/^\/+/, "");
  const directoryOnly = withoutLeadingSlash.endsWith("/");
  const normalizedPattern = withoutLeadingSlash.replace(/\/+$/, "");
  if (normalizedPattern.length === 0) return false;
  if (directoryOnly && !candidate.isDirectory) return false;
  if (!anchored && !normalizedPattern.includes("/")) {
    return globOrExactMatches(normalizedPattern, basename(candidate.path));
  }
  return globOrExactMatches(normalizedPattern, candidate.path);
}

function globOrExactMatches(pattern: string, path: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return path === pattern;
  return globPatternToRegExp(pattern).test(path);
}

function globPatternToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  let expression = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "**") {
      if (index === 0) {
        expression += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
      } else if (index === segments.length - 1) {
        expression += "/.*";
      } else {
        expression += "(?:/[^/]+)*/";
      }
      continue;
    }
    if (index > 0 && segments[index - 1] !== "**") expression += "/";
    expression += globSegmentToRegExp(segment);
  }
  return new RegExp(`${expression}$`);
}

function globSegmentToRegExp(segment: string): string {
  let expression = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character);
    }
  }
  return expression;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function isSameOrChild(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathForRefusal(path: string): string | undefined {
  try {
    return validateRepoRelativePath(path);
  } catch {
    return undefined;
  }
}
