import type {
  PythonValidationCapabilityToolProvenance,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type {
  MypyCapabilityArgs,
  MypyCapabilityResult,
  MypyExecutionContext
} from "./mypy-runner-types.js";
import type { PythonToolRunResult } from "./process.js";
import {
  completedTypeResult,
  terminatedTypeResult,
  typeInvalidConfigFailure,
  typeMaterializationFailure,
  typeProtocolFailure
} from "./type-result.js";
import type { TypeCapabilityArgs, TypeExecutionContext } from "./type-runner-types.js";

export function completedMypyResult(
  context: MypyExecutionContext,
  exitCode: number,
  diagnostics: readonly ValidationDiagnostic[],
  durationMs: number
): MypyCapabilityResult {
  const shared = sharedContext(context);
  if (exitCode === 0 && diagnostics.length !== 0) {
    return typeProtocolFailure(shared, durationMs, exitCode, "mypy exit 0 emitted diagnostics");
  }
  if (exitCode === 1 && !diagnostics.some(isFindingDiagnostic)) {
    return typeProtocolFailure(shared, durationMs, exitCode, "mypy exit 1 emitted no finding diagnostics");
  }
  return completedTypeResult({
    context: shared,
    status: exitCode === 0 ? "passed" : "findings",
    exitCode,
    diagnostics,
    durationMs
  });
}

export function terminatedMypyResult(
  context: MypyExecutionContext,
  result: Exclude<PythonToolRunResult, { termination: "exited" }>,
  durationMs: number
): MypyCapabilityResult {
  return terminatedTypeResult(sharedContext(context), result, durationMs);
}

export function materializationFailure(
  args: MypyCapabilityArgs,
  tool: PythonValidationCapabilityToolProvenance,
  startedAt: number
): MypyCapabilityResult {
  return typeMaterializationFailure(sharedArgs(args), tool, startedAt);
}

export function protocolFailure(
  context: Pick<MypyExecutionContext, "args" | "tool">,
  durationMs: number,
  exitCode: number,
  rawMessage: string
): MypyCapabilityResult {
  return typeProtocolFailure({ args: sharedArgs(context.args), tool: context.tool }, durationMs, exitCode, rawMessage);
}

export function invalidConfigFailure(
  context: Pick<MypyExecutionContext, "args" | "tool">,
  durationMs: number,
  exitCode: number
): MypyCapabilityResult {
  return typeInvalidConfigFailure({ args: sharedArgs(context.args), tool: context.tool }, durationMs, exitCode);
}

function sharedArgs(args: MypyCapabilityArgs): TypeCapabilityArgs {
  return { ...args, authority: "mypy" };
}

function sharedContext(context: MypyExecutionContext): TypeExecutionContext {
  return { ...context, args: sharedArgs(context.args) };
}

function isFindingDiagnostic(entry: ValidationDiagnostic): boolean {
  return entry.severity === "error" || entry.severity === "warning";
}
