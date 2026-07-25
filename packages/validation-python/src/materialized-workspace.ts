import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { validateRepoRelativePath } from "@the-open-engine/opcore-contracts";

export function resolveMaterializedWorkspacePath(root: string, path: string, label: string): string {
  const normalized = validateRepoRelativePath(path);
  const absolutePath = resolve(root, normalized);
  const relativePath = relative(root, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.split(sep).includes("..")) {
    throw new Error(`Repo-relative path escapes ${label}: ${path}`);
  }
  return absolutePath;
}

export async function writeMaterializedWorkspaceFile(
  root: string,
  path: string,
  content: string,
  label: string,
  mode?: number
): Promise<void> {
  const absolutePath = resolveMaterializedWorkspacePath(root, path, label);
  await mkdir(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  if (mode !== undefined) chmodSync(absolutePath, mode & 0o7777);
}

export function removeMaterializedWorkspace(root: string, label: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      if (!existsSync(root)) return;
      lastError = new Error(`${label} cleanup left residual files.`);
    } catch (error) {
      lastError = error;
    }
    sleep(25);
  }
  throw sanitizeWorkspaceCleanupError(lastError, label);
}

function sanitizeWorkspaceCleanupError(error: unknown, label: string): Error {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  const suffix = error instanceof Error && error.message.includes("residual files")
    ? "Residual files remained after cleanup retries."
    : (code === undefined ? "Cleanup failed." : `Cleanup failed (${code}).`);
  return new Error(`${label} ${suffix}`);
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
