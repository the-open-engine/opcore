#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  statSync
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandLatencyTelemetryArtifactPolicy,
  validateCommandLatencyRecord,
  validateLatencyBudget,
  validateLatencyBudgetResult
} from "../packages/contracts/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultBudgetsPath = join(repoRoot, "docs/performance/latency-budgets.json");
const defaultTelemetryPath = join(repoRoot, "tests/fixtures/latency/telemetry-pass.jsonl");
const latencyBudgetArtifactPolicy = {
  maxBudgets: 200,
  maxBytes: 64 * 1024
};

const options = parseArgs(process.argv.slice(2));

try {
  const budgets = readBudgets(options.budgetsPath);
  const telemetry = readTelemetry(options.telemetryPath);
  const report = evaluateLatencyBudgets({
    budgets,
    telemetry,
    budgetsPath: options.budgetsPath,
    telemetryPath: options.telemetryPath,
    failOnOver: options.failOnOver
  });

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatHumanReport(report));

  process.exitCode = options.failOnOver && report.overCount > 0 ? 1 : 0;
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}

function parseArgs(args) {
  let budgetsPath = defaultBudgetsPath;
  let telemetryPath = defaultTelemetryPath;
  let json = false;
  let failOnOver = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--warn-only") {
      failOnOver = false;
    } else if (arg === "--fail-on-over") {
      failOnOver = true;
    } else if (arg === "--budgets") {
      budgetsPath = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--telemetry" || arg === "--records") {
      telemetryPath = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(helpText());
      process.exit(0);
    } else {
      throw new Error(`Unknown latency budget option: ${arg}`);
    }
  }
  return {
    budgetsPath: resolvePath(budgetsPath),
    telemetryPath: resolvePath(telemetryPath),
    json,
    failOnOver
  };
}

