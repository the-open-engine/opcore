import type { GraphProviderStatus, OpcoreRepoStatePayload } from "@the-open-engine/opcore-contracts";
import {
  createNodePythonProjectWorkspace,
  isPythonSourcePath,
  resolvePythonProjectContexts
} from "@the-open-engine/opcore-validation-python";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  formatTraversalFailurePaths,
  readRepoCensus,
  type CensusTraversalFailure
} from "./status-census.js";
import { computeCoverage } from "./status-coverage.js";
import type { RepoResolution } from "./status-repo.js";
import { validationPolicySummary, validationSummary } from "./status-validation.js";
import { createDefaultValidationStatusPayload } from "./validation-composition.js";

interface StatusWarningOptions {
  coverage: OpcoreRepoStatePayload["coverage"];
  validation: OpcoreRepoStatePayload["validation"];
  graphStatus: GraphProviderStatus;
  traversalFailures: readonly CensusTraversalFailure[];
}

export async function createRepoState(resolution: RepoResolution): Promise<OpcoreRepoStatePayload> {
  const census = readRepoCensus(resolution);
  const coverage = computeCoverage(census.files);
  const pythonTargets = census.files.filter(isPythonSourcePath);
  const pythonProjectContexts = pythonTargets.length === 0
    ? []
    : await resolvePythonProjectContexts({
        repoRoot: resolution.root,
        targets: pythonTargets,
        workspace: createNodePythonProjectWorkspace(resolution.root)
      });
  const validationStatus = createDefaultValidationStatusPayload({
    repoRoot: resolution.root,
    graphMode: "optional",
    pythonProjectContexts
  });
  const graphStatus = validationStatus.graph.status;
  const policy = validationPolicySummary(resolution.root, validationStatus.adapterRegistry.checkIds);
  const validation = validationSummary(validationStatus, coverage, policy, pythonProjectContexts);
  const blockers = statusBlockers(graphStatus, census.traversalFailures);
  const level = activationLevel(graphStatus, validation.ready, blockers);
  const warningOptions = { coverage, validation, graphStatus, traversalFailures: census.traversalFailures };

  return {
    schemaVersion: 1,
    repo: {
      root: resolution.root,
      requestedPath: resolution.requestedPath,
      git: census.git
    },
    coverage,
    graph: graphSummary(graphStatus),
    validation,
    activation: {
      ready: level === "ready",
      level,
      summary: activationSummary(level, graphStatus, coverage.unsupported.totalFiles, census.traversalFailures),
      asp: discoverAspEnrollment(resolution.root)
    },
    warnings: statusWarnings(warningOptions),
    blockers,
    nextActions: nextCommands(resolution.root, graphStatus, census.traversalFailures)
  };
}

function graphSummary(graphStatus: GraphProviderStatus): OpcoreRepoStatePayload["graph"] {
  return {
    state: graphStatus.state,
    mode: graphStatus.mode,
    provider: graphStatus.provider,
    action: graphAction(graphStatus),
    ...(graphStatus.message ? { message: graphStatus.message } : {}),
    status: graphStatus
  };
}

function activationLevel(
  graphStatus: GraphProviderStatus,
  validationReady: boolean,
  blockers: readonly string[]
): OpcoreRepoStatePayload["activation"]["level"] {
  if (graphStatus.state === "available" && validationReady && blockers.length === 0) return "ready";
  return blockers.length > 0 ? "blocked" : "degraded";
}

function discoverAspEnrollment(repoRoot: string): OpcoreRepoStatePayload["activation"]["asp"] {
  const candidates = [".asp/asp.json", ".asp/local.json", "asp-server.json"];
  const paths = candidates.filter((path) => existsSync(join(repoRoot, path)));
  return { state: paths.length > 0 ? "enrolled" : "not_enrolled", paths };
}

function statusWarnings(options: StatusWarningOptions): string[] {
  const warnings: string[] = [];
  if (options.traversalFailures.length > 0) {
    warnings.push(`Unreadable repo paths: ${formatTraversalFailurePaths(options.traversalFailures)}; coverage may be incomplete.`);
  }
  if (options.coverage.unsupported.totalFiles > 0) {
    const stacks = options.coverage.unsupported.stacks.map((stack) => `${stack.language} (${stack.count})`).join(", ");
    warnings.push(`Unsupported stacks: ${stacks}`);
  }
  if (options.validation.degradedToolchains.length > 0) {
    const tools = options.validation.degradedToolchains.map((tool) => tool.tool).join(", ");
    warnings.push(`Degraded validation tools: ${tools}`);
  }
  if (graphRefreshRecommended(options.graphStatus)) {
    warnings.push(`Graph is ${options.graphStatus.state}; graph-backed scan/check work needs ${graphAction(options.graphStatus)}`);
  }
  return warnings;
}

function statusBlockers(
  graphStatus: GraphProviderStatus,
  traversalFailures: readonly CensusTraversalFailure[]
): string[] {
  const blockers: string[] = [];
  if (traversalFailures.length > 0) {
    blockers.push(`Unreadable repo paths prevent complete coverage census: ${formatTraversalFailurePaths(traversalFailures)}`);
  }
  if (graphStatus.state === "error" || graphStatus.state === "daemon_unavailable") {
    blockers.push(graphStatus.message ?? graphStatus.failure.message);
  }
  if (graphStatus.state === "schema_mismatch") blockers.push("Graph metadata schema mismatch requires rebuild.");
  return blockers;
}

function nextCommands(
  repoRoot: string,
  graphStatus: GraphProviderStatus,
  traversalFailures: readonly CensusTraversalFailure[]
): string[] {
  if (traversalFailures.length > 0) {
    return [
      `Fix permissions for unreadable repo paths: ${formatTraversalFailurePaths(traversalFailures)}`,
      `opcore status --repo ${repoRoot} --json`
    ];
  }
  if (graphStatus.state === "available") {
    return [`opcore check --changed --repo ${repoRoot} --json`, `opcore --repo ${repoRoot} --json`];
  }
  if (graphRefreshRecommended(graphStatus)) {
    return [`opcore graph build --repo ${repoRoot} --json`, `opcore --repo ${repoRoot} --json`];
  }
  return [`opcore --repo ${repoRoot} --json`, `opcore status --repo ${repoRoot} --json`];
}

function graphRefreshRecommended(status: GraphProviderStatus): boolean {
  return status.state === "stale" ||
    status.state === "schema_mismatch" ||
    status.state === "skipped" ||
    status.state === "required_missing";
}

function graphAction(status: GraphProviderStatus): string {
  if (status.state === "available") return "Graph is ready.";
  if (status.state === "warming") return "Wait for graph warmup.";
  if (status.state === "stale") return "refresh graph evidence before graph-backed checks.";
  if (status.state === "schema_mismatch") return "refresh graph metadata.";
  if (status.state === "skipped" || status.state === "required_missing") return "graph evidence is unavailable.";
  return status.message ?? status.failure.message;
}

function activationSummary(
  level: OpcoreRepoStatePayload["activation"]["level"],
  graphStatus: GraphProviderStatus,
  unsupportedFiles: number,
  traversalFailures: readonly CensusTraversalFailure[]
): string {
  if (level === "ready") return unsupportedFiles > 0 ? "Repo is ready with unsupported stacks reported." : "Repo is ready.";
  if (traversalFailures.length > 0) return "Repo activation is blocked: unreadable repo paths prevent complete coverage census.";
  if (level === "blocked") return `Repo activation is blocked: ${graphAction(graphStatus)}`;
  return `Repo activation is degraded: ${graphAction(graphStatus)}`;
}
