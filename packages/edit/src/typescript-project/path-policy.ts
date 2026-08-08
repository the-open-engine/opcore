import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function isPathInside(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(resolve(parentPath), resolve(childPath));
  return (
    childRelativePath === "" ||
    (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath))
  );
}

export function isSafeExistingFileInsideRepo(
  repoRoot: string,
  absolutePath: string
): boolean {
  if (!isPathInside(repoRoot, absolutePath) || !existsSync(absolutePath)) {
    return false;
  }
  try {
    return (
      isPathInside(repoRoot, realpathSync(absolutePath)) &&
      statSync(absolutePath).isFile()
    );
  } catch {
    return false;
  }
}

export function isSafeExistingDirectoryInsideRepo(
  repoRoot: string,
  absolutePath: string
): boolean {
  if (!isPathInside(repoRoot, absolutePath) || !existsSync(absolutePath)) {
    return false;
  }
  try {
    return (
      isPathInside(repoRoot, realpathSync(absolutePath)) &&
      statSync(absolutePath).isDirectory()
    );
  } catch {
    return false;
  }
}

export function normalizeModulePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function sourceExtension(path: string): string | undefined {
  if (path.endsWith(".d.ts")) return ".d.ts";
  return /\.[^./]+$/u.exec(path)?.[0];
}

export function replaceImportExtension(
  path: string,
  extension: string
): string {
  if (path.endsWith(".d.ts")) {
    return `${path.slice(0, -".d.ts".length)}${extension}`;
  }
  return path.replace(/\.[^./]+$/u, extension);
}

export function uniqueValues<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

export function uniqueSortedValues(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
