import { rmSync } from "node:fs";
import { removeEmptyOpcoreHookDir } from "./init-files.js";
import {
  assertMutationPath,
  resolveRepoPath
} from "./init-paths.js";
import {
  readUndoMetadata,
  readUndoMetadataIfExists,
  undoPathForScope
} from "./init-undo-metadata.js";
import {
  priorEntry,
  restoreUndoEntry,
  writeScopedFile
} from "./init-write.js";
import type {
  InitScope,
  PlannedWrite,
  UndoMetadata
} from "./init-types.js";

export function applyInit(root: string, scope: InitScope, writes: readonly PlannedWrite[]): void {
  const scopedWrites = writes.filter((write) => write.targetScope === scope);
  const previous = readUndoMetadataIfExists(root, scope);
  const previousPaths = previous === undefined
    ? []
    : previous.entries.map((entry) => entry.path);
  const touchedPaths = uniqueStrings([
    ...previousPaths,
    ...scopedWrites.map((write) => write.path),
    undoPathForScope(scope)
  ]);
  for (const path of touchedPaths) assertMutationPath(root, path, `Opcore ${scope} init target`);
  const metadata: UndoMetadata = {
    schemaVersion: 1,
    kind: scope === "global" ? "opcore_global_init_undo" : "opcore_init_undo",
    ...(scope === "global" ? { homeRoot: root } : { repoRoot: root }),
    entries: touchedPaths.map((path) => {
      const previousEntry = previous?.entries.find((entry) => entry.path === path);
      return previousEntry ??
        priorEntry(root, path, scopedWrites.find((write) => write.path === path));
    })
  };
  for (const write of scopedWrites) writeScopedFile(root, write);
  writeScopedFile(root, {
    kind: "write", path: undoPathForScope(scope), targetScope: scope,
    content: `${JSON.stringify(metadata, null, 2)}\n`
  });
}

export function applyUndo(root: string, scope: InitScope): void {
  const metadata = readUndoMetadata(root, scope);
  const undoPath = undoPathForScope(scope);
  for (const entry of metadata.entries) {
    assertMutationPath(root, entry.path, "Opcore init undo target");
  }
  for (const entry of metadata.entries.filter((entry) => entry.path !== undoPath)) {
    restoreUndoEntry(root, entry);
  }
  const undoEntry = metadata.entries.find((entry) => entry.path === undoPath);
  if (undoEntry) restoreUndoEntry(root, undoEntry);
  else rmSync(resolveRepoPath(root, undoPath), { force: true });
  removeEmptyOpcoreHookDir(root);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
