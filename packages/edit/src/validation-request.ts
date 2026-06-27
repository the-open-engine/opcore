import type {
  EditPlan,
  HypotheticalOverlay,
  RepoIdentity,
  RepoRelativeChange,
  ValidationRequest
} from "@the-open-engine/opcore-contracts";
import {
  validateRepoIdentity,
  validateRepoRelativePath,
  validateValidationRequestPayload
} from "@the-open-engine/opcore-contracts";

export type EditPlanAfterState = Readonly<Record<string, string | null>>;

export function createValidationRequest(
  files: readonly string[],
  repo: string | RepoIdentity = "current-worktree",
  overlays: readonly HypotheticalOverlay[] = []
): ValidationRequest {
  const request: ValidationRequest = {
    repo: typeof repo === "string" ? { repoId: repo } : validateRepoIdentity(repo),
    scope: {
      kind: "files",
      files: uniqueSorted(files.map((file) => validateRepoRelativePath(file)))
    },
    graph: {
      mode: "required",
      provider: "opcore-graph"
    },
    overlays: overlays.map((overlay) => normalizeOverlay(overlay))
  };
  return validateValidationRequestPayload(request);
}

export function createValidationRequestFromPlan(plan: EditPlan, afterState: EditPlanAfterState): ValidationRequest {
  return createValidationRequestFromChanges(plan.repo, plan.changes, afterState, plan.validation.request);
}

export function createValidationRequestFromChanges(
  repo: RepoIdentity,
  changes: readonly RepoRelativeChange[],
  afterState: EditPlanAfterState,
  seedRequest?: ValidationRequest
): ValidationRequest {
  const overlays: HypotheticalOverlay[] = [];
  for (const change of changes) {
    if (change.kind === "create" || change.kind === "replace") {
      overlays.push({
        path: validateRepoRelativePath(change.path),
        action: "write",
        content: contentAfter(change.path, afterState, change.content),
        checksumBefore: change.checksumBefore
      });
    } else if (change.kind === "delete") {
      overlays.push({
        path: validateRepoRelativePath(change.path),
        action: "delete",
        checksumBefore: change.checksumBefore
      });
    } else if (change.kind === "rename") {
      overlays.push({
        path: validateRepoRelativePath(change.path),
        action: "delete",
        checksumBefore: change.checksumBefore
      });
      overlays.push({
        path: validateRepoRelativePath(change.toPath),
        action: "write",
        content: contentAfter(change.toPath, afterState),
        checksumBefore: undefined
      });
    }
  }
  const normalizedOverlays = overlays.map((overlay) => normalizeOverlay(overlay));
  const overlayPaths = normalizedOverlays.map((overlay) => overlay.path);
  const seedScope = seedRequest?.scope;
  const request: ValidationRequest = {
    repo: validateRepoIdentity(repo),
    scope: seedScope === undefined
      ? (overlayPaths.length === 0 ? { kind: "repo" } : { kind: "files", files: uniqueSorted(overlayPaths) })
      : seedScope.kind === "files"
        ? { kind: "files", files: uniqueSorted([...seedScope.files, ...overlayPaths].map((file) => validateRepoRelativePath(file))) }
        : seedScope,
    graph: seedRequest?.graph ?? {
      mode: "required",
      provider: "opcore-graph"
    },
    overlays: normalizedOverlays
  };
  if (seedRequest?.requestId !== undefined) request.requestId = seedRequest.requestId;
  if (seedRequest?.checks !== undefined) request.checks = seedRequest.checks;
  return validateValidationRequestPayload(request);
}

function normalizeOverlay(overlay: HypotheticalOverlay): HypotheticalOverlay {
  return {
    ...overlay,
    path: validateRepoRelativePath(overlay.path),
  } as HypotheticalOverlay;
}

function contentAfter(path: string, afterState: EditPlanAfterState, fallback?: string): string {
  const normalized = validateRepoRelativePath(path);
  const content = afterState[normalized] ?? fallback;
  if (typeof content !== "string") {
    throw new Error(`Planned after-state content is required for ${normalized}`);
  }
  return content;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
