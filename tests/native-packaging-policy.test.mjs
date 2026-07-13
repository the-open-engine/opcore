import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  bundledReleasePackageNames,
  publicReleasePackageNames
} from "../scripts/release-package-dirs.mjs";
import { npmPackResultForPackage } from "../scripts/stage-opcore-bundle.mjs";

const nativeTargets = {
  "darwin-arm64": { os: "darwin", cpu: "arm64", rustTarget: "aarch64-apple-darwin" },
  "darwin-x64": { os: "darwin", cpu: "x64", rustTarget: "x86_64-apple-darwin" },
  "linux-x64": { os: "linux", cpu: "x64", rustTarget: "x86_64-unknown-linux-musl" }
};

const nativePackageName = (target) => `@the-open-engine/opcore-graph-core-${target}`;
const nativePackageDir = (target) => `packages/opcore-graph-core-${target}`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("native graph-core packaging policy", () => {
  it("accepts npm pack JSON from direct, array, and workspace-keyed output", () => {
    const packageName = "@the-open-engine/opcore-asp-provider";
    const expected = { name: packageName, files: [{ path: "package.json" }] };
    assert.equal(npmPackResultForPackage(expected, packageName), expected);
    assert.equal(npmPackResultForPackage([expected], packageName), expected);
    assert.equal(npmPackResultForPackage({ [packageName]: expected }, packageName), expected);
    assert.equal(
      npmPackResultForPackage({ unrelated: { name: "unrelated", files: [] }, [packageName]: expected }, packageName),
      expected
    );
  });

  it("keeps npm publishing strict single-package while bundling internal native artifacts", () => {
    assert.deepEqual(publicReleasePackageNames, ["opcore"]);
    for (const target of Object.keys(nativeTargets)) {
      assert.equal(bundledReleasePackageNames.includes(nativePackageName(target)), true, target);
    }
    assert.equal(bundledReleasePackageNames.includes("@the-open-engine/opcore-asp-provider"), true);
    assert.equal(bundledReleasePackageNames.includes("opcore"), false);

    const releasePublish = readFileSync("scripts/release-publish.mjs", "utf8");
    assert.doesNotMatch(releasePublish, /graphCoreNativePackageNames/);
    assert.match(releasePublish, /publicReleasePackageNames/);
    assert.match(releasePublish, /createStagedOpcorePackage/);
    assert.match(releasePublish, /cwd:\s*packageDirs\.get\(packageName\)/);
    assert.doesNotMatch(releasePublish, /cwd:\s*releasePackageDirForName\(packageName\)/);
    assert.match(releasePublish, /--loglevel", "notice"/);
    assert.match(releasePublish, /hasTrustedPublishingContext\(\) && !hasTokenAuth\(\) && !options\.dryRun/);

    const stageBundle = readFileSync("scripts/stage-opcore-bundle.mjs", "utf8");
    assert.match(stageBundle, /"pack", "\.", "--dry-run", "--json", "--ignore-scripts"/);
    assert.match(stageBundle, /disableLifecycleScripts: true/);
    assert.match(stageBundle, /delete manifest\.scripts/);

    const releaseDryRun = readFileSync("scripts/release-dry-run.mjs", "utf8");
    assert.match(releaseDryRun, /npmPackResultForPackage\(JSON\.parse\(result\.stdout\), packageName\)/);
    assert.doesNotMatch(releaseDryRun, /JSON\.parse\(result\.stdout\)\[0\]/);
  });

  it("encodes npm os/cpu support in each bundled native package manifest", () => {
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
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const triggerBlock = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
    assert.match(triggerBlock, /pull_request:/);
    assert.match(triggerBlock, /merge_group:/);
    assert.match(triggerBlock, /dev/);
    assert.match(triggerBlock, /main/);
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
    assert.match(aggregateJob, /OPCORE_REQUIRE_ALL_NATIVE_PACKAGES:\s*"1"/);
    assert.doesNotMatch(aggregateJob, /rust-toolchain|Setup Rust|cargo build|npm run build/);
    for (const target of Object.keys(nativeTargets)) {
      assert.match(aggregateJob, new RegExp(`tar -xzf "\\$\\{RUNNER_TEMP\\}/opcore-graph-core-${target}/opcore-graph-core-${target}\\.tgz" -C packages/opcore-graph-core-${target}`));
    }
    assert.match(readFileSync("scripts/release-dry-run.mjs", "utf8"), /assertCompleteNativeArtifacts/);
  });

  it("publishes only after successful main CI and reuses CI native artifacts", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    assert.match(workflow, /workflow_run:/);
    assert.match(workflow, /workflows: \["CI"\]/);
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /NPM_TAG: latest/);
    assert.match(workflow, /OPCORE_CONFIRM_PUBLISH:\s*"0\.2\.0"/);
    assert.match(workflow, /OPCORE_REQUIRE_ALL_NATIVE_PACKAGES:\s*"1"/);
    assert.match(workflow, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
    assert.match(
      workflow,
      /name: Build JS artifacts[\s\S]*node node_modules\/typescript\/bin\/tsc -b --pretty false && node scripts\/write-cli-descriptor\.mjs && node scripts\/write-asp-provider-manifest\.mjs/
    );
    for (const target of Object.keys(nativeTargets)) {
      assert.match(workflow, new RegExp(`name: opcore-graph-core-${target}`));
      assert.match(workflow, new RegExp(`tar -xzf "\\$\\{RUNNER_TEMP\\}/opcore-graph-core-${target}/opcore-graph-core-${target}\\.tgz" -C packages/opcore-graph-core-${target}`));
    }
    assert.match(workflow, /release_notes="docs\/release\/v\$\{RELEASE_VERSION\}\.md"/);
    assert.match(workflow, /--notes-file "\$release_notes"/);
    assert.doesNotMatch(workflow, /Initial Opcore alpha release/);
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
        env: { ...process.env, OPCORE_REQUIRE_ALL_NATIVE_PACKAGES: "1" },
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
        env: { ...process.env, OPCORE_REQUIRE_ALL_NATIVE_PACKAGES: "1" },
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
