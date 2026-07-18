import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

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

interface ProcessCapture {
  stdout: string;
  stderr: string;
  inputFailure?: string;
  outputFailure?: string;
  spawnFailure?: string;
  timedOut: boolean;
}

interface ProcessIdentity {
  command: string;
  args: readonly string[];
  cwd: string;
  allowedExitCodes: readonly number[];
}

export async function runTool(
  command: string,
  args: readonly string[] = [],
  options: PythonToolRunOptions = {}
): Promise<PythonToolRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const allowedExitCodes = uniqueExitCodes(options.allowedExitCodes ?? [0]);
  const identity = { command, args, cwd, allowedExitCodes };
  const capture: ProcessCapture = { stdout: "", stderr: "", timedOut: false };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, {
      cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    return spawnFailure(identity, errorMessage(error));
  }
  captureProcessOutput(child, capture, options.maxOutputBytes ?? defaultMaxOutputBytes);
  const timeoutMs = options.timeoutMs ?? 10000;
  const completionPromise = waitForProcess(child, capture, timeoutMs);
  writeProcessInput(child, options.input, capture);
  const completion = await completionPromise;
  const base = processBase(identity, completion, capture);
  return classifyProcessResult(base, capture, timeoutMs);
}

function waitForProcess(
  child: ChildProcessWithoutNullStreams,
  capture: ProcessCapture,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      capture.timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    child.once("error", (error) => {
      capture.spawnFailure = errorMessage(error);
      terminateProcessTree(child);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      terminateProcessTree(child);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function captureProcessOutput(child: ChildProcessWithoutNullStreams, capture: ProcessCapture, limit: number): void {
  let bytes = 0;
  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    bytes += chunk.byteLength;
    if (bytes > limit) {
      capture.outputFailure ??= `Python tool output exceeded ${limit} bytes`;
      terminateProcessTree(child);
      return;
    }
    capture[stream] += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
}

function writeProcessInput(
  child: ChildProcessWithoutNullStreams,
  input: string | undefined,
  capture: ProcessCapture
): void {
  child.stdin.on("error", (error) => {
    if (input === undefined) return;
    capture.inputFailure ??= `Python tool stdin write failed: ${errorMessage(error)}`;
    terminateProcessTree(child);
  });
  if (input !== undefined) child.stdin.write(input, "utf8");
  child.stdin.end();
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", timeout: 1000 });
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
  }
}

function processBase(
  identity: ProcessIdentity,
  completion: { code: number | null; signal: NodeJS.Signals | null },
  capture: ProcessCapture
): PythonToolRunBase {
  return {
    command: identity.command,
    args: [...identity.args],
    cwd: identity.cwd,
    allowedExitCodes: identity.allowedExitCodes,
    exitCode: completion.code,
    signal: completion.signal,
    stdout: capture.stdout,
    stderr: capture.stderr
  };
}

function classifyProcessResult(
  base: PythonToolRunBase,
  capture: ProcessCapture,
  timeoutMs: number
): PythonToolRunResult {
  if (capture.timedOut) return { ...base, termination: "timeout", ok: false, failureMessage: `${base.command} timed out after ${timeoutMs}ms` };
  const failure = capture.spawnFailure ?? capture.inputFailure ?? capture.outputFailure;
  if (failure !== undefined || base.exitCode === null && base.signal === null) {
    return { ...base, termination: "spawn_error", ok: false, failureMessage: failure ?? `${base.command} did not report an exit status` };
  }
  if (base.signal !== null) {
    return { ...base, termination: "signal", ok: false, signal: base.signal, failureMessage: `${base.command} terminated with signal ${base.signal}` };
  }
  const exitCode = base.exitCode as number;
  const ok = base.allowedExitCodes.includes(exitCode);
  return {
    ...base,
    termination: "exited",
    ok,
    exitCode,
    signal: null,
    ...(ok ? {} : { failureMessage: `${base.command} exited with code ${exitCode}; expected ${base.allowedExitCodes.join(" or ")}` })
  };
}

function spawnFailure(
  identity: ProcessIdentity,
  failureMessage: string
): PythonToolSpawnErrorResult {
  return {
    command: identity.command, args: [...identity.args], cwd: identity.cwd,
    allowedExitCodes: identity.allowedExitCodes, exitCode: null, signal: null,
    stdout: "", stderr: "", termination: "spawn_error", ok: false, failureMessage
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueExitCodes(exitCodes: readonly number[]): readonly number[] {
  if (exitCodes.length === 0 || exitCodes.some((code) => !Number.isInteger(code) || code < 0)) {
    throw new Error("Python tool allowedExitCodes must contain non-negative integers");
  }
  return [...new Set(exitCodes)].sort((left, right) => left - right);
}
