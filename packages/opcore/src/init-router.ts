import type {
  CommandRouterResult,
  ParsedCommandArgv
} from "@the-open-engine/opcore-contracts";
import { parseOpcoreInitArgs } from "./init-args.js";
import { opcoreSetupHelpMessage } from "./init-help.js";
import { createInitRouterResult } from "./init-result.js";
import { runResolvedSetup } from "./init-session.js";
import {
  HELP_ARGS
} from "./init-constants.js";
import type {
  OpcoreInitRuntime,
  OpcoreSetupCommand
} from "./init-types.js";
import { createInstallWizard } from "./init-wizard-render.js";
import { resolveRepo } from "./status.js";

export async function routeOpcoreInit(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime = {}
): Promise<CommandRouterResult> {
  return routeOpcoreSetup(argv, parsed, runtime, "init");
}

export async function routeOpcoreInstall(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime = {}
): Promise<CommandRouterResult> {
  return routeOpcoreSetup(argv, parsed, runtime, "install");
}

export async function routeOpcoreUninstall(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime = {}
): Promise<CommandRouterResult> {
  return routeOpcoreSetup(argv, parsed, runtime, "uninstall");
}

async function routeOpcoreSetup(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime,
  command: OpcoreSetupCommand
): Promise<CommandRouterResult> {
  const rest = parsed.args.slice(1);
  if (rest.some((arg) => HELP_ARGS.has(arg))) {
    return createInitRouterResult({
      argv, json: parsed.json, status: "ok", message: opcoreSetupHelpMessage(command),
      canonicalCommand: ["opcore", command, "help"]
    });
  }
  const initArgs = parseOpcoreInitArgs(rest, command);
  if (!initArgs.ok) {
    return createInitRouterResult({
      argv, json: parsed.json, status: "error", message: initArgs.message
    });
  }
  const resolution = resolveRepo(initArgs.args.repo, `opcore ${command}`);
  if (!resolution.ok) {
    return createInitRouterResult({
      argv, json: parsed.json, status: "error", message: resolution.message
    });
  }
  return runResolvedSetup({
    argv, parsed, runtime, command, options: initArgs.args,
    resolution: resolution.resolution,
    wizard: createInstallWizard(parsed.json, initArgs.args, runtime, command)
  });
}
