import type {
  GraphDaemonRequest,
  GraphDaemonResponse,
  GraphProviderArtifactMetadata,
  GraphPipelineResult,
  GraphWatchLifecycle,
  GraphProviderFailureStatus,
  GraphProviderStatus
} from "@the-open-engine/opcore-contracts";
import { validateGraphDaemonResponse, validateGraphWatchLifecycle } from "@the-open-engine/opcore-contracts";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedGraphCoreArtifact } from "./artifact.js";
import { providerFailureStatus, resolveGraphCoreArtifact, schemaMismatchStatus } from "./artifact.js";

declare const process: {
  kill(pid: number, signal?: 0): boolean;
};

export function invokeGraphCoreSidecar(request: GraphDaemonRequest): GraphDaemonResponse {
  const resolution = resolveGraphCoreArtifact();
  if (!resolution.ok) return failureResponse(request, resolution.status);
  if (request.operation === "watch") return invokeGraphCoreWatch(resolution.artifact, request);
  const result = spawnGraphCoreSidecar(resolution.artifact.executablePath, request);
  const status = processFailureStatus(result);
  if (status) return failureResponse(request, status);
  const line = firstStdoutLine(result.stdout);
  if (!line) return failureResponse(request, noStdoutStatus());
  return decodeSidecarResponse(request, line, resolution.artifact);
}

