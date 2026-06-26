import type { EditPlan, EditRefusal, RepoIdentity, RepoRelativeChange, ValidationRequest } from "@the-open-engine/lattice-contracts";
import { calculateEditChecksum, calculatePlanHash, createPlanId } from "./hash.js";
import {
  applyResolvedTextEdits,
  applySearchReplaceOperations,
  findLiteralMatches,
  resolveExactTextEdit,
  type EditOperationResult,
  type EditTextOperation,
  type LiteralMatch,
  type ResolvedTextEdit,
  type SearchReplaceOperation
} from "./operations.js";
import { createEditPathRefusal, normalizeEditRepoRelativePath, validateEditRepoIdentity } from "./path-policy.js";
import { createValidationRequestFromChanges, type EditPlanAfterState } from "./validation-request.js";

export interface EditPlanRequestBase {
  repo?: RepoIdentity;
  validation?: {
    required?: boolean;
  };
}

export interface EditPlanBuildOptions {
  planIdentity?: unknown;
  validationRequest?: ValidationRequest;
  afterState?: EditPlanAfterState;
}

export interface ExactEditPlanRequest extends EditPlanRequestBase, EditTextOperation {
  path: string;
  content: string;
}

export interface MultiEditFileRequest {
  path: string;
  content: string;
  checksumBefore?: string;
  operations: readonly EditTextOperation[];
}

export interface MultiEditPlanRequest extends EditPlanRequestBase {
  files: readonly MultiEditFileRequest[];
}

export interface SearchReplaceEditPlanRequest extends EditPlanRequestBase {
  path: string;
  content: string;
  search: string;
  replace: string;
  checksumBefore?: string;
  expectedCount?: number;
  replaceAll?: boolean;
  regex?: boolean;
  caseInsensitive?: boolean;
  multiline?: boolean;
  dotAll?: boolean;
}

export interface SearchReplaceFileRequest {
  path: string;
  content: string;
  checksumBefore?: string;
}

export interface SearchReplaceFilesEditPlanRequest extends EditPlanRequestBase {
  files: readonly SearchReplaceFileRequest[];
  operations: readonly SearchReplaceOperation[];
  fileContains?: string;
}

export interface EditPlannerSuccess {
  ok: true;
  plan: EditPlan;
  matchCount?: number;
  matches?: readonly LiteralMatch[];
  afterState: EditPlanAfterState;
}

export interface EditPlannerRefusal {
  ok: false;
  refusal: EditRefusal;
  matchCount?: number;
  matches?: readonly LiteralMatch[];
}

export type EditPlannerResult = EditPlannerSuccess | EditPlannerRefusal;

const defaultRepo: RepoIdentity = { repoId: "current-worktree" };

export function createExactEditPlan(request: ExactEditPlanRequest): EditPlannerResult {
  const base = normalizePlannerBase(request.repo);
  if (!base.ok) return base;
  const path = normalizeEditRepoRelativePath(request.path);
  if (!path.ok) return path;

  const resolved = resolveExactTextEdit({
    path: path.value,
    content: request.content,
    expectedText: request.expectedText,
    replacementText: request.replacementText,
    occurrence: request.occurrence,
    checksumBefore: request.checksumBefore
  });
  if (!resolved.ok) return resolved;

  const applied = applyResolvedTextEdits(request.content, [resolved.value]);
  if (!applied.ok) return applied;
  return buildPlan(base.value, request.validation?.required ?? true, [
    replaceChange(path.value, request.content, applied.value, request.checksumBefore)
  ]);
}

