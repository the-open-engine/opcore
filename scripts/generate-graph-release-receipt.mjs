#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets,
  graphReleaseBenchmarkMetrics,
  graphReleaseCoreCommandIds,
  graphReleaseDeferredChildren,
  graphReleaseDirectSqliteQueryIds,
  graphReleaseHandoffIssues,
  graphReleaseOptionalAnalysisSurfaces,
  graphReleaseRustCommandIds,
  validateGraphReleaseReceipt
} from "../packages/contracts/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const latticeBin = join(repoRoot, "packages/opcore/dist/lattice/index.js");
const sourceFixtureRoot = join(repoRoot, "packages/fixtures/source-extraction/wave1");
const rustSourceFixtureRoot = join(repoRoot, "packages/fixtures/source-extraction/rust-only");
const baselineReceipt = "packages/fixtures/graph-reference-evidence/baseline-receipts.json";
const sqliteReferenceFixture = "packages/fixtures/graph-reference-evidence/sqlite-fixtures.json";
const graphPackageRoot = join(repoRoot, "packages/graph");
const receiptPath = "docs/release/graph-release-receipt.json";
const handoffReceiptPath = "docs/release/graph-release-receipt.payload.json";
const handoffPath = "docs/release/graph-release-handoff.md";

const args = new Set(process.argv.slice(2));
const writeDocs = args.has("--write");
const jsonOutput = args.has("--json") || !writeDocs;
const inspectPackageOnly = args.has("--inspect-package-only");

