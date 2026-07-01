import type { OpcoreRuntimeInfoPayload } from "@the-open-engine/opcore-contracts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = dirname(packageJsonPath);
const entrypointPath = fileURLToPath(new URL("./index.js", import.meta.url));

let cachedRuntimeInfo: OpcoreRuntimeInfoPayload | undefined;

export function readOpcoreRuntimeInfo(): OpcoreRuntimeInfoPayload {
  if (cachedRuntimeInfo !== undefined) return cachedRuntimeInfo;
  const version = readPackageVersion();
  cachedRuntimeInfo = {
    schemaVersion: 1,
    packageName: "@the-open-engine/opcore",
    version,
    bin: "opcore",
    artifactSource: classifyArtifactSource(),
    packageRoot,
    entrypoint: entrypointPath
  };
  return cachedRuntimeInfo;
}

export function formatOpcoreVersion(runtime = readOpcoreRuntimeInfo()): string {
  return `${runtime.packageName} ${runtime.version} (${runtime.artifactSource})`;
}

function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function classifyArtifactSource(): OpcoreRuntimeInfoPayload["artifactSource"] {
  const normalizedRoot = packageRoot.replaceAll("\\", "/");
  if (normalizedRoot.includes("/node_modules/@the-open-engine/opcore")) return "installed_package";
  if (normalizedRoot.endsWith("/packages/opcore") && existsSync(join(packageRoot, "..", "..", "package.json"))) {
    return "source_checkout";
  }
  return "unknown";
}
