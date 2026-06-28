import type { CommandRouterResult, ParsedCommandArgv } from "@the-open-engine/opcore-contracts";
import { commandGroupByName, createCommandRouterResult, normalizeCommandBin, parseCommandArgv } from "@the-open-engine/opcore-contracts";
import { routeOpcoreCheck } from "./check.js";
import {
  createOpcoreMeasureDelta,
  formatOpcoreMeasureHuman,
  readCommandLatencyTelemetry,
  readOpcoreLatencyBudgets,
  readOpcoreMetricHistory,
  readOpcoreMetricReport,
  writeCommandLatencyTelemetry
} from "./reporting.js";
import { routeOpcoreInit, type OpcoreInitRuntime } from "./init.js";
import { routeOpcoreScan } from "./scan.js";
import { parseOpcoreRepoArgs, resolveRepo, routeOpcoreStatus } from "./status.js";
import { createCommandLatencyRecord, timeCommand } from "./timing.js";
import { routeOpcoreTry } from "./try.js";
import { routeCommand as routeAdvancedOpcoreCommand } from "./advanced/router.js";
import { commandRouterResultForJsonOutput } from "./json-output.js";

declare const process: {
  stdin: {
    isTTY?: boolean;
  };
  stdout: {
    isTTY?: boolean;
    write(text: string): void;
  };
  stderr: {
    write(text: string): void;
  };
};

type Writer = (text: string) => void;

export interface RunOpcoreCliOptions {
  argv: readonly string[];
  bin?: string;
  stdout?: Writer;
  stderr?: Writer;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  readLine?: (prompt: string) => Promise<string>;
}

const helpArgs = new Set(["--help", "-h", "help"]);
const advancedCommandGroups = new Set(["graph", "inspect", "edit", "validate", "doctor"]);

export async function routeOpcoreCommand(
  argv: readonly string[],
  bin = "opcore",
  runtime: OpcoreInitRuntime = {}
): Promise<CommandRouterResult> {
  const parsed = parseCommandArgv(argv);
  const normalizedBin = normalizeCommandBin(bin);
  const routed = await timeCommand(async () => {
    if (normalizedBin !== "opcore") {
      return createCommandRouterResult({
        bin: normalizedBin,
        argv,
        canonicalCommand: ["opcore", "unsupported"],
        owner: "runtime",
        status: "unsupported",
        json: parsed.json,
        message: `Unsupported command entrypoint: ${normalizedBin}`
      });
    }
    return routeOpcoreParsed(argv, parsed, runtime);
  });
  if (shouldWriteLatencyTelemetry(routed)) {
    writeCommandLatencyTelemetry(routed.repoState.repo.root, createCommandLatencyRecord(routed));
  }
  return routed;
}

export async function runOpcoreCli(options: RunOpcoreCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const routed = await routeOpcoreCommand(options.argv, options.bin ?? "opcore", {
    stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY === true,
    stdoutIsTTY: options.stdoutIsTTY ?? process.stdout.isTTY === true,
    readLine: options.readLine ?? createReadLine()
  });
  const output = routed.json ? JSON.stringify(commandRouterResultForJsonOutput(routed)) : routed.message;
  const write = routed.json || routed.status === "ok" ? stdout : stderr;
  write(`${output}\n`);
  return routed.exitCode;
}

async function routeOpcoreParsed(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime
): Promise<CommandRouterResult> {
  const [head, ...rest] = parsed.args;
  if (head === undefined) return routeOpcoreScan(argv, rest, parsed.json);
  if (helpArgs.has(head)) return routeHelp(argv, parsed.json);
  if (head.startsWith("--")) return routeOpcoreScan(argv, parsed.args, parsed.json);
  if (head === "status") return routeOpcoreStatus(argv, parsed);
  if (head === "check") return routeOpcoreCheck(argv, parsed);
  if (head === "init") return routeOpcoreInit(argv, parsed, runtime);
  if (head === "measure") return routeMeasure(argv, parsed);
  if (head === "try") return routeOpcoreTry(argv, parsed);
  if (advancedCommandGroups.has(head)) return routeAdvancedOpcoreCommand(argv, "opcore");
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", head],
    owner: "runtime",
    status: "unsupported",
    json: parsed.json,
    message: `Unsupported opcore command: ${head}`
  });
}

