import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_TYPES_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { materializePythonSources } from "./source-files.js";
import { probePythonToolchain, type PythonValidationToolchainOptions } from "./toolchain.js";

export interface PythonTypeCheckOptions extends PythonValidationToolchainOptions {}

export function createTypeCheck(options: PythonTypeCheckOptions = {}): ValidationCheckDefinition {
  return {
    id: PYTHON_TYPES_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    run: async (context) => {
      const sourceSet = await materializePythonSources(context);
      if (sourceSet.files.length === 0) return { diagnostics: [] };
      const repoRoot = context.request.repo.repoRoot ?? process.cwd();
      const toolchain = probePythonToolchain({ ...options, repoRoot });
      const hasTypeChecker = toolchain.some((tool) => (tool.tool === "mypy" || tool.tool === "pyright") && tool.available);
      if (!hasTypeChecker) {
        return {
          status: "unsupported_request",
          diagnostics: [
            {
              category: "types",
              severity: "info",
              code: "PYTHON_TYPES_UNSUPPORTED",
              message: "Python type validation requires mypy or pyright; neither tool is available."
            }
          ]
        };
      }
      return {
        status: "skipped",
        diagnostics: [
          {
            category: "types",
            severity: "info",
            code: "PYTHON_TYPES_DEFERRED",
            message: "Python type validation tool execution is deferred to a follow-up adapter hardening pass."
          }
        ]
      };
    }
  };
}
