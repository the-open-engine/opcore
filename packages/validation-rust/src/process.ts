import { spawnSync } from "node:child_process";

export interface RustValidationProcessOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  allowedExitCodes?: readonly number[];
  input?: string;
}

export interface RustValidationProcessResult {
  command: string;
  args: readonly string[];
  status: number | null;
  ok: boolean;
  stdout: string;
  stderr: string;
  failureMessage?: string;
  timedOut: boolean;
}

export function runTool(
  command: string,
  args: readonly string[],
  options: RustValidationProcessOptions = {}
): RustValidationProcessResult {
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs
  });
  const status = result.status;
  const timedOut =
    result.signal === "SIGTERM" ||
    result.signal === "SIGKILL" ||
    (result.error as (Error & { code?: string }) | undefined)?.code === "ETIMEDOUT";
  const failureMessage = processFailureMessage({
    command,
    args,
    error: result.error,
    status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut
  });
  return {
    command,
    args,
    status,
    ok: !timedOut && status !== null && allowedExitCodes.includes(status),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    failureMessage,
    timedOut
  };
}

export function toolInvocation(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export function processFailureMessage(result: {
  command: string;
  args: readonly string[];
  error: Error | undefined;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): string | undefined {
  const invocation = toolInvocation(result.command, result.args);
  if (result.timedOut) return `${invocation} timed out`;
  if (result.error !== undefined) return `${invocation} failed to spawn: ${result.error.message}`;
  if (result.status === 0) return undefined;
  return [
    `${invocation} exited with status ${result.status ?? "unknown"}`,
    result.stderr.trim(),
    result.stdout.trim()
  ].filter((line) => line.length > 0).join("\n");
}

export function parseJsonLines(stdout: string, label = "tool"): unknown[] {
  const values: unknown[] = [];
  let lineNumber = 0;
  for (const line of stdout.split(/\r?\n/)) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(
        `${label} returned invalid JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return values;
}

export function parseJsonObject(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
