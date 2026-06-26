import type { ValidationDiagnostic, ValidationDiagnosticCategory } from "@the-open-engine/opcore-contracts";
import ts from "typescript";
import { toRepoRelativeCompilerPath } from "./compiler-host.js";

export function mapTypeScriptDiagnostics(
  category: ValidationDiagnosticCategory,
  diagnostics: readonly ts.Diagnostic[],
  repoRoot: string
): readonly ValidationDiagnostic[] {
  return diagnostics.map((diagnostic) => mapTypeScriptDiagnostic(category, diagnostic, repoRoot)).sort(compareDiagnostics);
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

function compareDiagnostics(left: ValidationDiagnostic, right: ValidationDiagnostic): number {
  return (
    (left.path ?? "").localeCompare(right.path ?? "") ||
    (left.code ?? "").localeCompare(right.code ?? "") ||
    left.message.localeCompare(right.message)
  );
}
