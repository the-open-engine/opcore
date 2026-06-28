import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { existsSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { parseJsonObject, runTool } from "./process.js";

export interface CargoMetadataPackageTarget {
  name: string;
  kind: readonly string[];
  srcPath: string;
  edition?: string;
}

export interface CargoMetadataPackage {
  name: string;
  manifestPath: string;
  root: string;
  edition?: string;
  targets: readonly CargoMetadataPackageTarget[];
}

export interface CargoWorkspaceMetadata {
  workspaceRoot: string;
  members: readonly CargoMetadataPackage[];
}

export type CargoMetadataResult =
  | {
      ok: true;
      metadata: CargoWorkspaceMetadata;
    }
  | {
      ok: false;
      status: "infrastructure_failure" | "policy_failure" | "unsupported_request";
      failureMessage: string;
      diagnostics: readonly ValidationDiagnostic[];
    };

export type CargoPackageScopeResolution =
  | {
      ok: true;
      member?: CargoMetadataPackage;
    }
  | {
      ok: false;
      status: "unsupported_request";
      failureMessage: string;
      diagnostics: readonly ValidationDiagnostic[];
    };

export interface CargoMetadataOptions {
  cargoTargetCacheKey?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function loadCargoMetadata(
  root: string,
  options: CargoMetadataOptions = {}
): CargoMetadataResult {
  if (!existsSync(join(root, "Cargo.toml"))) {
    return {
      ok: false,
      status: "unsupported_request",
      failureMessage: "Rust validation requires a Cargo.toml manifest",
      diagnostics: []
    };
  }
  const result = runTool("cargo", ["metadata", "--no-deps", "--format-version=1"], {
    cwd: root,
    cargoTargetCacheKey: options.cargoTargetCacheKey,
    env: options.env,
    timeoutMs: options.timeoutMs,
    allowedExitCodes: [0]
  });
  if (!result.ok) {
    if (result.failureMessage?.includes("failed to spawn") === true || result.timedOut) {
      return {
        ok: false,
        status: "infrastructure_failure",
        failureMessage: result.failureMessage ?? "cargo metadata failed",
        diagnostics: []
      };
    }
    return {
      ok: false,
      status: "policy_failure",
      failureMessage: result.failureMessage ?? "cargo metadata failed",
      diagnostics: [
        {
          category: "syntax",
          severity: "error",
          path: "Cargo.toml",
          code: "RUST_CARGO_METADATA",
          message: result.stderr.trim() || result.stdout.trim() || "cargo metadata failed"
        }
      ]
    };
  }
  const parsed = parseJsonObject(result.stdout, "cargo metadata");
  return {
    ok: true,
    metadata: parseCargoMetadata(realpathSync(root), parsed)
  };
}

export function resolveCargoPackageScope(
  metadata: CargoWorkspaceMetadata,
  scope: { kind: string; packageName?: string; packageRoot?: string }
): CargoPackageScopeResolution {
  if (scope.kind !== "package") return { ok: true };
  const packageName = scope.packageName;
  const packageRoot = scope.packageRoot === undefined ? undefined : normalizeMetadataPath(scope.packageRoot);
  const member = metadata.members.find(
    (entry) =>
      (packageName !== undefined && entry.name === packageName) ||
      (packageRoot !== undefined && normalizeMetadataPath(entry.root) === packageRoot)
  );
  if (member !== undefined) return { ok: true, member };
  return {
    ok: false,
    status: "unsupported_request",
    failureMessage: `Rust validation package scope is not a Cargo workspace member: ${packageName ?? packageRoot ?? "unknown"}`,
    diagnostics: []
  };
}

function parseCargoMetadata(root: string, value: unknown): CargoWorkspaceMetadata {
  if (!value || typeof value !== "object") throw new Error("cargo metadata JSON must be an object");
  const metadata = value as {
    packages?: unknown[];
    workspace_members?: unknown[];
    workspace_root?: unknown;
  };
  const workspaceMembers = new Set((metadata.workspace_members ?? []).filter((member): member is string => typeof member === "string"));
  const workspaceRoot = typeof metadata.workspace_root === "string" ? toRepoRelative(root, metadata.workspace_root) || "." : ".";
  const packages = (metadata.packages ?? [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .filter((entry) => typeof entry.id === "string" && workspaceMembers.has(entry.id))
    .map((entry): CargoMetadataPackage => {
      const manifestPath = requiredString(entry.manifest_path, "cargo metadata package manifest_path");
      const rootPath = dirnamePath(toRepoRelative(root, manifestPath));
      const targets = Array.isArray(entry.targets)
        ? entry.targets.filter((target): target is Record<string, unknown> => typeof target === "object" && target !== null).map((target) => ({
            name: requiredString(target.name, "cargo metadata target name"),
            kind: Array.isArray(target.kind) ? target.kind.filter((kind): kind is string => typeof kind === "string") : [],
            srcPath: toRepoRelative(root, requiredString(target.src_path, "cargo metadata target src_path")),
            edition: typeof target.edition === "string" ? target.edition : undefined
          }))
        : [];
      return {
        name: requiredString(entry.name, "cargo metadata package name"),
        manifestPath: toRepoRelative(root, manifestPath),
        root: rootPath,
        edition: typeof entry.edition === "string" ? entry.edition : undefined,
        targets
      };
    });
  return {
    workspaceRoot,
    members: packages.sort((left, right) => left.name.localeCompare(right.name))
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function toRepoRelative(root: string, absoluteOrRelativePath: string): string {
  const relativePath = absoluteOrRelativePath.startsWith("/") ? relative(root, absoluteOrRelativePath) : absoluteOrRelativePath;
  return relativePath.replaceAll("\\", "/");
}

function dirnamePath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function normalizeMetadataPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.length === 0 ? "." : normalized;
}
