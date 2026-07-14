import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { TYPE_SCRIPT_DEAD_CODE_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import type { TypeScriptDeadCodeOptions } from "./dead-code-entrypoints.js";
import { deadCodeGraphRequirements } from "./graph-requirements.js";
import { runTypeScriptDeadCodeCheck } from "./dead-code-run.js";

export function createDeadCodeCheck(options: TypeScriptDeadCodeOptions = {}): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: true,
    graphRequirements: deadCodeGraphRequirements,
    run: (context) => runTypeScriptDeadCodeCheck(context, options)
  };
}
