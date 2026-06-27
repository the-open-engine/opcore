import type { ValidationDiagnostic, ValidationDiagnosticCategory } from "@the-open-engine/opcore-contracts";

export interface PythonDiagnosticArgs {
  category: ValidationDiagnosticCategory;
  severity?: ValidationDiagnostic["severity"];
  path?: string;
  code: string;
  message: string;
}

export function diagnostic(args: PythonDiagnosticArgs): ValidationDiagnostic {
  return {
    category: args.category,
    severity: args.severity ?? "error",
    path: args.path,
    code: args.code,
    message: args.message
  };
}

export function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      (left.path ?? "").localeCompare(right.path ?? "") ||
      (left.code ?? "").localeCompare(right.code ?? "") ||
      left.message.localeCompare(right.message)
  );
}
