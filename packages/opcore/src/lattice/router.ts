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
import {
  checkCommandAdapter,
  createDefaultValidationStatusPayload,
  validateCommandAdapter
} from "./validation-composition.js";

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

const helpArgs = new Set(["--help", "-h", "help"]);
const runtimeCommands = new Set<RuntimeCommand>(["status", "doctor"]);

type RuntimeCommand = "status" | "doctor";

validateCommandRouterManifest(commandRouterManifest);

export async function routeCommand(argv: readonly string[], bin: string): Promise<CommandRouterResult> {
  const parsed = parseCommandArgv(argv);
  const normalizedBin = normalizeCommandBin(bin);
  if (normalizedBin !== "lattice") {
    return createCommandRouterResult({
      bin: normalizedBin,
      argv,
      canonicalCommand: ["lattice", "unsupported"],
      owner: "runtime",
      status: "unsupported",
      json: parsed.json,
      message: `Unsupported command entrypoint: ${normalizedBin}`
    });
  }
  return routeLattice(argv, parsed);
}

export async function runCli(options: RunCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const routed = await routeCommand(options.argv, options.bin);
  if (routed.json) {
    stdout(`${JSON.stringify(routed)}\n`);
  } else if (routed.status === "ok") {
    stdout(`${routed.message}\n`);
  } else {
    stderr(`${routed.message}\n`);
  }
  return routed.exitCode;
}

async function routeLattice(argv: readonly string[], parsed: ParsedCommandArgv): Promise<CommandRouterResult> {
  const [head, ...rest] = parsed.args;
  if (!head || helpArgs.has(head)) {
    return routeHelp("lattice", argv, parsed.json);
  }
  if (isRuntimeCommand(head)) {
    return routeRuntimeCommand(argv, parsed, head, rest);
  }
  const adapter = adapterForGroup(head);
  if (adapter) {
    return routeCommandAdapter({
      bin: "lattice",
      argv,
      args: rest,
      json: parsed.json,
      groupName: head,
      adapter,
      validateFirstRouteArg: head === "check" || head === "validate" ? false : true
    });
  }
  return createCommandRouterResult({
    bin: "lattice",
    argv,
    canonicalCommand: ["lattice", head],
    owner: "runtime",
    status: "unsupported",
    json: parsed.json,
    message: `Unsupported lattice command group: ${head}`
  });
}

function routeRuntimeCommand(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  command: RuntimeCommand,
  rest: readonly string[]
): CommandRouterResult {
  if (rest.some((arg) => helpArgs.has(arg))) {
    return routeHelp("lattice", argv, parsed.json, command);
  }
  const canonicalCommand = ["lattice", command, ...rest];
  if (rest.length > 0) {
    return createCommandRouterResult({
      bin: "lattice",
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
    bin: "lattice",
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

function adapterForGroup(groupName: string): CommandAdapter | undefined {
  if (groupName === "graph") return graphCommandAdapter;
  if (groupName === "inspect") return inspectCommandAdapter;
  if (groupName === "edit") return editCommandAdapter;
  if (groupName === "check") return checkCommandAdapter;
  if (groupName === "validate") return validateCommandAdapter;
  return undefined;
}

function routeHelp(bin: string, argv: readonly string[], json: boolean, groupName?: string): CommandRouterResult {
  const group = groupName ? commandGroupByName(groupName) : undefined;
  const canonicalCommand = group ? [...group.canonicalCommand, "help"] : ["lattice", "help"];
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
      "Lattice - Local code intelligence and edit safety for coding agents.",
      "",
      "Usage:",
      "  lattice <group> <command> [options]",
      "",
      "Groups:",
      "  graph      build/search/query repository graph context",
      "  inspect    read symbols, definitions, references, signatures, implementations, and search results",
      "  edit       create and apply validation-gated edit plans",
      "  check      run syntax, type, graph-aware, and manifest checks",
      "  validate   validate request files, hypothetical overlays, and pre-write receipts",
      "  status     show runtime readiness",
      "  doctor     show runtime diagnostics",
      "",
      "Examples:",
      "  lattice graph build --repo .",
      "  lattice graph search \"GreetingCard\" --repo . --limit 5",
      "  lattice validate pre-write --request-file ./validation-request.json --timeout-ms 30000 --json",
      "",
      "Use --json for agent integrations. Docs: https://github.com/the-open-engine/opcore#readme",
      "Groups: graph, inspect, edit, check, validate, status, doctor"
    ].join("\n");
  }
  const group = commandGroupByName(groupName);
  if (!group) return `Unknown lattice command group: ${groupName}`;
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
      "lattice doctor: router manifest valid; graph, edit, and validation engines are package-owned.",
      graphAdvice
    ].join("\n");
  }
  return ["lattice status: router ready.", graphAdvice].join("\n");
}

function graphStatusAdvice(validationStatus: ValidationStatusPayload): string {
  const graphStatus = validationStatus.graph.status;
  if (graphStatus.state === "available") return "Graph is available.";
  if (graphStatus.state === "warming") return "Graph is warming. Try again shortly or run `lattice graph status --json` for details.";
  if (graphStatus.state === "stale") return "Graph is stale. Run `lattice graph build`.";
  if (graphStatus.state === "schema_mismatch") return "Graph metadata needs rebuild. Run `lattice graph build`.";
  return "Graph is not available yet. Run `lattice graph build`.";
}

function groupSyntax(groupName: string): string {
  if (groupName === "graph") return "lattice graph <build|status|search|impact|query> --repo . [--json]";
  if (groupName === "inspect") return "lattice inspect <symbols|definition|references|signature|implementations|search> <target> --repo . [--json]";
  if (groupName === "edit") return "lattice edit <exact|patch|tree|rename|move|signature> --repo . [--json]";
  if (groupName === "check") return "lattice check <files|changed|staged|tree|all|manifest> --repo . [--json]";
  if (groupName === "validate") return "lattice validate <request|hypothetical|pre-write|manifest> --request-file <file> --json";
  if (groupName === "status") return "lattice status [--json]";
  if (groupName === "doctor") return "lattice doctor [--json]";
  return `lattice ${groupName} <command> [options]`;
}

function groupExample(groupName: string): string {
  if (groupName === "graph") return 'lattice graph search "GreetingCard" --repo . --limit 5';
  if (groupName === "inspect") return "lattice inspect signature src/components/GreetingCard.tsx GreetingCard --line 11 --repo . --json";
  if (groupName === "edit") return 'lattice edit exact --path src/a.ts --expected "old" --replacement "new" --json';
  if (groupName === "check") return "lattice check files --files src/index.ts --json";
  if (groupName === "validate") return "lattice validate pre-write --request-file ./validation-request.json --timeout-ms 30000 --json";
  if (groupName === "status") return "lattice status";
  if (groupName === "doctor") return "lattice doctor --json";
  return `lattice ${groupName} --help`;
}
