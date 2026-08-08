import { withoutUndefinedProperties } from "../shared/primitives.js";
import { validateCommandAdapterRequest } from "./adapter-validator.js";
import type { CommandGroupContract } from "./contracts.js";
import { commandRouterManifest } from "./manifest.js";
import { commandGroupByName, commandHelpMessage } from "./router-02.js";
import type {
  CommandAdapterRequest,
  CommandRouterResult,
  CommandRouterResultInput,
  ParsedCommandArgv,
  RouteCommandAdapterOptions,
  RunCommandAdapterCliOptions,
} from "./router-contracts.js";
import { validateCommandRouterResult } from "./validators.js";
import type { CommandRouteStatus } from "./vocabulary.js";

declare const process: {
  argv: string[];
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
};

const commandHelpArgs = new Set(["--help", "-h", "help"]);

export { commandHelpArgs };

function parseCommandArgv(argv: readonly string[]): ParsedCommandArgv {
  return {
    args: argv.filter((arg) => arg !== "--json"),
    json: argv.includes("--json"),
  };
}

export { parseCommandArgv };

function normalizeCommandBin(bin: string): string {
  const normalized = bin.replaceAll("\\", "/").split("/").at(-1) ?? bin;
  return normalized.endsWith(".js") ? "opcore" : normalized;
}

export { normalizeCommandBin };

function commandExitCodeForStatus(status: CommandRouteStatus): number {
  if (status === "ok") return commandRouterManifest.exitSemantics.ok;
  if (status === "error") return commandRouterManifest.exitSemantics.error;
  if (status === "not_implemented") return commandRouterManifest.exitSemantics.notImplemented;
  return commandRouterManifest.exitSemantics.unsupported;
}

export { commandExitCodeForStatus };

function createCommandRouterResult(input: CommandRouterResultInput): CommandRouterResult {
  return validateCommandRouterResult(
    withoutUndefinedProperties({
      schemaVersion: 1,
      bin: input.bin,
      argv: input.argv,
      canonicalCommand: input.canonicalCommand,
      owner: input.owner,
      status: input.status,
      exitCode: commandExitCodeForStatus(input.status),
      message: input.message,
      json: input.json,
      providerStatus: input.providerStatus,
      graphPipeline: input.graphPipeline,
      graphQuery: input.graphQuery,
      graphSearch: input.graphSearch,
      inspectResult: input.inspectResult,
      graphImpact: input.graphImpact,
      graphReviewContext: input.graphReviewContext,
      graphChanges: input.graphChanges,
      graphServe: input.graphServe,
      validationResult: input.validationResult,
      validationStatus: input.validationStatus,
      receipt: input.receipt,
      editPlan: input.editPlan,
      editResult: input.editResult,
      repoState: input.repoState,
      runtimeInfo: input.runtimeInfo,
      opcoreDoctor: input.opcoreDoctor,
      opcoreInit: input.opcoreInit,
      opcoreMeasure: input.opcoreMeasure,
      opcoreTry: input.opcoreTry,
      timing: input.timing,
    }) as CommandRouterResult,
  );
}

export { createCommandRouterResult };

async function routeCommandAdapter(options: RouteCommandAdapterOptions): Promise<CommandRouterResult> {
  const parsedArgv = parseCommandArgv(options.argv);
  const parsed = resolveParsedCommandArgv(options, parsedArgv);
  const bin = normalizeCommandBin(options.bin);
  const group = commandGroupByName(options.groupName);
  if (!group) {
    return unsupportedCommandGroupResult(options, bin, parsed.json);
  }

  if (shouldShowCommandHelp(options, group, parsed.args)) {
    const routeName = parsed.args.find((arg) => !commandHelpArgs.has(arg) && !arg.startsWith("-"));
    return commandHelpResult(bin, options.argv, parsed.json, group.name, routeName);
  }

  const canonicalCommand = [...group.canonicalCommand, ...parsed.args.map(canonicalCommandArg)];
  const firstRouteArg = parsed.args.find((arg) => !arg.startsWith("-"));
  if (isUnsupportedCommandRoute(options, group, firstRouteArg)) {
    return unsupportedCommandRouteResult({ options, bin, json: parsed.json, group, canonicalCommand });
  }

  const adapterRequest = validateCommandAdapterRequest({
    schemaVersion: 1,
    bin,
    argv: options.argv,
    args: parsed.args,
    json: parsed.json,
    group,
    canonicalCommand,
  });
  return invokeCommandAdapter({ options, adapterRequest, bin, json: parsed.json, group, canonicalCommand });
}

