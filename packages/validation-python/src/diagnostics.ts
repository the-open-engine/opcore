import type {
  ValidationDiagnostic,
  ValidationDiagnosticCategory,
  ValidationDiagnosticToolProvenance
} from "@the-open-engine/opcore-contracts";

export interface PythonDiagnosticArgs {
  category: ValidationDiagnosticCategory;
  severity?: ValidationDiagnostic["severity"];
  path?: string;
  code: string;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  tool?: ValidationDiagnosticToolProvenance;
}

export function diagnostic(args: PythonDiagnosticArgs): ValidationDiagnostic {
  return {
    category: args.category,
    severity: args.severity ?? "error",
    code: args.code,
    message: args.message,
    ...(args.path === undefined ? {} : { path: args.path }),
    ...(args.line === undefined ? {} : { line: args.line }),
    ...(args.column === undefined ? {} : { column: args.column }),
    ...(args.endLine === undefined ? {} : { endLine: args.endLine }),
    ...(args.endColumn === undefined ? {} : { endColumn: args.endColumn }),
    ...(args.tool === undefined ? {} : { tool: args.tool })
  };
}

export function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      (left.path ?? "").localeCompare(right.path ?? "") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.column ?? 0) - (right.column ?? 0) ||
      (left.endLine ?? 0) - (right.endLine ?? 0) ||
      (left.endColumn ?? 0) - (right.endColumn ?? 0) ||
      (left.code ?? "").localeCompare(right.code ?? "") ||
      left.message.localeCompare(right.message)
  );
}
