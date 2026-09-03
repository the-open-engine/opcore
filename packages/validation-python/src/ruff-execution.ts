import type {
  PythonProjectContext,
  PythonProjectToolProvenance,
  ValidationCheckOutcome,
  ValidationDiagnosticToolProvenance,
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { join } from "node:path";
import { diagnostic } from "./diagnostics.js";
import { missingPythonProjectContextResult } from "./python-context-result.js";
import {
  isAbsolutePortablePath,
  normalizePortablePath,
  toolProvenance,
  type MaterializedPythonExecutionWorkspace
} from "./python-execution-workspace.js";
import type { PythonToolRunResult } from "./process.js";
import {
  portablePythonExecutableLocator,
  portablePythonValidationArgument
} from "./type-capability-run.js";
import { isolatedTypeEnvironmentBase } from "./type-runner-runtime.js";

export type RuffCheckKind = "lint" | "format";

export function ruffCommandArgs(
  tool: PythonProjectToolProvenance,
  project: Pick<PythonProjectContext, "projectRoot" | "repositoryRoot">,
  subcommand: "check" | "format",
  args: readonly string[]
): readonly string[] {
  return [
    ...withoutRuffConfigOptions(tool.argv.slice(1)),
    subcommand,
    ...(tool.configFile === undefined
      ? []
      : ["--config", materializedRuffConfigPath(tool.configFile, project)]),
    ...args
  ];
}

export function ruffRunEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
  tool: PythonProjectToolProvenance,
  workspace: Pick<MaterializedPythonExecutionWorkspace, "runtimeRoot" | "projectCwd">
): Record<string, string> {
  return isolatedTypeEnvironmentBase({
    input: env === undefined ? undefined : { ...env },
    executable: tool.executable,
    workspace,
    extra: {
      PYTHONPATH: "",
      RUFF_NO_CACHE: "1",
      RUFF_CACHE_DIR: join(workspace.runtimeRoot, "ruff-cache")
    }
  });
}

export function missingRuffContextResult(kind: RuffCheckKind, missing: readonly string[]): ValidationCheckResult {
  return missingPythonProjectContextResult(
    kind === "lint" ? "PY_RUFF_LINT_CONTEXT_MISSING" : "PY_RUFF_FORMAT_CONTEXT_MISSING",
    missing
  );
}

export function hasUnresolvedRuffContext(context: PythonProjectContext): boolean {
  return context.reasons.some(isRuffContextFailureReason);
}

function isRuffContextFailureReason(reason: PythonProjectContext["reasons"][number]): boolean {
  return reason.tool === "ruff";
}

export function selectRuffTool(context: PythonProjectContext): PythonProjectToolProvenance | undefined {
  return context.tools.find((tool) => tool.tool === "ruff" && tool.available);
}

export function ruffContextFailure(kind: RuffCheckKind, context: PythonProjectContext): ValidationCheckResult {
  const tool = context.tools.find((entry) => entry.tool === "ruff");
  const reason = context.reasons.find(isRuffContextFailureReason) ?? context.reasons[0];
  const outcome = ruffContextOutcome(reason?.code);
  const unsupported = outcome === "tool_unavailable" || outcome === "invalid_config" || outcome === "unsupported_target";
  const message = reason?.message ?? `Ruff is unavailable for ${context.projectRoot}`;
  return {
    outcome,
    failureMessage: message,
    diagnostics: [diagnostic({
      category: "infrastructure",
      severity: unsupported ? "info" : "error",
      code: `${ruffDiagnosticPrefix(kind)}_${resolutionSuffix(outcome)}`,
      message,
      path: context.target,
      ...(tool === undefined ? {} : { tool: toolProvenance(tool) })
    })]
  };
}

export function ruffProcessFailure(
  kind: RuffCheckKind,
  tool: PythonProjectToolProvenance,
  result: PythonToolRunResult,
  project: Pick<PythonProjectContext, "projectRoot" | "repositoryRoot">
): ValidationCheckResult {
  const provenance = ruffExecutionProvenance(tool, result.args, project);
  if (result.termination === "timeout") {
    return ruffToolFailure(kind, "timeout", result.failureMessage ?? "ruff timed out", tool, provenance);
  }
  return ruffToolFailure(kind, "tool_failure", result.failureMessage ?? "ruff invocation failed", tool, provenance);
}

export function ruffConfigurationFailure(
  kind: RuffCheckKind,
  tool: PythonProjectToolProvenance,
  message: string,
  path?: string,
  provenance?: ValidationDiagnosticToolProvenance
): ValidationCheckResult {
  return {
    ...ruffToolFailure(kind, "invalid_config", message, tool, provenance),
    diagnostics: [diagnostic({
      category: "infrastructure",
      severity: "info",
      code: `${ruffDiagnosticPrefix(kind)}_INVALID_CONFIG`,
      message,
      ...(path === undefined ? {} : { path }),
      tool: provenance ?? toolProvenance(tool)
    })]
  };
}

