import type {
  PythonValidationCapabilityToolProvenance,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import { parse, parseTree, type ParseError } from "jsonc-parser";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { duplicateJsonObjectKey } from "./strict-json.js";
import {
  repoRelativeMaterializedPath,
  type MaterializedPythonTypeWorkspace
} from "./type-capability-run.js";

export type ParsedPyrightOutput =
  | { ok: true; diagnostics: readonly ValidationDiagnostic[]; summary: PyrightOutputSummary }
  | { ok: false; message: string };

export interface PyrightOutputSummary {
  filesAnalyzed: number;
  errorCount: number;
  warningCount: number;
  informationCount: number;
  timeInSec: number;
}

interface PyrightPosition {
  line: number;
  character: number;
}

interface PyrightDiagnosticRecord {
  file: string;
  severity: "error" | "warning" | "information";
  message: string;
  rule?: string;
  range: { start: PyrightPosition; end: PyrightPosition };
}

type PyrightDiagnosticIdentity = Omit<PyrightDiagnosticRecord, "range">;

export function parsePyrightJsonOutput(
  stdout: string,
  workspace: MaterializedPythonTypeWorkspace,
  tool: PythonValidationCapabilityToolProvenance
): ParsedPyrightOutput {
  try {
    const errors: ParseError[] = [];
    const value = parse(stdout, errors, { allowTrailingComma: false, disallowComments: true }) as unknown;
    if (errors.length > 0 || !isTable(value)) return { ok: false, message: "pyright emitted malformed or truncated JSON" };
    const treeErrors: ParseError[] = [];
    const tree = parseTree(stdout, treeErrors, { allowTrailingComma: false, disallowComments: true });
    if (tree === undefined || treeErrors.length > 0) return { ok: false, message: "pyright emitted malformed or truncated JSON" };
    const duplicateKey = duplicateJsonObjectKey(tree);
    if (duplicateKey !== undefined) return { ok: false, message: `pyright JSON has duplicate key ${duplicateKey}` };
    return validatePyrightPayload(value, workspace, tool);
  } catch {
    return { ok: false, message: "pyright emitted malformed or excessively nested JSON" };
  }
}

function validatePyrightPayload(
  value: Record<string, unknown>,
  workspace: MaterializedPythonTypeWorkspace,
  tool: PythonValidationCapabilityToolProvenance
): ParsedPyrightOutput {
  if (typeof value.version !== "string" || value.version.length === 0) {
    return { ok: false, message: "pyright JSON has invalid version" };
  }
  if (tool.version === undefined || value.version !== tool.version) {
    return { ok: false, message: `pyright output version ${String(value.version)} does not match selected tool version ${tool.version ?? "unknown"}` };
  }
  if (!Array.isArray(value.generalDiagnostics)) {
    return { ok: false, message: "pyright JSON generalDiagnostics must be an array" };
  }
  const summary = validateSummary(value.summary);
  if (typeof summary === "string") return { ok: false, message: summary };
  const normalized = normalizePyrightDiagnostics(value.generalDiagnostics, workspace, tool);
  if (!normalized.ok) return normalized;
  if (!summaryMatchesDiagnostics(summary, normalized.severityCounts)) {
    return { ok: false, message: "pyright JSON summary counts do not match generalDiagnostics" };
  }
  return { ok: true, diagnostics: sortDiagnostics(normalized.diagnostics), summary };
}

interface NormalizedPyrightDiagnostics {
  ok: true;
  diagnostics: readonly ValidationDiagnostic[];
  severityCounts: Record<PyrightDiagnosticRecord["severity"], number>;
}

type NormalizedDiagnosticPath =
  | { ok: true; path: string }
  | { ok: false; message: string };

function normalizePyrightDiagnostics(
  records: readonly unknown[],
  workspace: MaterializedPythonTypeWorkspace,
  tool: PythonValidationCapabilityToolProvenance
): NormalizedPyrightDiagnostics | { ok: false; message: string } {
  const diagnostics: ValidationDiagnostic[] = [];
  const identities = new Set<string>();
  const diagnosticSeverities = new Map<string, string>();
  const severityCounts = { error: 0, warning: 0, information: 0 };
  for (let index = 0; index < records.length; index += 1) {
    const record = validateDiagnosticRecord(records[index], index + 1);
    if (typeof record === "string") return { ok: false, message: record };
    const normalizedPath = normalizeDiagnosticPath(record, index + 1, workspace);
    if (!normalizedPath.ok) return normalizedPath;
    const { path } = normalizedPath;
    const identity = JSON.stringify([path, record.severity, record.message, record.rule, record.range]);
    if (identities.has(identity)) return { ok: false, message: `pyright JSON contains duplicate diagnostic ${index + 1}` };
    identities.add(identity);
    const semanticIdentity = JSON.stringify([path, record.message, record.rule, record.range]);
    const earlierSeverity = diagnosticSeverities.get(semanticIdentity);
    if (earlierSeverity !== undefined && earlierSeverity !== record.severity) {
      return { ok: false, message: `pyright JSON contains contradictory diagnostic ${index + 1}` };
    }
    diagnosticSeverities.set(semanticIdentity, record.severity);
    severityCounts[record.severity] += 1;
    diagnostics.push(pyrightDiagnostic(record, path, tool));
  }
  return { ok: true, diagnostics, severityCounts };
}

function normalizeDiagnosticPath(
  record: PyrightDiagnosticRecord,
  index: number,
  workspace: MaterializedPythonTypeWorkspace
): NormalizedDiagnosticPath {
  let path: string;
  try {
    path = repoRelativeMaterializedPath(record.file, workspace.projectCwd, workspace.root);
  } catch {
    return { ok: false, message: `pyright JSON diagnostic ${index} has an out-of-repository file` };
  }
  if (!workspace.selectedSourcePaths.includes(path) && !workspace.selectedConfigPaths.includes(path)) {
    return { ok: false, message: `pyright JSON diagnostic ${index} names a file outside the selected after-state closure` };
  }
  const content = workspace.afterStateContentByPath.get(path);
  return content === undefined || !rangeWithinContent(record.range, content)
    ? { ok: false, message: `pyright JSON diagnostic ${index} has a range outside its after-state file` }
    : { ok: true, path };
}

function summaryMatchesDiagnostics(
  summary: PyrightOutputSummary,
  counts: Record<PyrightDiagnosticRecord["severity"], number>
): boolean {
  return summary.errorCount === counts.error && summary.warningCount === counts.warning &&
    summary.informationCount === counts.information;
}

function validateDiagnosticRecord(value: unknown, index: number): PyrightDiagnosticRecord | string {
  if (!isTable(value)) return `pyright JSON diagnostic ${index} must be an object`;
  const identity = validateDiagnosticIdentity(value, index);
  if (typeof identity === "string") return identity;
  const range = validateDiagnosticRange(value.range, index);
  if (typeof range === "string") return range;
  return { ...identity, range };
}

function validateDiagnosticIdentity(
  value: Record<string, unknown>,
  index: number
): PyrightDiagnosticIdentity | string {
  if (!isProtocolString(value.file)) {
    return `pyright JSON diagnostic ${index} has invalid file`;
  }
  if (!isDiagnosticSeverity(value.severity)) {
    return `pyright JSON diagnostic ${index} has invalid severity`;
  }
  if (!isProtocolString(value.message)) {
    return `pyright JSON diagnostic ${index} has invalid message`;
  }
  if (value.rule !== undefined && !isProtocolString(value.rule)) {
    return `pyright JSON diagnostic ${index} has invalid rule`;
  }
  return {
    file: value.file,
    severity: value.severity,
    message: value.message,
    ...(value.rule === undefined ? {} : { rule: value.rule })
  };
}

function isProtocolString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isDiagnosticSeverity(value: unknown): value is PyrightDiagnosticRecord["severity"] {
  return value === "error" || value === "warning" || value === "information";
}

function validateDiagnosticRange(
  value: unknown,
  index: number
): PyrightDiagnosticRecord["range"] | string {
  if (!isTable(value) || !isPosition(value.start) || !isPosition(value.end)) {
    return `pyright JSON diagnostic ${index} has invalid range`;
  }
  if (value.end.line < value.start.line || value.end.line === value.start.line && value.end.character < value.start.character) {
    return `pyright JSON diagnostic ${index} has a reversed range`;
  }
  return { start: value.start, end: value.end };
}

function validateSummary(value: unknown): PyrightOutputSummary | string {
  if (!isTable(value)) return "pyright JSON summary must be an object";
  for (const key of ["filesAnalyzed", "errorCount", "warningCount", "informationCount"] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 0) return `pyright JSON summary has invalid ${key}`;
  }
  if (typeof value.timeInSec !== "number" || !Number.isFinite(value.timeInSec) || value.timeInSec < 0) {
    return "pyright JSON summary has invalid timeInSec";
  }
  return value as unknown as PyrightOutputSummary;
}

