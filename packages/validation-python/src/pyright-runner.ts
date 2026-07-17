import type {
  PythonProjectToolProvenance,
  PythonValidationAuthoritySource,
  PythonValidationCapabilityToolProvenance
} from "@the-open-engine/opcore-contracts";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { parsePyrightJsonOutput } from "./pyright-output.js";
import { runTool, type PythonToolExitedResult, type PythonToolRunResult } from "./process.js";
import {
  materializePythonTypeCapability,
  portablePythonValidationTool,
  relativePythonProjectPath,
  type MaterializedPythonTypeWorkspace,
  type PythonTypeCapabilityPreparation
} from "./type-capability-run.js";
import {
  completedTypeResult,
  terminatedTypeResult,
  typeInvalidConfigFailure,
  typeMaterializationFailure,
  typePreflightFailure,
  typeProtocolFailure
} from "./type-result.js";
import type { TypeCapabilityArgs, TypeCapabilityResult, TypeExecutionContext } from "./type-runner-types.js";

export interface PyrightCapabilityArgs {
  preparation: PythonTypeCapabilityPreparation;
  checker: PythonProjectToolProvenance;
  authoritySource: PythonValidationAuthoritySource;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
}

export type PyrightCapabilityResult = TypeCapabilityResult;

export async function runPyrightCapability(args: PyrightCapabilityArgs): Promise<PyrightCapabilityResult> {
  const sharedArgs: TypeCapabilityArgs = { ...args, authority: "pyright" };
  const startedAt = Date.now();
  const invocation = pyrightInvocation(args.checker, args.preparation);
  if (!invocation.ok) {
    const tool = portableTool(args.checker, args.checker.argv, args.preparation);
    return typePreflightFailure(sharedArgs, tool, invocation.message);
  }
  const observedArgv = invocation.argv;
  const tool = portableTool(args.checker, observedArgv, args.preparation);
  let workspace: MaterializedPythonTypeWorkspace;
  try {
    workspace = await materializePythonTypeCapability(args.preparation);
  } catch {
    return typeMaterializationFailure(sharedArgs, tool, startedAt);
  }
  try {
    return await executePyrightCapability({ args: sharedArgs, workspace, tool, startedAt }, observedArgv);
  } finally {
    workspace.cleanup();
  }
}

async function executePyrightCapability(
  context: TypeExecutionContext,
  observedArgv: readonly string[]
): Promise<PyrightCapabilityResult> {
  const result = await runTool(observedArgv[0], observedArgv.slice(1), {
    cwd: context.workspace.projectCwd,
    env: isolatedPyrightEnvironment(context.args.env, context.args.checker, context.workspace),
    timeoutMs: context.args.timeoutMs,
    allowedExitCodes: [0, 1, 2, 3, 4]
  });
  return interpretPyrightResult(context, result, Date.now() - context.startedAt);
}

function interpretPyrightResult(
  context: TypeExecutionContext,
  result: PythonToolRunResult,
  durationMs: number
): PyrightCapabilityResult {
  if (result.termination !== "exited") return terminatedTypeResult(context, result, durationMs);
  return interpretExitedPyrightResult(context, result, durationMs);
}

function interpretExitedPyrightResult(
  context: TypeExecutionContext,
  result: PythonToolExitedResult,
  durationMs: number
): PyrightCapabilityResult {
  if (result.exitCode === 2 || result.exitCode === 4 || ![0, 1, 3].includes(result.exitCode)) {
    return typeProtocolFailure(context, durationMs, result.exitCode, `pyright exited with fatal code ${result.exitCode}`);
  }
  if (result.exitCode === 3) return interpretInvalidPyrightConfig(context, result, durationMs);
  if (result.stderr.trim().length > 0) {
    return typeProtocolFailure(context, durationMs, result.exitCode, "pyright wrote unclassified protocol or fatal output to stderr");
  }
  const parsed = parsePyrightJsonOutput(result.stdout, context.workspace, context.tool);
  if (!parsed.ok) return typeProtocolFailure(context, durationMs, result.exitCode, parsed.message);
  const contradiction = completedPyrightContradiction(context, result, parsed);
  if (contradiction !== undefined) return typeProtocolFailure(context, durationMs, result.exitCode, contradiction);
  return completedTypeResult({
    context,
    status: result.exitCode === 0 ? "passed" : "findings",
    exitCode: result.exitCode,
    diagnostics: parsed.diagnostics,
    durationMs
  });
}

function interpretInvalidPyrightConfig(
  context: TypeExecutionContext,
  result: PythonToolExitedResult,
  durationMs: number
): PyrightCapabilityResult {
  if (result.stdout.trim().length === 0) return typeInvalidConfigFailure(context, durationMs, result.exitCode);
  const parsed = parsePyrightJsonOutput(result.stdout, context.workspace, context.tool);
  if (!parsed.ok) return typeProtocolFailure(context, durationMs, result.exitCode, parsed.message);
  return typeInvalidConfigFailure(context, durationMs, result.exitCode, parsed.diagnostics);
}

