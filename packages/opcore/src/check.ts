import type { CommandGroupContract, CommandRouterResult, ParsedCommandArgv } from "@the-open-engine/lattice-contracts";
import { createCommandRouterResult } from "@the-open-engine/lattice-contracts";
import { checkCommandAdapter } from "./validation-composition.js";

const checkGroup: CommandGroupContract = {
  name: "check",
  owner: "validation",
  canonicalCommand: ["opcore", "check"],
  commands: ["files", "staged", "changed", "tree", "all", "manifest"],
  summary: "Run Opcore validation checks."
};

const checkRoutes = new Set(checkGroup.commands);

export async function routeOpcoreCheck(argv: readonly string[], parsed: ParsedCommandArgv): Promise<CommandRouterResult> {
  const rawArgs = parsed.args.slice(1);
  if (rawArgs.some((arg) => arg === "--help" || arg === "-h" || arg === "help") || rawArgs.length === 0) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "check", "help"],
      owner: "validation",
      status: "ok",
      json: parsed.json,
      message: opcoreCheckHelpMessage()
    });
  }
  const args = normalizeCheckArgs(rawArgs);
  const canonicalCommand = ["opcore", "check", ...args];
  const firstRoute = firstCheckPositional(args);
  if (firstRoute !== undefined && !checkRoutes.has(firstRoute)) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand,
      owner: "validation",
      status: "unsupported",
      json: parsed.json,
      message: `Unsupported opcore check route: ${firstRoute}`
    });
  }
  const result = await checkCommandAdapter({
    schemaVersion: 1,
    bin: "opcore",
    argv,
    args,
    json: parsed.json,
    group: checkGroup,
    canonicalCommand
  });
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand,
    owner: "validation",
    status: result.status,
    json: parsed.json,
    message: result.message.replace(/^lattice validation/, "opcore validation").replace(/^lattice check/, "opcore check"),
    validationResult: result.validationResult,
    receipt: result.receipt
  });
}

function normalizeCheckArgs(args: readonly string[]): string[] {
  const changedFlagIndex = args.indexOf("--changed");
  if (changedFlagIndex >= 0) {
    const rest = removeAt(args, changedFlagIndex);
    return ["changed", ...(hasBase(rest) ? rest : ["--base", "HEAD", ...rest])];
  }
  const stagedFlagIndex = args.indexOf("--staged");
  if (stagedFlagIndex >= 0) {
    return ["staged", ...removeAt(args, stagedFlagIndex)];
  }
  let normalized = [...args];
  const firstPositional = firstCheckPositional(normalized);
  if (firstPositional === "changed" && !hasBase(normalized)) {
    normalized = insertAfterFirst(normalized, "changed", ["--base", "HEAD"]);
  }
  if (firstPositional !== undefined && !checkRoutes.has(firstPositional)) {
    normalized.unshift("files");
  }
  return normalized;
}

function removeAt(args: readonly string[], index: number): string[] {
  return [...args.slice(0, index), ...args.slice(index + 1)];
}

function insertAfterFirst(args: readonly string[], target: string, values: readonly string[]): string[] {
  const index = args.indexOf(target);
  if (index < 0) return [...args, ...values];
  return [...args.slice(0, index + 1), ...values, ...args.slice(index + 1)];
}

function firstCheckPositional(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--files") {
      index += 1;
      while (index < args.length && !args[index].startsWith("-")) index += 1;
      index -= 1;
      continue;
    }
    if (optionConsumesNextValue(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function optionConsumesNextValue(arg: string): boolean {
  return [
    "--repo",
    "--base",
    "--tree",
    "--changed-from",
    "--graph-mode",
    "--check",
    "--checks",
    "--request-file",
    "--timeout-ms"
  ].includes(arg);
}

function hasBase(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--base" || arg.startsWith("--base="));
}

function opcoreCheckHelpMessage(): string {
  return [
    "opcore check --changed --json",
    "opcore check --staged --json",
    "opcore check <file...> --json",
    "Exit codes: 0 passed, 1 findings or errors, 64 unsupported."
  ].join("\n");
}
