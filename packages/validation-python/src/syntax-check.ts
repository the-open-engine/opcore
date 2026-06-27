import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_SYNTAX_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { readPythonAfterSources, skippedPythonInputResult } from "./source-files.js";

const compoundStatementPattern =
  /^(?:async\s+def|def|class|if|elif|else\b|for|while|try\b|except|finally\b|with|match|case)\b/u;

export function createSyntaxCheck(): ValidationCheckDefinition {
  return {
    id: PYTHON_SYNTAX_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedPythonValidationScopes,
    run: async (context) => {
      const skipped = skippedPythonInputResult(context);
      if (skipped !== undefined) return skipped;
      const diagnostics: ValidationDiagnostic[] = [];
      for (const source of await readPythonAfterSources(context)) {
        diagnostics.push(...syntaxDiagnostics(source.path, source.content));
      }
      return { diagnostics: sortDiagnostics(diagnostics) };
    }
  };
}

function syntaxDiagnostics(path: string, content: string): readonly ValidationDiagnostic[] {
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
