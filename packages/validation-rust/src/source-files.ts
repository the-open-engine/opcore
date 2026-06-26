import type { ValidationCheckContext, ValidationCheckResult } from "@the-open-engine/lattice-validation";
import { normalizeValidationFileViewPath } from "@the-open-engine/lattice-validation";

export interface RustMaterializedSourceFile {
  path: string;
  content: string;
}

export interface RustInputSet {
  paths: readonly string[];
  ownedPaths: readonly string[];
  cargoLockOnly: boolean;
}

export function isRustSourcePath(path: string): boolean {
  return path.endsWith(".rs");
}

export function isRustIncludeSourcePath(path: string): boolean {
  return path.endsWith(".inc");
}

export function isCargoManifestPath(path: string): boolean {
  return path === "Cargo.toml" || path.endsWith("/Cargo.toml");
}

export function isCargoLockPath(path: string): boolean {
  return path === "Cargo.lock" || path.endsWith("/Cargo.lock");
}

export function isRustAdapterOwnedPath(path: string): boolean {
  const normalized = normalizeValidationFileViewPath(path);
  return isRustSourcePath(normalized) || isRustIncludeSourcePath(normalized) || isCargoManifestPath(normalized);
}

export function rustInputSet(context: ValidationCheckContext): RustInputSet {
  const paths = uniqueSorted([
    ...context.fileView.scopeFiles,
    ...context.fileView.overlays.map((overlay) => overlay.path)
  ].map((path) => normalizeValidationFileViewPath(path)));
  const ownedPaths = paths.filter(isRustAdapterOwnedPath);
  return {
    paths,
    ownedPaths,
    cargoLockOnly: ownedPaths.length === 0 && paths.length > 0 && paths.every(isCargoLockPath)
  };
}

export async function readRustAfterSources(context: ValidationCheckContext): Promise<readonly RustMaterializedSourceFile[]> {
  const files: RustMaterializedSourceFile[] = [];
  for (const path of rustInputSet(context).ownedPaths) {
    if (!isRustSourcePath(path) && !isRustIncludeSourcePath(path)) continue;
    const result = await context.fileView.readAfter(path);
    if (result.status !== "found") continue;
    files.push({ path, content: result.content });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function skippedRustInputResult(context: ValidationCheckContext): ValidationCheckResult | undefined {
  const input = rustInputSet(context);
  if (input.ownedPaths.length > 0) return undefined;
  return {
    status: "skipped",
    diagnostics: [],
    failureMessage: input.cargoLockOnly
      ? "Cargo.lock-only changes are retained compatibility outside native Rust adapter ownership."
      : "No Rust-owned files were selected."
  };
}

export function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
