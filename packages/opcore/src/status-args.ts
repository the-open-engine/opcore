declare const process: {
  cwd(): string;
};

const helpArgs = new Set(["--help", "-h", "help"]);

export interface OpcoreStatusArgs {
  repo: string;
  showAspLine: boolean;
}

export function parseOpcoreStatusArgs(
  args: readonly string[]
): { ok: true; repo: string; showAspLine: boolean } | { ok: false; message: string } {
  let parsed: OpcoreStatusArgs = { repo: process.cwd(), showAspLine: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (helpArgs.has(arg)) return { ok: false, message: opcoreStatusHelpMessage() };
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, message: "opcore status: --repo requires a path" };
      parsed = { ...parsed, repo: value };
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) return { ok: false, message: "opcore status: --repo requires a path" };
      parsed = { ...parsed, repo: value };
      continue;
    }
    if (arg === "--verbose" || arg === "--asp") {
      parsed = { ...parsed, showAspLine: true };
      continue;
    }
    return { ok: false, message: `opcore status: unsupported argument ${arg}` };
  }
  return { ok: true, ...parsed };
}

export function parseOpcoreRepoArgs(
  args: readonly string[],
  command: string
): { ok: true; repo: string } | { ok: false; message: string } {
  let repo = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (helpArgs.has(arg)) return { ok: false, message: opcoreStatusHelpMessage() };
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, message: `${command}: --repo requires a path` };
      repo = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) return { ok: false, message: `${command}: --repo requires a path` };
      repo = value;
      continue;
    }
    return { ok: false, message: `${command}: unsupported argument ${arg}` };
  }
  return { ok: true, repo };
}

export function opcoreStatusHelpMessage(): string {
  return [
    "Usage: opcore status [--repo <path>] [--verbose] [--json]",
    "Flags:",
    "  --repo <path>  Repository root to inspect.",
    "  --verbose      Include non-enrolled ASP state in human output.",
    "  --asp          Include ASP state in human output.",
    "  --json         Emit structured JSON.",
    "Defaults:",
    "  --repo defaults to the current working directory; status is read-only.",
    "Examples:",
    "  opcore status --repo . --json",
    "Exit codes: 0 status produced, 1 invalid repo or status error, 64 unsupported."
  ].join("\n");
}

export function isStatusHelpArg(arg: string): boolean {
  return helpArgs.has(arg);
}