export function createMultiEditPlan(request: MultiEditPlanRequest): EditPlannerResult {
  const base = normalizePlannerBase(request.repo);
  if (!base.ok) return base;
  if (request.files.length === 0) {
    return refusal("unsupported_change", "Multi-edit planning requires at least one file");
  }

  const orderedPaths: string[] = [];
  const mergedFiles = new Map<string, { originalContent: string; currentContent: string; checksumBefore?: string }>();
  for (const file of request.files) {
    const path = normalizeEditRepoRelativePath(file.path);
    if (!path.ok) return path;
    if (file.operations.length === 0) {
      return refusal("unsupported_change", `Multi-edit file has no operations: ${path.value}`, path.value);
    }
    const checksumBefore = calculateEditChecksum(file.content);
    if (file.checksumBefore !== undefined && file.checksumBefore !== checksumBefore) {
      return refusal(
        "conflict",
        `Stale checksumBefore for ${path.value}: expected ${file.checksumBefore} but found ${checksumBefore}`,
        path.value
      );
    }

    const existing = mergedFiles.get(path.value);
    const merged = existing ?? {
      originalContent: file.content,
      currentContent: file.content,
      checksumBefore: file.checksumBefore
    };
    if (!existing) {
      orderedPaths.push(path.value);
      mergedFiles.set(path.value, merged);
    } else if (file.content !== existing.originalContent && file.content !== existing.currentContent) {
      return refusal(
        "conflict",
        `Duplicate multi-edit file metadata for ${path.value} does not match original or intermediate content`,
        path.value
      );
    } else if (existing.checksumBefore === undefined && file.checksumBefore !== undefined && file.content === existing.originalContent) {
      existing.checksumBefore = file.checksumBefore;
    }

    for (const operation of file.operations) {
      const operationChecksum = calculateEditChecksum(merged.currentContent);
      if (operation.checksumBefore !== undefined && operation.checksumBefore !== operationChecksum) {
        return refusal(
          "conflict",
          `Stale checksumBefore for ${path.value}: expected ${operation.checksumBefore} but found ${operationChecksum}`,
          path.value
        );
      }
      const applied = applyExactOperation(path.value, merged.currentContent, operation);
      if (!applied.ok) return applied;
      merged.currentContent = applied.value;
    }
  }

  const changes: RepoRelativeChange[] = [];
  for (const path of orderedPaths) {
    const file = mergedFiles.get(path);
    if (!file) throw new Error(`Missing merged multi-edit file: ${path}`);
    if (file.currentContent !== file.originalContent) {
      changes.push(replaceChange(path, file.originalContent, file.currentContent, file.checksumBefore));
    }
  }

  return buildPlan(base.value, request.validation?.required ?? true, changes);
}

export function createSearchReplaceEditPlan(request: SearchReplaceEditPlanRequest): EditPlannerResult {
  const base = normalizePlannerBase(request.repo);
  if (!base.ok) return base;
  const path = normalizeEditRepoRelativePath(request.path);
  if (!path.ok) return path;

  const checksumBefore = calculateEditChecksum(request.content);
  if (request.checksumBefore !== undefined && request.checksumBefore !== checksumBefore) {
    return refusal(
      "conflict",
      `Stale checksumBefore for ${path.value}: expected ${request.checksumBefore} but found ${checksumBefore}`,
      path.value
    );
  }

  const operation = {
    search: request.search,
    replace: request.replace,
    regex: request.regex,
    caseInsensitive: request.caseInsensitive,
    multiline: request.multiline,
    dotAll: request.dotAll,
    replaceAll: request.replaceAll
  };
  const applied = applySearchReplaceOperations(request.content, [operation], path.value);
  if (!applied.ok) return applied;
  const matchCount = applied.value.matchCount;
  if (request.expectedCount !== undefined && (!Number.isInteger(request.expectedCount) || request.expectedCount < 0)) {
    return refusal("unsafe_edit", `expectedCount must be a non-negative integer for ${path.value}`, path.value);
  }
  if (request.expectedCount !== undefined && request.expectedCount !== matchCount) {
    return {
      ...refusal(
        "conflict",
        `Search text matched ${matchCount} times in ${path.value}; expected ${request.expectedCount}`,
        path.value
      ),
      matchCount,
    };
  }
  if (matchCount > 1 && request.expectedCount === undefined && request.replaceAll !== true) {
    return {
      ...refusal(
        "unsafe_edit",
        `Search text matched ${matchCount} times in ${path.value}; pass expectedCount or replaceAll for deterministic replacement`,
        path.value
      ),
      matchCount
    };
  }
  if (matchCount === 0) {
    const planned = buildPlan(base.value, request.validation?.required ?? true, []);
    return planned.ok ? { ...planned, matchCount } : planned;
  }
  if (applied.value.content === request.content) {
    return { ...refusal("unsafe_edit", `Search-replace for ${path.value} leaves content unchanged`, path.value), matchCount };
  }

  const planned = buildPlan(base.value, request.validation?.required ?? true, [
    replaceChange(path.value, request.content, applied.value.content, request.checksumBefore)
  ]);
  return planned.ok ? { ...planned, matchCount } : planned;
}

