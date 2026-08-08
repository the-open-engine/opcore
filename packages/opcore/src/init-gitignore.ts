import {
  OPCORE_IGNORE_LINE
} from "./init-constants.js";
import type { ManagedLineUndoEntry } from "./init-types.js";

export function gitignoreIgnoresOpcore(content: string): boolean {
  let ignored = false;
  for (const rawLine of content.split(/\r\n|\n|\r/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1).trim() : line;
    if (isOpcoreGitignorePattern(pattern)) ignored = !negated;
  }
  return ignored;
}

function isOpcoreGitignorePattern(pattern: string): boolean {
  return pattern === ".opcore" ||
    pattern === ".opcore/" ||
    pattern === "/.opcore" ||
    pattern === "/.opcore/" ||
    pattern === ".opcore/**" ||
    pattern === "/.opcore/**";
}

export function appendManagedGitignoreLine(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) return `${OPCORE_IGNORE_LINE}\n`;
  return `${existing.endsWith("\n") || existing.endsWith("\r") ? "" : "\n"}${OPCORE_IGNORE_LINE}\n`;
}

export function removeManagedGitignoreLine(
  current: string,
  entry: ManagedLineUndoEntry
): { content: string; removed: boolean } {
  if (entry.appended !== undefined && current.endsWith(entry.appended)) {
    return { content: current.slice(0, -entry.appended.length), removed: true };
  }
  const matchedChunks = current.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu);
  const chunks = matchedChunks === null ? [] : matchedChunks;
  const meaningful = chunks.filter((chunk) => chunk.length > 0);
  const index = meaningful.findIndex((chunk) => chunk.replace(/(?:\r\n|\n|\r)$/u, "") === entry.line);
  if (index < 0) return { content: current, removed: false };
  meaningful.splice(index, 1);
  return { content: meaningful.join(""), removed: true };
}
