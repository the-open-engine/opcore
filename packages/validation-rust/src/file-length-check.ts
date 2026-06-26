import type { ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { RUST_FILE_LENGTH_CHECK_ID } from "./check-ids.js";
import { defaultRustFileLengthThresholds, rustCheckAdapter, rustCheckOwner, supportedRustValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { isRustSourcePath, readRustAfterSources, rustInputSet, skippedRustInputResult } from "./source-files.js";

export interface RustFileLengthThresholds {
  maxFileLines: number;
}

export function createFileLengthCheck(
  options: {
    thresholds?: RustFileLengthThresholds;
  } = {}
): ValidationCheckDefinition {
  const thresholds = normalizeThresholds(options.thresholds);
  return {
    id: RUST_FILE_LENGTH_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    run: async (context): Promise<ValidationCheckResult> => {
      const skipped = skippedRustInputResult(context);
      if (skipped !== undefined) return skipped;

      const input = rustInputSet(context);
      if (!input.ownedPaths.some(isRustSourcePath)) {
        return {
          status: "skipped",
          diagnostics: [],
          failureMessage: "No Rust source files were selected."
        };
      }

      const diagnostics = [];
      const sources = await readRustAfterSources(context);
      for (const source of sources) {
        if (!isRustSourcePath(source.path)) continue;
        const lines = countPhysicalLines(source.content);
        if (lines > thresholds.maxFileLines) {
          diagnostics.push(
            diagnostic({
              category: "policy",
              path: source.path,
              code: "RUST_FILE_LINES",
              message: `Rust file has ${lines} lines; max is ${thresholds.maxFileLines}.`
            })
          );
        }
      }
      return { diagnostics: sortDiagnostics(diagnostics) };
    }
  };
}

function normalizeThresholds(thresholds: RustFileLengthThresholds | undefined): RustFileLengthThresholds {
  const resolved = thresholds ?? defaultRustFileLengthThresholds;
  if (!Number.isInteger(resolved.maxFileLines) || resolved.maxFileLines <= 0) {
    throw new Error("Rust file length maxFileLines must be a positive integer.");
  }
  return resolved;
}

function countPhysicalLines(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (withoutFinalNewline.length === 0) return 0;
  return withoutFinalNewline.split("\n").length;
}