const tempRoot = mkdtempSync(join(tmpdir(), "lattice-graph-release-"));
try {
  if (inspectPackageOnly) {
    const inspection = inspectGraphPackage();
    if (jsonOutput) process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    else process.stdout.write("graph package inspection passed\n");
  } else {
    const receipt = await generateReceipt(tempRoot);
    const validated = validateGraphReleaseReceipt(receipt);
    if (writeDocs) writeReleaseDocs(validated);
    if (jsonOutput) process.stdout.write(`${JSON.stringify(validated, null, 2)}\n`);
    else process.stdout.write(`graph release receipt written to ${receiptPath}\n`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

async function generateReceipt(tempRoot) {
  const { fixtureRoot, installSetupMs } = prepareReleaseFixture(tempRoot);
  const rustFixtureRoot = prepareRustReleaseFixture(tempRoot);
  const coverage = runCommandCoverage(fixtureRoot);
  const rustCoverage = runRustCommandCoverage(rustFixtureRoot);
  const serveEvidence = await collectServeEvidence(fixtureRoot);
  const baseReceipt = assembleBaseReceipt({
    fixtureRoot,
    installSetupMs,
    coverage,
    rustCoverage,
    serveEvidence
  });
  return withHandoff(baseReceipt, checksumJson(baseReceipt));
}

function prepareReleaseFixture(tempRoot) {
  const fixtureRoot = join(tempRoot, "wave1");
  const setupStart = performance.now();
  cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
  return { fixtureRoot, installSetupMs: elapsed(setupStart) };
}

function prepareRustReleaseFixture(tempRoot) {
  const fixtureRoot = join(tempRoot, "rust");
  cpSync(rustSourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
  return fixtureRoot;
}

function runCommandCoverage(fixtureRoot) {
  const commandCoverage = [];
  const build = runBuildCoverage(fixtureRoot, commandCoverage);
  const update = runUpdateCoverage(fixtureRoot, commandCoverage);
  const basicReads = runBasicReadCoverage(fixtureRoot, commandCoverage);
  const impact = runImpactCoverage(fixtureRoot, commandCoverage);
  const search = runSearchCoverage(fixtureRoot, commandCoverage);
  runServeCommandCoverage(fixtureRoot, commandCoverage);
  sortCommandCoverage(commandCoverage);
  return {
    commandCoverage,
    coldBuildMs: build.durationMs,
    incrementalUpdateMs: update.durationMs,
    impactColdMs: impact.cold.durationMs,
    impactHotMs: impact.hot.durationMs,
    searchMs: search.durationMs,
    walSizeBytes: walSizeBytesFromGraphCore([build, update, basicReads.watch])
  };
}

function runRustCommandCoverage(fixtureRoot) {
  const commandCoverage = [];
  const build = recordCoverage(commandCoverage, "lattice-graph-rust-build", latticeBin, [
    "graph",
    "build",
    "--repo",
    fixtureRoot,
    "--json"
  ], "packages/fixtures/source-extraction/rust-only");
  writeFileSync(join(fixtureRoot, "src/helpers.rs"), "pub fn assist() -> usize { 2 }\n");
  recordCoverage(commandCoverage, "lattice-graph-rust-update", latticeBin, [
    "graph",
    "update",
    "--repo",
    fixtureRoot,
    "--base",
    "HEAD",
    "--json"
  ], "packages/fixtures/source-extraction/rust-only");
  recordCoverage(commandCoverage, "lattice-graph-rust-watch", latticeBin, [
    "graph",
    "watch",
    "--repo",
    fixtureRoot,
    "--once",
    "--poll-interval-ms",
    "50",
    "--json"
  ], "packages/fixtures/source-extraction/rust-only");
  recordCoverage(commandCoverage, "lattice-graph-rust-status", latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"], "packages/fixtures/source-extraction/rust-only");
  const query = recordCoverage(commandCoverage, "lattice-graph-rust-query", latticeBin, ["graph", "query", "--repo", fixtureRoot, "--json"], "packages/fixtures/source-extraction/rust-only");
  const impact = recordCoverage(commandCoverage, "lattice-graph-rust-impact", latticeBin, [
    "graph",
    "impact",
    "--repo",
    fixtureRoot,
    "--files",
    "src/helpers.rs",
    "--json"
  ], "packages/fixtures/source-extraction/rust-only");
  const search = recordCoverage(commandCoverage, "lattice-graph-rust-search", latticeBin, [
    "graph",
    "search",
    "Widget",
    "--repo",
    fixtureRoot,
    "--limit",
    "5",
    "--json"
  ], "packages/fixtures/source-extraction/rust-only");
  recordCoverage(commandCoverage, "lattice-graph-rust-serve", latticeBin, ["graph", "serve", "--repo", fixtureRoot, "--json"], "packages/fixtures/source-extraction/rust-only");
  assertRustGraphEvidence({ build, query, impact, search });
  sortRustCommandCoverage(commandCoverage);
  return commandCoverage;
}

function runBuildCoverage(fixtureRoot, commandCoverage) {
  const build = recordCoverage(commandCoverage, "lattice-graph-build", latticeBin, [
    "graph",
    "build",
    "--repo",
    fixtureRoot,
    "--json"
  ]);
  return build;
}

function runUpdateCoverage(fixtureRoot, commandCoverage) {
  writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 7; }\n");
  const update = recordCoverage(commandCoverage, "lattice-graph-update", latticeBin, [
    "graph",
    "update",
    "--repo",
    fixtureRoot,
    "--base",
    "HEAD",
    "--json"
  ]);
  return update;
}

function runBasicReadCoverage(fixtureRoot, commandCoverage) {
  const watchArgs = ["graph", "watch", "--repo", fixtureRoot, "--once", "--poll-interval-ms", "50", "--json"];
  const watch = recordCoverage(commandCoverage, "lattice-graph-watch", latticeBin, watchArgs);
  recordCoverage(commandCoverage, "lattice-graph-status", latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"]);
  recordCoverage(commandCoverage, "lattice-graph-query", latticeBin, ["graph", "query", "--repo", fixtureRoot, "--json"]);
  return { watch };
}

function runImpactCoverage(fixtureRoot, commandCoverage) {
  const cold = recordCoverage(commandCoverage, "lattice-graph-impact", latticeBin, [
    "graph",
    "impact",
    "--repo",
    fixtureRoot,
    "--files",
    "src/models.ts",
    "--json"
  ]);
  const hot = runCovered("lattice-graph-impact", latticeBin, [
    "graph",
    "impact",
    "--repo",
    fixtureRoot,
    "--files",
    "src/models.ts",
    "--json"
  ]);
  return { cold, hot };
}

function runSearchCoverage(fixtureRoot, commandCoverage) {
  const search = recordCoverage(commandCoverage, "lattice-graph-search", latticeBin, [
    "graph",
    "search",
    "Greeting",
    "--repo",
    fixtureRoot,
    "--limit",
    "5",
    "--json"
  ]);
  return search;
}

function runServeCommandCoverage(fixtureRoot, commandCoverage) {
  recordCoverage(commandCoverage, "lattice-graph-serve", latticeBin, ["graph", "serve", "--repo", fixtureRoot, "--json"]);
}

async function collectServeEvidence(fixtureRoot) {
  const serveStart = performance.now();
  const serveTransport = await runServeTransport(fixtureRoot);
  const daemonStartupMs = elapsed(serveStart);
  const daemonQueryMs = Math.max(1, Math.round(requireServeTransportDuration(serveTransport, "serve-jsonl-query")));
  const serveReceipts = serveTransport.map(({ durationMs, ...entry }) => entry);
  return { serveReceipts, daemonStartupMs, daemonQueryMs };
}

function requireServeTransportDuration(serveTransport, id) {
  const receipt = serveTransport.find((entry) => entry.id === id);
  if (!receipt) throw new Error(`Missing graph serve transport receipt: ${id}`);
  if (typeof receipt.durationMs !== "number" || receipt.durationMs <= 0) {
    throw new Error(`Invalid graph serve transport duration for ${id}: ${String(receipt.durationMs)}`);
  }
  return receipt.durationMs;
}

function assembleBaseReceipt({ fixtureRoot, installSetupMs, coverage, rustCoverage, serveEvidence }) {
  const directSqliteQueries = runDirectSqliteQueries(fixtureRoot);
  const dbPath = join(realpathSync(fixtureRoot), ".lattice/graph/graph.db");
  return {
    schemaVersion: 1,
    issue: "#17",
    origin: "covibes-authored-synthetic",
    generatedAt: new Date().toISOString(),
    commitSha: git(["rev-parse", "HEAD"]).trim(),
    graphPackageVersions: graphPackageVersions(),
    graphProviderSchemaVersion: 1,
    requiredChildren: ["#35", "#8", "#9", "#10", "#11", "#12", "#19", "#47"],
    deferredChildren: graphReleaseDeferredChildren,
    commandCoverage: coverage.commandCoverage,
    rustCommandCoverage: rustCoverage,
    directSqliteQueries,
    serveTransport: serveEvidence.serveReceipts,
    benchmarks: benchmarkReceipts({
      installSetupMs,
      coldBuildMs: coverage.coldBuildMs,
      incrementalUpdateMs: coverage.incrementalUpdateMs,
      impactColdMs: coverage.impactColdMs,
      impactHotMs: coverage.impactHotMs,
      searchMs: coverage.searchMs,
      daemonStartupMs: serveEvidence.daemonStartupMs,
      daemonQueryMs: serveEvidence.daemonQueryMs,
      dbSizeBytes: fileSize(dbPath),
      walSizeBytes: coverage.walSizeBytes
    }),
    packageInspection: inspectGraphPackage(),
    supportedNativeTargets: graphCoreNativeSupportedTargets,
    nativeArtifacts: collectGraphReleaseNativeArtifacts(),
    reportReceipts: graphReleaseReportReceipts(),
    graphArtifact: readGraphArtifactMetadata(),
    optionalSurfaces: graphReleaseOptionalAnalysisSurfaces
  };
}

function recordCoverage(commandCoverage, id, script, args, fixture = "packages/fixtures/source-extraction/wave1") {
  const result = runCovered(id, script, args, fixture);
  commandCoverage.push(result.coverage);
  return result;
}

function graphReleaseReportReceipts() {
  return [
    runReport("conformance", ["npm", "run", "conformance:check"], "docs/release/graph-release-receipt.json"),
    runReport("pack", ["npm", "run", "pack:check"], "docs/release/graph-release-receipt.json"),
    runReport("license", ["npm", "run", "license:report"], "docs/release/license-report.md"),
    runReport("provenance", ["npm", "run", "provenance:check"], "docs/release/provenance-receipts.md")
  ];
}

function runCovered(id, script, args, fixture = "packages/fixtures/source-extraction/wave1") {
  const start = performance.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const durationMs = elapsed(start);
  if (result.status !== 0) failCommand(process.execPath, [script, ...args], result);
  const parsed = JSON.parse(result.stdout);
  if (parsed.status !== "ok" || parsed.exitCode !== 0) {
    throw new Error(`Graph release command ${id} did not pass:\n${JSON.stringify(parsed, null, 2)}`);
  }
  return {
    durationMs,
    parsed: releaseReceiptCommandOutput(parsed),
    coverage: {
      id,
      bin: "lattice",
      command: receiptCommandForId(id),
      canonicalCommand: canonicalCommandForId(id),
      status: "passed",
      exitCode: parsed.exitCode,
      fixture,
      durationMs
    }
  };
}

function releaseReceiptCommandOutput(parsed) {
  if (process.env.LATTICE_GRAPH_RELEASE_TEST_DROP_WAL_EVIDENCE !== "1") return parsed;
  const clone = JSON.parse(JSON.stringify(parsed));
  if (clone.graphPipeline?.summary) delete clone.graphPipeline.summary.walCheckpoint;
  if (clone.graphPipeline?.status) delete clone.graphPipeline.status.walCheckpoint;
  if (clone.providerStatus) delete clone.providerStatus.walCheckpoint;
  return clone;
}

function walSizeBytesFromGraphCore(results) {
  const missingStatusEvidence = results.find(
    (result) => result.parsed?.providerStatus?.state === "available" && !result.parsed.providerStatus.walCheckpoint
  );
  if (missingStatusEvidence) {
    throw new Error(`Missing graph-core WAL checkpoint evidence: missing status walCheckpoint for ${missingStatusEvidence.coverage.id}`);
  }
  const checkpoints = results
    .flatMap((result) => [
      result.parsed?.graphPipeline?.summary?.walCheckpoint,
      result.parsed?.graphPipeline?.status?.walCheckpoint,
      result.parsed?.providerStatus?.walCheckpoint
    ])
    .filter(Boolean);
  if (checkpoints.length === 0) {
    throw new Error("Missing graph-core WAL checkpoint evidence for graph release benchmark");
  }
  const maxBytes = checkpoints.reduce((maxBytes, checkpoint) => Math.max(maxBytes, validateWalCheckpoint(checkpoint)), 0);
  if (maxBytes <= 0) throw new Error("Graph-core WAL checkpoint evidence recorded no WAL bytes");
  return maxBytes;
}

function validateWalCheckpoint(checkpoint) {
  if (typeof checkpoint.walPath !== "string" || checkpoint.walPath.length === 0) {
    throw new Error("Graph-core WAL checkpoint evidence missing walPath");
  }
  if (typeof checkpoint.checkpointed !== "boolean") {
    throw new Error("Graph-core WAL checkpoint evidence missing checkpointed flag");
  }
  return Math.max(validateWalBytes(checkpoint, "bytesBefore"), validateWalBytes(checkpoint, "bytesAfter"));
}

function validateWalBytes(checkpoint, key) {
  const value = checkpoint[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Graph-core WAL checkpoint ${key} must be a non-negative number`);
  }
  return value;
}

function runDirectSqliteQueries(fixtureRoot) {
  const dbPath = join(realpathSync(fixtureRoot), ".lattice/graph/graph.db");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, sqliteReferenceFixture), "utf8"));
    const queries = manifest.directReaderQueries ?? [];
    const ids = queries.map((entry) => entry.id);
    if (ids.join("\0") !== graphReleaseDirectSqliteQueryIds.join("\0")) {
      throw new Error(`#19 direct-reader query ids changed: ${ids.join(", ")}`);
    }
    return queries.map((entry) => {
      const rows = db.prepare(entry.sql).all(...directSqliteParams(entry.id, fixtureRoot));
      if (rows.length === 0) throw new Error(`#19 direct-reader query returned no rows: ${entry.id}`);
      return {
        id: entry.id,
        query: entry.sql,
        status: "passed",
        rowCount: rows.length,
        fixture: "packages/fixtures/source-extraction/wave1/.lattice/graph/graph.db"
      };
    });
  } finally {
    db.close();
  }
}

function directSqliteParams(id, fixtureRoot) {
  if (id === "impact-edges-from-file") return [join(realpathSync(fixtureRoot), "src/models.ts")];
  if (id === "search-by-name") return ["%Greeting%", 5];
  return [];
}

function runServeTransport(fixtureRoot) {
  return new Promise((resolveServe, reject) => {
    const state = createServeTransportState(fixtureRoot, reject);
    attachServeTransportListeners(state, resolveServe, reject);
    sendServeTransportRequests(state);
  });
}

function createServeTransportState(fixtureRoot, reject) {
  const requests = serveRequests(fixtureRoot);
  const state = {
    requests,
    startById: new Map(requests.map((request) => [request.requestId, performance.now()])),
    child: spawn(process.execPath, [latticeBin, "graph", "serve", "--repo", fixtureRoot], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    }),
    stdout: "",
    stderr: "",
    responses: [],
    timer: undefined
  };
  state.timer = setTimeout(() => {
    state.child.kill("SIGTERM");
    reject(new Error(`graph serve timed out\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`));
  }, 10000);
  return state;
}

function attachServeTransportListeners(state, resolveServe, reject) {
  state.child.stdout.on("data", (chunk) => {
    readServeStdout(state, chunk);
  });
  state.child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString("utf8");
  });
  state.child.on("error", reject);
  state.child.on("close", (status) => {
    finishServeTransport(state, status, resolveServe, reject);
  });
}

function readServeStdout(state, chunk) {
  state.stdout += chunk.toString("utf8");
  for (;;) {
    const newline = state.stdout.indexOf("\n");
    if (newline === -1) break;
    const line = state.stdout.slice(0, newline).trim();
    state.stdout = state.stdout.slice(newline + 1);
    if (line) state.responses.push(JSON.parse(line));
  }
}

function finishServeTransport(state, status, resolveServe, reject) {
  clearTimeout(state.timer);
  if (status !== 0) {
    reject(new Error(`graph serve exited ${status}\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`));
    return;
  }
  resolveServe(state.responses.map((response) => serveResponseReceipt(response, state.startById)));
}

function serveResponseReceipt(response, startById) {
  const operation = requestOperation(response.requestId);
  const ok =
    response.status?.state === "available" ||
    response.result?.status?.state === "available" ||
    response.search?.status?.state === "available";
  if (!ok) throw new Error(`graph serve response failed:\n${JSON.stringify(response, null, 2)}`);
  return {
    id: `serve-jsonl-${operation}`,
    protocol: "lattice.graph.daemon",
    operation,
    status: "passed",
    exitCode: 0,
    durationMs: Math.max(1, Math.round(performance.now() - (startById.get(response.requestId) ?? performance.now())))
  };
}

function sendServeTransportRequests(state) {
  for (const request of state.requests) state.child.stdin.write(`${JSON.stringify(request)}\n`);
  state.child.stdin.end();
}

function serveRequests(fixtureRoot) {
  const repo = { repoRoot: fixtureRoot };
  return [
    serveRequest(repo, "serve-ping", "ping"),
    serveRequest(repo, "serve-status", "status"),
    serveRequest(repo, "serve-query", "query", { query: serveQueryEnvelope(repo) }),
    serveRequest(repo, "serve-search", "query", { search: serveSearchEnvelope(repo) }),
    serveRequest(repo, "serve-shutdown", "shutdown")
  ];
}

function serveRequest(repo, requestId, operation, extra = {}) {
  return {
    protocol: "lattice.graph.daemon",
    requestId,
    schemaVersion: 1,
    operation,
    repo,
    ...extra
  };
}

function serveQueryEnvelope(repo) {
  return {
    requestId: "serve-query",
    repo,
    schemaVersion: 1,
    mode: "required",
    selector: { kind: "nodes", nodeKinds: ["File"], limit: 2 }
  };
}

function serveSearchEnvelope(repo) {
  return {
    requestId: "serve-search",
    repo,
    schemaVersion: 1,
    mode: "required",
    query: "Greeting",
    limit: 2
  };
}

function inspectGraphPackage() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--workspace", "@the-open-engine/opcore-graph"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) failCommand("npm", ["pack", "--dry-run", "--json", "--workspace", "@the-open-engine/opcore-graph"], result);
  const parsed = JSON.parse(result.stdout);
  const files = parsed[0]?.files?.map((entry) => entry.path).sort() ?? [];
  const pathFindings = scanGraphPackagePaths(files);
  if (pathFindings.length > 0) {
    throw new Error(`Graph package dry-run file path contains forbidden marker:\n${pathFindings.join("\n")}`);
  }
  const contentFindings = scanGraphPackageFileContents(files);
  if (contentFindings.length > 0) {
    throw new Error(`Graph package file content contains forbidden marker:\n${contentFindings.join("\n")}`);
  }
  return {
    packageName: "@the-open-engine/opcore-graph",
    tarballName: parsed[0]?.filename ?? "covibes-lattice-graph-0.1.0-alpha.0.tgz",
    fileCount: files.length,
    files,
    forbiddenMarkersAbsent: true,
    generatedBuildMetadataAbsent: true,
    privatePathsAbsent: true,
    pythonCrgSourceAbsent: true,
    pythonGraphPackageMetadataAbsent: true,
    pythonCrgGitHistoryAbsent: true,
    forbiddenImplementationPackageNamesAbsent: true,
    inspections: ["npm-pack-dry-run", "package-file-scan", "package-content-scan", "provenance-marker-scan"]
  };
}