function createReadLine(): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const readline = await import("node:readline/promises");
    const input = process.stdin;
    const output = process.stdout;
    const rl = readline.createInterface({ input, output });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  };
}

function routeMeasure(argv: readonly string[], parsed: ParsedCommandArgv): CommandRouterResult {
  const args = parsed.args.slice(1);
  if (args.some((arg) => helpArgs.has(arg))) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "measure", "help"],
      owner: "runtime",
      status: "ok",
      json: parsed.json,
      message: "opcore measure [--repo <path>] [--json]"
    });
  }
  const parsedMeasure = parseOpcoreRepoArgs(args, "opcore measure");
  if (!parsedMeasure.ok) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "measure"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: parsedMeasure.message
    });
  }
  const resolution = resolveRepo(parsedMeasure.repo, "opcore measure");
  if (!resolution.ok) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "measure"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: resolution.message
    });
  }
  try {
    const current = readOpcoreMetricReport(resolution.resolution.root);
    const history = readOpcoreMetricHistory(resolution.resolution.root);
    const latencyRecords = readCommandLatencyTelemetry(resolution.resolution.root);
    const latencyBudgets = readOpcoreLatencyBudgets(resolution.resolution.root);
    const opcoreMeasure = createOpcoreMeasureDelta({ current, history, latencyRecords, latencyBudgets });
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "measure"],
      owner: "runtime",
      status: "ok",
      json: parsed.json,
      message: formatOpcoreMeasureHuman(opcoreMeasure),
      opcoreMeasure
    });
  } catch (error) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "measure"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: `opcore measure: missing or invalid .opcore/report.json or .opcore/history.jsonl: ${errorMessage(error)}`
    });
  }
}

function routeHelp(argv: readonly string[], json: boolean): CommandRouterResult {
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", "help"],
    owner: "runtime",
    status: "ok",
    json,
    message: opcoreHelpMessage()
  });
}

function opcoreHelpMessage(): string {
  return [
    "Opcore - Local code intelligence, agent setup, and validation gate.",
    "",
    "Usage:",
    "  opcore [--repo <path>] [--json]",
    "  opcore status [--repo <path>] [--verbose] [--json]",
    "  opcore check --changed --json",
    "  opcore check --staged --json",
    "  opcore check <file...> --json",
    "  opcore init [--repo <path>] [--approve] [--json]",
    "  opcore init --undo --approve [--repo <path>] [--json]",
    "  opcore measure [--repo <path>] [--json]",
    "  opcore try [--json]",
    `  ${graphCommandSyntax()}`,
    "  opcore inspect <symbols|definition|references|signature|implementations|search> <target> --repo . [--json]",
    "  opcore edit <exact|patch|tree|rename|move|signature> --repo . [--json]",
    "  opcore validate <request|hypothetical|pre-write|manifest> --request-file <file> --json",
    "  opcore doctor [--json]",
    "",
    "Examples:",
    "  opcore init --repo . --approve",
    "  opcore graph search \"GreetingCard\" --repo . --limit 5",
    "  opcore validate pre-write --request-file ./validation-request.json --timeout-ms 30000 --json",
    "",
    "Exit codes: 0 passed, 1 findings or errors, 64 unsupported."
  ].join("\n");
}

function graphCommandSyntax(): string {
  const graphGroup = commandGroupByName("graph");
  if (!graphGroup) throw new Error("Opcore graph command group is missing from command router manifest");
  return `${graphGroup.canonicalCommand.join(" ")} <${graphGroup.commands.join("|")}> --repo . [--json]`;
}

function shouldWriteLatencyTelemetry(result: CommandRouterResult): result is CommandRouterResult & { repoState: NonNullable<CommandRouterResult["repoState"]> } {
  return (
    result.bin === "opcore" &&
    result.status === "ok" &&
    result.repoState !== undefined &&
    result.canonicalCommand.length >= 2 &&
    result.canonicalCommand[0] === "opcore" &&
    result.canonicalCommand[1] === "scan"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
