export const PYTHON_SYNTAX_CHECK_ID = "python.syntax";
export const PYTHON_SOURCE_HYGIENE_CHECK_ID = "python.source-hygiene";
export const PYTHON_RUFF_LINT_CHECK_ID = "python.ruff-lint";
export const PYTHON_RUFF_FORMAT_CHECK_ID = "python.ruff-format";
export const PYTHON_TYPES_CHECK_ID = "python.types";
export const PYTHON_IMPORT_GRAPH_CHECK_ID = "python.import-graph";
export const PYTHON_DEAD_CODE_CHECK_ID = "python.dead-code";
export const PYTHON_RELEVANT_TESTS_CHECK_ID = "python.relevant-tests";

export const pythonValidationCheckIds = [
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_SOURCE_HYGIENE_CHECK_ID,
  PYTHON_RUFF_LINT_CHECK_ID,
  PYTHON_RUFF_FORMAT_CHECK_ID,
  PYTHON_TYPES_CHECK_ID,
  PYTHON_IMPORT_GRAPH_CHECK_ID,
  PYTHON_DEAD_CODE_CHECK_ID,
  PYTHON_RELEVANT_TESTS_CHECK_ID
] as const;

export type PythonValidationCheckId = (typeof pythonValidationCheckIds)[number];
