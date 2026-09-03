import type { CommandRouterResult } from "@the-open-engine/opcore-contracts";
import type { InstallWizardRenderer } from "./install-wizard.js";
import { createOpcoreScanAnalysis } from "./scan.js";
import { initHomeRoot } from "./init-prompts.js";
import { routeOpcoreInitPlanOrApply } from "./init-plan-flow.js";
import { createInitRouterResult } from "./init-result.js";
import { createInitScanSummary, createInitSettings } from "./init-settings.js";
import {
  createTimingState,
  elapsedMs,
  finalizeTimings,
  nowMs,
  startInitScanProgress,
  type InitScanProgress
} from "./init-timing.js";
import type {
  OpcoreInitRuntime,
  OpcoreSetupCommand,
  ParsedInitArgs,
  SetupSession
} from "./init-types.js";
import { routeOpcoreInitUndo } from "./init-undo-flow.js";
import { runInstallWizardFlow } from "./init-wizard-flow.js";
import {
  repoDisplayLabel,
  startWizardScanProgress
} from "./init-wizard-render.js";
import type { RepoResolution } from "./status.js";
import type { ParsedCommandArgv } from "@the-open-engine/opcore-contracts";
import { errorMessage } from "./init-data.js";

export interface ResolvedSetupInput {
  argv: readonly string[];
  parsed: ParsedCommandArgv;
  runtime: OpcoreInitRuntime;
  command: OpcoreSetupCommand;
  options: ParsedInitArgs;
  resolution: RepoResolution;
  wizard?: InstallWizardRenderer;
}

export async function runResolvedSetup(input: ResolvedSetupInput): Promise<CommandRouterResult> {
  try {
    const timing = createTimingState();
    const analysis = await scanForSetup(input, timing);
    const context = {
      scan: createInitScanSummary(analysis.repoState, analysis.validationResult),
      settings: createInitSettings(analysis.repoState),
      interaction: { tty: isInteractive(input.runtime), promptState: "not_requested" as const },
      timings: finalizeTimings(timing)
    };
    const session: SetupSession = {
      argv: input.argv, json: input.parsed.json, parsed: input.parsed,
      repoRoot: input.resolution.root, requestedPath: input.resolution.requestedPath,
      git: input.resolution.git, homeRoot: initHomeRoot(input.runtime),
      options: input.options, context, timing, runtime: input.runtime, command: input.command
    };
    if (session.options.undo) return routeOpcoreInitUndo(session);
    if (input.wizard) return await runInstallWizardFlow({ ...session, wizard: input.wizard });
    return await routeOpcoreInitPlanOrApply(session);
  } catch (error) {
    return createInitRouterResult({
      argv: input.argv, json: input.parsed.json, status: "error",
      message: `opcore ${input.command} failed: ${errorMessage(error)}`
    });
  } finally {
    input.wizard?.showCursor();
  }
}

async function scanForSetup(
  input: ResolvedSetupInput,
  timing: ReturnType<typeof createTimingState>
): Promise<Awaited<ReturnType<typeof createOpcoreScanAnalysis>>> {
  const startedAt = nowMs();
  const progress = setupProgress(input);
  const scan = input.runtime.scanAnalysis ?? createOpcoreScanAnalysis;
  try {
    const analysis = await scan(input.resolution);
    timing.scanMs = elapsedMs(startedAt);
    progress?.complete(timing.scanMs, analysis.repoState.coverage.totalFiles);
    return analysis;
  } catch (error) {
    timing.scanMs = elapsedMs(startedAt);
    progress?.fail(timing.scanMs);
    throw error;
  }
}

function setupProgress(input: ResolvedSetupInput): InitScanProgress | undefined {
  if (input.wizard) {
    return startWizardScanProgress(
      input.wizard, input.runtime,
      repoDisplayLabel(input.resolution.root, initHomeRoot(input.runtime))
    );
  }
  return startInitScanProgress(input.parsed.json, input.runtime, input.command);
}

function isInteractive(runtime: OpcoreInitRuntime): boolean {
  return runtime.stdinIsTTY === true && runtime.stdoutIsTTY === true;
}
