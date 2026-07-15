import { createHash } from "node:crypto";

export function pythonProjectDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

export function normalizePythonProjectFingerprintInput(
  value: unknown,
  repoRoot: string,
  platform: string
): unknown {
  const normalizedRoot = normalizeRoot(repoRoot, platform);
  return normalizeFingerprintValue(value, normalizedRoot, platform);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  );
}

function normalizeFingerprintValue(value: unknown, repoRoot: string, platform: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFingerprintValue(entry, repoRoot, platform));
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? replaceRepoRoot(value, repoRoot, platform) : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, normalizeFingerprintValue(entry, repoRoot, platform)])
  );
}

function normalizeRoot(repoRoot: string, platform: string): string {
  const normalized = normalizeSeparators(repoRoot, platform);
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

function replaceRepoRoot(value: string, repoRoot: string, platform: string): string {
  const normalized = normalizeSeparators(value, platform);
  if (repoRoot.length === 0) return normalized;
  if (repoRoot === "/") {
    return normalized.startsWith("/") ? `$REPO${normalized}` : normalized;
  }
  const comparableValue = platform === "win32" ? normalized.toLowerCase() : normalized;
  const comparableRoot = platform === "win32" ? repoRoot.toLowerCase() : repoRoot;
  let cursor = 0;
  let result = "";
  while (cursor < normalized.length) {
    const index = comparableValue.indexOf(comparableRoot, cursor);
    if (index < 0) return result + normalized.slice(cursor);
    const preceding = index === 0 ? undefined : normalized[index - 1];
    const following = normalized[index + repoRoot.length];
    const startsPath = preceding === undefined || /[\s=,:;"'(\[]/u.test(preceding);
    const endsRoot = following === undefined || following === "/";
    if (!startsPath || !endsRoot) {
      result += normalized.slice(cursor, index + repoRoot.length);
      cursor = index + repoRoot.length;
      continue;
    }
    result += `${normalized.slice(cursor, index)}$REPO`;
    cursor = index + repoRoot.length;
  }
  return result;
}

function normalizeSeparators(value: string, platform: string): string {
  return platform === "win32" ? value.replaceAll("\\", "/") : value;
}
