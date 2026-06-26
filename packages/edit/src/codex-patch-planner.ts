import type { EditRefusal, RepoRelativeChange } from "@the-open-engine/lattice-contracts";
import { decodeTextContent, validateTextContentString } from "./content-policy.js";
import { calculateEditChecksum } from "./hash.js";
import type { ParsedCodexPatchHunk, ParsedCodexPatchSection } from "./codex-patch-parser.js";
import {
  normalizePatchTreeRepoRelativePath,
  validateCreatePatchTreePath,
  validateExistingPatchTreePath
} from "./path-policy.js";
import type { EditWorkspace } from "./workspace.js";

interface CodexWorkingFile {
  path: string;
  initialExists: boolean;
  initialContent?: string;
  initialChecksum?: string;
  currentExists: boolean;
  currentContent?: string;
  createdByAdd?: boolean;
}

type CodexPlanResult = { ok: true; value: RepoRelativeChange[] } | { ok: false; refusal: EditRefusal };
type CodexStepResult<T = true> = { ok: true; value: T } | { ok: false; refusal: EditRefusal };

export async function planCodexPatchSections(
  workspace: EditWorkspace,
  sections: readonly ParsedCodexPatchSection[]
): Promise<CodexPlanResult> {
  const files = new Map<string, CodexWorkingFile>();
  for (const section of sections) {
    const applied = await applyCodexSection(workspace, files, section);
    if (!applied.ok) return applied;
  }
  return { ok: true, value: emitCodexChanges(files) };
}

async function applyCodexSection(
  workspace: EditWorkspace,
  files: Map<string, CodexWorkingFile>,
  section: ParsedCodexPatchSection
): Promise<CodexStepResult> {
  if (section.kind === "add") return applyCodexAddSection(workspace, files, section);
  if (section.kind === "delete") return applyCodexDeleteSection(workspace, files, section);
  return applyCodexUpdateSection(workspace, files, section);
}

function emitCodexChanges(files: Map<string, CodexWorkingFile>): RepoRelativeChange[] {
  const changes: RepoRelativeChange[] = [];
  const ordered = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  for (const file of ordered) {
    const change = codexChangeFromFile(file);
    if (change) changes.push(change);
  }
  return changes;
}

function codexChangeFromFile(file: CodexWorkingFile): RepoRelativeChange | undefined {
  if (!file.initialExists && file.currentExists) return createCodexCreateChange(file);
  if (!file.initialExists || !file.currentExists) return file.initialExists ? createCodexDeleteChange(file) : undefined;
  if (file.currentContent === file.initialContent) return undefined;
  return createCodexReplaceChange(file);
}

function createCodexCreateChange(file: CodexWorkingFile): RepoRelativeChange {
  const content = requiredCurrentContent(file);
  return { kind: "create", path: file.path, content, checksumAfter: calculateEditChecksum(content) };
}

function createCodexDeleteChange(file: CodexWorkingFile): RepoRelativeChange {
  return { kind: "delete", path: file.path, checksumBefore: requiredChecksum(file) };
}

function createCodexReplaceChange(file: CodexWorkingFile): RepoRelativeChange {
  const content = requiredCurrentContent(file);
  return {
    kind: "replace",
    path: file.path,
    content,
    checksumBefore: requiredChecksum(file),
    checksumAfter: calculateEditChecksum(content)
  };
}

async function applyCodexAddSection(
  workspace: EditWorkspace,
  files: Map<string, CodexWorkingFile>,
  section: ParsedCodexPatchSection
): Promise<CodexStepResult> {
  const target = await validateCreatePatchTreePath(workspace, section.path, { mustNotExist: true });
  if (!target.ok) return target;
  if (files.has(target.value.path)) {
    return refusal("conflict", `Codex add conflicts with prior patch section for ${target.value.path}`, target.value.path);
  }
  const proposed = validateTextContentString(section.content ?? "", target.value.path, "Codex add content");
  if (!proposed.ok) return proposed;
  files.set(target.value.path, {
    path: target.value.path,
    initialExists: false,
    currentExists: true,
    currentContent: proposed.value.content,
    createdByAdd: true
  });
  return { ok: true, value: true };
}

async function applyCodexDeleteSection(
  workspace: EditWorkspace,
  files: Map<string, CodexWorkingFile>,
  section: ParsedCodexPatchSection
): Promise<CodexStepResult> {
  const file = await existingCodexFile(workspace, files, section.path);
  if (!file.ok) return file;
  if (file.value.createdByAdd) return refusal("conflict", `Codex delete conflicts with prior add for ${file.value.path}`, file.value.path);
  if (!file.value.currentExists) return refusal("conflict", `Codex delete target is already removed: ${file.value.path}`, file.value.path);
  file.value.currentExists = false;
  file.value.currentContent = undefined;
  return { ok: true, value: true };
}

async function applyCodexUpdateSection(
  workspace: EditWorkspace,
  files: Map<string, CodexWorkingFile>,
  section: ParsedCodexPatchSection
): Promise<CodexStepResult> {
  const file = await existingCodexFile(workspace, files, section.path);
  if (!file.ok) return file;
  if (!file.value.currentExists) return refusal("conflict", `Codex update target is deleted: ${file.value.path}`, file.value.path);
  const patched = applyCodexHunks(requiredCurrentContent(file.value), section.hunks, file.value.path);
  if (!patched.ok) return patched;
  if (section.moveTo !== undefined) return applyCodexMove({ workspace, files, file: file.value, section, content: patched.value });
  return applyCodexReplace(file.value, patched.value);
}

