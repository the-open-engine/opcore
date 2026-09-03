import type { PythonRuffValidationCapabilityRun, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition,
  ValidationCheckResult
} from "@the-open-engine/opcore-validation";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { inactivePythonCapabilityRun } from "./ruff-capability-run.js";
import {
  type PythonRuffCheckOptions,
  resolveRuffProjects,
  runResolvedRuffProjects,
  type RuffProjectExecution
} from "./ruff-check-shared.js";
import type { PythonProjectContextResolver, PythonSourceSetResolver } from "./source-files.js";

export type RuffExecutedProjectResult =
  | { status: "failed"; result: ValidationCheckResult }
  | {
      status: "passed";
      diagnostics: readonly ValidationDiagnostic[];
      pythonCapabilityRun: PythonRuffValidationCapabilityRun;
    };

export function createRuffCheckDefinition(args: {
  checkId: "python.ruff-lint" | "python.ruff-format";
  capability: "ruff_lint" | "ruff_format";
  kind: "lint" | "format";
  options: PythonRuffCheckOptions;
  resolveContexts?: PythonProjectContextResolver;
  resolveSources?: PythonSourceSetResolver;
  runProject: (
    project: RuffProjectExecution,
    context: ValidationCheckContext,
    options: PythonRuffCheckOptions
  ) => Promise<RuffExecutedProjectResult>;
}): ValidationCheckDefinition {
  return {
    id: args.checkId,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    defaultScopes: [],
    // WHY: an opt-in check that never ran must never read as a passing check, so the
    // inactive run stays skipped and carries only its non-execution receipt.
    inactiveResult: (_context, state) => ({
      status: "skipped",
      diagnostics: [],
      failureMessage: state === "disabled"
        ? `${args.checkId} is disabled by repository validation policy.`
        : `${args.checkId} was not requested; Ruff validation is opt-in.`,
      pythonCapabilityRuns: [inactivePythonCapabilityRun(args.checkId, args.capability, state)]
    }),
    run: async (context) => {
      const resolved = await resolveRuffProjects(args.kind, context, args.resolveContexts, args.resolveSources);
      if ("result" in resolved) return resolved.result;
      return runResolvedRuffProjects(context, resolved, (project) =>
        args.runProject(project, context, args.options)
      );
    }
  };
}
