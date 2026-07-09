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
  "typescript.lint",
  "typescript.import-graph",
  "typescript.dead-code",
  "typescript.function-metrics",
  "typescript.relevant-tests",
  "typescript.file-length",
  "rust.source-hygiene",
  "rust.fmt",
  "rust.cargo-check",
  "rust.clippy",
  "rust.rustdoc",
  "rust.import-graph",
  "rust.dead-code",
  "rust.graph-signals",
  "rust.unused-deps",
  "rust.file-length",
  "rust.function-metrics",
  "python.syntax",
  "python.source-hygiene",
  "python.types",
  "python.import-graph",
  "python.dead-code",
  "python.relevant-tests",
  "docs.existence",
  "docs.staleness",
  "docs.freshness",
  "docs.length",
  "docs.dry",
  "docs.content-quality",
  "docs.code-blocks",
  "docs.rules-why",
  "docs.hub-coverage",
  "docs.subtree-coverage"
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
      writeFileSync(join(repo, "src/lib.rs"), "pub fn answer() -> i32 { 42 }\n");

      const host = createHostWorkspace({
        "tsconfig.json": "{}\n",
        "src/modify.ts": "export const value = 1;\n",
        "src/delete.ts": "export const deletedValue = 1;\n",
        "src/old-name.ts": "export const renamedValue = 1;\n",
        "src/lib.rs": "pub fn answer() -> i32 { 42 }\n"
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
        assert.equal(Object.hasOwn(init.capabilities, "inspect"), false);
        assert.equal(Object.hasOwn(init.capabilities, "edit"), false);
        assert.equal(Object.hasOwn(init.capabilities, "session"), false);
        assert.deepEqual(init.requestedPermissions, { read: ["**/*"], write: false, network: false });
        assertNoForbiddenKeys(init);

        peer.notify("initialized", {
          grantedPermissions: init.requestedPermissions,
          baseline: host.baseline
        });

        const changes = [
          host.modify("src/modify.ts", "export const value = ;\n"),
          host.modify("src/lib.rs", "pub fn answer() -> i32 { 43 }\n"),
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
          checks: ["typescript.syntax", "typescript.import-graph", "rust.source-hygiene"]
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
        assertCommandTiming(assessment.timing, {
          expectedPhases: [
            "changeset_overlay_mapping",
            "host_workspace_binding",
            "validation",
            "validation_typescript_syntax",
            "validation_rust_source-hygiene"
          ]
        });
        assertNoForbiddenKeys(assessment);
      } finally {
        peer.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("maps TypeScript function metrics diagnostics to their validation check id", { timeout: 60000 }, async () => {
    assert.equal(existsSync(providerBin), true, "run npm run build before asp-provider tests");
    const repo = mkdtempSync(join(tmpdir(), "opcore-asp-provider-function-metrics-"));
    try {
      writeFileSync(join(repo, "tsconfig.json"), "{}\n");
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src/metrics.ts"), "export const ok = 1;\n");

      const host = createHostWorkspace({
        "tsconfig.json": "{}\n",
        "src/metrics.ts": "export const ok = 1;\n"
      });
      const peer = spawnProvider(host);
      try {
        await peer.request("initialize", {
          protocolVersion: "asp/0.1",
          host: { name: "fake-host", version: "0.1.0-test" },
          hostCapabilities: { readBlob: true, listTree: true, putBlob: false },
          workspace: { root: repo, baseline: host.baseline },
          assuranceMode: "gated"
        });
        peer.notify("initialized", {
          grantedPermissions: { read: ["**/*"], write: false, network: false },
          baseline: host.baseline
        });

        const longFunction = [
          "export function tooLong(a: number, b: number, c: number, d: number, e: number) {",
          "  if (a > 0) {",
          "    return a;",
          "  }",
          "  return b + c + d + e;",
          "}"
        ].join("\n");
        const changeset = host.changeset([host.modify("src/metrics.ts", `${longFunction}\n`)]);
        const assessment = await peer.request("check/evaluate", {
          callSite: "interactive",
          changeset,
          comparison: "all",
          checks: ["typescript.function-metrics"]
        });

        const functionMetricDiagnostic = assessment.diagnostics.find((diagnostic) =>
          diagnostic.code.includes("/TS_FUNCTION_PARAMS")
        );
        assert.equal(functionMetricDiagnostic?.source, "opcore");
        assert.equal(functionMetricDiagnostic?.code, "opcore/typescript.function-metrics/TS_FUNCTION_PARAMS");
      } finally {
        peer.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("honors repo validation policy thresholds during check evaluation", { timeout: 60000 }, async () => {
    assert.equal(existsSync(providerBin), true, "run npm run build before asp-provider tests");
    const repo = mkdtempSync(join(tmpdir(), "opcore-asp-provider-policy-"));
    try {
      writeFileSync(join(repo, "tsconfig.json"), "{}\n");
      mkdirSync(join(repo, ".opcore"), { recursive: true });
      mkdirSync(join(repo, "src"));
      writeFileSync(
        join(repo, ".opcore/config"),
        `${JSON.stringify({
          schemaVersion: 1,
          kind: "opcore_init_config",
          validation: {
            checks: {
              typescript: {
                fileLength: {
                  maxFileLines: 2
                }
              }
            }
          }
        })}\n`
      );
      writeFileSync(join(repo, "src/length.ts"), "export const ok = 1;\n");

      const host = createHostWorkspace({
        "tsconfig.json": "{}\n",
        "src/length.ts": "export const ok = 1;\n"
      });
      const peer = spawnProvider(host);
      try {
        await peer.request("initialize", {
          protocolVersion: "asp/0.1",
          host: { name: "fake-host", version: "0.1.0-test" },
          hostCapabilities: { readBlob: true, listTree: true, putBlob: false },
          workspace: { root: repo, baseline: host.baseline },
          assuranceMode: "gated"
        });
        peer.notify("initialized", {
          grantedPermissions: { read: ["**/*"], write: false, network: false },
          baseline: host.baseline
        });

        const changeset = host.changeset([
          host.modify("src/length.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n")
        ]);
        const assessment = await peer.request("check/evaluate", {
          callSite: "interactive",
          changeset,
          comparison: "all",
          checks: ["typescript.file-length"]
        });

        const fileLengthDiagnostic = assessment.diagnostics.find((diagnostic) =>
          diagnostic.code.includes("/TS_FILE_LINES")
        );
        assert.equal(fileLengthDiagnostic?.source, "opcore");
        assert.equal(fileLengthDiagnostic?.code, "opcore/typescript.file-length/TS_FILE_LINES");
        assert.equal(fileLengthDiagnostic?.message, "TypeScript file has 3 lines; max is 2.");
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
    assert.equal(manifest.packageName, "opcore");
    assert.deepEqual(manifest.executable, {
      packageName: "opcore",
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

  it("ships a canonical ASP server manifest with read-only access expectations", () => {
    const manifestPath = join(repoRoot, "packages/asp-provider/dist/manifests/asp-server.json");
    assert.equal(existsSync(manifestPath), true, "run npm run build before asp-provider tests");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const indexSha256 = sha256File(join(repoRoot, "packages/asp-provider/dist/index.js"));

    assertKeys(manifest, [
      "$schema",
      "accessExpectations",
      "artifact",
      "capabilities",
      "entrypoint",
      "manifestVersion",
      "protocolVersions",
      "provenance",
      "server"
    ]);
    assertKeys(manifest.server, ["id", "name", "version"]);
    assertKeys(manifest.entrypoint, ["args", "bin", "transport"]);
    assertKeys(manifest.artifact, ["checksums", "fingerprint"]);
    assertKeys(manifest.artifact.checksums[0], ["path", "sha256"]);
    assertKeys(manifest.provenance, ["license", "publisher", "source"]);
    assertKeys(manifest.accessExpectations, ["dataClasses", "environment", "filesystem", "network", "secrets"]);
    assertKeys(manifest.accessExpectations.filesystem, ["read", "write"]);
    assertKeys(manifest.accessExpectations.network, ["allowlist", "outbound"]);
    assertKeys(manifest.accessExpectations.secrets, ["names"]);
    assertKeys(manifest.accessExpectations.environment, ["inherit", "variables"]);

    assert.equal(manifest.$schema, "https://covibes.dev/asp/schemas/server-manifest.schema.json");
    assert.equal(manifest.manifestVersion, "asp-server/0.1");
    assert.deepEqual(manifest.server, { id: "opcore", name: "Opcore", version: "0.1.0" });
    assert.deepEqual(manifest.protocolVersions, ["asp/0.1"]);
    assert.deepEqual(manifest.capabilities, ["check"]);
    assert.deepEqual(manifest.entrypoint, { transport: "stdio", bin: "opcore-asp-provider", args: ["--stdio"] });
    assert.equal(manifest.artifact.fingerprint, `sha256:${indexSha256}`);
    assert.deepEqual(manifest.artifact.checksums, [{ path: "dist/index.js", sha256: indexSha256 }]);
    assert.match(manifest.artifact.checksums[0].sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(manifest.provenance, {
      publisher: "The Open Engine",
      source: "https://github.com/the-open-engine/opcore",
      license: "MIT"
    });
    assert.deepEqual(manifest.accessExpectations, {
      filesystem: { read: ["**/*"], write: [] },
      network: { outbound: false, allowlist: [] },
      secrets: { names: [] },
      environment: { inherit: false, variables: [] },
      dataClasses: ["source-code"]
    });
    assertNoForbiddenKeys(manifest);
    assert.doesNotMatch(JSON.stringify(manifest.provenance), /\b(?:trust|authority|gate|apply|decision|verdict|assurance)\b/i);
    assert.doesNotMatch(JSON.stringify(manifest), /\.ace\/runtime|\b(?:rox|crg|cix)\b|LATTICE_CURRENT_TOOLS_DIR/i);
  });

  it("removes stale legacy generated manifests before packaging", () => {
    const manifestDir = join(repoRoot, "packages/asp-provider/dist/manifests");
    const legacyManifestPath = join(manifestDir, ["lattice", "asp", "provider.provisional.json"].join("-"));
    const provisionalManifestPath = join(manifestDir, "opcore-asp-provider.provisional.json");
    const canonicalManifestPath = join(manifestDir, "asp-server.json");
    writeFileSync(legacyManifestPath, "{}\n");

    const result = spawnSync(process.execPath, ["scripts/write-asp-provider-manifest.mjs"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(legacyManifestPath), false);
    assert.equal(existsSync(provisionalManifestPath), true);
    assert.equal(existsSync(canonicalManifestPath), true);
  });
});

// #15/#45: claim-scrub gate over the provider README, package.json, and manifest source.
// Reads source files only, so it runs in `npm test` without a prior build. It locks the
// "providers assess, hosts decide" semantics and forbids overclaim phrases that would never
// legitimately appear on the provider surface (host authority, ASP-standard, old-tool
// replacement, security/SAST, all-stack, AI-authorship, automatic-fix, blended score).
describe("Opcore ASP provider claim scrub", () => {
  const readmePath = join(repoRoot, "packages/asp-provider/README.md");
  const packageJsonPath = join(repoRoot, "packages/asp-provider/package.json");
  const manifestSourcePath = join(repoRoot, "packages/asp-provider/src/manifest.ts");

  // package.json description/keywords are pure marketing metadata with no disclaimer prose,
  // so a bare forbidden-token scan there is meaningful (unlike the README, which legitimately
  // names these concepts in order to disclaim them).
  const forbiddenMetadataTokens = [
    /\bstandard\b/i,
    /\bauthority\b/i,
    /\breplaces?\b/i,
    /\bsecurity\b/i,
    /\bSAST\b/i,
    /\bgate\b/i,
    /\ball[- ]stack\b/i,
    /\bblended\b/i,
    /\bAI authorship\b/i
  ];

  it("keeps the providers-assess / hosts-decide semantics in the README", () => {
    const readme = readFileSync(readmePath, "utf8");
    assert.match(readme, /providers assess/i, "README must state that providers assess");
    assert.match(readme, /hosts decide/i, "README must state that hosts decide");
    assert.match(readme, /never (?:makes a policy decision|holds authority)/i, "README must disclaim host authority");
    assert.match(readme, /no ASP router|there is no ASP router/i, "README must disclaim an ASP router command");
    assert.match(readme, /\bwrite\b[^.\n]*\bfalse\b/i, "README must state write is false");
    assert.match(readme, /\bnetwork\b[^.\n]*\bfalse\b/i, "README must state network is false");
    assert.match(readme, /degraded|unsupported/i, "README must describe degraded/unsupported coverage honesty");
    assert.match(readme, /does \*\*not\*\* use ACE|not use ACE as a carrier/i, "README must disclaim ACE as carrier/provisioner");
  });

  it("rejects forbidden marketing tokens in package.json metadata", () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const marketing = [manifest.description ?? "", ...(manifest.keywords ?? [])].join(" ");
    for (const pattern of forbiddenMetadataTokens) {
      assert.doesNotMatch(marketing, pattern, `Forbidden provider marketing token ${pattern} in package.json`);
    }
  });

  it("forbids ASP router command examples in the README", () => {
    const readme = readFileSync(readmePath, "utf8");
    for (const block of readme.match(/```[\s\S]*?```/g) ?? []) {
      assert.doesNotMatch(block, /\b(?:opcore|lattice)\s+asp\b/i, "README code blocks must not show an ASP router command");
    }
  });

  it("keeps no-authority manifest flags in the manifest source", () => {
    const source = readFileSync(manifestSourcePath, "utf8");
    assert.match(source, /noAuthority:\s*true/);
    assert.match(source, /noTrust:\s*true/);
    assert.match(source, /noGateGrant:\s*true/);
    assert.match(source, /write:\s*false/);
    assert.match(source, /network:\s*false/);
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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), expected.sort());
}

function assertCommandTiming(timing, { expectedPhases }) {
  assertKeys(timing, ["durationMs", "phases", "processState"]);
  assert.equal(typeof timing.durationMs, "number");
  assert.ok(timing.durationMs >= 0);
  assert.match(timing.processState, /^(cold|warm)$/);
  assert.equal(Array.isArray(timing.phases), true);
  const phaseIds = new Set(timing.phases.map((phase) => phase.phase));
  for (const expectedPhase of expectedPhases) {
    assert.equal(phaseIds.has(expectedPhase), true, `missing timing phase ${expectedPhase}`);
  }
  for (const phase of timing.phases) {
    assertKeys(phase, phase.fileCount === undefined ? ["durationMs", "phase"] : ["durationMs", "fileCount", "phase"]);
    assert.match(phase.phase, /^[a-z][a-z0-9_-]*$/);
    assert.equal(typeof phase.durationMs, "number");
    assert.ok(phase.durationMs >= 0);
  }
  assert.equal(Object.hasOwn(timing, "startedAt"), false);
  assert.equal(Object.hasOwn(timing, "endedAt"), false);
  assert.equal(Object.hasOwn(timing, "elapsedMs"), false);
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
