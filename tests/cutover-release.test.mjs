import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphCoreNativePackageNames,
  releaseCutoverRustCommandIds,
  releaseReceiptPackageNames,
  validateReleaseCutoverReceipt
} from "../packages/contracts/dist/index.js";
import { withCompleteNativeArtifactFixtures } from "./native-artifact-fixture.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const releaseDocsLockTimeoutMs = 900000;
const receiptGatesRunSeparately = process.env.OPCORE_CI_RECEIPT_GATES_RUN_SEPARATELY === "1";
const separateReceiptGateSkip = receiptGatesRunSeparately ? "covered by root CI receipt gate" : false;

describe("cutover release receipt", () => {
  it("proves installed Opcore artifacts without current-tool fallback", { timeout: 180000, skip: separateReceiptGateSkip }, () => {
    withReleaseDocsLock(() => {
      run(["scripts/generate-release-receipt.mjs", "--inspect-packages-only", "--json"]);
      const result = withCompleteNativeArtifactFixtures(() =>
        run(["scripts/generate-cutover-receipt.mjs", "--json"], {
          env: { ...process.env, OPCORE_CUTOVER_REUSE_RELEASE_PACKAGES: "1" }
        })
      );
      const receipt = validateReleaseCutoverReceipt(JSON.parse(result.stdout));
      assert.equal(receipt.issue, "#30");
      assert.deepEqual(receipt.packageNames, releaseReceiptPackageNames);
      assert.equal(receipt.installedPackages.filter((entry) => graphCoreNativePackageNames.includes(entry.packageName)).length, 1);
      assert.deepEqual(
        receipt.installedPackages.filter((entry) => !graphCoreNativePackageNames.includes(entry.packageName)).map((entry) => entry.packageName).sort(),
        releaseReceiptPackageNames.filter((packageName) => !graphCoreNativePackageNames.includes(packageName)).sort()
      );
      assert.equal(receipt.environmentIsolation.currentToolEnvCleared, true);
      assert.equal(receipt.environmentIsolation.aceRuntimeBinExcluded, true);
      assert.equal(receipt.environmentIsolation.siblingCovibesExcluded, true);
      assert.equal(receipt.environmentIsolation.opcoreBinOnly, true);
      assert.deepEqual(receipt.environmentIsolation.oldBinsAbsent, { crg: true, cix: true, rox: true });
      assert.equal(receipt.commandReceipts.every((entry) => entry.command[0] === "opcore" || entry.command[0] === "opcore"), true);
      assert.deepEqual(
        receipt.commandReceipts.filter((entry) => entry.status === "not_implemented").map((entry) => entry.id),
        []
      );
      assert.deepEqual(
        receipt.rustCommandReceipts.map((entry) => entry.id),
        releaseCutoverRustCommandIds
      );
      assert.equal(receipt.rustCommandReceipts.every((entry) => entry.owner === "graph" && entry.status === "ok"), true);
      for (const id of ["inspect-symbols", "inspect-definition", "inspect-references", "inspect-signature", "inspect-implementations", "inspect-search"]) {
        assert.equal(receipt.commandReceipts.find((entry) => entry.id === id)?.owner, "inspect", id);
      }
      assert.equal(receipt.forbiddenMarkerScan.findingCount, 0);
      assert.deepEqual(receipt.inputEvidence.map((entry) => entry.issue).sort(), ["#17", "#29", "#58"]);
    });
  });

  it("rejects cutover receipts with advertised placeholder command evidence", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-cutover-negative-"));
    try {
      const receiptPath = join(temp, "cutover.json");
      const descriptor = JSON.parse(readFileSync(resolve(repoRoot, "packages/fixtures/descriptors/opcore.managed-tool.json"), "utf8"));
      const cutover = {
        schemaVersion: 1,
        issue: "#30",
        origin: "covibes-authored-cutover-proof",
        generatedAt: "2026-06-05T00:00:00.000Z",
        commitSha: "a".repeat(40),
        privateRepo: true,
        packageNames: releaseReceiptPackageNames,
        installedPackages: releaseReceiptPackageNames
          .filter((packageName) => !graphCoreNativePackageNames.includes(packageName) || packageName === graphCoreNativePackageNames[0])
          .map((packageName) => ({
            packageName,
            version: "0.1.0-alpha.0",
            tarball: { filename: `${packageName}.tgz`, sha256: "b".repeat(64) },
            installedManifest: {
              path: `node_modules/${packageName}/package.json`,
              sha256: "c".repeat(64),
              bins:
                packageName === "@the-open-engine/opcore"
                  ? { opcore: "dist/index.js" }
                  : packageName === "@the-open-engine/opcore-asp-provider"
                    ? { "opcore-asp-provider": "dist/index.js" }
                    : {}
            },
            installedFiles: installedFilesFor(packageName)
          })),
        descriptor: {
          path: "packages/opcore/dist/descriptors/opcore.managed-tool.json",
          packageName: "@the-open-engine/opcore",
          checksumSha256: "d".repeat(64),
          descriptor,
          resolvedArtifacts: descriptor.artifacts.map((artifact) => ({ ...artifact, packageFile: true })),
          resolvedChecksums: descriptor.checksums.map((checksum) => ({
            ...checksum,
            packageFile: true,
            value: "8".repeat(64)
          }))
        },
        environmentIsolation: {
          currentToolEnvCleared: true,
          clearedEnvVarCount: 5,
          pathSanitized: true,
          aceRuntimeBinExcluded: true,
          siblingCovibesExcluded: true,
          opcoreBinOnly: true,
          oldBinsAbsent: { crg: true, cix: true, rox: true }
        },
        commandReceipts: [
          {
            id: "inspect-symbols",
            command: ["opcore", "inspect", "symbols"],
            canonicalCommand: ["opcore", "inspect", "symbols"],
            owner: "inspect",
            status: "not_implemented",
            exitCode: 2,
            binPath: "node_modules/.bin/opcore",
            stdoutSha256: "e".repeat(64),
            stderrSha256: "f".repeat(64),
            assertion: "bad placeholder"
          }
        ],
        negativeChecks: [],
        forbiddenMarkerScan: { scannedTextCount: 1, findingCount: 0, markersBlocked: ["private-runtime"] },
        inputEvidence: [
          { issue: "#17", path: "docs/release/graph-release-receipt.json", checksumSha256: "1".repeat(64) },
          { issue: "#29", path: "docs/release/release-receipt.json", checksumSha256: "2".repeat(64) },
          { issue: "#58", path: "docs/integration/pre-write-validation.md", checksumSha256: "3".repeat(64) }
        ]
      };
      writeFileSync(receiptPath, `${JSON.stringify(cutover)}\n`);
      const result = run(["scripts/generate-cutover-receipt.mjs", "--validate-receipt-file", receiptPath], { expectFailure: true });
      assert.match(`${result.stdout}\n${result.stderr}`, /not_implemented|command receipts/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function installedFilesFor(packageName) {
  const paths = [
    "package.json",
    ...(packageName === "@the-open-engine/opcore" ? ["dist/index.js"] : []),
    ...(packageName === "@the-open-engine/opcore-asp-provider" ? ["dist/index.js", "dist/manifests/asp-server.json"] : [])
  ];
  return paths.map((path) => ({ path: `node_modules/${packageName}/${path}`, sha256: "4".repeat(64) }));
}

function withReleaseDocsLock(runLocked) {
  const lockPath = resolve(repoRoot, "docs/release/.receipt-test.lock");
  const mutableDocs = [
    "docs/release/release-receipt.json",
    "docs/release/release-receipt.summary.md",
    "docs/release/license-report.md",
    "docs/release/provenance-receipts.md",
    "docs/release/artifact-attestation.md"
  ];
  const deadline = Date.now() + releaseDocsLockTimeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      const snapshots = mutableDocs.map((path) => {
        const absolute = resolve(repoRoot, path);
        return {
          path: absolute,
          exists: existsSync(absolute),
          content: existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined
        };
      });
      try {
        ensureReleaseReceiptInputFixture();
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

function ensureReleaseReceiptInputFixture() {
  const receiptPath = resolve(repoRoot, "docs/release/release-receipt.json");
  if (existsSync(receiptPath)) return;
  writeFileSync(
    receiptPath,
    `${JSON.stringify({ schemaVersion: 1, issue: "#29", kind: "cutover-test-release-receipt-input" }, null, 2)}\n`
  );
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const expectFailure = options.expectFailure ?? false;
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    throw new Error(
      [
        `Command failed: node ${args.join(" ")}`,
        `status: ${result.status}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`
      ].join("\n")
    );
  }
  return result;
}
