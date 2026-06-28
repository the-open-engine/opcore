import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import ts from "typescript";
import { TYPE_SCRIPT_TYPES_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import {
  createOverlayAwareTypeScriptProgramIterator,
  emitTypeScriptProgramBuildInfo,
  repoSourceFiles,
  toRepoRelativeCompilerPath
} from "./compiler-host.js";
import { mapTypeScriptDiagnostics } from "./diagnostics.js";

export interface CollectTypeScriptSemanticDiagnosticsArgs {
  repoRoot: string;
  sourceFiles: readonly ts.SourceFile[];
  getSemanticDiagnostics: (sourceFile: ts.SourceFile) => readonly ts.Diagnostic[];
}

const defaultTypeScriptTypeCheckScopes = supportedTypeScriptValidationScopes.filter(
  (scope) => scope !== "all" && scope !== "repo"
);

export function createTypeCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_TYPES_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedTypeScriptValidationScopes,
    defaultScopes: defaultTypeScriptTypeCheckScopes,
    run: async (context) => {
      const diagnostics: ValidationDiagnostic[] = [];
      for await (const bundle of createOverlayAwareTypeScriptProgramIterator(context)) {
        const diagnosticsProvider = bundle.builderProgram ?? bundle.program;
        diagnostics.push(
          ...mapTypeScriptDiagnostics(
            "types",
            [
              ...bundle.configDiagnostics,
              ...diagnosticsProvider.getOptionsDiagnostics(),
              ...diagnosticsProvider.getGlobalDiagnostics()
            ],
            bundle.repoRoot
          ),
          ...collectTypeScriptSemanticDiagnostics({
            repoRoot: bundle.repoRoot,
            sourceFiles: repoSourceFiles(bundle),
            getSemanticDiagnostics: (sourceFile) => diagnosticsProvider.getSemanticDiagnostics(sourceFile)
          })
        );
        emitTypeScriptProgramBuildInfo(bundle);
      }
      return { diagnostics };
    }
  };
}

export function collectTypeScriptSemanticDiagnostics(
  args: CollectTypeScriptSemanticDiagnosticsArgs
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const sourceFile of args.sourceFiles) {
    try {
      diagnostics.push(...mapTypeScriptDiagnostics("types", args.getSemanticDiagnostics(sourceFile), args.repoRoot));
    } catch (error) {
      diagnostics.push(typeScriptSemanticDiagnosticsFailure(args.repoRoot, sourceFile, error));
    }
  }
  return diagnostics;
}

function typeScriptSemanticDiagnosticsFailure(
  repoRoot: string,
  sourceFile: ts.SourceFile,
  error: unknown
): ValidationDiagnostic {
  const path = toRepoRelativeCompilerPath(sourceFile.fileName, repoRoot);
  const label = path === undefined || path.length === 0 ? sourceFile.fileName : path;
  const diagnostic: ValidationDiagnostic = {
    category: "types",
    severity: "error",
    code: "TS_SEMANTIC_DIAGNOSTICS_FAILED",
    message: `TypeScript semantic diagnostics failed for ${label}: ${errorMessage(error)}`
  };
  if (path !== undefined && path.length > 0) diagnostic.path = path;
  return diagnostic;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}
