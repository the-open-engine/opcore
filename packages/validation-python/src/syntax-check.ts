import type {
  ValidationCheckOutcome,
  ValidationDiagnostic,
  ValidationDiagnosticToolProvenance,
  PythonInterpreterProvenance,
  PythonProjectContext
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { PYTHON_SYNTAX_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import {
  compilerRequest,
  compilerToolProvenance,
  parseCompilerResponse,
  pythonCompileScript,
  type PythonCompilerErrorKind,
  type PythonCompilerFinding
} from "./compiler-protocol.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { runTool } from "./process.js";
import { readPythonAfterSources, skippedPythonInputResult, type PythonProjectContextResolver } from "./source-files.js";
import { type PythonValidationToolchainOptions } from "./toolchain.js";

export interface PythonSyntaxCheckOptions extends Omit<PythonValidationToolchainOptions, "contexts"> {
  timeoutMs?: number;
}

export function createSyntaxCheck(
  options: PythonSyntaxCheckOptions = {},
  resolveContexts?: PythonProjectContextResolver
): ValidationCheckDefinition {
  return {
    id: PYTHON_SYNTAX_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedPythonValidationScopes,
    run: async (context) => {
      const skipped = skippedPythonInputResult(context);
      if (skipped !== undefined) return skipped;

      const sources = await readPythonAfterSources(context);
      if (resolveContexts === undefined) return missingContextResult(sources.map((source) => source.path));
      const resolvedContexts = await resolveContexts(context);
      const missing = sources.map((source) => source.path).filter((path) => !resolvedContexts.some((candidate) => candidate.target === path));
      if (resolvedContexts.length === 0 || missing.length > 0) return missingContextResult(missing);
      const unresolved = resolvedContexts.find((candidate) => candidate.interpreter === undefined || hasInterpreterFailure(candidate));
      if (unresolved !== undefined) return resolutionFailure(unresolved);
      const contexts = groupProjectContexts(resolvedContexts);
      const diagnostics: ValidationDiagnostic[] = [];
      for (const project of contexts) {
        if (project.interpreter === undefined) return resolutionFailure(project);
        const selected = sources.filter((source) => project.targets.includes(source.path));
        const result = await compileSources(project.interpreter, selected, options);
        diagnostics.push(...(result.diagnostics ?? []));
        if (result.outcome !== "passed" && result.outcome !== "findings") return result;
      }
      return { outcome: diagnostics.length === 0 ? "passed" : "findings", diagnostics: sortDiagnostics(diagnostics) };
    }
  };
}

function missingContextResult(missing: readonly string[]): ValidationCheckResult {
  const suffix = missing.length === 0 ? "" : `: ${missing.join(", ")}`;
  const message = `Canonical Python project context resolution returned no context for selected source${suffix}`;
  return {
    outcome: "tool_failure",
    failureMessage: message,
    diagnostics: [diagnostic({ category: "infrastructure", code: "PY_SYNTAX_CONTEXT_MISSING", message })]
  };
}

type PythonSyntaxProjectGroup = PythonProjectContext & { targets: readonly string[] };

function groupProjectContexts(contexts: readonly PythonProjectContext[]): readonly PythonSyntaxProjectGroup[] {
  const groups = new Map<string, { context: PythonProjectContext; targets: string[] }>();
  for (const context of contexts) {
    const group = groups.get(context.projectKey) ?? { context, targets: [] };
    group.targets.push(context.target);
    groups.set(context.projectKey, group);
  }
  return [...groups.values()]
    .map(({ context, targets }) => ({ ...context, targets: [...new Set(targets)].sort() }))
    .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
}

async function compileSources(
  interpreter: PythonInterpreterProvenance,
  sources: Awaited<ReturnType<typeof readPythonAfterSources>>,
  options: PythonSyntaxCheckOptions
): Promise<ValidationCheckResult> {
  const result = runTool(interpreter.executable, [...interpreter.argv.slice(1), "-I", "-B", "-c", pythonCompileScript], {
    cwd: interpreter.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 10000,
    input: compilerRequest(sources)
  });
  if (!result.ok) {
    const outcome = result.termination === "timeout" ? "timeout" : "tool_failure";
    return checkFailure(outcome, result.failureMessage ?? "Python compiler invocation failed", compilerToolProvenance(interpreter));
  }
  const response = parseCompilerResponse(result.stdout, sources, interpreter);
  if (response.status === "malformed") {
    return checkFailure("tool_failure", response.message, compilerToolProvenance(interpreter));
  }
  const diagnostics = response.findings.map((finding) => findingDiagnostic(finding, interpreter));
  return {
    outcome: diagnostics.length === 0 ? "passed" : "findings",
    diagnostics: sortDiagnostics(diagnostics)
  };
}

function resolutionFailure(context: PythonProjectContext): ValidationCheckResult {
  const primary = context.reasons.find((reason) => reason.tool === "python") ?? context.reasons[0];
  const outcome = primary?.code === "probe_timeout" ? "timeout" :
    primary?.code === "invalid_config" || context.outcome === "ambiguous" ? "invalid_config" :
    primary?.code === "incompatible_interpreter" || primary?.code === "unsupported_target" || primary?.code === "unsupported_platform"
      ? "unsupported_target" :
      primary?.code === "interpreter_unavailable" || primary?.code === "tool_unavailable" ? "tool_unavailable" : "tool_failure";
  const message = primary?.message ?? `Python project context is unresolved for ${context.target}`;
  const code = resolutionFailureCode(outcome);
  const unsupported = outcome === "tool_unavailable" || outcome === "invalid_config" || outcome === "unsupported_target";
  return {
    outcome,
    failureMessage: message,
    diagnostics: [
      diagnostic({
        category: "infrastructure",
        severity: unsupported ? "info" : "error",
        code,
        message,
        path: context.target,
        ...(context.interpreter === undefined ? {} : { tool: compilerToolProvenance(context.interpreter) })
      })
    ]
  };
}

function checkFailure(
  outcome: Extract<ValidationCheckOutcome, "timeout" | "tool_failure">,
  message: string,
  tool: ValidationDiagnosticToolProvenance
): ValidationCheckResult {
  return {
    outcome,
    failureMessage: message,
    diagnostics: [
      diagnostic({
        category: "infrastructure",
        code: outcome === "timeout" ? "PY_SYNTAX_COMPILER_TIMEOUT" : "PY_SYNTAX_COMPILER_FAILURE",
        message,
        tool
      })
    ]
  };
}

function findingDiagnostic(finding: PythonCompilerFinding, interpreter: PythonInterpreterProvenance): ValidationDiagnostic {
  return diagnostic({
    category: "syntax",
    path: finding.path,
    code: compilerFindingCode(finding.kind),
    message: finding.message,
    line: finding.line,
    column: finding.column,
    endLine: finding.endLine,
    endColumn: finding.endColumn,
    tool: compilerToolProvenance(interpreter)
  });
}

function compilerFindingCode(kind: PythonCompilerErrorKind): string {
  const codes: Record<PythonCompilerErrorKind, string> = {
    syntax_error: "PY_SYNTAX_ERROR",
    indentation_error: "PY_INDENTATION_ERROR",
    tab_error: "PY_TAB_ERROR",
    null_byte: "PY_NULL_BYTE",
    recursion_error: "PY_COMPILER_RECURSION_ERROR",
    overflow_error: "PY_COMPILER_OVERFLOW_ERROR"
  };
  return codes[kind];
}

function resolutionFailureCode(outcome: Exclude<ValidationCheckOutcome, "passed" | "findings">): string {
  const codes = {
    tool_unavailable: "PY_SYNTAX_TOOL_UNAVAILABLE",
    invalid_config: "PY_SYNTAX_INVALID_CONFIG",
    timeout: "PY_SYNTAX_INTERPRETER_TIMEOUT",
    unsupported_target: "PY_SYNTAX_UNSUPPORTED_TARGET",
    tool_failure: "PY_SYNTAX_INTERPRETER_FAILURE"
  } as const;
  return codes[outcome];
}

function hasInterpreterFailure(context: PythonProjectContext): boolean {
  return context.outcome === "ambiguous" || context.outcome === "unsupported" || context.reasons.some((reason) => reason.tool === "python" ||
    reason.code === "invalid_config" ||
    ["incompatible_interpreter", "unsupported_target", "unsupported_platform", "symlink_refused", "path_refused", "ambiguous_path"].includes(reason.code));
}
