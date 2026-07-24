import type { ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import {
  PYTHON_RELEVANT_TESTS_CHECK_ID,
  PYTHON_RUFF_FORMAT_CHECK_ID,
  PYTHON_RUFF_LINT_CHECK_ID,
  PYTHON_TYPES_CHECK_ID
} from "./check-ids.js";
import { createDeadCodeCheck } from "./dead-code-check.js";
import { createImportGraphCheck } from "./import-graph-check.js";
import { createRelevantTestsCheck } from "./relevant-tests-check.js";
import { createRuffFormatCheck, type PythonRuffFormatCheckOptions } from "./ruff-format-check.js";
import { createRuffLintCheck, type PythonRuffLintCheckOptions } from "./ruff-lint-check.js";
import { createSourceHygieneCheck } from "./source-hygiene-check.js";
import { createSyntaxCheck, type PythonSyntaxCheckOptions } from "./syntax-check.js";
import { createPythonProjectContextResolver, createPythonSourceRootResolver, createPythonSourceSetResolver, pythonInputSet } from "./source-files.js";
import { createTypeCheck, type PythonTypeCheckOptions } from "./type-check.js";
import type { PythonImportAnalyzer } from "./import-analysis.js";

export {
  PYTHON_DEAD_CODE_CHECK_ID,
  PYTHON_IMPORT_GRAPH_CHECK_ID,
  PYTHON_RELEVANT_TESTS_CHECK_ID,
  PYTHON_RUFF_FORMAT_CHECK_ID,
  PYTHON_RUFF_LINT_CHECK_ID,
  PYTHON_SOURCE_HYGIENE_CHECK_ID,
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_TYPES_CHECK_ID,
  pythonValidationCheckIds,
  type PythonValidationCheckId
} from "./check-ids.js";
export { validationPythonAdapterName } from "./check-constants.js";
export { isPythonSourcePath } from "./source-files.js";
export type { PythonImportAnalyzer, PythonImportEdge, PythonImportSourceFile } from "./import-analysis.js";
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
export {
  createRuffFormatCheck,
  type PythonRuffFormatCheckOptions
} from "./ruff-format-check.js";
export {
  createRuffLintCheck,
  type PythonRuffLintCheckOptions
} from "./ruff-lint-check.js";
export { createSyntaxCheck, type PythonSyntaxCheckOptions } from "./syntax-check.js";
export { createTypeCheck, type PythonTypeCheckOptions } from "./type-check.js";

export interface CreatePythonValidationChecksOptions
  extends PythonTypeCheckOptions, PythonSyntaxCheckOptions, PythonRuffLintCheckOptions, PythonRuffFormatCheckOptions {
  importAnalyzer?: PythonImportAnalyzer;
}

export function createPythonValidationChecks(
  options: CreatePythonValidationChecksOptions = {}
): readonly ValidationCheckDefinition[] {
  const resolveContexts = createPythonProjectContextResolver({
    ...(options.nodeWorkspace === undefined ? {} : { nodeWorkspace: options.nodeWorkspace }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.interpreterArgv === undefined ? {} : { interpreterArgv: options.interpreterArgv }),
    ...(options.toolArgv === undefined ? {} : { toolArgv: options.toolArgv }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
    ...(options.processProbe === undefined ? {} : { processProbe: options.processProbe }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  const resolveSources = createPythonSourceSetResolver(options.importAnalyzer, resolveContexts);
  const resolveRoots = createPythonSourceRootResolver();
  return [
    createSyntaxCheck(options, resolveContexts),
    createSourceHygieneCheck(),
    createRuffLintCheck(options, resolveContexts, resolveSources),
    createRuffFormatCheck(options, resolveContexts, resolveSources),
    createTypeCheck(options, resolveContexts, resolveSources),
    createImportGraphCheck(resolveSources),
    createDeadCodeCheck(resolveRoots),
    createRelevantTestsCheck(resolveRoots)
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
      const pythonProjectContexts = await resolveContexts(context, undefined, toolKindsForExecution(context.selectedCheckIds, check.id));
      if (result === undefined) return { diagnostics: [], pythonProjectContexts };
      if (Array.isArray(result)) return { diagnostics: result as readonly ValidationDiagnostic[], pythonProjectContexts };
      return { ...(result as ValidationCheckResult), pythonProjectContexts };
    }
  };
}

function toolKindsForCheck(checkId: string): readonly ("mypy" | "pyright" | "ruff" | "pytest")[] {
  if (checkId === PYTHON_RUFF_LINT_CHECK_ID || checkId === PYTHON_RUFF_FORMAT_CHECK_ID) return ["ruff"];
  if (checkId === PYTHON_TYPES_CHECK_ID) return ["mypy", "pyright"];
  if (checkId === PYTHON_RELEVANT_TESTS_CHECK_ID) return ["pytest"];
  return [];
}

function toolKindsForExecution(
  requestedChecks: readonly string[] | undefined,
  checkId: string
): readonly ("mypy" | "pyright" | "ruff" | "pytest")[] {
  const current = toolKindsForCheck(checkId);
  if (current.length === 0 || requestedChecks === undefined) return current;
  return [...new Set(requestedChecks.flatMap((requestedCheckId) => toolKindsForCheck(requestedCheckId)))];
}
