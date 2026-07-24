import type {
  PythonProjectContext,
  PythonProjectToolProvenance,
  PythonValidationAuthority,
  PythonValidationAuthoritySource,
  PythonTypesValidationCapabilityRun,
  PythonValidationCapabilityRunStatus,
  PythonValidationCapabilityToolProvenance
} from "@the-open-engine/opcore-contracts";
import { normalizeValidationFileViewPath, type ValidationFileView } from "@the-open-engine/opcore-validation";
import { isAbsolute, posix, relative, resolve } from "node:path";
import {
  materializePreparedPythonExecutionWorkspace,
  preparePythonExecutionWorkspace,
  readPythonExecutionWorkspaceRecords,
  type PythonExecutionWorkspaceRecord
} from "./python-execution-workspace.js";

export const isolatedMypyConfigPath = ".opcore-mypy-isolated.ini";

export interface PythonTypeCapabilityPreparation {
  project: PythonProjectContext;
  targets: readonly string[];
  selectedSourcePaths: readonly string[];
  selectedConfigPaths: readonly string[];
  moduleSearchRoots: readonly string[];
  afterStateManifestFingerprint: string;
  records: readonly PythonExecutionWorkspaceRecord[];
}

export interface MaterializedPythonTypeWorkspace {
  root: string;
  runtimeRoot: string;
  projectCwd: string;
  pythonPathEntries: readonly string[];
  selectedSourcePaths: readonly string[];
  selectedConfigPaths: readonly string[];
  afterStateContentByPath: ReadonlyMap<string, string>;
  cleanup(): void;
}

export async function preparePythonTypeCapability(args: {
  fileView: ValidationFileView;
  project: PythonProjectContext;
  targets: readonly string[];
  sourcePaths: readonly string[];
  configPaths: readonly string[];
  moduleSearchRoots?: readonly string[];
}): Promise<PythonTypeCapabilityPreparation> {
  const targets = uniqueSorted(args.targets);
  const selectedSourcePaths = uniqueSorted(args.sourcePaths);
  const selectedConfigPaths = uniqueSorted(args.configPaths);
  const manifestConfigPaths = authorityCandidatePaths(args.project.projectRoot);
  const records = await readPythonExecutionWorkspaceRecords(args.fileView, [
    ...selectedSourcePaths,
    ...selectedConfigPaths,
    ...manifestConfigPaths
  ]);
  const workspacePreparation = preparePythonExecutionWorkspace({
    project: args.project,
    targets,
    sourcePaths: selectedSourcePaths,
    configPaths: selectedConfigPaths,
    records
  });
  return {
    project: args.project,
    targets,
    selectedSourcePaths,
    selectedConfigPaths,
    moduleSearchRoots: uniqueSorted(args.moduleSearchRoots ?? args.project.sourceRoots),
    afterStateManifestFingerprint: workspacePreparation.afterStateFingerprint,
    records: workspacePreparation.records
  };
}

function authorityCandidatePaths(projectRoot: string): readonly string[] {
  const names = [".mypy.ini", "mypy.ini", "pyproject.toml", "pyrightconfig.json", "setup.cfg", "tox.ini"];
  return names.map((name) => projectRoot === "." ? name : `${projectRoot}/${name}`).sort();
}

