import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const opcoreBin = join(repoRoot, "packages/opcore/dist/advanced/index.js");

describe("ASP warm serve stdio transport", () => {
  it("keeps asp serve hidden from public help", assertAspServeHiddenFromPublicHelp);
  it("answers initialize, inspect, edit preview, check, and shutdown without mutating the worktree", { timeout: 60000 }, assertWarmRoundTrip);
  it("includes files created after warmup in rename preview", { timeout: 60000 }, assertRenamePreviewSeesLateFiles);
  it("nests inspect candidates inside failure payloads", { timeout: 60000 }, assertInspectCandidatesStayInsideFailure);
});

function assertAspServeHiddenFromPublicHelp() {
  const help = spawnSync(process.execPath, [opcoreBin, "--help"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /\basp\b/i);
  assert.doesNotMatch(help.stdout, /\bserve\b.*\bASP\b/i);
}

async function assertWarmRoundTrip() {
  assert.equal(existsSync(opcoreBin), true, "run npm run build before asp warm transport tests");
  const fixture = createFixtureRepo();
  const host = createFixtureHost();
  const peer = spawnWarmServer(fixture.repo, host);
  try {
    await initializeWarmPeer(peer, fixture.repo, host);
    await assertWarmInspect(peer);
    const edit = await assertWarmEditPreview(peer, fixture.repo);
    await assertWarmCheck(peer, host, edit, fixture.repo);
    await assertWarmShutdown(peer);
  } finally {
    peer.close();
    rmSync(fixture.repo, { recursive: true, force: true });
  }
}

async function assertRenamePreviewSeesLateFiles() {
  const fixture = createFixtureRepo();
  const host = createFixtureHost();
  const peer = spawnWarmServer(fixture.repo, host);
  try {
    await initializeWarmPeer(peer, fixture.repo, host);
    await assertWarmInspect(peer);
    writeFileSync(join(fixture.repo, "src/late.ts"), "import { greet } from \"./api\";\nexport const late = greet(\"Grace\");\n");
    const edit = await requestWarmRename(peer, "salute");
    assert.ok(edit.editResult.changes.some((change) => change.path === "src/late.ts" && /salute/.test(change.content)));
  } finally {
    peer.close();
    rmSync(fixture.repo, { recursive: true, force: true });
  }
}

async function assertInspectCandidatesStayInsideFailure() {
  const fixture = createFixtureRepo();
  writeFileSync(join(fixture.repo, "src/ambiguous.ts"), "export function sameName() {}\n{\n  const sameName = 1;\n  console.log(sameName);\n}\n");
  const host = createFixtureHost();
  const peer = spawnWarmServer(fixture.repo, host);
  try {
    await initializeWarmPeer(peer, fixture.repo, host);
    const response = await peer.request("inspect/references", {
      path: "src/ambiguous.ts",
      symbolName: "sameName"
    });
    assert.equal(response.inspectResult.status, "error");
    assert.equal(response.inspectResult.failure.category, "target_ambiguous");
    assert.equal(Object.hasOwn(response.inspectResult, "candidates"), false);
    assert.ok(response.inspectResult.failure.candidates.length > 0);
  } finally {
    peer.close();
    rmSync(fixture.repo, { recursive: true, force: true });
  }
}

async function initializeWarmPeer(peer, repo, host) {
  const init = await peer.request("initialize", {
    protocolVersion: "asp/0.1",
    host: { name: "fake-host", version: "0.1.0-test" },
    hostCapabilities: { readBlob: true, listTree: true, putBlob: false },
    workspace: { root: repo, baseline: host.baseline },
    assuranceMode: "gated"
  });
  assert.equal(init.serverInfo.name, "opcore");
  assert.deepEqual(init.capabilityFamilies, ["check", "inspect", "edit", "session"]);
  assert.deepEqual(init.capabilities.check.rules.length > 0, true);
  assert.deepEqual(init.capabilities.inspect.routes, ["references"]);
  assert.deepEqual(init.capabilities.edit.routes, ["rename"]);
  assert.deepEqual(init.requestedPermissions, { read: ["**/*"], write: false, network: false });
  peer.notify("initialized", {
    grantedPermissions: init.requestedPermissions,
    baseline: host.baseline
  });
}

async function assertWarmInspect(peer) {
  const request = { path: "src/api.ts", symbolName: "greet", line: 1, limit: 10 };
  const coldInspect = await peer.request("inspect/references", request);
  const warmInspect = await peer.request("inspect/references", request);
  assert.equal(coldInspect.inspectResult.status, "ok");
  assert.equal(warmInspect.inspectResult.status, "ok");
  assert.equal(coldInspect.timing.processState, "cold");
  assert.equal(warmInspect.timing.processState, "warm");
  assert.ok(warmInspect.timing.durationMs <= coldInspect.timing.durationMs);
  assert.ok(warmInspect.inspectResult.references.some((reference) => reference.file === "src/use.ts"));
}

async function assertWarmEditPreview(peer, repo) {
  const beforeApi = readFileSync(join(repo, "src/api.ts"), "utf8");
  const edit = await requestWarmRename(peer, "salute");
  assert.equal(edit.editResult.status, "preview");
  assert.equal(edit.timing.processState, "warm");
  assert.ok(edit.editResult.changes.some((change) => change.path === "src/api.ts" && /salute/.test(change.content)));
  assert.ok(edit.editResult.changes.some((change) => change.path === "src/use.ts" && /salute/.test(change.content)));
  assert.equal(readFileSync(join(repo, "src/api.ts"), "utf8"), beforeApi);
  return edit;
}

function requestWarmRename(peer, newName) {
  return peer.request("edit/rename", {
    target: { path: "src/api.ts", name: "greet", line: 1 },
    newName
  });
}

async function assertWarmCheck(peer, host, edit, repo) {
  const beforeApi = readFileSync(join(repo, "src/api.ts"), "utf8");
  host.resetReadSet();
  const changeset = host.changesetFromRepoRelativeChanges(edit.editResult.changes);
  const assessment = await peer.request("check/evaluate", {
    callSite: "interactive",
    changeset,
    changesetDigest: digestJson(changeset),
    comparison: "introduced",
    checks: ["typescript.syntax"]
  });
  assert.equal(assessment.provider.id, "opcore");
  assert.equal(assessment.provider.capabilityFamily, "check");
  assert.equal(readFileSync(join(repo, "src/api.ts"), "utf8"), beforeApi);
}

async function assertWarmShutdown(peer) {
  const shutdown = await peer.request("session/shutdown", {});
  assert.equal(shutdown.session.state, "shutdown");
  assert.equal(shutdown.timing.processState, "warm");
  await peer.closed();
}

function spawnWarmServer(repo, host) {
  const child = spawn(process.execPath, [opcoreBin, "asp", "serve", "--stdio", "--repo", repo, "--idle-timeout-ms", "60000"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return new TestJsonRpcPeer(child, host).start();
}

class TestJsonRpcPeer {
  constructor(child, host) {
    this.child = child;
    this.host = host;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
  }

  start() {
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.exit = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        const error = new Error(`warm server exited code=${code} signal=${signal}\nstderr:\n${this.stderr}`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        resolve({ code, signal });
      });
    });
    return this;
  }

  request(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}\nstderr:\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async closed() {
    const exit = await this.exit;
    assert.equal(exit.code, 0, this.stderr);
  }

  close() {
    if (!this.child.killed) this.child.kill();
  }

  onData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.handleMessage(JSON.parse(line));
    }
  }

  handleMessage(message) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message);
        error.rpc = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "workspace/listTree") {
      this.write({ jsonrpc: "2.0", id: message.id, result: this.host.listTree(message.params) });
      return;
    }
    if (message.method === "workspace/readBlob") {
      this.write({ jsonrpc: "2.0", id: message.id, result: this.host.readBlob(message.params) });
      return;
    }
    this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method-not-found" } });
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function createFixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "opcore-asp-warm-transport-"));
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/api.ts"), "export function greet(name: string) {\n  return `hello ${name}`;\n}\n");
  writeFileSync(join(repo, "src/use.ts"), "import { greet } from \"./api\";\nexport const message = greet(\"Ada\");\n");
  return { repo };
}

