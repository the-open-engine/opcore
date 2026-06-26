import { dirname } from "node:path";
import type { EditPlan, EditRefusal, RepoRelativeChange, ValidationRequest } from "@the-open-engine/lattice-contracts";
import { decodeTextContent } from "./content-policy.js";
import { calculateEditChecksum } from "./hash.js";
import {
  createEditPathRefusal,
  normalizeEditRepoRelativePath,
  validateEditRepoIdentity,
  validateCreatePathInsideRepo,
  validateExistingPathInsideRepo
} from "./path-policy.js";
import type { EditFileStat, EditWorkspace } from "./workspace.js";
import { errorCode } from "./workspace.js";
import {
  createValidationRequestFromPlan,
  type EditPlanAfterState
} from "./validation-request.js";

export interface EditPlanPreviewSuccess {
  ok: true;
  planId: string;
  planHash?: string;
  afterState: EditPlanAfterState;
  validationRequest: ValidationRequest;
}

export interface EditPlanRollbackState {
  completed: boolean;
  restoredPaths: readonly string[];
  failedPaths: readonly string[];
  cleanupFailedPaths: readonly string[];
}

export interface EditPlanApplySuccess extends EditPlanPreviewSuccess {
  applied: true;
  appliedAt: string;
}

export interface EditPlanApplyRefusal {
  ok: false;
  applied: false;
  refusal: EditRefusal;
  rollback: EditPlanRollbackState;
}

export type EditPlanApplyResult = EditPlanApplySuccess | EditPlanApplyRefusal;
export type EditPlanPreviewResult = EditPlanPreviewSuccess | Omit<EditPlanApplyRefusal, "applied" | "rollback">;

interface FileSnapshot {
  path: string;
  absolutePath: string;
  existed: boolean;
  content?: string;
  stat?: EditFileStat;
}

type ReadSnapshotResult = { ok: true; value: FileSnapshot } | { ok: false; refusal: EditRefusal };

interface PreparedChange {
  change: RepoRelativeChange;
  index: number;
  snapshots: readonly FileSnapshot[];
  write?: {
    path: string;
    absolutePath: string;
    content: string;
    stat?: EditFileStat;
    tempPath?: string;
  };
  deletePath?: {
    path: string;
    absolutePath: string;
  };
}

interface PreparedPlan {
  afterState: EditPlanAfterState;
  changes: readonly PreparedChange[];
}

export async function previewEditPlan(workspace: EditWorkspace, plan: EditPlan): Promise<EditPlanPreviewResult> {
  const prepared = await preparePlan(workspace, plan);
  if (!prepared.ok) return { ok: false, refusal: prepared.refusal };
  return {
    ok: true,
    planId: plan.planId,
    planHash: plan.atomic.planHash,
    afterState: prepared.value.afterState,
    validationRequest: createValidationRequestFromPlan(plan, prepared.value.afterState)
  };
}

