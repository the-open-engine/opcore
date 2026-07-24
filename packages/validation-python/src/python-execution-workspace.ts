import type {
  PythonProjectContext,
  PythonProjectToolProvenance,
  ValidationDiagnosticToolProvenance
} from "@the-open-engine/opcore-contracts";
import type {
  ValidationFileReadStatus,
  ValidationFileView
} from "@the-open-engine/opcore-validation";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pythonProjectDigest } from "./project-fingerprint.js";

export interface PythonExecutionWorkspaceEvidence {
  projectCwdRelative: string;
  afterStateFingerprint: string;
  sourcePaths: readonly string[];
  configPaths: readonly string[];
}

export interface MaterializedPythonExecutionWorkspace extends PythonExecutionWorkspaceEvidence {
  root: string;
  runtimeRoot: string;
  projectCwd: string;
  afterStateContentByPath: ReadonlyMap<string, string>;
  cleanup(): void;
}

export interface PythonExecutionWorkspaceRecord {
  path: string;
  status: ValidationFileReadStatus;
  checksum?: string;
  content?: string;
  materializedContent?: string;
}

export interface PythonExecutionWorkspacePreparation {
  project: PythonProjectContext;
  targets: readonly string[];
  sourcePaths: readonly string[];
  configPaths: readonly string[];
  afterStateFingerprint: string;
  records: readonly PythonExecutionWorkspaceRecord[];
}

interface PythonExecutionWorkspaceMaterializationOptions {
  tempPrefix: string;
  generatedProjectFiles?: readonly {
    path: string;
    content: string;
  }[];
  runtimeDirectories?: readonly string[];
}

export async function readPythonExecutionWorkspaceRecords(
  fileView: ValidationFileView,
  paths: readonly string[]
): Promise<readonly PythonExecutionWorkspaceRecord[]> {
  const records: PythonExecutionWorkspaceRecord[] = [];
  for (const path of uniqueSorted(paths)) {
    const state = await fileView.readAfter(path);
    records.push({
      path,
      status: state.status,
      ...(state.status === "found" ? { checksum: state.checksum, content: state.content } : {})
    });
  }
  return records;
}

export function preparePythonExecutionWorkspace(args: {
  project: PythonProjectContext;
  targets: readonly string[];
  sourcePaths: readonly string[];
  configPaths: readonly string[];
  records: readonly PythonExecutionWorkspaceRecord[];
}): PythonExecutionWorkspacePreparation {
  const targets = uniqueSorted(args.targets);
  const sourcePaths = uniqueSorted(args.sourcePaths);
  const configPaths = uniqueSorted(args.configPaths);
  const records = [...args.records].sort((left, right) => left.path.localeCompare(right.path));
  const portableRecords = records.map(({ content, materializedContent: _materializedContent, ...record }) => ({
    ...record,
    ...(record.status === "found" && record.checksum === undefined && content !== undefined
      ? { checksum: pythonProjectDigest(content) }
      : {})
  }));
  return {
    project: args.project,
    targets,
    sourcePaths,
    configPaths,
    afterStateFingerprint: pythonProjectDigest({
      projectKey: args.project.projectKey,
      contextFingerprint: args.project.contextFingerprint,
      projectRoot: args.project.projectRoot,
      targets,
      sourcePaths,
      configPaths,
      records: portableRecords
    }),
    records
  };
}

export async function materializePreparedPythonExecutionWorkspace(
  preparation: PythonExecutionWorkspacePreparation,
  options: PythonExecutionWorkspaceMaterializationOptions
): Promise<MaterializedPythonExecutionWorkspace> {
  const tempRoot = mkdtempSync(join(tmpdir(), options.tempPrefix));
  const rawRoot = join(tempRoot, "repo");
  try {
    await mkdir(rawRoot, { recursive: true });
    const root = realpathSync(rawRoot);
    const runtimeRoot = realpathSync(tempRoot);
    for (const record of preparation.records) {
      if (record.status !== "found") continue;
      const content = record.materializedContent ?? record.content;
      if (content === undefined) {
        throw new Error(`Found after-state Python workspace record omitted content: ${record.path}`);
      }
      await writeMaterializedFile(root, record.path, content);
    }
    const projectCwdRelative = preparation.project.projectRoot;
    const projectCwd = projectCwdRelative === "." ? root : resolveRepoPath(root, projectCwdRelative);
    await mkdir(projectCwd, { recursive: true });
    for (const file of options.generatedProjectFiles ?? []) {
      await writeMaterializedFile(projectCwd, file.path, file.content);
    }
    for (const path of options.runtimeDirectories ?? []) {
      await mkdir(resolveRepoPath(runtimeRoot, path), { recursive: true });
    }
    return {
      root,
      runtimeRoot,
      projectCwd,
      projectCwdRelative,
      afterStateFingerprint: preparation.afterStateFingerprint,
      sourcePaths: preparation.sourcePaths,
      configPaths: preparation.configPaths,
      afterStateContentByPath: new Map(preparation.records.flatMap((record) =>
        record.status === "found" && record.content !== undefined
          ? [[record.path, record.content] as const]
          : []
      )),
      cleanup: () => rmSync(tempRoot, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function relativeProjectPath(path: string, projectRoot: string): string {
  const normalizedPath = normalizePortablePath(path);
  const normalizedProjectRoot = normalizeMaterializedProjectRoot(projectRoot, normalizedPath);
  if (normalizedProjectRoot === ".") return normalizedPath;
  return normalizedPath.startsWith(`${normalizedProjectRoot}/`)
    ? normalizedPath.slice(normalizedProjectRoot.length + 1)
    : normalizedPath;
}

export function selectedRepoRelativeDiagnosticPath(
  path: string,
  checkerCwd: string,
  workspaceRoot: string,
  selectedSourcePaths: readonly string[]
): string | undefined {
  const absolute = canonicalExistingPath(resolve(checkerCwd, path));
  const canonicalWorkspaceRoot = canonicalExistingPath(workspaceRoot);
  const relativePath = relative(canonicalWorkspaceRoot, absolute).replaceAll("\\", "/");
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsolutePortablePath(relativePath)
  ) {
    return undefined;
  }
  return new Set(selectedSourcePaths.map(normalizePortablePath)).has(relativePath)
    ? relativePath
    : undefined;
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function toolProvenance(tool: PythonProjectToolProvenance): ValidationDiagnosticToolProvenance {
  return {
    name: tool.tool,
    command: tool.argv.join(" "),
    ...(tool.version === undefined ? {} : { version: tool.version }),
    source: tool.source,
    cwd: tool.cwd
  };
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

function normalizeMaterializedProjectRoot(projectRoot: string, path: string): string {
  const normalizedRoot = normalizePortablePath(projectRoot).replace(/\/+$/u, "");
  if (normalizedRoot.length === 0 || normalizedRoot === ".") return ".";
  if (!isAbsolutePortablePath(normalizedRoot)) return normalizedRoot;
  const pathDirectory = portableDirname(path);
  if (pathDirectory === ".") return ".";
  const rootSegments = normalizedRoot.split("/").filter(Boolean);
  const pathSegments = pathDirectory.split("/").filter(Boolean);
  if (pathSegments.length === 0 || pathSegments.length > rootSegments.length) return path;
  const rootSuffix = rootSegments.slice(-pathSegments.length).join("/");
  return rootSuffix === pathDirectory ? pathDirectory : path;
}

export function normalizePortablePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "") || ".";
}

export function isAbsolutePortablePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.startsWith("//");
}

export function portableDirname(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex < 0 ? "." : path.slice(0, separatorIndex) || "/";
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