function createFixtureHost() {
  return createHostWorkspace({
    "tsconfig.json": "{}\n",
    "src/api.ts": "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
    "src/use.ts": "import { greet } from \"./api\";\nexport const message = greet(\"Ada\");\n"
  });
}

function createHostWorkspace(files) {
  const baseline = { rev: "tree:test-baseline", stampedAt: "2026-06-28T00:00:00.000Z" };
  const blobs = new Map();
  const entries = Object.entries(files).map(([path, content]) => {
    const blobId = blobIdFor(content);
    blobs.set(blobId, content);
    return { path, blobId, kind: "file" };
  });
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const readSet = new Set();
  return {
    baseline,
    changeset: (changes) => ({ baseline, changes }),
    changesetFromRepoRelativeChanges(changes) {
      return {
        baseline,
        changes: changes.map((change) => {
          if (change.kind !== "replace") throw new Error(`unsupported test change kind: ${change.kind}`);
          const after = blobIdFor(change.content);
          blobs.set(after, change.content);
          return { kind: "modify", path: change.path, before: entryByPath.get(change.path).blobId, after };
        })
      };
    },
    listTree(params = {}) {
      const paths = new Set(Array.isArray(params.paths) ? params.paths : []);
      return {
        entries: entries.filter((entry) => paths.size === 0 || paths.has(entry.path)),
        truncated: false
      };
    },
    readBlob(params = {}) {
      const requested = Array.isArray(params.blobs) ? params.blobs : [];
      return {
        blobs: requested.map((id) => {
          if (!blobs.has(id)) throw new Error(`missing blob ${id}`);
          readSet.add(id);
          return { id, encoding: "utf-8", bytes: blobs.get(id) };
        })
      };
    },
    resetReadSet() {
      readSet.clear();
    }
  };
}

function blobIdFor(content) {
  return `blob:sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function digestJson(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}
