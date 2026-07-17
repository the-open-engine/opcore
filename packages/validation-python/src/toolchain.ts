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
import { selectPythonTypeAuthority } from "./type-authority.js";

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
  const degradedChecks = pythonTypeDegradedChecks(options.contexts);
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

function pythonTypeDegradedChecks(
  contexts: readonly PythonProjectContext[] | undefined
): readonly ValidationAdapterDegradedCheckStatus[] {
  if (contexts === undefined) return [contextRequiredDegradation()];
  const typeGaps = contexts.flatMap(pythonTypeGap);
  const syntaxUnavailable = contexts.some((context) => context.interpreter === undefined);
  return [
    ...(typeGaps.length === 0 ? [] : [typeGapDegradation(typeGaps)]),
    ...(syntaxUnavailable ? [syntaxToolDegradation()] : [])
  ];
}

interface PythonTypeGap {
  projectRoot: string;
  reason: string;
  requiredTool: string;
  followUpIssue?: string;
}

function pythonTypeGap(context: PythonProjectContext): readonly PythonTypeGap[] {
  const selection = selectPythonTypeAuthority(context);
  if (selection.status === "invalid_config") {
    return [{ projectRoot: context.projectRoot, reason: selection.message ?? "Python type authority configuration is invalid", requiredTool: "one non-conflicting configured authority" }];
  }
  if (selection.status === "unsupported_target") {
    return [{ projectRoot: context.projectRoot, reason: selection.message ?? "Python type authority is not configured", requiredTool: "configured Python type authority" }];
  }
  if (selection.tool === undefined || !selection.tool.available) {
    const authority = selection.authority ?? "Python type";
    return [{ projectRoot: context.projectRoot, reason: `Configured ${authority} authority is unavailable`, requiredTool: authority }];
  }
  return [];
}

function typeGapDegradation(gaps: readonly PythonTypeGap[]): ValidationAdapterDegradedCheckStatus {
  const requiredTools = [...new Set(gaps.map((gap) => gap.requiredTool))];
  const followUps = [...new Set(gaps.flatMap((gap) => gap.followUpIssue === undefined ? [] : [gap.followUpIssue]))];
  return {
    checkId: PYTHON_TYPES_CHECK_ID,
    status: "unsupported_request",
    reason: "configured_authority_unavailable",
    requiredTool: requiredTools.length === 1 ? requiredTools[0] : "per-project configured authority",
    message: gaps.map((gap) => `${gap.projectRoot}: ${gap.reason}`).join("; "),
    ...(followUps.length === 1 ? { followUpIssue: followUps[0] } : {})
  };
}

function contextRequiredDegradation(): ValidationAdapterDegradedCheckStatus {
  return {
    checkId: PYTHON_TYPES_CHECK_ID,
    status: "unsupported_request",
    reason: "canonical_context_required",
    requiredTool: "configured Python type authority",
    message: "Canonical Python project contexts are required before reporting python.types authority status."
  };
}

function syntaxToolDegradation(): ValidationAdapterDegradedCheckStatus {
  return {
    checkId: PYTHON_SYNTAX_CHECK_ID,
    status: "unsupported_request",
    reason: "required_tool_unavailable",
    requiredTool: "python",
    message: "No compatible canonical project interpreter is available; python.syntax cannot compile the selected after-state."
  };
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
