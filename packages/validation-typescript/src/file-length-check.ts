import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { normalizeValidationFileViewPath } from "@the-open-engine/opcore-validation";
import { TYPE_SCRIPT_FILE_LENGTH_CHECK_ID } from "./check-ids.js";
import {
  defaultTypeScriptFileLengthThresholds,
  supportedTypeScriptValidationScopes,
  typeScriptCheckAdapter,
  typeScriptCheckOwner
} from "./check-constants.js";
import { isTypeScriptSourcePath } from "./source-files.js";

export interface TypeScriptFileLengthThresholds {
  maxFileLines: number;
}

export function createFileLengthCheck(
  options: {
    thresholds?: TypeScriptFileLengthThresholds;
  } = {}
): ValidationCheckDefinition {
  const thresholds = normalizeThresholds(options.thresholds);
  return {
    id: TYPE_SCRIPT_FILE_LENGTH_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: false,
    run: async (context): Promise<ValidationCheckResult> => {
      const diagnostics: ValidationDiagnostic[] = [];
      for (const path of typeScriptInputPaths(context)) {
        const result = await context.fileView.readAfter(path);
        if (result.status !== "found") continue;
        const lines = countPhysicalLines(result.content);
        if (lines <= thresholds.maxFileLines) continue;
        diagnostics.push({
          category: "policy",
          severity: "error",
          path,
          code: "TS_FILE_LINES",
          message: `TypeScript file has ${lines} lines; max is ${thresholds.maxFileLines}.`
        });
      }
      return { diagnostics: sortDiagnostics(diagnostics) };
    }
  };
}

function normalizeThresholds(thresholds: TypeScriptFileLengthThresholds | undefined): TypeScriptFileLengthThresholds {
  const resolved = thresholds ?? defaultTypeScriptFileLengthThresholds;
  if (!Number.isInteger(resolved.maxFileLines) || resolved.maxFileLines <= 0) {
    throw new Error("TypeScript file length maxFileLines must be a positive integer.");
  }
  return resolved;
}

function typeScriptInputPaths(context: Parameters<ValidationCheckDefinition["run"]>[0]): readonly string[] {
  return uniqueSorted(
    [...context.fileView.scopeFiles, ...context.fileView.overlays.map((overlay) => overlay.path)]
      .map((path) => normalizeValidationFileViewPath(path))
      .filter(isTypeScriptSourcePath)
  );
}

function countPhysicalLines(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (withoutFinalNewline.length === 0) return 0;
  return withoutFinalNewline.split("\n").length;
}

function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      (left.path ?? "").localeCompare(right.path ?? "") ||
      (left.code ?? "").localeCompare(right.code ?? "") ||
      left.message.localeCompare(right.message)
  );
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
