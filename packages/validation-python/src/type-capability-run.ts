import type {
  PythonProjectContext,
  PythonProjectToolProvenance,
  PythonValidationAuthority,
  PythonValidationAuthoritySource,
  PythonValidationCapabilityRun,
  PythonValidationCapabilityRunStatus,
  PythonValidationCapabilityToolProvenance
} from "@the-open-engine/opcore-contracts";
import { normalizeValidationFileViewPath, type ValidationFileReadStatus, type ValidationFileView } from "@the-open-engine/opcore-validation";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export const isolatedMypyConfigPath = ".opcore-mypy-isolated.ini";

interface ManifestRecord {
  path: string;
  status: ValidationFileReadStatus;
  checksum?: string;
  content?: string;
}

export interface PythonTypeCapabilityPreparation {
  project: PythonProjectContext;
  targets: readonly string[];
  selectedSourcePaths: readonly string[];
  selectedConfigPaths: readonly string[];
  moduleSearchRoots: readonly string[];
  afterStateManifestFingerprint: string;
  records: readonly ManifestRecord[];
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
  const records: ManifestRecord[] = [];
  for (const path of uniqueSorted([
    ...selectedSourcePaths,
    ...selectedConfigPaths,
    ...manifestConfigPaths
  ])) {
    const state = await args.fileView.readAfter(path);
    records.push({
      path,
      status: state.status,
      ...(state.status === "found" ? { checksum: state.checksum, content: state.content } : {})
    });
  }
  const portableRecords = records.map(({ content: _content, ...record }) => record);
  const canonical = JSON.stringify({
    projectKey: args.project.projectKey,
    contextFingerprint: args.project.contextFingerprint,
    projectRoot: args.project.projectRoot,
    targets,
    records: portableRecords
  });
  return {
    project: args.project,
    targets,
    selectedSourcePaths,
    selectedConfigPaths,
    moduleSearchRoots: uniqueSorted(args.moduleSearchRoots ?? args.project.sourceRoots),
    afterStateManifestFingerprint: `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
    records
  };
}

function authorityCandidatePaths(projectRoot: string): readonly string[] {
  const names = [".mypy.ini", "mypy.ini", "pyproject.toml", "pyrightconfig.json", "setup.cfg", "tox.ini"];
  return names.map((name) => projectRoot === "." ? name : `${projectRoot}/${name}`).sort();
}

export async function materializePythonTypeCapability(
  preparation: PythonTypeCapabilityPreparation
): Promise<MaterializedPythonTypeWorkspace> {
  const tempRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-workspace-"));
  const rawRoot = join(tempRoot, "repo");
  try {
    await mkdir(rawRoot, { recursive: true });
    const root = await realpath(rawRoot);
    const runtimeRoot = await realpath(tempRoot);
    for (const record of preparation.records) {
      if (record.status !== "found" || record.content === undefined) continue;
      const absolute = resolveRepoPath(root, record.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, record.content, "utf8");
    }
    const projectCwd = preparation.project.projectRoot === "."
      ? root
      : resolveRepoPath(root, preparation.project.projectRoot);
    await mkdir(projectCwd, { recursive: true });
    await writeFile(join(projectCwd, isolatedMypyConfigPath), "[mypy]\n", "utf8");
    for (const name of ["home", "xdg-config", "xdg-cache", "tmp", "pyright-cache"]) {
      await mkdir(join(tempRoot, name), { recursive: true });
    }
    const pythonPathEntries = preparation.moduleSearchRoots.map((path) =>
      path === "." ? root : resolveRepoPath(root, path)
    );
    return {
      root,
      runtimeRoot,
      projectCwd,
      pythonPathEntries,
      selectedSourcePaths: preparation.selectedSourcePaths,
      selectedConfigPaths: preparation.selectedConfigPaths,
      afterStateContentByPath: new Map(preparation.records.flatMap((record) =>
        record.status === "found" && record.content !== undefined ? [[record.path, record.content] as const] : []
      )),
      cleanup: () => rmSync(tempRoot, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
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
  execution?: PythonValidationCapabilityRun["execution"];
}): PythonValidationCapabilityRun {
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
  const executable = portableExecutableLocator(
    args.checker.executable,
    args.preparation.project.repositoryRoot
  );
  const observedArgv = args.argv ?? args.checker.argv;
  const argv = observedArgv.map((argument, index) => index === 0
    ? executable
    : portableArgument(argument, args.preparation.project.repositoryRoot));
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

function portableArgument(argument: string, repositoryRoot: string): string {
  const assignment = /^(.*?=)(.*)$/u.exec(argument);
  if (assignment !== null && isHostAbsolutePath(assignment[2])) {
    return `${assignment[1]}${portableExecutableLocator(assignment[2], repositoryRoot)}`;
  }
  return isHostAbsolutePath(argument) ? portableExecutableLocator(argument, repositoryRoot) : argument;
}

function portableExecutableLocator(executable: string, repositoryRoot: string): string {
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
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.split(sep).includes("..")) {
    throw new Error(`Repo-relative path escapes materialized Python workspace: ${path}`);
  }
  return absolute;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
