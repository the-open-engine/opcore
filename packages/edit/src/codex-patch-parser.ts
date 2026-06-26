import type { EditRefusal } from "@the-open-engine/opcore-contracts";
import type { ParsedPatchLine } from "./patch-parser.js";

export type ParsedCodexPatchSectionKind = "add" | "delete" | "update";

export interface ParsedCodexPatchHunk {
  lines: readonly ParsedPatchLine[];
  endOfFile?: boolean;
  lineNumber: number;
}

export interface ParsedCodexPatchSection {
  kind: ParsedCodexPatchSectionKind;
  path: string;
  moveTo?: string;
  content?: string;
  hunks: readonly ParsedCodexPatchHunk[];
  lineNumber: number;
}

export type CodexPatchParseResult = { ok: true; sections: readonly ParsedCodexPatchSection[] } | { ok: false; refusal: EditRefusal };

interface PhysicalLine {
  text: string;
  eol: string;
  lineNumber: number;
}

interface MutableCodexPatchHunk {
  lines: ParsedPatchLine[];
  endOfFile?: boolean;
  lineNumber: number;
}

interface CodexUpdateState {
  path: string;
  moveTo?: string;
  hunks: MutableCodexPatchHunk[];
  currentHunk?: MutableCodexPatchHunk;
  sawChange: boolean;
}

const codexPatchBegin = "*** Begin Patch";
const codexPatchEnd = "*** End Patch";
const codexAddFilePrefix = "*** Add File: ";
const codexDeleteFilePrefix = "*** Delete File: ";
const codexUpdateFilePrefix = "*** Update File: ";
const codexMoveToPrefix = "*** Move to: ";
const codexEndOfFile = "*** End of File";

export function isCodexApplyPatch(patch: string): boolean {
  return patch.trimStart().startsWith(codexPatchBegin);
}

export function parseCodexApplyPatch(patch: string): CodexPatchParseResult {
  if (typeof patch !== "string" || patch.length === 0) {
    return refusal("unsupported_change", "Patch input must be a non-empty Codex apply_patch document");
  }
  const lines = splitPhysicalLines(patch);
  if (lines.length === 0 || lineText(lines[0], 0) !== codexPatchBegin) {
    return refusal("unsupported_change", `Malformed Codex patch: missing ${codexPatchBegin}`);
  }
  return parseCodexSections(lines);
}

function parseCodexSections(lines: readonly PhysicalLine[]): CodexPatchParseResult {
  const sections: ParsedCodexPatchSection[] = [];
  let index = 1;
  while (index < lines.length) {
    const text = lineText(lines[index], index);
    if (text === codexPatchEnd) return finishCodexSections(lines, index, sections);
    const section = parseCodexSection(lines, index);
    if (!section.ok) return section;
    sections.push(section.section);
    index = section.nextIndex;
  }
  return refusal("unsupported_change", `Malformed Codex patch: missing ${codexPatchEnd}`);
}

function finishCodexSections(
  lines: readonly PhysicalLine[],
  index: number,
  sections: readonly ParsedCodexPatchSection[]
): CodexPatchParseResult {
  if (index !== lines.length - 1 && !remainingLinesAreBlank(lines, index + 1)) {
    return refusal("unsupported_change", `Unexpected content after ${codexPatchEnd}`);
  }
  if (sections.length === 0) return refusal("unsupported_change", "Codex patch contains no file sections");
  return { ok: true, sections };
}

function parseCodexSection(
  lines: readonly PhysicalLine[],
  startIndex: number
):
  | { ok: true; section: ParsedCodexPatchSection; nextIndex: number }
  | { ok: false; refusal: EditRefusal } {
  const header = lineText(lines[startIndex], startIndex);
  if (isUnsupportedPatchMetadata(header)) return refusal("unsupported_change", `Unsupported Codex patch construct at line ${lines[startIndex].lineNumber}`);
  if (header.startsWith(codexAddFilePrefix)) return parseCodexAddFileSection(lines, startIndex, header.slice(codexAddFilePrefix.length));
  if (header.startsWith(codexDeleteFilePrefix)) return parseCodexDeleteFileSection(lines, startIndex, header.slice(codexDeleteFilePrefix.length));
  if (header.startsWith(codexUpdateFilePrefix)) return parseCodexUpdateFileSection(lines, startIndex, header.slice(codexUpdateFilePrefix.length));
  return refusal("unsupported_change", `Unexpected Codex patch line at line ${lines[startIndex].lineNumber}`);
}

