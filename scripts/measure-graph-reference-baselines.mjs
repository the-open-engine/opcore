import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const write = process.argv.includes("--write");
const referenceGraphTool = ".ace/runtime/bin/crg";
const sourceAvailability = existsSync(referenceGraphTool) ? "available" : "unavailable";
const outputPath = "packages/fixtures/graph-reference-evidence/baseline-receipts.json";

const receipts = [
  measureCommand("baseline-install-setup", "install_setup_ms", [referenceGraphTool, "--help"]),
  measureCommand("baseline-cold-build", "cold_build_ms", [referenceGraphTool, "build", "--repo", ".", "--json"]),
  measureCommand("baseline-incremental-update", "incremental_update_ms", [referenceGraphTool, "update", "--base", "HEAD", "--repo", ".", "--json"]),
  measureCommand("baseline-impact-cold", "impact_cold_ms", [
    referenceGraphTool,
    "impact",
    "--files",
    "packages/contracts/src/index.ts",
    "--repo",
    ".",
    "--json"
  ]),
  measureCommand("baseline-impact-hot", "impact_hot_ms", [
    referenceGraphTool,
    "impact",
    "--files",
    "packages/contracts/src/index.ts",
    "--repo",
    ".",
    "--json"
  ]),
  measureCommand("baseline-search", "search_ms", [referenceGraphTool, "search", "GraphProvider", "--limit", "5", "--repo", ".", "--json"]),
  measureFile("baseline-db-size", "db_size_bytes", ".code-review-graph/graph.db"),
  measureFile("baseline-wal-size", "wal_size_bytes", ".code-review-graph/graph.db-wal"),
  measureCommand("baseline-daemon-startup", "daemon_startup_ms", [referenceGraphTool, "serve", "--help"]),
  syntheticReceipt("baseline-daemon-query", "daemon_query_ms", "lattice.graph.daemon synthetic query envelope")
];

const payload = {
  schemaVersion: 1,
  issue: "#19",
  label: "reference_evidence_non_implementation_input",
  origin: "covibes-authored-synthetic",
  sourceTool: "current external dev wrapper",
  sourceAvailability,
  collectedAt: new Date().toISOString(),
  receipts
};

if (write) {
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function measureCommand(id, metric, command) {
  if (sourceAvailability === "unavailable") {
    return unavailableReceipt(id, metric, command.join(" "));
  }
  const start = performance.now();
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000
  });
  const elapsed = Math.max(1, Math.round(performance.now() - start));
  return {
    id,
    metric,
    value: elapsed,
    unit: "ms",
    sourceAvailability,
    nonImplementationInput: true,
    command: command.join(" "),
    exitCode: result.status ?? 124,
    stderr: result.stderr.trim()
  };
}

function measureFile(id, metric, path) {
  if (!existsSync(path)) return unavailableReceipt(id, metric, `stat ${path}`, "bytes");
  return {
    id,
    metric,
    value: Math.max(1, statSync(path).size),
    unit: "bytes",
    sourceAvailability,
    nonImplementationInput: true,
    command: `stat ${path}`
  };
}

function syntheticReceipt(id, metric, command) {
  return {
    id,
    metric,
    value: 1,
    unit: "ms",
    sourceAvailability,
    nonImplementationInput: true,
    command
  };
}

function unavailableReceipt(id, metric, command, unit = "ms") {
  return {
    id,
    metric,
    value: 1,
    unit,
    sourceAvailability: "unavailable",
    nonImplementationInput: true,
    command
  };
}
