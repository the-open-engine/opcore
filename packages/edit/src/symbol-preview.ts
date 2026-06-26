import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  EditRefusal,
  GraphDetectChangesAvailableResult,
  GraphFactNode,
  GraphReviewContextAvailableResult,
  RepoIdentity,
  ValidationRequest
} from "@the-open-engine/opcore-contracts";
import type { EditPlannerResult } from "./planner.js";
import { createEditPlanFromChanges } from "./planner.js";
import {
  availableResultFromGraphCall,
  graphRequestBase,
  graphStatusFingerprint,
  requiredGraphStatus,
  type EditGraphProviderClient
} from "./symbol-graph.js";
import {
  materializeMoveSymbolEdit,
  materializeRenameSymbolEdit,
  materializeSignatureSymbolEdit,
  isSupportedSymbolSourcePath
} from "./language-service.js";
import type { SymbolEditRequest, SymbolEditTarget } from "./symbol-requests.js";
import type { EditWorkspace } from "./workspace.js";

export async function createSymbolEditPlan(
  workspace: EditWorkspace,
  repo: RepoIdentity,
  request: SymbolEditRequest,
  graphClient: EditGraphProviderClient | undefined
): Promise<EditPlannerResult> {
  const graphStatus = await requiredGraphStatus(repo, graphClient);
  if (!graphStatus.ok) return { ok: false, refusal: graphStatus.refusal };
  if (!graphClient) {
    return {
      ok: false,
      refusal: {
        category: "provider_required_missing",
        message: "GraphProvider client is not configured"
      }
    };
  }

  const targetEvidence = request.kind === "move"
    ? await collectMoveEvidence(workspace.repoRoot, graphClient, repo, request.fromPath)
    : await collectTargetEvidence(graphClient, repo, request.target);
  if (!targetEvidence.ok) return { ok: false, refusal: targetEvidence.refusal };

  let materialized: ReturnType<typeof materializeRenameSymbolEdit>;
  try {
    materialized = request.kind === "rename"
      ? materializeRenameSymbolEdit(workspace.repoRoot, request)
      : request.kind === "move"
        ? materializeMoveSymbolEdit(workspace.repoRoot, request)
        : materializeSignatureSymbolEdit(workspace.repoRoot, request);
  } catch (error) {
    return {
      ok: false,
      refusal: {
        category: "unsafe_edit",
        message: `Symbol edit planning failed: ${errorMessage(error)}`
      }
    };
  }
  if (!materialized.ok) return materialized;

  const validationRequest = seededValidationRequest(repo, graphStatus.status);
  return createEditPlanFromChanges(
    request.repo ?? repo,
    materialized.changes,
    { required: true },
    {
      validationRequest,
      afterState: materialized.afterState,
      planIdentity: {
        operation: request.kind,
        target: request.kind === "move" ? { fromPath: request.fromPath, toPath: request.toPath } : request.target,
        requestedShape: request.kind === "rename"
          ? { newName: request.newName }
          : request.kind === "signature"
            ? { changes: request.changes }
            : { toPath: request.toPath },
        graphFingerprint: graphStatusFingerprint(graphStatus.status),
        affectedChecksums: materialized.affectedChecksums,
        graphEvidence: targetEvidence.value
      }
    }
  );
}

