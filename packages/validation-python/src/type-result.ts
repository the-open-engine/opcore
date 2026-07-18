import type {
  PythonValidationAuthority,
  PythonValidationCapabilityExecution,
  PythonValidationCapabilityRunStatus,
  PythonValidationCapabilityToolProvenance,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import { diagnostic } from "./diagnostics.js";
import type { PythonToolRunResult } from "./process.js";
import { createPythonTypeCapabilityRun } from "./type-capability-run.js";
import type { TypeCapabilityArgs, TypeCapabilityResult, TypeExecutionContext } from "./type-runner-types.js";

interface CompletedTypeResultArgs {
  context: TypeExecutionContext;
  status: Extract<PythonValidationCapabilityRunStatus, "passed" | "findings">;
  exitCode: number;
  diagnostics: readonly ValidationDiagnostic[];
  durationMs: number;
}

export function completedTypeResult(args: CompletedTypeResultArgs): TypeCapabilityResult {
  return {
    run: createPythonTypeCapabilityRun({
      preparation: args.context.args.preparation,
      authority: args.context.args.authority,
      authoritySource: args.context.args.authoritySource,
      status: args.status,
      durationMs: args.durationMs,
      counts: diagnosticCounts(args.diagnostics),
      tool: args.context.tool,
      execution: { termination: "exited", exitCode: args.exitCode }
    }),
    diagnostics: args.diagnostics
  };
}

export function terminatedTypeResult(
  context: TypeExecutionContext,
  result: Exclude<PythonToolRunResult, { termination: "exited" }>,
  durationMs: number
): TypeCapabilityResult {
  const status = result.termination === "timeout" ? "timeout" : "tool_failure";
  const failureMessage = portableFailure(
    result.failureMessage ?? `${context.args.authority} terminated with ${result.termination}`,
    context
  );
  return failedResult({
    args: context.args,
    tool: context.tool,
    status,
    durationMs,
    execution: nonExitedExecution(result.termination, result.signal, failureMessage),
    failureMessage
  });
}

export function typeMaterializationFailure(
  args: TypeCapabilityArgs,
  tool: PythonValidationCapabilityToolProvenance,
  startedAt: number
): TypeCapabilityResult {
  const failureMessage = `${args.authority} exact after-state materialization failed`;
  return failedResult({
    args,
    tool,
    status: "tool_failure",
    durationMs: Date.now() - startedAt,
    execution: { termination: "spawn_error", failureSummary: failureMessage },
    failureMessage
  });
}

export function typePreflightFailure(
  args: TypeCapabilityArgs,
  tool: PythonValidationCapabilityToolProvenance,
  rawMessage: string
): TypeCapabilityResult {
  const failureMessage = boundedFailure(rawMessage, args.authority);
  const failureDiagnostic = diagnostic({
    category: "infrastructure",
    severity: "error",
    code: "PYTHON_TYPES_INVALID_CONFIG",
    message: `${args.authority} could not produce authoritative type evidence: ${failureMessage}`,
    ...(tool.configFile === undefined ? {} : { path: tool.configFile }),
    tool: diagnosticTool(tool)
  });
  return {
    run: createPythonTypeCapabilityRun({
      preparation: args.preparation,
      authority: args.authority,
      authoritySource: args.authoritySource,
      status: "invalid_config",
      durationMs: 0,
      counts: diagnosticCounts([failureDiagnostic]),
      tool
    }),
    diagnostics: [failureDiagnostic],
    failureMessage
  };
}

export function typeProtocolFailure(
  context: Pick<TypeExecutionContext, "args" | "tool">,
  durationMs: number,
  exitCode: number,
  rawMessage: string
): TypeCapabilityResult {
  const failureMessage = boundedFailure(rawMessage, context.args.authority);
  return failedResult({
    args: context.args,
    tool: context.tool,
    status: "tool_failure",
    durationMs,
    execution: { termination: "exited", exitCode, failureSummary: failureMessage },
    failureMessage
  });
}

export function typeInvalidConfigFailure(
  context: Pick<TypeExecutionContext, "args" | "tool">,
  durationMs: number,
  exitCode: number,
  diagnostics: readonly ValidationDiagnostic[] = []
): TypeCapabilityResult {
  const configFile = context.tool.configFile ?? `selected ${context.args.authority} configuration`;
  const failureMessage = `${context.args.authority} rejected selected configuration: ${configFile}`;
  const failureDiagnostic = diagnostic({
    category: "infrastructure",
    severity: "error",
    code: "PYTHON_TYPES_INVALID_CONFIG",
    message: `${context.args.authority} could not produce authoritative type evidence: ${failureMessage}`,
    ...(context.tool.configFile === undefined ? {} : { path: context.tool.configFile }),
    tool: diagnosticTool(context.tool)
  });
  const allDiagnostics = diagnostics.length === 0 ? [failureDiagnostic] : [...diagnostics, failureDiagnostic];
  return {
    run: createPythonTypeCapabilityRun({
      preparation: context.args.preparation,
      authority: context.args.authority,
      authoritySource: context.args.authoritySource,
      status: "invalid_config",
      durationMs,
      counts: diagnosticCounts(allDiagnostics),
      tool: context.tool,
      execution: { termination: "exited", exitCode, failureSummary: failureMessage }
    }),
    diagnostics: allDiagnostics,
    failureMessage
  };
}

export function diagnosticCounts(diagnostics: readonly ValidationDiagnostic[]) {
  return {
    diagnosticCount: diagnostics.length,
    errorCount: diagnostics.filter((entry) => entry.severity === "error").length,
    warningCount: diagnostics.filter((entry) => entry.severity === "warning").length,
    noteCount: diagnostics.filter((entry) => entry.severity === "info").length
  };
}

interface FailedResultArgs {
  args: TypeCapabilityArgs;
  tool: PythonValidationCapabilityToolProvenance;
  status: Extract<PythonValidationCapabilityRunStatus, "timeout" | "tool_failure">;
  durationMs: number;
  execution: PythonValidationCapabilityExecution;
  failureMessage: string;
}

function failedResult(input: FailedResultArgs): TypeCapabilityResult {
  return {
    run: createPythonTypeCapabilityRun({
      preparation: input.args.preparation, authority: input.args.authority, authoritySource: input.args.authoritySource,
      status: input.status, durationMs: input.durationMs,
      counts: { diagnosticCount: 1, errorCount: 1, warningCount: 0, noteCount: 0 },
      tool: input.tool,
      execution: input.execution
    }),
    diagnostics: [toolFailureDiagnostic(input.status, input.failureMessage, input.tool, input.args.authority)],
    failureMessage: input.failureMessage
  };
}

function nonExitedExecution(
  termination: "timeout" | "signal" | "spawn_error",
  signal: string | null,
  failureSummary: string
): PythonValidationCapabilityExecution {
  return { termination, ...(termination === "signal" && signal !== null ? { signal } : {}), failureSummary };
}

function toolFailureDiagnostic(
  status: "timeout" | "tool_failure",
  message: string,
  tool: PythonValidationCapabilityToolProvenance,
  authority: PythonValidationAuthority
): ValidationDiagnostic {
  return diagnostic({
    category: "infrastructure",
    code: status === "timeout" ? "PYTHON_TYPES_TOOL_TIMEOUT" : "PYTHON_TYPES_TOOL_FAILED",
    message: `${authority} could not produce authoritative type evidence: ${message}`,
    tool: diagnosticTool(tool)
  });
}

function diagnosticTool(tool: PythonValidationCapabilityToolProvenance) {
  return {
    name: tool.name,
    command: tool.argv.join(" "),
    ...(tool.version === undefined ? {} : { version: tool.version }),
    source: tool.source,
    cwd: tool.cwd
  };
}

function boundedFailure(message: string, authority: PythonValidationAuthority): string {
  const normalized = message.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  return (normalized.length === 0 ? `${authority} failed without a message` : normalized).slice(0, 1024);
}

function portableFailure(message: string, context: TypeExecutionContext): string {
  let portable = message;
  for (const path of [
    context.args.checker.executable,
    context.workspace.projectCwd,
    context.workspace.root,
    context.workspace.runtimeRoot
  ].sort((left, right) => right.length - left.length)) {
    if (path.length > 0) portable = portable.replaceAll(path, context.tool.executable);
  }
  return boundedFailure(portable, context.args.authority);
}
