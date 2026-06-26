import type { ValidationCheckDefinition, ValidationCheckContext, ValidationCheckResult } from "@the-open-engine/lattice-validation";
import type { ValidationDiagnostic } from "@the-open-engine/lattice-contracts";
import { RUST_FUNCTION_METRICS_CHECK_ID } from "./check-ids.js";
import {
  defaultRustFunctionMetricThresholds,
  rustCheckAdapter,
  rustCheckOwner,
  supportedRustValidationScopes
} from "./check-constants.js";
import { diagnostic, repoRelativePath, sortDiagnostics } from "./diagnostics.js";
import { materializeRustWorkspace, resolveRepoPath } from "./materialize.js";
import { runTool } from "./process.js";
import { isRustSourcePath, rustInputSet, skippedRustInputResult } from "./source-files.js";
import { toolAvailable } from "./toolchain.js";

export interface RustFunctionMetricThresholds {
  maxFunctionLines: number;
  maxComplexity: number;
  maxParams: number;
}

export function createFunctionMetricsCheck(
  options: {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    thresholds?: RustFunctionMetricThresholds;
  } = {}
): ValidationCheckDefinition {
  return {
    id: RUST_FUNCTION_METRICS_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    run: async (context) => {
      const skipped = skippedRustInputResult(context);
      if (skipped !== undefined) return skipped;
      if (!toolAvailable("rust-code-analysis-cli", { env: options.env })) {
        return {
          status: "unsupported_request",
          diagnostics: [],
          failureMessage: "rust-code-analysis-cli is unavailable"
        } as ValidationCheckResult;
      }
      return runFunctionMetrics(context, options);
    }
  };
}

async function runFunctionMetrics(
  context: ValidationCheckContext,
  options: {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    thresholds?: RustFunctionMetricThresholds;
  }
): Promise<ValidationCheckResult> {
  const thresholds = options.thresholds ?? defaultRustFunctionMetricThresholds;
  const materialized = await materializeRustWorkspace(context, { env: options.env });
  try {
    const diagnostics: ValidationDiagnostic[] = [];
    for (const path of rustInputSet(context).ownedPaths.filter(isRustSourcePath)) {
      if ((await context.fileView.readAfter(path)).status !== "found") continue;
      const absolutePath = resolveRepoPath(materialized.root, path);
      const result = runTool("rust-code-analysis-cli", ["-p", absolutePath, "-m", "-O", "json"], {
        cwd: materialized.root,
        env: options.env,
        timeoutMs: options.timeoutMs
      });
      if (!result.ok) {
        return {
          status: "infrastructure_failure",
          diagnostics: [],
          failureMessage: result.failureMessage ?? "rust-code-analysis-cli failed"
        };
      }
      const value = parseFunctionMetricJson(result.stdout);
      for (const fn of functionMetricEntries(value, materialized.root, path)) {
        if (fn.lines > thresholds.maxFunctionLines) {
          diagnostics.push(
            diagnostic({
              category: "policy",
              path: fn.path,
              code: "RUST_FUNCTION_LINES",
              message: `Rust function ${fn.name} has ${fn.lines} lines; max is ${thresholds.maxFunctionLines}.`
            })
          );
        }
        if (fn.complexity > thresholds.maxComplexity) {
          diagnostics.push(
            diagnostic({
              category: "policy",
              path: fn.path,
              code: "RUST_FUNCTION_COMPLEXITY",
              message: `Rust function ${fn.name} has cyclomatic complexity ${fn.complexity}; max is ${thresholds.maxComplexity}.`
            })
          );
        }
        if (fn.params > thresholds.maxParams) {
          diagnostics.push(
            diagnostic({
              category: "policy",
              path: fn.path,
              code: "RUST_FUNCTION_PARAMS",
              message: `Rust function ${fn.name} has ${fn.params} parameters; max is ${thresholds.maxParams}.`
            })
          );
        }
      }
    }
    return { diagnostics: sortDiagnostics(diagnostics) };
  } finally {
    materialized.cleanup();
  }
}

interface FunctionMetricEntry {
  name: string;
  path: string;
  lines: number;
  complexity: number;
  params: number;
}

interface FunctionMetricCollection {
  entries: FunctionMetricEntry[];
  seen: Set<string>;
  workspaceRoot: string;
  fallbackPath?: string;
}

