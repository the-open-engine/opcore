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
import { routeOpcoreInit, routeOpcoreInstall, routeOpcoreUninstall, type OpcoreInitRuntime } from "./init.js";
import { routeOpcoreScan } from "./scan.js";
import { parseOpcoreRepoArgs, resolveRepo, routeOpcoreStatus } from "./status.js";
import { routeOpcoreDoctor } from "./doctor.js";
import {
  commandRouterResultForStreamFinalOutput,
  shouldWriteValidationStreamFinalJson
} from "./stream-output.js";
import { createCommandLatencyRecord, timeCommand } from "./timing.js";
import { routeOpcoreTry } from "./try.js";
import { formatOpcoreVersion, readOpcoreRuntimeInfo } from "./runtime-info.js";
import { routeCommand as routeAdvancedOpcoreCommand } from "./advanced/router.js";
import { commandRouterResultForJsonOutput } from "./json-output.js";
import type { OpcoreCheckRuntime, OpcorePresentation } from "./check.js";

declare const process: {
  env?: Record<string, string | undefined>;
  stdin: {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
    setEncoding?: (encoding: string) => void;
    resume(): void;
    pause(): void;
    on(event: "data", listener: (chunk: unknown) => void): void;
    off(event: "data", listener: (chunk: unknown) => void): void;
  };
  stdout: {
    isTTY?: boolean;
    write(text: string): void;
  };
  stderr: {
    isTTY?: boolean;
    write(text: string): void;
  };
};

const plainPresentation: OpcorePresentation = { stdoutIsTTY: false, color: false };

function resolvePresentation(options: RunOpcoreCliOptions): OpcorePresentation {
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  const color = stdoutIsTTY && !(process.env && process.env.NO_COLOR);
  return { stdoutIsTTY, color };
}

type Writer = (text: string) => void;

interface OpcoreCommandRuntime extends OpcoreInitRuntime, OpcoreCheckRuntime {
  presentation?: OpcorePresentation;
}

export interface RunOpcoreCliOptions {
  argv: readonly string[];
  bin?: string;
  stdout?: Writer;
  stderr?: Writer;
  homeDir?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  readLine?: (prompt: string) => Promise<string>;
  readKey?: () => Promise<string>;
  initWizardMotion?: boolean;
}

const helpArgs = new Set(["--help", "-h", "help"]);
const versionArgs = new Set(["--version", "-v", "version"]);
const advancedCommandGroups = new Set(["graph", "inspect", "edit", "validate"]);

export async function routeOpcoreCommand(
  argv: readonly string[],
  bin = "opcore",
  runtime: OpcoreCommandRuntime = {}
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
    ...createOpcoreInitRuntime(options, stderr),
    streamWriter: stdout,
    presentation: resolvePresentation(options)
  });
  const streamFinalJson = shouldWriteValidationStreamFinalJson(routed, options.argv);
  const output = routed.json
    ? JSON.stringify(commandRouterResultForJsonOutput(routed))
    : streamFinalJson
      ? JSON.stringify(commandRouterResultForStreamFinalOutput(routed))
      : routed.message;
  const write = routed.json || streamFinalJson || routed.status === "ok" ? stdout : stderr;
  write(`${output}\n`);
  return routed.exitCode;
}

function createOpcoreInitRuntime(options: RunOpcoreCliOptions, stderr: Writer): OpcoreInitRuntime {
  const stderrIsTTY = options.stderrIsTTY ?? process.stderr.isTTY === true;
  const noColor = Boolean(process.env && process.env.NO_COLOR);
  return {
    stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY === true,
    stdoutIsTTY: options.stdoutIsTTY ?? process.stdout.isTTY === true,
    stderrIsTTY,
    stderrColor: stderrIsTTY && !noColor,
    stderrTrueColor: /truecolor|24bit/.test((process.env && process.env.COLORTERM) ?? ""),
    homeDir: options.homeDir,
    writeStderr: stderr,
    readLine: options.readLine ?? createReadLine(),
    readKey: options.readKey ?? createReadKey(),
    initWizardMotion: options.initWizardMotion
  };
}

function createReadKey(): (() => Promise<string>) | undefined {
  if (process.stdin.isTTY !== true || typeof process.stdin.setRawMode !== "function") return undefined;
  return () =>
    new Promise<string>((resolveKey) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw === true;
      stdin.setRawMode?.(true);
      stdin.resume();
      const onData = (chunk: unknown) => {
        stdin.off("data", onData);
        if (!wasRaw) stdin.setRawMode?.(false);
        stdin.pause();
        resolveKey(typeof chunk === "string" ? chunk : String(chunk));
      };
      stdin.setEncoding?.("utf8");
      stdin.on("data", onData);
    });
}

async function routeOpcoreParsed(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreCommandRuntime
): Promise<CommandRouterResult> {
  const [head, ...rest] = parsed.args;
  const presentation = runtime.presentation ?? plainPresentation;
  if (head === undefined) return routeOpcoreScan(argv, rest, parsed.json, presentation);
  if (helpArgs.has(head)) return routeHelp(argv, parsed.json);
  if (versionArgs.has(head)) return routeVersion(argv, parsed);
  if (head.startsWith("--")) return routeOpcoreScan(argv, parsed.args, parsed.json, presentation);
  if (head === "status") return routeOpcoreStatus(argv, parsed);
  if (head === "doctor") return routeOpcoreDoctor(argv, parsed);
  if (head === "check") return routeOpcoreCheck(argv, parsed, runtime, presentation);
  if (head === "init") return routeOpcoreInit(argv, parsed, runtime);
  if (head === "install") return routeOpcoreInstall(argv, parsed, runtime);
  if (head === "uninstall") return routeOpcoreUninstall(argv, parsed, runtime);
  if (head === "measure") return routeMeasure(argv, parsed);
  if (head === "try") return routeOpcoreTry(argv, parsed);
  if (advancedCommandGroups.has(head)) return routeAdvancedOpcoreCommand(argv, "opcore", { streamWriter: runtime.streamWriter });
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

function routeVersion(argv: readonly string[], parsed: ParsedCommandArgv): CommandRouterResult {
  const runtimeInfo = readOpcoreRuntimeInfo();
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", "version"],
    owner: "runtime",
    status: "ok",
    json: parsed.json,
    message: formatOpcoreVersion(runtimeInfo),
    runtimeInfo
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
      message: [
        "Usage: opcore measure [--repo <path>] [--json]",
        "Flags:",
        "  --repo <path>  Repository root to read .opcore artifacts from.",
        "  --json         Emit structured JSON.",
        "Defaults:",
        "  --repo defaults to the current working directory.",
        "Examples:",
        "  opcore measure --repo . --json",
        "Exit codes: 0 report read, 1 missing or invalid artifacts, 64 unsupported."
      ].join("\n")
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
    "  opcore --version [--json]",
    "  opcore status [--repo <path>] [--verbose] [--json]",
    "  opcore install [--repo <path>] [--yes] [--json]",
    "  opcore uninstall [--repo <path>] [--yes] [--json]",
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
    "  opcore doctor [--repo <path>] [--json]",
    "",
    "Examples:",
    "  opcore --version --json",
    "  opcore install",
    "  opcore init --repo . --approve",
    "  opcore doctor --repo . --json",
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