function withoutRuffConfigOptions(args: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--config=")) continue;
    result.push(argument);
  }
  return result;
}

function materializedRuffConfigPath(
  configFile: string,
  project: Pick<PythonProjectContext, "projectRoot" | "repositoryRoot">
): string {
  let normalizedConfig = normalizePortablePath(configFile);
  if (isAbsolutePortablePath(normalizedConfig)) {
    const normalizedRepository = normalizePortablePath(project.repositoryRoot);
    const caseInsensitive = /^[A-Za-z]:\//u.test(normalizedRepository);
    const comparableConfig = caseInsensitive ? normalizedConfig.toLowerCase() : normalizedConfig;
    const comparableRepository = caseInsensitive ? normalizedRepository.toLowerCase() : normalizedRepository;
    if (!comparableConfig.startsWith(`${comparableRepository}/`)) {
      throw new Error(`Ruff configuration path is outside the repository: ${configFile}`);
    }
    normalizedConfig = normalizedConfig.slice(normalizedRepository.length + 1);
  }
  const normalizedProject = normalizePortablePath(project.projectRoot);
  if (normalizedProject === ".") return normalizedConfig;
  const projectSegments = normalizedProject.split("/").filter(Boolean);
  const configSegments = normalizedConfig.split("/").filter(Boolean);
  let shared = 0;
  while (
    shared < projectSegments.length &&
    shared < configSegments.length &&
    projectSegments[shared] === configSegments[shared]
  ) {
    shared += 1;
  }
  const relative = [
    ...Array(projectSegments.length - shared).fill(".."),
    ...configSegments.slice(shared)
  ].join("/");
  if (relative.length === 0) {
    throw new Error(`Ruff configuration path must identify a file: ${configFile}`);
  }
  return relative;
}

function ruffToolFailure(
  kind: RuffCheckKind,
  outcome: Exclude<ValidationCheckOutcome, "passed" | "findings" | "unsupported_target" | "tool_unavailable">,
  message: string,
  tool: PythonProjectToolProvenance,
  provenance?: ValidationDiagnosticToolProvenance
): ValidationCheckResult {
  const suffix = outcome === "timeout" ? "TIMEOUT" : outcome === "invalid_config" ? "INVALID_CONFIG" : "TOOL_FAILED";
  return {
    outcome,
    failureMessage: message,
    diagnostics: [diagnostic({
      category: "infrastructure",
      code: `${ruffDiagnosticPrefix(kind)}_${suffix}`,
      message,
      tool: provenance ?? toolProvenance(tool)
    })]
  };
}

export function ruffExecutionProvenance(
  tool: PythonProjectToolProvenance,
  args: readonly string[],
  project: Pick<PythonProjectContext, "projectRoot" | "repositoryRoot">
): ValidationDiagnosticToolProvenance {
  const executable = portablePythonExecutableLocator(tool.executable, project.repositoryRoot);
  const argv = [
    executable,
    ...args.map((argument) => portablePythonValidationArgument(argument, project.repositoryRoot))
  ];
  return {
    name: tool.tool,
    command: argv.join(" "),
    ...(tool.version === undefined ? {} : { version: tool.version }),
    source: tool.source,
    cwd: project.projectRoot
  };
}

function ruffContextOutcome(code: PythonProjectContext["reasons"][number]["code"] | undefined): ValidationCheckOutcome {
  if (code === "invalid_config") return "invalid_config";
  if (code === "interpreter_unavailable" || code === "tool_unavailable") return "tool_unavailable";
  if (code === "unsupported_target" || code === "unsupported_platform") return "unsupported_target";
  return "tool_failure";
}

function ruffDiagnosticPrefix(kind: RuffCheckKind): "PY_RUFF_LINT" | "PY_RUFF_FORMAT" {
  return kind === "lint" ? "PY_RUFF_LINT" : "PY_RUFF_FORMAT";
}

function resolutionSuffix(
  outcome: ValidationCheckOutcome
): "INVALID_CONFIG" | "TOOL_UNAVAILABLE" | "UNSUPPORTED_TARGET" | "TOOL_FAILED" {
  if (outcome === "invalid_config") return "INVALID_CONFIG";
  if (outcome === "tool_unavailable") return "TOOL_UNAVAILABLE";
  if (outcome === "unsupported_target") return "UNSUPPORTED_TARGET";
  return "TOOL_FAILED";
}
