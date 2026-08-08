import type {
  InitScope,
  OpcoreSetupCommand,
  ParsedInitArgs
} from "./init-types.js";

declare const process: { cwd(): string };

type FlagHandler = (parsed: ParsedInitArgs) => void;

interface RepoArgumentResult {
  handled: boolean;
  consumed: number;
  message?: string;
}

export function parseOpcoreInitArgs(
  args: readonly string[],
  command: OpcoreSetupCommand
): { ok: true; args: ParsedInitArgs } | { ok: false; message: string } {
  const parsed = createDefaultArgs(command);
  const handlers = createFlagHandlers(command);
  for (let index = 0; index < args.length; index += 1) {
    const repoArgument = parseRepoArgument(args, index, parsed, command);
    if (repoArgument.message) return { ok: false, message: repoArgument.message };
    if (repoArgument.handled) {
      index += repoArgument.consumed;
      continue;
    }
    const handler = handlers[args[index]];
    if (!handler) return { ok: false, message: `opcore ${command}: unsupported argument ${args[index]}` };
    handler(parsed);
  }
  return { ok: true, args: parsed };
}

function createDefaultArgs(command: OpcoreSetupCommand): ParsedInitArgs {
  return {
    command,
    repo: process.cwd(),
    repoExplicit: false,
    scope: "repo",
    scopeExplicit: false,
    approved: false,
    dryRun: false,
    failClosedHook: false,
    agentSkill: command === "install",
    writeGateHooks: true,
    activePreCommitHook: command === "install",
    undo: command === "uninstall"
  };
}

function createFlagHandlers(command: OpcoreSetupCommand): Record<string, FlagHandler> {
  const handlers: Record<string, FlagHandler> = {
    "--global": (parsed) => setScope(parsed, "global"),
    "--local": (parsed) => setScope(parsed, "repo"),
    "--approve": approve,
    "--yes": approve,
    "--dry-run": (parsed) => {
      parsed.dryRun = true;
    },
    "--fail-closed-hook": (parsed) => {
      parsed.failClosedHook = true;
    }
  };
  if (command === "install") {
    handlers["--no-pre-commit"] = (parsed) => {
      parsed.activePreCommitHook = false;
    };
    handlers["--no-skill"] = (parsed) => {
      parsed.agentSkill = false;
    };
  } else {
    handlers["--undo"] = (parsed) => {
      parsed.undo = true;
    };
  }
  return handlers;
}

function parseRepoArgument(
  args: readonly string[],
  index: number,
  parsed: ParsedInitArgs,
  command: OpcoreSetupCommand
): RepoArgumentResult {
  const arg = args[index];
  if (arg === "--repo") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return { handled: true, consumed: 0, message: `opcore ${command}: --repo requires a path` };
    }
    setRepo(parsed, value);
    return { handled: true, consumed: 1 };
  }
  if (!arg.startsWith("--repo=")) return { handled: false, consumed: 0 };
  const value = arg.slice("--repo=".length);
  if (!value) return { handled: true, consumed: 0, message: `opcore ${command}: --repo requires a path` };
  setRepo(parsed, value);
  return { handled: true, consumed: 0 };
}

function setRepo(parsed: ParsedInitArgs, repo: string): void {
  parsed.repo = repo;
  parsed.repoExplicit = true;
  setScope(parsed, "repo");
}

function setScope(parsed: ParsedInitArgs, scope: InitScope): void {
  parsed.scope = scope;
  parsed.scopeExplicit = true;
}
function approve(parsed: ParsedInitArgs): void {
  parsed.approved = true;
}
