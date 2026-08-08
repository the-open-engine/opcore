import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { relevantTestsGraphRequirements } from "./graph-requirements.js";
import { createRelevantTestEvidence } from "./relevant-tests-evidence.js";
import { materializeTypeScriptSources } from "./source-files.js";
import { isConventionalTypeScriptTestPath } from "./test-paths.js";

export function createRelevantTestsCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "info",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: true,
    graphRequirements: relevantTestsGraphRequirements,
    run: async (context) => {
      const [sourceSet, importsFrom, testedBy] = await Promise.all([
        materializeTypeScriptSources(context),
        context.graph.importsFrom(),
        context.graph.testedBy()
      ]);
      const relevantTestEvidence = createRelevantTestEvidence(importsFrom, testedBy);
      const sourcePaths = sourceSet.rootPaths.filter((path) => !isConventionalTypeScriptTestPath(path));
      const diagnostics = sourcePaths.flatMap((path): ValidationDiagnostic[] => {
        if (relevantTestEvidence(path).length > 0) return [];
        return [{
          category: "test",
          severity: "info",
          path,
          code: "TS_RELEVANT_TESTS_ABSENT",
          message: `No TESTED_BY graph evidence found for ${path}.`
        }];
      });
      return { diagnostics };
    }
  };
}
