import type {
  ValidationCheckOutcome,
  ValidationDiagnostic,
  ValidationDiagnosticToolProvenance
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
import { readPythonAfterSources, skippedPythonInputResult } from "./source-files.js";
import { type PythonValidationToolchainOptions } from "./toolchain.js";
import {
  resolvePythonInterpreter,
  type PythonInterpreterResolution,
  type ResolvedPythonInterpreter
} from "./toolchain-resolver.js";

export interface PythonSyntaxCheckOptions extends PythonValidationToolchainOptions {
  timeoutMs?: number;
}

export function createSyntaxCheck(options: PythonSyntaxCheckOptions = {}): ValidationCheckDefinition {
  return {
    id: PYTHON_SYNTAX_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedPythonValidationScopes,
    run: async (context) => {
      const skipped = skippedPythonInputResult(context);
      if (skipped !== undefined) return skipped;

      const repoRoot = options.repoRoot ?? context.request.repo.repoRoot ?? process.cwd();
      const interpreter = resolvePythonInterpreter({
        repoRoot,
        env: options.env,
        pythonCommand: options.pythonCommand,
        targetPythonVersion: options.targetPythonVersion
      });
      if (!interpreter.available) return resolutionFailure(interpreter);

      const sources = await readPythonAfterSources(context);
      return compileSources(interpreter, sources, options);
    }
  };
}

async function compileSources(
  interpreter: ResolvedPythonInterpreter,
  sources: Awaited<ReturnType<typeof readPythonAfterSources>>,
  options: PythonSyntaxCheckOptions
): Promise<ValidationCheckResult> {
  const result = runTool(interpreter.command, ["-I", "-B", "-c", pythonCompileScript], {
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

function resolutionFailure(interpreter: Exclude<PythonInterpreterResolution, ResolvedPythonInterpreter>): ValidationCheckResult {
  const outcome = interpreter.outcome;
  const code = resolutionFailureCode(outcome);
  const unsupported = outcome === "tool_unavailable" || outcome === "invalid_config" || outcome === "unsupported_target";
  return {
    outcome,
    failureMessage: interpreter.failureMessage,
    diagnostics: [
      diagnostic({
        category: "infrastructure",
        severity: unsupported ? "info" : "error",
        code,
        message: interpreter.failureMessage,
        tool: unresolvedToolProvenance(interpreter)
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

function findingDiagnostic(finding: PythonCompilerFinding, interpreter: ResolvedPythonInterpreter): ValidationDiagnostic {
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

function resolutionFailureCode(outcome: Exclude<PythonInterpreterResolution["outcome"], "resolved">): string {
  const codes = {
    tool_unavailable: "PY_SYNTAX_TOOL_UNAVAILABLE",
    invalid_config: "PY_SYNTAX_INVALID_CONFIG",
    timeout: "PY_SYNTAX_INTERPRETER_TIMEOUT",
    unsupported_target: "PY_SYNTAX_UNSUPPORTED_TARGET",
    tool_failure: "PY_SYNTAX_INTERPRETER_FAILURE"
  } as const;
  return codes[outcome];
}

function unresolvedToolProvenance(interpreter: Exclude<PythonInterpreterResolution, ResolvedPythonInterpreter>) {
  return {
    name: "python",
    command: interpreter.command,
    ...(interpreter.version === undefined ? {} : { version: interpreter.version }),
    source: interpreter.source,
    cwd: interpreter.cwd
  };
}
