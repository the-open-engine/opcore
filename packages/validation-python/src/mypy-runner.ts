import type { PythonProjectToolProvenance } from "@the-open-engine/opcore-contracts";
import { delimiter, join } from "node:path";
import {
  completedMypyResult,
  invalidConfigFailure,
  materializationFailure,
  protocolFailure,
  terminatedMypyResult
} from "./mypy-result.js";
import { parseMypyJsonStream, validateMypyRecord } from "./mypy-output.js";
import type {
  MypyCapabilityArgs,
  MypyCapabilityResult,
  MypyExecutionContext
} from "./mypy-runner-types.js";
import { runTool, type PythonToolRunResult } from "./process.js";
import {
  isolatedMypyConfigPath,
  relativePythonProjectPath,
  repoRelativeMaterializedPath,
  type MaterializedPythonTypeWorkspace,
  type PythonTypeCapabilityPreparation
} from "./type-capability-run.js";
import { isolatedTypeEnvironmentBase, withMaterializedTypeExecution } from "./type-runner-runtime.js";
import type { TypeCapabilityArgs, TypeExecutionContext } from "./type-runner-types.js";

export type { MypyCapabilityArgs, MypyCapabilityResult, MypyExecutionContext } from "./mypy-runner-types.js";

export async function runMypyCapability(args: MypyCapabilityArgs): Promise<MypyCapabilityResult> {
  const observedArgv = mypyArgv(args.checker, args.preparation);
  return withMaterializedTypeExecution(
    sharedTypeArgs(args),
    observedArgv,
    async (context) => executeMypyCapability(toMypyExecutionContext(context, args), observedArgv),
    (tool, startedAt) => materializationFailure(args, tool, startedAt)
  );
}

async function executeMypyCapability(
  context: MypyExecutionContext,
  observedArgv: readonly string[]
): Promise<MypyCapabilityResult> {
  const result = await runTool(observedArgv[0], observedArgv.slice(1), {
    cwd: context.workspace.projectCwd,
    env: isolatedMypyEnvironment(context.args.env, context.args.checker, context.workspace),
    timeoutMs: context.args.timeoutMs,
    allowedExitCodes: [0, 1]
  });
  return interpretMypyResult(context, result, Date.now() - context.startedAt);
}

function interpretMypyResult(
  context: MypyExecutionContext,
  result: PythonToolRunResult,
  durationMs: number
): MypyCapabilityResult {
  if (result.termination !== "exited") return terminatedMypyResult(context, result, durationMs);
  if (isSelectedConfigFailure(context, result.stderr)) {
    return invalidConfigFailure(context, durationMs, result.exitCode);
  }
  if (!result.ok || (result.exitCode !== 0 && result.exitCode !== 1)) {
    return protocolFailure(context, durationMs, result.exitCode, `mypy exited with unexpected code ${result.exitCode}`);
  }
  if (result.stderr.trim().length > 0) {
    return protocolFailure(context, durationMs, result.exitCode, "mypy wrote non-JSON error output to stderr");
  }
  const parsed = parseMypyJsonStream(result.stdout, context.workspace, context.tool);
  if (!parsed.ok) return protocolFailure(context, durationMs, result.exitCode, parsed.message);
  return completedMypyResult(context, result.exitCode, parsed.diagnostics, durationMs);
}

function isSelectedConfigFailure(context: MypyExecutionContext, stderr: string): boolean {
  const configFile = context.tool.configFile;
  if (configFile === undefined) return false;
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => configFailureLineMatches(
    line,
    configFile,
    context.args.preparation.project.projectRoot,
    context.workspace
  ));
}

function configFailureLineMatches(
  line: string,
  configFile: string,
  projectRoot: string,
  workspace: MaterializedPythonTypeWorkspace
): boolean {
  try {
    const value = JSON.parse(line) as unknown;
    const validated = validateMypyRecord(value, 1);
    return typeof validated !== "string" && selectedConfigPath(validated.file, configFile, workspace);
  } catch {
    // Mypy emits human-readable semantic config errors even in JSON output mode.
  }
  return configPathCandidates(configFile, projectRoot, workspace).some((path) =>
    line.startsWith(`${path}:`) && /^:\s+\[mypy(?:-[^\]]+)?\]:/u.test(line.slice(path.length))
  );
}

function selectedConfigPath(
  path: string,
  configFile: string,
  workspace: MaterializedPythonTypeWorkspace
): boolean {
  try {
    return repoRelativeMaterializedPath(path, workspace.projectCwd, workspace.root) === configFile;
  } catch {
    return false;
  }
}

function configPathCandidates(
  configFile: string,
  projectRoot: string,
  workspace: MaterializedPythonTypeWorkspace
): readonly string[] {
  const relativeConfig = relativePythonProjectPath(configFile, projectRoot);
  const candidates = [configFile, relativeConfig, join(workspace.root, configFile)];
  return [...new Set(candidates.flatMap((path) => [path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")]))];
}

function mypyArgv(
  checker: PythonProjectToolProvenance,
  preparation: PythonTypeCapabilityPreparation
): readonly string[] {
  const prefix = withoutConfigArguments(checker.argv.slice(1));
  const selectedConfig = checker.configFile === undefined
    ? isolatedMypyConfigPath
    : relativePythonProjectPath(checker.configFile, preparation.project.projectRoot);
  const targets = preparation.targets.map((path) => relativePythonProjectPath(path, preparation.project.projectRoot));
  return [
    checker.executable,
    ...prefix,
    "--config-file",
    selectedConfig,
    "--output=json",
    "--no-color-output",
    "--no-pretty",
    "--no-error-summary",
    "--no-incremental",
    "--cache-dir=.opcore-mypy-cache",
    ...targets
  ];
}

function isolatedMypyEnvironment(
  input: Record<string, string | undefined> | undefined,
  checker: PythonProjectToolProvenance,
  workspace: MaterializedPythonTypeWorkspace
): Record<string, string> {
  return isolatedTypeEnvironmentBase({
    input,
    executable: checker.executable,
    workspace,
    extra: {
      MYPY_CACHE_DIR: join(workspace.projectCwd, ".opcore-mypy-cache"),
      PYTHONPATH: workspace.pythonPathEntries.join(delimiter)
    }
  });
}

function sharedTypeArgs(args: MypyCapabilityArgs): TypeCapabilityArgs {
  return { ...args, authority: "mypy" };
}

function toMypyExecutionContext(
  context: TypeExecutionContext,
  args: MypyCapabilityArgs
): MypyExecutionContext {
  return { ...context, args };
}

function withoutConfigArguments(args: readonly string[]): readonly string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config" || argument === "--config-file") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--config=") || argument.startsWith("--config-file=")) continue;
    filtered.push(argument);
  }
  return filtered;
}
