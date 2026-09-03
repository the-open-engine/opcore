import type { ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { PYTHON_RUFF_LINT_CHECK_ID } from "./check-ids.js";
import { diagnostic } from "./diagnostics.js";
import { runTool } from "./process.js";
import { relativeProjectPath } from "./python-execution-workspace.js";
import {
  pythonCapabilityInvocation,
  pythonCapabilityRun
} from "./ruff-capability-run.js";
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
import { failedRuffInvocation } from "./ruff-invocation-failure.js";
import { parseRuffLintDiagnostics } from "./ruff-lint-output.js";
import type { PythonProjectContextResolver, PythonSourceSetResolver } from "./source-files.js";

export type PythonRuffLintCheckOptions = PythonRuffCheckOptions;

export function createRuffLintCheck(
  options: PythonRuffCheckOptions = {},
  resolveContexts?: PythonProjectContextResolver,
  resolveSources?: PythonSourceSetResolver
): ValidationCheckDefinition {
  return createRuffCheckDefinition({
    checkId: PYTHON_RUFF_LINT_CHECK_ID,
    capability: "ruff_lint",
    options,
    resolveContexts,
    resolveSources,
    kind: "lint",
    runProject: (project, context, runOptions) =>
      runSingleRuffProject({
        checkId: PYTHON_RUFF_LINT_CHECK_ID,
        capability: "ruff_lint",
        context,
        kind: "lint",
        project,
        options: runOptions,
        createArgs: (projectContext, tool, targets) => ruffCommandArgs(tool, projectContext, "check", [
          "--output-format=json",
          "--no-fix",
          "--no-cache",
          "--force-exclude",
          ...targets.map((path) => relativeProjectPath(path, projectContext.projectRoot))
        ]),
        execute: executeLintInvocation
      })
  });
}

async function executeLintInvocation(invocation: RuffProjectInvocation): Promise<RuffExecutedProjectResult> {
  const startedAt = Date.now();
  const result = await runTool(invocation.tool.executable, invocation.args, {
    cwd: invocation.workspace.projectCwd,
    env: ruffRunEnv(invocation.options.env, invocation.tool, invocation.workspace),
    timeoutMs: invocation.options.timeoutMs ?? 30000,
    allowedExitCodes: [0, 1]
  });
  const durationMs = Math.max(1, Date.now() - startedAt);
  const evidence = [pythonCapabilityInvocation(invocation.tool.executable, invocation.args, result, durationMs)];
  if (!result.ok) {
    return failedRuffInvocation({
      kind: "lint",
      invocation,
      result,
      durationMs,
      invocations: evidence
    });
  }
  const provenance = ruffExecutionProvenance(invocation.tool, invocation.args, invocation.projectContext);
  const parsed = parseRuffLintDiagnostics(result.stdout, provenance, invocation.workspace);
  if (parsed.status === "malformed") {
    return ruffFailureResult({
      kind: "lint",
      invocation,
      result,
      durationMs,
      failure: malformedLintResult(parsed.message, provenance),
      invocations: evidence
    });
  }
  if (lintOutputContradictsExit(result.exitCode, parsed.diagnostics.length)) {
    return ruffFailureResult({
      kind: "lint",
      invocation,
      result,
      durationMs,
      failure: malformedLintResult(
        `ruff lint exit ${result.exitCode} contradicted its JSON diagnostic count ${parsed.diagnostics.length}`,
        provenance
      ),
      invocations: evidence
    });
  }
  return {
    status: "passed",
    diagnostics: parsed.diagnostics,
    pythonCapabilityRun: pythonCapabilityRun(
      PYTHON_RUFF_LINT_CHECK_ID,
      "ruff_lint",
      parsed.diagnostics.length === 0 ? "passed" : "findings",
      {
        project: invocation.projectContext,
        workspace: invocation.workspace,
        tool: invocation.tool,
        argv: [invocation.tool.executable, ...invocation.args],
        invocations: evidence,
        result,
        durationMs,
        diagnosticCount: parsed.diagnostics.length
      }
    )
  };
}

function lintOutputContradictsExit(exitCode: number | null, diagnosticCount: number): boolean {
  return (exitCode === 0 && diagnosticCount > 0) || (exitCode === 1 && diagnosticCount === 0);
}

function malformedLintResult(
  message: string,
  provenance: ReturnType<typeof ruffExecutionProvenance>
): ValidationCheckResult {
  return {
    outcome: "tool_failure",
    failureMessage: message,
    diagnostics: [diagnostic({
      category: "infrastructure",
      code: "PY_RUFF_LINT_TOOL_FAILED",
      message,
      tool: provenance
    })]
  };
}