function parseCodexAddFileSection(
  lines: readonly PhysicalLine[],
  startIndex: number,
  rawPath: string
):
  | { ok: true; section: ParsedCodexPatchSection; nextIndex: number }
  | { ok: false; refusal: EditRefusal } {
  const path = parseCodexPath(rawPath, "add", lines[startIndex].lineNumber);
  if (!path.ok) return path;
  const content = collectCodexAddedContent(lines, startIndex + 1, path.value);
  if (!content.ok) return content;
  return {
    ok: true,
    section: { kind: "add", path: path.value, content: content.content, hunks: [], lineNumber: lines[startIndex].lineNumber },
    nextIndex: content.nextIndex
  };
}

function collectCodexAddedContent(
  lines: readonly PhysicalLine[],
  startIndex: number,
  path: string
): { ok: true; content: string; nextIndex: number } | { ok: false; refusal: EditRefusal } {
  let content = "";
  let addedLines = 0;
  let index = startIndex;
  while (index < lines.length && !isCodexSectionBoundary(lineText(lines[index], index))) {
    const parsed = codexAddedLine(lines[index], index, path);
    if (!parsed.ok) return parsed;
    content += parsed.content;
    addedLines += 1;
    index += 1;
  }
  if (addedLines === 0) return refusal("unsupported_change", `Add file section for ${path} has no content`, path);
  return { ok: true, content, nextIndex: index };
}

function parseCodexDeleteFileSection(
  lines: readonly PhysicalLine[],
  startIndex: number,
  rawPath: string
):
  | { ok: true; section: ParsedCodexPatchSection; nextIndex: number }
  | { ok: false; refusal: EditRefusal } {
  const path = parseCodexPath(rawPath, "delete", lines[startIndex].lineNumber);
  if (!path.ok) return path;
  const nextIndex = startIndex + 1;
  if (nextIndex < lines.length && !isCodexSectionBoundary(lineText(lines[nextIndex], nextIndex))) {
    return refusal("unsupported_change", `Delete file section for ${path.value} has unexpected content at line ${lines[nextIndex].lineNumber}`, path.value);
  }
  return {
    ok: true,
    section: { kind: "delete", path: path.value, hunks: [], lineNumber: lines[startIndex].lineNumber },
    nextIndex
  };
}

function parseCodexUpdateFileSection(
  lines: readonly PhysicalLine[],
  startIndex: number,
  rawPath: string
):
  | { ok: true; section: ParsedCodexPatchSection; nextIndex: number }
  | { ok: false; refusal: EditRefusal } {
  const path = parseCodexPath(rawPath, "update", lines[startIndex].lineNumber);
  if (!path.ok) return path;
  const state: CodexUpdateState = { path: path.value, hunks: [], sawChange: false };
  let index = startIndex + 1;
  while (index < lines.length && !isCodexSectionBoundary(lineText(lines[index], index))) {
    const parsed = parseCodexUpdateLine(lines[index], index, state);
    if (!parsed.ok) return parsed;
    index += 1;
  }
  if (!state.sawChange && state.moveTo === undefined) return refusal("unsupported_change", `Update file section for ${state.path} has no hunks`, state.path);
  return {
    ok: true,
    section: { kind: "update", path: state.path, moveTo: state.moveTo, hunks: state.hunks, lineNumber: lines[startIndex].lineNumber },
    nextIndex: index
  };
}

function parseCodexUpdateLine(
  physical: PhysicalLine,
  index: number,
  state: CodexUpdateState
): { ok: true } | { ok: false; refusal: EditRefusal } {
  const text = lineText(physical, index);
  if (isUnsupportedPatchMetadata(text)) return refusal("unsupported_change", `Unsupported Codex update construct at line ${physical.lineNumber}`);
  if (text.startsWith(codexMoveToPrefix)) return parseCodexMoveLine(text, physical.lineNumber, state);
  if (text.startsWith("@@")) return startCodexHunk(physical.lineNumber, state);
  if (text === codexEndOfFile) return markCodexEndOfFile(physical.lineNumber, state);
  return appendCodexHunkLine(text, physical, state);
}

