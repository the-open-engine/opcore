import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { TYPE_SCRIPT_SYNTAX_CHECK_ID } from "./check-ids.js";
import {
  createOverlayAwareTypeScriptProgramIterator,
  emitTypeScriptProgramBuildInfo,
  repoSourceFiles
} from "./compiler-host.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { mapTypeScriptDiagnostics } from "./diagnostics.js";

export function createSyntaxCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_SYNTAX_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedTypeScriptValidationScopes,
    run: async (context) => {
      const diagnostics: ValidationDiagnostic[] = [];
      for await (const bundle of createOverlayAwareTypeScriptProgramIterator(context)) {
        diagnostics.push(
          ...mapTypeScriptDiagnostics(
            "syntax",
            repoSourceFiles(bundle).flatMap((sourceFile) =>
              (bundle.builderProgram ?? bundle.program).getSyntacticDiagnostics(sourceFile)
            ),
            bundle.repoRoot
          )
        );
        emitTypeScriptProgramBuildInfo(bundle);
      }
      return { diagnostics };
    }
  };
}
