import type {
  PythonProjectContext,
  PythonProjectToolKind,
  ValidationAdapterDegradedCheckStatus,
  ValidationAdapterRuntimeStatus,
  ValidationAdapterToolchainStatus
} from "@the-open-engine/opcore-contracts";
import { PYTHON_SYNTAX_CHECK_ID, PYTHON_TYPES_CHECK_ID, pythonValidationCheckIds } from "./check-ids.js";
import { validationPythonAdapterName } from "./check-constants.js";
import type { PythonProjectProcessProbe } from "./environment-resolution.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";

export interface PythonValidationToolchainOptions {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  interpreterArgv?: readonly string[];
  toolArgv?: Partial<Record<PythonProjectToolKind, readonly string[]>>;
  platform?: string;
  architecture?: string;
  processProbe?: PythonProjectProcessProbe;
  timeoutMs?: number;
  contexts?: readonly PythonProjectContext[];
  nodeWorkspace?: PythonProjectWorkspace;
}

export function createPythonValidationAdapterStatus(
  options: PythonValidationToolchainOptions = {}
): ValidationAdapterRuntimeStatus {
  const toolchain = options.contexts === undefined ? unresolvedContextToolchain() : toolchainFromContexts(options.contexts);
  const missing = new Set(toolchain.filter((tool) => !tool.available).map((tool) => tool.tool));
  const degradedChecks = createPythonDegradedChecks(missing);
  return {
    adapter: validationPythonAdapterName,
    status: degradedChecks.length > 0 || options.contexts?.some((context) => context.outcome !== "resolved")
      ? "degraded"
      : "available",
    checkIds: [...pythonValidationCheckIds],
    toolchain,
    degradedChecks,
    tempWorkspaceRequired: false
  };
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
      requiredTool: "python",
      message: "No compatible Python interpreter is available; python.syntax cannot compile the selected after-state."
    });
  }
  return degraded;
}

function toolchainFromContexts(contexts: readonly PythonProjectContext[]): readonly ValidationAdapterToolchainStatus[] {
  const entries: ValidationAdapterToolchainStatus[] = [];
  for (const context of contexts) {
    if (context.interpreter !== undefined) {
      entries.push({
        tool: "python",
        available: !context.reasons.some((reason) => reason.tool === "python"),
        command: context.interpreter.argv.join(" "),
        cwd: context.interpreter.cwd,
        source: context.interpreter.source,
        ...(context.interpreter.version === undefined ? {} : { version: context.interpreter.version })
      });
    } else {
      entries.push({ tool: "python", available: false, failureMessage: reasonMessage(context, "python") });
    }
    for (const tool of context.tools) {
      entries.push({
        tool: tool.tool,
        available: tool.available,
        command: tool.argv.join(" "),
        cwd: tool.cwd,
        source: tool.source,
        ...(tool.version === undefined ? {} : { version: tool.version }),
        ...(tool.configFile === undefined ? {} : { configFile: tool.configFile }),
        ...(tool.available ? {} : { failureMessage: reasonMessage(context, tool.tool) })
      });
    }
  }
  const byIdentity = new Map<string, ValidationAdapterToolchainStatus>();
  for (const entry of entries) byIdentity.set(`${entry.tool}\0${entry.command ?? ""}\0${entry.cwd ?? ""}`, entry);
  return [...byIdentity.values()].sort((left, right) => `${left.tool}\0${left.command ?? ""}`.localeCompare(`${right.tool}\0${right.command ?? ""}`));
}

function unresolvedContextToolchain(): readonly ValidationAdapterToolchainStatus[] {
  return ["python", "mypy", "pyright", "ruff", "pytest"].map((tool) => ({
    tool,
    available: false,
    failureMessage: "Canonical Python project contexts are required before reporting toolchain availability"
  }));
}

function reasonMessage(context: PythonProjectContext, tool: string): string {
  return context.reasons.find((reason) => reason.tool === tool)?.message ?? `${tool} unavailable for ${context.projectRoot}`;
}