function pyrightDiagnostic(
  record: PyrightDiagnosticRecord,
  path: string,
  tool: PythonValidationCapabilityToolProvenance
): ValidationDiagnostic {
  return diagnostic({
    category: "types",
    severity: record.severity === "information" ? "info" : record.severity,
    path,
    code: record.rule === undefined ? "PYRIGHT_TYPE_ERROR" : `PYRIGHT_${normalizeDiagnosticCode(record.rule)}`,
    message: record.message,
    line: record.range.start.line + 1,
    column: record.range.start.character + 1,
    endLine: record.range.end.line + 1,
    endColumn: record.range.end.character + 1,
    tool: {
      name: tool.name,
      command: tool.argv.join(" "),
      ...(tool.version === undefined ? {} : { version: tool.version }),
      source: tool.source,
      cwd: tool.cwd
    }
  });
}

function isPosition(value: unknown): value is PyrightPosition {
  return isTable(value) && Number.isInteger(value.line) && (value.line as number) >= 0 &&
    Number.isInteger(value.character) && (value.character as number) >= 0;
}

function rangeWithinContent(range: PyrightDiagnosticRecord["range"], content: string): boolean {
  const lines = content.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  return range.start.line < lines.length && range.end.line < lines.length &&
    range.start.character <= lines[range.start.line].length && range.end.character <= lines[range.end.line].length;
}

function normalizeDiagnosticCode(code: string): string {
  return code.replace(/([a-z])([A-Z])/gu, "$1_$2").replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "").toUpperCase();
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
