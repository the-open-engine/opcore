import type { ValidationDiagnostic, ValidationDiagnosticCategory } from "@the-open-engine/opcore-contracts";

export interface DocsDiagnosticArgs {
  category?: ValidationDiagnosticCategory;
  severity?: ValidationDiagnostic["severity"];
  path?: string;
  code: string;
  message: string;
}

export function diagnostic(args: DocsDiagnosticArgs): ValidationDiagnostic {
  return {
    category: args.category ?? "policy",
    severity: args.severity ?? "error",
    message: args.message,
    ...(args.path === undefined ? {} : { path: args.path }),
    code: args.code
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
