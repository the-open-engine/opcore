import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { graphCoreNativeSupportedTargets, releaseReceiptPackageNames, validateReleaseReceipt } from "../packages/contracts/dist/index.js";
import { withCompleteNativeArtifactFixtures } from "./native-artifact-fixture.mjs";

describe("release receipt gate", () => {
  it("emits validated #29 release receipt JSON", () => {
    withReleaseDocsLock(() => {
      const result = withCompleteNativeArtifactFixtures(() => run("npm", ["run", "release-receipt:check", "--", "--json"]));
      const receipt = validateReleaseReceipt(parseJsonOutput(result.stdout));
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.issue, "#29");
      assert.equal(receipt.packages.length, releaseReceiptPackageNames.length);
      assert.deepEqual(receipt.commandGroups, ["graph", "inspect", "edit", "check", "validate", "status", "doctor"]);
      assert.equal(receipt.nativeArtifacts.length, graphCoreNativeSupportedTargets.length);
      assert.deepEqual(
        receipt.nativeArtifacts.map((entry) => entry.targetPlatform),
        graphCoreNativeSupportedTargets
      );
      assert.ok(receipt.nativeArtifacts.every((entry) => /^[a-f0-9]{64}$/.test(entry.binarySha256)));
      for (const entry of receipt.packages) {
        assert.match(entry.tarball.sha256, /^[a-f0-9]{64}$/);
        assert.equal(entry.fileCount, entry.files.length);
        assert.equal(entry.expectedFileCount, entry.expectedFiles.length);
      }
      const descriptorFiles = new Map(receipt.packages.map((entry) => [entry.packageName, new Set(entry.files)]));
      for (const artifact of receipt.descriptor.resolvedArtifacts) {
        assert.equal(descriptorFiles.get(artifact.packageName).has(artifact.path), true, artifact.id);
      }
      assert.equal(receipt.license.unresolvedLicenseCount, 0);
      assert.equal(receipt.secretHistory.findingCount, 0);
      assert.equal(receipt.provenance.findingCount, 0);
      const graphReceiptChecksum = sha256File(receipt.graphReleaseReceipt.path);
      assert.equal(receipt.graphReleaseReceipt.checksumSha256, graphReceiptChecksum);
      const graphReport = receipt.reports.find((entry) => entry.id === "graph-release");
      assert.equal(graphReport?.checksumSha256, graphReceiptChecksum);
    });
  });

  it("write mode refreshes machine and human release receipt docs", () => {
    withReleaseDocsLock(() => {
      rmSync("docs/release/release-receipt.json", { force: true });
      rmSync("docs/release/release-receipt.summary.md", { force: true });
      const result = withCompleteNativeArtifactFixtures(() => run("node", ["scripts/generate-release-receipt.mjs", "--write", "--json"]));
      const receipt = validateReleaseReceipt(parseJsonOutput(result.stdout));
      assert.equal(existsSync("docs/release/release-receipt.json"), true);
      assert.equal(existsSync("docs/release/release-receipt.summary.md"), true);
      assert.equal(validateReleaseReceipt(JSON.parse(readFileSync("docs/release/release-receipt.json", "utf8"))).commitSha, receipt.commitSha);
      const summary = readFileSync("docs/release/release-receipt.summary.md", "utf8");
      assert.match(summary, /maintainer release/i);
      assert.match(summary, /alpha package gate/i);
      assert.match(summary, /allowlist/i);
    });
  });
});

function withReleaseDocsLock(runLocked) {
  const lockPath = "docs/release/.receipt-test.lock";
  const mutableDocs = [
    "docs/release/release-receipt.json",
    "docs/release/release-receipt.summary.md",
    "docs/release/license-report.md",
    "docs/release/provenance-receipts.md",
    "docs/release/artifact-attestation.md"
  ];
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      const snapshots = mutableDocs.map((path) => ({
        path,
        exists: existsSync(path),
        content: existsSync(path) ? readFileSync(path, "utf8") : undefined
      }));
      try {
        return runLocked();
      } finally {
        for (const snapshot of snapshots) {
          if (snapshot.exists) writeFileSync(snapshot.path, snapshot.content);
          else rmSync(snapshot.path, { force: true });
        }
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      sleep(50);
    }
  }
  throw new Error(`timed out waiting for ${lockPath}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf("{");
  assert.notEqual(start, -1, `missing JSON object in stdout:\n${stdout}`);
  return JSON.parse(stdout.slice(start));
}