async function collectTargetEvidence(
  client: EditGraphProviderClient,
  repo: RepoIdentity,
  target: SymbolEditTarget
): Promise<{ ok: true; value: unknown } | { ok: false; refusal: EditRefusal }> {
  const base = graphRequestBase(repo, "required");
  const symbols = await availableResultFromGraphCall(
    "GraphProvider symbol query",
    () => client.factQuery({
      requestId: "edit-symbols-target",
      ...base,
      selector: target.nodeId
        ? { kind: "symbols", ids: [target.nodeId], limit: 50 }
        : { kind: "symbols", text: target.name, limit: 50 }
    })
  );
  if (!symbols.ok) return symbols;

  const matches = matchingSymbolNodes(symbols.value.nodes, target);
  if (matches.length === 0) {
    const search = await availableResultFromGraphCall(
      "GraphProvider search",
      () => client.search({
        requestId: "edit-symbols-search",
        ...base,
        query: target.name,
        files: [target.path],
        limit: 20
      })
    );
    if (!search.ok) return search;
    const searchMatches = search.value.results.filter((entry) =>
      (target.nodeId === undefined || entry.nodeId === target.nodeId) &&
      (entry.path === target.path || entry.filePath === target.path) &&
      entry.name === target.name
    );
    if (searchMatches.length === 0) return refused("unsafe_edit", `GraphProvider did not find symbol target ${target.name} in ${target.path}`, target.path);
    if (searchMatches.length > 1 && target.line === undefined && target.nodeId === undefined) {
      return refused("unsafe_edit", `GraphProvider target is ambiguous for ${target.name} in ${target.path}`, target.path);
    }
  } else if (matches.length > 1 && target.line === undefined && target.nodeId === undefined) {
    return refused("unsafe_edit", `GraphProvider target is ambiguous for ${target.name} in ${target.path}`, target.path);
  }

  const targetId = target.nodeId ?? matches[0]?.id ?? target.name;
  for (const queryKind of ["importers_of", "callers_of", "file_summary"] as const) {
    const named = await availableResultFromGraphCall(
      `GraphProvider ${queryKind}`,
      () => client.namedQuery({
        requestId: `edit-symbols-${queryKind}`,
        ...base,
        queryKind,
        target: queryKind === "file_summary" ? target.path : targetId,
        maxDepth: 2,
        limit: 100
      })
    );
    if (!named.ok) return named;
  }
  const review = await availableResultFromGraphCall(
    "GraphProvider review context",
    () => client.reviewContext({
      requestId: "edit-symbols-review-context",
      ...base,
      maxDepth: 2,
      limit: 100
    })
  );
  if (!review.ok) return review;
  const changes = await availableResultFromGraphCall(
    "GraphProvider detect changes",
    () => client.detectChanges({
      requestId: "edit-symbols-detect-changes",
      ...base
    })
  );
  if (!changes.ok) return changes;
  const dirty = dirtyGraphEvidenceRefusal("symbol target", review.value, changes.value);
  if (dirty) return dirty;
  return {
    ok: true,
    value: {
      targetId,
      nodeCount: matches.length,
      reviewChangedFiles: review.value.changedFiles,
      detectChangedFiles: changes.value.changedFiles
    }
  };
}

async function collectMoveEvidence(
  repoRoot: string,
  client: EditGraphProviderClient,
  repo: RepoIdentity,
  fromPath: string
): Promise<{ ok: true; value: unknown } | { ok: false; refusal: EditRefusal }> {
  const base = graphRequestBase(repo, "required");
  const moveTargets = listMoveGraphTargets(repoRoot, fromPath);
  if (!moveTargets.ok) return moveTargets;
  const summaries: { target: string; nodeCount: number; edgeCount: number }[] = [];
  for (const target of moveTargets.value) {
    const summary = await availableResultFromGraphCall(
      "GraphProvider file summary",
      () => client.namedQuery({
        requestId: `edit-symbols-move-summary:${target}`,
        ...base,
        queryKind: "file_summary",
        target,
        maxDepth: 1,
        limit: 100
      })
    );
    if (!summary.ok) return summary;
    const nodeCount = summary.value.nodes.length;
    const edgeCount = summary.value.edges.length;
    if (nodeCount + edgeCount === 0) {
      return refused("unsupported_change", `GraphProvider file facts are required for move source ${target}`, target);
    }
    summaries.push({ target, nodeCount, edgeCount });
  }
  const review = await availableResultFromGraphCall(
    "GraphProvider review context",
    () => client.reviewContext({
      requestId: "edit-symbols-move-review",
      ...base,
      maxDepth: 2,
      limit: 100
    })
  );
  if (!review.ok) return review;
  const changes = await availableResultFromGraphCall(
    "GraphProvider detect changes",
    () => client.detectChanges({
      requestId: "edit-symbols-move-changes",
      ...base
    })
  );
  if (!changes.ok) return changes;
  const dirty = dirtyGraphEvidenceRefusal("move source", review.value, changes.value);
  if (dirty) return dirty;
  return {
    ok: true,
    value: {
      summaries,
      reviewChangedFiles: review.value.changedFiles,
      detectChangedFiles: changes.value.changedFiles
    }
  };
}

function matchingSymbolNodes(nodes: readonly GraphFactNode[], target: SymbolEditTarget): readonly GraphFactNode[] {
  return nodes.filter((node) =>
    (target.nodeId === undefined || node.id === target.nodeId) &&
    (node.path === undefined || node.path === target.path) &&
    (node.name === undefined || node.name === target.name)
  );
}

