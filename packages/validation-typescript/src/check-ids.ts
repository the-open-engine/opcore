export const TYPE_SCRIPT_SYNTAX_CHECK_ID = "typescript.syntax";
export const TYPE_SCRIPT_TYPES_CHECK_ID = "typescript.types";
export const TYPE_SCRIPT_LINT_CHECK_ID = "typescript.lint";
export const TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID = "typescript.import-graph";
export const TYPE_SCRIPT_DEAD_CODE_CHECK_ID = "typescript.dead-code";
export const TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID = "typescript.function-metrics";
export const TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID = "typescript.relevant-tests";
export const TYPE_SCRIPT_FILE_LENGTH_CHECK_ID = "typescript.file-length";

export type TypeScriptValidationCheckId =
  | typeof TYPE_SCRIPT_SYNTAX_CHECK_ID
  | typeof TYPE_SCRIPT_TYPES_CHECK_ID
  | typeof TYPE_SCRIPT_LINT_CHECK_ID
  | typeof TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID
  | typeof TYPE_SCRIPT_DEAD_CODE_CHECK_ID
  | typeof TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID
  | typeof TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID
  | typeof TYPE_SCRIPT_FILE_LENGTH_CHECK_ID;
