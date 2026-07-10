import { createHash } from "node:crypto";
import type { HypotheticalOverlay, ValidationRequest } from "@the-open-engine/opcore-contracts";
import { validateRepoRelativePath, validateValidationRequestPayload } from "@the-open-engine/opcore-contracts";
import type {
  ResolvedValidationScope,
  ValidationWorkspace,
  ValidationWorkspaceFile,
  ValidationWorkspaceFileSet,
  ValidationWorkspaceReadFileResult
} from "./scope.js";

export type ValidationFileReadState = "before" | "after";
export type ValidationFileReadStatus = "found" | "missing" | "deleted";
export type ValidationFileReadSource = "workspace" | "overlay";

export interface ValidationOverlayEntry {
  path: string;
  action: HypotheticalOverlay["action"];
  content?: string;
  checksumBefore?: string;
  checksum?: string;
}

export interface ValidationFileSourceMetadata {
  source: ValidationFileReadSource;
  path: string;
  overlay?: {
    action: HypotheticalOverlay["action"];
    checksumBefore?: string;
  };
}

export interface ValidationFileFoundReadResult {
  path: string;
  state: ValidationFileReadState;
  status: "found";
  source: ValidationFileReadSource;
  sourceMetadata: ValidationFileSourceMetadata;
  content: string;
  checksum: string;
  overlay?: ValidationOverlayEntry;
}

export interface ValidationFileMissingReadResult {
  path: string;
  state: ValidationFileReadState;
  status: "missing";
  source: "workspace";
  sourceMetadata: ValidationFileSourceMetadata;
}

export interface ValidationFileDeletedReadResult {
  path: string;
  state: "after";
  status: "deleted";
  source: "overlay";
  sourceMetadata: ValidationFileSourceMetadata;
  overlay: ValidationOverlayEntry;
}

export type ValidationFileReadResult =
  | ValidationFileFoundReadResult
  | ValidationFileMissingReadResult
  | ValidationFileDeletedReadResult;

export interface ValidationFileReadOptions {
  state?: ValidationFileReadState;
}

export interface ValidationFileExistsOptions {
  state?: ValidationFileReadState;
}

export interface CreateValidationFileViewArgs {
  request: ValidationRequest;
  scope: ResolvedValidationScope;
  workspace: ValidationWorkspace;
  defaultReadState?: ValidationFileReadState;
}

export interface ValidationFileView {
  readonly overlays: readonly ValidationOverlayEntry[];
  readonly scopeFiles: readonly string[];
  readonly defaultReadState: ValidationFileReadState;
  listVisibleFiles: () => Promise<readonly string[]>;
  readFile: (path: string, options?: ValidationFileReadOptions) => Promise<ValidationFileReadResult>;
  readBefore: (path: string) => Promise<ValidationFileReadResult>;
  readAfter: (path: string) => Promise<ValidationFileReadResult>;
  exists: (path: string, options?: ValidationFileExistsOptions) => Promise<boolean>;
  hasOverlay: (path: string) => boolean;
  overlayFor: (path: string) => ValidationOverlayEntry | undefined;
}

export class ValidationOverlayConflictError extends Error {
  readonly path: string;
  readonly expected: string;
  readonly actual?: string;

