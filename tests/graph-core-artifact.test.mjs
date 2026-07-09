import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphCoreNativePackageNamesByTarget,
  resolveGraphCoreArtifactForTarget
} from "../packages/graph/dist/index.js";
import { releasePackageDirForName } from "../scripts/release-package-dirs.mjs";

const sourceFixtureRoot = fileURLToPath(new URL("../packages/fixtures/source-extraction/wave1", import.meta.url));
const currentTarget = `${process.platform}-${process.arch}`;
const currentNativePackage = graphCoreNativePackageNamesByTarget[currentTarget];

describe("graph-core native artifact", () => {
  it("returns a clear typed failure for unsupported Windows targets without local fallback", () => {
    const attempted = [];
    const result = resolveGraphCoreArtifactForTarget("win32-x64", (specifier) => {
      attempted.push(specifier);
      throw new Error(`unexpected lookup: ${specifier}`);
    });
    assert.equal(result.ok, false);
    assert.equal(result.status.state, "required_missing");
    assert.equal(result.status.failure.category, "provider_missing");
    assert.match(result.status.message, /Opcore 0\.2\.0 supports darwin-arm64, darwin-x64, linux-x64/);
    assert.match(result.status.message, /Windows is not supported/);
    assert.deepEqual(attempted, []);
  });

  it("resolves native package metadata with injected package resolution", () => {
    assert.ok(currentNativePackage, `unsupported local graph-core target ${currentTarget}`);
    const metadataPath = fileURLToPath(new URL(`../packages/${currentNativePackage.replace("@the-open-engine/", "")}/metadata.json`, import.meta.url));
    const result = resolveGraphCoreArtifactForTarget(currentTarget, (specifier) => {
      assert.equal(specifier, `${currentNativePackage}/metadata.json`);
      return metadataPath;
    });
    assert.equal(result.ok, true);
    assert.equal(result.artifact.targetPlatform, currentTarget);
    assert.equal(result.artifact.binaryPath, "opcore-graph-core");
    assert.equal(result.artifact.checksumPath, "opcore-graph-core.sha256");
  });

  it("builds linux-x64 with the musl Rust target even on linux-x64 hosts", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-graph-core-musl-build-"));
    try {
      mkdirSync(join(temp, "bin"), { recursive: true });
      mkdirSync(join(temp, "packages", "graph"), { recursive: true });
      mkdirSync(join(temp, "packages", "opcore-graph-core-linux-x64"), { recursive: true });
      writeFileSync(join(temp, "packages", "graph", "package.json"), `${JSON.stringify({ version: "0.2.0" })}\n`);
      const cargoStub = join(temp, "bin", "cargo");
      writeFileSync(
        cargoStub,
        [
          "#!/usr/bin/env node",
          'const { mkdirSync, writeFileSync } = require("node:fs");',
          'const { join } = require("node:path");',
          "const args = process.argv.slice(2);",
          'writeFileSync(join(process.cwd(), "cargo-args.json"), `${JSON.stringify(args)}\\n`);',
          'mkdirSync(join(process.cwd(), "target", "x86_64-unknown-linux-musl", "release"), { recursive: true });',
          'writeFileSync(join(process.cwd(), "target", "x86_64-unknown-linux-musl", "release", "opcore-graph-core"), "linux-musl-binary\\n");'
        ].join("\n")
      );
      chmodSync(cargoStub, 0o755);

      const scriptUrl = new URL("../scripts/build-graph-core-artifact.mjs", import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            'Object.defineProperty(process, "platform", { value: "linux" });',
            'Object.defineProperty(process, "arch", { value: "x64" });',
            'process.argv = ["node", "scripts/build-graph-core-artifact.mjs", "--target", "linux-x64"];',
            `await import(${JSON.stringify(scriptUrl)});`
          ].join("\n")
        ],
        {
          cwd: temp,
          env: {
            ...process.env,
            PATH: `${join(temp, "bin")}:${process.env.PATH ?? ""}`
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.deepEqual(JSON.parse(readFileSync(join(temp, "cargo-args.json"), "utf8")), [
        "build",
        "--package",
        "opcore-graph-core",
        "--release",
        "--target",
        "x86_64-unknown-linux-musl"
      ]);
      const metadata = JSON.parse(readFileSync(join(temp, "packages", "opcore-graph-core-linux-x64", "metadata.json"), "utf8"));
      assert.equal(metadata.targetPlatform, "linux-x64");
      assert.equal(metadata.binaryPath, "opcore-graph-core");
      assert.equal(metadata.checksumPath, "opcore-graph-core.sha256");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("packs, installs, and answers GraphProvider daemon smoke envelopes", { timeout: 120000 }, () => {
    assert.ok(currentNativePackage, `unsupported local graph-core target ${currentTarget}`);
    const temp = mkdtempSync(join(tmpdir(), "opcore-graph-core-artifact-"));
    try {
      const contracts = packWorkspace("@the-open-engine/opcore-contracts", temp);
      const native = packWorkspace(currentNativePackage, temp);
      const graph = packWorkspace("@the-open-engine/opcore-graph", temp);
      const project = join(temp, "project");
      const fixtureRoot = join(temp, "wave1");
      cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
      mkdirSync(project);
      run("npm", ["init", "-y"], { cwd: project });
      run("npm", ["install", "--ignore-scripts", contracts, native, graph], { cwd: project });

      const sidecar = join(
        project,
        "node_modules",
        ...currentNativePackage.split("/"),
        "opcore-graph-core"
      );

      const ping = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "ping-1",
        schemaVersion: 1,
        operation: "ping",
        repo: {
          repoId: "opcore"
        }
      });
      assert.equal(ping.status.state, "available");
      assert.equal(ping.status.handshake.supportedOperations.includes("health"), true);

      const status = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "status-1",
        schemaVersion: 1,
        operation: "status",
        repo: {
          repoId: "opcore"
        }
      });
      assert.equal(status.protocol, "opcore.graph.daemon");
      assert.equal(status.schemaVersion, 1);
      assert.equal(status.status.state, "available");
      assert.equal(status.status.provider, "opcore-graph");
      assert.equal(status.status.handshake.artifactName, "opcore-graph-core");
      assert.equal(status.status.handshake.artifact.artifactName, "opcore-graph-core");

      const build = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "build-1",
        schemaVersion: 1,
        operation: "build",
        repo: {
          repoRoot: fixtureRoot
        }
      });
      assert.equal(build.status.state, "available");
      assert.equal(build.pipeline.summary.operation, "build");
      assert.deepEqual(build.pipeline.summary.phaseTimings.map((timing) => timing.phase), ["discovery", "extraction", "store"]);

      const query = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "query-1",
        schemaVersion: 1,
        operation: "query",
        repo: {
          repoRoot: fixtureRoot
        },
        query: {
          requestId: "query-1",
          repo: {
            repoRoot: fixtureRoot
          },
          schemaVersion: 1,
          mode: "required",
          selector: {
            kind: "nodes"
          }
        }
      });
      assert.equal(query.protocol, "opcore.graph.daemon");
      assert.equal(query.status.state, "available");
      assert.equal(query.result.status.state, "available");
      assert.ok(query.result.nodes.length > 0);
      assert.ok(query.result.edges.length > 0);
      assert.equal(query.result.metadata.provider, "opcore-graph");

      const update = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "update-1",
        schemaVersion: 1,
        operation: "update",
        repo: {
          repoRoot: fixtureRoot
        },
        baseRef: "HEAD"
      });
      assert.equal(update.status.state, "available");
      assert.equal(update.pipeline.summary.operation, "update");
      assert.equal(update.pipeline.summary.baseRef, "HEAD");

      const watch = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "watch-jsonl",
        schemaVersion: 1,
        operation: "watch",
        repo: {
          repoRoot: fixtureRoot
        },
        once: true,
        pollIntervalMs: 50,
        idleTimeoutMs: 0
      });
      assert.equal(watch.requestId, "watch-jsonl");
      assert.equal(watch.status.state, "available");
      assert.equal(watch.pipeline.summary.operation, "watch");
      assert.equal(watch.lifecycle.state, "available");
      assert.equal(watch.pipeline.lifecycle.state, "available");
      assert.equal(watch.lifecycle.idleTimeoutMs, 0);
      for (const artifact of [watch.lifecycle.pidPath, watch.lifecycle.statePath, watch.lifecycle.logPath]) {
        assert.equal(existsSync(artifact), true, artifact);
      }
      const stoppedWatch = JSON.parse(readFileSync(watch.lifecycle.statePath, "utf8"));
      assert.equal(stoppedWatch.state, "stopped");
      assert.equal(stoppedWatch.idleTimeoutMs, 0);

      const health = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "health-1",
        schemaVersion: 1,
        operation: "health",
        repo: {
          repoRoot: fixtureRoot
        }
      });
      assert.equal(health.status.state, "available");

      const daemonDir = join(fixtureRoot, ".opcore/graph/daemon");
      const statePath = join(daemonDir, "state.json");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(
        statePath,
        `${JSON.stringify({
          state: "warming",
          pid: 999999,
          startedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
          pidPath: join(daemonDir, "pid"),
          statePath,
          logPath: join(daemonDir, "daemon.log"),
          pollIntervalMs: 50,
          idleTimeoutMs: 1800000,
          watchPaths: [],
          message: "stale lifecycle"
        })}\n`
      );
      const staleHealth = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "health-stale-lifecycle",
        schemaVersion: 1,
        operation: "health",
        repo: {
          repoRoot: fixtureRoot
        }
      });
      assert.equal(staleHealth.status.state, "daemon_unavailable");
      assert.equal(staleHealth.status.failure.category, "daemon_unavailable");

      writeFileSync(join(daemonDir, "pid"), "999999\n");
      writeFileSync(
        statePath,
        `${JSON.stringify({
          state: "available",
          pid: 999999,
          startedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
          pidPath: join(daemonDir, "pid"),
          statePath,
          logPath: join(daemonDir, "daemon.log"),
          pollIntervalMs: 50,
          idleTimeoutMs: 1800000,
          watchPaths: [],
          message: "stale lifecycle"
        })}\n`
      );
      const staleAvailableHealth = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "health-stale-available-lifecycle",
        schemaVersion: 1,
        operation: "health",
        repo: {
          repoRoot: fixtureRoot
        }
      });
      assert.equal(staleAvailableHealth.status.state, "daemon_unavailable");
      assert.equal(staleAvailableHealth.status.failure.category, "daemon_unavailable");
      assert.match(staleAvailableHealth.status.failure.message, /pid 999999 is not running/);

      writeFileSync(statePath, "{not json\n");
      const corruptHealth = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "health-corrupt-lifecycle",
        schemaVersion: 1,
        operation: "health",
        repo: {
          repoRoot: fixtureRoot
        }
      });
      assert.equal(corruptHealth.status.state, "daemon_unavailable");
      assert.equal(corruptHealth.status.failure.category, "daemon_unavailable");
      assert.match(corruptHealth.status.failure.message, /state file .* is invalid/);

      const badProtocol = invoke(sidecar, {
        protocol: "bad.protocol",
        requestId: "bad-protocol",
        schemaVersion: 99,
        operation: "status",
        repo: {
          repoId: "opcore"
        }
      });
      assert.equal(badProtocol.status.state, "schema_mismatch");
      assert.equal(badProtocol.status.expectedSchemaVersion, 1);
      assert.equal(badProtocol.status.actualSchemaVersion, 99);
      assert.equal(badProtocol.status.handshake, undefined);
      assert.equal(badProtocol.result, undefined);

      const missingQuery = invoke(sidecar, {
        protocol: "opcore.graph.daemon",
        requestId: "missing-query",
        schemaVersion: 1,
        operation: "query",
        repo: {
          repoId: "opcore"
        }
      });
      assert.equal(missingQuery.status.state, "schema_mismatch");
      assert.equal(missingQuery.result.status.state, "schema_mismatch");
      assert.equal(missingQuery.result.metadata, undefined);
      assert.equal(missingQuery.result.nodes, undefined);
      assert.equal(missingQuery.result.edges, undefined);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function packWorkspace(packageName, destination) {
  const result = run("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: releasePackageDirForName(packageName)
  });
  const parsed = JSON.parse(result.stdout);
  return join(destination, parsed[0].filename);
}

function skipGeneratedStore(source) {
  const normalized = source.replaceAll("\\", "/");
  return !normalized.endsWith("/.lattice") && !normalized.includes("/.lattice/");
}

function invoke(sidecar, request) {
  const result = run(sidecar, [], {
    input: `${JSON.stringify(request)}\n`,
    expectedStatus: 0
  });
  const line = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  assert.ok(line, "sidecar stdout");
  return JSON.parse(line);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const expectedStatus = options.expectedStatus ?? 0;
  if (result.status !== expectedStatus) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `cwd: ${options.cwd ?? process.cwd()}`,
        `status: ${result.status}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`
      ].join("\n")
    );
  }
  return result;
}
