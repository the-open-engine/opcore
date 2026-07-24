import type {
  PythonProjectContext,
  PythonProjectToolKind,
  ValidationAdapterDegradedCheckStatus,
  ValidationAdapterRuntimeStatus,
  ValidationAdapterToolchainStatus
} from "@the-open-engine/opcore-contracts";
import {
  PYTHON_RELEVANT_TESTS_CHECK_ID,
  PYTHON_RUFF_FORMAT_CHECK_ID,
  PYTHON_RUFF_LINT_CHECK_ID,
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_TYPES_CHECK_ID,
  pythonValidationCheckIds
} from "./check-ids.js";
import { validationPythonAdapterName } from "./check-constants.js";
import type { PythonProjectProcessProbe } from "./environment-resolution.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";
import { selectPythonTypeAuthority } from "./type-authority.js";
import { hasUnresolvedRuffContext } from "./ruff-execution.js";

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
  activeCheckIds?: readonly string[];
}

export function createPythonValidationAdapterStatus(
  options: PythonValidationToolchainOptions = {}
): ValidationAdapterRuntimeStatus {
  const toolchain = options.contexts === undefined ? unresolvedContextToolchain() : toolchainFromContexts(options.contexts);
  const missing = new Set(toolchain.filter((tool) => !tool.available).map((tool) => tool.tool));
  const activeChecks = new Set(options.activeCheckIds ?? [PYTHON_SYNTAX_CHECK_ID, PYTHON_TYPES_CHECK_ID]);
  const degradedChecks = pythonDegradedChecks(options.contexts, missing, activeChecks);
  const contextDegraded = (options.contexts ?? []).some((context) => contextHasActiveFailure(context, activeChecks));
  return {
    adapter: validationPythonAdapterName,
    status: degradedChecks.length > 0 || contextDegraded
      ? "degraded"
      : "available",
    checkIds: [...pythonValidationCheckIds],
    toolchain,
    degradedChecks,
    tempWorkspaceRequired: false
  };
}

function pythonDegradedChecks(
  contexts: readonly PythonProjectContext[] | undefined,
  missing: ReadonlySet<string>,
  activeChecks: ReadonlySet<string>
): readonly ValidationAdapterDegradedCheckStatus[] {
  const typeGaps = activeChecks.has(PYTHON_TYPES_CHECK_ID)
    ? contexts?.flatMap(pythonTypeGap) ?? []
    : [];
  const syntaxUnavailable =
    activeChecks.has(PYTHON_SYNTAX_CHECK_ID) &&
    (contexts?.some((context) => context.interpreter === undefined) ?? true);
  return [
    ...(activeChecks.has(PYTHON_TYPES_CHECK_ID) && contexts === undefined ? [contextRequiredDegradation()] : []),
    ...(typeGaps.length === 0 ? [] : [typeGapDegradation(typeGaps)]),
    ...(syntaxUnavailable ? [syntaxToolDegradation()] : []),
    ...ruffToolDegradations(missing, activeChecks)
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

function ruffToolDegradations(
  missing: ReadonlySet<string>,
  activeChecks: ReadonlySet<string>
): readonly ValidationAdapterDegradedCheckStatus[] {
  const degraded: ValidationAdapterDegradedCheckStatus[] = [];
  if (missing.has("ruff")) {
    if (activeChecks.has(PYTHON_RUFF_LINT_CHECK_ID)) {
      degraded.push({
        checkId: PYTHON_RUFF_LINT_CHECK_ID,
        status: "unsupported_request",
        reason: "optional_tool_unavailable",
        requiredTool: "ruff",
        message: "Ruff is unavailable; python.ruff-lint cannot lint the selected after-state."
      });
    }
    if (activeChecks.has(PYTHON_RUFF_FORMAT_CHECK_ID)) {
      degraded.push({
        checkId: PYTHON_RUFF_FORMAT_CHECK_ID,
        status: "unsupported_request",
        reason: "optional_tool_unavailable",
        requiredTool: "ruff",
        message: "Ruff is unavailable; python.ruff-format cannot verify formatting for the selected after-state."
      });
    }
  }
  return degraded;
}

function contextHasActiveFailure(
  context: PythonProjectContext,
  activeChecks: ReadonlySet<string>
): boolean {
  if (context.outcome === "resolved") return false;
  const activeTypes = activeChecks.has(PYTHON_TYPES_CHECK_ID);
  const activeSyntax = activeChecks.has(PYTHON_SYNTAX_CHECK_ID);
  const activeRuff = activeChecks.has(PYTHON_RUFF_LINT_CHECK_ID) || activeChecks.has(PYTHON_RUFF_FORMAT_CHECK_ID);
  const activeRelevantTests = activeChecks.has(PYTHON_RELEVANT_TESTS_CHECK_ID);
  const activeContextConsumer = activeTypes || activeSyntax || activeRuff || activeRelevantTests;
  if (!activeContextConsumer) return false;
  if (activeRuff && hasUnresolvedRuffContext(context)) return true;
  return context.reasons.some((reason) => {
    switch (reason.tool) {
      case "mypy":
      case "pyright":
        return activeTypes;
      case "ruff":
        return activeRuff;
      case "pytest":
        return activeRelevantTests;
      case "python":
        return activeTypes || activeSyntax || activeRelevantTests;
      default:
        return reason.code !== "missing_config" && (activeTypes || activeSyntax || activeRelevantTests);
    }
  });
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
