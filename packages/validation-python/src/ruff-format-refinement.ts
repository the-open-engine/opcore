import type {
  PythonProjectContext,
  PythonValidationCapabilityInvocation
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { runTool, type PythonToolRunResult } from "./process.js";
import { relativeProjectPath } from "./python-execution-workspace.js";
import { pythonCapabilityInvocation } from "./ruff-capability-run.js";
import { ruffCommandArgs, ruffProcessFailure, selectRuffTool } from "./ruff-execution.js";

const formatBatchSize = 64;
const maxFormatInvocations = 512;

export interface RuffFormatRefinement {
  tool: NonNullable<ReturnType<typeof selectRuffTool>>;
  project: Pick<PythonProjectContext, "projectRoot" | "repositoryRoot">;
  cwd: string;
  targets: readonly string[];
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

export interface RuffFormatInvocationEvidence {
  args: readonly string[];
  result: PythonToolRunResult;
  durationMs: number;
}

export async function refineFormatDriftPaths(
  refinement: RuffFormatRefinement
): Promise<
  | {
      paths: readonly string[];
      invocation: RuffFormatInvocationEvidence;
      invocations: readonly RuffFormatInvocationEvidence[];
      durationMs: number;
      invocationCount: number;
    }
  | {
      failure: ValidationCheckResult;
      invocation: RuffFormatInvocationEvidence;
      invocations: readonly RuffFormatInvocationEvidence[];
      durationMs: number;
      invocationCount: number;
    }
> {
  if (refinement.targets.length === 0) throw new Error("Ruff format refinement requires at least one target");
  const state: RuffFormatRefinementState = {
    startedAt: Date.now(),
    deadline: Date.now() + refinement.timeoutMs,
    invocationCount: 0,
    invocations: []
  };
  const paths: string[] = [];
  for (let index = 0; index < refinement.targets.length; index += formatBatchSize) {
    const batch = refinement.targets.slice(index, index + formatBatchSize);
    const result = await refineFormatBatch(refinement, batch, state);
    if ("failure" in result) {
      return {
        ...result,
        invocations: state.invocations,
        durationMs: Math.max(1, Date.now() - state.startedAt),
        invocationCount: state.invocationCount
      };
    }
    paths.push(...result.paths);
  }
  if (state.representative === undefined) throw new Error("Ruff format refinement produced no execution evidence");
  return {
    paths: [...new Set(paths)].sort((a, b) => a.localeCompare(b)),
    invocation: state.representative,
    invocations: state.invocations,
    durationMs: Math.max(1, Date.now() - state.startedAt),
    invocationCount: state.invocationCount
  };
}

interface RuffFormatRefinementState {
  startedAt: number;
  deadline: number;
  invocationCount: number;
  invocations: RuffFormatInvocationEvidence[];
  representative?: RuffFormatInvocationEvidence;
}

async function refineFormatBatch(
  refinement: RuffFormatRefinement,
  targets: readonly string[],
  state: RuffFormatRefinementState
): Promise<{ paths: readonly string[] } | { failure: ValidationCheckResult; invocation: RuffFormatInvocationEvidence }> {
  const args = ruffCommandArgs(refinement.tool, refinement.project, "format", [
    "--check",
    "--no-cache",
    "--force-exclude",
    ...targets.map((path) => relativeProjectPath(path, refinement.project.projectRoot))
  ]);
  if (state.invocationCount >= maxFormatInvocations) {
    return boundedFailure(refinement, state, args, "overflow", `ruff format exceeded ${maxFormatInvocations} bounded invocations`);
  }
  const remainingMs = state.deadline - Date.now();
  if (remainingMs <= 0) {
    return boundedFailure(refinement, state, args, "timeout", `ruff format exceeded its ${refinement.timeoutMs}ms total time bound`);
  }
  state.invocationCount += 1;
  const invocationStartedAt = Date.now();
  const result = await runTool(refinement.tool.executable, args, {
    cwd: refinement.cwd,
    env: refinement.env,
    timeoutMs: Math.max(1, Math.min(refinement.timeoutMs, remainingMs)),
    allowedExitCodes: [0, 1]
  });
  const invocation = {
    args,
    result,
    durationMs: Math.max(1, Date.now() - invocationStartedAt)
  };
  state.invocations.push(invocation);
  if (state.representative === undefined || (state.representative.result.exitCode === 0 && result.exitCode === 1)) {
    state.representative = invocation;
  }
  if (!result.ok) return { failure: ruffProcessFailure("format", refinement.tool, result, refinement.project), invocation };
  if (result.exitCode === 0) return { paths: [] };
  if (targets.length === 1) return { paths: [targets[0]] };
  const middle = Math.ceil(targets.length / 2);
  const left = await refineFormatBatch(refinement, targets.slice(0, middle), state);
  if ("failure" in left) return left;
  const right = await refineFormatBatch(refinement, targets.slice(middle), state);
  if ("failure" in right) return right;
  return { paths: [...left.paths, ...right.paths].sort((a, b) => a.localeCompare(b)) };
}

function boundedFailure(
  refinement: RuffFormatRefinement,
  state: RuffFormatRefinementState,
  args: readonly string[],
  termination: "timeout" | "overflow",
  failureMessage: string
): { failure: ValidationCheckResult; invocation: RuffFormatInvocationEvidence } {
  // WHY: the bounded attempt is the run-level termination evidence, so it must also appear
  // in the recorded invocation list that receipt consumers reconcile against.
  const invocation = boundedInvocation(refinement, args, termination, failureMessage);
  state.invocations.push(invocation);
  return { failure: ruffProcessFailure("format", refinement.tool, invocation.result, refinement.project), invocation };
}

function boundedInvocation(
  refinement: RuffFormatRefinement,
  args: readonly string[],
  termination: "timeout" | "overflow",
  failureMessage: string
): RuffFormatInvocationEvidence {
  return {
    args,
    result: {
      command: refinement.tool.executable,
      args,
      cwd: refinement.cwd,
      allowedExitCodes: [0, 1],
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      termination,
      ok: false,
      failureMessage
    },
    durationMs: 1
  };
}

export function formatCapabilityInvocations(
  executable: string,
  invocations: readonly RuffFormatInvocationEvidence[]
): readonly PythonValidationCapabilityInvocation[] {
  return invocations.map((invocation) =>
    pythonCapabilityInvocation(executable, invocation.args, invocation.result, invocation.durationMs)
  );
}