export async function applyEditPlan(workspace: EditWorkspace, plan: EditPlan): Promise<EditPlanApplyResult> {
  const prepared = await preparePlan(workspace, plan);
  const emptyRollback: EditPlanRollbackState = { completed: true, restoredPaths: [], failedPaths: [], cleanupFailedPaths: [] };
  if (!prepared.ok) return { ok: false, applied: false, refusal: prepared.refusal, rollback: emptyRollback };

  const tempPaths: string[] = [];
  const snapshots = uniqueSnapshots(prepared.value.changes.flatMap((change) => change.snapshots));
  try {
    for (const preparedChange of prepared.value.changes) {
      if (!preparedChange.write) continue;
      const directory = dirname(preparedChange.write.absolutePath);
      await workspace.fileSystem.mkdir(directory, { recursive: true });
      const tempPath = workspace.createTempPath(directory);
      preparedChange.write.tempPath = tempPath;
      tempPaths.push(tempPath);
      await workspace.failureHooks?.beforeStage?.(preparedChange.change, preparedChange.index);
      await workspace.fileSystem.writeFile(
        tempPath,
        preparedChange.write.content,
        preparedChange.write.stat ? { mode: permissionMode(preparedChange.write.stat) } : "utf8"
      );
      if (preparedChange.write.stat) {
        await workspace.fileSystem.chmod(tempPath, permissionMode(preparedChange.write.stat));
        await workspace.fileSystem.chown(tempPath, preparedChange.write.stat.uid, preparedChange.write.stat.gid);
      }
      await workspace.failureHooks?.afterStage?.(preparedChange.change, preparedChange.index, tempPath);
    }

    for (const preparedChange of prepared.value.changes) {
      await workspace.failureHooks?.beforeCommit?.(preparedChange.change, preparedChange.index);
      if (preparedChange.write) {
        if (!preparedChange.write.tempPath) throw new Error(`Missing staged temp file for ${preparedChange.write.path}`);
        await workspace.fileSystem.rename(preparedChange.write.tempPath, preparedChange.write.absolutePath);
      }
      if (preparedChange.deletePath) {
        await workspace.fileSystem.rm(preparedChange.deletePath.absolutePath, { force: false, recursive: false });
      }
      await workspace.failureHooks?.afterCommit?.(preparedChange.change, preparedChange.index);
    }

    return {
      ok: true,
      applied: true,
      appliedAt: new Date().toISOString(),
      planId: plan.planId,
      planHash: plan.atomic.planHash,
      afterState: prepared.value.afterState,
      validationRequest: createValidationRequestFromPlan(plan, prepared.value.afterState)
    };
  } catch (error) {
    const snapshotRollback = await rollbackSnapshots(workspace, snapshots);
    const cleanupFailedPaths = await cleanupTemps(workspace, tempPaths);
    const rollback: EditPlanRollbackState = {
      ...snapshotRollback,
      cleanupFailedPaths,
      completed: snapshotRollback.completed && cleanupFailedPaths.length === 0
    };
    return {
      ok: false,
      applied: false,
      refusal: {
        category: "conflict",
        message: `Atomic edit apply failed: ${errorMessage(error)}`
      },
      rollback
    };
  }
}

async function preparePlan(
  workspace: EditWorkspace,
  plan: EditPlan
): Promise<{ ok: true; value: PreparedPlan } | { ok: false; refusal: EditRefusal }> {
  const repo = validateEditRepoIdentity(plan.repo);
  if (!repo.ok) return { ok: false, refusal: repo.refusal };

  const touched = new Set<string>();
  const prepared: PreparedChange[] = [];
  const afterEntries: [string, string | null][] = [];

  for (let index = 0; index < plan.changes.length; index += 1) {
    const change = plan.changes[index];
    const duplicate = duplicateTouchedPath(change, touched);
    if (duplicate) {
      return { ok: false, refusal: createEditPathRefusal("conflict", `Conflicting operations touch ${duplicate}`, duplicate).refusal };
    }

    const preparedChange = await prepareChange(workspace, change, index);
    if (!preparedChange.ok) return preparedChange;
    prepared.push(preparedChange.value);

    if (change.kind === "create" || change.kind === "replace") afterEntries.push([change.path, change.content]);
    else if (change.kind === "delete") afterEntries.push([change.path, null]);
    else if (change.kind === "rename") {
      const sourceSnapshot = preparedChange.value.snapshots.find((snapshot) => snapshot.path === change.path);
      if (sourceSnapshot?.content === undefined) {
        return { ok: false, refusal: { category: "unsafe_edit", message: `Rename source content is missing for ${change.path}`, path: change.path } };
      }
      afterEntries.push([change.path, null], [change.toPath, sourceSnapshot.content]);
    }
  }

  return {
    ok: true,
    value: {
      afterState: Object.fromEntries(afterEntries.sort(([left], [right]) => left.localeCompare(right))),
      changes: prepared
    }
  };
}