export { routeCommandAdapter };

function resolveParsedCommandArgv(
  options: RouteCommandAdapterOptions,
  parsed: ParsedCommandArgv,
): ParsedCommandArgv {
  return {
    args: options.args ?? parsed.args,
    json: options.json ?? parsed.json,
  };
}

function shouldShowCommandHelp(
  options: RouteCommandAdapterOptions,
  group: CommandGroupContract,
  args: readonly string[],
): boolean {
  const showHelpOnEmpty = options.showHelpOnEmpty ?? group.name !== "check";
  return args.some((arg) => commandHelpArgs.has(arg)) || (args.length === 0 && showHelpOnEmpty);
}

function isUnsupportedCommandRoute(
  options: RouteCommandAdapterOptions,
  group: CommandGroupContract,
  firstRouteArg: string | undefined,
): boolean {
  const validateFirstRouteArg = options.validateFirstRouteArg !== false;
  return Boolean(validateFirstRouteArg && firstRouteArg && !group.commands.includes(firstRouteArg));
}

function unsupportedCommandGroupResult(
  options: RouteCommandAdapterOptions,
  bin: string,
  json: boolean,
): CommandRouterResult {
  return createCommandRouterResult({
    bin,
    argv: options.argv,
    canonicalCommand: ["opcore", options.groupName],
    owner: "runtime",
    status: "unsupported",
    json,
    message: `Unsupported opcore command group: ${options.groupName}`,
  });
}

export { unsupportedCommandGroupResult };

interface CommandRouteResultContext {
  options: RouteCommandAdapterOptions;
  bin: string;
  json: boolean;
  group: CommandGroupContract;
  canonicalCommand: readonly string[];
}

function unsupportedCommandRouteResult(context: CommandRouteResultContext): CommandRouterResult {
  const { options, bin, json, group, canonicalCommand } = context;
  return createCommandRouterResult({
    bin,
    argv: options.argv,
    canonicalCommand,
    owner: group.owner,
    status: "unsupported",
    json,
    message: `${canonicalCommand.join(" ")} is not a supported ${group.name} route.`,
  });
}

export { unsupportedCommandRouteResult };

async function invokeCommandAdapter(
  context: CommandRouteResultContext & { adapterRequest: CommandAdapterRequest },
): Promise<CommandRouterResult> {
  const { options, adapterRequest, bin, json, group, canonicalCommand } = context;
  try {
    return validateCommandRouterResult(await options.adapter(adapterRequest));
  } catch (error) {
    return createCommandRouterResult({
      bin,
      argv: options.argv,
      canonicalCommand,
      owner: group.owner,
      status: "error",
      json,
      message: `${canonicalCommand.join(" ")} failed: ${errorMessage(error)}`,
    });
  }
}

export { invokeCommandAdapter };

async function runCommandAdapterCli(options: RunCommandAdapterCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const argv = options.argv ?? process.argv.slice(2);
  const routed = await routeCommandAdapter({
    ...options,
    argv,
  });
  const text = routed.json ? JSON.stringify(routed) : routed.message;
  const write = routed.json || routed.status === "ok" ? stdout : stderr;
  write(`${text}\n`);
  return routed.exitCode;
}

export { runCommandAdapterCli };

function commandHelpResult(
  ...args: readonly [bin: string, argv: readonly string[], json: boolean, groupName?: string, routeName?: string]
): CommandRouterResult {
  const [bin, argv, json, groupName, routeName] = args;
  const group = groupName ? commandGroupByName(groupName) : undefined;
  const canonicalCommand =
    group && routeName
      ? [...group.canonicalCommand, routeName, "help"]
      : group
        ? [...group.canonicalCommand, "help"]
        : ["opcore", "help"];
  return createCommandRouterResult({
    bin,
    argv,
    canonicalCommand,
    owner: group?.owner ?? "runtime",
    status: "ok",
    json,
    message: commandHelpMessage(groupName, routeName),
  });
}

export { commandHelpResult };

function canonicalCommandArg(arg: string): string {
  return arg.length === 0 ? "<empty>" : arg;
}

export { canonicalCommandArg };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { errorMessage };
