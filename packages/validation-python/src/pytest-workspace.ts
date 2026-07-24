import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import {
  removeMaterializedWorkspace,
  resolveMaterializedWorkspacePath,
  writeMaterializedWorkspaceFile
} from "./materialized-workspace.js";
import { pythonProjectDigest } from "./project-fingerprint.js";
import { createValidationFileViewPythonWorkspace, type PythonProjectWorkspace } from "./project-workspace.js";
import { isRelevantPythonConfig } from "./project-config-files.js";

export const pytestWorkspaceCaps = {
  maxCandidateFiles: 128,
  maxCollectedNodeIds: 2048,
  maxNodeIdBytes: 256 * 1024,
  maxManifestBytes: 256 * 1024,
  maxHookReportBytes: 512 * 1024,
  maxProcessOutputBytes: 512 * 1024,
  maxWorkspaceBytes: 4 * 1024 * 1024,
  maxArgvBytes: 16 * 1024
} as const;

export interface MaterializedPytestWorkspace {
  root: string;
  repoRoot: string;
  projectCwd: string;
  runtimeRoot: string;
  afterStateFingerprint: string;
  totalBytes: number;
  cleanup(): void;
}

export interface MaterializePytestWorkspaceArgs {
  context: ValidationCheckContext;
  project: PythonProjectContext;
  paths: readonly string[];
  nodeWorkspace?: PythonProjectWorkspace;
}

export async function materializePytestWorkspace(
  args: MaterializePytestWorkspaceArgs
): Promise<MaterializedPytestWorkspace> {
  const workspace = createValidationFileViewPythonWorkspace(args.context.fileView, undefined, args.nodeWorkspace);
  const tempRoot = mkdtempSync(join(tmpdir(), pytestWorkspacePrefix()));
  const repoRoot = join(tempRoot, "repo");
  const runtimeRoot = join(tempRoot, "runtime");
  let totalBytes = 0;
  try {
    await mkdir(repoRoot, { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });
    const normalizedPaths = [...new Set(args.paths)].sort();
    const fingerprintEntries: { path: string; content: string }[] = [];
    for (const path of normalizedPaths) {
      const real = await workspace.realpath(path);
      if (real.unavailable) throw new Error(`Pytest workspace realpath evidence is unavailable: ${path}`);
      if (real.symlink || real.path !== path) throw new Error(`Pytest workspace refuses symlinked path: ${path}`);
      const content = await workspace.read(path);
      if (content === undefined) throw new Error(`Pytest workspace materialization requires visible file: ${path}`);
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > pytestWorkspaceCaps.maxWorkspaceBytes) {
        throw new Error(`Pytest workspace exceeded ${pytestWorkspaceCaps.maxWorkspaceBytes} bytes`);
      }
      fingerprintEntries.push({ path, content });
      await writeMaterializedWorkspaceFile(repoRoot, path, content, "pytest workspace", await workspace.statMode?.(path) ?? 0o644);
    }
    const projectCwd = args.project.projectRoot === "." ? repoRoot : writeMaterializedProjectPath(repoRoot, args.project.projectRoot);
    return {
      root: tempRoot,
      repoRoot,
      projectCwd,
      runtimeRoot,
      totalBytes,
      afterStateFingerprint: pythonProjectDigest(fingerprintEntries),
      cleanup: () => removeMaterializedWorkspace(tempRoot, "Pytest temporary workspace")
    };
  } catch (error) {
    removeMaterializedWorkspace(tempRoot, "Pytest temporary workspace");
    throw error;
  }
}

export async function collectPytestProjectPaths(
  context: ValidationCheckContext,
  project: PythonProjectContext,
  candidatePaths: readonly string[],
  nodeWorkspace?: PythonProjectWorkspace
): Promise<readonly string[]> {
  const workspace = createValidationFileViewPythonWorkspace(context.fileView, undefined, nodeWorkspace);
  const visible = workspace.listAll === undefined ? await workspace.list() : await workspace.listAll();
  const relevant = new Set<string>();
  for (const path of visible) {
    if (!withinProject(path, project.projectRoot)) continue;
    relevant.add(path);
  }
  for (const candidate of candidatePaths) {
    if (withinProject(candidate, project.projectRoot)) relevant.add(candidate);
  }
  for (const evidence of project.evidence) {
    if (withinProject(evidence.path, project.projectRoot) && (isRelevantPythonConfig(evidence.path) || evidence.role === "config")) {
      relevant.add(evidence.path);
    }
  }
  return [...relevant].sort();
}

function withinProject(path: string, projectRoot: string): boolean {
  return projectRoot === "." || path === projectRoot || path.startsWith(`${projectRoot}/`);
}

function writeMaterializedProjectPath(root: string, path: string): string {
  return path === "." ? root : resolveMaterializedWorkspacePath(root, path, "pytest workspace");
}

function pytestWorkspacePrefix(): string {
  const configured = process.env.OPCORE_INTERNAL_PYTEST_WORKSPACE_PREFIX;
  if (configured === undefined) return "opcore-python-pytest-workspace-";
  if (!/^[A-Za-z0-9._-]+$/.test(configured) || !configured.endsWith("-")) {
    throw new Error("OPCORE_INTERNAL_PYTEST_WORKSPACE_PREFIX must be a simple basename ending with '-'");
  }
  return configured;
}
