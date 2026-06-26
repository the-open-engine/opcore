import type { EditRefusal } from "@the-open-engine/lattice-contracts";

export type ParsedPatchFileKind = "create" | "delete" | "modify";
export type ParsedPatchLineKind = "context" | "add" | "delete";

export interface ParsedPatchLine {
  kind: ParsedPatchLineKind;
  content: string;
  noNewlineAtEnd: boolean;
  lineNumber: number;
}

export interface ParsedPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: readonly ParsedPatchLine[];
  lineNumber: number;
}

export interface ParsedPatchFile {
  kind: ParsedPatchFileKind;
  oldPath?: string;
  newPath?: string;
  hunks: readonly ParsedPatchHunk[];
}

export type PatchParseResult = { ok: true; files: readonly ParsedPatchFile[] } | { ok: false; refusal: EditRefusal };

interface PhysicalLine {
  text: string;
  eol: string;
  lineNumber: number;
}

interface PatchMetadata {
  modeChange: boolean;
  renameMetadata: boolean;
}

const emptyMetadata = (): PatchMetadata => ({ modeChange: false, renameMetadata: false });

export function parseUnifiedDiffPatch(patch: string): PatchParseResult {
  if (typeof patch !== "string" || patch.length === 0) {
    return refusal("unsupported_change", "Patch input must be a non-empty unified diff");
  }
  const lines = splitPhysicalLines(patch);
  const files: ParsedPatchFile[] = [];
  let index = 0;
  let pending = emptyMetadata();
  let pendingDiffLineNumber: number | undefined;

  while (index < lines.length) {
    const text = lineText(lines[index], index);

    if (text.startsWith("diff --git ")) {
      const unfinished = rejectUnfinishedDiffBlock(pending, pendingDiffLineNumber);
      if (!unfinished.ok) return unfinished;
      pending = emptyMetadata();
      pendingDiffLineNumber = lines[index].lineNumber;
      index += 1;
      continue;
    }

    if (!text.startsWith("--- ")) {
      const metadata = updateMetadataOrRefuse(text, pending);
      if (!metadata.ok) return metadata;
      if (!metadata.recognized || pendingDiffLineNumber === undefined) {
        return refusal("unsupported_change", `Unexpected patch line at line ${lines[index].lineNumber} before file header`);
      }
      index += 1;
      continue;
    }

    const oldPath = parsePatchPath(text.slice(4));
    if (!oldPath.ok) return oldPath;
    const next = lines[index + 1];
    if (!next) return refusal("unsupported_change", `Patch file header at line ${lines[index].lineNumber} is missing +++ header`);
    const nextText = lineText(next, index + 1);
    if (!nextText.startsWith("+++ ")) {
      return refusal("unsupported_change", `Patch file header at line ${lines[index].lineNumber} is missing +++ header`);
    }
    const newPath = parsePatchPath(nextText.slice(4));
    if (!newPath.ok) return newPath;
    index += 2;

    const metadata = pending;
    pending = emptyMetadata();
    pendingDiffLineNumber = undefined;
    const hunks: ParsedPatchHunk[] = [];
    while (index < lines.length) {
      const currentText = lineText(lines[index], index);
      if (currentText.startsWith("diff --git ") || currentText.startsWith("--- ")) break;
      const hunkUnsupported = updateMetadataOrRefuse(currentText, metadata);
      if (!hunkUnsupported.ok) return hunkUnsupported;
      if (currentText.startsWith("@@ ")) {
        const parsed = parseHunk(lines, index);
        if (!parsed.ok) return parsed;
        hunks.push(parsed.hunk);
        index = parsed.nextIndex;
        continue;
      }
      return refusal(
        "unsupported_change",
        `Unexpected patch line at line ${lines[index].lineNumber} in ${pathLabel(oldPath.value, newPath.value)}`
      );
    }

    if (hunks.length === 0) {
      if (metadata.modeChange) return refusal("unsupported_change", "Mode-only patches are not supported");
      if (metadata.renameMetadata) return refusal("unsupported_change", "Rename-only patches without text hunks are not supported");
      return refusal("unsupported_change", `Patch for ${pathLabel(oldPath.value, newPath.value)} has no text hunks`);
    }
    const ordered = validateHunkOrdering(hunks, pathLabel(oldPath.value, newPath.value));
    if (!ordered.ok) return ordered;
    const file = patchFileFromHeaders(oldPath.value, newPath.value, hunks);
    if (!file.ok) return file;
    files.push(file.value);
  }

  const unfinished = rejectUnfinishedDiffBlock(pending, pendingDiffLineNumber);
  if (!unfinished.ok) return unfinished;
  if (files.length === 0) {
    if (pending.modeChange) return refusal("unsupported_change", "Mode-only patches are not supported");
    if (pending.renameMetadata) return refusal("unsupported_change", "Rename-only patches without text hunks are not supported");
    return refusal("unsupported_change", "Patch input did not contain unified diff file hunks");
  }
  return { ok: true, files };
}

