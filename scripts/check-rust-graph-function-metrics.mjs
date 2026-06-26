import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const check = {
  name: "lattice-rust-graph-function-metrics",
  description: "Runs scoped Rust graph-core function metrics during repo-wide Rox checks.",
  modes: ["all"],
  async run(config) {
    return runRustGraphMetrics(config.rootDir);
  }
};

export default check;

if (isCli()) {
  const results = runRustGraphMetrics(process.cwd());
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.some((result) => result.severity === "error") ? 2 : 0);
}

function runRustGraphMetrics(rootDir) {
  const files = rustSourceFiles(rootDir);
  if (files.length === 0) return [];
  const rox = join(rootDir, ".ace/runtime/bin/rox");
  const result = spawnSync(
    rox,
    ["check", "--files", ...files, "--no-daemon", "--checks", "functionMetrics", "--json"],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return parseResult(result);
}

function rustSourceFiles(rootDir) {
  return collectRustFiles(rootDir, "crates", []).sort();
}

function collectRustFiles(rootDir, relativeDir, files) {
  for (const entry of readdirSync(join(rootDir, relativeDir), { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) collectRustFiles(rootDir, relativePath, files);
    if (entry.isFile() && entry.name.endsWith(".rs")) files.push(relativePath);
  }
  return files.filter((file) => statSync(join(rootDir, file)).isFile());
}

function parseResult(result) {
  const stdout = result.stdout.trim();
  if (stdout.length > 0) {
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [executionError(result, "Rox Rust metric output was not valid JSON")];
    }
  }
  if (result.status === 0) return [];
  return [executionError(result, "Rox Rust metric command failed")];
}

function executionError(result, message) {
  return {
    severity: "error",
    message: `${message}: exit ${result.status ?? "signal"}${result.stderr ? `; stderr: ${result.stderr.trim()}` : ""}`,
    rule: "lattice-rust-graph-function-metrics/error"
  };
}

function isCli() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
