import type { CommandRouterResult, ParsedCommandArgv } from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult, normalizeCommandBin, parseCommandArgv } from "@the-open-engine/opcore-contracts";
import { routeOpcoreCheck } from "./check.js";
import {
  createOpcoreMeasureDelta,
  formatOpcoreMeasureHuman,
  readOpcoreMetricHistory,
  readOpcoreMetricReport
} from "./reporting.js";
import { routeOpcoreInit, type OpcoreInitRuntime } from "./init.js";
import { routeOpcoreScan } from "./scan.js";
import { parseOpcoreRepoArgs, resolveRepo, routeOpcoreStatus } from "./status.js";
import { routeOpcoreTry } from "./try.js";

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

export async function routeOpcoreCommand(
  argv: readonly string[],
  bin = "opcore",
  runtime: OpcoreInitRuntime = {}
): Promise<CommandRouterResult> {
  const parsed = parseCommandArgv(argv);
  const normalizedBin = normalizeCommandBin(bin);
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
}

export async function runOpcoreCli(options: RunOpcoreCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const routed = await routeOpcoreCommand(options.argv, options.bin ?? "opcore", {
    stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY === true,
    stdoutIsTTY: options.stdoutIsTTY ?? process.stdout.isTTY === true,
    readLine: options.readLine ?? createReadLine()
  });
  if (routed.json) {
    stdout(`${JSON.stringify(routed)}\n`);
  } else if (routed.status === "ok") {
    stdout(`${routed.message}\n`);
  } else {
    stderr(`${routed.message}\n`);
  }
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
    const opcoreMeasure = createOpcoreMeasureDelta({ current, history });
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
    "Opcore - code scan, agent setup, and validation gate.",
    "",
    "Usage:",
    "  opcore [--repo <path>] [--json]",
    "  opcore status [--repo <path>] [--json]",
    "  opcore check --changed --json",
    "  opcore check --staged --json",
    "  opcore check <file...> --json",
    "  opcore init [--repo <path>] [--approve] [--json]",
    "  opcore init --undo --approve [--repo <path>] [--json]",
    "  opcore measure [--repo <path>] [--json]",
    "  opcore try [--json]",
    "",
    "Exit codes: 0 passed, 1 findings or errors, 64 unsupported."
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
