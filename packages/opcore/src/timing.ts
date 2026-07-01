import type {
  CommandLatencyRecord,
  CommandRouterResult,
  CommandTiming,
  CommandTimingPhase,
  CommandTimingProcessState,
  OpcoreRepoStatePayload
} from "@the-open-engine/opcore-contracts";
import {
  validateCommandLatencyRecord,
  validateCommandTiming
} from "@the-open-engine/opcore-contracts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let firstTimedCommand = true;
let cachedOpcoreVersion: string | undefined;

export async function timeCommand(dispatch: () => CommandRouterResult | Promise<CommandRouterResult>): Promise<CommandRouterResult> {
  const startedAt = Date.now();
  // Process state is intentionally process-local and write-free: the first routed command in this Node process is cold, later routed commands are warm.
  const processState: CommandTimingProcessState = firstTimedCommand ? "cold" : "warm";
  firstTimedCommand = false;
  const result = await dispatch();
  return attachCommandTiming(result, {
    durationMs: elapsedMs(startedAt),
    processState
  });
}

export function attachCommandTiming(
  result: CommandRouterResult,
  timing: Pick<CommandTiming, "durationMs" | "processState">
): CommandRouterResult {
  const phases = collectTimingPhases(result);
  return {
    ...result,
    timing: validateCommandTiming({
      durationMs: timing.durationMs,
      phases,
      processState: timing.processState,
      ...(phases.length === 0 ? { degradations: ["no_source"] as const } : {})
    })
  };
}

export function collectTimingPhases(result: CommandRouterResult): CommandTimingPhase[] {
  const phases: CommandTimingPhase[] = [];
  for (const phase of result.graphPipeline?.summary.phaseTimings ?? []) {
    phases.push(withOptionalFileCount({
      phase: normalizePhaseId(phase.phase, "graph"),
      durationMs: phase.durationMs
    }, phase.fileCount));
  }
  const validationDurationMs = result.validationResult?.manifest?.durationMs;
  if (isNonNegativeFiniteNumber(validationDurationMs)) {
    phases.push({
      phase: "validation",
      durationMs: validationDurationMs
    });
  }
  for (const run of result.validationResult?.manifest?.runs ?? []) {
    if (!isNonNegativeFiniteNumber(run.durationMs)) continue;
    phases.push({
      phase: `validation_${normalizePhaseId(run.checkId, "check")}`,
      durationMs: run.durationMs
    });
  }
  const prewriteDurationMs = result.receipt?.durationMs;
  if (isNonNegativeFiniteNumber(prewriteDurationMs)) {
    phases.push({
      phase: "prewrite",
      durationMs: prewriteDurationMs
    });
  }
  return phases;
}

export function createCommandLatencyRecord(
  result: CommandRouterResult,
  repoState: OpcoreRepoStatePayload = requireRepoState(result),
  recordedAt = new Date().toISOString()
): CommandLatencyRecord {
  return validateCommandLatencyRecord({
    schemaVersion: 1,
    recordedAt,
    bin: sanitizeTelemetryBin(result.bin),
    canonicalCommand: sanitizeCanonicalCommand(result.canonicalCommand, result.bin),
    owner: result.owner,
    status: result.status,
    exitCode: result.exitCode,
    repo: {
      totalFiles: repoState.coverage.totalFiles,
      languages: repoState.coverage.languages.map((entry) => ({
        language: entry.language,
        files: entry.files
      })),
      graph: {
        supportedFiles: repoState.coverage.graph.supportedFiles,
        unsupportedFiles: Math.max(0, repoState.coverage.totalFiles - repoState.coverage.graph.supportedFiles)
      },
      git: {
        available: repoState.repo.git.available,
        ...(typeof repoState.repo.git.clean === "boolean" ? { clean: repoState.repo.git.clean } : {})
      }
    },
    timing: validateCommandTiming(requireMeasuredCommandTiming(result)),
    opcoreVersion: readOpcoreVersion()
  });
}

function requireRepoState(result: CommandRouterResult): OpcoreRepoStatePayload {
  if (!result.repoState) throw new Error("Command latency telemetry requires repoState");
  return result.repoState;
}

function requireMeasuredCommandTiming(result: CommandRouterResult): CommandTiming {
  if (!result.timing) {
    throw new Error("Command latency telemetry requires measured command timing");
  }
  return result.timing;
}

function withOptionalFileCount(phase: Pick<CommandTimingPhase, "phase" | "durationMs">, fileCount: number | undefined): CommandTimingPhase {
  return isNonNegativeFiniteNumber(fileCount)
    ? { ...phase, fileCount }
    : phase;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizePhaseId(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/[_-]+$/g, "");
  return /^[a-z][a-z0-9_-]*$/.test(normalized) ? normalized : fallback;
}

function sanitizeTelemetryBin(bin: string): CommandLatencyRecord["bin"] {
  const graphCliBin = ["lat", "tice"].join("");
  if (bin === graphCliBin) return graphCliBin as CommandLatencyRecord["bin"];
  if (bin === "opcore" || bin === "opcore-asp-provider") return bin;
  return "opcore";
}

function sanitizeCanonicalCommand(command: readonly string[], bin: string): readonly string[] {
  const tokens = command.length > 0 ? command : [sanitizeTelemetryBin(bin), "unknown"];
  const sanitized = tokens.map((token) => sanitizeCanonicalToken(token));
  return sanitized.length > 0 ? sanitized : [sanitizeTelemetryBin(bin), "unknown"];
}

function sanitizeCanonicalToken(token: string): string {
  const normalized = token.trim();
  if (isSafeCanonicalToken(normalized)) return normalized;
  if (normalized.startsWith("--")) {
    const flag = normalized.split("=")[0];
    if (isSafeCanonicalToken(flag)) return flag;
  }
  return "arg";
}

function isSafeCanonicalToken(token: string): boolean {
  return (
    /^(?=.*[A-Za-z0-9])[-@A-Za-z0-9._,:=]+$/.test(token) &&
    !token.includes("/") &&
    !token.includes("\\") &&
    token !== "." &&
    token !== ".." &&
    !token.startsWith("~") &&
    !/^[A-Za-z]:/.test(token) &&
    !/^file:/i.test(token) &&
    !/\.(?:[cm]?[tj]sx?|mjs|cjs|jsonl?|rs|pyi?|mdx?|toml|lock|ya?ml|txt|inc|css|s[ac]ss|html?|vue|svelte|go|java|rb|php|swift|kts?|scala|lua|cs|c|cc|cpp|h|hpp)(?:$|[,=:])/i.test(token)
  );
}

function readOpcoreVersion(): string {
  if (cachedOpcoreVersion !== undefined) return cachedOpcoreVersion;
  try {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    cachedOpcoreVersion = typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "0.1.0";
  } catch {
    cachedOpcoreVersion = "0.1.0";
  }
  return cachedOpcoreVersion;
}
