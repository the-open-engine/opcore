import type {
  CommandRouterResult,
  OpcoreMeasureDelta,
  OpcoreMetricReport,
  OpcoreTryCommandSummary,
  OpcoreTryPayload,
  OpcoreTryScenario,
  OpcoreTrySignalSummary,
  ParsedCommandArgv
} from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult, parseCommandArgv } from "@the-open-engine/opcore-contracts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeOpcoreCheck } from "./check.js";
import { routeOpcoreInit } from "./init.js";
import {
  createOpcoreMeasureDelta,
  readOpcoreMetricHistory,
  readOpcoreMetricReport
} from "./reporting.js";
import { routeOpcoreScan } from "./scan.js";

declare const process: {
  env: Record<string, string | undefined>;
};

interface TryScenarioSeed {
  id: string;
  title: string;
  write(repoRoot: string): void;
}

interface TryScenarioResult {
  scenario: OpcoreTryScenario;
  commands: readonly OpcoreTryCommandSummary[];
}

const scenarioSeeds: readonly TryScenarioSeed[] = [
  {
    id: "typescript-app",
    title: "TypeScript app with a seeded type finding",
    write(repoRoot) {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "tsconfig.json"),
        `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"] }, null, 2)}\n`
      );
      writeFileSync(join(repoRoot, "src/index.ts"), "export const total: number = \"bad\";\n");
    }
  },
  {
    id: "rust-crate",
    title: "Rust crate with source hygiene findings",
    write(repoRoot) {
      writeRustCrate(repoRoot, "opcore_try_rust");
    }
  },
  {
    id: "python-package",
    title: "Python package with syntax and source hygiene findings",
    write(repoRoot) {
      mkdirSync(join(repoRoot, "pkg"), { recursive: true });
      writeFileSync(join(repoRoot, "pyproject.toml"), "[project]\nname = \"opcore-try-python\"\n");
      writeFileSync(
        join(repoRoot, "pkg/app.py"),
        [
          "def broken()",
          "    return 1  # type: ignore",
          ""
        ].join("\n")
      );
    }
  },
  {
    id: "mixed-repo",
    title: "Mixed TS/Rust repo with both supported stacks",
    write(repoRoot) {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "tsconfig.json"),
        `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"] }, null, 2)}\n`
      );
      writeFileSync(join(repoRoot, "src/app.ts"), "export const total: number = \"bad\";\n");
      writeRustCrate(repoRoot, "opcore_try_mixed");
    }
  },
  {
    id: "unsupported-files",
    title: "Repo with unsupported files counted honestly",
    write(repoRoot) {
      mkdirSync(join(repoRoot, "scripts"), { recursive: true });
      writeFileSync(join(repoRoot, "scripts/task.go"), "package scripts\n\nfunc Run() string { return \"unsupported day-one stack\" }\n");
    }
  }
];

const checkArgs = [
  "check",
  "--changed",
  "--checks",
  "typescript.syntax,typescript.types,rust.source-hygiene,rust.file-length,python.syntax,python.source-hygiene",
  "--json"
] as const;

export async function routeOpcoreTry(argv: readonly string[], parsed: ParsedCommandArgv): Promise<CommandRouterResult> {
  const rest = parsed.args.slice(1);
  if (rest.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "try", "help"],
      owner: "runtime",
      status: "ok",
      json: parsed.json,
      message: "opcore try [--json]"
    });
  }
  if (rest.length > 0) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "try"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: `opcore try: unsupported argument ${rest[0]}`
    });
  }

  try {
    const sampleRoot = mkdtempSync(join(tmpdir(), "opcore-try-"));
    const scenarioResults = [];
    for (const seed of scenarioSeeds) scenarioResults.push(await runScenario(sampleRoot, seed));
    const opcoreTry: OpcoreTryPayload = {
      schemaVersion: 1,
      sampleRoot,
      published: false,
      scenarios: scenarioResults.map((entry) => entry.scenario),
      commands: scenarioResults.flatMap((entry) => entry.commands)
    };
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "try"],
      owner: "runtime",
      status: "ok",
      json: parsed.json,
      message: formatTryHuman(opcoreTry),
      opcoreTry
    });
  } catch (error) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "try"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: `opcore try failed: ${errorMessage(error)}`
    });
  }
}

