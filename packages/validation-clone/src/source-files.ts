import type { ValidationCheckContext, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { normalizeValidationFileViewPath } from "@the-open-engine/opcore-validation";

export const cloneSourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".pyi", ".rs"] as const;

export function isCloneSourcePath(path: string): boolean {
  return cloneSourceExtensions.some((extension) => path.endsWith(extension));
}

export function cloneInputPaths(context: ValidationCheckContext): readonly string[] {
  return uniqueSorted(
    [...context.fileView.scopeFiles, ...context.fileView.overlays.map((overlay) => overlay.path)]
      .map((path) => normalizeValidationFileViewPath(path))
      .filter(isCloneSourcePath)
  );
}

export async function cloneOverlayPaths(context: ValidationCheckContext, paths: readonly string[]): Promise<readonly string[]> {
  const visibleFiles = await context.fileView.listVisibleFiles();
  return uniqueSorted(
    [...visibleFiles, ...paths]
      .map((path) => normalizeValidationFileViewPath(path))
      .filter(isCloneSourcePath)
  );
}

export function skippedCloneInputResult(context: ValidationCheckContext): ValidationCheckResult | undefined {
  if (cloneInputPaths(context).length > 0) return undefined;
  return {
    status: "skipped",
    diagnostics: [],
    failureMessage: "No clone-owned source files were selected."
  };
}

function uniqueSorted(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort();
}
