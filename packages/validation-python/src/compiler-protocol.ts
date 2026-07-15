import type { ValidationDiagnosticToolProvenance } from "@the-open-engine/opcore-contracts";
import { hasExactProtocolKeys, hasOnlyProtocolKeys, isProtocolRecord } from "./protocol-validation.js";
import type { PythonMaterializedSourceFile } from "./source-files.js";
import type { ResolvedPythonInterpreter } from "./toolchain-resolver.js";

export const PYTHON_COMPILE_PROTOCOL = "opcore.python.compile.v1";

export const pythonCompileScript = String.raw`
import json
import platform
import sys

PROTOCOL = "opcore.python.compile.v1"

def positive(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None

def compiler_error(error, source):
    if "\x00" in source:
        kind = "null_byte"
        message = "source code string cannot contain null bytes"
    elif isinstance(error, TabError):
        kind = "tab_error"
        message = error.msg
    elif isinstance(error, IndentationError):
        kind = "indentation_error"
        message = error.msg
    elif isinstance(error, SyntaxError):
        kind = "syntax_error"
        message = error.msg
    elif isinstance(error, RecursionError):
        kind = "recursion_error"
        message = str(error) or "maximum recursion depth exceeded during compilation"
    else:
        kind = "overflow_error"
        message = str(error) or "compiler overflow"
    result = {"kind": kind, "message": message}
    for source_name, output_name in (
        ("lineno", "line"),
        ("offset", "column"),
        ("end_lineno", "endLine"),
        ("end_offset", "endColumn"),
    ):
        value = positive(getattr(error, source_name, None))
        if value is not None:
            result[output_name] = value
    return result

request = json.load(sys.stdin)
if not isinstance(request, dict) or request.get("protocol") != PROTOCOL or not isinstance(request.get("files"), list):
    raise ValueError("invalid compiler request")

results = []
for file in request["files"]:
    if not isinstance(file, dict) or set(file) != {"path", "content"}:
        raise ValueError("invalid compiler file request")
    path = file["path"]
    source = file["content"]
    if not isinstance(path, str) or not isinstance(source, str):
        raise ValueError("invalid compiler file values")
    try:
        compile(source, path, "exec", dont_inherit=True)
        results.append({"path": path, "status": "passed"})
    except (SyntaxError, ValueError, RecursionError, OverflowError) as error:
        if isinstance(error, ValueError) and "\x00" not in source:
            raise
        results.append({"path": path, "status": "finding", "error": compiler_error(error, source)})

print(json.dumps({
    "protocol": PROTOCOL,
    "interpreter": {"executable": sys.executable, "version": platform.python_version()},
    "results": results,
}, separators=(",", ":"), sort_keys=True))
`;

export type PythonCompilerErrorKind =
  | "syntax_error"
  | "indentation_error"
  | "tab_error"
  | "null_byte"
  | "recursion_error"
  | "overflow_error";