function parseHunk(
  lines: readonly PhysicalLine[],
  startIndex: number
): { ok: true; hunk: ParsedPatchHunk; nextIndex: number } | { ok: false; refusal: EditRefusal } {
  const header = lineText(lines[startIndex], startIndex);
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return refusal("unsupported_change", `Malformed patch hunk header at line ${lines[startIndex].lineNumber}`);
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  if (!validRange(oldStart, oldLines) || !validRange(newStart, newLines)) {
    return refusal("unsupported_change", `Malformed patch hunk range at line ${lines[startIndex].lineNumber}`);
  }

  const hunkLines: ParsedPatchLine[] = [];
  let index = startIndex + 1;
  while (index < lines.length) {
    const physical = lines[index];
    const text = lineText(physical, index);
    const counts = countHunkLines(hunkLines);
    const expectedCountsSatisfied = counts.oldCount === oldLines && counts.newCount === newLines;
    if (
      text.startsWith("diff --git ") ||
      text.startsWith("@@ ") ||
      (expectedCountsSatisfied && text.startsWith("--- "))
    ) {
      break;
    }
    if (text === "\\ No newline at end of file") {
      const previous = hunkLines[hunkLines.length - 1];
      if (!previous || previous.noNewlineAtEnd) {
        return refusal("unsupported_change", `Misplaced no-newline marker at line ${physical.lineNumber}`);
      }
      hunkLines[hunkLines.length - 1] = {
        ...previous,
        content: removeLineEnding(previous.content),
        noNewlineAtEnd: true
      };
      index += 1;
      continue;
    }
    const marker = text[0];
    if (marker !== " " && marker !== "+" && marker !== "-") break;
    hunkLines.push({
      kind: marker === " " ? "context" : marker === "+" ? "add" : "delete",
      content: text.slice(1) + physical.eol,
      noNewlineAtEnd: false,
      lineNumber: physical.lineNumber
    });
    index += 1;
  }

  const oldCount = hunkLines.filter((line) => line.kind !== "add").length;
  const newCount = hunkLines.filter((line) => line.kind !== "delete").length;
  if (oldCount !== oldLines || newCount !== newLines) {
    return refusal(
      "unsupported_change",
      `Patch hunk at line ${lines[startIndex].lineNumber} has ${oldCount}/${newCount} old/new lines, expected ${oldLines}/${newLines}`
    );
  }
  return {
    ok: true,
    hunk: {
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: hunkLines,
      lineNumber: lines[startIndex].lineNumber
    },
    nextIndex: index
  };
}

function countHunkLines(lines: readonly ParsedPatchLine[]): { oldCount: number; newCount: number } {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.kind !== "add") oldCount += 1;
    if (line.kind !== "delete") newCount += 1;
  }
  return { oldCount, newCount };
}

function updateMetadataOrRefuse(
  text: string,
  metadata: PatchMetadata
): { ok: true; recognized: boolean } | { ok: false; refusal: EditRefusal } {
  if (/^Binary files /.test(text) || text === "GIT binary patch" || /^literal \d+/.test(text) || /^delta \d+/.test(text)) {
    return refusal("unsupported_change", "Binary patches are not supported");
  }
  if (/^(?:index .*\b160000\b|new file mode 160000|deleted file mode 160000)/.test(text)) {
    return refusal("unsupported_change", "Submodule/gitlink patches are not supported");
  }
  if (/^(?:old mode|new mode) /.test(text)) return refusal("unsupported_change", "Chmod patches are not supported");
  if (/^(?:rename from|rename to|similarity index) /.test(text)) {
    metadata.renameMetadata = true;
    return { ok: true, recognized: true };
  }
  if (/^(?:index|new file mode|deleted file mode) /.test(text)) return { ok: true, recognized: true };
  return { ok: true, recognized: false };
}

