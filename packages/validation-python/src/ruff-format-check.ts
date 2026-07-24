import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_RUFF_FORMAT_CHECK_ID } from "./check-ids.js";
import { diagnostic } from "./diagnostics.js";
import { relativeProjectPath } from "./python-execution-workspace.js";
import { pythonCapabilityRun } from "./ruff-capability-run.js";
import {
  createRuffCheckDefinition,
  type RuffExecutedProjectResult
} from "./ruff-check-definition.js";
import {
  type PythonRuffCheckOptions,
  ruffFailureResult,
  runSingleRuffProject,
  type RuffProjectInvocation
} from "./ruff-check-shared.js";
import {
  ruffCommandArgs,
  ruffExecutionProvenance,
  ruffRunEnv
} from "./ruff-execution.js";
import {
  formatCapabilityInvocations,
  refineFormatDriftPaths
} from "./ruff-format-refinement.js";
import { failedRuffInvocation } from "./ruff-invocation-failure.js";
import type { PythonProjectContextResolver, PythonSourceSetResolver } from "./source-files.js";

export type PythonRuffFormatCheckOptions = PythonRuffCheckOptions;

export function createRuffFormatCheck(
  options: PythonRuffCheckOptions = {},
  resolveContexts?: PythonProjectContextResolver,
  resolveSources?: PythonSourceSetResolver
): ValidationCheckDefinition {
  return createRuffCheckDefinition({
    checkId: PYTHON_RUFF_FORMAT_CHECK_ID,
    capability: "ruff_format",
    options,
    resolveContexts,
    resolveSources,
    kind: "format",
    runProject: (project, context, runOptions) =>
      runSingleRuffProject({
        checkId: PYTHON_RUFF_FORMAT_CHECK_ID,
        capability: "ruff_format",
        context,
        kind: "format",
        project,
        options: runOptions,
        createArgs: (projectContext, tool, targets) => ruffCommandArgs(tool, projectContext, "format", [
          "--check",
          "--no-cache",
          "--force-exclude",
          ...targets.map((path) => relativeProjectPath(path, projectContext.projectRoot))
        ]),
        execute: executeFormatInvocation
      })
  });
}

async function executeFormatInvocation(invocation: RuffProjectInvocation): Promise<RuffExecutedProjectResult> {
  const driftPaths = await refineFormatDriftPaths({
    tool: invocation.tool,
    project: invocation.projectContext,
    cwd: invocation.workspace.projectCwd,
    targets: invocation.targets,
    env: ruffRunEnv(invocation.options.env, invocation.tool, invocation.workspace),
    timeoutMs: invocation.options.timeoutMs ?? 30000
  });
  const result = driftPaths.invocation.result;
  const formatInvocations = formatCapabilityInvocations(invocation.tool.executable, driftPaths.invocations);
  const executedInvocation = { ...invocation, args: driftPaths.invocation.args };
  if ("failure" in driftPaths) {
    return failedRuffInvocation({
      kind: "format",
      invocation: executedInvocation,
      result,
      durationMs: driftPaths.durationMs,
      invocations: formatInvocations,
      failure: driftPaths.failure
    });
  }
  const diagnostics = driftPaths.paths.map((path) => diagnostic({
    category: "policy",
    severity: "warning",
    path,
    code: "PY_RUFF_FORMAT_DRIFT",
    message: `ruff format --check would reformat ${path}`,
    tool: ruffExecutionProvenance(invocation.tool, driftPaths.invocation.args, invocation.projectContext)
  }));
  return {
    status: "passed",
    diagnostics,
    pythonCapabilityRun: pythonCapabilityRun(
      PYTHON_RUFF_FORMAT_CHECK_ID,
      "ruff_format",
      diagnostics.length === 0 ? "passed" : "findings",
      {
        project: invocation.projectContext,
        workspace: invocation.workspace,
        tool: invocation.tool,
        argv: [invocation.tool.executable, ...driftPaths.invocation.args],
        invocations: formatInvocations,
        result,
        durationMs: driftPaths.durationMs,
        diagnosticCount: diagnostics.length
      }
    )
  };
}
