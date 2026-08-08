import { readFileSync, readdirSync, rmSync } from "node:fs";
import {
  assertExistingRepoPath,
  lstatIfExists,
  repoPathExists,
  resolveRepoPath
} from "./init-paths.js";
import { isPlainObject } from "./init-data.js";

export function readJsonObject(root: string, path: string): Record<string, unknown> {
  const content = readOptionalRepoFile(root, path);
  if (content === undefined) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!isPlainObject(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

export function readJsonObjectIfExists(root: string, path: string): Record<string, unknown> {
  return repoPathExists(root, path) ? readJsonObject(root, path) : {};
}

export function readOptionalRepoFile(root: string, path: string): string | undefined {
  if (!repoPathExists(root, path)) return undefined;
  return readFileSync(assertExistingRepoPath(root, path, "Existing repo file", "file"), "utf8");
}

export function removeEmptyOpcoreHookDir(root: string): void {
  const hooksDir = resolveRepoPath(root, ".opcore/hooks");
  if (!lstatIfExists(hooksDir)) return;
  assertExistingRepoPath(root, ".opcore/hooks", "Opcore hooks directory", "directory");
  if (readdirSync(hooksDir).length === 0) rmSync(hooksDir, { recursive: true, force: true });
}