async function prepareChange(
  workspace: EditWorkspace,
  change: RepoRelativeChange,
  index: number
): Promise<{ ok: true; value: PreparedChange } | { ok: false; refusal: EditRefusal }> {
  if (change.kind === "create") {
    const target = await validateCreatePathInsideRepo(workspace, change.path, { mustNotExist: true });
    if (!target.ok) return target;
    const snapshot = await readSnapshot(workspace, target.value.path, target.value.absolutePath);
    if (!snapshot.ok) return snapshot;
    return {
      ok: true,
      value: {
        change,
        index,
        snapshots: [snapshot.value],
        write: {
          path: target.value.path,
          absolutePath: target.value.absolutePath,
          content: change.content
        }
      }
    };
  }

  if (change.kind === "replace") {
    const target = await validateExistingPathInsideRepo(workspace, change.path);
    if (!target.ok) return target;
    const snapshot = await readSnapshot(workspace, target.value.path, target.value.absolutePath);
    if (!snapshot.ok) return snapshot;
    const checksum = snapshot.value.content === undefined ? undefined : calculateEditChecksum(snapshot.value.content);
    if (change.checksumBefore !== undefined && change.checksumBefore !== checksum) {
      return {
        ok: false,
        refusal: {
          category: "conflict",
          message: `Stale checksumBefore for ${target.value.path}: expected ${change.checksumBefore} but found ${checksum ?? "missing"}`,
          path: target.value.path
        }
      };
    }
    return {
      ok: true,
      value: {
        change,
        index,
        snapshots: [snapshot.value],
        write: {
          path: target.value.path,
          absolutePath: target.value.absolutePath,
          content: change.content,
          stat: target.value.stat
        }
      }
    };
  }

  if (change.kind === "delete") {
    const target = await validateExistingPathInsideRepo(workspace, change.path);
    if (!target.ok) return target;
    const snapshot = await readSnapshot(workspace, target.value.path, target.value.absolutePath);
    if (!snapshot.ok) return snapshot;
    const checksum = snapshot.value.content === undefined ? undefined : calculateEditChecksum(snapshot.value.content);
    if (change.checksumBefore !== undefined && change.checksumBefore !== checksum) {
      return {
        ok: false,
        refusal: {
          category: "conflict",
          message: `Stale checksumBefore for ${target.value.path}: expected ${change.checksumBefore} but found ${checksum ?? "missing"}`,
          path: target.value.path
        }
      };
    }
    return {
      ok: true,
      value: {
        change,
        index,
        snapshots: [snapshot.value],
        deletePath: {
          path: target.value.path,
          absolutePath: target.value.absolutePath
        }
      }
    };
  }

  if (change.kind !== "rename") {
    return { ok: false, refusal: { category: "unsupported_change", message: `Unsupported edit change kind: ${String((change as { kind?: unknown }).kind)}` } };
  }

  const source = await validateExistingPathInsideRepo(workspace, change.path);
  if (!source.ok) return source;
  const target = await validateCreatePathInsideRepo(workspace, change.toPath, { mustNotExist: true });
  if (!target.ok) return target;
  const sourceSnapshot = await readSnapshot(workspace, source.value.path, source.value.absolutePath);
  if (!sourceSnapshot.ok) return sourceSnapshot;
  const targetSnapshot = await readSnapshot(workspace, target.value.path, target.value.absolutePath);
  if (!targetSnapshot.ok) return targetSnapshot;
  const checksum = sourceSnapshot.value.content === undefined ? undefined : calculateEditChecksum(sourceSnapshot.value.content);
  if (change.checksumBefore !== undefined && change.checksumBefore !== checksum) {
    return {
      ok: false,
      refusal: {
        category: "conflict",
        message: `Stale checksumBefore for ${source.value.path}: expected ${change.checksumBefore} but found ${checksum ?? "missing"}`,
        path: source.value.path
      }
    };
  }
  if (sourceSnapshot.value.content === undefined) {
    return { ok: false, refusal: { category: "unsafe_edit", message: `Rename source is missing: ${source.value.path}`, path: source.value.path } };
  }
  return {
    ok: true,
    value: {
      change,
      index,
      snapshots: [sourceSnapshot.value, targetSnapshot.value],
      write: {
        path: target.value.path,
        absolutePath: target.value.absolutePath,
        content: sourceSnapshot.value.content,
        stat: source.value.stat
      },
      deletePath: {
        path: source.value.path,
        absolutePath: source.value.absolutePath
      }
    }
  };
}

