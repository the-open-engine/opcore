import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  createValidationFileViewPythonWorkspace,
  type PythonProjectWorkspace
} from "./project-workspace.js";
import {
  materializePreparedPythonExecutionWorkspace,
  portableDirname,
  preparePythonExecutionWorkspace,
  type MaterializedPythonExecutionWorkspace,
  type PythonExecutionWorkspaceEvidence,
  type PythonExecutionWorkspaceRecord
} from "./python-execution-workspace.js";
import type { PythonProjectGroup } from "./project-groups.js";
import {
  isPyprojectConfig,
  portableRelativePath,
  repoRelativeConfigPath,
  resolveRuffExtendPath
} from "./ruff-config-paths.js";
import type { PythonMaterializedSourceFile } from "./source-files.js";

/**
 * Raised while resolving the selected Ruff configuration closure, before the after-state
 * workspace evidence exists. It never escapes this module.
 */
class RuffConfigResolutionError extends Error {
  readonly configPath: string;
  configPaths: readonly string[] = [];
  configRecords: readonly PythonExecutionWorkspaceRecord[] = [];

  constructor(configPath: string, message: string) {
    super(message);
    this.name = "RuffConfigResolutionError";
    this.configPath = configPath;
  }
}

/**
 * Selected-configuration failure raised to Ruff checks. It always carries the exact after-state
 * evidence a pre-execution receipt must bind - WHY: an activated Ruff receipt without source,
 * config, cwd, and fingerprint evidence cannot prove which state was refused.
 */
export class PythonExecutionWorkspaceConfigError extends Error {
  readonly configPath: string;
  readonly configPaths: readonly string[];
  readonly workspaceEvidence: PythonExecutionWorkspaceEvidence;

  constructor(source: RuffConfigResolutionError, workspaceEvidence: PythonExecutionWorkspaceEvidence) {
    super(source.message);
    this.name = "PythonExecutionWorkspaceConfigError";
    this.configPath = source.configPath;
    this.configPaths = source.configPaths;
    this.workspaceEvidence = workspaceEvidence;
  }
}

export async function materializePythonExecutionWorkspace(
  validation: ValidationCheckContext,
  project: PythonProjectGroup,
  files: readonly PythonMaterializedSourceFile[],
  nodeWorkspace?: PythonProjectWorkspace
): Promise<MaterializedPythonExecutionWorkspace> {
  const sourceRecords: PythonExecutionWorkspaceRecord[] = files.map((file) => ({
    path: file.path,
    status: "found",
    content: file.content
  }));
  let supportFiles: Awaited<ReturnType<typeof readSelectedRuffSupportFiles>>;
  try {
    supportFiles = await readSelectedRuffSupportFiles(validation, project.context, nodeWorkspace);
  } catch (error) {
    if (!(error instanceof RuffConfigResolutionError)) throw error;
    const preparation = preparePythonExecutionWorkspace({
      project: project.context,
      targets: project.targets,
      sourcePaths: sourceRecords.map((record) => record.path),
      configPaths: error.configPaths,
      records: [...sourceRecords, ...error.configRecords]
    });
    throw new PythonExecutionWorkspaceConfigError(error, {
      projectCwdRelative: preparation.project.projectRoot,
      afterStateFingerprint: preparation.afterStateFingerprint,
      sourcePaths: preparation.sourcePaths,
      configPaths: preparation.configPaths
    });
  }
  const supportRecords: PythonExecutionWorkspaceRecord[] = [...supportFiles.afterStateByPath]
    .map(([path, content]) => {
      const materializedContent = supportFiles.materializedByPath.get(path);
      return {
        path,
        status: "found",
        content,
        ...(materializedContent === undefined || materializedContent === content
          ? {}
          : { materializedContent })
      };
    });
  const preparation = preparePythonExecutionWorkspace({
    project: project.context,
    targets: project.targets,
    sourcePaths: sourceRecords.map((record) => record.path),
    configPaths: supportRecords.map((record) => record.path),
    records: [...sourceRecords, ...supportRecords]
  });
  return materializePreparedPythonExecutionWorkspace(preparation, {
    tempPrefix: "opcore-python-check-",
    runtimeDirectories: ["home", "xdg-config", "xdg-cache", "tmp", "ruff-cache"]
  });
}

async function readSelectedRuffSupportFiles(
  validation: ValidationCheckContext,
  context: PythonProjectContext,
  nodeWorkspace: PythonProjectWorkspace | undefined
): Promise<{
  afterStateByPath: ReadonlyMap<string, string>;
  materializedByPath: ReadonlyMap<string, string>;
}> {
  const selectedConfigPaths = context.tools
    .filter((tool) => tool.tool === "ruff" && tool.configFile !== undefined)
    .map((tool) => tool.configFile as string);
  const supportPaths = new Set<string>();
  const workspace = createValidationFileViewPythonWorkspace(validation.fileView, undefined, nodeWorkspace);
  const materializedOverrides = await addRuffExtendClosure(
    validation,
    context,
    selectedConfigPaths,
    supportPaths,
    workspace
  );
  const afterStateByPath = new Map<string, string>();
  const materializedByPath = new Map<string, string>();
  for (const path of [...supportPaths].sort()) {
    await assertConfinedRuffConfigPath(workspace, path);
    const result = await validation.fileView.readAfter(path);
    if (result.status !== "found") continue;
    afterStateByPath.set(path, result.content);
    materializedByPath.set(path, materializedOverrides.get(path) ?? result.content);
  }
  return { afterStateByPath, materializedByPath };
}

