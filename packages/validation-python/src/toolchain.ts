import type {
  ValidationAdapterDegradedCheckStatus,
  ValidationAdapterRuntimeStatus,
  ValidationAdapterToolchainStatus
} from "@the-open-engine/opcore-contracts";
import { PYTHON_TYPES_CHECK_ID, pythonValidationCheckIds } from "./check-ids.js";
import { validationPythonAdapterName } from "./check-constants.js";
import { runTool } from "./process.js";

export interface PythonValidationToolchainOptions {
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
  return [
    probeTool("mypy", "mypy", ["--version"], options.env),
    probeTool("pyright", "pyright", ["--version"], options.env),
    probeTool("ruff", "ruff", ["--version"], options.env),
    probeTool("pytest", "pytest", ["--version"], options.env)
  ];
}

export function pythonAvailable(options: PythonValidationToolchainOptions = {}): boolean {
  return probeTool("python", options.pythonCommand ?? "python3", ["--version"], options.env).available;
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
  return degraded;
}

function probeTool(
  tool: string,
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined> | undefined
): ValidationAdapterToolchainStatus {
  const result = runTool(command, args, { env });
  if (result.ok) {
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
    return {
      tool,
      available: true,
      command: [command, ...args].join(" "),
      ...(version.length > 0 ? { version } : {})
    };
  }
  return {
    tool,
    available: false,
    command: [command, ...args].join(" "),
    failureMessage: result.failureMessage ?? `${tool} unavailable`
  };
}
