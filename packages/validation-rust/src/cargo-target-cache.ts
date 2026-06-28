import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultTtlMs = 7 * 24 * 60 * 60 * 1000;
const defaultMaxBytes = 2 * 1024 * 1024 * 1024;
const defaultCleanupIntervalMs = 60 * 60 * 1000;
const cacheRootName = "opcore-validation-rust-target";
const touchFileName = ".opcore-cache-touch";

export interface CargoTargetDirOptions {
  baseDir?: string;
  cleanupIntervalMs?: number;
  maxBytes?: number;
  nowMs?: number;
  ttlMs?: number;
}

interface CargoTargetCacheEntry {
  path: string;
  lastUsedMs: number;
  sizeBytes: number;
}

const lastCleanupByBaseDir = new Map<string, number>();

export function cargoTargetCacheKeyForContext(context: ValidationCheckContext): string {
  return JSON.stringify({
    repo: context.request.repo.repoRoot ?? context.request.repo.repoId ?? "unknown",
    scope: {
      kind: context.scope.kind,
      packageName: context.scope.packageName,
      packageRoot: context.scope.packageRoot,
      baseRef: context.scope.baseRef,
      treeRef: context.scope.treeRef,
      changedFrom: context.scope.changedFrom
    },
    overlays: context.fileView.overlays.map((overlay) => ({
      path: overlay.path,
      action: overlay.action,
      checksum: overlay.checksum,
      checksumBefore: overlay.checksumBefore
    }))
  });
}

export function cargoTargetDirForKey(
  cacheKey: string,
  env: Record<string, string | undefined> = process.env,
  options: CargoTargetDirOptions = {}
): string {
  const baseDir = options.baseDir ?? join(tmpdir(), cacheRootName);
  const nowMs = options.nowMs ?? Date.now();
  cleanupCargoTargetCache(baseDir, nowMs, options);
  const targetDir = join(baseDir, cargoTargetDirDigest(cacheKey, env));
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, touchFileName), String(nowMs));
  return targetDir;
}

function cleanupCargoTargetCache(baseDir: string, nowMs: number, options: CargoTargetDirOptions): void {
  const intervalMs = options.cleanupIntervalMs ?? defaultCleanupIntervalMs;
  const previousCleanupMs = lastCleanupByBaseDir.get(baseDir);
  if (previousCleanupMs !== undefined && intervalMs > 0 && nowMs - previousCleanupMs < intervalMs) return;
  lastCleanupByBaseDir.set(baseDir, nowMs);
  if (!existsSync(baseDir)) return;
  try {
    removeExpiredEntries(baseDir, nowMs, options.ttlMs ?? defaultTtlMs);
    enforceSizeLimit(baseDir, options.maxBytes ?? defaultMaxBytes);
  } catch {
    // Cache cleanup is best-effort; validation must not fail because a stale target dir could not be inspected.
  }
}

function removeExpiredEntries(baseDir: string, nowMs: number, ttlMs: number): void {
  for (const entryName of readdirSync(baseDir)) {
    const entryPath = join(baseDir, entryName);
    if (!isDirectory(entryPath)) continue;
    if (nowMs - cacheEntryLastUsedMs(entryPath) > ttlMs) {
      rmSync(entryPath, { recursive: true, force: true });
    }
  }
}

function enforceSizeLimit(baseDir: string, maxBytes: number): void {
  const entries = [...cacheEntries(baseDir)].sort((left, right) => left.lastUsedMs - right.lastUsedMs);
  let totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  for (const entry of entries) {
    if (totalBytes <= maxBytes) return;
    rmSync(entry.path, { recursive: true, force: true });
    totalBytes -= entry.sizeBytes;
  }
}

function cacheEntries(baseDir: string): readonly CargoTargetCacheEntry[] {
  return readdirSync(baseDir).flatMap((entryName) => {
    const entryPath = join(baseDir, entryName);
    if (!isDirectory(entryPath)) return [];
    return [{
      path: entryPath,
      lastUsedMs: cacheEntryLastUsedMs(entryPath),
      sizeBytes: directorySizeBytes(entryPath)
    }];
  });
}

function directorySizeBytes(path: string): number {
  if (!isDirectory(path)) return safeStat(path)?.size ?? 0;
  return readdirSync(path).reduce((total, entryName) => total + directorySizeBytes(join(path, entryName)), 0);
}

function cacheEntryLastUsedMs(path: string): number {
  const touchPath = join(path, touchFileName);
  try {
    const value = Number(readFileSync(touchPath, "utf8"));
    if (Number.isFinite(value)) return value;
  } catch {
    // Fall back to the directory mtime when an older cache entry has no marker.
  }
  return safeStat(path)?.mtimeMs ?? 0;
}

function isDirectory(path: string): boolean {
  return safeStat(path)?.isDirectory() ?? false;
}

function safeStat(path: string): { isDirectory(): boolean; size: number; mtimeMs: number } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function cargoTargetDirDigest(cacheKey: string, env: Record<string, string | undefined>): string {
  return createHash("sha256")
    .update(
      [
        cacheKey,
        process.platform,
        process.arch,
        env.RUSTUP_TOOLCHAIN ?? "",
        env.CARGO_BUILD_TARGET ?? "",
        env.CARGO ?? "",
        env.RUSTC ?? "",
        env.RUSTFLAGS ?? "",
        env.CARGO_ENCODED_RUSTFLAGS ?? "",
        env.RUSTDOCFLAGS ?? "",
        env.PATH ?? ""
      ].join("\0"),
      "utf8"
    )
    .digest("hex");
}
