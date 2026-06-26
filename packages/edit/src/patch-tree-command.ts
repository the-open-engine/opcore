import type { EditRefusal, RepoIdentity, RepoRelativeChange } from "@the-open-engine/opcore-contracts";
import { calculateEditChecksum } from "./hash.js";
import { decodeTextContent, validateTextContentString } from "./content-policy.js";
import { isCodexApplyPatch, parseCodexApplyPatch } from "./codex-patch-parser.js";
import { planCodexPatchSections } from "./codex-patch-planner.js";
import { parseUnifiedDiffPatch, type ParsedPatchFile, type ParsedPatchHunk } from "./patch-parser.js";
import { validateCreatePatchTreePath, validateExistingPatchTreePath } from "./path-policy.js";
import { createEditPlanFromChanges, type EditPlannerResult } from "./planner.js";
import type { EditWorkspace } from "./workspace.js";

export interface PatchEditPlanRequest {
  repo?: RepoIdentity;
  validation?: {
    required?: boolean;
  };
  patch: string;
  threeWay?: boolean;
}

export async function createPatchEditPlan(workspace: EditWorkspace, request: PatchEditPlanRequest): Promise<EditPlannerResult> {
  if (request.threeWay === true) {
    return refusal(
      "unsupported_change",
      "Patch --3way is explicitly de-scoped in this release; dirty or stale hunks are refused instead of merged"
    );
  }
  if (isCodexApplyPatch(request.patch)) {
    const parsed = parseCodexApplyPatch(request.patch);
    if (!parsed.ok) return parsed;
    const planned = await planCodexPatchSections(workspace, parsed.sections);
    if (!planned.ok) return planned;
    return createEditPlanFromChanges(request.repo, planned.value, request.validation);
  }
  const parsed = parseUnifiedDiffPatch(request.patch);
  if (!parsed.ok) return parsed;
  const changes = await planUnifiedPatchFiles(workspace, parsed.files);
  if (!changes.ok) return changes;
  return createEditPlanFromChanges(request.repo, changes.value, request.validation);
}

async function planUnifiedPatchFiles(
  workspace: EditWorkspace,
  files: readonly ParsedPatchFile[]
): Promise<{ ok: true; value: RepoRelativeChange[] } | { ok: false; refusal: EditRefusal }> {
  const changes: RepoRelativeChange[] = [];
  for (const file of files) {
    const planned = await planPatchFile(workspace, file);
    if (!planned.ok) return planned;
    changes.push(...planned.value);
  }
  return { ok: true, value: changes };
}

async function planPatchFile(
  workspace: EditWorkspace,
  file: ParsedPatchFile
): Promise<{ ok: true; value: RepoRelativeChange[] } | { ok: false; refusal: EditRefusal }> {
  if (file.kind === "create") return planCreatePatchFile(workspace, file);
  if (file.kind === "delete") return planDeletePatchFile(workspace, file);
  return planModifyPatchFile(workspace, file);
}

async function planCreatePatchFile(
  workspace: EditWorkspace,
  file: ParsedPatchFile
): Promise<{ ok: true; value: RepoRelativeChange[] } | { ok: false; refusal: EditRefusal }> {
  if (!file.newPath) return refusal("unsupported_change", "Create patch is missing new path");
  const target = await validateCreatePatchTreePath(workspace, file.newPath, { mustNotExist: true });
  if (!target.ok) return target;
  const after = applyPatchHunks("", file.hunks, target.value.path);
  if (!after.ok) return after;
  const proposed = validateTextContentString(after.value, target.value.path, "patched content");
  if (!proposed.ok) return proposed;
  return {
    ok: true,
    value: [{ kind: "create", path: target.value.path, content: proposed.value.content, checksumAfter: calculateEditChecksum(proposed.value.content) }]
  };
}

async function planDeletePatchFile(
  workspace: EditWorkspace,
  file: ParsedPatchFile
): Promise<{ ok: true; value: RepoRelativeChange[] } | { ok: false; refusal: EditRefusal }> {
  if (!file.oldPath) return refusal("unsupported_change", "Delete patch is missing old path");
  const before = await readPatchTarget(workspace, file.oldPath);
  if (!before.ok) return before;
  const after = applyPatchHunks(before.value.content, file.hunks, before.value.path);
  if (!after.ok) return after;
  if (after.value.length !== 0) return refusal("conflict", `Delete patch for ${before.value.path} does not remove all content`, before.value.path);
  return { ok: true, value: [{ kind: "delete", path: before.value.path, checksumBefore: before.value.checksum }] };
}

