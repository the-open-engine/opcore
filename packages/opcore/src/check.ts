import type { CommandGroupContract, CommandRouterResult, ParsedCommandArgv } from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult } from "@the-open-engine/opcore-contracts";
import { formatCheckStamp } from "./plate.js";
import { checkCommandAdapter, createOpcoreCheckCommandAdapter } from "./validation-composition.js";

export interface OpcoreCheckRuntime {
  streamWriter?: (line: string) => void;
}

export interface OpcorePresentation {
  stdoutIsTTY: boolean;
  color: boolean;
}

const plainPresentation: OpcorePresentation = { stdoutIsTTY: false, color: false };

const checkGroup: CommandGroupContract = {
  name: "check",
  owner: "validation",
  canonicalCommand: ["opcore", "check"],
  commands: ["files", "staged", "changed", "tree", "all", "manifest"],
  summary: "Run Opcore validation checks."
};

const checkRoutes = new Set(checkGroup.commands);

export async function routeOpcoreCheck(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreCheckRuntime = {},
  presentation: OpcorePresentation = plainPresentation
): Promise<CommandRouterResult> {
  const rawArgs = parsed.args.slice(1);
  if (rawArgs.some((arg) => arg === "--help" || arg === "-h" || arg === "help") || rawArgs.length === 0) {
    const helpRoute = checkHelpRoute(rawArgs);
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: helpRoute === undefined ? ["opcore", "check", "help"] : ["opcore", "check", helpRoute, "help"],
      owner: "validation",
      status: "ok",
      json: parsed.json,
      message: opcoreCheckHelpMessage(helpRoute)
    });
  }
  const args = normalizeCheckArgs(rawArgs);
  const canonicalCommand = ["opcore", "check", ...args.map(canonicalCheckArg)];
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
  const adapter =
    runtime.streamWriter === undefined
      ? checkCommandAdapter
      : createOpcoreCheckCommandAdapter({
          streamWriter: runtime.streamWriter
        });
  const result = await adapter({
    schemaVersion: 1,
    bin: "opcore",
    argv,
    args,
    json: parsed.json,
    group: checkGroup,
    canonicalCommand
  });
  const fancy = presentation.stdoutIsTTY && !parsed.json;
  const message =
    fancy && result.validationResult !== undefined
      ? formatCheckStamp({
          validationResult: result.validationResult,
          scope: (firstCheckPositional(args) ?? "check").toUpperCase(),
          base: checkBaseRef(args),
          color: presentation.color
        })
      : result.message;
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand,
    owner: "validation",
    status: result.status,
    json: parsed.json,
    message,
    validationResult: result.validationResult,
    receipt: result.receipt
  });
}

function checkBaseRef(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base") return args[index + 1];
    if (arg.startsWith("--base=")) return arg.slice("--base=".length);
  }
  return undefined;
}

function normalizeCheckArgs(args: readonly string[]): string[] {
  const changedFlagIndex = args.indexOf("--changed");
  if (changedFlagIndex >= 0) {
    const rest = removeAt(args, changedFlagIndex);
    return withChangedDefaults(["changed", ...(hasBase(rest) ? rest : ["--base", "HEAD", ...rest])]);
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
  if (firstPositional === "changed") {
    normalized = withChangedDefaults(normalized);
  }
  if (firstPositional !== undefined && !checkRoutes.has(firstPositional)) {
    normalized.unshift("files");
  }
  return normalized;
}

function withChangedDefaults(args: readonly string[]): string[] {
  if (hasReportMode(args)) return [...args];
  return insertAfterFirst(args, "changed", ["--report-mode", "introduced"]);
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
    "--report-mode",
    "--request-file",
    "--timeout-ms"
  ].includes(arg);
}

function canonicalCheckArg(arg: string): string {
  return arg.length === 0 ? "<empty>" : arg;
}

function hasBase(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--base" || arg.startsWith("--base="));
}

function hasReportMode(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--report-mode" || arg.startsWith("--report-mode=") || arg === "--introduced");
}

function checkHelpRoute(args: readonly string[]): string | undefined {
  if (args.includes("--changed")) return "changed";
  if (args.includes("--staged")) return "staged";
  if (args.includes("--all")) return "all";
  for (const arg of args) {
    if (arg === "files" || arg === "changed" || arg === "staged" || arg === "all" || arg === "tree" || arg === "manifest") return arg;
    if (!arg.startsWith("-") && arg !== "help") return "files";
  }
  return undefined;
}

function opcoreCheckHelpMessage(route?: string): string {
  if (route === "changed") {
    return [
      "Usage: opcore check changed [--base <ref>] [--checks <ids>] [--json]",
      "Flags:",
      "  --base <ref>     Git base ref for changed-file scope.",
      "  --checks <ids>   Comma-separated validation check ids.",
      "  --json           Emit structured JSON.",
      "Defaults:",
      "  --base defaults to HEAD; --report-mode defaults to introduced.",
      "Examples:",
      "  opcore check --changed --json",
      "  opcore check changed --base origin/main --checks typescript.syntax --json",
      "Exit codes: 0 passed, 1 findings or errors, 64 unsupported."
    ].join("\n");
  }
  if (route === "staged") {
    return [
      "Usage: opcore check staged [--checks <ids>] [--json]",
      "Flags:",
      "  --checks <ids>   Comma-separated validation check ids.",
      "  --json           Emit structured JSON.",
      "Defaults:",
      "  Checks run on currently staged files.",
      "Examples:",
      "  opcore check --staged --json",
      "Exit codes: 0 passed, 1 findings or errors, 64 unsupported."
    ].join("\n");
  }
  if (route === "all") {
    return [
      "Usage: opcore check all [--checks <ids>] [--json]",
      "Flags:",
      "  --checks <ids>   Comma-separated validation check ids.",
      "  --json           Emit structured JSON.",
      "Defaults:",
      "  Checks run on all supported repo files.",
      "Examples:",
      "  opcore check --all --json",
      "Exit codes: 0 passed, 1 findings or errors, 64 unsupported."
    ].join("\n");
  }
  if (route === "files") {
    return [
      "Usage: opcore check files --files <path...> [--checks <ids>] [--json]",
      "Flags:",
      "  --files <path...>  Explicit repo-relative files to validate.",
      "  --checks <ids>     Comma-separated validation check ids.",
      "  --json             Emit structured JSON.",
      "Defaults:",
      "  Bare file operands are treated as files scope.",
      "Examples:",
      "  opcore check src/index.ts --checks typescript.syntax --json",
      "Exit codes: 0 passed, 1 findings or errors, 64 unsupported."
    ].join("\n");
  }
  return [
    "Usage:",
    "  opcore check --changed --json",
    "  opcore check --staged --json",
    "  opcore check --all --json",
    "  opcore check <file...> --json",
    "Flags:",
    "  --checks <ids>  Comma-separated validation check ids.",
    "  --json          Emit structured JSON.",
    "Defaults:",
    "  changed uses --base HEAD and --report-mode introduced.",
    "Examples:",
    "  opcore check --changed --json",
    "  opcore check src/index.ts --checks typescript.syntax --json",
    "Exit codes: 0 passed, 1 findings or errors, 64 unsupported."
  ].join("\n");
}
