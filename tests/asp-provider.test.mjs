import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const providerBin = join(repoRoot, "packages/asp-provider/dist/index.js");
const forbiddenKeys = new Set(["decision", "verdict", "pass", "authority", "assurance", "transactionGuarantee", "applyReceipt"]);
const allCheckIds = [
  "typescript.syntax",
  "typescript.types",
  "typescript.import-graph",
  "typescript.dead-code",
  "typescript.relevant-tests",
  "rust.source-hygiene",
  "rust.fmt",
  "rust.cargo-check",
  "rust.clippy",
  "rust.rustdoc",
  "rust.import-graph",
  "rust.dead-code",
  "rust.unused-deps",
  "rust.file-length",
  "rust.function-metrics"
];

describe("Opcore ASP provider", () => {
  it("handles initialize/initialized/evaluate over stdio without mutating host files", { timeout: 60000 }, async () => {
    assert.equal(existsSync(providerBin), true, "run npm run build before asp-provider tests");
    const repo = mkdtempSync(join(tmpdir(), "opcore-asp-provider-repo-"));
    try {
      writeFileSync(join(repo, "tsconfig.json"), "{}\n");
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src/modify.ts"), "export const value = 1;\n");
      writeFileSync(join(repo, "src/delete.ts"), "export const deletedValue = 1;\n");
      writeFileSync(join(repo, "src/old-name.ts"), "export const renamedValue = 1;\n");

      const host = createHostWorkspace({
        "tsconfig.json": "{}\n",
        "src/modify.ts": "export const value = 1;\n",
        "src/delete.ts": "export const deletedValue = 1;\n",
        "src/old-name.ts": "export const renamedValue = 1;\n"
      });
      const peer = spawnProvider(host);
      try {
        await assert.rejects(
          () => peer.request("check/evaluate", { callSite: "interactive", changeset: host.changeset([]) }),
          (error) => error.rpc?.code === -32010 && error.rpc.message === "provider-not-initialized"
        );

        const init = await peer.request("initialize", {
          protocolVersion: "asp/0.1",
          host: { name: "fake-host", version: "0.1.0-test" },
          hostCapabilities: { readBlob: true, listTree: true, putBlob: false },
          workspace: { root: repo, baseline: host.baseline },
          assuranceMode: "gated"
        });
        assert.equal(init.serverInfo.name, "opcore");
        assert.deepEqual(init.capabilityFamilies, ["check"]);
        assert.deepEqual(init.capabilities.check.rules, allCheckIds);
        assert.deepEqual(init.capabilities.check.comparisons, ["all"]);
        assert.deepEqual(init.requestedPermissions, { read: ["**/*"], write: false, network: false });
        assertNoForbiddenKeys(init);

        peer.notify("initialized", {
          grantedPermissions: init.requestedPermissions,
          baseline: host.baseline
        });

        const changes = [
          host.modify("src/modify.ts", "export const value = ;\n"),
          host.create("src/create.ts", "export const createdValue = 1;\n"),
          host.delete("src/delete.ts"),
          host.rename("src/old-name.ts", "src/new-name.ts", "export const renamedValue = 2;\n")
        ];
        host.resetReadSet();
        const changeset = host.changeset(changes);
        const changesetDigest = digestJson(changeset);
        const assessment = await peer.request("check/evaluate", {
          callSite: "interactive",
          changeset,
          changesetDigest,
          comparison: "introduced",
          checks: ["typescript.syntax", "typescript.import-graph"]
        });

        assert.equal(assessment.provider.id, "opcore");
        assert.equal(assessment.provider.capabilityFamily, "check");
        assert.equal(assessment.validAsOf.changesetDigest, changesetDigest);
        assert.deepEqual(assessment.validAsOf.baseline, host.baseline);
        assert.deepEqual(assessment.validAsOf.blobs, host.readBlobIds());
        assert.equal(readFileSync(join(repo, "src/modify.ts"), "utf8"), "export const value = 1;\n");
        assert.ok(assessment.diagnostics.some((diagnostic) => diagnostic.source === "opcore"));
        assert.ok(assessment.diagnostics.every((diagnostic) => diagnostic.code.startsWith(`${diagnostic.source}/`)));
        assert.ok(assessment.diagnostics.every((diagnostic) => diagnostic.fingerprint.startsWith("sha256:")));
        assert.ok(assessment.coverage.degraded.some((entry) => entry.reason === "unsupported" && /comparison/.test(entry.requirement)));
        assert.ok(assessment.coverage.degraded.some((entry) => entry.reason === "unavailable" && entry.requirement === "typescript.import-graph"));
        assert.equal(assessment.coverage.exhaustive, false);
        assertNoForbiddenKeys(assessment);
      } finally {
        peer.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ships a provisional install manifest without authority semantics", () => {
    const manifestPath = join(repoRoot, "packages/asp-provider/dist/manifests/opcore-asp-provider.provisional.json");
    assert.equal(existsSync(manifestPath), true, "run npm run build before asp-provider tests");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.providerId, "opcore");
    assert.equal(manifest.packageName, "@the-open-engine/opcore-asp-provider");
    assert.deepEqual(manifest.executable, {
      packageName: "@the-open-engine/opcore-asp-provider",
      bin: "opcore-asp-provider",
      args: ["--stdio"]
    });
    assert.deepEqual(manifest.capabilityFamilies, ["check"]);
    assert.equal(manifest.noAuthority, true);
    assert.equal(manifest.noTrust, true);
    assert.equal(manifest.noGateGrant, true);
    assert.match(manifest.checksums["dist/index.js"].sha256, /^[a-f0-9]{64}$/);
    assertNoForbiddenKeys(manifest);
    assert.doesNotMatch(JSON.stringify(manifest), /\.ace\/runtime|\b(?:rox|crg|cix)\b|LATTICE_CURRENT_TOOLS_DIR/i);
  });

  it("removes stale legacy generated manifests before packaging", () => {
    const manifestDir = join(repoRoot, "packages/asp-provider/dist/manifests");
    const legacyManifestPath = join(manifestDir, ["lattice", "asp", "provider.provisional.json"].join("-"));
    const manifestPath = join(manifestDir, "opcore-asp-provider.provisional.json");
    writeFileSync(legacyManifestPath, "{}\n");

    const result = spawnSync(process.execPath, ["scripts/write-asp-provider-manifest.mjs"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(legacyManifestPath), false);
    assert.equal(existsSync(manifestPath), true);
  });
});

function spawnProvider(host) {
  const child = spawn(process.execPath, [providerBin, "--stdio"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const peer = new TestJsonRpcPeer(child, host).start();
  return peer;
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
    this.child.on("exit", (code, signal) => {
      const error = new Error(`provider exited code=${code} signal=${signal}\nstderr:\n${this.stderr}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
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

  close() {
    this.child.kill();
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

function createHostWorkspace(files) {
  const baseline = { rev: "tree:test-baseline", stampedAt: "2026-06-24T00:00:00.000Z" };
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
    create(path, content) {
      const after = blobIdFor(content);
      blobs.set(after, content);
      return { kind: "create", path, after };
    },
    modify(path, content) {
      const after = blobIdFor(content);
      blobs.set(after, content);
      return { kind: "modify", path, before: entryByPath.get(path).blobId, after };
    },
    delete(path) {
      return { kind: "delete", path, before: entryByPath.get(path).blobId };
    },
    rename(from, path, content) {
      const after = blobIdFor(content);
      blobs.set(after, content);
      return { kind: "rename", from, path, before: entryByPath.get(from).blobId, after };
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
    },
    readBlobIds() {
      return [...readSet].sort();
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

function assertNoForbiddenKeys(value, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenKeys.has(key), false, `${path}.${key}`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}
