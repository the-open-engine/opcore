import type { PythonValidationCapabilityToolProvenance } from "@the-open-engine/opcore-contracts";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import {
  materializePythonTypeCapability,
  portablePythonValidationTool,
  type MaterializedPythonTypeWorkspace
} from "./type-capability-run.js";
import type { TypeCapabilityArgs, TypeExecutionContext } from "./type-runner-types.js";

export async function withMaterializedTypeExecution<TResult>(
  args: TypeCapabilityArgs,
  observedArgv: readonly string[],
  execute: (context: TypeExecutionContext) => Promise<TResult>,
  onMaterializationFailure: (
    tool: PythonValidationCapabilityToolProvenance,
    startedAt: number
  ) => TResult
): Promise<TResult> {
  const startedAt = Date.now();
  const tool = portableTypeTool(args, observedArgv);
  let workspace: MaterializedPythonTypeWorkspace;
  try {
    workspace = await materializePythonTypeCapability(args.preparation);
  } catch {
    return onMaterializationFailure(tool, startedAt);
  }
  try {
    return await execute({ args, workspace, tool, startedAt });
  } finally {
    workspace.cleanup();
  }
}

export function isolatedTypeEnvironmentBase(args: {
  input: Record<string, string | undefined> | undefined;
  executable: string;
  workspace: MaterializedPythonTypeWorkspace;
  includeProcessExecPath?: boolean;
  extra?: Record<string, string>;
}): Record<string, string> {
  const source = args.input ?? process.env;
  return {
    PATH: isolatedExecutablePath(args.executable, source, args.includeProcessExecPath === true),
    PWD: args.workspace.projectCwd,
    HOME: join(args.workspace.runtimeRoot, "home"),
    XDG_CONFIG_HOME: join(args.workspace.runtimeRoot, "xdg-config"),
    XDG_CACHE_HOME: join(args.workspace.runtimeRoot, "xdg-cache"),
    TMPDIR: join(args.workspace.runtimeRoot, "tmp"),
    TEMP: join(args.workspace.runtimeRoot, "tmp"),
    TMP: join(args.workspace.runtimeRoot, "tmp"),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
    LC_ALL: "C",
    LANG: "C",
    ...(args.extra ?? {}),
    ...(process.platform !== "win32" ? {} : windowsEnvironment(source))
  };
}

export function portableTypeTool(
  args: TypeCapabilityArgs,
  observedArgv: readonly string[]
): PythonValidationCapabilityToolProvenance {
  return portablePythonValidationTool({
    checker: args.checker,
    argv: observedArgv,
    preparation: args.preparation,
    authority: args.authority
  });
}

function isolatedExecutablePath(
  executable: string,
  source: Readonly<Record<string, string | undefined>>,
  includeProcessExecPath: boolean
): string {
  const system = process.platform === "win32" ? source.SystemRoot ?? source.SYSTEMROOT : undefined;
  const systemPaths = system === undefined ? ["/usr/bin", "/bin"] : [join(system, "System32"), system];
  return [...new Set([
    isAbsolute(executable) ? dirname(executable) : undefined,
    ...(includeProcessExecPath ? [dirname(process.execPath)] : []),
    ...systemPaths
  ])].filter((path): path is string => path !== undefined).join(delimiter);
}

function windowsEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] as const) {
    const value = source[key];
    if (value !== undefined) values[key] = value;
  }
  return values;
}
