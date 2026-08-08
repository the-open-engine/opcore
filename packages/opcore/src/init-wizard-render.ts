import { sep } from "node:path";
import {
  createInstallWizardRenderer,
  type InstallWizardRenderer
} from "./install-wizard.js";
import { isInteractiveRuntime } from "./init-prompts.js";
import { elapsedMs, nowMs, writeProgress, type InitScanProgress } from "./init-timing.js";
import type {
  OpcoreInitRuntime,
  OpcoreSetupCommand,
  ParsedInitArgs
} from "./init-types.js";

export function createInstallWizard(
  json: boolean,
  options: ParsedInitArgs,
  runtime: OpcoreInitRuntime,
  command: OpcoreSetupCommand
): InstallWizardRenderer | undefined {
  if (command !== "install" || json || options.approved || options.dryRun || options.undo) return undefined;
  if (!isInteractiveRuntime(runtime) || runtime.stderrIsTTY !== true) return undefined;
  if (typeof runtime.readKey !== "function" || typeof runtime.writeStderr !== "function") return undefined;
  const writeStderr = runtime.writeStderr;
  return createInstallWizardRenderer(
    {
      write: (text) => writeProgress(writeStderr, text),
      readKey: runtime.readKey,
      color: runtime.stderrColor === true,
      motion: runtime.initWizardMotion !== false
    },
    runtime.stderrTrueColor === true
  );
}

export function startWizardScanProgress(
  wizard: InstallWizardRenderer,
  runtime: OpcoreInitRuntime,
  repoLabel: string
): InitScanProgress {
  wizard.hideCursor();
  wizard.header(repoLabel);
  const startedAt = nowMs();
  let finished = false;
  let frame = 0;
  wizard.scanFrame(frame, 0);
  const intervalMs = runtime.initWizardMotion === false ? 0 : 120;
  const timer = intervalMs > 0
    ? (setInterval(() => {
      if (finished) return;
      frame += 1;
      wizard.scanFrame(frame, elapsedMs(startedAt));
    }, intervalMs) as ReturnType<typeof setInterval> & { unref?: () => void })
    : undefined;
  timer?.unref?.();
  return {
    complete: (scanMs, totalFiles) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      wizard.scanDone(scanMs, totalFiles);
    },
    fail: (scanMs) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      wizard.scanFailed(scanMs);
    }
  };
}

export function repoDisplayLabel(root: string, homeRoot: string): string {
  if (root === homeRoot) return "~";
  return root.startsWith(`${homeRoot}${sep}`) ? `~${root.slice(homeRoot.length)}` : root;
}
