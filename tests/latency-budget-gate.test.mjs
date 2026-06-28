import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/check-latency-budgets.mjs");
const budgetsPath = join(repoRoot, "docs/performance/latency-budgets.json");
const passTelemetryPath = join(repoRoot, "tests/fixtures/latency/telemetry-pass.jsonl");
const overTelemetryPath = join(repoRoot, "tests/fixtures/latency/telemetry-over.jsonl");

describe("latency budget gate", () => {
  it("exposes the root latency:check script against deterministic fixture timings", () => {
    const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.equal(
      root.scripts?.["latency:check"],
      "node scripts/check-latency-budgets.mjs --records tests/fixtures/latency/telemetry-pass.jsonl"
    );
  });

  it("passes fixture timings with per-command and per-phase budget evidence", () => {
    const result = runGate(["--records", passTelemetryPath, "--json"], 0);
    const report = JSON.parse(result.stdout);

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.status, "pass");
    assert.equal(report.overCount, 0);
    assert.equal(report.checkedRecordCount, 7);
    assert.equal(report.skippedCount, 0);
    assert.equal(report.results.some((entry) => entry.observed.phase === "total"), true);
    assertPassEvidence(report, "opcore check changed --report-mode introduced --base HEAD --checks typescript.syntax", "validation", true);
    assertPassEvidence(report, "opcore graph serve", "total");
    assertPassEvidence(report, "opcore graph serve query", "serve_query");
    assertPassEvidence(report, "opcore graph serve search", "serve_search");
    assertPassEvidence(report, "opcore inspect", "total");
    assert.equal(JSON.stringify(report).includes("score"), false);
  });

  it("fails with actionable command, phase, and bucket evidence when telemetry exceeds a budget", () => {
    const result = runGate(["--telemetry", overTelemetryPath, "--json", "--fail-on-over"], 1);
    const report = JSON.parse(result.stdout);
    const over = report.over.find(
      (entry) =>
        entry.evidence.canonicalCommand.join(" ") ===
          "opcore check changed --report-mode introduced --base HEAD --checks typescript.syntax" &&
        entry.evidence.phase === "validation" &&
        entry.evidence.repoShapeBucket === "small"
    );

    assert.equal(report.status, "over");
    assert.equal(report.overCount > 0, true);
    assert.ok(over, "expected an over-budget validation phase finding");
    assert.equal(over.evidence.observedMs > over.evidence.budgetMs, true);
    assert.equal(over.evidence.overByMs, over.evidence.observedMs - over.evidence.budgetMs);
    assert.equal(JSON.stringify(report).includes("score"), false);
  });

  it("keeps default trend mode non-blocking without dropping regression evidence", () => {
    const result = runGate(["--telemetry", overTelemetryPath, "--json"], 0);
    const report = JSON.parse(result.stdout);

    assert.equal(report.status, "over");
    assert.equal(report.mode, "trend");
    assert.equal(report.overCount > 0, true);
  });
});

function runGate(args, expectedStatus) {
  const result = spawnSync(process.execPath, [scriptPath, "--budgets", budgetsPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, expectedStatus, [
    `Command: ${process.execPath} ${[scriptPath, "--budgets", budgetsPath, ...args].join(" ")}`,
    `status: ${result.status}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`
  ].join("\n"));
  return result;
}

function assertPassEvidence(report, command, phase, requireZeroOverBy = false) {
  assert.equal(
    report.results.some(
      (entry) =>
        entry.status === "pass" &&
        entry.evidence.canonicalCommand.join(" ") === command &&
        entry.evidence.phase === phase &&
        entry.evidence.repoShapeBucket === "small" &&
        (!requireZeroOverBy || entry.evidence.overByMs === 0)
    ),
    true
  );
}