function scanGraphPackagePaths(files) {
  const findings = [];
  for (const file of files) {
    const entry = file.split("/").at(-1);
    if (["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"].includes(entry)) {
      findings.push(`${file}: python package metadata path`);
    }
    if (/(^|\/)\.git(\/|$)/i.test(file)) findings.push(`${file}: git history path`);
    if (/code-review-graph|gungnir/i.test(file)) findings.push(`${file}: forbidden implementation package path`);
    if (/\.tsbuildinfo$/i.test(file)) findings.push(`${file}: generated build metadata path`);
  }
  return findings;
}

function scanGraphPackageFileContents(files) {
  const findings = [];
  for (const file of files) {
    const absolutePath = resolvePackagedGraphFile(file);
    const content = readFileSync(absolutePath);
    const text = content.toString("utf8");
    for (const marker of graphPackageForbiddenContentMarkers()) {
      if (marker.pattern.test(text)) findings.push(`${file}: ${marker.label}`);
    }
    findings.push(...inspectPackagedGraphArtifactMetadata(file, text));
  }
  return findings;
}

function resolvePackagedGraphFile(file) {
  const absolutePath = resolve(graphPackageRoot, file);
  if (!absolutePath.startsWith(`${graphPackageRoot}/`)) throw new Error(`Graph package dry-run file escapes package root: ${file}`);
  if (!existsSync(absolutePath)) throw new Error(`Graph package dry-run file missing on disk: ${file}`);
  return absolutePath;
}

