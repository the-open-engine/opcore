import type {
  HypotheticalOverlay,
  ValidationFailureCategory,
  ValidationRequest,
  ValidationScope,
  ValidationScopeKind
} from "@the-open-engine/opcore-contracts";
import { validateRepoRelativePath, validateValidationRequestPayload } from "@the-open-engine/opcore-contracts";

export type ValidationWorkspaceFileStatus = "added" | "modified" | "deleted" | "renamed" | "unchanged";

export interface ValidationWorkspaceFile {
  path: string;
  status?: ValidationWorkspaceFileStatus;
  fromPath?: string;
  toPath?: string;
}

export interface ValidationWorkspaceFileSet {
  files: readonly (string | ValidationWorkspaceFile)[];
  unavailable?: boolean;
  truncated?: boolean;
  message?: string;
  cause?: string;
}

export type ValidationWorkspaceReadFileResult =
  | {
      status: "found";
      content: string;
    }
  | {
      status: "missing";
    };

export interface ValidationWorkspaceReadContext {
  scope: ResolvedValidationScope;
  state?: "before" | "after";
}

export interface ValidationWorkspaceListFilesContext {
  scope: ResolvedValidationScope;
  state?: "before" | "after";
}

export interface ValidationWorkspace {
  readFile: (path: string, context?: ValidationWorkspaceReadContext) => ValidationWorkspaceReadFileResult | Promise<ValidationWorkspaceReadFileResult>;
  listFiles?: (context: ValidationWorkspaceListFilesContext) => ValidationWorkspaceFileSet | Promise<ValidationWorkspaceFileSet>;
  listChangedFiles?: (baseRef: string) => ValidationWorkspaceFileSet | Promise<ValidationWorkspaceFileSet>;
  listTreeFiles?: (treeRef: string, changedFrom: string) => ValidationWorkspaceFileSet | Promise<ValidationWorkspaceFileSet>;
  listStagedFiles?: () => ValidationWorkspaceFileSet | Promise<ValidationWorkspaceFileSet>;
  listRepoFiles?: () => ValidationWorkspaceFileSet | Promise<ValidationWorkspaceFileSet>;
  listPackageFiles?: (packageName: string, packageRoot: string) => ValidationWorkspaceFileSet | Promise<ValidationWorkspaceFileSet>;
  resolvePackageRoot?: (packageName: string) => string | undefined | Promise<string | undefined>;
}

export interface ResolvedValidationScope {
  kind: ValidationScopeKind;
  files: readonly string[];
  workspaceFiles: readonly ValidationWorkspaceFile[];
  packageName?: string;
  packageRoot?: string;
  baseRef?: string;
  treeRef?: string;
  changedFrom?: string;
}

export class ValidationScopeResolutionError extends Error {
  readonly category: ValidationFailureCategory;
  readonly causeMessage?: string;

  constructor(message: string, category: ValidationFailureCategory = "unsupported_request", cause?: string) {
    super(message);
    this.name = "ValidationScopeResolutionError";
    this.category = category;
    this.causeMessage = cause;
  }
}

export async function resolveValidationScope(
  request: ValidationRequest,
  workspace: ValidationWorkspace
): Promise<ResolvedValidationScope> {
  const validated = validateValidationRequestPayload(request);
  const overlayFiles = validated.overlays.map((overlay) => normalizeOverlayPath(overlay));
  const scope = validated.scope;

  if (scope.kind === "files") {
    return resolved(scope.kind, [...scope.files, ...overlayFiles].map((path) => fileFromPath(path)));
  }
  if (scope.kind === "changed") {
    const files = await requireWorkspaceFileSet(workspace.listChangedFiles, [scope.baseRef], "Changed validation scope is unavailable");
    return {
      ...resolved(scope.kind, [...files.files, ...overlayFiles.map((path) => fileFromPath(path))]),
      baseRef: scope.baseRef
    };
  }
  if (scope.kind === "tree") {
    const files = await requireWorkspaceFileSet(
      workspace.listTreeFiles,
      [scope.treeRef, scope.changedFrom],
      "Tree validation scope is unavailable"
    );
    return {
      ...resolved(scope.kind, [...files.files, ...overlayFiles.map((path) => fileFromPath(path))]),
      treeRef: scope.treeRef,
      changedFrom: scope.changedFrom
    };
  }
  if (scope.kind === "staged") {
    const files = await requireWorkspaceFileSet(workspace.listStagedFiles, [], "Staged validation scope is unavailable");
    return resolved(scope.kind, [...files.files, ...overlayFiles.map((path) => fileFromPath(path))]);
  }
  if (scope.kind === "all" || scope.kind === "repo") {
    const files = await requireWorkspaceFileSet(workspace.listRepoFiles, [], "Repository validation scope is unavailable");
    return resolved(scope.kind, [...files.files, ...overlayFiles.map((path) => fileFromPath(path))]);
  }

  const packageRoot = normalizePath(scope.packageRoot);
  await validateWorkspacePackageRoot(workspace, scope, packageRoot);
  const packageFiles =
    workspace.listPackageFiles !== undefined
      ? await requireWorkspaceFileSet(workspace.listPackageFiles, [scope.packageName, packageRoot], "Package validation scope is unavailable")
      : filterPackageFileSet(
          await requireWorkspaceFileSet(workspace.listRepoFiles, [], "Package validation scope is unavailable"),
          packageRoot
        );
  const normalized = resolved(scope.kind, [...packageFiles.files, ...overlayFiles.map((path) => fileFromPath(path))], {
    packageName: scope.packageName,
    packageRoot
  });
  for (const file of normalized.files) {
    if (!isInsidePackageRoot(file, packageRoot)) {
      throw new ValidationScopeResolutionError(`Validation package scope file is outside package root: ${file}`);
    }
  }
  return normalized;
}