async function readSnapshot(workspace: EditWorkspace, path: string, absolutePath: string): Promise<ReadSnapshotResult> {
  try {
    const fileStat = await workspace.fileSystem.stat(absolutePath);
    if (!fileStat.isFile()) {
      return { ok: true, value: { path, absolutePath, existed: true, stat: fileStat } };
    }
    const decoded = decodeTextContent(await workspace.fileSystem.readFile(absolutePath), path, "edit target");
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      value: {
        path,
        absolutePath,
        existed: true,
        content: decoded.value.content,
        stat: fileStat
      }
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        ok: true,
        value: {
          path,
          absolutePath,
          existed: false
        }
      };
    }
    throw error;
  }
}

async function rollbackSnapshots(workspace: EditWorkspace, snapshots: readonly FileSnapshot[]): Promise<EditPlanRollbackState> {
  const restoredPaths: string[] = [];
  const failedPaths: string[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      await workspace.failureHooks?.beforeRollback?.(snapshot.path);
      if (!snapshot.existed) {
        await workspace.fileSystem.rm(snapshot.absolutePath, { force: true, recursive: false });
      } else {
        if (snapshot.content === undefined || snapshot.stat === undefined) {
          throw new Error(`Cannot restore non-file snapshot: ${snapshot.path}`);
        }
        await workspace.fileSystem.mkdir(dirname(snapshot.absolutePath), { recursive: true });
        const tempPath = workspace.createTempPath(dirname(snapshot.absolutePath));
        await workspace.fileSystem.writeFile(tempPath, snapshot.content, { mode: permissionMode(snapshot.stat) });
        await workspace.fileSystem.chmod(tempPath, permissionMode(snapshot.stat));
        await workspace.fileSystem.chown(tempPath, snapshot.stat.uid, snapshot.stat.gid);
        await workspace.fileSystem.rename(tempPath, snapshot.absolutePath);
      }
      await workspace.failureHooks?.afterRollback?.(snapshot.path);
      restoredPaths.push(snapshot.path);
    } catch {
      failedPaths.push(snapshot.path);
    }
  }
  return {
    completed: failedPaths.length === 0,
    restoredPaths,
    failedPaths,
    cleanupFailedPaths: []
  };
}

async function cleanupTemps(workspace: EditWorkspace, tempPaths: readonly string[]): Promise<string[]> {
  const failedPaths: string[] = [];
  for (const tempPath of tempPaths) {
    try {
      await workspace.fileSystem.rm(tempPath, { force: true, recursive: false });
    } catch {
      failedPaths.push(tempPath);
    }
  }
  return failedPaths;
}

function uniqueSnapshots(snapshots: readonly FileSnapshot[]): FileSnapshot[] {
  const byPath = new Map<string, FileSnapshot>();
  for (const snapshot of snapshots) byPath.set(snapshot.path, snapshot);
  return [...byPath.values()];
}

function duplicateTouchedPath(change: RepoRelativeChange, touched: Set<string>): string | undefined {
  const paths = change.kind === "rename" ? [change.path, change.toPath] : [change.path];
  for (const path of paths) {
    const normalized = normalizeEditRepoRelativePath(path);
    const key = normalized.ok ? normalized.value : path;
    if (touched.has(key)) return key;
    touched.add(key);
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionMode(stat: EditFileStat): number {
  return stat.mode & 0o7777;
}
