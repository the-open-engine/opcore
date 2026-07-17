import type {
  PythonValidationCapabilityToolProvenance,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import {
  repoRelativeMaterializedPath,
  type MaterializedPythonTypeWorkspace
} from "./type-capability-run.js";

export type ParsedMypyStream =
  | { ok: true; diagnostics: readonly ValidationDiagnostic[] }
  | { ok: false; message: string };

export interface MypyJsonRecord {
  file: string;
  line: number;
  column: number;
  end_line?: number;
  end_column?: number;
  message: string;
  hint?: string | null;
  code?: string | null;
  severity: "error" | "warning" | "note";
}

export function parseMypyJsonStream(
  stdout: string,
  workspace: MaterializedPythonTypeWorkspace,
  tool: PythonValidationCapabilityToolProvenance
): ParsedMypyStream {
  const diagnostics: ValidationDiagnostic[] = [];
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseMypyJsonLine(lines[index], index + 1, workspace, tool);
    if (typeof parsed === "string") return { ok: false, message: parsed };
    diagnostics.push(parsed);
  }
  return { ok: true, diagnostics: sortDiagnostics(diagnostics) };
}

export function validateMypyRecord(value: unknown, record: number): MypyJsonRecord | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `mypy JSON record ${record} must be an object`;
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["file", "line", "column", "end_line", "end_column", "message", "hint", "code", "severity"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return `mypy JSON record ${record} has unknown fields`;
  const failure = validateMypyLocation(candidate, record) ?? validateMypyText(candidate, record);
  if (failure !== undefined) return failure;
  return candidate as unknown as MypyJsonRecord;
}

function parseMypyJsonLine(
  line: string,
  record: number,
  workspace: MaterializedPythonTypeWorkspace,
  tool: PythonValidationCapabilityToolProvenance
): ValidationDiagnostic | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return `mypy emitted malformed JSON record ${record}`;
  }
  const validated = validateMypyRecord(value, record);
  if (typeof validated === "string") return validated;
  try {
    const path = repoRelativeMaterializedPath(validated.file, workspace.projectCwd, workspace.root);
    return mypyDiagnostic(validated, path, tool);
  } catch {
    return `mypy JSON record ${record} has an out-of-repository file`;
  }
}

function mypyDiagnostic(
  record: MypyJsonRecord,
  path: string,
  tool: PythonValidationCapabilityToolProvenance
): ValidationDiagnostic {
  return diagnostic({
    category: "types", severity: record.severity === "note" ? "info" : record.severity, path,
    code: record.code == null ? "MYPY_TYPE_ERROR" : `MYPY_${normalizeDiagnosticCode(record.code)}`,
    message: record.hint == null ? record.message : `${record.message} (${record.hint})`,
    line: record.line, column: record.column + 1,
    ...(record.end_line === undefined ? {} : { endLine: record.end_line }),
    ...(record.end_line === undefined || record.end_column === undefined ? {} : { endColumn: record.end_column + 1 }),
    tool: {
      name: tool.name, command: tool.argv.join(" "), source: tool.source, cwd: tool.cwd,
      ...(tool.version === undefined ? {} : { version: tool.version })
    }
  });
}

function validateMypyLocation(candidate: Record<string, unknown>, record: number): string | undefined {
  if (typeof candidate.file !== "string" || candidate.file.length === 0 || candidate.file.includes("\0")) return `mypy JSON record ${record} has invalid file`;
  if (!Number.isInteger(candidate.line) || (candidate.line as number) < 1) return `mypy JSON record ${record} has invalid line`;
  if (!Number.isInteger(candidate.column) || (candidate.column as number) < 0) return `mypy JSON record ${record} has invalid column`;
  return validateMypyEndLocation(candidate, record);
}

function validateMypyEndLocation(candidate: Record<string, unknown>, record: number): string | undefined {
  if (candidate.end_line !== undefined && (!Number.isInteger(candidate.end_line) || (candidate.end_line as number) < (candidate.line as number))) return `mypy JSON record ${record} has invalid end_line`;
  if (candidate.end_column !== undefined && (!Number.isInteger(candidate.end_column) || (candidate.end_column as number) < 0)) return `mypy JSON record ${record} has invalid end_column`;
  if (candidate.end_column !== undefined && candidate.end_line === undefined) return `mypy JSON record ${record} has end_column without end_line`;
  if (candidate.end_line === candidate.line && candidate.end_column !== undefined && (candidate.end_column as number) < (candidate.column as number)) return `mypy JSON record ${record} has end location before its start location`;
  return undefined;
}

function validateMypyText(candidate: Record<string, unknown>, record: number): string | undefined {
  if (typeof candidate.message !== "string" || candidate.message.length === 0) return `mypy JSON record ${record} has invalid message`;
  if (candidate.hint != null && typeof candidate.hint !== "string") return `mypy JSON record ${record} has invalid hint`;
  if (candidate.code != null && typeof candidate.code !== "string") return `mypy JSON record ${record} has invalid code`;
  if (candidate.severity !== "error" && candidate.severity !== "warning" && candidate.severity !== "note") return `mypy JSON record ${record} has unknown severity`;
  return undefined;
}

function normalizeDiagnosticCode(code: string): string {
  return code.replace(/([a-z])([A-Z])/gu, "$1_$2").replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toUpperCase();
}
