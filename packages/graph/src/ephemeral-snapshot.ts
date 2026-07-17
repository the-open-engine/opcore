import type {
  GraphDetectChangesRequest,
  GraphDetectChangesResult,
  GraphFactQueryRequest,
  GraphFactQueryResult,
  GraphImpactRequest,
  GraphImpactResult,
  GraphNamedQueryRequest,
  GraphNamedQueryResult,
  GraphPipelineResult,
  GraphProviderMode,
  GraphProviderStatus,
  GraphReviewContextRequest,
  GraphReviewContextResult,
  RepoIdentity
} from "@the-open-engine/opcore-contracts";
import { validateRepoRelativePath } from "@the-open-engine/opcore-contracts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface EphemeralGraphSourceUniverse {
  paths: readonly string[];
  complete: boolean;
  message?: string;
}

export interface EphemeralGraphSourceReadResult {
  status: "found" | "missing" | "deleted";
  content?: string;
}

export interface EphemeralGraphSnapshotLimits {
  maxFiles?: number;
  maxDepth?: number;
  maxBytes?: number;
}

export interface CreateEphemeralGraphSnapshotOptions {
  logicalRepo: RepoIdentity;
  sourceUniverse: EphemeralGraphSourceUniverse;
  readFile: (path: string) => EphemeralGraphSourceReadResult | Promise<EphemeralGraphSourceReadResult>;
  limits?: EphemeralGraphSnapshotLimits;
}

export interface EphemeralGraphOperations {
  build(repo: RepoIdentity): GraphPipelineResult;
  factQuery(repo: RepoIdentity, request: GraphFactQueryRequest): GraphFactQueryResult;
  namedQuery?(repo: RepoIdentity, request: GraphNamedQueryRequest): GraphNamedQueryResult;
  impact?(repo: RepoIdentity, request: GraphImpactRequest): GraphImpactResult;
  reviewContext?(repo: RepoIdentity, request: GraphReviewContextRequest): GraphReviewContextResult;
  detectChanges?(repo: RepoIdentity, request: GraphDetectChangesRequest): GraphDetectChangesResult;
}

export interface EphemeralGraphSnapshot {
  readonly logicalRepo: RepoIdentity;
  readonly materializedPaths: readonly string[];
  status(mode: GraphProviderMode): GraphProviderStatus;
  factQuery(request: GraphFactQueryRequest): GraphFactQueryResult;
  namedQuery(request: GraphNamedQueryRequest): GraphNamedQueryResult;
  impact(request: GraphImpactRequest): GraphImpactResult;
  reviewContext(request: GraphReviewContextRequest): GraphReviewContextResult;
  detectChanges(request: GraphDetectChangesRequest): GraphDetectChangesResult;
  dispose(): void;
}

const defaultLimits: Required<EphemeralGraphSnapshotLimits> = {
  maxFiles: 50_000,
  maxDepth: 64,
  maxBytes: 256 * 1024 * 1024
};

export async function createEphemeralGraphSnapshotWithOperations(
  options: CreateEphemeralGraphSnapshotOptions,
  operations: EphemeralGraphOperations
): Promise<EphemeralGraphSnapshot> {
  const paths = normalizeUniverse(options.sourceUniverse);
  const limits = normalizeLimits(options.limits);
  const sourcePaths = paths.filter(isSupportedGraphSourcePath);
  enforcePathLimits(sourcePaths, limits);
  const materialized = await materializeSnapshotSources(sourcePaths, options.readFile, limits);
  let disposed = false;
  try {
    const build = operations.build(materialized.repo);
    if (build.status.state !== "available") throw snapshotOperationFailure("build", build.status);
    return bindSnapshot(options.logicalRepo, materialized, build.status, operations, () => {
      if (disposed) return;
      disposed = true;
      rmSync(materialized.tempRoot, { recursive: true, force: true });
    });
  } catch (error) {
    rmSync(materialized.tempRoot, { recursive: true, force: true });
    throw error;
  }
}

interface MaterializedSnapshotSources {
  tempRoot: string;
  repo: RepoIdentity;
  paths: readonly string[];
}