export interface PythonCompilerFinding {
  path: string;
  kind: PythonCompilerErrorKind;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export type PythonCompilerProtocolResult =
  | { status: "parsed"; findings: readonly PythonCompilerFinding[] }
  | { status: "malformed"; message: string };

export function compilerRequest(files: readonly PythonMaterializedSourceFile[]): string {
  return JSON.stringify({
    protocol: PYTHON_COMPILE_PROTOCOL,
    files: files.map((file) => ({ path: file.path, content: file.content }))
  });
}

export function parseCompilerResponse(
  stdout: string,
  files: readonly PythonMaterializedSourceFile[],
  interpreter: ResolvedPythonInterpreter
): PythonCompilerProtocolResult {
  const parsed = parseJsonObject(stdout);
  if (parsed === undefined || !hasExactProtocolKeys(parsed, ["protocol", "interpreter", "results"])) {
    return malformed("Python compiler returned malformed protocol output");
  }
  if (parsed.protocol !== PYTHON_COMPILE_PROTOCOL || !validInterpreter(parsed.interpreter, interpreter)) {
    return malformed("Python compiler response provenance does not match the resolved interpreter");
  }
  if (!Array.isArray(parsed.results) || parsed.results.length !== files.length) {
    return malformed("Python compiler response must contain exactly one result per requested file");
  }
  const findings: PythonCompilerFinding[] = [];
  for (const [index, expected] of files.entries()) {
    const result = parseFileResult(parsed.results[index], expected.path);
    if (result.status === "malformed") return result;
    if (result.finding !== undefined) findings.push(result.finding);
  }
  return { status: "parsed", findings };
}

export function compilerToolProvenance(interpreter: ResolvedPythonInterpreter): ValidationDiagnosticToolProvenance {
  return {
    name: "python",
    command: interpreter.command,
    version: interpreter.version,
    source: interpreter.source,
    cwd: interpreter.cwd
  };
}

function parseFileResult(
  value: unknown,
  expectedPath: string
): { status: "parsed"; finding?: PythonCompilerFinding } | { status: "malformed"; message: string } {
  if (!isProtocolRecord(value) || value.path !== expectedPath) return malformed(`Python compiler omitted or reordered ${expectedPath}`);
  if (value.status === "passed" && hasExactProtocolKeys(value, ["path", "status"])) return { status: "parsed" };
  if (value.status !== "finding" || !hasExactProtocolKeys(value, ["path", "status", "error"])) {
    return malformed(`Python compiler returned an invalid result for ${expectedPath}`);
  }
  const error = parseCompilerError(value.error);
  if (error === undefined) return malformed(`Python compiler returned an invalid diagnostic for ${expectedPath}`);
  return { status: "parsed", finding: { path: expectedPath, ...error } };
}

function parseCompilerError(value: unknown): Omit<PythonCompilerFinding, "path"> | undefined {
  if (!isProtocolRecord(value) || !hasOnlyProtocolKeys(value, ["kind", "message", "line", "column", "endLine", "endColumn"])) return undefined;
  if (!isCompilerErrorKind(value.kind)) return undefined;
  if (typeof value.message !== "string" || value.message.length === 0) return undefined;
  const location = parseCompilerLocation(value);
  if (location === undefined) return undefined;
  return { kind: value.kind, message: value.message, ...location };
}

function parseCompilerLocation(value: Record<string, unknown>): Omit<PythonCompilerFinding, "path" | "kind" | "message"> | undefined {
  const line = optionalPositiveInteger(value.line);
  const column = optionalPositiveInteger(value.column);
  const endLine = optionalPositiveInteger(value.endLine);
  const endColumn = optionalPositiveInteger(value.endColumn);
  if (![line, column, endLine, endColumn].every((field) => field.valid)) return undefined;
  const location = compactCompilerLocation(line.value, column.value, endLine.value, endColumn.value);
  return validCompilerLocationShape(location) ? location : undefined;
}

function compactCompilerLocation(
  line: number | undefined,
  column: number | undefined,
  endLine: number | undefined,
  endColumn: number | undefined
): Omit<PythonCompilerFinding, "path" | "kind" | "message"> {
  return {
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(endColumn === undefined ? {} : { endColumn })
  };
}

function validCompilerLocationShape(location: Omit<PythonCompilerFinding, "path" | "kind" | "message">): boolean {
  if (location.column !== undefined && location.line === undefined) return false;
  if (location.endLine !== undefined && location.line === undefined) return false;
  if (location.endColumn !== undefined && location.endLine === undefined) return false;
  return true;
}

function validInterpreter(value: unknown, expected: ResolvedPythonInterpreter): boolean {
  return isProtocolRecord(value) && hasExactProtocolKeys(value, ["executable", "version"]) &&
    value.executable === expected.command && value.version === expected.version;
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(stdout.trim());
    return isProtocolRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function malformed(message: string): { status: "malformed"; message: string } {
  return { status: "malformed", message };
}

const compilerErrorKinds: readonly PythonCompilerErrorKind[] = [
  "syntax_error",
  "indentation_error",
  "tab_error",
  "null_byte",
  "recursion_error",
  "overflow_error"
];

function optionalPositiveInteger(value: unknown): { valid: boolean; value?: number } {
  if (value === undefined) return { valid: true };
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return { valid: true, value };
  return { valid: false };
}

function isCompilerErrorKind(value: unknown): value is PythonCompilerErrorKind {
  return typeof value === "string" && compilerErrorKinds.some((kind) => kind === value);
}
