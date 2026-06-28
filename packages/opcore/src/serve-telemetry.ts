import type { CommandRouterResult, OpcoreRepoStatePayload } from "@the-open-engine/opcore-contracts";
import type { GraphServeTelemetry } from "@the-open-engine/opcore-graph";
import { writeCommandLatencyTelemetry } from "./reporting.js";
import { createRepoState, resolveRepo } from "./status.js";
import { createCommandLatencyRecord } from "./timing.js";

export function createGraphServeTelemetry(): GraphServeTelemetry {
  const repoStateCache = new Map<string, OpcoreRepoStatePayload>();
  return {
    recordFrameTiming(event): void {
      const repoRoot = event.repo.repoRoot;
      if (!repoRoot) return;
      const repoState = cachedRepoState(repoStateCache, repoRoot);
      if (!repoState) return;
      const result: CommandRouterResult = {
        schemaVersion: 1,
        bin: "opcore",
        argv: event.canonicalCommand,
        canonicalCommand: event.canonicalCommand,
        owner: event.owner,
        status: event.status,
        exitCode: event.exitCode,
        message: `${event.canonicalCommand.join(" ")} frame timing`,
        json: false,
        timing: event.timing
      };
      writeCommandLatencyTelemetry(repoState.repo.root, createCommandLatencyRecord(result, repoState));
    }
  };
}

function cachedRepoState(
  cache: Map<string, OpcoreRepoStatePayload>,
  repoRoot: string
): OpcoreRepoStatePayload | undefined {
  const cached = cache.get(repoRoot);
  if (cached) return cached;
  const resolution = resolveRepo(repoRoot, "opcore graph serve telemetry");
  if (!resolution.ok) return undefined;
  const repoState = createRepoState(resolution.resolution);
  cache.set(repoRoot, repoState);
  return repoState;
}
