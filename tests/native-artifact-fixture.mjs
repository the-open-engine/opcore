import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets
} from "../packages/contracts/dist/index.js";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const binaryName = "opcore-graph-core";
const checksumName = "opcore-graph-core.sha256";
const metadataName = "metadata.json";
const nativeArtifactLockPath = join(repoRoot, "docs/release/.native-artifact-test.lock");
const nativeArtifactLockTimeoutMs = 900000;

export function withCompleteNativeArtifactFixtures(runWithArtifacts) {
  if (!existsSync(nativeArtifactLockPath) && nativeArtifactsComplete()) return runWithArtifacts();
  return withNativeArtifactLock(() => {
    const created = [];
    try {
      for (const target of graphCoreNativeSupportedTargets) {
        const packageRoot = nativePackageRoot(target);
        mkdirSync(packageRoot, { recursive: true });
        const binaryPath = join(packageRoot, binaryName);
        const checksumPath = join(packageRoot, checksumName);
        const metadataPath = join(packageRoot, metadataName);
        if (existsSync(binaryPath) && existsSync(checksumPath) && existsSync(metadataPath)) continue;
        const binary = `#!/usr/bin/env sh\nprintf '%s\\n' 'test-only ${target} graph-core artifact' >&2\nexit 64\n`;
        writeFileSync(binaryPath, binary);
        chmodSync(binaryPath, 0o755);
        const binarySha256 = sha256File(binaryPath);
        writeFileSync(checksumPath, `${binarySha256}  ${binaryName}\n`);
        writeFileSync(
          metadataPath,
          `${JSON.stringify(
            {
              artifactName: "opcore-graph-core",
              artifactVersion: "0.1.0",
              targetPlatform: target,
              binaryPath: binaryName,
              checksumPath: checksumName,
              checksumSha256: binarySha256,
              buildProfile: "release"
            },
            null,
            2
          )}\n`
        );
        created.push(binaryPath, checksumPath, metadataPath);
      }
      return runWithArtifacts();
    } finally {
      for (const path of created.reverse()) rmSync(path, { force: true });
    }
  });
}

function nativePackageRoot(target) {
  const packageName = graphCoreNativePackageNameForTarget(target).replace("@the-open-engine/", "");
  return join(repoRoot, "packages", packageName);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nativeArtifactsComplete() {
  return graphCoreNativeSupportedTargets.every((target) => {
    const packageRoot = nativePackageRoot(target);
    return [binaryName, checksumName, metadataName].every((fileName) => existsSync(join(packageRoot, fileName)));
  });
}

function withNativeArtifactLock(runLocked) {
  const deadline = Date.now() + nativeArtifactLockTimeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(nativeArtifactLockPath);
      try {
        return runLocked();
      } finally {
        rmSync(nativeArtifactLockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      sleep(50);
    }
  }
  throw new Error(`timed out waiting for ${nativeArtifactLockPath}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