function seededValidationRequest(repo: RepoIdentity, status: ValidationRequest["graph"]["status"]): ValidationRequest {
  return {
    repo,
    scope: { kind: "repo" },
    graph: {
      mode: "required",
      provider: "lattice-graph",
      status
    },
    overlays: []
  };
}

function listMoveGraphTargets(repoRoot: string, fromPath: string): { ok: true; value: readonly string[] } | { ok: false; refusal: EditRefusal } {
  const absolutePath = resolve(repoRoot, fromPath);
  if (!isInside(repoRoot, absolutePath)) return refused("parent_directory", `Move source escapes repository: ${fromPath}`, fromPath);
  let realPath: string;
  let sourceStat: ReturnType<typeof statSync>;
  try {
    realPath = realpathSync(absolutePath);
    sourceStat = statSync(absolutePath);
  } catch (error) {
    return refused("unsafe_edit", `Move source cannot be inspected for graph facts: ${fromPath}: ${errorMessage(error)}`, fromPath);
  }
  if (!isInside(repoRoot, realPath)) {
    return refused("unsafe_edit", `Move source resolves outside repository through a symlink: ${fromPath}`, fromPath);
  }

  if (sourceStat.isFile()) return { ok: true, value: [repoPath(repoRoot, absolutePath)] };
  if (!sourceStat.isDirectory()) return refused("unsupported_change", `Move source is not a file or directory: ${fromPath}`, fromPath);

  const sourceFiles = listSourceGraphTargets(repoRoot, absolutePath);
  if (!sourceFiles.ok) return sourceFiles;
  return {
    ok: true,
    value: sourceFiles.value.length > 0 ? sourceFiles.value : [repoPath(repoRoot, absolutePath)]
  };
}

function listSourceGraphTargets(repoRoot: string, directoryPath: string): { ok: true; value: readonly string[] } | { ok: false; refusal: EditRefusal } {
  const targets: string[] = [];
  const pending = [directoryPath];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      return refused("unsafe_edit", `Move source cannot be inspected for graph facts: ${repoPath(repoRoot, current)}: ${errorMessage(error)}`, repoPath(repoRoot, current));
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      const entryRepoPath = repoPath(repoRoot, entryPath);
      let entryRealPath: string;
      try {
        entryRealPath = realpathSync(entryPath);
      } catch (error) {
        return refused("unsafe_edit", `Move source cannot be inspected for graph facts: ${entryRepoPath}: ${errorMessage(error)}`, entryRepoPath);
      }
      if (!isInside(repoRoot, entryRealPath)) {
        return refused("unsafe_edit", `Move source resolves outside repository through a symlink: ${entryRepoPath}`, entryRepoPath);
      }
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && isSupportedSymbolSourcePath(entryRepoPath)) targets.push(entryRepoPath);
    }
  }
  return { ok: true, value: targets.sort() };
}

function dirtyGraphEvidenceRefusal(
  scope: string,
  review: Pick<GraphReviewContextAvailableResult, "changedFiles" | "deletedFiles" | "renamedFiles">,
  changes: Pick<GraphDetectChangesAvailableResult, "changedFiles" | "deletedFiles" | "renamedFiles">
): { ok: false; refusal: EditRefusal } | undefined {
  const changedFiles = uniqueSorted([...review.changedFiles, ...changes.changedFiles]);
  const deletedFiles = uniqueSorted([...review.deletedFiles, ...changes.deletedFiles]);
  const renamedFiles = uniqueSorted([...review.renamedFiles, ...changes.renamedFiles].map((file) => `${file.fromPath}->${file.toPath}`));
  if (changedFiles.length + deletedFiles.length + renamedFiles.length === 0) return undefined;
  const details = [
    changedFiles.length > 0 ? `changed=${changedFiles.join(",")}` : undefined,
    deletedFiles.length > 0 ? `deleted=${deletedFiles.join(",")}` : undefined,
    renamedFiles.length > 0 ? `renamed=${renamedFiles.join(",")}` : undefined
  ].filter((entry): entry is string => entry !== undefined);
  return refused("conflict", `GraphProvider reported dirty ${scope} evidence before symbol planning: ${details.join("; ")}`, changedFiles[0] ?? deletedFiles[0]);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function repoPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function isInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function refused(category: EditRefusal["category"], message: string, path?: string): { ok: false; refusal: EditRefusal } {
  return {
    ok: false,
    refusal: {
      category,
      message,
      path
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