function parseCodexMoveLine(
  text: string,
  lineNumber: number,
  state: CodexUpdateState
): { ok: true } | { ok: false; refusal: EditRefusal } {
  if (state.moveTo !== undefined) return refusal("unsupported_change", `Duplicate Codex move target for ${state.path}`, state.path);
  if (state.sawChange) return refusal("unsupported_change", `Codex move target for ${state.path} must appear before hunks`, state.path);
  const moveTo = parseCodexPath(text.slice(codexMoveToPrefix.length), "move", lineNumber);
  if (!moveTo.ok) return moveTo;
  state.moveTo = moveTo.value;
  return { ok: true };
}

function startCodexHunk(lineNumber: number, state: CodexUpdateState): { ok: true } {
  state.currentHunk = { lines: [], lineNumber };
  state.hunks.push(state.currentHunk);
  state.sawChange = true;
  return { ok: true };
}

function markCodexEndOfFile(lineNumber: number, state: CodexUpdateState): { ok: true } | { ok: false; refusal: EditRefusal } {
  if (!state.currentHunk || state.currentHunk.lines.length === 0) {
    return refusal("unsupported_change", `Misplaced Codex end-of-file marker at line ${lineNumber}`, state.path);
  }
  if (state.currentHunk.endOfFile) return refusal("unsupported_change", `Duplicate Codex end-of-file marker at line ${lineNumber}`, state.path);
  state.currentHunk.endOfFile = true;
  state.sawChange = true;
  return { ok: true };
}

function appendCodexHunkLine(
  text: string,
  physical: PhysicalLine,
  state: CodexUpdateState
): { ok: true } | { ok: false; refusal: EditRefusal } {
  const marker = text[0];
  if (marker !== " " && marker !== "+" && marker !== "-") {
    return refusal("unsupported_change", `Unexpected Codex update line at line ${physical.lineNumber}`, state.path);
  }
  const hunk = state.currentHunk ?? startImplicitCodexHunk(physical.lineNumber, state);
  hunk.lines.push({
    kind: marker === " " ? "context" : marker === "+" ? "add" : "delete",
    content: text.slice(1) + physical.eol,
    noNewlineAtEnd: false,
    lineNumber: physical.lineNumber
  });
  state.sawChange = true;
  return { ok: true };
}

function startImplicitCodexHunk(lineNumber: number, state: CodexUpdateState): MutableCodexPatchHunk {
  state.currentHunk = { lines: [], lineNumber };
  state.hunks.push(state.currentHunk);
  return state.currentHunk;
}

function codexAddedLine(
  physical: PhysicalLine,
  index: number,
  path: string
): { ok: true; content: string } | { ok: false; refusal: EditRefusal } {
  const text = lineText(physical, index);
  if (isUnsupportedPatchMetadata(text)) return refusal("unsupported_change", `Unsupported Codex add construct at line ${physical.lineNumber}`);
  if (!text.startsWith("+")) return refusal("unsupported_change", `Add file section for ${path} has non-add line at line ${physical.lineNumber}`, path);
  return { ok: true, content: text.slice(1) + physical.eol };
}

function parseCodexPath(
  rawPath: string,
  label: string,
  lineNumber: number
): { ok: true; value: string } | { ok: false; refusal: EditRefusal } {
  const path = rawPath.trim();
  if (path.length === 0) return refusal("unsupported_change", `Codex ${label} path is empty at line ${lineNumber}`);
  return { ok: true, value: path };
}

function isCodexSectionBoundary(text: string): boolean {
  return text === codexPatchEnd || isCodexSectionHeader(text);
}

function isCodexSectionHeader(text: string): boolean {
  return text.startsWith(codexAddFilePrefix) || text.startsWith(codexDeleteFilePrefix) || text.startsWith(codexUpdateFilePrefix);
}

function remainingLinesAreBlank(lines: readonly PhysicalLine[], startIndex: number): boolean {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lineText(lines[index], index).trim().length !== 0) return false;
  }
  return true;
}

function isUnsupportedPatchMetadata(text: string): boolean {
  return (
    text.startsWith("diff --git ") ||
    text.startsWith("--- ") ||
    text.startsWith("+++ ") ||
    /^Binary files /.test(text) ||
    text === "GIT binary patch" ||
    /^literal \d+/.test(text) ||
    /^delta \d+/.test(text) ||
    /^(?:index .*\b160000\b|new file mode 160000|deleted file mode 160000)/.test(text) ||
    /^(?:old mode|new mode|new file mode|deleted file mode|rename from|rename to|similarity index) /.test(text)
  );
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
