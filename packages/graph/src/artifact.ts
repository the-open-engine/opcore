import type {
  GraphProviderArtifactMetadata,
  GraphProviderErrorFailureCategory,
  GraphProviderStatus
} from "@the-open-engine/opcore-contracts";
import { validateGraphProviderArtifactMetadata } from "@the-open-engine/opcore-contracts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  graphCoreNativePackageNameForTarget,
  graphCoreSupportedTargets,
  isSupportedGraphCoreTarget,
  type GraphCoreSupportedTarget
} from "./native-targets.js";

declare const process: {
  arch: string;
  platform: string;
};

export interface ResolvedGraphCoreArtifact extends GraphProviderArtifactMetadata {
  executablePath: string;
  metadataPath: string;
}

export type GraphCoreArtifactResolution =
  | {
      ok: true;
      artifact: ResolvedGraphCoreArtifact;
    }
  | {
      ok: false;
      status: GraphProviderStatus;
    };

export type GraphCorePackageFileResolver = (specifier: string) => string;

export function resolveGraphCoreArtifact(): GraphCoreArtifactResolution {
  return resolveGraphCoreArtifactForTarget(`${process.platform}-${process.arch}`);
}

export function resolveGraphCoreArtifactForTarget(
  target: string,
  resolvePackageFile: GraphCorePackageFileResolver = createRequire(import.meta.url).resolve
): GraphCoreArtifactResolution {
  if (!isSupportedGraphCoreTarget(target)) {
    return {
      ok: false,
      status: providerFailureStatus(
        "required_missing",
        "provider_missing",
        unsupportedPlatformMessage(target),
        "required"
      )
    };
  }
  const packageName = graphCoreNativePackageNameForTarget(target);
  let metadataPath: string;
  try {
    metadataPath = resolvePackageFile(`${packageName}/metadata.json`);
  } catch (error) {
    return {
      ok: false,
      status: providerFailureStatus(
        "required_missing",
        "provider_missing",
        `Opcore graph-core native package ${packageName} is not installed for ${target}: ${errorMessage(error)}`,
        "required"
      )
    };
  }

  const packageRoot = dirname(metadataPath);
  let metadata: GraphProviderArtifactMetadata;
  try {
    metadata = validateGraphProviderArtifactMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));
    if (metadata.targetPlatform !== target) {
      return {
        ok: false,
        status: providerFailureStatus("error", "incompatible_provider", "graph-core artifact target mismatch", "required")
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: providerFailureStatus("error", "unknown", `graph-core artifact metadata invalid: ${errorMessage(error)}`, "required")
    };
  }

  if (!isSafePackageRelativePath(metadata.binaryPath) || !isSafePackageRelativePath(metadata.checksumPath)) {
    return {
      ok: false,
      status: providerFailureStatus("error", "incompatible_provider", "graph-core artifact metadata paths must stay package-relative", "required")
    };
  }

  const executablePath = join(packageRoot, metadata.binaryPath);
  const checksumPath = join(packageRoot, metadata.checksumPath);
  if (!existsSync(metadataPath) || !existsSync(executablePath) || !existsSync(checksumPath)) {
    return {
      ok: false,
      status: providerFailureStatus(
        "required_missing",
        "provider_missing",
        `Opcore graph-core artifact missing for ${target} in ${packageName}`,
        "required"
      )
    };
  }
  return resolveExistingGraphCoreArtifact(packageRoot, metadataPath, executablePath, checksumPath);
}

function resolveExistingGraphCoreArtifact(
  packageRoot: string,
  metadataPath: string,
  executablePath: string,
  checksumPath: string
): GraphCoreArtifactResolution {
  try {
    const metadata = validateGraphProviderArtifactMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));
    const checksum = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0] ?? "";
    const actual = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
    if (checksum.length === 0 || metadata.checksumSha256 !== checksum || actual !== checksum) {
      return {
        ok: false,
        status: providerFailureStatus("error", "unknown", "graph-core artifact checksum mismatch", "required")
      };
    }
    return {
      ok: true,
      artifact: {
        ...metadata,
        binaryPath: toPackageRelative(packageRoot, executablePath),
        checksumPath: toPackageRelative(packageRoot, checksumPath),
        checksumSha256: checksum,
        executablePath,
        metadataPath
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: providerFailureStatus("error", "unknown", `graph-core artifact resolution failed: ${errorMessage(error)}`, "required")
    };
  }
}

function unsupportedPlatformMessage(target: string): string {
  const supported = graphCoreSupportedTargets.join(", ");
  if (target.startsWith("win32-")) {
    return `Unsupported graph-core platform ${target}. Opcore 0.1.0-alpha.0 supports ${supported}; Windows is not supported in this alpha.`;
  }
  return `Unsupported graph-core platform ${target}. Opcore 0.1.0-alpha.0 supports ${supported}.`;
}

export function providerFailureStatus(
  state: "required_missing",
  category: "provider_missing",
  message: string,
  mode: "required"
): GraphProviderStatus;
export function providerFailureStatus(
  state: "daemon_unavailable",
  category: "daemon_unavailable",
  message: string,
  mode: "required"
): GraphProviderStatus;
export function providerFailureStatus(
  state: "error",
  category: GraphProviderErrorFailureCategory,
  message: string,
  mode: "required"
): GraphProviderStatus;
export function providerFailureStatus(
  state: "required_missing" | "daemon_unavailable" | "error",
  category: "provider_missing" | "daemon_unavailable" | GraphProviderErrorFailureCategory,
  message: string,
  mode: "required"
): GraphProviderStatus {
  if (state === "required_missing") {
    return {
      state,
      mode,
      provider: "lattice-graph",
      schemaVersion: 1,
      message,
      failure: {
        category: "provider_missing",
        message
      }
    };
  }
  if (state === "daemon_unavailable") {
    return {
      state,
      mode,
      provider: "lattice-graph",
      schemaVersion: 1,
      message,
      failure: {
        category: "daemon_unavailable",
        message,
        retryable: true
      }
    };
  }
  return {
    state: "error",
    mode,
    provider: "lattice-graph",
    schemaVersion: 1,
    message,
    failure: {
      category: category as GraphProviderErrorFailureCategory,
      message
    }
  };
}

export function schemaMismatchStatus(message: string, actualSchemaVersion = 0): GraphProviderStatus {
  return {
    state: "schema_mismatch",
    mode: "required",
    provider: "lattice-graph",
    schemaVersion: 1,
    expectedSchemaVersion: 1,
    actualSchemaVersion,
    message,
    failure: {
      category: "schema_mismatch",
      message
    }
  };
}

function toPackageRelative(packageRoot: string, path: string): string {
  return path.slice(packageRoot.length + 1).replaceAll("\\", "/");
}

function isSafePackageRelativePath(path: string): boolean {
  const normalized = normalize(path).replaceAll("\\", "/");
  return !isAbsolute(path) && normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
