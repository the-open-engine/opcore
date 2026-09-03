import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIVE_PRE_COMMIT_HOOK_PATH,
  AGENT_FILE_CANDIDATES,
  AGENT_GATE_HOOK_PATH,
  AGENT_SKILL_PATHS,
  CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  CONFIG_PATH,
  GITIGNORE_PATH,
  GLOBAL_UNDO_PATH,
  HOOK_PATH,
  UNDO_PATH
} from "./init-constants.js";
import { isPlainObject } from "./init-data.js";
import { assertExistingRepoPath, repoPathExists } from "./init-paths.js";
import { parseUndoEntry } from "./init-undo-entry.js";
import type {
  InitScope,
  UndoMetadata
} from "./init-types.js";

const allowedRepoPaths = new Set<string>([
  CONFIG_PATH, UNDO_PATH, HOOK_PATH, AGENT_GATE_HOOK_PATH, ...AGENT_SKILL_PATHS,
  CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, ACTIVE_PRE_COMMIT_HOOK_PATH,
  GITIGNORE_PATH, ...AGENT_FILE_CANDIDATES
]);
const allowedGlobalPaths = new Set<string>([
  GLOBAL_UNDO_PATH, AGENT_GATE_HOOK_PATH, ...AGENT_SKILL_PATHS,
  CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH
]);

export function readUndoMetadata(root: string, scope: InitScope): UndoMetadata {
  const path = undoPathForScope(scope);
  const raw = readFileSync(assertExistingRepoPath(root, path, "Opcore init undo metadata", "file"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const envelope = validateUndoEnvelope(parsed, root, scope);
  const seenPaths = new Set<string>();
  const allowedPaths = scope === "global" ? allowedGlobalPaths : allowedRepoPaths;
  const entries = envelope.entries.map((value) =>
    parseUndoEntry({ value, allowedPaths, root, seenPaths })
  );
  return {
    schemaVersion: 1,
    kind: envelope.kind,
    ...(scope === "global" ? { homeRoot: envelope.recordedRoot } : { repoRoot: envelope.recordedRoot }),
    entries
  };
}

function validateUndoEnvelope(
  value: unknown,
  root: string,
  scope: InitScope
): { kind: UndoMetadata["kind"]; recordedRoot: string; entries: unknown[] } {
  const expectedKind = scope === "global" ? "opcore_global_init_undo" : "opcore_init_undo";
  if (!isPlainObject(value) ||
      value.schemaVersion !== 1 ||
      value.kind !== expectedKind ||
      !Array.isArray(value.entries)) {
    throw new Error(".opcore/init-undo.json is not valid Opcore init undo metadata");
  }
  const recordedRoot = scope === "global" ? value.homeRoot : value.repoRoot;
  if (typeof recordedRoot !== "string" || resolve(recordedRoot) !== resolve(root)) {
    throw new Error(".opcore/init-undo.json repoRoot does not match this repository");
  }
  return { kind: expectedKind, recordedRoot, entries: value.entries };
}

export function readUndoMetadataIfExists(root: string, scope: InitScope): UndoMetadata | undefined {
  return repoPathExists(root, undoPathForScope(scope)) ? readUndoMetadata(root, scope) : undefined;
}

export function undoPathForScope(_scope: InitScope): string {
  return UNDO_PATH;
}
