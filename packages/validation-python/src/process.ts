import { spawnSync } from "node:child_process";

export interface PythonToolRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failureMessage?: string;
}

export interface PythonToolRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  input?: string;
}

export function runTool(
  command: string,
  args: readonly string[] = [],
  options: PythonToolRunOptions = {}
): PythonToolRunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 10000,
    input: options.input
  });
  const failureMessage =
    result.error?.message ??
    (result.signal !== null ? `${command} terminated with signal ${result.signal}` : undefined);
  return {
    ok: result.status === 0 && failureMessage === undefined,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(failureMessage !== undefined ? { failureMessage } : {})
  };
}
