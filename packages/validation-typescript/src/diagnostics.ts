import type { ValidationDiagnostic, ValidationDiagnosticCategory } from "@the-open-engine/opcore-contracts";
import ts from "typescript";
import { toRepoRelativeCompilerPath } from "./compiler-host.js";

export function mapTypeScriptDiagnostics(
  category: ValidationDiagnosticCategory,
  diagnostics: readonly ts.Diagnostic[],
  repoRoot: string
): readonly ValidationDiagnostic[] {
  return sortValidationDiagnostics(diagnostics.map((diagnostic) => mapTypeScriptDiagnostic(category, diagnostic, repoRoot)));
}

export function mapTypeScriptDiagnostic(
  category: ValidationDiagnosticCategory,
  diagnostic: ts.Diagnostic,
  repoRoot: string
): ValidationDiagnostic {
  const validationDiagnostic: ValidationDiagnostic = {
    category,
    severity: "error",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    code: String(diagnostic.code)
  };
  if (diagnostic.file !== undefined) {
    const path = toRepoRelativeCompilerPath(diagnostic.file.fileName, repoRoot);
    if (path !== undefined && path.length > 0) validationDiagnostic.path = path;
  }
  return validationDiagnostic;
}

export function sortValidationDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort(compareDiagnostics);
}

export function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function compareDiagnostics(left: ValidationDiagnostic, right: ValidationDiagnostic): number {
  return (
    (left.path ?? "").localeCompare(right.path ?? "") ||
    (left.code ?? "").localeCompare(right.code ?? "") ||
    left.message.localeCompare(right.message)
  );
}
