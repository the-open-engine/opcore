import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_SOURCE_HYGIENE_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { readPythonAfterSources, skippedPythonInputResult } from "./source-files.js";

const typeIgnorePattern = /#\s*type:\s*ignore(?:\b|\[)/iu;
const broadNoqaPattern = /#\s*(?:ruff:\s*)?noqa(?:\s*$|(?::\s*$))/iu;
const formatterDisabledPattern = /#\s*(?:fmt:\s*off|yapf:\s*disable|autopep8:\s*off)\b/iu;
const pylintDisableAllPattern = /#\s*pylint:\s*disable\s*=\s*(?:all|.*\ball\b)/iu;

export function createSourceHygieneCheck(): ValidationCheckDefinition {
  return {
    id: PYTHON_SOURCE_HYGIENE_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedPythonValidationScopes,
    run: async (context) => {
      const skipped = skippedPythonInputResult(context);
      if (skipped !== undefined) return skipped;
      const diagnostics: ValidationDiagnostic[] = [];
      for (const source of await readPythonAfterSources(context)) {
        diagnostics.push(...sourceHygieneDiagnostics(source.path, source.content));
      }
      return { diagnostics: sortDiagnostics(diagnostics) };
    }
  };
}

function sourceHygieneDiagnostics(path: string, content: string): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (formatterDisabledPattern.test(line)) {
      diagnostics.push(
        diagnostic({
          category: "policy",
          path,
          code: "PY_SOURCE_FORMATTER_DISABLED",
          message: "Python formatter disable comments are not allowed in validation input."
        })
      );
    }
    if (broadNoqaPattern.test(line)) {
      diagnostics.push(
        diagnostic({
          category: "policy",
          path,
          code: "PY_SOURCE_NOQA_BROAD",
          message: "Broad Python noqa suppressions must name the suppressed rule."
        })
      );
    }
    if (typeIgnorePattern.test(line)) {
      diagnostics.push(
        diagnostic({
          category: "policy",
          path,
          code: "PY_SOURCE_TYPE_IGNORE",
          message: "Python type-ignore suppressions are not allowed in validation input."
        })
      );
    }
    if (pylintDisableAllPattern.test(line)) {
      diagnostics.push(
        diagnostic({
          category: "policy",
          path,
          code: "PY_SOURCE_PYLINT_DISABLE_ALL",
          message: "Broad Python pylint disable-all suppressions are not allowed."
        })
      );
    }
  }
  return diagnostics;
}