  constructor(path: string, expected: string, actual?: string) {
    super(
      actual === undefined
        ? `Validation overlay checksumBefore conflict for ${path}: expected ${expected} but file is missing`
        : `Validation overlay checksumBefore conflict for ${path}: expected ${expected} but found ${actual}`
    );
    this.name = "ValidationOverlayConflictError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

export function calculateValidationFileChecksum(content: string): string {
  if (typeof content !== "string") {
    throw new Error("Validation file checksum content must be a string");
  }
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function normalizeValidationFileViewPath(path: string): string {
  return validateRepoRelativePath(path);
}

export function findValidationOverlayEntry(
  overlays: readonly ValidationOverlayEntry[],
  path: string
): ValidationOverlayEntry | undefined {
  const normalizedPath = normalizeValidationFileViewPath(path);
  return overlays.find((overlay) => overlay.path === normalizedPath);
}

export async function createValidationFileView(args: CreateValidationFileViewArgs): Promise<ValidationFileView> {
  const request = validateValidationRequestPayload(args.request);
  validateWorkspaceReader(args.workspace);
  const overlays = normalizeValidationOverlayEntries(request.overlays);
  const overlayByPath = new Map(overlays.map((overlay) => [overlay.path, overlay]));
  const scopeFiles = uniqueSorted(args.scope.files.map(normalizeValidationFileViewPath));
  const defaultReadState = args.defaultReadState ?? "after";
  let visibleFilesPromise: Promise<readonly string[]> | undefined;
  const listVisibleFiles = (): Promise<readonly string[]> => {
    visibleFilesPromise ??= resolveVisibleFiles(args.workspace, args.scope, defaultReadState, scopeFiles, overlays);
    return visibleFilesPromise;
  };
  const readBefore = (path: string): Promise<ValidationFileReadResult> =>
    readWorkspacePath(args.workspace, args.scope, normalizeValidationFileViewPath(path), "before");
  const readAfter = async (path: string): Promise<ValidationFileReadResult> => {
    const normalizedPath = normalizeValidationFileViewPath(path);
    if (defaultReadState === "before") return readWorkspacePath(args.workspace, args.scope, normalizedPath, "before");
    const overlay = overlayByPath.get(normalizedPath);
    if (overlay?.action === "write") return overlayWriteResult(overlay);
    if (overlay?.action === "delete") return overlayDeleteResult(overlay);
    return readWorkspacePath(args.workspace, args.scope, normalizedPath, "after");
  };

  for (const overlay of overlays) {
    if (overlay.checksumBefore === undefined) continue;
    const before = await readBefore(overlay.path);
    const actual = before.status === "found" ? before.checksum : undefined;
    if (actual !== overlay.checksumBefore) {
      throw new ValidationOverlayConflictError(overlay.path, overlay.checksumBefore, actual);
    }
  }

  return {
    overlays,
    scopeFiles,
    defaultReadState,
    listVisibleFiles,
    readFile: (path, options = {}) =>
      options.state === "before" || (options.state === undefined && defaultReadState === "before") ? readBefore(path) : readAfter(path),
    readBefore,
    readAfter,
    exists: async (path, options = {}) =>
      (await (options.state === "before" || (options.state === undefined && defaultReadState === "before") ? readBefore(path) : readAfter(path)))
        .status === "found",
    hasOverlay: (path) => overlayByPath.has(normalizeValidationFileViewPath(path)),
    overlayFor: (path) => overlayByPath.get(normalizeValidationFileViewPath(path))
  };
}

function normalizeValidationOverlayEntries(overlays: readonly HypotheticalOverlay[]): readonly ValidationOverlayEntry[] {
  return [...overlays].map(normalizeValidationOverlayEntry).sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeValidationOverlayEntry(overlay: HypotheticalOverlay): ValidationOverlayEntry {
  const path = normalizeValidationFileViewPath(overlay.path);
  if (overlay.action === "write") {
    return {
      path,
      action: "write",
      content: overlay.content,
      checksumBefore: overlay.checksumBefore,
      checksum: calculateValidationFileChecksum(overlay.content)
    };
  }
  return {
    path,
    action: "delete",
    checksumBefore: overlay.checksumBefore
  };
}

async function readWorkspacePath(
  workspace: ValidationWorkspace,
  scope: ResolvedValidationScope,
  path: string,
  state: ValidationFileReadState
): Promise<ValidationFileReadResult> {
  const result = await workspace.readFile(path, { scope, state });
  const normalized = normalizeWorkspaceReadFileResult(path, result);
  if (normalized.status === "missing") {
    return {
      path,
      state,
      status: "missing",
      source: "workspace",
      sourceMetadata: workspaceSourceMetadata(path)
    };
  }
  return {
    path,
    state,
    status: "found",
    source: "workspace",
    sourceMetadata: workspaceSourceMetadata(path),
    content: normalized.content,
    checksum: calculateValidationFileChecksum(normalized.content)
  };
}

function normalizeWorkspaceReadFileResult(path: string, result: ValidationWorkspaceReadFileResult): ValidationWorkspaceReadFileResult {
  if (!result || typeof result !== "object") {
    throw new Error(`Validation workspace readFile returned an invalid result for ${path}`);
  }
  if (result.status === "missing") return result;
  if (result.status === "found" && typeof result.content === "string") return result;
  throw new Error(`Validation workspace readFile returned an invalid result for ${path}`);
}

function overlayWriteResult(overlay: ValidationOverlayEntry): ValidationFileFoundReadResult {
  if (overlay.action !== "write" || overlay.content === undefined || overlay.checksum === undefined) {
    throw new Error(`Validation write overlay is invalid for ${overlay.path}`);
  }
  return {
    path: overlay.path,
    state: "after",
    status: "found",
    source: "overlay",
    sourceMetadata: overlaySourceMetadata(overlay),
    content: overlay.content,
    checksum: overlay.checksum,
    overlay
  };
}

function overlayDeleteResult(overlay: ValidationOverlayEntry): ValidationFileDeletedReadResult {
  if (overlay.action !== "delete") {
    throw new Error(`Validation delete overlay is invalid for ${overlay.path}`);
  }
  return {
    path: overlay.path,
    state: "after",
    status: "deleted",
    source: "overlay",
    sourceMetadata: overlaySourceMetadata(overlay),
    overlay
  };
}

function workspaceSourceMetadata(path: string): ValidationFileSourceMetadata {
  return {
    source: "workspace",
    path
  };
}

function overlaySourceMetadata(overlay: ValidationOverlayEntry): ValidationFileSourceMetadata {
  const metadata: ValidationFileSourceMetadata = {
    source: "overlay",
    path: overlay.path,
    overlay: {
      action: overlay.action
    }
  };
  if (overlay.checksumBefore !== undefined && metadata.overlay !== undefined) {
    metadata.overlay.checksumBefore = overlay.checksumBefore;
  }
  return metadata;
}

function validateWorkspaceReader(workspace: ValidationWorkspace): void {
  if (!workspace || typeof workspace.readFile !== "function") {
    throw new Error("Validation workspace readFile is required");
  }
}

async function resolveVisibleFiles(
  workspace: ValidationWorkspace,
  scope: ResolvedValidationScope,
  state: ValidationFileReadState,
  scopeFiles: readonly string[],
  overlays: readonly ValidationOverlayEntry[]
): Promise<readonly string[]> {
  const overlayFiles = overlays.map((overlay) => overlay.path);
  if (workspace.listFiles === undefined) return uniqueSorted([...scopeFiles, ...overlayFiles]);
  const fileSet = await workspace.listFiles({ scope, state });
  if (fileSet.unavailable) return uniqueSorted([...scopeFiles, ...overlayFiles]);
  return uniqueSorted([...fileSetPaths(fileSet), ...scopeFiles, ...overlayFiles]);
}

function fileSetPaths(fileSet: ValidationWorkspaceFileSet): readonly string[] {
  return fileSet.files.map((file) => normalizeValidationFileViewPath(workspaceFilePath(file)));
}

function workspaceFilePath(file: string | ValidationWorkspaceFile): string {
  return typeof file === "string" ? file : file.toPath ?? file.path;
}

function uniqueSorted(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort();
}
