import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runGraphServeCli } from "../packages/graph/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");
const latticeBin = fileURLToPath(new URL("../packages/opcore/dist/advanced/index.js", import.meta.url));

describe("graph serve stdio transport", () => {
  it("answers opcore graph serve JSONL ping/status/query/search/shutdown", async () => {
    await withBuiltFixture(async (fixtureRoot) => {
      const responses = await serve(latticeBin, ["graph", "serve", "--repo", fixtureRoot], jsonlRequests(fixtureRoot));
      assertJsonlResponses(responses);
    });
  });

  it("answers repeated opcore graph serve JSONL requests", async () => {
    await withBuiltFixture(async (fixtureRoot) => {
      const canonical = await serve(latticeBin, ["graph", "serve", "--repo", fixtureRoot], jsonlRequests(fixtureRoot));
      const repeated = await serve(latticeBin, ["graph", "serve", "--repo", fixtureRoot], jsonlRequests(fixtureRoot));
      assert.deepEqual(canonical.map((response) => response.status.state), repeated.map((response) => response.status.state));
      assert.equal(repeated[2].result.nodes.length, canonical[2].result.nodes.length);
      assert.deepEqual(
        repeated[3].search.results.map((entry) => entry.nodeId),
        canonical[3].search.results.map((entry) => entry.nodeId)
      );
    });
  });

  it("writes one latency telemetry record per forwarded JSONL frame", async () => {
    await withBuiltFixture(async (fixtureRoot) => {
      const requests = jsonlRequests(fixtureRoot);
      const responses = await serve(latticeBin, ["graph", "serve", "--repo", fixtureRoot], requests);
      assertJsonlResponses(responses);

      const records = readLatencyRecords(fixtureRoot);
      assert.equal(records.length, requests.length);
      assert.deepEqual(records.map((record) => record.canonicalCommand), [
        ["opcore", "graph", "serve", "ping"],
        ["opcore", "graph", "serve", "status"],
        ["opcore", "graph", "serve", "query"],
        ["opcore", "graph", "serve", "search"],
        ["opcore", "graph", "serve", "shutdown"]
      ]);
      assert.deepEqual(records.map((record) => record.timing.processState), ["cold", "warm", "warm", "warm", "warm"]);
      assert.equal(records.every((record) => record.bin === "opcore" && record.owner === "graph"), true);
      assert.equal(records.every((record) => record.repo.totalFiles > 0), true);
      assert.equal(records.every((record) => record.timing.durationMs >= 0), true);
      assert.deepEqual(
        records.map((record) => record.timing.phases[0]?.phase),
        ["serve_ping", "serve_status", "serve_query", "serve_search", "serve_shutdown"]
      );
    });
  });

  it("returns typed failures for missing repos, stale stores, schema mismatch, and bad frames", async () => {
    const missingRepo = join(tmpdir(), `lattice-serve-missing-${process.pid}-${Date.now()}`);
    const missing = await serve(latticeBin, ["graph", "serve", "--repo", missingRepo], [
      statusRequest("missing-status", missingRepo),
      shutdownRequest("missing-shutdown", missingRepo)
    ]);
    assert.equal(missing[0].status.state, "required_missing");
    assert.equal(missing[0].status.failure.category, "provider_missing");

    await withBuiltFixture(async (fixtureRoot) => {
      cpSync(join(fixtureRoot, "src/models.ts"), join(fixtureRoot, "src/models-copy.ts"));
      const stale = await serve(latticeBin, ["graph", "serve", "--repo", fixtureRoot], [
        queryRequest("stale-query"),
        shutdownRequest("stale-shutdown", fixtureRoot)
      ]);
      assert.equal(stale[0].status.state, "stale");
      assert.equal(stale[0].result.status.state, "stale");
      assert.equal(stale[0].result.nodes, undefined);
    });

    await withBuiltFixture(async (fixtureRoot) => {
      corruptSnapshotSchema(fixtureRoot);
      const mismatch = await serve(latticeBin, ["graph", "serve", "--repo", fixtureRoot], [
        statusRequest("schema-status", fixtureRoot),
        shutdownRequest("schema-shutdown", fixtureRoot)
      ]);
      assert.equal(mismatch[0].status.state, "schema_mismatch");
      assert.equal(mismatch[0].status.failure.category, "schema_mismatch");
    });

    await withBuiltFixture(async (fixtureRoot) => {
      const bad = await serveRaw(latticeBin, ["graph", "serve", "--repo", fixtureRoot], [
        "{bad json",
        JSON.stringify(shutdownRequest("bad-shutdown", fixtureRoot))
      ]);
      assert.equal(bad.responses[0].status.state, "schema_mismatch");
      assert.equal(bad.responses[1].status.state, "available");
      assert.equal(bad.stderr, "");
      assert.equal(bad.status, 0);
    });
  });

  it("wraps MCP initialize/status/shutdown JSON-RPC frames", async () => {
    await withBuiltFixture(async (fixtureRoot) => {
      const responses = await serveRaw(latticeBin, ["graph", "serve", "--repo", fixtureRoot], [
        JSON.stringify({ jsonrpc: "2.0", id: "init-1", method: "initialize", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: "bad-1", method: "opcore.graph/unknown", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: "status-1", method: "opcore.graph/status", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: "query-1", method: "opcore.graph/query", params: { limit: 2 } }),
        JSON.stringify({ jsonrpc: "2.0", id: "search-1", method: "opcore.graph/search", params: { query: "Greeting", limit: 2 } }),
        JSON.stringify({ jsonrpc: "2.0", id: "shutdown-1", method: "opcore.graph/shutdown", params: {} })
      ]);
      assert.equal(responses.status, 0);
      assert.equal(responses.stderr, "");
      assert.equal(responses.responses.length, 6);
      assert.equal(responses.responses[0].result.serverInfo.name, "opcore-graph");
      assert.equal(responses.responses[1].error.code, -32600);
      assert.equal(responses.responses[1].error.data.status.state, "schema_mismatch");
      assert.equal(responses.responses[2].result.status.state, "available");
      assert.equal(responses.responses[3].result.result.status.state, "available");
      assert.ok(responses.responses[3].result.result.nodes.length > 0);
      assert.equal(responses.responses[4].result.search.status.state, "available");
      assert.ok(responses.responses[4].result.search.results.length > 0);
      assert.equal(responses.responses[5].result.status.state, "available");
    });
  });

  it("supports parallel independent stdio serve sessions as the hot-query replacement boundary", async () => {
    await withBuiltFixture(async (fixtureRoot) => {
      const [left, right] = await Promise.all([
        serve(latticeBin, ["graph", "serve", "--repo", fixtureRoot], jsonlRequests(fixtureRoot)),
        serve(latticeBin, ["graph", "serve", "--repo", fixtureRoot], jsonlRequests(fixtureRoot))
      ]);
      assertJsonlResponses(left);
      assertJsonlResponses(right);
      assert.deepEqual(
        left[3].search.results.map((entry) => entry.nodeId),
        right[3].search.results.map((entry) => entry.nodeId)
      );
    });
  });

  it("returns typed daemon_unavailable for sidecar startup failure", async () => {
    const input = new PassThrough();
    input.end();
    let stdout = "";
    const exitCode = await runGraphServeCli({
      argv: ["serve"],
      bin: "opcore",
      stdin: input,
      stdout: new Writable({
        write(chunk, _encoding, callback) {
          stdout += chunk.toString();
          callback();
        }
      }),
      resolveArtifact: () => ({
        ok: true,
        artifact: {
          artifactName: "opcore-graph-core",
          artifactVersion: "0.1.0-alpha.0",
          targetPlatform: "test",
          binaryPath: "dist/native/test/opcore-graph-core",
          checksumPath: "dist/native/test/opcore-graph-core.sha256",
          checksumSha256: "a".repeat(64),
          buildProfile: "release",
          executablePath: "/missing/opcore-graph-core",
          metadataPath: "dist/native/test/metadata.json"
        }
      }),
      spawnGraphCore: fakeFailingSpawn
    });
    assert.equal(exitCode, 1);
    const response = JSON.parse(stdout);
    assert.equal(response.status.state, "daemon_unavailable");
    assert.equal(response.status.failure.category, "daemon_unavailable");
    assert.match(response.status.failure.message, /spawn denied/);
  });
});