function rejectUnfinishedDiffBlock(
  metadata: PatchMetadata,
  lineNumber: number | undefined
): { ok: true } | { ok: false; refusal: EditRefusal } {
  if (lineNumber === undefined) return { ok: true };
  if (metadata.modeChange) return refusal("unsupported_change", "Mode-only patches are not supported");
  if (metadata.renameMetadata) return refusal("unsupported_change", "Rename-only patches without text hunks are not supported");
  return refusal("unsupported_change", `Patch diff at line ${lineNumber} has no text hunks`);
}

function validateHunkOrdering(hunks: readonly ParsedPatchHunk[], path: string): { ok: true } | { ok: false; refusal: EditRefusal } {
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  for (const hunk of hunks) {
    if (hunk.oldStart < previousOldEnd || hunk.newStart < previousNewEnd) {
      return refusal("unsupported_change", `Patch hunks are out of order or overlapping for ${path}`);
    }
    previousOldEnd = hunk.oldStart + hunk.oldLines;
    previousNewEnd = hunk.newStart + hunk.newLines;
  }
  return { ok: true };
}

function patchFileFromHeaders(
  oldPath: string,
  newPath: string,
  hunks: readonly ParsedPatchHunk[]
): { ok: true; value: ParsedPatchFile } | { ok: false; refusal: EditRefusal } {
  if (oldPath === "/dev/null" && newPath === "/dev/null") {
    return refusal("unsupported_change", "Patch cannot use /dev/null for both old and new paths");
  }
  if (oldPath === "/dev/null") return { ok: true, value: { kind: "create", newPath, hunks } };
  if (newPath === "/dev/null") return { ok: true, value: { kind: "delete", oldPath, hunks } };
  return { ok: true, value: { kind: "modify", oldPath, newPath, hunks } };
}

function parsePatchPath(rawPath: string): { ok: true; value: string } | { ok: false; refusal: EditRefusal } {
  const path = unquotePath(rawPath.split("\t")[0] ?? "").trimEnd();
  if (path.length === 0) return refusal("unsupported_change", "Patch file header path is empty");
  if (path === "/dev/null") return { ok: true, value: path };
  if (path.startsWith("a/") || path.startsWith("b/")) return { ok: true, value: path.slice(2) };
  return { ok: true, value: path };
}

function unquotePath(path: string): string {
  if (!path.startsWith("\"") || !path.endsWith("\"")) return path;
  return path
    .slice(1, -1)
    .replaceAll("\\t", "\t")
    .replaceAll("\\n", "\n")
    .replaceAll("\\\"", "\"")
    .replaceAll("\\\\", "\\");
}

function splitPhysicalLines(input: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let start = 0;
  let lineNumber = 1;
  while (start < input.length) {
    const lfIndex = input.indexOf("\n", start);
    if (lfIndex === -1) {
      lines.push({ text: input.slice(start), eol: "", lineNumber });
      break;
    }
    if (lfIndex > start && input[lfIndex - 1] === "\r") {
      lines.push({ text: input.slice(start, lfIndex - 1), eol: "\r\n", lineNumber });
    } else {
      lines.push({ text: input.slice(start, lfIndex), eol: "\n", lineNumber });
    }
    start = lfIndex + 1;
    lineNumber += 1;
  }
  return lines;
}

function lineText(line: PhysicalLine, index: number): string {
  return index === 0 && line.text.startsWith("\uFEFF") ? line.text.slice(1) : line.text;
}

function validRange(start: number, lines: number): boolean {
  return Number.isInteger(start) && Number.isInteger(lines) && lines >= 0 && (lines === 0 ? start >= 0 : start >= 1);
}

function removeLineEnding(content: string): string {
  if (content.endsWith("\r\n")) return content.slice(0, -2);
  if (content.endsWith("\n") || content.endsWith("\r")) return content.slice(0, -1);
  return content;
}

function pathLabel(oldPath: string, newPath: string): string {
  return newPath === "/dev/null" ? oldPath : newPath;
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
