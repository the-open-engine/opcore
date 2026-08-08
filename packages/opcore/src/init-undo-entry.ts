import {
  GITIGNORE_PATH,
  OPCORE_IGNORE_LINE
} from "./init-constants.js";
import { isPlainObject } from "./init-data.js";
import { resolveRepoPath } from "./init-paths.js";
import type {
  ManagedLineUndoEntry,
  UndoEntry
} from "./init-types.js";

export interface UndoEntryParseInput {
  value: unknown;
  allowedPaths: ReadonlySet<string>;
  root: string;
  seenPaths: Set<string>;
}

export function parseUndoEntry(input: UndoEntryParseInput): UndoEntry {
  const entry = input.value;
  if (!isPlainObject(entry) || typeof entry.path !== "string" || typeof entry.existed !== "boolean") {
    throw new Error(".opcore/init-undo.json contains an invalid entry");
  }
  validateEntryPath(entry.path, input);
  const kind = typeof entry.kind === "string" ? entry.kind : "restore_file";
  if (kind === "append_managed_line") return parseManagedLineEntry(entry, input.root);
  return parseFileEntry(entry, kind, input.root);
}

function validateEntryPath(path: string, input: UndoEntryParseInput): void {
  if (!input.allowedPaths.has(path)) {
    throw new Error(`.opcore/init-undo.json contains unsupported path: ${path}`);
  }
  if (input.seenPaths.has(path)) {
    throw new Error(`.opcore/init-undo.json contains duplicate path: ${path}`);
  }
  input.seenPaths.add(path);
}

function parseManagedLineEntry(
  entry: Record<string, unknown>,
  root: string
): ManagedLineUndoEntry {
  const path = entry.path as string;
  if (path !== GITIGNORE_PATH) {
    throw new Error(`.opcore/init-undo.json append-managed-line entry targets unsupported path: ${path}`);
  }
  if (entry.line !== OPCORE_IGNORE_LINE) {
    throw new Error(`.opcore/init-undo.json append-managed-line entry for ${path} has invalid line`);
  }
  validateAppendedText(entry, path);
  resolveRepoPath(root, path);
  return {
    kind: "append_managed_line",
    path,
    existed: entry.existed as boolean,
    line: OPCORE_IGNORE_LINE,
    ...(typeof entry.appended === "string" ? { appended: entry.appended } : {})
  };
}

function validateAppendedText(entry: Record<string, unknown>, path: string): void {
  if (!("appended" in entry) || entry.appended === undefined) return;
  if (entry.appended === `${OPCORE_IGNORE_LINE}\n`) return;
  if (entry.appended === `\n${OPCORE_IGNORE_LINE}\n`) return;
  throw new Error(`.opcore/init-undo.json append-managed-line entry for ${path} has invalid appended text`);
}

function parseFileEntry(
  entry: Record<string, unknown>,
  kind: string,
  root: string
): UndoEntry {
  const path = entry.path as string;
  if (path === GITIGNORE_PATH) {
    throw new Error(".opcore/init-undo.json .gitignore entry must use managed-line undo metadata");
  }
  if (kind !== "restore_file") {
    throw new Error(`.opcore/init-undo.json contains unsupported entry kind: ${kind}`);
  }
  validateFileContent(entry, path);
  resolveRepoPath(root, path);
  return {
    kind: "restore_file",
    path,
    existed: entry.existed as boolean,
    ...(typeof entry.content === "string" ? { content: entry.content } : {})
  };
}

function validateFileContent(entry: Record<string, unknown>, path: string): void {
  if (entry.existed && typeof entry.content !== "string") {
    throw new Error(`.opcore/init-undo.json restore entry for ${path} is missing string content`);
  }
  if (!entry.existed && "content" in entry && entry.content !== undefined && typeof entry.content !== "string") {
    throw new Error(`.opcore/init-undo.json remove entry for ${path} has invalid content`);
  }
}
