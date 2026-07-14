import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import type { ValidationCheckOutcome, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PYTHON_TYPES_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { runTool } from "./process.js";
import { materializePythonSources, type PythonMaterializedSourceSet } from "./source-files.js";
import { type PythonValidationToolchainOptions } from "./toolchain.js";
import { resolvePythonTool, type PythonToolResolution } from "./toolchain-resolver.js";

export interface PythonTypeCheckOptions extends PythonValidationToolchainOptions {
  timeoutMs?: number;
}

interface MaterializedPythonTypeWorkspace {
  root: string;
  cleanup: () => void;
}

const pythonToolConfigFiles = [
  "mypy.ini",
  "setup.cfg",
  "tox.ini",
  "pyproject.toml",
  "pyrightconfig.json"
] as const;

export function createTypeCheck(options: PythonTypeCheckOptions = {}): ValidationCheckDefinition {
  return {
    id: PYTHON_TYPES_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    run: async (context) => {
      const sourceSet = await materializePythonSources(context);
      if (sourceSet.files.length === 0) return { diagnostics: [] };
      const repoRoot = context.request.repo.repoRoot ?? process.cwd();
      const checker = selectTypeChecker({ ...options, repoRoot });
      if (checker === undefined) {
        return {
          outcome: "tool_unavailable",
          failureMessage: "Neither mypy nor pyright is available.",
          diagnostics: [
            {
              category: "types",
              severity: "info",
              code: "PYTHON_TYPES_UNSUPPORTED",
              message: "Python type validation requires mypy or pyright; neither tool is available."
            }
          ]
        };
      }

      const workspace = await materializePythonTypeWorkspace(repoRoot, sourceSet);
      try {
        const result = runTool(checker.command, checkerArgs(checker, sourceSet), {
          cwd: workspace.root,
          env: options.env,
          timeoutMs: options.timeoutMs ?? 30000,
          allowedExitCodes: [0, 1]
        });
        if (!result.ok) {
          const outcome = result.termination === "timeout" ? "timeout" : "tool_failure";
          return typeToolFailure(checker, outcome, result.failureMessage ?? `${checker.tool} invocation failed`);
        }
        const diagnostics = sortDiagnostics(parseTypeCheckerDiagnostics(checker, result.stdout, result.stderr, workspace.root));
        if (result.exitCode !== 0 && diagnostics.length === 0) {
          return typeToolFailure(checker, "tool_failure", `${checker.tool} exited ${result.exitCode} without parseable diagnostics`);
        }
        return {
          outcome: diagnostics.some((entry) => entry.severity === "error") ? "findings" : "passed",
          diagnostics
        };
      } finally {
        workspace.cleanup();
      }
    }
  };
}

function selectTypeChecker(options: Required<Pick<PythonValidationToolchainOptions, "repoRoot">> & PythonValidationToolchainOptions): PythonToolResolution | undefined {
  const resolverOptions = { repoRoot: options.repoRoot, env: options.env, pythonCommand: options.pythonCommand };
  const mypy = resolvePythonTool("mypy", "mypy", ["--version"], resolverOptions);
  const pyright = resolvePythonTool("pyright", "pyright", ["--version"], resolverOptions);
  if (!mypy.available && !pyright.available) return undefined;
  if (pyright.available && !mypy.available) return pyright;
  if (mypy.available && !pyright.available) return mypy;
  if (pyright.configFile?.endsWith("pyrightconfig.json") && !mypy.configFile?.endsWith("mypy.ini")) return pyright;
  return mypy;
}

function checkerArgs(checker: PythonToolResolution, sourceSet: PythonMaterializedSourceSet): readonly string[] {
  if (checker.tool === "pyright") return [...sourceSet.rootPaths];
  return [...sourceSet.rootPaths];
}

async function materializePythonTypeWorkspace(
  repoRoot: string,
  sourceSet: PythonMaterializedSourceSet
): Promise<MaterializedPythonTypeWorkspace> {
  const tempRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-"));
  const root = join(tempRoot, "repo");
  try {
    await mkdir(root, { recursive: true });
    await copyPythonConfigFiles(repoRoot, root);
    for (const source of sourceSet.files) {
      const absolutePath = resolveRepoPath(root, source.path);
      await mkdir(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, source.content);
    }
    return { root, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function copyPythonConfigFiles(repoRoot: string, root: string): Promise<void> {
  for (const file of pythonToolConfigFiles) {
    const source = join(repoRoot, file);
    if (!existsSync(source)) continue;
    await copyFile(source, join(root, file));
  }
}

function resolveRepoPath(root: string, path: string): string {
  const absolutePath = resolve(root, path);
  const relativePath = relative(root, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.split(sep).includes("..")) {
    throw new Error(`Repo-relative path escapes materialized Python workspace: ${path}`);
  }
  return absolutePath;
}

function typeToolFailure(
  checker: PythonToolResolution,
  outcome: Extract<ValidationCheckOutcome, "timeout" | "tool_failure">,
  message: string
) {
  return {
    outcome,
    failureMessage: message,
    diagnostics: [
      diagnostic({
        category: "infrastructure",
        code: outcome === "timeout" ? "PYTHON_TYPES_TOOL_TIMEOUT" : "PYTHON_TYPES_TOOL_FAILED",
        message: `${checker.tool} could not run: ${message}`,
        tool: checkerProvenance(checker)
      })
    ]
  };
}

function parseTypeCheckerDiagnostics(
  checker: PythonToolResolution,
  stdout: string,
  stderr: string,
  workspaceRoot: string
): readonly ValidationDiagnostic[] {
  const text = [stdout, stderr].filter((part) => part.trim().length > 0).join("\n");
  const diagnostics: ValidationDiagnostic[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const parsed = checker.tool === "pyright"
      ? parsePyrightLine(line, workspaceRoot, checker)
      : parseMypyLine(line, workspaceRoot, checker);
    if (parsed !== undefined) diagnostics.push(parsed);
  }
  return diagnostics;
}

function parseMypyLine(
  line: string,
  workspaceRoot: string,
  checker: PythonToolResolution
): ValidationDiagnostic | undefined {
  const match = /^(?<path>.+?):(?<line>\d+)(?::(?<column>\d+))?:\s+(?<severity>error|warning|note):\s+(?<message>.+?)(?:\s+\[(?<code>[^\]]+)\])?$/u.exec(line.trim());
  if (match?.groups === undefined) return undefined;
  const severity = match.groups.severity === "error" ? "error" : "warning";
  const code = match.groups.code !== undefined ? `MYPY_${normalizeDiagnosticCode(match.groups.code)}` : "MYPY_TYPE_ERROR";
  return diagnostic({
    category: "types",
    severity,
    path: repoRelativeDiagnosticPath(match.groups.path, workspaceRoot),
    code,
    message: match.groups.message,
    line: parsePositiveInteger(match.groups.line),
    column: parsePositiveInteger(match.groups.column),
    tool: checkerProvenance(checker)
  });
}

function parsePyrightLine(
  line: string,
  workspaceRoot: string,
  checker: PythonToolResolution
): ValidationDiagnostic | undefined {
  const match = /^\s*(?<path>.+?):(?<line>\d+):(?<column>\d+)\s+-\s+(?<severity>error|warning|information):\s+(?<message>.+?)(?:\s+\((?<code>[^)]+)\))?$/u.exec(line.trim());
  if (match?.groups === undefined) return undefined;
  const severity = match.groups.severity === "error" ? "error" : match.groups.severity === "warning" ? "warning" : "info";
  const code = match.groups.code !== undefined ? `PYRIGHT_${normalizeDiagnosticCode(match.groups.code)}` : "PYRIGHT_TYPE_ERROR";
  return diagnostic({
    category: "types",
    severity,
    path: repoRelativeDiagnosticPath(match.groups.path, workspaceRoot),
    code,
    message: match.groups.message,
    line: parsePositiveInteger(match.groups.line),
    column: parsePositiveInteger(match.groups.column),
    tool: checkerProvenance(checker)
  });
}

function repoRelativeDiagnosticPath(path: string, workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot, path);
  const relativePath = relative(workspaceRoot, absolute).replaceAll("\\", "/");
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : path.replaceAll("\\", "/");
}

function normalizeDiagnosticCode(code: string): string {
  return code.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function checkerProvenance(checker: Pick<PythonToolResolution, "tool"> & Partial<PythonToolResolution>) {
  return {
    name: checker.tool,
    command: checker.command ?? checker.tool,
    ...(checker.version === undefined ? {} : { version: checker.version }),
    ...(checker.source === undefined ? {} : { source: checker.source }),
    ...(checker.cwd === undefined ? {} : { cwd: checker.cwd })
  };
}
