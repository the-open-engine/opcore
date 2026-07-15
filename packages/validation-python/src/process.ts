import { spawnSync } from "node:child_process";

const defaultMaxOutputBytes = 1024 * 1024;

interface PythonToolRunBase {
  command: string;
  args: readonly string[];
  cwd: string;
  allowedExitCodes: readonly number[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  failureMessage?: string;
}

export interface PythonToolExitedResult extends PythonToolRunBase {
  termination: "exited";
  ok: boolean;
  exitCode: number;
  signal: null;
}

export interface PythonToolTimeoutResult extends PythonToolRunBase {
  termination: "timeout";
  ok: false;
}

export interface PythonToolSignalResult extends PythonToolRunBase {
  termination: "signal";
  ok: false;
  signal: string;
}

export interface PythonToolSpawnErrorResult extends PythonToolRunBase {
  termination: "spawn_error";
  ok: false;
  failureMessage: string;
}

export type PythonToolRunResult =
  | PythonToolExitedResult
  | PythonToolTimeoutResult
  | PythonToolSignalResult
  | PythonToolSpawnErrorResult;

export interface PythonToolRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  input?: string;
  allowedExitCodes?: readonly number[];
  maxOutputBytes?: number;
}

export function runTool(
  command: string,
  args: readonly string[] = [],
  options: PythonToolRunOptions = {}
): PythonToolRunResult {
  const cwd = options.cwd ?? process.cwd();
  const allowedExitCodes = uniqueExitCodes(options.allowedExitCodes ?? [0]);
  const result = spawnSync(command, args, {
    cwd,
    env: options.env,
    encoding: "utf8",
    stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 10000,
    maxBuffer: options.maxOutputBytes ?? defaultMaxOutputBytes,
    input: options.input
  });
  const base = {
    command,
    args: [...args],
    cwd,
    allowedExitCodes,
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };

  if (isTimeoutError(result.error)) {
    return {
      ...base,
      termination: "timeout",
      ok: false,
      failureMessage: `${command} timed out after ${options.timeoutMs ?? 10000}ms`
    };
  }
  if (result.signal !== null) {
    return {
      ...base,
      termination: "signal",
      ok: false,
      signal: result.signal,
      failureMessage: `${command} terminated with signal ${result.signal}`
    };
  }
  if (result.error !== undefined || result.status === null) {
    return {
      ...base,
      termination: "spawn_error",
      ok: false,
      failureMessage: result.error?.message ?? `${command} did not report an exit status`
    };
  }
  return {
    ...base,
    termination: "exited",
    ok: allowedExitCodes.includes(result.status),
    exitCode: result.status,
    signal: null,
    ...(allowedExitCodes.includes(result.status)
      ? {}
      : { failureMessage: `${command} exited with code ${result.status}; expected ${allowedExitCodes.join(" or ")}` })
  };
}

function isTimeoutError(error: Error | undefined): boolean {
  return (error as (Error & { code?: string }) | undefined)?.code === "ETIMEDOUT";
}

function uniqueExitCodes(exitCodes: readonly number[]): readonly number[] {
  if (exitCodes.length === 0 || exitCodes.some((code) => !Number.isInteger(code) || code < 0)) {
    throw new Error("Python tool allowedExitCodes must contain non-negative integers");
  }
  return [...new Set(exitCodes)].sort((left, right) => left - right);
}