function completedPyrightContradiction(
  context: TypeExecutionContext,
  result: PythonToolExitedResult,
  parsed: Extract<ReturnType<typeof parsePyrightJsonOutput>, { ok: true }>
): string | undefined {
  if (parsed.diagnostics.some((diagnostic) => diagnostic.path === undefined || !context.workspace.selectedSourcePaths.includes(diagnostic.path))) {
    return "pyright type diagnostics escaped the selected after-state source closure";
  }
  if (parsed.summary.filesAnalyzed === 0) return "pyright analyzed zero files";
  const hasErrors = parsed.summary.errorCount > 0;
  const hasFindings = hasErrors || parsed.summary.warningCount > 0;
  if (result.exitCode === 0 && hasErrors) return "pyright exit 0 contradicted error diagnostics";
  if (result.exitCode === 1 && !hasFindings) return "pyright exit 1 emitted no finding diagnostics";
  return undefined;
}

type PyrightInvocation =
  | { ok: true; argv: readonly string[] }
  | { ok: false; message: string };

function pyrightInvocation(
  checker: PythonProjectToolProvenance,
  preparation: PythonTypeCapabilityPreparation
): PyrightInvocation {
  const configFile = checker.configFile;
  if (configFile === undefined || !preparation.selectedConfigPaths.includes(configFile)) {
    return { ok: false, message: "Selected Pyright authority requires an exact after-state project configuration" };
  }
  const interpreter = preparation.project.interpreter;
  if (interpreter === undefined) {
    const reason = preparation.project.reasons.find((entry) => entry.tool === "python")?.message;
    return {
      ok: false,
      message: reason === undefined
        ? "Selected Pyright authority requires canonical interpreter provenance"
        : `Selected Pyright authority requires canonical interpreter provenance: ${reason}`
    };
  }
  return {
    ok: true,
    argv: [
      checker.executable,
      ...withoutConflictingPyrightArguments(checker),
      "--outputjson",
      "--project",
      relativePythonProjectPath(configFile, preparation.project.projectRoot),
      "--pythonpath",
      interpreter.executable
    ]
  };
}

function withoutConflictingPyrightArguments(checker: PythonProjectToolProvenance): readonly string[] {
  const args = checker.argv.slice(1);
  const preservedLauncherCount = launcherPrefixLength(checker.executable, args);
  return args.slice(0, preservedLauncherCount);
}

function launcherPrefixLength(executable: string, args: readonly string[]): number {
  const name = executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if ((name === "node" || name === "node.exe") && /\.(?:c?js|mjs)$/u.test(args[0] ?? "")) return 1;
  if ((name.startsWith("python") || name === "py") && args[0] === "-m" && args[1] === "pyright") return 2;
  return 0;
}

function isolatedPyrightEnvironment(
  input: Record<string, string | undefined> | undefined,
  checker: PythonProjectToolProvenance,
  workspace: MaterializedPythonTypeWorkspace
): Record<string, string> {
  const source = input ?? process.env;
  return {
    PATH: isolatedExecutablePath(checker.executable, source),
    PWD: workspace.projectCwd,
    HOME: join(workspace.runtimeRoot, "home"),
    XDG_CONFIG_HOME: join(workspace.runtimeRoot, "xdg-config"),
    XDG_CACHE_HOME: join(workspace.runtimeRoot, "xdg-cache"),
    TMPDIR: join(workspace.runtimeRoot, "tmp"),
    TEMP: join(workspace.runtimeRoot, "tmp"),
    TMP: join(workspace.runtimeRoot, "tmp"),
    PYRIGHT_PYTHON_CACHE_DIR: join(workspace.runtimeRoot, "pyright-cache"),
    PYTHONPATH: "",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
    NODE_PATH: "",
    NODE_OPTIONS: "",
    LC_ALL: "C",
    LANG: "C",
    ...(process.platform !== "win32" ? {} : windowsEnvironment(source))
  };
}

function isolatedExecutablePath(
  executable: string,
  source: Readonly<Record<string, string | undefined>>
): string {
  const system = process.platform === "win32" ? source.SystemRoot ?? source.SYSTEMROOT : undefined;
  const systemPaths = system === undefined ? ["/usr/bin", "/bin"] : [join(system, "System32"), system];
  return [...new Set([
    isAbsolute(executable) ? dirname(executable) : undefined,
    dirname(process.execPath),
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

function portableTool(
  checker: PythonProjectToolProvenance,
  argv: readonly string[],
  preparation: PythonTypeCapabilityPreparation
): PythonValidationCapabilityToolProvenance {
  return portablePythonValidationTool({ checker, argv, preparation, authority: "pyright" });
}
