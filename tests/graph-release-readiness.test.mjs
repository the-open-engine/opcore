import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphReleaseBenchmarkMetrics,
  graphReleaseCoreCommandIds,
  graphReleaseDeferredChildren,
  graphReleaseDirectSqliteQueryIds,
  graphReleaseOptionalAnalysisSurfaces,
  graphReleaseRustCommandIds,
  validateGraphReleaseReceipt
} from "../packages/contracts/dist/index.js";
import { withCompleteNativeArtifactFixtures } from "./native-artifact-fixture.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const receiptGatesRunSeparately = process.env.OPCORE_CI_RECEIPT_GATES_RUN_SEPARATELY === "1";
const separateReceiptGateSkip = receiptGatesRunSeparately ? "covered by root CI receipt gate" : false;
const serveTransportIds = [
  "serve-jsonl-ping",
  "serve-jsonl-status",
  "serve-jsonl-query",
  "serve-jsonl-search",
  "serve-jsonl-shutdown"
];

describe("graph release readiness receipt", () => {
  it("validates the static #17 fixture", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../packages/fixtures/graph-release/release-readiness-fixture.json", import.meta.url), "utf8")
    );
    const receipt = validateGraphReleaseReceipt(fixture);
    assert.deepEqual(
      receipt.commandCoverage.map((entry) => entry.id),
      graphReleaseCoreCommandIds
    );
    assert.deepEqual(
      receipt.rustCommandCoverage.map((entry) => entry.id),
      graphReleaseRustCommandIds
    );
    assert.deepEqual(
      receipt.benchmarks.map((entry) => entry.metric),
      graphReleaseBenchmarkMetrics
    );
    assert.deepEqual(
      receipt.directSqliteQueries.map((entry) => entry.id),
      graphReleaseDirectSqliteQueryIds
    );
    assert.deepEqual(
      receipt.serveTransport.map((entry) => entry.id),
      serveTransportIds
    );
    assert.deepEqual(receipt.deferredChildren, graphReleaseDeferredChildren);
    assert.deepEqual(receipt.optionalSurfaces, graphReleaseOptionalAnalysisSurfaces);
    assert.equal(receipt.packageInspection.fileCount, receipt.packageInspection.files.length);
    assert.equal(receipt.packageInspection.forbiddenMarkersAbsent, true);
  });

  it("generates a passing #17 receipt gate", { skip: separateReceiptGateSkip }, () => {
    const result = withCompleteNativeArtifactFixtures(() => {
      return spawnSync("npm", ["run", "--silent", "graph-release:check", "--", "--json"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = validateGraphReleaseReceipt(JSON.parse(result.stdout));
    assert.deepEqual(
      receipt.commandCoverage.map((entry) => entry.status),
      graphReleaseCoreCommandIds.map(() => "passed")
    );
    assert.deepEqual(
      receipt.rustCommandCoverage.map((entry) => entry.id),
      graphReleaseRustCommandIds
    );
    assert.ok(receipt.rustCommandCoverage.every((entry) => entry.status === "passed" && entry.fixture === "packages/fixtures/source-extraction/rust-only"));
    assert.deepEqual(
      receipt.benchmarks.map((entry) => entry.metric),
      graphReleaseBenchmarkMetrics
    );
    assert.ok(receipt.benchmarks.every((entry) => entry.value > 0));
    assert.ok(receipt.benchmarks.find((entry) => entry.metric === "wal_size_bytes").value > 1);
    assert.deepEqual(
      receipt.directSqliteQueries.map((entry) => entry.id),
      graphReleaseDirectSqliteQueryIds
    );
    assert.deepEqual(
      receipt.serveTransport.map((entry) => entry.id),
      serveTransportIds
    );
    assert.deepEqual(receipt.deferredChildren, graphReleaseDeferredChildren);
    assert.deepEqual(receipt.optionalSurfaces, graphReleaseOptionalAnalysisSurfaces);
    assert.ok(receipt.directSqliteQueries.every((entry) => entry.status === "passed"));
    assert.ok(receipt.handoff.every((entry) => entry.checksumSha256 === payloadChecksum(receipt)));
    assert.equal(receipt.packageInspection.fileCount, receipt.packageInspection.files.length);
    assert.equal(receipt.packageInspection.forbiddenMarkersAbsent, true);
    assert.ok(receipt.reportReceipts.every((entry) => entry.status === "passed" && entry.exitCode === 0));
  });

  it("keeps graph release generator functions focused", () => {
    const source = readFileSync(new URL("../scripts/generate-graph-release-receipt.mjs", import.meta.url), "utf8");
    const lengths = functionLineLengths(source);
    assert.ok(lengths.get("generateReceipt") <= 50, `generateReceipt has ${lengths.get("generateReceipt")} lines`);
    assert.ok(lengths.get("runServeTransport") <= 50, `runServeTransport has ${lengths.get("runServeTransport")} lines`);
    assert.doesNotMatch(source, /serveTransport\.find[\s\S]*\?\? 1/);
    assert.doesNotMatch(source, /walSizeBytes:\s*existsSync[\s\S]*\?\s*fileSize\([^)]*\)\s*:\s*1/);
    assert.doesNotMatch(source, /value:\s*Math\.max\(1/);
    assert.match(source, /walCheckpoint/);
  });

  it("fails instead of fabricating WAL benchmark evidence", { skip: separateReceiptGateSkip }, () => {
    const result = spawnSync("npm", ["run", "--silent", "graph-release:check", "--", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, LATTICE_GRAPH_RELEASE_TEST_DROP_WAL_EVIDENCE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.notEqual(result.status, 0, "missing WAL evidence must fail graph-release:check");
    assert.match(result.stderr, /Missing graph-core WAL checkpoint evidence/);
    assert.doesNotMatch(result.stdout, /"metric": "wal_size_bytes"[\s\S]*"value": 1/);
  });

  it("rejects forbidden markers inside packaged graph files", () => {
    const testRepo = tempGraphPackageInspectionRepo();
    try {
      const taintedPath = join(testRepo, "packages/graph/dist/__tainted-provenance.js");
      writeFileSync(taintedPath, "export const forbidden = 'setup.py';\n");
      const result = spawnSync(
        process.execPath,
        ["scripts/generate-graph-release-receipt.mjs", "--inspect-package-only", "--json"],
        {
          cwd: testRepo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      assert.notEqual(result.status, 0, "tainted packaged content must fail inspection");
      assert.match(result.stderr, /Graph package file content contains forbidden marker/);
      assert.equal(existsSync(join(repoRoot, "packages/graph/dist/__tainted-provenance.js")), false);
    } finally {
      rmSync(testRepo, { recursive: true, force: true });
    }
  });
});

function tempGraphPackageInspectionRepo() {
  const tempRoot = mkdtempSync(join(tmpdir(), "opcore-graph-package-test-"));
  mkdirSync(join(tempRoot, "scripts"), { recursive: true });
  mkdirSync(join(tempRoot, "packages/contracts/dist"), { recursive: true });
  mkdirSync(join(tempRoot, "packages/graph"), { recursive: true });
  cpSync(join(repoRoot, "package.json"), join(tempRoot, "package.json"));
  cpSync(join(repoRoot, ".npmrc"), join(tempRoot, ".npmrc"));
  cpSync(join(repoRoot, "scripts/generate-graph-release-receipt.mjs"), join(tempRoot, "scripts/generate-graph-release-receipt.mjs"));
  cpSync(join(repoRoot, "packages/contracts/dist/index.js"), join(tempRoot, "packages/contracts/dist/index.js"));
  cpSync(join(repoRoot, "packages/graph/package.json"), join(tempRoot, "packages/graph/package.json"));
  cpSync(join(repoRoot, "packages/graph/README.md"), join(tempRoot, "packages/graph/README.md"));
  cpSync(join(repoRoot, "packages/graph/dist"), join(tempRoot, "packages/graph/dist"), { recursive: true });
  return tempRoot;
}

function payloadChecksum(receipt) {
  const { handoff, ...payload } = receipt;
  return createHash("sha256")
    .update(`${JSON.stringify(payload, null, 2)}\n`)
    .digest("hex");
}

function functionLineLengths(source) {
  const lines = source.split("\n");
  const lengths = new Map();
  lines.forEach((line, index) => {
    const match = line.match(/^(?:async )?function (\w+)\b/);
    if (!match) return;
    const end = findFunctionEnd(lines, index);
    lengths.set(match[1], end - index + 1);
  });
  return lengths;
}

function findFunctionEnd(lines, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
    if (index > startIndex && depth === 0) return index;
  }
  throw new Error(`Function starting on line ${startIndex + 1} did not close`);
}
