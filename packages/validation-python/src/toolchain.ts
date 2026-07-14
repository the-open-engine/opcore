import type {
  ValidationAdapterDegradedCheckStatus,
  ValidationAdapterRuntimeStatus,
  ValidationAdapterToolchainStatus
} from "@the-open-engine/opcore-contracts";
import { PYTHON_SYNTAX_CHECK_ID, PYTHON_TYPES_CHECK_ID, pythonValidationCheckIds } from "./check-ids.js";
import { validationPythonAdapterName } from "./check-constants.js";
import { resolvePythonTool, type PythonToolResolution } from "./toolchain-resolver.js";

export interface PythonValidationToolchainOptions {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  pythonCommand?: string;
}

export function createPythonValidationAdapterStatus(
  options: PythonValidationToolchainOptions = {}
): ValidationAdapterRuntimeStatus {
  const checkIds = [...pythonValidationCheckIds];
  const toolchain = probePythonToolchain(options);
  const missing = new Set(toolchain.filter((tool) => !tool.available).map((tool) => tool.tool));
  const degradedChecks = createPythonDegradedChecks(missing);
  return {
    adapter: validationPythonAdapterName,
    status: degradedChecks.length > 0 ? "degraded" : "available",
    checkIds,
    toolchain,
    degradedChecks,
    tempWorkspaceRequired: false
  };
}

export function probePythonToolchain(
  options: PythonValidationToolchainOptions = {}
): readonly ValidationAdapterToolchainStatus[] {
  const resolverOptions = {
    repoRoot: options.repoRoot ?? process.cwd(),
    env: options.env,
    pythonCommand: options.pythonCommand
  };
  return [
    toToolchainStatus(resolvePythonTool("python", options.pythonCommand ?? "python3", ["--version"], resolverOptions)),
    toToolchainStatus(resolvePythonTool("mypy", "mypy", ["--version"], resolverOptions)),
    toToolchainStatus(resolvePythonTool("pyright", "pyright", ["--version"], resolverOptions)),
    toToolchainStatus(resolvePythonTool("ruff", "ruff", ["--version"], resolverOptions)),
    toToolchainStatus(resolvePythonTool("pytest", "pytest", ["--version"], resolverOptions))
  ];
}

export function pythonAvailable(options: PythonValidationToolchainOptions = {}): boolean {
  return resolvePythonTool("python", options.pythonCommand ?? "python3", ["--version"], {
    repoRoot: options.repoRoot ?? process.cwd(),
    env: options.env
  }).available;
}

export function createPythonDegradedChecks(missing: ReadonlySet<string>): readonly ValidationAdapterDegradedCheckStatus[] {
  const degraded: ValidationAdapterDegradedCheckStatus[] = [];
  if (missing.has("mypy") && missing.has("pyright")) {
    degraded.push({
      checkId: PYTHON_TYPES_CHECK_ID,
      status: "unsupported_request",
      reason: "optional_tool_unavailable",
      requiredTool: "mypy or pyright",
      message: "Neither mypy nor pyright is available; Python type validation is reported as degraded instead of passing silently."
    });
  }
  if (missing.has("python")) {
    degraded.push({
      checkId: PYTHON_SYNTAX_CHECK_ID,
      status: "unsupported_request",
      reason: "required_tool_unavailable",
      requiredTool: "python3",
      message: "No Python interpreter (python3) is available; python.syntax cannot be parser-validated, so results are reported as unsupported instead of a false pass."
    });
  }
  return degraded;
}

function toToolchainStatus(resolution: PythonToolResolution): ValidationAdapterToolchainStatus {
  return {
    tool: resolution.tool,
    available: resolution.available,
    command: [resolution.command, ...resolution.args].join(" "),
    cwd: resolution.cwd,
    source: resolution.source,
    ...(resolution.version !== undefined ? { version: resolution.version } : {}),
    ...(resolution.configFile !== undefined ? { configFile: resolution.configFile } : {}),
    ...(resolution.failureMessage !== undefined ? { failureMessage: resolution.failureMessage } : {})
  };
}
