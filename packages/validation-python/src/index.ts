import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { createDeadCodeCheck } from "./dead-code-check.js";
import { createImportGraphCheck } from "./import-graph-check.js";
import { createRelevantTestsCheck } from "./relevant-tests-check.js";
import { createSourceHygieneCheck } from "./source-hygiene-check.js";
import { createSyntaxCheck, type PythonSyntaxCheckOptions } from "./syntax-check.js";
import { createTypeCheck, type PythonTypeCheckOptions } from "./type-check.js";

export {
  PYTHON_DEAD_CODE_CHECK_ID,
  PYTHON_IMPORT_GRAPH_CHECK_ID,
  PYTHON_RELEVANT_TESTS_CHECK_ID,
  PYTHON_SOURCE_HYGIENE_CHECK_ID,
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_TYPES_CHECK_ID,
  pythonValidationCheckIds,
  type PythonValidationCheckId
} from "./check-ids.js";
export { validationPythonAdapterName } from "./check-constants.js";
export { isPythonSourcePath } from "./source-files.js";
export { createPythonValidationAdapterStatus, probePythonToolchain, type PythonValidationToolchainOptions } from "./toolchain.js";
export {
  resolvePythonInterpreter,
  resolvePythonTool,
  findPythonConfigFile,
  type PythonInterpreterResolution,
  type PythonInterpreterResolutionOutcome,
  type ResolvedPythonInterpreter,
  type UnresolvedPythonInterpreter,
  type PythonToolResolution,
  type PythonToolResolutionSource,
  type PythonToolResolverOptions
} from "./toolchain-resolver.js";
export { createSyntaxCheck, type PythonSyntaxCheckOptions } from "./syntax-check.js";
export { createTypeCheck, type PythonTypeCheckOptions } from "./type-check.js";

export interface CreatePythonValidationChecksOptions extends PythonTypeCheckOptions, PythonSyntaxCheckOptions {}

export function createPythonValidationChecks(
  options: CreatePythonValidationChecksOptions = {}
): readonly ValidationCheckDefinition[] {
  return [
    createSyntaxCheck(options),
    createSourceHygieneCheck(),
    createTypeCheck(options),
    createImportGraphCheck(),
    createDeadCodeCheck(),
    createRelevantTestsCheck()
  ];
}
