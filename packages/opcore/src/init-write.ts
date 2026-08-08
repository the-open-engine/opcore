import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { appendManagedGitignoreLine, removeManagedGitignoreLine } from "./init-gitignore.js";
import { readOptionalRepoFile } from "./init-files.js";
import {
  assertExistingRepoPath,
  assertMutationPath,
  repoPathExists
} from "./init-paths.js";
import type {
  PlannedWrite,
  UndoEntry
} from "./init-types.js";

export function priorEntry(root: string, path: string, write: PlannedWrite | undefined): UndoEntry {
  if (write?.kind === "append_managed_line") {
    const existing = readOptionalRepoFile(root, path);
    return {
      kind: "append_managed_line", path, existed: existing !== undefined,
      line: write.line, appended: appendManagedGitignoreLine(existing)
    };
  }
  if (!repoPathExists(root, path)) return { kind: "restore_file", path, existed: false };
  return {
    kind: "restore_file",
    path,
    existed: true,
    content: readFileSync(assertExistingRepoPath(
      root, path, "Existing Opcore init target", "file"
    ), "utf8")
  };
}

export function writeScopedFile(root: string, write: PlannedWrite): void {
  const absolute = assertMutationPath(root, write.path, "Opcore init write target");
  mkdirSync(dirname(absolute), { recursive: true });
  if (write.kind === "append_managed_line") {
    appendFileSync(absolute, appendManagedGitignoreLine(readOptionalRepoFile(root, write.path)));
    return;
  }
  writeFileSync(absolute, write.content, "utf8");
  if (write.executable) {
    assertMutationPath(root, write.path, "Opcore init chmod target");
    chmodSync(absolute, 0o755);
  }
}

export function restoreUndoEntry(root: string, entry: UndoEntry): void {
  const absolute = assertMutationPath(root, entry.path, "Opcore init undo target");
  if (entry.kind === "append_managed_line") {
    restoreManagedLine(root, absolute, entry);
    return;
  }
  if (!entry.existed) {
    rmSync(absolute, { force: true });
    return;
  }
  if (entry.content === undefined) throw new Error(`Undo entry for ${entry.path} is missing content`);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, entry.content, "utf8");
}

function restoreManagedLine(
  root: string,
  absolute: string,
  entry: Extract<UndoEntry, { kind: "append_managed_line" }>
): void {
  if (!repoPathExists(root, entry.path)) return;
  const removal = removeManagedGitignoreLine(readFileSync(absolute, "utf8"), entry);
  if (!removal.removed) return;
  if (!entry.existed && removal.content.length === 0) {
    rmSync(absolute, { force: true });
    return;
  }
  writeFileSync(absolute, removal.content, "utf8");
}