interface FunctionMetricNode {
  name?: unknown;
  path?: unknown;
  file?: unknown;
  filename?: unknown;
  kind?: unknown;
  start_line?: unknown;
  end_line?: unknown;
  lines?: unknown;
  complexity?: unknown;
  cyclomatic_complexity?: unknown;
  params?: unknown;
  parameters?: unknown;
  spaces?: unknown;
  children?: unknown;
  functions?: unknown;
  metrics?: {
    cyclomatic?: { sum?: unknown; max?: unknown; total?: unknown };
    nargs?: { total?: unknown; functions_max?: unknown; max?: unknown };
    loc?: { sloc?: unknown; sloc_max?: unknown; lines?: unknown };
  };
}

function functionMetricEntries(value: unknown, workspaceRoot: string, fallbackPath?: string): readonly FunctionMetricEntry[] {
  const collection: FunctionMetricCollection = { entries: [], seen: new Set(), workspaceRoot, fallbackPath };
  visitFunctionMetricNode(value, fallbackPath, collection);
  return collection.entries;
}

function visitFunctionMetricNode(
  node: unknown,
  inheritedPath: string | undefined,
  collection: FunctionMetricCollection
): void {
  if (Array.isArray(node)) {
    for (const child of node) visitFunctionMetricNode(child, inheritedPath, collection);
    return;
  }
  if (!node || typeof node !== "object") return;
  const item = node as FunctionMetricNode;
  const nextPath = unitPath(item, collection.workspaceRoot) ?? inheritedPath ?? collection.fallbackPath;
  addFunctionMetricEntry(item, nextPath, collection);
  for (const child of functionMetricChildren(item)) visitFunctionMetricNode(child, nextPath, collection);
}

function addFunctionMetricEntry(
  item: FunctionMetricNode,
  path: string | undefined,
  collection: FunctionMetricCollection
): void {
  if (!isFunctionMetricNode(item) || typeof item.name !== "string" || path === undefined) return;
  const entry = functionMetricEntry(item, item.name, path, collection.workspaceRoot);
  const key = functionMetricEntryKey(entry);
  if (collection.seen.has(key)) return;
  collection.entries.push(entry);
  collection.seen.add(key);
}

function functionMetricEntry(
  item: FunctionMetricNode,
  name: string,
  path: string,
  workspaceRoot: string
): FunctionMetricEntry {
  return {
    name,
    path: repoRelativePath(workspaceRoot, path),
    lines: functionMetricLines(item),
    complexity: functionMetricComplexity(item),
    params: functionMetricParams(item)
  };
}

function functionMetricChildren(item: FunctionMetricNode): readonly unknown[] {
  return [item.spaces, item.children, item.functions];
}

function functionMetricEntryKey(entry: FunctionMetricEntry): string {
  return `${entry.path}\0${entry.name}\0${entry.lines}\0${entry.complexity}\0${entry.params}`;
}

function functionMetricLines(item: FunctionMetricNode): number {
  return numeric(item.metrics?.loc?.sloc, numeric(item.metrics?.loc?.lines, numeric(item.lines, lineCount(item.start_line, item.end_line))));
}

function functionMetricComplexity(item: FunctionMetricNode): number {
  return numeric(
    item.metrics?.cyclomatic?.sum,
    numeric(item.metrics?.cyclomatic?.max, numeric(item.metrics?.cyclomatic?.total, numeric(item.cyclomatic_complexity, numeric(item.complexity, 1))))
  );
}

function functionMetricParams(item: FunctionMetricNode): number {
  return numeric(item.metrics?.nargs?.total, numeric(item.metrics?.nargs?.functions_max, numeric(item.metrics?.nargs?.max, paramCount(item))));
}

function parseFunctionMetricJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`rust-code-analysis-cli returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function unitPath(
  item: { kind?: unknown; name?: unknown; path?: unknown; file?: unknown; filename?: unknown },
  workspaceRoot: string
): string | undefined {
  for (const value of [item.path, item.file, item.filename, item.kind === "unit" || item.kind === "file" ? item.name : undefined]) {
    if (typeof value === "string" && value.length > 0) return repoRelativePath(workspaceRoot, value);
  }
  return undefined;
}

function isFunctionMetricNode(item: { kind?: unknown; metrics?: unknown; name?: unknown; start_line?: unknown; end_line?: unknown }): boolean {
  return item.kind === "function" || (typeof item.name === "string" && item.metrics !== undefined && item.start_line !== undefined && item.end_line !== undefined);
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function lineCount(start: unknown, end: unknown): number {
  return typeof start === "number" && typeof end === "number" && end >= start ? end - start + 1 : 0;
}

function paramCount(item: { params?: unknown; parameters?: unknown }): number {
  if (typeof item.params === "number") return item.params;
  if (Array.isArray(item.params)) return item.params.length;
  if (typeof item.parameters === "number") return item.parameters;
  if (Array.isArray(item.parameters)) return item.parameters.length;
  return 0;
}