async function addRuffExtendClosure(
  validation: ValidationCheckContext,
  context: PythonProjectContext,
  selectedConfigPaths: readonly string[],
  supportPaths: Set<string>,
  workspace: PythonProjectWorkspace
): Promise<ReadonlyMap<string, string>> {
  const roots = selectedConfigPaths.map((path) => normalizeSelectedConfigPath(path, context.repositoryRoot));
  const visited = new Set<string>();
  const active: string[] = [];
  const configRecords = new Map<string, PythonExecutionWorkspaceRecord>();
  const materializedOverrides = new Map<string, string>();

  const visit = async (path: string): Promise<void> => {
    if (visited.has(path)) return;
    const cycleStart = active.indexOf(path);
    if (cycleStart >= 0) {
      const declaringPath = active.at(-1) ?? path;
      throw new RuffConfigResolutionError(
        declaringPath,
        `Ruff configuration extend cycle detected: ${[...active.slice(cycleStart), path].join(" -> ")}`
      );
    }
    active.push(path);
    supportPaths.add(path);
    await assertConfinedRuffConfigPath(workspace, path);
    const result = await validation.fileView.readAfter(path);
    configRecords.set(path, {
      path,
      status: result.status,
      ...(result.status === "found" ? { checksum: result.checksum, content: result.content } : {})
    });
    if (result.status !== "found") {
      throw new RuffConfigResolutionError(
        path,
        `Ruff configuration is missing from the after-state: ${path}`
      );
    }
    const parsed = parseRuffConfig(result.content, path);
    const extend = ruffExtendValue(parsed, path);
    if (extend === undefined) {
      active.pop();
      visited.add(path);
      return;
    }
    const extended = resolveRuffExtendPath(path, extend, context.repositoryRoot);
    if (extended.status === "invalid") {
      throw new RuffConfigResolutionError(path, extended.message);
    }
    supportPaths.add(extended.path);
    if (extended.rewrite) {
      setRuffExtendValue(parsed, path, portableRelativePath(portableDirname(path), extended.path));
      materializedOverrides.set(path, stringifyToml(parsed));
    }
    await visit(extended.path);
    active.pop();
    visited.add(path);
  };

  try {
    for (const path of roots) await visit(path);
  } catch (error) {
    if (error instanceof RuffConfigResolutionError) {
      error.configPaths = [...supportPaths].sort();
      error.configRecords = [...configRecords.values()].sort((left, right) => left.path.localeCompare(right.path));
    }
    throw error;
  }
  return materializedOverrides;
}

function normalizeSelectedConfigPath(path: string, repositoryRoot: string): string {
  try {
    return repoRelativeConfigPath(path, repositoryRoot);
  } catch (error) {
    throw new RuffConfigResolutionError(
      path,
      `Ruff configuration path is outside the after-state repository: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function assertConfinedRuffConfigPath(
  workspace: PythonProjectWorkspace,
  path: string
): Promise<void> {
  const resolved = await workspace.realpath(path);
  if (resolved.unavailable) {
    throw new RuffConfigResolutionError(
      path,
      `Ruff configuration realpath evidence is unavailable: ${path}`
    );
  }
  if (resolved.symlink || resolved.path !== path) {
    throw new RuffConfigResolutionError(
      path,
      `Symlinked Ruff configuration path is refused: ${path}`
    );
  }
}

function parseRuffConfig(content: string, path: string): Record<string, unknown> {
  try {
    const parsed = asTable(parseToml(content));
    if (parsed === undefined) throw new Error("TOML document root is not a table");
    return parsed;
  } catch {
    throw new RuffConfigResolutionError(
      path,
      `Ruff configuration is malformed: ${path}`
    );
  }
}

function ruffExtendValue(root: Record<string, unknown>, configPath: string): string | undefined {
  const tool = asTable(root?.tool);
  const ruff = asTable(tool?.ruff);
  return !isPyprojectConfig(configPath) && typeof root?.extend === "string"
    ? root.extend
    : typeof ruff?.extend === "string"
      ? ruff.extend
      : undefined;
}

function setRuffExtendValue(root: Record<string, unknown>, configPath: string, value: string): void {
  if (!isPyprojectConfig(configPath) && typeof root.extend === "string") {
    root.extend = value;
    return;
  }
  const ruff = asTable(asTable(root.tool)?.ruff);
  if (ruff === undefined || typeof ruff.extend !== "string") {
    throw new Error("Ruff extend rewrite requires a parsed extend value");
  }
  ruff.extend = value;
}

function asTable(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
