import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { TYPE_SCRIPT_TYPES_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { createOverlayAwareTypeScriptProgram, repoSourceFiles } from "./compiler-host.js";
import { mapTypeScriptDiagnostics } from "./diagnostics.js";

export function createTypeCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_TYPES_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedTypeScriptValidationScopes,
    run: async (context) => {
      const bundle = await createOverlayAwareTypeScriptProgram(context);
      const diagnostics = [
        ...bundle.configDiagnostics,
        ...bundle.program.getOptionsDiagnostics(),
        ...bundle.program.getGlobalDiagnostics(),
        ...repoSourceFiles(bundle).flatMap((sourceFile) => bundle.program.getSemanticDiagnostics(sourceFile))
      ];
      return {
        diagnostics: mapTypeScriptDiagnostics("types", diagnostics, bundle.repoRoot)
      };
    }
  };
}
