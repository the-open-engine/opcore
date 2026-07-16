import type {
  PythonProjectContext,
  PythonProjectToolProvenance,
  ValidationCheckOutcome,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition,
  ValidationCheckResult
} from "@the-open-engine/opcore-validation";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PYTHON_TYPES_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { runTool } from "./process.js";
import {
  pythonInputSet,
  skippedPythonInputResult,
  type PythonMaterializedSourceFile,
  type PythonProjectContextResolver,
  type PythonSourceSetResolver
} from "./source-files.js";
import type { PythonValidationToolchainOptions } from "./toolchain.js";

export interface PythonTypeCheckOptions extends Omit<PythonValidationToolchainOptions, "contexts"> {
  timeoutMs?: number;
}

interface MaterializedPythonTypeWorkspace {
  root: string;
  projectCwd: string;
  cleanup(): void;
}

interface PythonProjectGroup {
  context: PythonProjectContext;
  targets: readonly string[];
}

export function createTypeCheck(
  options: PythonTypeCheckOptions = {},
  resolveContexts?: PythonProjectContextResolver,
  resolveSources?: PythonSourceSetResolver
): ValidationCheckDefinition {
  return {
    id: PYTHON_TYPES_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    run: async (context) => {
      const skipped = skippedPythonInputResult(context);
      if (skipped !== undefined) return skipped;
      if (resolveContexts === undefined) return missingContextResult(pythonInputSet(context));
      if (resolveSources === undefined) throw new Error("A shared Python source-set resolver is required for Python type validation");
      const sourceSet = await resolveSources(context);
      if (sourceSet.rootPaths.length === 0) return { diagnostics: [] };
      const resolvedContexts = await resolveContexts(context);
      const selectedTargets = sourceSet.rootPaths;
      const missing = selectedTargets.filter((path) => !resolvedContexts.some((candidate) => candidate.target === path));
      if (resolvedContexts.length === 0 || missing.length > 0) return missingContextResult(missing);
      if (sourceSet.files.length === 0) return { diagnostics: [] };
      const unresolved = resolvedContexts.find(isUnresolvedTypeContext);
      if (unresolved !== undefined) return unresolvedProjectResult(unresolved);
      const projects = groupProjectContexts(resolvedContexts);
      const diagnostics: ValidationDiagnostic[] = [];
      for (const project of projects) {
        const checker = selectTypeChecker(project.context);
        if (checker === undefined) return missingTypeChecker(project.context);
        const workspace = await materializePythonTypeWorkspace(context, project, sourceSet.files);
        try {
          const args = [
            ...materializedCheckerPrefix(checker, project.context.projectRoot),
            ...project.targets.map((path) => relativeProjectPath(path, project.context.projectRoot))
          ];
          const result = runTool(checker.executable, args, {
            cwd: workspace.projectCwd,
            env: options.env,
            timeoutMs: options.timeoutMs ?? 30000,
            allowedExitCodes: [0, 1]
          });
          if (!result.ok) {
            const outcome = result.termination === "timeout" ? "timeout" : "tool_failure";
            return typeToolFailure(checker, outcome, result.failureMessage ?? `${checker.tool} invocation failed`);
          }
          const parsed = parseTypeCheckerDiagnostics(
            checker,
            result.stdout,
            result.stderr,
            workspace.projectCwd,
            workspace.root
          );
          diagnostics.push(...parsed);
          if (result.exitCode !== 0 && parsed.length === 0) {
            return typeToolFailure(checker, "tool_failure", `${checker.tool} exited ${result.exitCode} without parseable diagnostics`);
          }
        } finally {
          workspace.cleanup();
        }
      }
      const sorted = sortDiagnostics(diagnostics);
      return { outcome: sorted.some((entry) => entry.severity === "error") ? "findings" : "passed", diagnostics: sorted };
    }
  };
}

function missingContextResult(missing: readonly string[]): ValidationCheckResult {
  const suffix = missing.length === 0 ? "" : `: ${missing.join(", ")}`;
  const message = `Canonical Python project context resolution returned no context for selected source${suffix}`;
  return {
    outcome: "tool_failure",
    failureMessage: message,
    diagnostics: [{
      category: "infrastructure",
      severity: "error",
      code: "PYTHON_CONTEXT_MISSING",
      message
    }]
  };
}

function groupProjectContexts(contexts: readonly PythonProjectContext[]): readonly PythonProjectGroup[] {
  const groups = new Map<string, { context: PythonProjectContext; targets: string[] }>();
  for (const context of contexts) {
    const group = groups.get(context.projectKey) ?? { context, targets: [] };
    group.targets.push(context.target);
    groups.set(context.projectKey, group);
  }
  return [...groups.values()]
    .map((group) => ({ context: group.context, targets: [...new Set(group.targets)].sort() }))
    .sort((left, right) => left.context.projectRoot.localeCompare(right.context.projectRoot));
}

