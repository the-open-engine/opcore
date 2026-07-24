import type { PythonProjectContext, PythonValidationCapabilityInvocation, PythonRuffValidationCapabilityRun, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { PYTHON_RUFF_FORMAT_CHECK_ID, PYTHON_RUFF_LINT_CHECK_ID } from "./check-ids.js";
import { groupPythonProjectContexts } from "./project-groups.js";
import type { PythonToolRunResult } from "./process.js";
import type {
  MaterializedPythonExecutionWorkspace,
  PythonExecutionWorkspaceEvidence
} from "./python-execution-workspace.js";
import {
  materializePythonExecutionWorkspace,
  PythonExecutionWorkspaceConfigError
} from "./ruff-execution-workspace.js";
import { sortDiagnostics } from "./diagnostics.js";
import { inactivePythonCapabilityRun, pythonCapabilityRun } from "./ruff-capability-run.js";
import {
  hasUnresolvedRuffContext,
  missingRuffContextResult,
  ruffConfigurationFailure,
  ruffContextFailure,
  selectRuffTool
} from "./ruff-execution.js";
import {
  pythonInputSet,
  selectPythonSourceFilesForTargets,
  skippedPythonInputResult,
  type PythonMaterializedSourceFile,
  type PythonProjectContextResolver,
  type PythonSourceSetResolver
} from "./source-files.js";
import type { PythonValidationToolchainOptions } from "./toolchain.js";

export interface PythonRuffCheckOptions extends Omit<PythonValidationToolchainOptions, "contexts"> {
  timeoutMs?: number;
}

export interface RuffResolvedProjects {
  contexts: readonly PythonProjectContext[];
  sourceSet: Awaited<ReturnType<NonNullable<PythonSourceSetResolver>>>;
  resolveContexts: PythonProjectContextResolver;
}

export interface RuffProjectExecution {
  projectContext: PythonProjectContext;
  targets: readonly string[];
  sourceFiles: readonly PythonMaterializedSourceFile[];
}

export interface RuffProjectInvocation {
  projectContext: PythonProjectContext;
  workspace: MaterializedPythonExecutionWorkspace;
  tool: NonNullable<ReturnType<typeof selectRuffTool>>;
  args: readonly string[];
  targets: readonly string[];
  options: PythonRuffCheckOptions;
}

export interface RuffFailureReceipt {
  checkId: PythonRuffValidationCapabilityRun["checkId"];
  capability: PythonRuffValidationCapabilityRun["capability"];
  projectContext: PythonProjectContext;
  workspace: MaterializedPythonExecutionWorkspace;
  tool: NonNullable<ReturnType<typeof selectRuffTool>>;
  args: readonly string[];
  invocations?: readonly PythonValidationCapabilityInvocation[];
  result: PythonToolRunResult;
  durationMs: number;
  diagnosticCount: number;
  failure: ValidationCheckResult;
}

type RuffProjectResult =
  | { status: "failed"; result: ValidationCheckResult }
  | { status: "passed"; diagnostics: readonly ValidationDiagnostic[]; pythonCapabilityRun: PythonRuffValidationCapabilityRun };

export async function resolveRuffProjects(
  kind: "lint" | "format",
  context: ValidationCheckContext,
  resolveContexts: PythonProjectContextResolver | undefined,
  resolveSources: PythonSourceSetResolver | undefined
): Promise<RuffResolvedProjects | { result: ValidationCheckResult }> {
  const skipped = skippedPythonInputResult(context);
  if (skipped !== undefined) return { result: skipped };
  if (resolveContexts === undefined) return { result: missingRuffContextResult(kind, pythonInputSet(context)) };
  if (resolveSources === undefined) throw new Error(`A shared Python source-set resolver is required for Ruff ${kind} validation`);
  const sourceSet = await resolveSources(context);
  if (sourceSet.rootPaths.length === 0) {
    const capability = kind === "lint"
      ? { checkId: PYTHON_RUFF_LINT_CHECK_ID as "python.ruff-lint", name: "ruff_lint" as const }
      : { checkId: PYTHON_RUFF_FORMAT_CHECK_ID as "python.ruff-format", name: "ruff_format" as const };
    return {
      result: {
        status: "skipped",
        diagnostics: [],
        failureMessage: "No Python after-state source files were selected.",
        pythonCapabilityRuns: [inactivePythonCapabilityRun(capability.checkId, capability.name, "not_applicable")]
      }
    };
  }
  const contexts = await resolveContexts(context, undefined, ["ruff"]);
  const missing = sourceSet.rootPaths.filter((path) => !contexts.some((candidate) => candidate.target === path));
  if (contexts.length === 0 || missing.length > 0) return { result: missingRuffContextResult(kind, missing) };
  return { contexts, sourceSet, resolveContexts };
}

function ruffContextFailureWithReceipt(
  kind: "lint" | "format",
  context: PythonProjectContext,
  workspace: PythonExecutionWorkspaceEvidence
): ValidationCheckResult {
  const failure = ruffContextFailure(kind, context);
  const tool = context.tools.find((entry) => entry.tool === "ruff");
  const config = kind === "lint"
    ? { checkId: "python.ruff-lint" as const, capability: "ruff_lint" as const }
    : { checkId: "python.ruff-format" as const, capability: "ruff_format" as const };
  return {
    ...failure,
    pythonCapabilityRuns: [pythonCapabilityRun(
      config.checkId,
      config.capability,
      failure.outcome ?? "tool_failure",
      {
        project: context,
        workspace,
        ...(tool === undefined ? {} : { tool }),
        durationMs: 0,
        diagnosticCount: failure.diagnostics?.length ?? 0,
        failureMessage: failure.failureMessage
      }
    )]
  };
}

export async function runResolvedRuffProjects(
  context: ValidationCheckContext,
  resolved: RuffResolvedProjects,
  executeProject: (
    project: RuffProjectExecution
  ) => Promise<RuffProjectResult>
): Promise<ValidationCheckResult> {
  const diagnostics: ValidationDiagnostic[] = [];
  const pythonCapabilityRuns: PythonRuffValidationCapabilityRun[] = [];
  const failures: ValidationCheckResult[] = [];
  for (const project of groupPythonProjectContexts(resolved.contexts)) {
    const result = await executeProject({
      projectContext: project.context,
      targets: project.targets,
      sourceFiles: await selectPythonSourceFilesForTargets(
        context,
        resolved.sourceSet,
        resolved.resolveContexts,
        project.targets
      )
    });
    if (result.status === "failed") {
      failures.push(result.result);
      diagnostics.push(...(result.result.diagnostics ?? []));
      for (const run of result.result.pythonCapabilityRuns ?? []) {
        if (run.capability !== "ruff_lint" && run.capability !== "ruff_format") {
          throw new Error(`Ruff validation returned unrelated Python capability evidence: ${run.capability}`);
        }
        pythonCapabilityRuns.push(run);
      }
    } else {
      diagnostics.push(...result.diagnostics);
      pythonCapabilityRuns.push(result.pythonCapabilityRun);
    }
  }
  if (failures.length > 0) {
    const primaryFailure = failures.reduce((selected, candidate) =>
      ruffFailureRank(candidate) > ruffFailureRank(selected) ? candidate : selected
    );
    return {
      ...primaryFailure,
      diagnostics: sortDiagnostics(diagnostics),
      pythonCapabilityRuns
    };
  }
  return {
    outcome: diagnostics.length === 0 ? "passed" : "findings",
    diagnostics: sortDiagnostics(diagnostics),
    pythonCapabilityRuns
  };
}

export async function runSingleRuffProject(
  args: {
    checkId: PythonRuffValidationCapabilityRun["checkId"];
    capability: PythonRuffValidationCapabilityRun["capability"];
    context: ValidationCheckContext;
    kind: "lint" | "format";
    project: RuffProjectExecution;
    options: PythonRuffCheckOptions;
    createArgs: (projectContext: PythonProjectContext, tool: NonNullable<ReturnType<typeof selectRuffTool>>, targets: readonly string[]) => readonly string[];
    execute: (invocation: RuffProjectInvocation) => RuffProjectResult | Promise<RuffProjectResult>;
  }
): Promise<RuffProjectResult> {
  const { capability, checkId, context, createArgs, execute, kind, options, project } = args;
  const { projectContext, sourceFiles, targets } = project;
  const selectedRuff = selectRuffTool(projectContext);
  const ruffEvidence = selectedRuff ?? projectContext.tools.find((entry) => entry.tool === "ruff");
  let workspace: MaterializedPythonExecutionWorkspace;
  try {
    workspace = await materializePythonExecutionWorkspace(
      context,
      { context: projectContext, targets },
      sourceFiles,
      options.nodeWorkspace
    );
  } catch (error) {
    if (!(error instanceof PythonExecutionWorkspaceConfigError)) throw error;
    if (ruffEvidence === undefined) {
      const contextFailure = ruffContextFailure(kind, projectContext);
      return {
        status: "failed",
        result: {
          ...contextFailure,
          pythonCapabilityRuns: [pythonCapabilityRun(checkId, capability, "tool_failure", {
            project: projectContext,
            workspace: error.workspaceEvidence,
            durationMs: 0,
            diagnosticCount: contextFailure.diagnostics?.length ?? 0,
            failureMessage: error.message
          })]
        }
      };
    }
    const failure = ruffConfigurationFailure(kind, ruffEvidence, error.message, error.configPath);
    return {
      status: "failed",
      result: {
        ...failure,
        pythonCapabilityRuns: [pythonCapabilityRun(checkId, capability, "invalid_config", {
          project: projectContext,
          workspace: error.workspaceEvidence,
          tool: ruffEvidence,
          ...(error.configPaths.includes(error.configPath) ? { configPath: error.configPath } : {}),
          durationMs: 0,
          diagnosticCount: failure.diagnostics?.length ?? 0,
          failureMessage: error.message
        })]
      }
    };
  }
  try {
    if (hasUnresolvedRuffContext(projectContext) || selectedRuff === undefined) {
      return {
        status: "failed",
        result: ruffContextFailureWithReceipt(kind, projectContext, workspace)
      };
    }
    return await execute({
      projectContext,
      workspace,
      tool: selectedRuff,
      args: createArgs(projectContext, selectedRuff, targets),
      targets,
      options
    });
  } finally {
    workspace.cleanup();
  }
}

function ruffFailureRank(result: ValidationCheckResult): number {
  if (result.outcome === "timeout" || result.outcome === "tool_failure") return 3;
  if (
    result.outcome === "invalid_config" ||
    result.outcome === "tool_unavailable" ||
    result.outcome === "unsupported_target"
  ) {
    return 2;
  }
  return result.status === "infrastructure_failure" || result.status === "provider_failure"
    ? 3
    : result.status === "unsupported_request"
      ? 2
      : 1;
}

export function ruffFailureWithReceipt(receipt: RuffFailureReceipt): ValidationCheckResult {
  return {
    ...receipt.failure,
    pythonCapabilityRuns: [pythonCapabilityRun(receipt.checkId, receipt.capability, receipt.failure.outcome ?? "tool_failure", {
      project: receipt.projectContext,
      workspace: receipt.workspace,
      tool: receipt.tool,
      argv: [receipt.tool.executable, ...receipt.args],
      ...(receipt.invocations === undefined || receipt.invocations.length === 0
        ? {}
        : { invocations: receipt.invocations }),
      result: receipt.result,
      durationMs: receipt.durationMs,
      diagnosticCount: receipt.diagnosticCount,
      failureMessage: receipt.failure.failureMessage
    })]
  };
}

export function ruffFailureResult(args: {
  kind: "lint" | "format";
  invocation: RuffProjectInvocation;
  result: PythonToolRunResult;
  durationMs: number;
  failure: ValidationCheckResult;
  invocations: readonly PythonValidationCapabilityInvocation[];
}): { status: "failed"; result: ValidationCheckResult } {
  const config = args.kind === "lint"
    ? { checkId: PYTHON_RUFF_LINT_CHECK_ID as "python.ruff-lint", capability: "ruff_lint" as const }
    : { checkId: PYTHON_RUFF_FORMAT_CHECK_ID as "python.ruff-format", capability: "ruff_format" as const };
  return {
    status: "failed",
    result: ruffFailureWithReceipt({
      checkId: config.checkId,
      capability: config.capability,
      projectContext: args.invocation.projectContext,
      workspace: args.invocation.workspace,
      tool: args.invocation.tool,
      args: args.invocation.args,
      invocations: args.invocations,
      result: args.result,
      durationMs: args.durationMs,
      diagnosticCount: 0,
      failure: args.failure
    })
  };
}
