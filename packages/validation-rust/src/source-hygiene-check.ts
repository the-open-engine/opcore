import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { RUST_SOURCE_HYGIENE_CHECK_ID } from "./check-ids.js";
import { ownedClippyLints, rustCheckAdapter, rustCheckOwner, supportedRustValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { isRustIncludeSourcePath, readRustAfterSources, skippedRustInputResult } from "./source-files.js";

const attributePattern = /#\s*!?\s*\[[^\]]*\]/g;
const lintSuppressionPattern = /\b(?:allow|expect)\s*\(([^)]*)\)/g;
const rustfmtSkipPattern = /#\s*\[\s*rustfmt::skip\s*\]/g;
const includeMacroPattern = /\binclude!\s*\(/g;
const broadSuppressionLints = new Set([
  "warnings",
  "clippy::all",
  "clippy::restriction",
  ...ownedClippyLints
]);

export function createSourceHygieneCheck(): ValidationCheckDefinition {
  return {
    id: RUST_SOURCE_HYGIENE_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    run: async (context) => {
      const skipped = skippedRustInputResult(context);
      if (skipped !== undefined) return skipped;
      const diagnostics = [];
      for (const source of await readRustAfterSources(context)) {
        if (isRustIncludeSourcePath(source.path)) {
          diagnostics.push(
            diagnostic({
              category: "policy",
              path: source.path,
              code: "RUST_SOURCE_INC_FILE",
              message: "Rust .inc source composition is not allowed in native validation input."
            })
          );
        }
        diagnostics.push(
          ...matches({
            path: source.path,
            content: source.content,
            pattern: includeMacroPattern,
            code: "RUST_SOURCE_INCLUDE_MACRO",
            message: "Rust include!(...) source composition is not allowed."
          })
        );
        diagnostics.push(
          ...matches({
            path: source.path,
            content: source.content,
            pattern: rustfmtSkipPattern,
            code: "RUST_SOURCE_RUSTFMT_SKIP",
            message: "rustfmt::skip suppressions are not allowed."
          })
        );
        diagnostics.push(...lintSuppressionDiagnostics(source.path, source.content));
      }
      return { diagnostics: sortDiagnostics(diagnostics) };
    }
  };
}

function lintSuppressionDiagnostics(path: string, content: string) {
  const diagnostics = [];
  attributePattern.lastIndex = 0;
  for (const attribute of content.matchAll(attributePattern)) {
    lintSuppressionPattern.lastIndex = 0;
    for (const match of String(attribute[0] ?? "").matchAll(lintSuppressionPattern)) {
      const lints = String(match[1] ?? "")
        .split(",")
        .map((lint) => lint.trim())
        .filter((lint) => lint.length > 0);
      for (const lint of lints) {
        if (lint === "dead_code") {
          diagnostics.push(
            diagnostic({
              category: "policy",
              path,
              code: "RUST_SOURCE_ALLOW_DEAD_CODE",
              message: "allow(dead_code) suppressions are not allowed."
            })
          );
        }
        if (isBroadSuppressionLint(lint)) {
          diagnostics.push(
            diagnostic({
              category: "policy",
              path,
              code: "RUST_SOURCE_BROAD_SUPPRESSION",
              message: "Broad Rust lint suppressions are not allowed."
            })
          );
        }
      }
    }
  }
  return diagnostics;
}

function isBroadSuppressionLint(lint: string): boolean {
  return broadSuppressionLints.has(lint) || lint === "unused" || lint.startsWith("unused_");
}

function matches(args: { path: string; content: string; pattern: RegExp; code: string; message: string }) {
  const diagnostics = [];
  args.pattern.lastIndex = 0;
  for (const _match of args.content.matchAll(args.pattern)) {
    diagnostics.push(
      diagnostic({
        category: "policy",
        path: args.path,
        code: args.code,
        message: args.message
      })
    );
  }
  return diagnostics;
}
