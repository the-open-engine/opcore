import type { EditRefusal } from "@the-open-engine/lattice-contracts";
import { calculateEditChecksum } from "./hash.js";

export interface EditOperationSuccess<T> {
  ok: true;
  value: T;
}

export interface EditOperationRefusal {
  ok: false;
  refusal: EditRefusal;
  matchCount?: number;
}

export type EditOperationResult<T> = EditOperationSuccess<T> | EditOperationRefusal;

export interface LiteralMatch {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface EditTextOperation {
  expectedText: string;
  replacementText: string;
  occurrence?: number;
  checksumBefore?: string;
  replaceAll?: boolean;
}

export interface SearchReplaceOperation {
  search: string;
  replace: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  multiline?: boolean;
  dotAll?: boolean;
  replaceAll?: boolean;
}

export interface ResolveExactTextEditRequest extends EditTextOperation {
  path: string;
  content: string;
}

export interface ResolvedTextEdit {
  path: string;
  start: number;
  end: number;
  before: string;
  after: string;
}

export interface SearchReplaceApplyResult {
  content: string;
  matchCount: number;
}

export function findLiteralMatches(content: string, search: string, path?: string): EditOperationResult<readonly LiteralMatch[]> {
  if (typeof content !== "string" || typeof search !== "string") {
    throw new Error("Literal match content and search must be strings");
  }
  if (search.length === 0) {
    return refused("unsupported_change", "Literal search text must be non-empty", path);
  }

  const matches: LiteralMatch[] = [];
  let offset = 0;
  while (offset <= content.length) {
    const found = content.indexOf(search, offset);
    if (found === -1) break;
    matches.push({
      index: matches.length,
      start: found,
      end: found + search.length,
      text: search
    });
    offset = found + search.length;
  }

  return { ok: true, value: matches };
}

export function resolveExactTextEdit(request: ResolveExactTextEditRequest): EditOperationResult<ResolvedTextEdit> {
  const checksumBefore = calculateEditChecksum(request.content);
  if (request.checksumBefore !== undefined && request.checksumBefore !== checksumBefore) {
    return refused(
      "conflict",
      `Stale checksumBefore for ${request.path}: expected ${request.checksumBefore} but found ${checksumBefore}`,
      request.path
    );
  }

  const matches = findLiteralMatches(request.content, request.expectedText, request.path);
  if (!matches.ok) return matches;
  if (matches.value.length === 0) {
    return { ...refused("unsafe_edit", `Expected text was not found in ${request.path}`, request.path), matchCount: 0 };
  }

  const occurrence = request.occurrence;
  if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 0) {
      return refused("unsafe_edit", `Occurrence index must be a non-negative integer for ${request.path}`, request.path);
    }
    const match = matches.value[occurrence];
    if (!match) {
      return {
        ...refused(
          "unsafe_edit",
          `Occurrence ${occurrence} was requested but ${matches.value.length} matches exist in ${request.path}`,
          request.path
        ),
        matchCount: matches.value.length
      };
    }
    return resolvedExactMatch(request, match);
  }

  if (matches.value.length !== 1) {
    return {
      ...refused(
        "unsafe_edit",
        `Expected text matched ${matches.value.length} times in ${request.path}; pass occurrence for deterministic exact edits`,
        request.path
      ),
      matchCount: matches.value.length
    };
  }

  return resolvedExactMatch(request, matches.value[0]);
}

export function applyResolvedTextEdits(
  content: string,
  edits: readonly ResolvedTextEdit[]
): EditOperationResult<string> {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 0; index < ordered.length; index += 1) {
    const edit = ordered[index];
    if (content.slice(edit.start, edit.end) !== edit.before) {
      return refused("conflict", `Resolved edit range no longer matches original content in ${edit.path}`, edit.path);
    }
    const previous = ordered[index - 1];
    if (previous && edit.start < previous.end) {
      return refused("conflict", `Conflicting edits overlap in ${edit.path}`, edit.path);
    }
  }

  let output = content;
  for (const edit of [...ordered].reverse()) {
    output = `${output.slice(0, edit.start)}${edit.after}${output.slice(edit.end)}`;
  }
  return { ok: true, value: output };
}

export function applySearchReplaceOperations(
  content: string,
  operations: readonly SearchReplaceOperation[],
  path?: string
): EditOperationResult<SearchReplaceApplyResult> {
  let output = content;
  let totalMatchCount = 0;
  for (const operation of operations) {
    const compiled = compileSearchReplaceOperation(operation, path);
    if (!compiled.ok) return compiled;

    const matchCount = countRegexMatches(output, compiled.value.countRegex);
    if (matchCount > 1 && operation.replaceAll !== true) {
      return { ...refused("unsafe_edit", `Search-replace matched ${matchCount} times in ${path ?? "content"}; set replaceAll=true or narrow the search`, path), matchCount };
    }
    if (matchCount === 0) continue;

    output = operation.regex === true
      ? output.replace(compiled.value.replaceRegex, operation.replace)
      : output.replace(compiled.value.replaceRegex, () => operation.replace);
    totalMatchCount += matchCount;
  }
  return { ok: true, value: { content: output, matchCount: totalMatchCount } };
}

function resolvedExactMatch(
  request: ResolveExactTextEditRequest,
  match: LiteralMatch
): EditOperationResult<ResolvedTextEdit> {
  if (request.expectedText === request.replacementText) {
    return refused("unsafe_edit", `Replacement for ${request.path} is unchanged`, request.path);
  }
  const nextContent = `${request.content.slice(0, match.start)}${request.replacementText}${request.content.slice(match.end)}`;
  if (nextContent === request.content) {
    return refused("unsafe_edit", `Replacement for ${request.path} leaves content unchanged`, request.path);
  }
  return {
    ok: true,
    value: {
      path: request.path,
      start: match.start,
      end: match.end,
      before: request.expectedText,
      after: request.replacementText
    }
  };
}

function compileSearchReplaceOperation(
  operation: SearchReplaceOperation,
  path?: string
): EditOperationResult<{ countRegex: RegExp; replaceRegex: RegExp }> {
  if (typeof operation.search !== "string" || operation.search.length === 0) {
    return refused("unsupported_change", "Search-replace pattern must be non-empty", path);
  }
  if (typeof operation.replace !== "string") {
    return refused("unsupported_change", "Search-replace replacement must be a string", path);
  }

  const source = operation.regex === true ? operation.search : escapeRegExp(operation.search);
  const flags = `${operation.caseInsensitive === true ? "i" : ""}m${operation.multiline === true || operation.dotAll === true ? "s" : ""}`;
  try {
    return {
      ok: true,
      value: {
        countRegex: new RegExp(source, uniqueFlags(`${flags}g`)),
        replaceRegex: new RegExp(source, uniqueFlags(`${flags}${operation.replaceAll === true ? "g" : ""}`))
      }
    };
  } catch (error) {
    return refused("unsafe_edit", `Invalid search-replace regex for ${path ?? "content"}: ${errorMessage(error)}`, path);
  }
}

function countRegexMatches(content: string, regex: RegExp): number {
  let count = 0;
  for (const _match of content.matchAll(regex)) count += 1;
  return count;
}

function uniqueFlags(flags: string): string {
  return [...new Set(flags.split(""))].join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refused(category: EditRefusal["category"], message: string, path?: string): EditOperationRefusal {
  return {
    ok: false,
    refusal: {
      category,
      message,
      path
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
