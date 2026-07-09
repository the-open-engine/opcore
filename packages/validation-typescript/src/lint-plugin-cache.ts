import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const skippedDependencyDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  ".ace",
  ".agents",
  ".claude",
  ".codex",
  ".gemini",
  ".opcore"
]);

export function lintPluginCacheKey(repoRoot: string, pluginPath: string, dependencyGlobs: readonly string[]): string {
  const paths = uniqueSorted([pluginPath, ...dependencyPaths(repoRoot, dependencyGlobs)]);
  return paths.map((path) => `${path}:${fileMtime(path)}`).join("|");
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function dependencyPaths(repoRoot: string, dependencyGlobs: readonly string[]): readonly string[] {
  if (dependencyGlobs.length === 0) return [];
  const files = listRepoFiles(repoRoot);
  const matched = new Set<string>();
  for (const pattern of dependencyGlobs) {
    const normalizedPattern = normalizeGlobPattern(pattern);
    if (normalizedPattern === undefined) continue;
    const direct = resolve(repoRoot, normalizedPattern);
    if (!containsGlobWildcard(normalizedPattern) && existsSync(direct)) matched.add(direct);
    const matcher = globMatcher(normalizedPattern);
    for (const file of files) {
      if (matcher(file)) matched.add(resolve(repoRoot, file));
    }
  }
  return uniqueSorted([...matched]);
}

function listRepoFiles(repoRoot: string): readonly string[] {
  const results: string[] = [];
  const pending = [repoRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of safeReadDir(directory)) {
      if (skippedDependencyDirs.has(entry)) continue;
      const absolutePath = join(directory, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(absolutePath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) pending.push(absolutePath);
      else if (stat.isFile()) results.push(relative(repoRoot, absolutePath).replaceAll("\\", "/"));
    }
  }
  return results.sort();
}

function safeReadDir(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function normalizeGlobPattern(pattern: string): string | undefined {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (normalized.length === 0 || normalized.startsWith("../") || normalized.includes("/../")) return undefined;
  return normalized;
}

function containsGlobWildcard(pattern: string): boolean {
  return pattern.includes("*");
}

function globMatcher(pattern: string): (path: string) => boolean {
  const regex = new RegExp(`^${globPatternSource(pattern)}$`);
  return (path) => regex.test(path);
}

function globPatternSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      const after = pattern[index + 2];
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegex(char);
    }
  }
  return source;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