async function runScenario(sampleRoot: string, seed: TryScenarioSeed): Promise<TryScenarioResult> {
  const repoRoot = join(sampleRoot, seed.id);
  mkdirSync(repoRoot, { recursive: true });
  initEmptyGitBaseline(repoRoot);
  seed.write(repoRoot);

  const scan = await routeOpcoreScan(["try", "--repo", repoRoot, "--json"], ["--repo", repoRoot], true);
  const init = await routeOpcoreInit(
    ["try", "init", "--repo", repoRoot, "--approve", "--json"],
    parseCommandArgv(["init", "--repo", repoRoot, "--approve", "--json"]),
    { stdinIsTTY: false, stdoutIsTTY: false }
  );
  const check = await routeOpcoreCheck(
    ["try", ...checkArgs, "--repo", repoRoot],
    parseCommandArgv([...checkArgs, "--repo", repoRoot])
  );
  const report = readOpcoreMetricReport(repoRoot);
  const measure = createOpcoreMeasureDelta({ current: report, history: readOpcoreMetricHistory(repoRoot) });
  const commands = [
    commandSummary(seed.id, ["opcore", "--repo", repoRoot], scan),
    commandSummary(seed.id, ["opcore", "init", "--repo", repoRoot, "--approve"], init),
    commandSummary(seed.id, ["opcore", ...checkArgs.filter((arg) => arg !== "--json"), "--repo", repoRoot], check),
    {
      scenarioId: seed.id,
      command: ["opcore", "measure", "--repo", repoRoot],
      canonicalCommand: ["opcore", "measure"],
      owner: "runtime",
      status: "ok",
      exitCode: 0
    } satisfies OpcoreTryCommandSummary
  ];

  return {
    scenario: {
      id: seed.id,
      repoRoot,
      title: seed.title,
      commands: commands.map((entry) => entry.command.join(" ")),
      coverage: {
        totalFiles: report.coverage.totalFiles,
        validationSupportedFiles: report.coverage.validation.supportedFiles,
        unsupportedFiles: report.coverage.unsupported.totalFiles
      },
      signals: signalSummaries(report, measure)
    },
    commands
  };
}

function writeRustCrate(repoRoot: string, crateName: string): void {
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(
    join(repoRoot, "Cargo.toml"),
    [
      "[package]",
      `name = "${crateName}"`,
      "version = \"0.1.0\"",
      "edition = \"2021\"",
      "",
      "[lib]",
      "path = \"src/lib.rs\"",
      ""
    ].join("\n")
  );
  writeFileSync(join(repoRoot, "src/generated.inc"), "1usize\n");
  writeFileSync(
    join(repoRoot, "src/lib.rs"),
    [
      "#[allow(dead_code)]",
      "pub fn hidden() -> usize { 1 }",
      "",
      "#[rustfmt::skip]",
      "pub fn cramped( ) -> usize { include!(\"generated.inc\") }",
      ""
    ].join("\n")
  );
}

function initEmptyGitBaseline(repoRoot: string): void {
  runGit(repoRoot, ["init"]);
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commit = runGit(repoRoot, ["commit-tree", emptyTree, "-m", "opcore try baseline"]).stdout.trim();
  runGit(repoRoot, ["branch", "-f", "main", commit]);
  runGit(repoRoot, ["checkout", "-q", "main"]);
}

function runGit(cwd: string, args: readonly string[]): { stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Opcore Try",
      GIT_AUTHOR_EMAIL: "opcore@example.invalid",
      GIT_COMMITTER_NAME: "Opcore Try",
      GIT_COMMITTER_EMAIL: "opcore@example.invalid"
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout };
}

function commandSummary(
  scenarioId: string,
  command: readonly string[],
  result: CommandRouterResult
): OpcoreTryCommandSummary {
  return {
    scenarioId,
    command,
    canonicalCommand: result.canonicalCommand,
    owner: result.owner,
    status: result.status,
    exitCode: result.exitCode
  };
}

function signalSummaries(report: OpcoreMetricReport, measure: OpcoreMeasureDelta): readonly OpcoreTrySignalSummary[] {
  const baselineDeltas = new Map(measure.baseline?.deltas.map((entry) => [entry.id, entry.delta]) ?? []);
  return report.signals.map((signal) => ({
    id: signal.id,
    title: signal.title,
    count: signal.count,
    delta: baselineDeltas.get(signal.id) ?? 0
  }));
}

function formatTryHuman(payload: OpcoreTryPayload): string {
  const signals = aggregateSignals(payload.scenarios);
  return [
    "Coverage:",
    `  scenarios=${payload.scenarios.length} files=${sum(payload.scenarios, (scenario) => scenario.coverage.totalFiles)} validation=${sum(payload.scenarios, (scenario) => scenario.coverage.validationSupportedFiles)} unsupported=${sum(payload.scenarios, (scenario) => scenario.coverage.unsupportedFiles)}`,
    "Findings:",
    ...(signals.length === 0 ? ["  none"] : signals.map((signal) => `  ${signal.id}: count=${signal.count} delta=${formatSigned(signal.delta)}`)),
    "Loop:",
    "  opcore --repo <sample>",
    "  opcore init --repo <sample> --approve",
    "  opcore check --changed --checks typescript.syntax,typescript.types,rust.source-hygiene,rust.file-length,python.syntax,python.source-hygiene --json",
    "  opcore measure --repo <sample>",
    "Sandbox:",
    `  ${payload.sampleRoot}`,
    "  generated locally; published=false"
  ].join("\n");
}

function aggregateSignals(scenarios: readonly OpcoreTryScenario[]): readonly OpcoreTrySignalSummary[] {
  const byId = new Map<string, OpcoreTrySignalSummary>();
  for (const scenario of scenarios) {
    for (const signal of scenario.signals) {
      const existing = byId.get(signal.id);
      byId.set(signal.id, {
        id: signal.id,
        title: signal.title,
        count: (existing?.count ?? 0) + signal.count,
        delta: (existing?.delta ?? 0) + signal.delta
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sum(scenarios: readonly OpcoreTryScenario[], select: (scenario: OpcoreTryScenario) => number): number {
  return scenarios.reduce((total, scenario) => total + select(scenario), 0);
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
