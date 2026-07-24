import type { PythonValidationCapabilityInvocation } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { relativeProjectPath } from "./python-execution-workspace.js";
import { pythonCapabilityInvocation } from "./ruff-capability-run.js";
import { proveRuffConfigurationFailure } from "./ruff-config-proof.js";
import {
  ruffFailureResult,
  type RuffProjectInvocation
} from "./ruff-check-shared.js";
import {
  ruffProcessFailure,
  ruffRunEnv,
  type RuffCheckKind
} from "./ruff-execution.js";
import type { RuffExecutedProjectResult } from "./ruff-check-definition.js";
import type { PythonToolRunResult } from "./process.js";

export async function failedRuffInvocation(args: {
  kind: RuffCheckKind;
  invocation: RuffProjectInvocation;
  result: PythonToolRunResult;
  durationMs: number;
  invocations: readonly PythonValidationCapabilityInvocation[];
  failure?: ValidationCheckResult;
}): Promise<RuffExecutedProjectResult> {
  const { durationMs, invocation, kind, result } = args;
  const proof = result.termination === "exited" && result.exitCode === 2
    ? await proveRuffConfigurationFailure({
        kind,
        tool: invocation.tool,
        project: invocation.projectContext,
        configPaths: invocation.workspace.configPaths,
        cwd: invocation.workspace.projectCwd,
        env: ruffRunEnv(invocation.options.env, invocation.tool, invocation.workspace),
        target: relativeProjectPath(invocation.targets[0], invocation.projectContext.projectRoot),
        timeoutMs: (invocation.options.timeoutMs ?? 30000) - durationMs
      })
    : undefined;
  const proofInvocation = proof === undefined
    ? []
    : [pythonCapabilityInvocation(invocation.tool.executable, proof.args, proof.result, proof.durationMs)];
  return proof?.failure === undefined
    ? ruffFailureResult({
        kind,
        invocation,
        result,
        durationMs: durationMs + (proof?.durationMs ?? 0),
        failure: args.failure ?? ruffProcessFailure(kind, invocation.tool, result, invocation.projectContext),
        invocations: [...args.invocations, ...proofInvocation]
      })
    : ruffFailureResult({
        kind,
        invocation: { ...invocation, args: proof.args },
        result: proof.result,
        durationMs: durationMs + proof.durationMs,
        failure: proof.failure,
        invocations: [...args.invocations, ...proofInvocation]
      });
}
