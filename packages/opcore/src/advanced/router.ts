import type { CommandAdapter, CommandRouterResult, ParsedCommandArgv, ValidationStatusPayload } from "@the-open-engine/opcore-contracts";
import {
  commandGroupByName,
  createCommandRouterResult,
  normalizeCommandBin,
  parseCommandArgv,
  routeCommandAdapter,
  validateCommandRouterManifest
} from "@the-open-engine/opcore-contracts";
import { graphCommandAdapter } from "@the-open-engine/opcore-graph";
import { editCommandAdapter } from "./edit-composition.js";
import { inspectCommandAdapter } from "./inspect-adapter.js";
import { commandRouterManifest } from "./manifest.js";
import { timeCommand } from "../timing.js";
import {
  checkCommandAdapter,
  createCliCheckCommandAdapter,
  createDefaultValidationStatusPayload,
  createCliValidateCommandAdapter,
  validateCommandAdapter
} from "./validation-composition.js";
import { commandRouterResultForJsonOutput } from "../json-output.js";
import {
  commandRouterResultForStreamFinalOutput,
  shouldWriteValidationStreamFinalJson
} from "../stream-output.js";
import { routeOpcoreDoctor } from "../doctor.js";

declare const process: {
  stdout: {
    write(text: string): void;
  };
  stderr: {
    write(text: string): void;
  };
  cwd(): string;
};

type Writer = (text: string) => void;

export interface RunCliOptions {
  argv: readonly string[];
  bin: string;
  stdout?: Writer;
  stderr?: Writer;
}

interface AdvancedCliRuntime {
  streamWriter?: Writer;
}

const helpArgs = new Set(["--help", "-h", "help"]);
const runtimeCommands = new Set<RuntimeCommand>(["status", "doctor"]);

type RuntimeCommand = "status" | "doctor";

validateCommandRouterManifest(commandRouterManifest);

export async function routeCommand(
  argv: readonly string[],
  bin: string,
  runtime: AdvancedCliRuntime = {}
): Promise<CommandRouterResult> {
  const parsed = parseCommandArgv(argv);
  const normalizedBin = normalizeCommandBin(bin);
  return timeCommand(async () => {
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
    return routeLattice(argv, parsed, runtime);
  });
}

export async function runCli(options: RunCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const routed = await routeCommand(options.argv, options.bin, { streamWriter: stdout });
  const streamFinalJson = shouldWriteValidationStreamFinalJson(routed, options.argv);
  if (routed.json || streamFinalJson) {
    const output = routed.json ? commandRouterResultForJsonOutput(routed) : commandRouterResultForStreamFinalOutput(routed);
    stdout(`${JSON.stringify(output)}\n`);
  } else if (routed.status === "ok") {
    stdout(`${routed.message}\n`);
  } else {
    stderr(`${routed.message}\n`);
  }
  return routed.exitCode;
}

async function routeLattice(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: AdvancedCliRuntime
): Promise<CommandRouterResult> {
  const [head, ...rest] = parsed.args;
  if (!head || helpArgs.has(head)) {
    return routeHelp("opcore", argv, parsed.json);
  }
  if (isRuntimeCommand(head)) {
    return routeRuntimeCommand(argv, parsed, head, rest);
  }
  const adapter = adapterForGroup(head, runtime);
  if (adapter) {
    return routeCommandAdapter({
      bin: "opcore",
      argv,
      args: rest,
      json: parsed.json,
      groupName: head,
      adapter,
      validateFirstRouteArg: head === "check" || head === "validate" ? false : true
    });
  }
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", head],
    owner: "runtime",
    status: "unsupported",
    json: parsed.json,
    message: `Unsupported opcore command group: ${head}`
  });
}

function routeRuntimeCommand(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  command: RuntimeCommand,
  rest: readonly string[]
): CommandRouterResult {
  if (command === "doctor") {
    return routeOpcoreDoctor(argv, { args: [command, ...rest], json: parsed.json });
  }
  if (rest.some((arg) => helpArgs.has(arg))) {
    return routeHelp("opcore", argv, parsed.json, command);
  }
  const canonicalCommand = ["opcore", command, ...rest];
  if (rest.length > 0) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand,
      owner: "runtime",
      status: "unsupported",
      json: parsed.json,
      message: `${canonicalCommand.join(" ")} is not a supported runtime route.`
    });
  }
  const validationStatus = createDefaultValidationStatusPayload({
    repoRoot: process.cwd(),
    graphMode: "optional"
  });
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand,
    owner: "runtime",
    status: "ok",
    json: parsed.json,
    message: runtimeMessage(command, validationStatus),
    validationStatus
  });
}

function isRuntimeCommand(command: string): command is RuntimeCommand {
  return runtimeCommands.has(command as RuntimeCommand);
}

function adapterForGroup(groupName: string, runtime: AdvancedCliRuntime): CommandAdapter | undefined {
  if (groupName === "graph") return graphCommandAdapter;
  if (groupName === "inspect") return inspectCommandAdapter;
  if (groupName === "edit") return editCommandAdapter;
  if (groupName === "check") {
    return runtime.streamWriter === undefined
      ? checkCommandAdapter
      : createCliCheckCommandAdapter({ streamWriter: runtime.streamWriter });
  }
  if (groupName === "validate") {
    return runtime.streamWriter === undefined
      ? validateCommandAdapter
      : createCliValidateCommandAdapter({ streamWriter: runtime.streamWriter });
  }
  return undefined;
}

