import type { ValidationCheckDefinition } from "@the-open-engine/lattice-validation";
import { TYPE_SCRIPT_SYNTAX_CHECK_ID } from "./check-ids.js";
import { createOverlayAwareTypeScriptProgram, repoSourceFiles } from "./compiler-host.js";
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
      const bundle = await createOverlayAwareTypeScriptProgram(context);
      const diagnostics = repoSourceFiles(bundle).flatMap((sourceFile) => bundle.program.getSyntacticDiagnostics(sourceFile));
      return {
        diagnostics: mapTypeScriptDiagnostics("syntax", diagnostics, bundle.repoRoot)
      };
    }
  };
}
