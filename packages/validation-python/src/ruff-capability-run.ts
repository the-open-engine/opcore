import {
  PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID,
  type PythonProjectContext,
  type PythonProjectToolProvenance,
  type PythonRuffValidationCapabilityRun,
  type PythonValidationCapabilityInvocation,
  type PythonValidationCapabilityState
} from "@the-open-engine/opcore-contracts";
import type {
  MaterializedPythonExecutionWorkspace,
  PythonExecutionWorkspaceEvidence
} from "./python-execution-workspace.js";
import type { PythonToolRunResult } from "./process.js";
import {
  portablePythonExecutableLocator,
  portablePythonValidationArgument
} from "./type-capability-run.js";

export function pythonCapabilityInvocation(
  executable: string,
  args: readonly string[],
  result: PythonToolRunResult,
  durationMs: number
): PythonValidationCapabilityInvocation {
  return {
    argv: [executable, ...args],
    termination: result.termination,
    ...(result.termination === "exited" ? { exitCode: result.exitCode } : {}),
    ...(result.termination === "signal" ? { signal: result.signal } : {}),
    durationMs: Math.max(1, durationMs)
  };
}

export function pythonCapabilityRun(
  checkId: PythonRuffValidationCapabilityRun["checkId"],
  capability: PythonRuffValidationCapabilityRun["capability"],
  state: PythonValidationCapabilityState,
  args: {
    project: PythonProjectContext;
    workspace?: PythonExecutionWorkspaceEvidence &
      Partial<Pick<MaterializedPythonExecutionWorkspace, "root" | "runtimeRoot" | "projectCwd">>;
    tool?: PythonProjectToolProvenance;
    configPath?: string;
    argv?: readonly string[];
    invocations?: readonly PythonValidationCapabilityInvocation[];
    result?: PythonToolRunResult;
    durationMs: number;
    diagnosticCount: number;
    failureMessage?: string;
  }
): PythonRuffValidationCapabilityRun {
  const run: PythonRuffValidationCapabilityRun = {
    schemaId: PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID,
    schemaVersion: 1,
    checkId,
    capability,
    state,
    projectKey: args.project.projectKey,
    contextFingerprint: args.project.contextFingerprint,
    durationMs:
      (capability === "ruff_lint" || capability === "ruff_format") &&
      (state === "passed" || state === "findings")
        ? Math.max(1, args.durationMs)
        : args.durationMs,
    diagnosticCount: args.diagnosticCount,
    ...(args.failureMessage === undefined
      ? {}
      : { failureMessage: portableFailureMessage(args.failureMessage, args) })
  };
  if (args.workspace !== undefined) {
    run.afterStateManifestFingerprint = args.workspace.afterStateFingerprint;
    run.sourcePaths = args.workspace.sourcePaths;
    run.configPaths = args.workspace.configPaths;
    run.cwd = args.workspace.projectCwdRelative;
  }
  const portableExecutable = args.tool === undefined
    ? undefined
    : portablePythonExecutableLocator(args.tool.executable, args.project.repositoryRoot);
  if (args.argv !== undefined) {
    run.argv = portableArgv(args.argv, args.project.repositoryRoot, portableExecutable);
    run.command = run.argv.join(" ");
  }
  if (args.invocations !== undefined) {
    run.invocations = args.invocations.map((invocation) => ({
      ...invocation,
      argv: portableArgv(invocation.argv, args.project.repositoryRoot, portableExecutable)
    }));
  }
  if (args.tool !== undefined) {
    run.executable = portableExecutable;
    run.toolVersion = args.tool.version;
    run.toolSource = args.tool.source;
    run.configPath = args.configPath ?? args.tool.configFile;
  }
  if (args.result !== undefined) {
    run.termination = args.result.termination;
    if (args.result.termination === "exited") run.exitCode = args.result.exitCode;
    if (args.result.termination === "signal") run.signal = args.result.signal;
  }
  if (state === "not_applicable" || state === "disabled") {
    delete run.command;
    delete run.argv;
    delete run.executable;
    delete run.toolVersion;
    delete run.toolSource;
    delete run.termination;
    delete run.exitCode;
    delete run.signal;
    delete run.invocations;
  }
  return run;
}

function portableArgv(
  argv: readonly string[],
  repositoryRoot: string,
  portableExecutable: string | undefined
): readonly string[] {
  return argv.map((argument, index) =>
    index === 0 && portableExecutable !== undefined
      ? portableExecutable
      : portablePythonValidationArgument(argument, repositoryRoot)
  );
}

function portableFailureMessage(
  message: string,
  args: {
    project: PythonProjectContext;
    workspace?: Partial<Pick<MaterializedPythonExecutionWorkspace, "root" | "runtimeRoot" | "projectCwd">>;
    tool?: PythonProjectToolProvenance;
  }
): string {
  const executable = args.tool === undefined
    ? undefined
    : portablePythonExecutableLocator(args.tool.executable, args.project.repositoryRoot);
  const replacements = [
    ...(args.tool === undefined || executable === undefined ? [] : [[args.tool.executable, executable] as const]),
    ...(args.workspace?.projectCwd === undefined || args.workspace.root === undefined || args.workspace.runtimeRoot === undefined
      ? []
      : [
          [args.workspace.projectCwd, "project:cwd"] as const,
          [args.workspace.root, "project:workspace"] as const,
          [args.workspace.runtimeRoot, "external:runtime"] as const
        ]),
    [args.project.repositoryRoot, "repo:root"] as const
  ].sort((left, right) => right[0].length - left[0].length);
  let portable = message;
  for (const [hostPath, locator] of replacements) {
    if (hostPath.length > 0) portable = portable.replaceAll(hostPath, locator);
  }
  const normalized = portable.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  return (normalized.length === 0 ? "Ruff validation failed without a message" : normalized).slice(0, 1024);
}

export function inactivePythonCapabilityRun(
  checkId: PythonRuffValidationCapabilityRun["checkId"],
  capability: PythonRuffValidationCapabilityRun["capability"],
  state: Extract<PythonValidationCapabilityState, "not_applicable" | "disabled">
): PythonRuffValidationCapabilityRun {
  return {
    schemaId: PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID,
    schemaVersion: 1,
    checkId,
    capability,
    state,
    durationMs: 0,
    diagnosticCount: 0
  };
}