async function planModifyPatchFile(
  workspace: EditWorkspace,
  file: ParsedPatchFile
): Promise<{ ok: true; value: RepoRelativeChange[] } | { ok: false; refusal: EditRefusal }> {
  if (!file.oldPath || !file.newPath) return refusal("unsupported_change", "Modify patch is missing file paths");
  const before = await readPatchTarget(workspace, file.oldPath);
  if (!before.ok) return before;
  const after = applyPatchHunks(before.value.content, file.hunks, before.value.path);
  if (!after.ok) return after;
  const proposed = validateTextContentString(after.value, file.newPath, "patched content");
  if (!proposed.ok) return proposed;
  if (file.oldPath === file.newPath) {
    if (before.value.content === proposed.value.content) return { ok: true, value: [] };
    return {
      ok: true,
      value: [replaceChange(before.value.path, proposed.value.content, before.value.checksum)]
    };
  }

  const target = await validateCreatePatchTreePath(workspace, file.newPath, { mustNotExist: true });
  if (!target.ok) return target;
  return {
    ok: true,
    value: [deleteChange(before.value.path, before.value.checksum), createChange(target.value.path, proposed.value.content)]
  };
}

function replaceChange(path: string, content: string, checksumBefore: string): RepoRelativeChange {
  return { kind: "replace", path, content, checksumBefore, checksumAfter: calculateEditChecksum(content) };
}

function createChange(path: string, content: string): RepoRelativeChange {
  return { kind: "create", path, content, checksumAfter: calculateEditChecksum(content) };
}

function deleteChange(path: string, checksumBefore: string): RepoRelativeChange {
  return { kind: "delete", path, checksumBefore };
}

function applyPatchHunks(
  content: string,
  hunks: readonly ParsedPatchHunk[],
  path: string
): { ok: true; value: string } | { ok: false; refusal: EditRefusal } {
  const beforeLines = splitContentLines(content);
  const afterLines: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const oldIndex = oldSideStartIndex(hunk);
    if (oldIndex < cursor || oldIndex > beforeLines.length) {
      return refusal("conflict", `Patch hunk at line ${hunk.lineNumber} is stale for ${path}`, path);
    }
    afterLines.push(...beforeLines.slice(cursor, oldIndex));
    let local = oldIndex;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        afterLines.push(line.content);
        continue;
      }
      const actual = beforeLines[local];
      if (actual !== line.content) {
        return refusal("conflict", `Patch context is stale for ${path} at hunk line ${line.lineNumber}`, path);
      }
      if (line.kind === "context") afterLines.push(actual);
      local += 1;
    }
    cursor = local;
  }

  afterLines.push(...beforeLines.slice(cursor));
  return { ok: true, value: afterLines.join("") };
}

function oldSideStartIndex(hunk: ParsedPatchHunk): number {
  if (hunk.oldLines !== 0) return hunk.oldStart - 1;
  return hunk.oldStart;
}

async function readPatchTarget(
  workspace: EditWorkspace,
  path: string
): Promise<{ ok: true; value: { path: string; content: string; checksum: string } } | { ok: false; refusal: EditRefusal }> {
  const target = await validateExistingPatchTreePath(workspace, path);
  if (!target.ok) return target;
  const decoded = decodeTextContent(await workspace.fileSystem.readFile(target.value.absolutePath), target.value.path, "existing patch target");
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    value: {
      path: target.value.path,
      content: decoded.value.content,
      checksum: decoded.value.checksum
    }
  };
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  while (start < content.length) {
    const lfIndex = content.indexOf("\n", start);
    if (lfIndex === -1) {
      lines.push(content.slice(start));
      break;
    }
    lines.push(content.slice(start, lfIndex + 1));
    start = lfIndex + 1;
  }
  return lines;
}

function refusal(category: EditRefusal["category"], message: string, path?: string): { ok: false; refusal: EditRefusal } {
  return {
    ok: false,
    refusal: {
      category,
      message,
      path
    }
  };
}
