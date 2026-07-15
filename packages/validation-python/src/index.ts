import type { ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { createDeadCodeCheck } from "./dead-code-check.js";
import { createImportGraphCheck } from "./import-graph-check.js";
import { createRelevantTestsCheck } from "./relevant-tests-check.js";
import { createSourceHygieneCheck } from "./source-hygiene-check.js";
import { createSyntaxCheck, type PythonSyntaxCheckOptions } from "./syntax-check.js";
import { createPythonProjectContextResolver, pythonInputSet } from "./source-files.js";
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
export {
  resolvePythonProjectContext,
  resolvePythonProjectContexts,
  type ResolvePythonProjectContextsOptions
} from "./project-context.js";
export {
  createNodePythonProjectWorkspace,
  createValidationFileViewPythonWorkspace,
  type PythonProjectWorkspace,
  type PythonProjectWorkspaceRealpath
} from "./project-workspace.js";
export type { PythonProjectProcessProbe } from "./environment-resolution.js";
export { createPythonValidationAdapterStatus, type PythonValidationToolchainOptions } from "./toolchain.js";
export { createSyntaxCheck, type PythonSyntaxCheckOptions } from "./syntax-check.js";
export { createTypeCheck, type PythonTypeCheckOptions } from "./type-check.js";

export interface CreatePythonValidationChecksOptions extends PythonTypeCheckOptions, PythonSyntaxCheckOptions {}

export function createPythonValidationChecks(
  options: CreatePythonValidationChecksOptions = {}
): readonly ValidationCheckDefinition[] {
  const resolveContexts = createPythonProjectContextResolver({
    ...(options.contexts === undefined ? {} : { contexts: options.contexts }),
    ...(options.nodeWorkspace === undefined ? {} : { nodeWorkspace: options.nodeWorkspace }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.interpreterArgv === undefined ? {} : { interpreterArgv: options.interpreterArgv }),
    ...(options.toolArgv === undefined ? {} : { toolArgv: options.toolArgv }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
    ...(options.processProbe === undefined ? {} : { processProbe: options.processProbe }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  return [
    createSyntaxCheck(options, resolveContexts),
    createSourceHygieneCheck(),
    createTypeCheck(options, resolveContexts),
    createImportGraphCheck(resolveContexts),
    createDeadCodeCheck(),
    createRelevantTestsCheck()
  ].map((check) => withPythonProjectContexts(check, resolveContexts));
}

function withPythonProjectContexts(
  check: ValidationCheckDefinition,
  resolveContexts: ReturnType<typeof createPythonProjectContextResolver>
): ValidationCheckDefinition {
  return {
    ...check,
    run: async (context) => {
      const result = await check.run(context);
      if (pythonInputSet(context).length === 0) return result;
      const pythonProjectContexts = await resolveContexts(context);
      if (result === undefined) return { diagnostics: [], pythonProjectContexts };
      if (Array.isArray(result)) return { diagnostics: result as readonly ValidationDiagnostic[], pythonProjectContexts };
      return { ...(result as ValidationCheckResult), pythonProjectContexts };
    }
  };
}
