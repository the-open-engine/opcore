import type {
  ValidationCheckRunStatus,
  ValidationDiagnostic,
  ValidationDiagnosticCategory
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { isAbsolute, relative } from "node:path";
import type { RustValidationProcessResult } from "./process.js";
import { parseJsonLines } from "./process.js";

export function diagnostic(args: {
  category: ValidationDiagnosticCategory;
  severity?: ValidationDiagnostic["severity"];
  path?: string;
  code?: string;
  message: string;
}): ValidationDiagnostic {
  const result: ValidationDiagnostic = {
    category: args.category,
    severity: args.severity ?? "error",
    message: args.message
  };
  if (args.path !== undefined && args.path.length > 0) result.path = normalizePath(args.path);
  if (args.code !== undefined && args.code.length > 0) result.code = args.code;
  return result;
}

export function mapCargoJsonDiagnostics(
  stdout: string,
  category: ValidationDiagnosticCategory,
  workspaceRoot: string,
  options: {
    includeCodes?: readonly string[];
    excludeCodes?: readonly string[];
    errorCodes?: readonly string[];
    forceSeverity?: ValidationDiagnostic["severity"];
  } = {}
): readonly ValidationDiagnostic[] {
  const includeCodes = new Set(options.includeCodes ?? []);
  const excludeCodes = new Set(options.excludeCodes ?? []);
  const errorCodes = new Set(options.errorCodes ?? []);
  const diagnostics: ValidationDiagnostic[] = [];
  for (const value of parseJsonLines(stdout, "cargo message-format JSON")) {
    const message = cargoCompilerMessage(value);
    if (message === undefined) continue;
    if (!isAllowedCargoDiagnostic(message, includeCodes, excludeCodes)) continue;
    const path = firstCargoSpanPath(message.spans, workspaceRoot);
    diagnostics.push(
      diagnostic({
        category,
        severity: options.forceSeverity ?? cargoDiagnosticSeverity(message, errorCodes),
        path,
        code: message.code,
        message: message.message
      })
    );
  }
  return sortDiagnostics(diagnostics);
}

export function stderrDiagnostic(args: {
  category: ValidationDiagnosticCategory;
  path: string | undefined;
  code: string;
  stderr: string;
  fallback: string;
}): ValidationDiagnostic {
  return diagnostic({
    category: args.category,
    path: args.path,
    code: args.code,
    message: args.stderr.trim().length > 0 ? args.stderr.trim() : args.fallback
  });
}

export function commandInfrastructureFailure(result: RustValidationProcessResult): ValidationCheckResult | undefined {
  if (result.failureMessage?.includes("failed to spawn") !== true && !result.timedOut) return undefined;
  return {
    status: "infrastructure_failure",
    diagnostics: [],
    failureMessage: result.failureMessage
  };
}

export function commandUnavailableFailure(
  result: RustValidationProcessResult,
  toolName: string
): ValidationCheckResult | undefined {
  const output = [result.stderr, result.stdout, result.failureMessage].filter(Boolean).join("\n");
  if (!isUnavailableToolOutput(output, toolName)) return undefined;
  return {
    status: "infrastructure_failure",
    diagnostics: [],
    failureMessage: output.trim() || `${toolName} is unavailable`
  };
}

export function requiredToolUnsupportedFailure(
  result: RustValidationProcessResult,
  toolName: string
): ValidationCheckResult | undefined {
  const output = [result.stderr, result.stdout, result.failureMessage].filter(Boolean).join("\n");
  if (!isUnavailableToolOutput(output, toolName)) return undefined;
  return {
    status: "unsupported_request",
    diagnostics: [],
    failureMessage: output.trim() || `${toolName} is unavailable`
  };
}

export function singleStderrPolicyFailure(args: {
  path: string | undefined;
  code: string;
  stderr: string;
  fallback: string;
}): ValidationCheckResult {
  return {
    diagnostics: [
      stderrDiagnostic({
        category: "policy",
        path: args.path,
        code: args.code,
        stderr: args.stderr,
        fallback: args.fallback
      })
    ]
  };
}

export function metadataFailureResult(metadata: {
  status: "policy_failure" | "infrastructure_failure" | "unsupported_request";
  diagnostics: readonly ValidationDiagnostic[];
  failureMessage: string;
}): ValidationCheckResult {
  if (metadata.status === "policy_failure") return { diagnostics: metadata.diagnostics };
  return {
    status: metadata.status as ValidationCheckRunStatus,
    diagnostics: metadata.diagnostics,
    failureMessage: metadata.failureMessage
  };
}

export function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort(compareDiagnostics);
}

function compareDiagnostics(left: ValidationDiagnostic, right: ValidationDiagnostic): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.category, right.category) ||
    compareText(left.severity, right.severity) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  );
}

function compareText(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "");
}

export function repoRelativePath(workspaceRoot: string, path: string): string {
  const relativePath = isAbsolute(path) ? relative(workspaceRoot, path) : path;
  return normalizePath(relativePath);
}

function firstCargoSpanPath(spans: unknown[] | undefined, workspaceRoot: string): string | undefined {
  if (!Array.isArray(spans)) return undefined;
  const span = spans.find(
    (entry): entry is { file_name: string; is_primary?: boolean } =>
      typeof entry === "object" && entry !== null && typeof (entry as { file_name?: unknown }).file_name === "string"
  );
  return span === undefined ? undefined : repoRelativePath(workspaceRoot, span.file_name);
}

interface CargoCompilerMessage {
  level: "error" | "warning";
  message: string;
  code?: string;
  spans?: unknown[];
}

function cargoCompilerMessage(value: unknown): CargoCompilerMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { reason?: unknown; message?: unknown };
  if (entry.reason !== "compiler-message" || !entry.message || typeof entry.message !== "object") return undefined;
  const rawMessage = entry.message as {
    level?: unknown;
    message?: unknown;
    code?: { code?: unknown } | null;
    spans?: unknown[];
  };
  const level = cargoDiagnosticLevel(rawMessage.level);
  if (level === undefined) return undefined;
  return {
    level,
    message: typeof rawMessage.message === "string" ? rawMessage.message : "Rust compiler diagnostic",
    code: typeof rawMessage.code?.code === "string" ? rawMessage.code.code : undefined,
    spans: rawMessage.spans
  };
}

function cargoDiagnosticLevel(level: unknown): CargoCompilerMessage["level"] | undefined {
  const normalized = typeof level === "string" ? level : "error";
  return normalized === "error" || normalized === "warning" ? normalized : undefined;
}

function cargoDiagnosticSeverity(
  message: CargoCompilerMessage,
  errorCodes: ReadonlySet<string>
): ValidationDiagnostic["severity"] {
  if (message.code !== undefined && errorCodes.has(message.code)) return "error";
  return message.level === "error" ? "error" : "warning";
}

function isAllowedCargoDiagnostic(
  message: CargoCompilerMessage,
  includeCodes: ReadonlySet<string>,
  excludeCodes: ReadonlySet<string>
): boolean {
  if (message.code !== undefined && excludeCodes.has(message.code)) return false;
  return includeCodes.size === 0 || (message.code !== undefined && includeCodes.has(message.code));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isUnavailableToolOutput(output: string, toolName: string): boolean {
  const escaped = escapeRegExp(toolName);
  return [
    new RegExp(`no such command:\\s*\`?${escaped}\`?`, "i"),
    new RegExp(`cargo-${escaped}[^\\n]*(?:not installed|is not installed|could not be found)`, "i"),
    new RegExp(`${escaped}[^\\n]*(?:not installed|is not installed|could not be found|unavailable)`, "i")
  ].some((pattern) => pattern.test(output));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
