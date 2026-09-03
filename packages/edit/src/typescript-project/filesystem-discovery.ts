import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isSafeExistingFileInsideRepo } from "./path-policy.js";

export function discoverRepoFiles(
  repoRoot: string,
  excludedDirectories: ReadonlySet<string>,
  include: (path: string, name: string) => boolean
): string[] {
  const files: string[] = [];
  visit(repoRoot);
  return files.sort();

  function visit(directory: string): void {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(path);
      } else if (
        entry.isFile() &&
        include(path, entry.name) &&
        isSafeExistingFileInsideRepo(repoRoot, path)
      ) {
        files.push(resolve(path));
      }
    }
  }
}
