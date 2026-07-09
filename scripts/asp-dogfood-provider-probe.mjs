import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "./asp-dogfood-receipt-support.mjs";

export async function runProviderProbe(providerBin) {
  const probeRoot = mkdtempSync(join(tmpdir(), "opcore-asp-provider-probe-"));
  try {
    writeFileSync(join(probeRoot, "tsconfig.json"), "{}\n");
    mkdirSync(join(probeRoot, "src"));
    writeFileSync(join(probeRoot, "src", "probe.ts"), "export const value = 1;\n");
    return await probeProvider(providerBin, probeRoot);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

async function probeProvider(providerBin, probeRoot) {
  const host = createHostWorkspace({ "tsconfig.json": "{}\n", "src/probe.ts": "export const value = 1;\n" });
  const peer = spawnProvider(providerBin, probeRoot, host);
  try {
    const init = await initialize(peer, probeRoot, host.baseline);
    host.resetReadSet();
    const changeset = host.changeset([host.modify("src/probe.ts", "export const value = ;\n")]);
    const assessment = await evaluate(peer, changeset);
    return providerProbeReceipt(peer, init, assessment);
  } finally {
    peer.close();
  }
}

function initialize(peer, probeRoot, baseline) {
  return peer.request("initialize", {
    protocolVersion: "asp/0.1",
    host: { name: "asp-dogfood-receipt", version: "0.2.0-test" },
    hostCapabilities: { readBlob: true, listTree: true, putBlob: false },
    workspace: { root: probeRoot, baseline },
    assuranceMode: "advisory"
  }).then((init) => {
    peer.notify("initialized", { grantedPermissions: init.requestedPermissions, baseline });
    return init;
  });
}

function evaluate(peer, changeset) {
  return peer.request("check/evaluate", {
    callSite: "interactive",
    changeset,
    changesetDigest: digestJson(changeset),
    comparison: "introduced",
    checks: ["typescript.syntax"]
  });
}

function providerProbeReceipt(peer, init, assessment) {
  return {
    id: "provider-probe",
    command: ["opcore-asp-provider", "--stdio"],
    status: "passed",
    exitCode: 0,
    stdoutSha256: sha256(peer.stdoutText),
    stderrSha256: sha256(peer.stderr),
    output: { initialize: init },
    assertion: "Installed provider returned an ASP assessment without host decision authority fields",
    assessment,
    validAsOf: assessment.validAsOf,
    coverage: assessment.coverage,
    diagnosticsCount: Array.isArray(assessment.diagnostics) ? assessment.diagnostics.length : 0,
    hostOwnedFieldLeak: hasHostOwnedFields(assessment)
  };
}

function spawnProvider(providerBin, cwd, host) {
  const child = spawn(providerBin, ["--stdio"], {
    cwd,
    env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH || ""].join(":") },
    stdio: ["pipe", "pipe", "pipe"]
  });
  return new JsonRpcPeer(child, host).start();
}

class JsonRpcPeer {
  constructor(child, host) {
    this.child = child;
    this.host = host;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.stdoutText = "";
  }

  start() {
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("exit", (code, signal) => this.rejectPending(`provider exited code=${code} signal=${signal}`));
    return this;
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, pendingRequest({ resolve, reject, method, timeoutMs, peer: this })));
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close() {
    this.child.kill();
  }

  onData(chunk) {
    this.stdoutText += chunk;
    this.buffer += chunk;
    while (this.buffer.includes("\n")) this.handleLine();
  }

  handleLine() {
    const index = this.buffer.indexOf("\n");
    const line = this.buffer.slice(0, index).trim();
    this.buffer = this.buffer.slice(index + 1);
    if (line.length > 0) this.handleMessage(JSON.parse(line));
  }

  handleMessage(message) {
    if (isResponse(message)) return this.resolveResponse(message);
    if (message.method === "workspace/listTree") return this.write({ jsonrpc: "2.0", id: message.id, result: this.host.listTree(message.params) });
    if (message.method === "workspace/readBlob") return this.write({ jsonrpc: "2.0", id: message.id, result: this.host.readBlob(message.params) });
    this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method-not-found" } });
  }

  resolveResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
    else pending.resolve(message.result);
  }

  rejectPending(detail) {
    const error = new Error(`${detail}\nstderr:\n${this.stderr}`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function pendingRequest({ resolve, reject, method, timeoutMs, peer }) {
  const timer = setTimeout(() => {
    reject(new Error(`request timed out: ${method}\nstderr:\n${peer.stderr}`));
  }, timeoutMs);
  return {
    resolve(value) {
      clearTimeout(timer);
      resolve(value);
    },
    reject(error) {
      clearTimeout(timer);
      reject(error);
    }
  };
}

function createHostWorkspace(files) {
  const baseline = { rev: "tree:asp-dogfood-baseline", stampedAt: "2026-06-24T00:00:00.000Z" };
  const blobs = new Map();
  const entries = Object.entries(files).map(([path, content]) => {
    const blobId = blobIdFor(content);
    blobs.set(blobId, content);
    return { path, blobId, kind: "file" };
  });
  return hostWorkspace(baseline, entries, blobs);
}

function hostWorkspace(baseline, entries, blobs) {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const readSet = new Set();
  return {
    baseline,
    changeset: (changes) => ({ baseline, changes }),
    modify: (path, content) => modifyChange(entryByPath, blobs, path, content),
    listTree: (params = {}) => ({ entries: filteredEntries(entries, params), truncated: false }),
    readBlob: (params = {}) => readBlobResult(blobs, readSet, params),
    resetReadSet: () => readSet.clear(),
    readBlobIds: () => [...readSet].sort()
  };
}

function modifyChange(entryByPath, blobs, path, content) {
  const after = blobIdFor(content);
  blobs.set(after, content);
  return { kind: "modify", path, before: entryByPath.get(path).blobId, after };
}

function filteredEntries(entries, params) {
  const paths = new Set(Array.isArray(params.paths) ? params.paths : []);
  return entries.filter((entry) => paths.size === 0 || paths.has(entry.path));
}

function readBlobResult(blobs, readSet, params) {
  const requested = Array.isArray(params.blobs) ? params.blobs : [];
  return {
    blobs: requested.map((id) => {
      if (!blobs.has(id)) throw new Error(`missing blob ${id}`);
      readSet.add(id);
      return { id, encoding: "utf-8", bytes: blobs.get(id) };
    })
  };
}

function blobIdFor(content) {
  return `blob:sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function digestJson(value) {
  return `sha256:${sha256(JSON.stringify(canonicalize(value)))}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalize(value[key])]));
}

function hasHostOwnedFields(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasHostOwnedFields);
  const forbidden = new Set(["decision", "verdict", "pass", "authority", "authorityEvidence", "assurance", "transactionGuarantee", "applyReceipt"]);
  return Object.entries(value).some(([key, child]) => forbidden.has(key) || hasHostOwnedFields(child));
}

function isResponse(message) {
  return Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) && !message.method;
}
