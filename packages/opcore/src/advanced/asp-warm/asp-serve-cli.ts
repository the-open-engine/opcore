import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { runAspWarmServer } from "./asp-warm-server.js";
import { createAspWarmLifecycle } from "./asp-warm-lifecycle.js";

declare const process: {
  cwd(): string;
  exit(code?: number): never;
  stdin: import("node:stream").Readable;
  stdout: import("node:stream").Writable;
  stderr: { write(text: string): void };
};

export interface RunAspWarmServeCliOptions {
  argv: readonly string[];
  bin: "opcore";
}

interface AspServeParseState {
  stdio: boolean;
  repoRoot: string;
  idleTimeoutMs: number;
}

type AspServeParseResult = { ok: true; repoRoot: string; idleTimeoutMs: number } | { ok: false; message: string };
type AspServeOptionResult = { ok: true; state: AspServeParseState; nextIndex: number } | { ok: false; message: string };

export function isAspServeTransportArgv(argv: readonly string[]): boolean {
  return argv[0] === "serve" && argv.includes("--stdio");
}

export async function runAspWarmServeCli(options: RunAspWarmServeCliOptions): Promise<number> {
  const parsed = parseAspServeArgv(options.argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 64;
  }
  const lifecycle = createAspWarmLifecycle({ repoRoot: parsed.repoRoot });
  const acquired = lifecycle.acquire({ idleTimeoutMs: parsed.idleTimeoutMs });
  if (!acquired.ok) {
    process.stderr.write(`ASP warm session already active for ${parsed.repoRoot} pid=${acquired.state.pid}\n`);
    return 1;
  }
  runAspWarmServer({
    repoRoot: parsed.repoRoot,
    input: process.stdin,
    output: process.stdout,
    lifecycle,
    idleTimeoutMs: parsed.idleTimeoutMs,
    onShutdown: () => process.exit(0)
  });
  return 0;
}

function parseAspServeArgv(argv: readonly string[]): AspServeParseResult {
  if (argv[0] !== "serve") return { ok: false, message: "ASP warm stdio transport expects serve --stdio [--repo <path>] [--idle-timeout-ms <ms>]" };
  let state: AspServeParseState = { stdio: false, repoRoot: process.cwd(), idleTimeoutMs: 300000 };
  for (let index = 1; index < argv.length;) {
    const parsed = parseAspServeOption(argv, index, state);
    if (!parsed.ok) return parsed;
    state = parsed.state;
    index = parsed.nextIndex;
  }
  return finalizeAspServeState(state);
}

function parseAspServeOption(argv: readonly string[], index: number, state: AspServeParseState): AspServeOptionResult {
  const arg = argv[index];
  if (arg === "--stdio") return { ok: true, state: { ...state, stdio: true }, nextIndex: index + 1 };
  if (arg === "--repo") return parsePathValue(argv, index, state);
  if (arg.startsWith("--repo=")) {
    return { ok: true, state: { ...state, repoRoot: realpathIfPossible(resolve(arg.slice("--repo=".length))) }, nextIndex: index + 1 };
  }
  if (arg === "--idle-timeout-ms") return parseIdleTimeoutValue(argv, index, state);
  if (arg.startsWith("--idle-timeout-ms=")) {
    return { ok: true, state: { ...state, idleTimeoutMs: Number(arg.slice("--idle-timeout-ms=".length)) }, nextIndex: index + 1 };
  }
  return { ok: false, message: `Unsupported ASP warm stdio option: ${arg}` };
}

function parsePathValue(argv: readonly string[], index: number, state: AspServeParseState): AspServeOptionResult {
  const value = argv[index + 1];
  if (!value) return { ok: false, message: "--repo requires a value" };
  return { ok: true, state: { ...state, repoRoot: realpathIfPossible(resolve(value)) }, nextIndex: index + 2 };
}

function parseIdleTimeoutValue(argv: readonly string[], index: number, state: AspServeParseState): AspServeOptionResult {
  const value = argv[index + 1];
  if (!value) return { ok: false, message: "--idle-timeout-ms requires a value" };
  return { ok: true, state: { ...state, idleTimeoutMs: Number(value) }, nextIndex: index + 2 };
}

function finalizeAspServeState(state: AspServeParseState): AspServeParseResult {
  if (!state.stdio) return { ok: false, message: "ASP warm stdio transport requires --stdio" };
  if (!Number.isFinite(state.idleTimeoutMs) || state.idleTimeoutMs <= 0) return { ok: false, message: "--idle-timeout-ms must be a positive number" };
  return { ok: true, repoRoot: realpathIfPossible(state.repoRoot), idleTimeoutMs: state.idleTimeoutMs };
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