function applyCodexReplace(file: CodexWorkingFile, content: string): CodexStepResult {
  const proposed = validateTextContentString(content, file.path, "Codex updated content");
  if (!proposed.ok) return proposed;
  file.currentContent = proposed.value.content;
  return { ok: true, value: true };
}

async function applyCodexMove(context: {
  workspace: EditWorkspace;
  files: Map<string, CodexWorkingFile>;
  file: CodexWorkingFile;
  section: ParsedCodexPatchSection;
  content: string;
}): Promise<CodexStepResult> {
  if (!context.file.initialExists || context.file.createdByAdd) {
    return refusal("conflict", `Codex move target is not an existing tracked file: ${context.file.path}`, context.file.path);
  }
  const target = await validateCreatePatchTreePath(context.workspace, requiredMoveTarget(context.section), { mustNotExist: true });
  if (!target.ok) return target;
  if (context.files.has(target.value.path)) {
    return refusal("conflict", `Codex move target conflicts with prior patch section for ${target.value.path}`, target.value.path);
  }
  const proposed = validateTextContentString(context.content, target.value.path, "Codex moved content");
  if (!proposed.ok) return proposed;
  context.file.currentExists = false;
  context.file.currentContent = undefined;
  context.files.set(target.value.path, {
    path: target.value.path,
    initialExists: false,
    currentExists: true,
    currentContent: proposed.value.content
  });
  return { ok: true, value: true };
}

async function existingCodexFile(
  workspace: EditWorkspace,
  files: Map<string, CodexWorkingFile>,
  path: string
): Promise<CodexStepResult<CodexWorkingFile>> {
  const normalized = await normalizePatchTreeRepoRelativePath(workspace, path);
  if (!normalized.ok) return normalized;
  const existing = files.get(normalized.value);
  if (existing) return { ok: true, value: existing };
  const before = await readPatchTarget(workspace, normalized.value);
  if (!before.ok) return before;
  const file = createLoadedCodexFile(before.value.path, before.value.content, before.value.checksum);
  files.set(file.path, file);
  return { ok: true, value: file };
}

function createLoadedCodexFile(path: string, content: string, checksum: string): CodexWorkingFile {
  return {
    path,
    initialExists: true,
    initialContent: content,
    initialChecksum: checksum,
    currentExists: true,
    currentContent: content
  };
}

function applyCodexHunks(
  content: string,
  hunks: readonly ParsedCodexPatchHunk[],
  path: string
): { ok: true; value: string } | { ok: false; refusal: EditRefusal } {
  const beforeLines = splitContentLines(content);
  const afterLines: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const applied = applyCodexHunk(beforeLines, cursor, hunk, path);
    if (!applied.ok) return applied;
    afterLines.push(...beforeLines.slice(cursor, applied.matchIndex), ...applied.newSide);
    cursor = applied.nextCursor;
  }
  afterLines.push(...beforeLines.slice(cursor));
  return { ok: true, value: afterLines.join("") };
}

function applyCodexHunk(
  beforeLines: readonly string[],
  cursor: number,
  hunk: ParsedCodexPatchHunk,
  path: string
): { ok: true; matchIndex: number; nextCursor: number; newSide: readonly string[] } | { ok: false; refusal: EditRefusal } {
  const oldSide = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.content);
  const newSide = hunk.lines.filter((line) => line.kind !== "delete").map((line) => line.content);
  const matchIndex = findLineSequence(beforeLines, oldSide, cursor, hunk.endOfFile === true);
  if (matchIndex === -1) return refusal("conflict", `Codex patch context is stale for ${path} at hunk line ${hunk.lineNumber}`, path);
  return { ok: true, matchIndex, nextCursor: matchIndex + oldSide.length, newSide };
}

function findLineSequence(lines: readonly string[], sequence: readonly string[], startIndex: number, mustEndAtFileEnd: boolean): number {
  if (sequence.length === 0) return mustEndAtFileEnd ? lines.length : startIndex;
  for (let index = startIndex; index <= lines.length - sequence.length; index += 1) {
    if ((!mustEndAtFileEnd || index + sequence.length === lines.length) && lineSequenceMatches(lines, sequence, index)) return index;
  }
  return -1;
}

function lineSequenceMatches(lines: readonly string[], sequence: readonly string[], startIndex: number): boolean {
  for (let offset = 0; offset < sequence.length; offset += 1) {
    if (lines[startIndex + offset] !== sequence[offset]) return false;
  }
  return true;
}

async function readPatchTarget(
  workspace: EditWorkspace,
  path: string
): Promise<CodexStepResult<{ path: string; content: string; checksum: string }>> {
  const target = await validateExistingPatchTreePath(workspace, path);
  if (!target.ok) return target;
  const decoded = decodeTextContent(await workspace.fileSystem.readFile(target.value.absolutePath), target.value.path, "existing patch target");
  if (!decoded.ok) return decoded;
  return { ok: true, value: { path: target.value.path, content: decoded.value.content, checksum: decoded.value.checksum } };
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

function requiredMoveTarget(section: ParsedCodexPatchSection): string {
  if (section.moveTo === undefined) throw new Error(`Missing Codex move target for ${section.path}`);
  return section.moveTo;
}

function requiredChecksum(file: CodexWorkingFile): string {
  if (file.initialChecksum === undefined) throw new Error(`Missing initial checksum for ${file.path}`);
  return file.initialChecksum;
}

function requiredCurrentContent(file: CodexWorkingFile): string {
  if (file.currentContent === undefined) throw new Error(`Missing current content for ${file.path}`);
  return file.currentContent;
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
