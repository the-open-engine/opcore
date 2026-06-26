import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { createDeadCodeCheck } from "./dead-code-check.js";
import { createImportGraphCheck } from "./import-graph-check.js";
import { createRelevantTestsCheck } from "./relevant-tests-check.js";
import { createSyntaxCheck } from "./syntax-check.js";
import { createTypeCheck } from "./type-check.js";
export {
  TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
  TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
  TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
  TYPE_SCRIPT_SYNTAX_CHECK_ID,
  TYPE_SCRIPT_TYPES_CHECK_ID,
  type TypeScriptValidationCheckId
} from "./check-ids.js";

export const validationTypeScriptAdapterName = "typescript";

export function createTypeScriptValidationChecks(): readonly ValidationCheckDefinition[] {
  return [
    createSyntaxCheck(),
    createTypeCheck(),
    createImportGraphCheck(),
    createDeadCodeCheck(),
    createRelevantTestsCheck()
  ];
}