function helpText() {
  return [
    "Usage: npm run latency:check -- [--json] [--fail-on-over] [--budgets <path>] [--records <path>]",
    "",
    "Default mode is a non-blocking trend signal. Use --fail-on-over to promote over-budget evidence to a failing gate.",
    ""
  ].join("\n");
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  return value;
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function readBudgets(path) {
  if (!existsSync(path)) throw new Error(`Latency budget file not found: ${displayPath(path)}`);
  const stats = statSync(path);
  if (stats.size > latencyBudgetArtifactPolicy.maxBytes) {
    throw new Error(
      `Latency budget file exceeds ${latencyBudgetArtifactPolicy.maxBytes} byte cap: ${displayPath(path)}`
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const entries = Array.isArray(parsed) ? parsed : parsed.budgets;
  if (!Array.isArray(entries)) throw new Error("Latency budget file must contain a budgets array");
  if (entries.length > latencyBudgetArtifactPolicy.maxBudgets) {
    throw new Error(`Latency budget file exceeds ${latencyBudgetArtifactPolicy.maxBudgets} budget cap`);
  }
  return entries.map((budget) => validateLatencyBudget(budget));
}

function readTelemetry(path) {
  if (!existsSync(path)) throw new Error(`Latency telemetry file not found: ${displayPath(path)}`);
  const stats = statSync(path);
  if (stats.size > commandLatencyTelemetryArtifactPolicy.maxBytes) {
    throw new Error(
      `Latency telemetry file exceeds ${commandLatencyTelemetryArtifactPolicy.maxBytes} byte cap: ${displayPath(path)}`
    );
  }
  const content = readFileSync(path, "utf8").trim();
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > commandLatencyTelemetryArtifactPolicy.maxRecords) {
    throw new Error(`Latency telemetry file exceeds ${commandLatencyTelemetryArtifactPolicy.maxRecords} record cap`);
  }
  return lines.map((line, index) => {
    try {
      return validateCommandLatencyRecord(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid latency telemetry at ${displayPath(path)}:${index + 1}: ${errorMessage(error)}`);
    }
  });
}

function evaluateLatencyBudgets({ budgets, telemetry, budgetsPath, telemetryPath, failOnOver }) {
  const results = [];
  const skipped = [];

  for (const record of telemetry) {
    const scope = record.timing.processState;
    const repoShapeBucket = classifyRepoShapeBucket(record.repo);
    const matchingBudgets = budgets.filter((budget) => (
      budget.scope === scope &&
      budget.repoShapeBucket === repoShapeBucket &&
      commandMatchesBudget(record.canonicalCommand, budget.canonicalCommand)
    ));
    if (matchingBudgets.length === 0) {
      skipped.push({
        reason: "missing_budget",
        canonicalCommand: record.canonicalCommand,
        scope,
        repoShapeBucket
      });
      continue;
    }
    for (const budget of matchingBudgets) {
      results.push(createBudgetResult(budget, record, "total", record.timing.durationMs));
      for (const phaseBudget of budget.phaseBudgets ?? []) {
        const observedPhase = record.timing.phases.find((phase) => phase.phase === phaseBudget.phase);
        if (!observedPhase) {
          skipped.push({
            reason: "missing_phase",
            canonicalCommand: record.canonicalCommand,
            scope,
            repoShapeBucket,
            phase: phaseBudget.phase
          });
          continue;
        }
        results.push(createBudgetResult(budget, record, phaseBudget.phase, observedPhase.durationMs));
      }
    }
  }

  const over = results.filter((result) => result.status === "over");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: over.length > 0 ? "over" : "pass",
    mode: failOnOver ? "blocking" : "trend",
    budgetFile: displayPath(budgetsPath),
    telemetryFile: displayPath(telemetryPath),
    budgetCount: budgets.length,
    checkedRecordCount: telemetry.length,
    evaluatedCount: results.length,
    overCount: over.length,
    skippedCount: skipped.length,
    repoShapeBuckets: {
      small: "totalFiles <= 100",
      medium: "totalFiles <= 5000",
      large: "totalFiles > 5000"
    },
    totals: {
      budgets: budgets.length,
      records: telemetry.length,
      evaluated: results.length,
      pass: results.length - over.length,
      over: over.length,
      skipped: skipped.length
    },
    results,
    over,
    skipped
  };
}

function createBudgetResult(budget, record, phase, durationMs) {
  const budgetMs = phase === "total"
    ? budget.budgetMs
    : budget.phaseBudgets?.find((entry) => entry.phase === phase)?.budgetMs;
  if (typeof budgetMs !== "number") throw new Error(`Missing latency budget for phase ${phase}`);
  return validateLatencyBudgetResult({
    schemaVersion: 1,
    status: durationMs > budgetMs ? "over" : "pass",
    budget,
    observed: {
      canonicalCommand: budget.canonicalCommand,
      phase,
      durationMs
    },
    evidence: {
      canonicalCommand: budget.canonicalCommand,
      phase,
      repoShapeBucket: budget.repoShapeBucket,
      observedMs: durationMs,
      budgetMs,
      overByMs: Math.max(0, durationMs - budgetMs)
    }
  });
}

function classifyRepoShapeBucket(repo) {
  if (repo.totalFiles <= 100) return "small";
  if (repo.totalFiles <= 5000) return "medium";
  return "large";
}

function commandMatchesBudget(observedCommand, budgetCommand) {
  if (observedCommand.length < budgetCommand.length) return false;
  return budgetCommand.every((token, index) => observedCommand[index] === token);
}

function formatHumanReport(report) {
  const lines = [
    `Latency budget check (${report.mode}): ${report.totals.pass} pass, ${report.totals.over} over, ${report.totals.skipped} skipped`,
    `Budgets: ${report.budgetFile}`,
    `Telemetry: ${report.telemetryFile}`
  ];
  for (const result of report.results.filter((entry) => entry.status === "over")) {
    lines.push(
      `OVER ${result.evidence.canonicalCommand.join(" ")} ` +
      `[${result.budget.scope}/${result.evidence.repoShapeBucket}/${result.evidence.phase}] ` +
      `${result.evidence.observedMs}ms > ${result.evidence.budgetMs}ms ` +
      `(over by ${result.evidence.overByMs}ms)`
    );
  }
  for (const skipped of report.skipped) {
    lines.push(
      `SKIP ${skipped.canonicalCommand.join(" ")} ` +
      `[${skipped.scope}/${skipped.repoShapeBucket}${skipped.phase ? `/${skipped.phase}` : ""}] ${skipped.reason}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function displayPath(path) {
  const relativePath = relative(repoRoot, path);
  return relativePath.startsWith("..") ? path : relativePath;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
