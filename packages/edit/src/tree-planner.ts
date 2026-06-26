import type { EditRefusal, RepoIdentity, RepoRelativeChange } from "@the-open-engine/opcore-contracts";
import { calculateEditChecksum } from "./hash.js";
import { decodeTextContent, validateTextContentString } from "./content-policy.js";
import { validateCreatePatchTreePath, validateExistingPatchTreePath, normalizePatchTreeRepoRelativePath } from "./path-policy.js";
import { createEditPlanFromChanges, type EditPlannerResult } from "./planner.js";
import type { EditWorkspace } from "./workspace.js";
import { errorCode } from "./workspace.js";

export type ApplyTreeFileEntry =
  | {
      path: string;
      content: string;
      checksumBefore?: string;
    }
  | {
      path: string;
      delete: true;
      checksumBefore?: string;
    };

export interface ApplyTreePlanRequest {
  repo?: RepoIdentity;
  validation?: {
    required?: boolean;
  };
  fileContains?: string;
  files: readonly ApplyTreeFileEntry[];
}

interface ExistingTextFile {
  exists: true;
  content: string;
  checksum: string;
}

interface MissingTextFile {
  exists: false;
}

type CurrentTextFile = ExistingTextFile | MissingTextFile;

export async function createTreeEditPlan(workspace: EditWorkspace, request: ApplyTreePlanRequest): Promise<EditPlannerResult> {
  if (!Array.isArray(request.files) || request.files.length === 0) {
    return refusal("unsupported_change", "Tree edit request requires at least one file");
  }
  if (request.fileContains !== undefined && (typeof request.fileContains !== "string" || request.fileContains.length === 0)) {
    return refusal("unsupported_change", "fileContains must be non-empty when provided");
  }

  const entries = [];
  const seen = new Set<string>();
  for (const rawEntry of request.files) {
    if (!rawEntry || typeof rawEntry !== "object") return refusal("unsupported_change", "Tree file entries must be objects");
    const normalized = await normalizePatchTreeRepoRelativePath(workspace, rawEntry.path);
    if (!normalized.ok) return normalized;
    if (seen.has(normalized.value)) return refusal("conflict", `Duplicate tree file path: ${normalized.value}`, normalized.value);
    seen.add(normalized.value);
    entries.push({ path: normalized.value, entry: rawEntry });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const changes: RepoRelativeChange[] = [];
  for (const { path, entry } of entries) {
    const current = await readCurrentTextFile(workspace, path);
    if (!current.ok) return current;
    if (entry.checksumBefore !== undefined) {
      const checksum = current.value.exists ? current.value.checksum : undefined;
      if (entry.checksumBefore !== checksum) {
        return refusal(
          "conflict",
          `Stale checksumBefore for ${path}: expected ${entry.checksumBefore} but found ${checksum ?? "missing"}`,
          path
        );
      }
    }

    if ("delete" in entry && entry.delete === true) {
      if (!current.value.exists) continue;
      if (request.fileContains !== undefined && !current.value.content.includes(request.fileContains)) continue;
      changes.push({
        kind: "delete",
        path,
        checksumBefore: entry.checksumBefore ?? current.value.checksum
      });
      continue;
    }

    if (!("content" in entry) || typeof entry.content !== "string") {
      return refusal("unsupported_change", `Tree write entry requires string content: ${path}`, path);
    }
    if (request.fileContains !== undefined && !entry.content.includes(request.fileContains)) continue;
    const proposed = validateTextContentString(entry.content, path, "proposed tree content");
    if (!proposed.ok) return proposed;
    if (current.value.exists && current.value.content === proposed.value.content) continue;
    changes.push({
      kind: current.value.exists ? "replace" : "create",
      path,
      content: proposed.value.content,
      checksumBefore: current.value.exists ? entry.checksumBefore ?? current.value.checksum : entry.checksumBefore,
      checksumAfter: calculateEditChecksum(proposed.value.content)
    });
  }

  return createEditPlanFromChanges(request.repo, changes, request.validation);
}

async function readCurrentTextFile(
  workspace: EditWorkspace,
  path: string
): Promise<{ ok: true; value: CurrentTextFile } | { ok: false; refusal: EditRefusal }> {
  const absolutePath = workspace.resolveRepoPath(path);
  try {
    await workspace.fileSystem.stat(absolutePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return refusal("unsafe_edit", `Tree target cannot be inspected for ${path}: ${errorMessage(error)}`, path);
    }
    const createTarget = await validateCreatePatchTreePath(workspace, path);
    if (!createTarget.ok) return createTarget;
    return { ok: true, value: { exists: false } };
  }

  const target = await validateExistingPatchTreePath(workspace, path);
  if (!target.ok) return target;
  const decoded = decodeTextContent(await workspace.fileSystem.readFile(target.value.absolutePath), target.value.path, "existing tree target");
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    value: {
      exists: true,
      content: decoded.value.content,
      checksum: decoded.value.checksum
    }
  };
}

function refusal(category: EditRefusal["category"], message: string, path?: string): { ok: false; refusal: EditRefusal } {
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
