import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_SYNTAX_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { runTool } from "./process.js";
import { readPythonAfterSources, skippedPythonInputResult } from "./source-files.js";
import { pythonAvailable, type PythonValidationToolchainOptions } from "./toolchain.js";

const compoundStatementPattern =
  /^(?:async\s+def|def|class|if|elif|else\b|for|while|try\b|except|finally\b|with|match|case)\b/u;

const PY_AST_CHECK_SCRIPT = `
import ast
import json
import sys

source = sys.stdin.read()
try:
    ast.parse(source)
    print(json.dumps({"ok": True}))
except SyntaxError as error:
    print(json.dumps({
        "ok": False,
        "message": error.msg,
        "line": error.lineno,
        "column": error.offset
    }))
except (ValueError, RecursionError) as error:
    print(json.dumps({
        "ok": False,
        "message": str(error),
        "line": None,
        "column": None
    }))
`;

export interface PythonSyntaxCheckOptions extends PythonValidationToolchainOptions {}

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

      const pythonCommand = options.pythonCommand ?? "python3";
      const parserAvailable = pythonAvailable({ env: options.env, pythonCommand });
      if (!parserAvailable) {
        return {
          status: "unsupported_request",
          diagnostics: [
            diagnostic({
              category: "syntax",
              severity: "info",
              code: "PY_SYNTAX_PARSER_UNAVAILABLE",
              message:
                "Python syntax validation requires a Python interpreter (python3); none is available, so results are reported as unsupported instead of a false pass."
            })
          ]
        };
      }

      const diagnostics: ValidationDiagnostic[] = [];
      for (const source of await readPythonAfterSources(context)) {
        const parserDiagnostics = parseWithPython(source.path, source.content, pythonCommand, options.env);
        diagnostics.push(...parserDiagnostics);
        if (parserDiagnostics.length === 0) diagnostics.push(...heuristicSyntaxDiagnostics(source.path, source.content));
      }
      return { diagnostics: sortDiagnostics(diagnostics) };
    }
  };
}

function parseWithPython(
  path: string,
  content: string,
  pythonCommand: string,
  env: Record<string, string | undefined> | undefined
): readonly ValidationDiagnostic[] {
  const result = runTool(pythonCommand, ["-c", PY_AST_CHECK_SCRIPT], {
    input: content,
    env,
    timeoutMs: 10000
  });

  let parsed: { ok: boolean; message?: string; line?: number | null; column?: number | null } | undefined;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    return [
      diagnostic({
        category: "syntax",
        path,
        code: "PY_SYNTAX_PARSE_ERROR",
        message: "Unable to parse Python source with the configured Python interpreter."
      })
    ];
  }

  if (parsed.ok) return [];

  return [
    diagnostic({
      category: "syntax",
      path,
      code: "PY_SYNTAX_PARSE_ERROR",
      message: buildParseErrorMessage(parsed)
    })
  ];
}

function buildParseErrorMessage(parsed: { message?: string; line?: number | null; column?: number | null }): string {
  const reason = parsed.message ?? "invalid syntax";
  if (parsed.line !== null && parsed.line !== undefined && parsed.column !== null && parsed.column !== undefined) {
    return `${reason} (line ${parsed.line}, column ${parsed.column})`;
  }
  return reason;
}

function heuristicSyntaxDiagnostics(path: string, content: string): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  diagnostics.push(...missingColonDiagnostics(path, content));
  diagnostics.push(...delimiterDiagnostics(path, content));
  return diagnostics;
}

function missingColonDiagnostics(path: string, content: string): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripInlineComment(rawLine).trim();
    if (line.length === 0 || line.endsWith(":") || line.endsWith("\\")) continue;
    if (!compoundStatementPattern.test(line)) continue;
    diagnostics.push(
      diagnostic({
        category: "syntax",
        path,
        code: "PY_SYNTAX_MISSING_COLON",
        message: "Python compound statements must end with a colon."
      })
    );
  }
  return diagnostics;
}

function delimiterDiagnostics(path: string, content: string): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const stack: string[] = [];
  let quote: "'" | "\"" | undefined;
  let tripleQuote: string | undefined;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const nextThree = content.slice(index, index + 3);
    if (tripleQuote !== undefined) {
      if (nextThree === tripleQuote) {
        tripleQuote = undefined;
        index += 2;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== undefined) {
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = undefined;
      if (char === "\n") quote = undefined;
      continue;
    }
    if (nextThree === "'''" || nextThree === "\"\"\"") {
      tripleQuote = nextThree;
      index += 2;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "#") {
      while (index < content.length && content[index] !== "\n") index += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const open = stack.pop();
      if (open === undefined || matchingClose(open) !== char) {
        diagnostics.push(
          diagnostic({
            category: "syntax",
            path,
            code: "PY_SYNTAX_MISMATCHED_DELIMITER",
            message: "Python delimiters are mismatched."
          })
        );
        break;
      }
    }
  }

  if (tripleQuote !== undefined || quote !== undefined) {
    diagnostics.push(
      diagnostic({
        category: "syntax",
        path,
        code: "PY_SYNTAX_UNTERMINATED_STRING",
        message: "Python string literal is unterminated."
      })
    );
  }
  if (stack.length > 0) {
    diagnostics.push(
      diagnostic({
        category: "syntax",
        path,
        code: "PY_SYNTAX_UNCLOSED_DELIMITER",
        message: "Python delimiters are not closed."
      })
    );
  }
  return diagnostics;
}

function matchingClose(open: string): string {
  return open === "(" ? ")" : open === "[" ? "]" : "}";
}

function stripInlineComment(line: string): string {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== undefined && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === undefined) quote = char;
      else if (quote === char) quote = undefined;
      continue;
    }
    if (quote === undefined && char === "#") return line.slice(0, index);
  }
  return line;
}
