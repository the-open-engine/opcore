import type {
  PythonValidationCapabilityExecution,
  PythonValidationCapabilityToolProvenance,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import { diagnostic } from "./diagnostics.js";
import type {
  MypyCapabilityArgs,
  MypyCapabilityResult,
  MypyExecutionContext
} from "./mypy-runner-types.js";
import type { PythonToolRunResult } from "./process.js";
import { createPythonTypeCapabilityRun } from "./type-capability-run.js";

export function completedMypyResult(
  context: MypyExecutionContext,
  exitCode: number,
  diagnostics: readonly ValidationDiagnostic[],
  durationMs: number
): MypyCapabilityResult {
  if (exitCode === 0 && diagnostics.length !== 0) {
    return protocolFailure(context, durationMs, exitCode, "mypy exit 0 emitted diagnostics");
  }
  if (exitCode === 1 && !diagnostics.some(isFindingDiagnostic)) {
    return protocolFailure(context, durationMs, exitCode, "mypy exit 1 emitted no finding diagnostics");
  }
  return {
    run: createPythonTypeCapabilityRun({
      preparation: context.args.preparation,
      authority: "mypy",
      authoritySource: context.args.authoritySource,
      status: exitCode === 0 ? "passed" : "findings",
      durationMs,
      counts: diagnosticCounts(diagnostics),
      tool: context.tool,
      execution: { termination: "exited", exitCode }
    }),
    diagnostics
  };
}

export function terminatedMypyResult(
  context: MypyExecutionContext,
  result: Exclude<PythonToolRunResult, { termination: "exited" }>,
  durationMs: number
): MypyCapabilityResult {
  const status = result.termination === "timeout" ? "timeout" : "tool_failure";
  const failureMessage = portableFailure(
    result.failureMessage ?? `mypy terminated with ${result.termination}`,
    context
  );
  return {
    run: createPythonTypeCapabilityRun({
      preparation: context.args.preparation,
      authority: "mypy",
      authoritySource: context.args.authoritySource,
      status,
      durationMs,
      counts: { diagnosticCount: 1, errorCount: 1, warningCount: 0, noteCount: 0 },
      tool: context.tool,
      execution: nonExitedExecution(result.termination, result.signal, failureMessage)
    }),
    diagnostics: [toolFailureDiagnostic(status, failureMessage, context.tool)],
    failureMessage
  };
}

export function materializationFailure(
  args: MypyCapabilityArgs,
  tool: PythonValidationCapabilityToolProvenance,
  startedAt: number
): MypyCapabilityResult {
  const failureMessage = "mypy exact after-state materialization failed";
  return {
    run: createPythonTypeCapabilityRun({
      preparation: args.preparation, authority: "mypy", authoritySource: args.authoritySource,
      status: "tool_failure", durationMs: Date.now() - startedAt,
      counts: { diagnosticCount: 1, errorCount: 1, warningCount: 0, noteCount: 0 }, tool,
      execution: { termination: "spawn_error", failureSummary: failureMessage }
    }),
    diagnostics: [toolFailureDiagnostic("tool_failure", failureMessage, tool)],
    failureMessage
  };
}

export function protocolFailure(
  context: Pick<MypyExecutionContext, "args" | "tool">,
  durationMs: number,
  exitCode: number,
  rawMessage: string
): MypyCapabilityResult {
  const failureMessage = boundedFailure(rawMessage);
  return {
    run: createPythonTypeCapabilityRun({
      preparation: context.args.preparation,
      authority: "mypy",
      authoritySource: context.args.authoritySource,
      status: "tool_failure",
      durationMs,
      counts: { diagnosticCount: 1, errorCount: 1, warningCount: 0, noteCount: 0 },
      tool: context.tool,
      execution: { termination: "exited", exitCode, failureSummary: failureMessage }
    }),
    diagnostics: [toolFailureDiagnostic("tool_failure", failureMessage, context.tool)],
    failureMessage
  };
}

export function invalidConfigFailure(
  context: Pick<MypyExecutionContext, "args" | "tool">,
  durationMs: number,
  exitCode: number
): MypyCapabilityResult {
  const configFile = context.tool.configFile ?? "selected mypy configuration";
  const failureMessage = `mypy rejected selected configuration: ${configFile}`;
  return {
    run: createPythonTypeCapabilityRun({
      preparation: context.args.preparation,
      authority: "mypy",
      authoritySource: context.args.authoritySource,
      status: "invalid_config",
      durationMs,
      counts: { diagnosticCount: 1, errorCount: 1, warningCount: 0, noteCount: 0 },
      tool: context.tool,
      execution: { termination: "exited", exitCode, failureSummary: failureMessage }
    }),
    diagnostics: [diagnostic({
      category: "infrastructure",
      severity: "error",
      code: "PYTHON_TYPES_INVALID_CONFIG",
      message: `mypy could not produce authoritative type evidence: ${failureMessage}`,
      ...(context.tool.configFile === undefined ? {} : { path: context.tool.configFile }),
      tool: {
        name: context.tool.name,
        command: context.tool.argv.join(" "),
        ...(context.tool.version === undefined ? {} : { version: context.tool.version }),
        source: context.tool.source,
        cwd: context.tool.cwd
      }
    })],
    failureMessage
  };
}

function nonExitedExecution(
  termination: "timeout" | "signal" | "spawn_error",
  signal: string | null,
  failureSummary: string
): PythonValidationCapabilityExecution {
  return {
    termination,
    ...(termination === "signal" && signal !== null ? { signal } : {}),
    failureSummary
  };
}

function toolFailureDiagnostic(
  status: "timeout" | "tool_failure",
  message: string,
  tool: PythonValidationCapabilityToolProvenance
): ValidationDiagnostic {
  return diagnostic({
    category: "infrastructure",
    code: status === "timeout" ? "PYTHON_TYPES_TOOL_TIMEOUT" : "PYTHON_TYPES_TOOL_FAILED",
    message: `mypy could not produce authoritative type evidence: ${message}`,
    tool: {
      name: tool.name,
      command: tool.argv.join(" "),
      ...(tool.version === undefined ? {} : { version: tool.version }),
      source: tool.source,
      cwd: tool.cwd
    }
  });
}

function diagnosticCounts(diagnostics: readonly ValidationDiagnostic[]) {
  return {
    diagnosticCount: diagnostics.length,
    errorCount: diagnostics.filter((entry) => entry.severity === "error").length,
    warningCount: diagnostics.filter((entry) => entry.severity === "warning").length,
    noteCount: diagnostics.filter((entry) => entry.severity === "info").length
  };
}

function isFindingDiagnostic(entry: ValidationDiagnostic): boolean {
  return entry.severity === "error" || entry.severity === "warning";
}

function boundedFailure(message: string): string {
  const normalized = message.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  return (normalized.length === 0 ? "mypy failed without a message" : normalized).slice(0, 1024);
}

function portableFailure(message: string, context: MypyExecutionContext): string {
  let portable = message;
  for (const path of [
    context.args.checker.executable,
    context.workspace.projectCwd,
    context.workspace.root,
    context.workspace.runtimeRoot
  ].sort((left, right) => right.length - left.length)) {
    if (path.length > 0) portable = portable.replaceAll(path, context.tool.executable);
  }
  return boundedFailure(portable);
}
