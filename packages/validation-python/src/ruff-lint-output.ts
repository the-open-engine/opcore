import type {
  ValidationDiagnostic,
  ValidationDiagnosticToolProvenance
} from "@the-open-engine/opcore-contracts";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import {
  selectedRepoRelativeDiagnosticPath,
  type MaterializedPythonExecutionWorkspace
} from "./python-execution-workspace.js";

type RuffLintEntry = {
  code: string | null;
  filename: string;
  location: { row: number; column: number };
  end_location?: { row: number; column: number };
  message: string;
};

const ruffSyntaxDiagnosticCode = "PY_RUFF_LINT_SYNTAX_ERROR";

export function parseRuffLintDiagnostics(
  stdout: string,
  provenance: ValidationDiagnosticToolProvenance,
  workspace: MaterializedPythonExecutionWorkspace
): { status: "parsed"; diagnostics: readonly ValidationDiagnostic[] } | { status: "malformed"; message: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return { status: "malformed", message: "ruff lint returned malformed JSON output" };
  }
  if (!Array.isArray(payload)) return { status: "malformed", message: "ruff lint output must be a JSON array" };
  const diagnostics = payload.map((entry) => parseLintDiagnostic(entry, provenance, workspace));
  if (diagnostics.some((entry) => entry === undefined)) {
    return { status: "malformed", message: "ruff lint output contained an invalid diagnostic entry" };
  }
  return { status: "parsed", diagnostics: sortDiagnostics(diagnostics as ValidationDiagnostic[]) };
}

function parseLintDiagnostic(
  value: unknown,
  provenance: ValidationDiagnosticToolProvenance,
  workspace: MaterializedPythonExecutionWorkspace
): ValidationDiagnostic | undefined {
  const entry = parseRuffLintEntry(value);
  if (entry === undefined) return undefined;
  const path = selectedRepoRelativeDiagnosticPath(
    entry.filename,
    workspace.projectCwd,
    workspace.root,
    workspace.sourcePaths
  );
  if (path === undefined) return undefined;
  return diagnostic({
    category: "policy",
    severity: "warning",
    path,
    code: entry.code === null
      ? ruffSyntaxDiagnosticCode
      : `PY_RUFF_LINT_${normalizeDiagnosticCode(entry.code)}`,
    message: entry.message,
    line: entry.location.row,
    column: entry.location.column,
    endLine: entry.end_location?.row,
    endColumn: entry.end_location?.column,
    tool: provenance
  });
}

function parseRuffLintEntry(value: unknown): RuffLintEntry | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const code = nullableDiagnosticCode(record);
  const filename = requiredString(record, "filename");
  const message = requiredString(record, "message");
  const location = requiredLocation(record, "location");
  const endLocation = optionalLocation(record, "end_location");
  if (code === undefined || filename === undefined || message === undefined || location === undefined || endLocation === null) {
    return undefined;
  }
  return {
    code,
    filename,
    location,
    ...(endLocation === undefined ? {} : { end_location: endLocation }),
    message
  };
}

function nullableDiagnosticCode(record: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(record, "code")) return undefined;
  const value = record.code;
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredLocation(record: Record<string, unknown>, key: string): { row: number; column: number } | undefined {
  return parseRuffLocation(record[key]);
}

function optionalLocation(
  record: Record<string, unknown>,
  key: string
): { row: number; column: number } | undefined | null {
  if (!(key in record) || record[key] === undefined) return undefined;
  return parseRuffLocation(record[key]) ?? null;
}

function parseRuffLocation(value: unknown): { row: number; column: number } | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const row = record.row;
  const column = record.column;
  return typeof row === "number" && Number.isInteger(row) && row > 0 &&
      typeof column === "number" && Number.isInteger(column) && column > 0
    ? { row, column }
    : undefined;
}

function normalizeDiagnosticCode(code: string): string {
  return code.replace(/([a-z])([A-Z])/gu, "$1_$2").replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toUpperCase();
}