function invokeGraphCoreWatch(
  artifactOrRequest: ResolvedGraphCoreArtifact | GraphDaemonRequest,
  maybeRequest?: GraphDaemonRequest
): GraphDaemonResponse {
  const artifact = maybeRequest ? (artifactOrRequest as ResolvedGraphCoreArtifact) : undefined;
  const request = maybeRequest ?? (artifactOrRequest as GraphDaemonRequest);
  const resolution = artifact ? { ok: true as const, artifact } : resolveGraphCoreArtifact();
  if (!resolution.ok) return failureResponse(request, resolution.status);
  const repoRoot = request.repo.repoRoot ? resolve(request.repo.repoRoot) : undefined;
  if (!repoRoot) {
    return failureResponse(
      request,
      providerFailureStatus("required_missing", "provider_missing", "GraphProvider watch requires repo.repoRoot", "required")
    );
  }

  const args = watchArgs(request, repoRoot);
  if (request.once) {
    const result = spawnSync(resolution.artifact.executablePath, args, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const status = processFailureStatus(result);
    if (status) return failureResponse(request, status);
    const line = firstStdoutLine(result.stdout);
    if (!line) return failureResponse(request, noStdoutStatus());
    return decodeSidecarResponse(request, line, resolution.artifact);
  }

  const child = spawn(resolution.artifact.executablePath, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  const lifecycleResult = pollWatchLifecycle(repoRoot, child.pid, request.pollIntervalMs ?? 1000);
  if (lifecycleResult.status) return failureResponse(request, lifecycleResult.status);
  const lifecycle = lifecycleResult.lifecycle;
  if (!lifecycle) {
    return failureResponse(
      request,
      providerFailureStatus("daemon_unavailable", "daemon_unavailable", "graph-core watch daemon did not publish state", "required")
    );
  }
  const status = lifecycleStatus(request, lifecycle);
  if (lifecycle.state === "error" || lifecycle.state === "stopped") return failureResponse(request, status);
  return validateGraphDaemonResponse({
    protocol: "opcore.graph.daemon",
    requestId: request.requestId,
    schemaVersion: 1,
    status,
    lifecycle,
    pipeline: {
      summary: {
        operation: "watch",
        repo: request.repo,
        storePath: join(repoRoot, ".lattice", "graph", "graph.db"),
        startedAt: lifecycle.startedAt,
        completedAt: lifecycle.updatedAt,
        durationMs: 0,
        discoveredFiles: 0,
        parsedFiles: 0,
        changedFiles: [],
        deletedFiles: [],
        unchangedFiles: 0,
        fullRebuildRequired: false,
        diagnosticsCount: 0,
        phaseTimings: [
          {
            phase: "watch",
            startedAt: lifecycle.startedAt,
            completedAt: lifecycle.updatedAt,
            durationMs: 0
          }
        ],
        watchPaths: request.watchPaths
      },
      status,
      lifecycle
    } satisfies GraphPipelineResult
  });
}

function spawnGraphCoreSidecar(executablePath: string, request: GraphDaemonRequest): SpawnSyncReturns {
  return spawnSync(executablePath, [], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function watchArgs(request: GraphDaemonRequest, repoRoot: string): string[] {
  const args = ["watch", "--repo", repoRoot, "--poll-interval-ms", String(request.pollIntervalMs ?? 1000)];
  const watchPaths = request.watchPaths ?? request.paths;
  if (watchPaths && watchPaths.length > 0) args.push("--paths", watchPaths.join(","));
  if (request.baseRef) args.push("--base", request.baseRef);
  if (request.idleTimeoutMs !== undefined) args.push("--idle-timeout-ms", String(request.idleTimeoutMs));
  if (request.maxWalBytes) args.push("--max-wal-bytes", String(request.maxWalBytes));
  if (request.once) args.push("--once");
  return args;
}

function pollWatchLifecycle(
  repoRoot: string,
  pid: number | undefined,
  pollIntervalMs: number
): { lifecycle?: GraphWatchLifecycle; status?: GraphProviderStatus } {
  if (!pid) return {};
  const statePath = join(repoRoot, ".lattice", "graph", "daemon", "state.json");
  const deadline = Date.now() + 2500;
  let lifecycleReadFailure: string | undefined;
  let lastLifecycle: GraphWatchLifecycle | undefined;
  while (Date.now() < deadline) {
    const lifecycle = readLifecycle(statePath);
    if (lifecycle.state === "ok" && lifecycle.lifecycle.pid === pid) {
      lastLifecycle = lifecycle.lifecycle;
      if (lifecycle.lifecycle.state === "available" || lifecycle.lifecycle.state === "error" || lifecycle.lifecycle.state === "stopped") {
        return { lifecycle: lifecycle.lifecycle };
      }
    }
    if (lifecycle.state === "error") {
      lifecycleReadFailure = lifecycle.message;
      if (!isProcessAlive(pid)) {
        return {
          status: providerFailureStatus("daemon_unavailable", "daemon_unavailable", lifecycle.message, "required")
        };
      }
    }
    if (!isProcessAlive(pid)) {
      if (lastLifecycle?.state === "error" || lastLifecycle?.state === "stopped") return { lifecycle: lastLifecycle };
      return {
        status: providerFailureStatus(
          "daemon_unavailable",
          "daemon_unavailable",
          `graph-core watch daemon pid ${pid} exited before publishing available state`,
          "required"
        )
      };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(100, pollIntervalMs));
  }
  if (lifecycleReadFailure) {
    return {
      status: providerFailureStatus("daemon_unavailable", "daemon_unavailable", lifecycleReadFailure, "required")
    };
  }
  return {};
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return code === "EPERM";
  }
}

function readLifecycle(statePath: string):
  | { state: "missing" }
  | { state: "ok"; lifecycle: GraphWatchLifecycle }
  | { state: "error"; message: string } {
  if (!existsSync(statePath)) return { state: "missing" };
  let content: string;
  try {
    content = readFileSync(statePath, "utf8");
  } catch (error) {
    return {
      state: "error",
      message: `graph watch daemon state file ${statePath} is unreadable: ${errorMessage(error)}`
    };
  }
  try {
    return { state: "ok", lifecycle: validateGraphWatchLifecycle(JSON.parse(content)) };
  } catch (error) {
    return {
      state: "error",
      message: `graph watch daemon state file ${statePath} is invalid: ${errorMessage(error)}`
    };
  }
}

function lifecycleStatus(request: GraphDaemonRequest, lifecycle: GraphWatchLifecycle): GraphProviderStatus {
  const freshness = {
    generatedAt: lifecycle.updatedAt,
    ageMs: 0,
    stale: lifecycle.state !== "available",
    reason: lifecycle.state === "available" ? undefined : lifecycle.message ?? lifecycle.state
  };
  if (lifecycle.state === "available") {
    return {
      state: "available",
      mode: "required",
      provider: "opcore-graph",
      schemaVersion: 1,
      repo: request.repo,
      freshness,
      dbPath: request.repo.repoRoot ? join(resolve(request.repo.repoRoot), ".lattice", "graph", "graph.db") : undefined,
      nodes_by_kind: {},
      edges_by_kind: {},
      message: lifecycle.message ?? "graph watch daemon available",
      capabilities: ["build", "update", "watch", "status", "query", "impact", "review-context", "detect-changes", "search"]
    };
  }
  if (lifecycle.state === "error") {
    return {
      state: "error",
      mode: "required",
      provider: "opcore-graph",
      schemaVersion: 1,
      message: lifecycle.message ?? "graph watch daemon error",
      failure: {
        category: "unknown",
        message: lifecycle.message ?? "graph watch daemon error"
      }
    };
  }
  if (lifecycle.state === "stopped") {
    return providerFailureStatus(
      "daemon_unavailable",
      "daemon_unavailable",
      lifecycle.message ?? "graph watch daemon stopped before becoming available",
      "required"
    );
  }
  return {
    state: "warming",
    mode: "required",
    provider: "opcore-graph",
    schemaVersion: 1,
    repo: request.repo,
    freshness,
    lifecycle,
    message: lifecycle.message ?? "graph watch daemon warming"
  };
}

function processFailureStatus(result: SpawnSyncReturns): GraphProviderStatus | undefined {
  if (result.error) {
    return providerFailureStatus("daemon_unavailable", "daemon_unavailable", result.error.message, "required");
  }
  if (result.status !== 0) {
    return providerFailureStatus(
      "daemon_unavailable",
      "daemon_unavailable",
      `graph-core sidecar exited ${String(result.status)}: ${result.stderr}`,
      "required"
    );
  }
  return undefined;
}

function firstStdoutLine(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
}

function noStdoutStatus(): GraphProviderStatus {
  return providerFailureStatus("daemon_unavailable", "daemon_unavailable", "graph-core sidecar produced no stdout", "required");
}

function decodeSidecarResponse(
  request: GraphDaemonRequest,
  line: string,
  artifact: ResolvedGraphCoreArtifact
): GraphDaemonResponse {
  try {
    const response = validateGraphDaemonResponse(JSON.parse(line));
    if (response.schemaVersion !== request.schemaVersion) {
      return failureResponse(
        request,
        schemaMismatchStatus("graph-core sidecar response schemaVersion mismatch", response.schemaVersion)
      );
    }
    return normalizeGraphCoreResponseArtifacts(response, artifact);
  } catch (error) {
    return failureResponse(request, schemaMismatchStatus(`graph-core sidecar protocol decode failed: ${errorMessage(error)}`));
  }
}

export function normalizeGraphCoreResponseArtifacts(
  response: GraphDaemonResponse,
  artifact: GraphProviderArtifactMetadata
): GraphDaemonResponse {
  normalizeArtifactHandshake(response.status, artifact);
  if (response.result) normalizeArtifactHandshake(response.result.status, artifact);
  if (response.namedQuery) normalizeArtifactHandshake(response.namedQuery.status, artifact);
  if (response.impact) normalizeArtifactHandshake(response.impact.status, artifact);
  if (response.reviewContext) normalizeArtifactHandshake(response.reviewContext.status, artifact);
  if (response.changes) normalizeArtifactHandshake(response.changes.status, artifact);
  if (response.search) normalizeArtifactHandshake(response.search.status, artifact);
  if (response.pipeline) normalizeArtifactHandshake(response.pipeline.status, artifact);
  return validateGraphDaemonResponse(response);
}

function normalizeArtifactHandshake(status: GraphProviderStatus, artifact: GraphProviderArtifactMetadata): void {
  if (status.state !== "available" || !status.handshake) return;
  status.handshake = {
    ...status.handshake,
    artifactName: artifact.artifactName,
    artifactVersion: artifact.artifactVersion,
    targetPlatform: artifact.targetPlatform,
    artifact: {
      artifactName: artifact.artifactName,
      artifactVersion: artifact.artifactVersion,
      targetPlatform: artifact.targetPlatform,
      binaryPath: artifact.binaryPath,
      checksumPath: artifact.checksumPath,
      checksumSha256: artifact.checksumSha256,
      buildProfile: artifact.buildProfile
    }
  };
}

function failureResponse(request: GraphDaemonRequest, status: GraphProviderStatus): GraphDaemonResponse {
  const queryFailureStatus = status as GraphProviderFailureStatus;
  return {
    protocol: "opcore.graph.daemon",
    requestId: request.requestId,
    schemaVersion: 1,
    status,
    result:
      request.operation === "query" && request.query
        ? {
            requestId: request.query.requestId ?? request.requestId,
            status: queryFailureStatus
          }
        : undefined,
    namedQuery:
      request.operation === "query" && request.namedQuery
        ? {
            requestId: request.namedQuery.requestId ?? request.requestId,
            status: queryFailureStatus
          }
        : undefined,
    impact:
      request.operation === "query" && request.impact
        ? {
            requestId: request.impact.requestId ?? request.requestId,
            status: queryFailureStatus
          }
        : undefined,
    reviewContext:
      request.operation === "query" && request.reviewContext
        ? {
            requestId: request.reviewContext.requestId ?? request.requestId,
            status: queryFailureStatus
          }
        : undefined,
    changes:
      request.operation === "query" && request.changes
        ? {
            requestId: request.changes.requestId ?? request.requestId,
            status: queryFailureStatus
          }
        : undefined,
    search:
      request.operation === "query" && request.search
        ? {
            requestId: request.search.requestId ?? request.requestId,
            status: queryFailureStatus
          }
        : undefined
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