function graphPackageForbiddenContentMarkers() {
  return [
    { label: "python CRG source author", pattern: /tirth8205|Tirth Kanani/i },
    { label: "python package metadata", pattern: /(^|[\\/"'\s])(pyproject\.toml|setup\.py|setup\.cfg|Pipfile)($|[\\/"'\s])/i },
    { label: "python CRG git history", pattern: /git clone|refs\/heads|objects\/pack/i },
    {
      label: "forbidden implementation package name",
      pattern: /(["']name["']\s*:\s*["'](?:code-review-graph|gungnir)["']|name\s*=\s*["'](?:code-review-graph|gungnir)["'])/i
    },
    { label: "private local path", pattern: /\/Users\/tom\/|\/private\/var\/folders\/|[A-Za-z]:\\Users\\/i },
    { label: "current tool source override", pattern: /LATTICE_(ROX|CRG|CIX)_SOURCE=\/|LATTICE_CURRENT_TOOLS_DIR=\//i },
    { label: "generated build metadata", pattern: /\.tsbuildinfo|tsconfig\.tsbuildinfo/i }
  ];
}

function inspectPackagedGraphArtifactMetadata(file, text) {
  if (!file.startsWith("dist/native/") || !file.endsWith("/metadata.json")) return [];
  const metadata = JSON.parse(text);
  const findings = [];
  for (const key of ["binaryPath", "checksumPath"]) {
    const value = metadata[key];
    if (typeof value !== "string") {
      findings.push(`${file}: graph artifact metadata ${key} is not a string`);
      continue;
    }
    if (/^(\/|[A-Za-z]:|~)|(^|\/)\.\.(\/|$)/.test(value)) {
      findings.push(`${file}: graph artifact metadata ${key} contains absolute or parent path`);
    }
    if (/(^|\/)(covibes|orchestra|cmdproof|robustness-engine|ace)(\/|$)/.test(value)) {
      findings.push(`${file}: graph artifact metadata ${key} contains private/global path`);
    }
  }
  return findings;
}

function runReport(id, command, path) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) failCommand(command[0], command.slice(1), result);
  return {
    id,
    command,
    status: "passed",
    exitCode: 0,
    path
  };
}

function benchmarkReceipts(values) {
  const byMetric = {
    install_setup_ms: [values.installSetupMs, "ms"],
    cold_build_ms: [values.coldBuildMs, "ms"],
    incremental_update_ms: [values.incrementalUpdateMs, "ms"],
    impact_cold_ms: [values.impactColdMs, "ms"],
    impact_hot_ms: [values.impactHotMs, "ms"],
    search_ms: [values.searchMs, "ms"],
    daemon_startup_ms: [values.daemonStartupMs, "ms"],
    daemon_query_ms: [values.daemonQueryMs, "ms"],
    db_size_bytes: [values.dbSizeBytes, "bytes"],
    wal_size_bytes: [values.walSizeBytes, "bytes"]
  };
  return graphReleaseBenchmarkMetrics.map((metric) => ({
    metric,
    value: positiveBenchmarkValue(metric, byMetric[metric][0]),
    unit: byMetric[metric][1],
    baselineIssue: "#19",
    baselineReceipt,
    comparison: "recorded"
  }));
}

function positiveBenchmarkValue(metric, rawValue) {
  const value = Math.round(rawValue);
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || value <= 0) {
    throw new Error(`Graph release benchmark ${metric} must have real positive evidence`);
  }
  return value;
}

function readGraphArtifactMetadata() {
  const target = `${process.platform}-${process.arch}`;
  const artifact = collectGraphReleaseNativeArtifacts().find((entry) => entry.targetPlatform === target) ?? collectGraphReleaseNativeArtifacts()[0];
  if (!artifact) throw new Error("Missing graph native artifact metadata. Run npm run build first.");
  return artifact.metadata;
}

function collectGraphReleaseNativeArtifacts() {
  return graphCoreNativeSupportedTargets.map((target) => {
    const packageName = graphCoreNativePackageNameForTarget(target);
    const packageRoot = join(repoRoot, "packages", packageName.replace("@the-open-engine/", ""));
    const binaryPath = "lattice-graph-core";
    const checksumPath = "lattice-graph-core.sha256";
    const metadataPath = "metadata.json";
    const binaryAbsolutePath = join(packageRoot, binaryPath);
    const checksumAbsolutePath = join(packageRoot, checksumPath);
    const metadataAbsolutePath = join(packageRoot, metadataPath);
    for (const path of [binaryAbsolutePath, checksumAbsolutePath, metadataAbsolutePath]) {
      if (!existsSync(path)) throw new Error(`Missing graph native package artifact: ${path}. Build/download all supported native packages first.`);
    }
    const binarySha256 = sha256File(binaryAbsolutePath);
    const checksumText = readFileSync(checksumAbsolutePath, "utf8").trim();
    if (!checksumText.startsWith(binarySha256)) throw new Error(`Graph native checksum mismatch: ${checksumAbsolutePath}`);
    const metadata = JSON.parse(readFileSync(metadataAbsolutePath, "utf8"));
    if (metadata.targetPlatform !== target || metadata.binaryPath !== binaryPath || metadata.checksumPath !== checksumPath) {
      throw new Error(`Graph native metadata mismatch: ${metadataAbsolutePath}`);
    }
    if (metadata.checksumSha256 !== binarySha256) throw new Error(`Graph native metadata checksum mismatch: ${metadataAbsolutePath}`);
    return {
      packageName,
      targetPlatform: target,
      metadata,
      binaryPath,
      checksumPath,
      metadataPath,
      binarySha256,
      checksumFileSha256: sha256File(checksumAbsolutePath),
      metadataSha256: sha256File(metadataAbsolutePath),
      packageFiles: ["package.json", "README.md", binaryPath, checksumPath, metadataPath]
    };
  });
}

function graphPackageVersions() {
  return [
    "packages/graph/package.json",
    "packages/contracts/package.json",
    ...graphCoreNativeSupportedTargets.map((target) => `packages/${graphCoreNativePackageNameForTarget(target).replace("@the-open-engine/", "")}/package.json`)
  ].map((path) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
    return {
      packageName: manifest.name,
      version: manifest.version
    };
  });
}