function resolved(
  kind: ValidationScopeKind,
  files: readonly (string | ValidationWorkspaceFile)[],
  extras: Pick<ResolvedValidationScope, "packageName" | "packageRoot"> = {}
): ResolvedValidationScope {
  const workspaceFiles = files.map(normalizeWorkspaceFile);
  const byPath = new Map<string, ValidationWorkspaceFile>();
  for (const file of workspaceFiles) byPath.set(file.path, file);
  return {
    kind,
    files: [...byPath.keys()].sort(),
    workspaceFiles: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    ...extras
  };
}

async function requireWorkspaceFileSet<Args extends readonly unknown[]>(
  loader: ((...args: Args) => ValidationWorkspaceFileSet | Promise<ValidationWorkspaceFileSet>) | undefined,
  args: Args,
  fallbackMessage: string
): Promise<ValidationWorkspaceFileSet> {
  if (loader === undefined) {
    throw new ValidationScopeResolutionError(fallbackMessage, "infrastructure_failure");
  }
  const fileSet = await loader(...args);
  if (!fileSet || typeof fileSet !== "object" || !Array.isArray(fileSet.files)) {
    throw new ValidationScopeResolutionError(`${fallbackMessage}: workspace returned an invalid file set`, "infrastructure_failure");
  }
  if (fileSet.unavailable) {
    throw new ValidationScopeResolutionError(fileSet.message ?? fallbackMessage, "infrastructure_failure", fileSet.cause);
  }
  return fileSet;
}

async function validateWorkspacePackageRoot(
  workspace: ValidationWorkspace,
  scope: Extract<ValidationScope, { kind: "package" }>,
  packageRoot: string
): Promise<void> {
  if (workspace.resolvePackageRoot === undefined) return;
  const resolvedRoot = await workspace.resolvePackageRoot(scope.packageName);
  if (resolvedRoot === undefined) return;
  const normalizedRoot = normalizePath(resolvedRoot);
  if (normalizedRoot !== packageRoot) {
    throw new ValidationScopeResolutionError(
      `Validation package scope packageRoot does not match workspace package root: ${scope.packageName}`
    );
  }
}

function filterPackageFileSet(fileSet: ValidationWorkspaceFileSet, packageRoot: string): ValidationWorkspaceFileSet {
  return {
    ...fileSet,
    files: fileSet.files.filter((file) => isInsidePackageRoot(typeof file === "string" ? normalizePath(file) : normalizePath(file.path), packageRoot))
  };
}

function normalizeWorkspaceFile(file: string | ValidationWorkspaceFile): ValidationWorkspaceFile {
  if (typeof file === "string") return fileFromPath(file);
  const normalized: ValidationWorkspaceFile = {
    ...file,
    path: normalizePath(file.toPath ?? file.path)
  };
  if (file.fromPath !== undefined) normalized.fromPath = normalizePath(file.fromPath);
  if (file.toPath !== undefined) normalized.toPath = normalizePath(file.toPath);
  return normalized;
}

function fileFromPath(path: string): ValidationWorkspaceFile {
  return {
    path: normalizePath(path)
  };
}

function normalizeOverlayPath(overlay: HypotheticalOverlay): string {
  return normalizePath(overlay.path);
}

function normalizePath(path: string): string {
  try {
    return validateRepoRelativePath(path);
  } catch (error) {
    throw new ValidationScopeResolutionError(error instanceof Error ? error.message : String(error));
  }
}

function isInsidePackageRoot(path: string, packageRoot: string): boolean {
  return path === packageRoot || path.startsWith(`${packageRoot}/`);
}
