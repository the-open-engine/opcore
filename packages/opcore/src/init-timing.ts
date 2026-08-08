import type { OpcoreInitPlanPayload, OpcoreInitTiming } from "@the-open-engine/opcore-contracts";
import type {
  InitContext,
  OpcoreInitRuntime,
  OpcoreSetupCommand,
  TimingState
} from "./init-types.js";
import { DEFAULT_INIT_PROGRESS_INTERVAL_MS } from "./init-constants.js";

export interface InitScanProgress {
  complete(scanMs: number, totalFiles?: number): void;
  fail(scanMs: number): void;
}

export function createTimingState(): TimingState {
  return {
    startedAt: nowMs(),
    scanMs: 0,
    planMs: 0,
    promptMs: 0,
    applyMs: 0
  };
}

export function withContext(
  payload: OpcoreInitPlanPayload,
  context: InitContext,
  timing: TimingState
): OpcoreInitPlanPayload {
  return {
    ...payload,
    scan: context.scan,
    settings: context.settings,
    interaction: context.interaction,
    timings: finalizeTimings(timing)
  };
}

export function startInitScanProgress(
  json: boolean,
  runtime: OpcoreInitRuntime,
  command: OpcoreSetupCommand
): InitScanProgress | undefined {
  if (json || runtime.stderrIsTTY !== true || typeof runtime.writeStderr !== "function") return undefined;
  const startedAt = nowMs();
  const intervalMs = normalizeProgressIntervalMs(runtime.initProgressIntervalMs);
  let finished = false;
  const write = (text: string) => writeProgress(runtime.writeStderr, text);
  const writeProgressLine = (text: string) => write(`\r\x1b[2K${text}`);
  write(`Opcore ${command}: scanning repository before setup...`);
  const timer = setInterval(() => {
    if (finished) return;
    const elapsedSeconds = Math.max(1, Math.floor(elapsedMs(startedAt) / 1000));
    writeProgressLine(`Opcore ${command}: still scanning repository before setup (${elapsedSeconds}s elapsed)...`);
  }, intervalMs) as ReturnType<typeof setInterval> & { unref?: () => void };
  timer.unref?.();
  return {
    complete: (scanMs) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      writeProgressLine(`Opcore ${command}: scan complete in ${scanMs}ms.\n`);
    },
    fail: (scanMs) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      writeProgressLine(`Opcore ${command}: scan failed after ${scanMs}ms.\n`);
    }
  };
}

function normalizeProgressIntervalMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_INIT_PROGRESS_INTERVAL_MS;
}

export function writeProgress(writeStderr: ((text: string) => void) | undefined, text: string): void {
  try {
    writeStderr?.(text);
  } catch {
    // Progress output must never change init scan/apply semantics.
  }
}

export function nowMs(): number {
  return Date.now();
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export function finalizeTimings(timing: TimingState): OpcoreInitTiming {
  return {
    scanMs: timing.scanMs,
    planMs: timing.planMs,
    promptMs: timing.promptMs,
    applyMs: timing.applyMs,
    totalMs: elapsedMs(timing.startedAt),
    firstOutputMs: timing.scanMs
  };
}