export function createSearchReplaceFilesEditPlan(request: SearchReplaceFilesEditPlanRequest): EditPlannerResult {
  const base = normalizePlannerBase(request.repo);
  if (!base.ok) return base;
  if (request.files.length === 0) return refusal("unsupported_change", "Search-replace planning requires at least one file");
  if (request.operations.length === 0) return refusal("unsupported_change", "Search-replace planning requires at least one operation");
  if (request.fileContains !== undefined && request.fileContains.length === 0) {
    return refusal("unsupported_change", "fileContains must be non-empty when provided");
  }

  const seenPaths = new Set<string>();
  const changes: RepoRelativeChange[] = [];
  let totalMatchCount = 0;
  for (const file of request.files) {
    const path = normalizeEditRepoRelativePath(file.path);
    if (!path.ok) return path;
    if (seenPaths.has(path.value)) return refusal("conflict", `Duplicate search-replace file path: ${path.value}`, path.value);
    seenPaths.add(path.value);

    const checksumBefore = calculateEditChecksum(file.content);
    if (file.checksumBefore !== undefined && file.checksumBefore !== checksumBefore) {
      return refusal(
        "conflict",
        `Stale checksumBefore for ${path.value}: expected ${file.checksumBefore} but found ${checksumBefore}`,
        path.value
      );
    }
    if (request.fileContains !== undefined && !file.content.includes(request.fileContains)) continue;

    const applied = applySearchReplaceOperations(file.content, request.operations, path.value);
    if (!applied.ok) return applied;
    totalMatchCount += applied.value.matchCount;
    if (applied.value.content !== file.content) {
      changes.push(replaceChange(path.value, file.content, applied.value.content, file.checksumBefore));
    }
  }

  const planned = buildPlan(base.value, request.validation?.required ?? true, changes);
  return planned.ok ? { ...planned, matchCount: totalMatchCount } : planned;
}

export function createEditPlanFromChanges(
  repo: RepoIdentity | undefined,
  changes: readonly RepoRelativeChange[],
  validation: { required?: boolean } = {},
  options: EditPlanBuildOptions = {}
): EditPlannerResult {
  const base = normalizePlannerBase(repo);
  if (!base.ok) return base;
  return buildPlan(base.value, validation.required ?? true, changes, options);
}

function buildPlan(
  repo: RepoIdentity,
  validationRequired: boolean,
  inputChanges: readonly RepoRelativeChange[],
  options: EditPlanBuildOptions = {}
): EditPlannerResult {
  const duplicate = firstDuplicateTouchedPath(inputChanges);
  if (duplicate) return refusal("conflict", `Conflicting operations touch ${duplicate}`, duplicate);

  const changes = [...inputChanges].sort(compareChanges);
  const afterState = mergeAfterState(afterStateFromChanges(changes), options.afterState);
  const missingRenameAfterState = firstMissingRenameAfterState(changes, afterState);
  if (missingRenameAfterState) {
    return refusal("unsafe_edit", `Rename after-state content is required for ${missingRenameAfterState}`, missingRenameAfterState);
  }
  const planHash = calculatePlanHash({
    repo,
    changes,
    validationRequired,
    planIdentity: options.planIdentity,
    validationRequest: options.validationRequest
  });
  const plan: EditPlan = {
    planId: createPlanId(planHash),
    repo,
    changes,
    atomic: {
      strategy: "all_or_nothing",
      planHash
    },
    validation: {
      required: validationRequired,
      request: createValidationRequestFromChanges(repo, changes, afterState, options.validationRequest)
    }
  };
  return {
    ok: true,
    plan,
    afterState
  };
}