async function materializeSnapshotSources(
  paths: readonly string[],
  readFile: CreateEphemeralGraphSnapshotOptions["readFile"],
  limits: Required<EphemeralGraphSnapshotLimits>
): Promise<MaterializedSnapshotSources> {
  const tempRoot = mkdtempSync(join(tmpdir(), "opcore-graph-snapshot-"));
  const repoRoot = join(tempRoot, "repo");
  try {
    mkdirSync(repoRoot, { recursive: true });
    let byteCount = 0;
    const materializedPaths: string[] = [];
    for (const path of paths) {
      const source = await readFile(path);
      if (source.status === "missing" || source.status === "deleted") continue;
      if (source.status !== "found" || typeof source.content !== "string") {
        throw new Error(`Ephemeral graph source reader returned an invalid result for ${path}`);
      }
      byteCount += new TextEncoder().encode(source.content).byteLength;
      if (byteCount > limits.maxBytes) {
        throw new Error(`Ephemeral graph snapshot exceeds maxBytes (${limits.maxBytes})`);
      }
      writeSourceFile(repoRoot, path, source.content);
      materializedPaths.push(path);
    }
    return { tempRoot, repo: { repoRoot }, paths: materializedPaths };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function bindSnapshot(
  logicalRepo: RepoIdentity,
  materialized: MaterializedSnapshotSources,
  status: GraphProviderStatus,
  operations: EphemeralGraphOperations,
  dispose: () => void
): EphemeralGraphSnapshot {
  const { repo } = materialized;
  return {
    logicalRepo,
    materializedPaths: materialized.paths,
    status: (mode) => bindStatus(status, mode, logicalRepo),
    factQuery: (request) => bindResult(operations.factQuery(repo, request), request, logicalRepo),
    namedQuery: (request) => bindResult(requireOperation(operations.namedQuery, "namedQuery")(repo, request), request, logicalRepo),
    impact: (request) => bindResult(requireOperation(operations.impact, "impact")(repo, request), request, logicalRepo),
    reviewContext: (request) => bindResult(requireOperation(operations.reviewContext, "reviewContext")(repo, request), request, logicalRepo),
    detectChanges: (request) => bindResult(requireOperation(operations.detectChanges, "detectChanges")(repo, request), request, logicalRepo),
    dispose
  };
}

function normalizeUniverse(universe: EphemeralGraphSourceUniverse): readonly string[] {
  if (!universe || !Array.isArray(universe.paths)) throw new Error("Ephemeral graph source universe is invalid");
  if (!universe.complete) throw new Error(universe.message ?? "Ephemeral graph source universe is incomplete");
  const seen = new Set<string>();
  for (const candidate of universe.paths) {
    const path = validateRepoRelativePath(candidate);
    if (seen.has(path)) throw new Error(`Ephemeral graph source universe contains duplicate path: ${path}`);
    seen.add(path);
  }
  return [...seen].sort();
}

function normalizeLimits(limits: EphemeralGraphSnapshotLimits | undefined): Required<EphemeralGraphSnapshotLimits> {
  const normalized = { ...defaultLimits, ...limits };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Ephemeral graph snapshot ${name} must be a positive integer`);
  }
  return normalized;
}

function enforcePathLimits(paths: readonly string[], limits: Required<EphemeralGraphSnapshotLimits>): void {
  if (paths.length > limits.maxFiles) throw new Error(`Ephemeral graph snapshot exceeds maxFiles (${limits.maxFiles})`);
  const tooDeep = paths.find((path) => path.split("/").length > limits.maxDepth);
  if (tooDeep !== undefined) throw new Error(`Ephemeral graph snapshot path exceeds maxDepth (${limits.maxDepth}): ${tooDeep}`);
}

function writeSourceFile(repoRoot: string, path: string, content: string): void {
  const absolutePath = resolve(repoRoot, validateRepoRelativePath(path));
  if (absolutePath !== repoRoot && !absolutePath.startsWith(`${repoRoot}/`)) {
    throw new Error(`Ephemeral graph source path escapes snapshot root: ${path}`);
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function isSupportedGraphSourcePath(path: string): boolean {
  return /\.(?:tsx?|[cm]ts|jsx?|pyi?|rs)$/u.test(path);
}

function bindStatus(status: GraphProviderStatus, mode: GraphProviderMode, logicalRepo: RepoIdentity): GraphProviderStatus {
  return { ...status, mode, ...(status.state === "available" || status.state === "stale" ? { repo: logicalRepo } : {}) } as GraphProviderStatus;
}

function bindResult<Result extends { requestId?: string; status: GraphProviderStatus; metadata?: { repo: RepoIdentity } }>(
  result: Result,
  request: { requestId?: string; mode: GraphProviderMode },
  logicalRepo: RepoIdentity
): Result {
  return {
    ...result,
    requestId: request.requestId,
    status: bindStatus(result.status, request.mode, logicalRepo),
    ...(result.metadata === undefined ? {} : { metadata: { ...result.metadata, repo: logicalRepo } })
  } as Result;
}

function snapshotOperationFailure(operation: string, status: GraphProviderStatus): Error {
  const message = "failure" in status ? status.failure.message : status.message;
  return new Error(`Ephemeral graph snapshot ${operation} failed (${status.state}): ${message ?? "no failure message"}`);
}

function requireOperation<Operation>(operation: Operation | undefined, name: string): Operation {
  if (operation === undefined) throw new Error(`Ephemeral graph snapshot operation is unavailable: ${name}`);
  return operation;
}