function assertJsonlResponses(responses) {
  assert.equal(responses.length, 5);
  assert.equal(responses[0].requestId, "serve-ping");
  assert.equal(responses[0].status.state, "available");
  assert.equal(responses[1].status.state, "available");
  assert.equal(responses[2].result.status.state, "available");
  assert.ok(responses[2].result.nodes.length > 0);
  assert.equal(responses[3].search.status.state, "available");
  assert.ok(responses[3].search.results.some((entry) => entry.path === "src/components/GreetingCard.tsx"));
  assert.equal(responses[4].requestId, "serve-shutdown");
  assert.equal(responses[4].status.state, "available");
}

function jsonlRequests(repoRoot) {
  return [
    {
      protocol: "opcore.graph.daemon",
      requestId: "serve-ping",
      schemaVersion: 1,
      operation: "ping",
      repo: {
        repoRoot
      }
    },
    statusRequest("serve-status", repoRoot),
    queryRequest("serve-query"),
    {
      protocol: "opcore.graph.daemon",
      requestId: "serve-search",
      schemaVersion: 1,
      operation: "query",
      repo: {
        repoRoot
      },
      search: {
        requestId: "serve-search",
        schemaVersion: 1,
        mode: "required",
        query: "Greeting",
        limit: 5
      }
    },
    shutdownRequest("serve-shutdown", repoRoot)
  ];
}