function applyExactOperation(path: string, content: string, operation: EditTextOperation): EditOperationResult<string> {
  if (operation.replaceAll === true) {
    const matches = findLiteralMatches(content, operation.expectedText, path);
    if (!matches.ok) return matches;
    if (matches.value.length === 0) {
      return { ...refusal("unsafe_edit", `Expected text was not found in ${path}`, path), matchCount: 0 };
    }
    if (operation.expectedText === operation.replacementText) {
      return refusal("unsafe_edit", `Replacement for ${path} is unchanged`, path);
    }
    const edits: ResolvedTextEdit[] = matches.value.map((match) => ({
      path,
      start: match.start,
      end: match.end,
      before: operation.expectedText,
      after: operation.replacementText
    }));
    return applyResolvedTextEdits(content, edits);
  }

  const resolved = resolveExactTextEdit({
    path,
    content,
    expectedText: operation.expectedText,
    replacementText: operation.replacementText,
    occurrence: operation.occurrence
  });
  if (!resolved.ok) return resolved;
  return applyResolvedTextEdits(content, [resolved.value]);
}

function normalizePlannerBase(repo: RepoIdentity | undefined): { ok: true; value: RepoIdentity } | EditPlannerRefusal {
  const normalized = validateEditRepoIdentity(repo ?? defaultRepo);
  return normalized.ok ? { ok: true, value: normalized.value } : normalized;
}

function replaceChange(path: string, before: string, after: string, checksumBefore?: string): RepoRelativeChange {
  return {
    kind: "replace",
    path,
    content: after,
    checksumBefore: checksumBefore ?? calculateEditChecksum(before),
    checksumAfter: calculateEditChecksum(after)
  };
}

function afterStateFromChanges(changes: readonly RepoRelativeChange[]): EditPlanAfterState {
  const entries: [string, string | null][] = [];
  for (const change of changes) {
    if (change.kind === "create" || change.kind === "replace") entries.push([change.path, change.content]);
    else if (change.kind === "delete") entries.push([change.path, null]);
    else if (change.kind === "rename") entries.push([change.path, null]);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function mergeAfterState(
  baseAfterState: EditPlanAfterState,
  overrideAfterState: EditPlanAfterState | undefined
): EditPlanAfterState {
  const entries = new Map<string, string | null>(Object.entries(baseAfterState));
  for (const [path, content] of Object.entries(overrideAfterState ?? {})) entries.set(path, content);
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function firstMissingRenameAfterState(
  changes: readonly RepoRelativeChange[],
  afterState: EditPlanAfterState
): string | undefined {
  for (const change of changes) {
    if (change.kind === "rename" && typeof afterState[change.toPath] !== "string") return change.toPath;
  }
  return undefined;
}

function firstDuplicateTouchedPath(changes: readonly RepoRelativeChange[]): string | undefined {
  const touched = new Set<string>();
  for (const change of changes) {
    const paths = change.kind === "rename" ? [change.path, change.toPath] : [change.path];
    for (const path of paths) {
      if (touched.has(path)) return path;
      touched.add(path);
    }
  }
  return undefined;
}

function compareChanges(left: RepoRelativeChange, right: RepoRelativeChange): number {
  return changeKey(left).localeCompare(changeKey(right));
}

function changeKey(change: RepoRelativeChange): string {
  return change.kind === "rename" ? `${change.path}\0${change.toPath}\0${change.kind}` : `${change.path}\0${change.kind}`;
}

function refusal(category: EditRefusal["category"], message: string, path?: string): EditPlannerRefusal {
  return createEditPathRefusal(category, message, path);
}
