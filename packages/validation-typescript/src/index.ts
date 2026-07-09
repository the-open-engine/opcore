import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { createDeadCodeCheck } from "./dead-code-check.js";
import { createFileLengthCheck, type TypeScriptFileLengthThresholds } from "./file-length-check.js";
import { createFunctionMetricsCheck, type TypeScriptFunctionMetricThresholds } from "./function-metrics-check.js";
import { createImportGraphCheck } from "./import-graph-check.js";
import { createImportLayerRulesCheck, type TypeScriptImportLayerRulesOptions } from "./import-layer-rules-check.js";
import { createLintCheck } from "./lint-check.js";
import { createLintPluginCheck, type TypeScriptLintPluginOptions } from "./lint-plugin-check.js";
import { createRelevantTestsCheck } from "./relevant-tests-check.js";
import { createSyntaxCheck } from "./syntax-check.js";
import { createTypeCheck } from "./type-check.js";
import type { TypeScriptDeadCodeOptions } from "./dead-code-entrypoints.js";
export {
  TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
  TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID,
  TYPE_SCRIPT_FILE_LENGTH_CHECK_ID,
  TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
  TYPE_SCRIPT_IMPORT_LAYER_RULES_CHECK_ID,
  TYPE_SCRIPT_LINT_CHECK_ID,
  TYPE_SCRIPT_LINT_PLUGIN_CHECK_ID,
  TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
  TYPE_SCRIPT_SYNTAX_CHECK_ID,
  TYPE_SCRIPT_TYPES_CHECK_ID,
  type TypeScriptValidationCheckId
} from "./check-ids.js";
export { createFileLengthCheck, type TypeScriptFileLengthThresholds } from "./file-length-check.js";
export { createFunctionMetricsCheck, type TypeScriptFunctionMetricThresholds } from "./function-metrics-check.js";
export { createImportLayerRulesCheck, type TypeScriptImportLayerRule, type TypeScriptImportLayerRulesOptions } from "./import-layer-rules-check.js";
export { createDeadCodeCheck } from "./dead-code-check.js";
export type { TypeScriptDeadCodeOptions } from "./dead-code-entrypoints.js";
export { createLintPluginCheck, type TypeScriptLintPluginOptions } from "./lint-plugin-check.js";

export const validationTypeScriptAdapterName = "typescript";

export interface CreateTypeScriptValidationChecksOptions {
  functionMetrics?: TypeScriptFunctionMetricThresholds;
  fileLength?: TypeScriptFileLengthThresholds;
  lint?: TypeScriptLintPluginOptions;
  importGraph?: TypeScriptImportLayerRulesOptions;
  deadCode?: TypeScriptDeadCodeOptions;
}

export function createTypeScriptValidationChecks(
  options: CreateTypeScriptValidationChecksOptions = {}
): readonly ValidationCheckDefinition[] {
  return [
    createSyntaxCheck(),
    createTypeCheck(),
    createLintCheck(),
    ...(options.lint?.repoPlugin !== undefined ? [createLintPluginCheck(options.lint)] : []),
    createImportGraphCheck(),
    ...(options.importGraph?.layerRules !== undefined && options.importGraph.layerRules.length > 0
      ? [createImportLayerRulesCheck(options.importGraph)]
      : []),
    createDeadCodeCheck(options.deadCode),
    createFunctionMetricsCheck({
      thresholds: options.functionMetrics
    }),
    createRelevantTestsCheck(),
    createFileLengthCheck({
      thresholds: options.fileLength
    })
  ];
}