export async function materializePythonTypeCapability(
  preparation: PythonTypeCapabilityPreparation
): Promise<MaterializedPythonTypeWorkspace> {
  const workspace = await materializePreparedPythonExecutionWorkspace({
    project: preparation.project,
    targets: preparation.targets,
    sourcePaths: preparation.selectedSourcePaths,
    configPaths: preparation.selectedConfigPaths,
    afterStateFingerprint: preparation.afterStateManifestFingerprint,
    records: preparation.records
  }, {
    tempPrefix: `opcore-python-types-workspace-${process.pid}-`,
    generatedProjectFiles: [{ path: isolatedMypyConfigPath, content: "[mypy]\n" }],
    runtimeDirectories: ["home", "xdg-config", "xdg-cache", "tmp", "pyright-cache"]
  });
  try {
    const pythonPathEntries = preparation.moduleSearchRoots.map((path) =>
      path === "." ? workspace.root : resolveRepoPath(workspace.root, path)
    );
    return {
      root: workspace.root,
      runtimeRoot: workspace.runtimeRoot,
      projectCwd: workspace.projectCwd,
      pythonPathEntries,
      selectedSourcePaths: workspace.sourcePaths,
      selectedConfigPaths: workspace.configPaths,
      afterStateContentByPath: workspace.afterStateContentByPath,
      cleanup: workspace.cleanup
    };
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
}

export function createPythonTypeCapabilityRun(args: {
  preparation: PythonTypeCapabilityPreparation;
  authority?: PythonValidationAuthority;
  authoritySource?: PythonValidationAuthoritySource;
  status: PythonValidationCapabilityRunStatus;
  durationMs: number;
  counts?: { diagnosticCount: number; errorCount: number; warningCount: number; noteCount: number };
  tool?: PythonValidationCapabilityToolProvenance;
  execution?: PythonTypesValidationCapabilityRun["execution"];
}): PythonTypesValidationCapabilityRun {
  const counts = args.counts ?? { diagnosticCount: 0, errorCount: 0, warningCount: 0, noteCount: 0 };
  return {
    schemaId: "opcore.python.validation-capability-run",
    schemaVersion: 1,
    capability: "types",
    checkId: "python.types",
    projectKey: args.preparation.project.projectKey,
    contextFingerprint: args.preparation.project.contextFingerprint,
    projectRoot: args.preparation.project.projectRoot,
    targets: args.preparation.targets,
    selectedSourcePaths: args.preparation.selectedSourcePaths,
    selectedConfigPaths: args.preparation.selectedConfigPaths,
    afterStateManifestFingerprint: args.preparation.afterStateManifestFingerprint,
    ...(args.authority === undefined ? {} : { authority: args.authority }),
    ...(args.authoritySource === undefined ? {} : { authoritySource: args.authoritySource }),
    status: args.status,
    ...(args.tool === undefined ? {} : { tool: args.tool }),
    ...(args.execution === undefined ? {} : { execution: args.execution }),
    durationMs: Math.max(0, Math.trunc(args.durationMs)),
    ...counts
  };
}

export function portablePythonValidationTool(args: {
  checker: PythonProjectToolProvenance;
  preparation: PythonTypeCapabilityPreparation;
  authority: PythonValidationAuthority;
  argv?: readonly string[];
}): PythonValidationCapabilityToolProvenance {
  const executable = portablePythonExecutableLocator(
    args.checker.executable,
    args.preparation.project.repositoryRoot
  );
  const observedArgv = args.argv ?? args.checker.argv;
  const argv = observedArgv.map((argument, index) => index === 0
    ? executable
    : portablePythonValidationArgument(argument, args.preparation.project.repositoryRoot));
  return {
    name: args.authority,
    executable,
    argv,
    cwd: args.preparation.project.projectRoot,
    source: args.checker.source,
    ...(args.checker.version === undefined ? {} : { version: args.checker.version }),
    ...(args.checker.configFile === undefined ? {} : { configFile: args.checker.configFile })
  };
}

export function portablePythonValidationArgument(argument: string, repositoryRoot: string): string {
  const assignment = /^(.*?=)(.*)$/u.exec(argument);
  if (assignment !== null && isHostAbsolutePath(assignment[2])) {
    return `${assignment[1]}${portablePythonExecutableLocator(assignment[2], repositoryRoot)}`;
  }
  return isHostAbsolutePath(argument) ? portablePythonExecutableLocator(argument, repositoryRoot) : argument;
}

export function portablePythonExecutableLocator(executable: string, repositoryRoot: string): string {
  if (!isHostAbsolutePath(executable)) {
    if (!executable.includes("/") && !executable.includes("\\")) return `path:${executable}`;
    const normalized = posix.normalize(executable.replaceAll("\\", "/").replace(/^\.\//u, ""));
    if (normalized !== ".." && !normalized.startsWith("../") && normalized !== ".") return `project:${normalized}`;
    return `external:${portableBasename(executable)}`;
  }
  const repositoryRelative = relative(repositoryRoot, executable).replaceAll("\\", "/");
  if (repositoryRelative.length > 0 && repositoryRelative !== ".." && !repositoryRelative.startsWith("../") && !isAbsolute(repositoryRelative)) {
    return `repo:${repositoryRelative}`;
  }
  return `external:${portableBasename(executable)}`;
}

function portableBasename(path: string): string {
  const value = path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "tool";
  return /^[A-Za-z0-9_.+-]+$/u.test(value) ? value : "tool";
}

function isHostAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

export function relativePythonProjectPath(path: string, projectRoot: string): string {
  if (projectRoot === ".") return path;
  return path === projectRoot ? "." : path.slice(`${projectRoot}/`.length);
}

export function repoRelativeMaterializedPath(path: string, projectCwd: string, workspaceRoot: string): string {
  const absolute = resolve(projectCwd, path);
  const repoPath = relative(workspaceRoot, absolute).replaceAll("\\", "/");
  if (repoPath.length === 0 || repoPath.startsWith("..") || repoPath.split("/").includes("..")) {
    throw new Error("mypy diagnostic path is outside the materialized repository");
  }
  return normalizeValidationFileViewPath(repoPath);
}

function resolveRepoPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) {
    throw new Error(`Repo-relative path escapes materialized Python workspace: ${path}`);
  }
  return absolute;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