function statusRequest(requestId, repoRoot) {
  return {
    protocol: "opcore.graph.daemon",
    requestId,
    schemaVersion: 1,
    operation: "status",
    repo: {
      repoRoot
    }
  };
}

function queryRequest(requestId) {
  return {
    protocol: "opcore.graph.daemon",
    requestId,
    schemaVersion: 1,
    operation: "query",
    repo: {},
    query: {
      requestId,
      schemaVersion: 1,
      mode: "required",
      selector: {
        kind: "nodes",
        limit: 3
      }
    }
  };
}

function shutdownRequest(requestId, repoRoot) {
  return {
    protocol: "opcore.graph.daemon",
    requestId,
    schemaVersion: 1,
    operation: "shutdown",
    repo: {
      repoRoot
    }
  };
}

async function serve(script, args, requests) {
  const output = await serveRaw(
    script,
    args,
    requests.map((request) => JSON.stringify(request))
  );
  assert.equal(output.status, 0, output.stdout);
  assert.equal(output.stderr, "");
  return output.responses;
}

function serveRaw(script, args, lines) {
  return new Promise((resolveServe, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serve transport timed out: ${process.execPath} ${[script, ...args].join(" ")}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      const responses = stdout.trim().length === 0 ? [] : stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
      resolveServe({ status, stdout, stderr, responses });
    });
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}

async function withBuiltFixture(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-serve-"));
  const fixtureRoot = join(temp, "wave1");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(latticeBin, ["graph", "build", "--repo", fixtureRoot, "--json"]);
    await runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function corruptSnapshotSchema(repoRoot) {
  const db = new DatabaseSync(join(repoRoot, ".lattice/graph/graph.db"));
  try {
    const metadata = JSON.parse(db.prepare("select value from metadata where key = 'lattice_snapshot_metadata'").get().value);
    metadata.schemaVersion = 2;
    const value = JSON.stringify(metadata);
    db.prepare("update metadata set value = ? where key = 'lattice_snapshot_metadata'").run(value);
    db.prepare("update lattice_store set value = ? where key = 'metadata_json'").run(value);
  } finally {
    db.close();
  }
}

function fakeFailingSpawn() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.unref = () => undefined;
  process.nextTick(() => child.emit("error", new Error("spawn denied")));
  return child;
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${process.execPath} ${[script, ...args].join(" ")}`,
        `status: ${result.status}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`
      ].join("\n")
    );
  }
  return JSON.parse(result.stdout);
}

function readLatencyRecords(repoRoot) {
  const text = readFileSync(join(repoRoot, ".opcore/telemetry.jsonl"), "utf8").trim();
  return text.length === 0 ? [] : text.split(/\r?\n/).map((line) => JSON.parse(line));
}

function skipGeneratedStore(source) {
  const normalized = source.replaceAll("\\", "/");
  return !normalized.endsWith("/.lattice") && !normalized.includes("/.lattice/");
}
