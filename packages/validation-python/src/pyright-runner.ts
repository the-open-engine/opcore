import type {
  PythonProjectToolProvenance,
  PythonValidationAuthoritySource
} from "@the-open-engine/opcore-contracts";
import { join } from "node:path";
import { parsePyrightJsonOutput } from "./pyright-output.js";
import { runTool, type PythonToolExitedResult, type PythonToolRunResult } from "./process.js";
import {
  relativePythonProjectPath,
  type MaterializedPythonTypeWorkspace,
  type PythonTypeCapabilityPreparation
} from "./type-capability-run.js";
import {
  isolatedTypeEnvironmentBase,
  portableTypeTool,
  withMaterializedTypeExecution
} from "./type-runner-runtime.js";
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
  const invocation = pyrightInvocation(args.checker, args.preparation);
  if (!invocation.ok) {
    const tool = portableTypeTool(sharedArgs, args.checker.argv);
    return typePreflightFailure(sharedArgs, tool, invocation.message);
  }
  return withMaterializedTypeExecution(
    sharedArgs,
    invocation.argv,
    async (context) => executePyrightCapability(context, invocation.argv),
    (tool, startedAt) => typeMaterializationFailure(sharedArgs, tool, startedAt)
  );
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
  return args.slice(0, launcherPrefixLength(checker.executable, args));
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
  return isolatedTypeEnvironmentBase({
    input,
    executable: checker.executable,
    workspace,
    includeProcessExecPath: true,
    extra: {
      NODE_OPTIONS: "",
      NODE_PATH: "",
      PYRIGHT_PYTHON_CACHE_DIR: join(workspace.runtimeRoot, "pyright-cache"),
      PYTHONPATH: ""
    }
  });
}
