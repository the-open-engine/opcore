import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolveRepoPath(root: string, path: string): string {
  if (path.length === 0 || path.includes("\0")) {
    throw new Error(`Invalid repo path: ${path}`);
  }
  const absolute = resolve(root, path);
  const normalized = relative(root, absolute);
  if (
    normalized === "" ||
    normalized.startsWith("..") ||
    normalized.split(sep).includes("..")
  ) {
    throw new Error(`Repo-relative path escapes repository: ${path}`);
  }
  return absolute;
}

export function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