function withHandoff(receipt, checksumSha256) {
  return {
    ...receipt,
    handoff: graphReleaseHandoffIssues.map((issue) => ({
      issue,
      receiptPath: handoffReceiptPath,
      checksumSha256,
      rollbackNote: "Keep ACE wrappers on current external tools if receipt regresses."
    }))
  };
}

function writeReleaseDocs(receipt) {
  mkdirSync(join(repoRoot, "docs/release"), { recursive: true });
  const receiptPayload = receiptWithoutHandoff(receipt);
  const payloadJson = `${JSON.stringify(receiptPayload, null, 2)}\n`;
  writeFileSync(join(repoRoot, handoffReceiptPath), payloadJson);
  const payloadChecksumSha256 = sha256(payloadJson);
  const receiptWithPayloadChecksums = withHandoff(receiptPayload, payloadChecksumSha256);
  const receiptJson = `${JSON.stringify(receiptWithPayloadChecksums, null, 2)}\n`;
  writeFileSync(join(repoRoot, receiptPath), receiptJson);
  writeFileSync(join(repoRoot, handoffPath), handoffMarkdown(receiptWithPayloadChecksums));
}

function receiptWithoutHandoff(receipt) {
  const { handoff, ...payload } = receipt;
  return payload;
}

function handoffMarkdown(receipt) {
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptChecksumSha256 = sha256(receiptJson);
  const rows = receipt.handoff
    .map((entry) => `| ${entry.issue} | ${entry.receiptPath} | ${entry.checksumSha256} |`)
    .join("\n");
  const parentScopeRows = graphReleaseOptionalAnalysisSurfaces
    .map((surface) => `| ${surface.issue} | ${surface.id} | ${surface.classification} | ${surface.status} | false |`)
    .join("\n");
  return `# Graph Release Handoff

Issue #17 graph-release gate receipt for #7, #28, and #29.

Full receipt: ${receiptPath}
Full receipt SHA-256: ${receiptChecksumSha256}

| Issue | Checksummed Receipt Path | SHA-256 |
|-------|--------------------------|---------|
${rows}

## Parent #4 Graph Scope

| Issue | Surface | Classification | Status | Release Blocking |
|-------|---------|----------------|--------|------------------|
${parentScopeRows}

## Downstream Inspect Evidence

| Issue | Evidence | Status |
|-------|----------|--------|
| #101 | docs/release/inspect-signature-parity.md | read-only signature parity evidence for #4/#17 consumers |
| #102 | docs/release/inspect-implementations-parity.md | read-only implementation parity evidence for #4/#17 consumers |

License report: docs/release/license-report.md
Provenance receipt: docs/release/provenance-receipts.md

Rollback: keep ACE wrappers on current external tools if receipt regresses.
Maintainer note: these graph release checks must pass before publishing alpha artifacts.
`;
}