function routeHelp(bin: string, argv: readonly string[], json: boolean, groupName?: string): CommandRouterResult {
  const group = groupName ? commandGroupByName(groupName) : undefined;
  const canonicalCommand = group ? [...group.canonicalCommand, "help"] : ["opcore", "help"];
  return createCommandRouterResult({
    bin,
    argv,
    canonicalCommand,
    owner: group?.owner ?? "runtime",
    status: "ok",
    json,
    message: helpMessage(groupName)
  });
}

function helpMessage(groupName?: string): string {
  if (!groupName) {
    return [
      "Opcore - Local code intelligence and edit safety for coding agents.",
      "",
      "Usage:",
      "  opcore <group> <command> [options]",
      "",
      "Groups:",
      "  graph      build, update, watch, query, search, and serve repository graph context",
      "  inspect    read symbols, definitions, references, signatures, implementations, and search results",
      "  edit       create and apply validation-gated edit plans",
      "  check      run syntax, type, graph-aware, and manifest checks",
      "  validate   validate request files, hypothetical overlays, and pre-write receipts",
      "  status     show runtime readiness",
      "  doctor     show runtime diagnostics",
      "",
      "Examples:",
      "  opcore graph build --repo .",
      "  opcore graph search \"GreetingCard\" --repo . --limit 5",
      "  opcore validate pre-write --request-file ./validation-request.json --timeout-ms 30000 --json",
      "",
      "Use --json for agent integrations. Docs: https://github.com/the-open-engine/opcore#readme",
      "Groups: graph, inspect, edit, check, validate, status, doctor"
    ].join("\n");
  }
  const group = commandGroupByName(groupName);
  if (!group) return `Unknown opcore command group: ${groupName}`;
  return [
    `${group.canonicalCommand.join(" ")} - ${group.summary}`,
    "",
    `Commands: ${group.commands.join(", ")}`,
    "",
    "Syntax:",
    `  ${groupSyntax(groupName)}`,
    "",
    "Example:",
    `  ${groupExample(groupName)}`
  ].join("\n");
}

function runtimeMessage(command: RuntimeCommand, validationStatus: ValidationStatusPayload): string {
  const graphAdvice = graphStatusAdvice(validationStatus);
  if (command === "doctor") {
    return [
      "opcore doctor: router manifest valid; graph, edit, and validation engines are package-owned.",
      graphAdvice
    ].join("\n");
  }
  return ["opcore status: router ready.", graphAdvice].join("\n");
}

function graphStatusAdvice(validationStatus: ValidationStatusPayload): string {
  const graphStatus = validationStatus.graph.status;
  if (graphStatus.state === "available") return "Graph is available.";
  if (graphStatus.state === "warming") return "Graph is warming. Try again shortly or run `opcore graph status --json` for details.";
  if (graphStatus.state === "stale") return "Graph is stale. Run `opcore graph build`.";
  if (graphStatus.state === "schema_mismatch") return "Graph metadata needs rebuild. Run `opcore graph build`.";
  return "Graph is not available yet. Run `opcore graph build`.";
}

function groupSyntax(groupName: string): string {
  if (groupName === "graph") return commandGroupSyntax("graph");
  if (groupName === "inspect") return "opcore inspect <symbols|definition|references|signature|implementations|search> <target> --repo . [--json]";
  if (groupName === "edit") return "opcore edit <exact|patch|tree|rename|move|signature> --repo . [--json]";
  if (groupName === "check") return "opcore check <files|changed|staged|tree|all|manifest> --repo . [--json]";
  if (groupName === "validate") return "opcore validate <request|hypothetical|pre-write|manifest> --request-file <file> --json";
  if (groupName === "status") return "opcore status [--json]";
  if (groupName === "doctor") return "opcore doctor [--json]";
  return `opcore ${groupName} <command> [options]`;
}

function commandGroupSyntax(groupName: string): string {
  const group = commandGroupByName(groupName);
  if (!group) throw new Error(`Opcore ${groupName} command group is missing from command router manifest`);
  return `${group.canonicalCommand.join(" ")} <${group.commands.join("|")}> --repo . [--json]`;
}

function groupExample(groupName: string): string {
  if (groupName === "graph") return 'opcore graph search "GreetingCard" --repo . --limit 5';
  if (groupName === "inspect") return "opcore inspect signature src/components/GreetingCard.tsx GreetingCard --line 11 --repo . --json";
  if (groupName === "edit") return 'opcore edit exact --path src/a.ts --expected "old" --replacement "new" --json';
  if (groupName === "check") return "opcore check files --files src/index.ts --json";
  if (groupName === "validate") return "opcore validate pre-write --request-file ./validation-request.json --timeout-ms 30000 --json";
  if (groupName === "status") return "opcore status";
  if (groupName === "doctor") return "opcore doctor --json";
  return `opcore ${groupName} --help`;
}
