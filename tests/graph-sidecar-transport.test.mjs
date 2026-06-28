import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeResolvedGraphCoreSidecar } from "../packages/graph/dist/sidecar.js";

const currentTarget = `${process.platform}-${process.arch}`;

describe("graph sidecar transport", () => {
  it("decodes sidecar responses larger than the default spawnSync buffer", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-graph-sidecar-large-"));
    try {
      const largeChangedFiles = Array.from({ length: 22000 }, (_, index) => {
        return `src/generated/module-${String(index).padStart(5, "0")}/component-${String(index).padStart(5, "0")}.ts`;
      });
      const responsePath = join(temp, "response.jsonl");
      const executablePath = join(temp, "opcore-graph-core");
      writeFileSync(responsePath, `${JSON.stringify(buildResponse(temp, largeChangedFiles, "large-build"))}\n`);
      assert.ok(readFileSync(responsePath, "utf8").length > 1024 * 1024);
      writeSidecarStub(executablePath, [
        `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(responsePath)}, "utf8"));`
      ]);

      const result = invokeResolvedGraphCoreSidecar(testArtifact(temp, executablePath), {
        protocol: "opcore.graph.daemon",
        requestId: "large-build",
        schemaVersion: 1,
        operation: "build",
        repo: {
          repoRoot: temp
        }
      });

      assert.equal(result.status.state, "available");
      assert.equal(result.pipeline.summary.changedFiles.length, largeChangedFiles.length);
      assert.equal(result.pipeline.summary.changedFiles.at(-1), largeChangedFiles.at(-1));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("bounds large stderr from failed sidecars while preserving diagnostics", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-graph-sidecar-large-stderr-"));
    try {
      const executablePath = join(temp, "opcore-graph-core");
      const headMarker = "sidecar stderr head marker";
      const tailMarker = "sidecar stderr tail marker";
      writeSidecarStub(executablePath, [
        `process.stderr.write(${JSON.stringify(headMarker)} + "\\n");`,
        `process.stderr.write("x".repeat(1024 * 1024 + 128));`,
        `process.stderr.write("\\n" + ${JSON.stringify(tailMarker)} + "\\n");`,
        "process.exit(42);"
      ]);

      const result = invokeResolvedGraphCoreSidecar(testArtifact(temp, executablePath), {
        protocol: "opcore.graph.daemon",
        requestId: "large-stderr",
        schemaVersion: 1,
        operation: "status",
        repo: {
          repoRoot: temp
        }
      });

      assert.equal(result.status.state, "daemon_unavailable");
      assert.match(result.status.failure.message, /graph-core sidecar exited 42/);
      assert.match(result.status.failure.message, new RegExp(headMarker));
      assert.match(result.status.failure.message, new RegExp(tailMarker));
      assert.match(result.status.failure.message, /\[stderr truncated: \d+ bytes omitted\]/);
      assert.ok(result.status.failure.message.length < 140000, "failure message should not embed full sidecar stderr");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("allows pipeline sidecars to run longer than the legacy five second timeout", { timeout: 15000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-graph-sidecar-timeout-"));
    try {
      const responsePath = join(temp, "response.jsonl");
      const executablePath = join(temp, "opcore-graph-core");
      writeFileSync(responsePath, `${JSON.stringify(buildResponse(temp, ["src/app.ts"], "slow-build"))}\n`);
      writeSidecarStub(executablePath, [
        "setTimeout(() => {",
        `  process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(responsePath)}, "utf8"));`,
        "}, 5500);"
      ]);

      const result = invokeResolvedGraphCoreSidecar(testArtifact(temp, executablePath), {
        protocol: "opcore.graph.daemon",
        requestId: "slow-build",
        schemaVersion: 1,
        operation: "build",
        repo: {
          repoRoot: temp
        }
      });

      assert.equal(result.status.state, "available");
      assert.deepEqual(result.pipeline.summary.changedFiles, ["src/app.ts"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function writeSidecarStub(executablePath, bodyLines) {
  writeFileSync(executablePath, ["#!/usr/bin/env node", ...bodyLines].join("\n"));
  chmodSync(executablePath, 0o755);
}

function availableStatus(repoRoot) {
  return {
    state: "available",
    mode: "required",
    provider: "opcore-graph",
    schemaVersion: 1,
    repo: { repoRoot },
    freshness: {
      generatedAt: "2026-01-01T00:00:01.000Z",
      ageMs: 0,
      stale: false
    },
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function buildResponse(repoRoot, changedFiles, requestId) {
  return {
    protocol: "opcore.graph.daemon",
    requestId,
    schemaVersion: 1,
    status: availableStatus(repoRoot),
    pipeline: {
      summary: {
        operation: "build",
        repo: { repoRoot },
        storePath: join(repoRoot, ".lattice", "graph", "graph.db"),
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        discoveredFiles: changedFiles.length,
        parsedFiles: changedFiles.length,
        changedFiles,
        deletedFiles: [],
        unchangedFiles: 0,
        fullRebuildRequired: false,
        diagnosticsCount: 0,
        phaseTimings: [
          {
            phase: "discovery",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            durationMs: 1000,
            fileCount: changedFiles.length
          }
        ]
      },
      status: availableStatus(repoRoot)
    }
  };
}

function testArtifact(temp, executablePath) {
  return {
    artifactName: "opcore-graph-core",
    artifactVersion: "0.1.0-alpha.0",
    targetPlatform: currentTarget,
    binaryPath: "opcore-graph-core",
    checksumPath: "opcore-graph-core.sha256",
    checksumSha256: "test-checksum",
    buildProfile: "test",
    executablePath,
    metadataPath: join(temp, "metadata.json")
  };
}
