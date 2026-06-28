import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const nativeTargets = {
  "darwin-arm64": { os: "darwin", cpu: "arm64", rustTarget: "aarch64-apple-darwin" },
  "darwin-x64": { os: "darwin", cpu: "x64", rustTarget: "x86_64-apple-darwin" },
  "linux-x64": { os: "linux", cpu: "x64", rustTarget: "x86_64-unknown-linux-musl" }
};

const nativePackageName = (target) => `@the-open-engine/opcore-graph-core-${target}`;
const nativePackageDir = (target) => `packages/opcore-graph-core-${target}`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("native graph-core packaging policy", () => {
  it("encodes npm os/cpu support in each public native package manifest", () => {
    for (const [target, expected] of Object.entries(nativeTargets)) {
      const manifest = readJson(`${nativePackageDir(target)}/package.json`);
      assert.equal(manifest.name, nativePackageName(target));
      assert.deepEqual(manifest.os, [expected.os], target);
      assert.deepEqual(manifest.cpu, [expected.cpu], target);
    }
  });

  it("keeps platform-scoped native packages out of root workspaces while linking local compatible optional deps", () => {
    const root = readJson("package.json");
    assert.equal(root.workspaces.includes("packages/*"), false);
    for (const workspace of root.workspaces) assert.doesNotMatch(workspace, /opcore-graph-core/);
    for (const target of Object.keys(nativeTargets)) {
      assert.equal(root.optionalDependencies?.[nativePackageName(target)], `file:${nativePackageDir(target)}`);
    }
  });

  it("does not weaken clean-room npm install gates with --force", () => {
    for (const script of ["scripts/generate-cutover-receipt.mjs", "scripts/generate-asp-dogfood-receipt.mjs"]) {
      assert.doesNotMatch(readFileSync(script, "utf8"), /"install"[\s\S]{0,120}"--force"/, script);
    }
  });

  it("proves native release dry-runs per CI target and aligns Linux Rust target with the build script", () => {
    const workflow = readFileSync(".github/workflows/release-dry-run.yml", "utf8");
    const triggerBlock = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
    assert.match(triggerBlock, /pull_request:/);
    assert.match(triggerBlock, /\.github\/workflows\/release-dry-run\.yml/);
    const nativeJob = workflow.slice(workflow.indexOf("native-artifact:"), workflow.indexOf("aggregate:"));
    for (const [target, expected] of Object.entries(nativeTargets)) {
      assert.match(nativeJob, new RegExp(`target: ${target}[\\s\\S]*?rust_target: ${expected.rustTarget}`));
    }
    assert.match(nativeJob, /npm run release:dry-run/);
    assert.match(nativeJob, /tar -C packages\/opcore-graph-core-\$\{\{ matrix\.target \}\} -czf "\$\{RUNNER_TEMP\}\/opcore-graph-core-\$\{\{ matrix\.target \}\}\.tgz" \./);
    assert.match(nativeJob, /path: \$\{\{ runner\.temp \}\}\/opcore-graph-core-\$\{\{ matrix\.target \}\}\.tgz/);
    assert.doesNotMatch(nativeJob, /path: packages\/opcore-graph-core-\$\{\{ matrix\.target \}\}\//);
    const aggregateJob = workflow.slice(workflow.indexOf("aggregate:"));
    assert.match(aggregateJob, /npm run release:dry-run/);
    assert.match(aggregateJob, /LATTICE_REQUIRE_ALL_NATIVE_PACKAGES:\s*"1"/);
    assert.doesNotMatch(aggregateJob, /rust-toolchain|Setup Rust|cargo build|npm run build/);
    for (const target of Object.keys(nativeTargets)) {
      assert.match(aggregateJob, new RegExp(`tar -xzf "\\$\\{RUNNER_TEMP\\}/opcore-graph-core-${target}/opcore-graph-core-${target}\\.tgz" -C packages/opcore-graph-core-${target}`));
    }
    assert.match(readFileSync("scripts/release-dry-run.mjs", "utf8"), /assertCompleteNativeArtifacts/);
  });

  it("fails aggregate release dry-run before packing when downloaded native binary mode is not executable", () => {
    const currentTarget = `${process.platform}-${process.arch}`;
    const target = Object.keys(nativeTargets).find((candidate) => candidate !== currentTarget);
    assert.ok(target, "test requires at least one non-current supported native target");

    const binary = `${nativePackageDir(target)}/opcore-graph-core`;
    const originalMode = statSync(binary).mode & 0o777;
    try {
      chmodSync(binary, 0o644);
      const result = spawnSync(process.execPath, ["scripts/release-dry-run.mjs"], {
        env: { ...process.env, LATTICE_REQUIRE_ALL_NATIVE_PACKAGES: "1" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /must be executable/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /graph build fails|EACCES|spawnSync/);
    } finally {
      chmodSync(binary, originalMode);
    }
  });

  it("fails aggregate release dry-run when a downloaded native artifact lacks clone protocol support", () => {
    const currentTarget = `${process.platform}-${process.arch}`;
    const target = Object.keys(nativeTargets).find((candidate) => candidate !== currentTarget);
    assert.ok(target, "test requires at least one non-current supported native target");

    const packageDir = nativePackageDir(target);
    const binary = `${packageDir}/opcore-graph-core`;
    const checksum = `${packageDir}/opcore-graph-core.sha256`;
    const metadataPath = `${packageDir}/metadata.json`;
    const originalBinary = readFileSync(binary);
    const originalChecksum = readFileSync(checksum, "utf8");
    const originalMetadata = readFileSync(metadataPath, "utf8");
    const originalMode = statSync(binary).mode & 0o777;
    try {
      const staleBinary = Buffer.from("#!/usr/bin/env sh\nexit 0\n");
      const staleChecksum = createHash("sha256").update(staleBinary).digest("hex");
      writeFileSync(binary, staleBinary);
      chmodSync(binary, 0o755);
      writeFileSync(checksum, `${staleChecksum}  opcore-graph-core\n`);
      const metadata = readJson(metadataPath);
      metadata.checksumSha256 = staleChecksum;
      writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

      const result = spawnSync(process.execPath, ["scripts/release-dry-run.mjs"], {
        env: { ...process.env, LATTICE_REQUIRE_ALL_NATIVE_PACKAGES: "1" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /must include clone protocol opcore\.clone\.v1/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /checksum mismatch/);
    } finally {
      writeFileSync(binary, originalBinary);
      chmodSync(binary, originalMode);
      writeFileSync(checksum, originalChecksum);
      writeFileSync(metadataPath, originalMetadata);
    }
  });
});