function receiptCommandForId(id) {
  const command = id.startsWith("lattice-graph-rust-") ? id.replace("lattice-graph-rust-", "") : id.replace("lattice-graph-", "");
  return ["graph", command];
}

function canonicalCommandForId(id) {
  const command = id.startsWith("lattice-graph-rust-") ? id.replace("lattice-graph-rust-", "") : id.replace("lattice-graph-", "");
  return ["lattice", "graph", command];
}

function requestOperation(requestId) {
  if (requestId === "serve-search") return "search";
  return requestId.replace("serve-", "");
}

function sortCommandCoverage(coverage) {
  const rank = new Map(graphReleaseCoreCommandIds.map((id, index) => [id, index]));
  coverage.sort((left, right) => rank.get(left.id) - rank.get(right.id));
}

function sortRustCommandCoverage(coverage) {
  const rank = new Map(graphReleaseRustCommandIds.map((id, index) => [id, index]));
  coverage.sort((left, right) => rank.get(left.id) - rank.get(right.id));
}

function assertRustGraphEvidence({ build, query, impact, search }) {
  const combined = JSON.stringify([build.parsed, query.parsed, impact.parsed, search.parsed]);
  for (const expected of ["src/lib.rs", "src/helpers.rs", "Widget"]) {
    if (!combined.includes(expected)) throw new Error(`Rust graph release coverage missing evidence for ${expected}`);
  }
}

function fileSize(path) {
  return statSync(path).size;
}

function skipGeneratedStore(source) {
  return !source.includes(`${join(".lattice", "graph")}`);
}

function elapsed(start) {
  return Math.max(1, Math.round(performance.now() - start));
}

function checksumJson(value) {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(path) {
  if (!existsSync(path)) throw new Error(`Missing file for checksum: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Checksum target is not a file: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) failCommand("git", args, result);
  return result.stdout;
}

function failCommand(command, args, result) {
  throw new Error(
    [
      `Command failed: ${command} ${args.join(" ")}`,
      `status: ${result.status}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`
    ].join("\n")
  );
}