function isUnresolvedTypeContext(context: PythonProjectContext): boolean {
  return context.outcome === "ambiguous" || context.outcome === "unsupported" || context.interpreter === undefined ||
    context.reasons.some((reason) => reason.code === "invalid_config");
}

function selectTypeChecker(context: PythonProjectContext): PythonProjectToolProvenance | undefined {
  const mypy = context.tools.find((tool) => tool.tool === "mypy" && tool.available);
  const pyright = context.tools.find((tool) => tool.tool === "pyright" && tool.available);
  if (pyright?.configFile !== undefined) return pyright;
  if (mypy?.configFile !== undefined) return mypy;
  return mypy ?? pyright;
}

async function materializePythonTypeWorkspace(
  validation: ValidationCheckContext,
  project: PythonProjectGroup,
  files: readonly PythonMaterializedSourceFile[]
): Promise<MaterializedPythonTypeWorkspace> {
  const tempRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-"));
  const root = join(tempRoot, "repo");
  try {
    await mkdir(root, { recursive: true });
    for (const source of files) await writeMaterializedFile(root, source.path, source.content);
    for (const evidence of project.context.evidence) {
      if (evidence.role === "layout" || evidence.role === "boundary" && !isConfigPath(evidence.path)) continue;
      const result = await validation.fileView.readAfter(evidence.path);
      if (result.status === "found") await writeMaterializedFile(root, evidence.path, result.content);
    }
    const projectCwd = project.context.projectRoot === "." ? root : resolveRepoPath(root, project.context.projectRoot);
    await mkdir(projectCwd, { recursive: true });
    return { root, projectCwd, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeMaterializedFile(root: string, path: string, content: string): Promise<void> {
  const absolutePath = resolveRepoPath(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function resolveRepoPath(root: string, path: string): string {
  const absolutePath = resolve(root, path);
  const relativePath = relative(root, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.split(sep).includes("..")) {
    throw new Error(`Repo-relative path escapes materialized Python workspace: ${path}`);
  }
  return absolutePath;
}

function unresolvedProjectResult(context: PythonProjectContext): ValidationCheckResult {
  const reason = context.reasons.find((entry) => entry.code === "invalid_config") ??
    context.reasons.find((entry) => entry.tool === "python") ?? context.reasons[0];
  const diagnostics: ValidationDiagnostic[] = [diagnostic({
    category: "infrastructure",
    severity: "info",
    code: context.outcome === "ambiguous" ? "PYTHON_CONTEXT_AMBIGUOUS" : "PYTHON_CONTEXT_UNSUPPORTED",
    message: reason?.message ?? `Python project context is unresolved for ${context.target}`,
    path: context.target
  })];
  if (selectTypeChecker(context) === undefined) {
    diagnostics.push({
      category: "types",
      severity: "info",
      code: "PYTHON_TYPES_UNSUPPORTED",
      message: `Python type validation requires mypy or pyright for project ${context.projectRoot}; neither tool is available.`
    });
  }
  return {
    outcome: reason?.code === "invalid_config" || context.outcome === "ambiguous" ? "invalid_config" : "unsupported_target",
    failureMessage: reason?.message ?? `Python project context is unresolved for ${context.target}`,
    diagnostics
  };
}

function missingTypeChecker(context: PythonProjectContext): ValidationCheckResult {
  return {
    outcome: "tool_unavailable",
    failureMessage: `Neither mypy nor pyright is available for ${context.projectRoot}.`,
    diagnostics: [{
      category: "types",
      severity: "info",
      code: "PYTHON_TYPES_UNSUPPORTED",
      message: `Python type validation requires mypy or pyright for project ${context.projectRoot}; neither tool is available.`
    }]
  };
}

function typeToolFailure(
  checker: PythonProjectToolProvenance,
  outcome: Extract<ValidationCheckOutcome, "timeout" | "tool_failure">,
  message: string
): ValidationCheckResult {
  return {
    outcome,
    failureMessage: message,
    diagnostics: [diagnostic({
      category: "infrastructure",
      code: outcome === "timeout" ? "PYTHON_TYPES_TOOL_TIMEOUT" : "PYTHON_TYPES_TOOL_FAILED",
      message: `${checker.tool} could not run: ${message}`,
      tool: checkerProvenance(checker)
    })]
  };
}

function parseTypeCheckerDiagnostics(
  checker: PythonProjectToolProvenance,
  stdout: string,
  stderr: string,
  checkerCwd: string,
  workspaceRoot: string
): readonly ValidationDiagnostic[] {
  const text = [stdout, stderr].filter((part) => part.trim().length > 0).join("\n");
  const diagnostics: ValidationDiagnostic[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const parsed = checker.tool === "pyright"
      ? parsePyrightLine(line, checkerCwd, workspaceRoot, checker)
      : parseMypyLine(line, checkerCwd, workspaceRoot, checker);
    if (parsed !== undefined) diagnostics.push(parsed);
  }
  return sortDiagnostics(diagnostics);
}

function parseMypyLine(
  line: string,
  checkerCwd: string,
  workspaceRoot: string,
  checker: PythonProjectToolProvenance
): ValidationDiagnostic | undefined {
  const match = /^(?<path>.+?):(?<line>\d+)(?::(?<column>\d+))?:\s+(?<severity>error|warning|note):\s+(?<message>.+?)(?:\s+\[(?<code>[^\]]+)\])?$/u.exec(line.trim());
  if (match?.groups === undefined) return undefined;
  return diagnostic({
    category: "types",
    severity: match.groups.severity === "error" ? "error" : "warning",
    path: repoRelativeDiagnosticPath(match.groups.path, checkerCwd, workspaceRoot),
    code: match.groups.code === undefined ? "MYPY_TYPE_ERROR" : `MYPY_${normalizeDiagnosticCode(match.groups.code)}`,
    message: match.groups.message,
    line: parsePositiveInteger(match.groups.line),
    column: parsePositiveInteger(match.groups.column),
    tool: checkerProvenance(checker)
  });
}

function parsePyrightLine(
  line: string,
  checkerCwd: string,
  workspaceRoot: string,
  checker: PythonProjectToolProvenance
): ValidationDiagnostic | undefined {
  const match = /^\s*(?<path>.+?):(?<line>\d+):(?<column>\d+)\s+-\s+(?<severity>error|warning|information):\s+(?<message>.+?)(?:\s+\((?<code>[^)]+)\))?$/u.exec(line.trim());
  if (match?.groups === undefined) return undefined;
  return diagnostic({
    category: "types",
    severity: match.groups.severity === "error" ? "error" : match.groups.severity === "warning" ? "warning" : "info",
    path: repoRelativeDiagnosticPath(match.groups.path, checkerCwd, workspaceRoot),
    code: match.groups.code === undefined ? "PYRIGHT_TYPE_ERROR" : `PYRIGHT_${normalizeDiagnosticCode(match.groups.code)}`,
    message: match.groups.message,
    line: parsePositiveInteger(match.groups.line),
    column: parsePositiveInteger(match.groups.column),
    tool: checkerProvenance(checker)
  });
}

function materializedCheckerPrefix(
  checker: PythonProjectToolProvenance,
  projectRoot: string
): readonly string[] {
  const prefix = [...checker.argv.slice(1)];
  if (checker.configFile === undefined) return prefix;
  const options = checker.tool === "mypy" ? ["--config", "--config-file"] : ["--project", "-p"];
  const materializedConfig = relativeProjectPath(checker.configFile, projectRoot);
  for (let index = 0; index < prefix.length; index += 1) {
    const argument = prefix[index];
    if (options.includes(argument)) {
      prefix[index + 1] = materializedConfig;
      index += 1;
      continue;
    }
    const option = options.find((candidate) => argument.startsWith(`${candidate}=`));
    if (option !== undefined) prefix[index] = `${option}=${materializedConfig}`;
  }
  return prefix;
}

function checkerProvenance(checker: PythonProjectToolProvenance) {
  return {
    name: checker.tool,
    command: checker.argv.join(" "),
    ...(checker.version === undefined ? {} : { version: checker.version }),
    source: checker.source,
    cwd: checker.cwd
  };
}

function repoRelativeDiagnosticPath(path: string, checkerCwd: string, workspaceRoot: string): string {
  const absolute = resolve(checkerCwd, path);
  const relativePath = relative(workspaceRoot, absolute).replaceAll("\\", "/");
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : path.replaceAll("\\", "/");
}

function normalizeDiagnosticCode(code: string): string {
  return code.replace(/([a-z])([A-Z])/gu, "$1_$2").replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toUpperCase();
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function relativeProjectPath(path: string, projectRoot: string): string {
  return projectRoot === "." ? path : path.slice(`${projectRoot}/`.length);
}


function isConfigPath(path: string): boolean {
  return /(?:\.toml|\.ini|\.cfg|\.lock|Pipfile|requirements.*\.txt)$/u.test(path);
}
