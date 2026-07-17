import type {
  GraphDetectChangesRequest,
  GraphDetectChangesResult,
  GraphDetectChangesAvailableResult,
  GraphEdgeKind,
  GraphFactEdge,
  GraphFactNode,
  GraphFactQueryAvailableResult,
  GraphFactQueryRequest,
  GraphFactQueryResult,
  GraphFactQuerySelector,
  GraphImpactRequest,
  GraphImpactResult,
  GraphImpactAvailableResult,
  GraphNamedQueryRequest,
  GraphNamedQueryResult,
  GraphNamedQueryAvailableResult,
  GraphProviderNonAvailableStatus,
  GraphProviderStatus,
  GraphReviewContextRequest,
  GraphReviewContextResult,
  GraphReviewContextAvailableResult,
  GraphSnapshotMetadata,
  JsonValue,
  RepoIdentity,
  ValidationRequest
} from "@the-open-engine/opcore-contracts";
import {
  GRAPH_SCHEMA_VERSION,
  validateGraphDetectChangesRequest,
  validateGraphDetectChangesResult,
  validateGraphFactQueryRequest,
  validateGraphFactQueryResult,
  validateGraphImpactRequest,
  validateGraphImpactResult,
  validateGraphNamedQueryRequest,
  validateGraphNamedQueryResult,
  validateGraphReviewContextRequest,
  validateGraphReviewContextResult,
  validateProviderStatus,
  validateRepoRelativePath
} from "@the-open-engine/opcore-contracts";
import { defaultValidationGraphProvider, missingGraphStatus } from "./request.js";
import type { ValidationFileView } from "./overlays.js";

type MaybePromise<T> = T | Promise<T>;

export type ValidationGraphOperation = "status" | "factQuery" | "namedQuery" | "impact" | "reviewContext" | "detectChanges";

export interface ValidationGraphProviderClient {
  status: (request: ValidationRequest) => MaybePromise<GraphProviderStatus | undefined>;
  factQuery: (request: GraphFactQueryRequest) => MaybePromise<GraphFactQueryResult>;
  namedQuery: (request: GraphNamedQueryRequest) => MaybePromise<GraphNamedQueryResult>;
  impact: (request: GraphImpactRequest) => MaybePromise<GraphImpactResult>;
  reviewContext: (request: GraphReviewContextRequest) => MaybePromise<GraphReviewContextResult>;
  detectChanges: (request: GraphDetectChangesRequest) => MaybePromise<GraphDetectChangesResult>;
}

export type ValidationGraphFactQueryRequirement =
  | {
      operation: "factQuery";
      selector: GraphFactQuerySelector;
      informational?: boolean;
    }
  | {
      operation: "facts";
      selector: GraphFactQuerySelector;
      informational?: boolean;
    };

export type ValidationGraphNamedQueryRequirement = {
  operation: "namedQuery";
  queryKind: GraphNamedQueryRequest["queryKind"];
  target: string;
  maxDepth?: number;
  limit?: number;
  informational?: boolean;
};

export type ValidationGraphImpactRequirement = {
  operation: "impact";
  files: readonly string[];
  baseRef?: string;
  maxDepth?: number;
  limit?: number;
  informational?: boolean;
};

export type ValidationGraphReviewContextRequirement = {
  operation: "reviewContext";
  files?: readonly string[];
  baseRef?: string;
  maxDepth?: number;
  limit?: number;
  informational?: boolean;
};

export type ValidationGraphDetectChangesRequirement = {
  operation: "detectChanges";
  files?: readonly string[];
  baseRef?: string;
  informational?: boolean;
};

export type ValidationGraphQueryRequirement =
  | ValidationGraphFactQueryRequirement
  | ValidationGraphNamedQueryRequirement
  | ValidationGraphImpactRequirement
  | ValidationGraphReviewContextRequirement
  | ValidationGraphDetectChangesRequirement;
type ValidationGraphNonFactRequirement =
  | ValidationGraphNamedQueryRequirement
  | ValidationGraphImpactRequirement
  | ValidationGraphReviewContextRequirement
  | ValidationGraphDetectChangesRequirement;

export type ValidationGraphNamedQueryInput = Omit<GraphNamedQueryRequest, "requestId" | "repo" | "schemaVersion" | "mode">;
export type ValidationGraphImpactInput = Omit<GraphImpactRequest, "requestId" | "repo" | "schemaVersion" | "mode">;
export type ValidationGraphReviewContextInput = Omit<GraphReviewContextRequest, "requestId" | "repo" | "schemaVersion" | "mode">;
export type ValidationGraphDetectChangesInput = Omit<GraphDetectChangesRequest, "requestId" | "repo" | "schemaVersion" | "mode">;

export interface ValidationGraphFactView {
  metadata: () => Promise<GraphSnapshotMetadata | undefined>;
  fileNodes: (paths: readonly string[]) => Promise<readonly GraphFactNode[]>;
  fileChecksum: (path: string) => Promise<string | undefined>;
  edgesByKind: (kinds: readonly GraphEdgeKind[]) => Promise<readonly GraphFactEdge[]>;
  importsFrom: () => Promise<readonly GraphFactEdge[]>;
  calls: () => Promise<readonly GraphFactEdge[]>;
  testedBy: () => Promise<readonly GraphFactEdge[]>;
}

export interface ValidationGraphQuerySession extends ValidationGraphFactView {
  readonly identity: ValidationGraphSessionIdentity;
  readonly status: GraphProviderStatus;
  readonly queryCapable: boolean;
  dispose: () => MaybePromise<void>;
  preload: (requirements: readonly ValidationGraphQueryRequirement[]) => Promise<void>;
  facts: (selector: GraphFactQuerySelector) => Promise<GraphFactQueryAvailableResult>;
  namedQuery: (query: ValidationGraphNamedQueryInput) => Promise<GraphNamedQueryAvailableResult>;
  impact: (query: ValidationGraphImpactInput) => Promise<GraphImpactAvailableResult>;
  reviewContext: (query: ValidationGraphReviewContextInput) => Promise<GraphReviewContextAvailableResult>;
  detectChanges: (query: ValidationGraphDetectChangesInput) => Promise<GraphDetectChangesAvailableResult>;
  factView: () => ValidationGraphFactView;
}

export type ValidationGraphSessionIdentity =
  | { kind: "persistent" }
  | { kind: "exact"; state: "before" | "after" };

export interface CreateValidationGraphQuerySessionArgs {
  request: ValidationRequest;
  client?: ValidationGraphProviderClient;
  status?: GraphProviderStatus;
  fileView?: ValidationFileView;
  identity?: ValidationGraphSessionIdentity;
}

export type ValidationGraphSessionFactory = (
  args: CreateValidationGraphQuerySessionArgs
) => MaybePromise<ValidationGraphQuerySession>;

export interface ValidationExactGraphSnapshot {
  status: GraphProviderStatus;
  client: ValidationGraphProviderClient;
  dispose: () => MaybePromise<void>;
}

export type ValidationExactGraphSnapshotFactory = (args: {
  request: ValidationRequest;
  fileView: ValidationFileView;
  state: "before" | "after";
}) => MaybePromise<ValidationExactGraphSnapshot>;

export interface ValidationEphemeralGraphSnapshot {
  status: (mode: ValidationRequest["graph"]["mode"]) => GraphProviderStatus;
  factQuery: ValidationGraphProviderClient["factQuery"];
  namedQuery: ValidationGraphProviderClient["namedQuery"];
  impact: ValidationGraphProviderClient["impact"];
  reviewContext: ValidationGraphProviderClient["reviewContext"];
  detectChanges: ValidationGraphProviderClient["detectChanges"];
  dispose: () => MaybePromise<void>;
}

export type ValidationEphemeralGraphSnapshotProvider = (args: {
  logicalRepo: RepoIdentity;
  sourceUniverse: { paths: readonly string[]; complete: boolean; message?: string };
  readFile: (path: string) => MaybePromise<{ status: "found" | "missing" | "deleted"; content?: string }>;
}) => MaybePromise<ValidationEphemeralGraphSnapshot>;

export function createValidationExactGraphSnapshotFactory(
  provider: ValidationEphemeralGraphSnapshotProvider
): ValidationExactGraphSnapshotFactory {
  return async ({ request, fileView }) => {
    const universe = await fileView.listVisibleFileUniverse();
    const snapshot = await provider({
      logicalRepo: request.repo,
      sourceUniverse: { paths: universe.files, complete: universe.complete, message: universe.message },
      readFile: (path) => fileView.readFile(path)
    });
    const client: ValidationGraphProviderClient = {
      status: (candidate) => snapshot.status(candidate.graph.mode),
      factQuery: snapshot.factQuery,
      namedQuery: snapshot.namedQuery,
      impact: snapshot.impact,
      reviewContext: snapshot.reviewContext,
      detectChanges: snapshot.detectChanges
    };
    return {
      status: snapshot.status(request.graph.mode),
      client,
      dispose: snapshot.dispose
    };
  };
}

export function createStateAwareValidationGraphSessionFactory(options: {
  persistentClient?: ValidationGraphProviderClient;
  exactSnapshotFactory: ValidationExactGraphSnapshotFactory;
}): ValidationGraphSessionFactory {
  return async (args) => {
    if (args.identity?.kind !== "exact") {
      return createValidationGraphQuerySession({ ...args, client: args.client ?? options.persistentClient });
    }
    if (args.fileView === undefined) throw new Error("Exact validation graph session requires its ValidationFileView");
    const snapshot = await options.exactSnapshotFactory({
      request: args.request,
      fileView: args.fileView,
      state: args.identity.state
    });
    try {
      const session = await createValidationGraphQuerySession({
        ...args,
        client: snapshot.client,
        status: snapshot.status
      });
      let disposed = false;
      return {
        ...session,
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          await snapshot.dispose();
        }
      };
    } catch (error) {
      await snapshot.dispose();
      throw error;
    }
  };
}

export class ValidationGraphProviderError extends Error {
  readonly operation: ValidationGraphOperation;
  readonly status: GraphProviderNonAvailableStatus;

  constructor(operation: ValidationGraphOperation, status: GraphProviderNonAvailableStatus, message?: string) {
    super(message ?? graphFailureMessage(status));
    this.name = "ValidationGraphProviderError";
    this.operation = operation;
    this.status = status;
  }
}

export class ValidationGraphRequirementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationGraphRequirementError";
  }
}

export async function createValidationGraphQuerySession(
  args: CreateValidationGraphQuerySessionArgs
): Promise<ValidationGraphQuerySession> {
  const status = await resolveInitialGraphStatus(args);
  const request = args.request;
  const client = args.client;
  const queryCapable = client !== undefined;
  const factCache = new Map<string, Promise<GraphFactQueryAvailableResult>>();
  const namedQueryCache = new Map<string, Promise<GraphNamedQueryAvailableResult>>();
  const impactCache = new Map<string, Promise<GraphImpactAvailableResult>>();
  const reviewContextCache = new Map<string, Promise<GraphReviewContextAvailableResult>>();
  const detectChangesCache = new Map<string, Promise<GraphDetectChangesAvailableResult>>();
  const factResults: { selector: GraphFactQuerySelector; result: GraphFactQueryAvailableResult }[] = [];

  const view: ValidationGraphFactView = {
    metadata: async () => factResults[0]?.result.metadata ?? (await facts({ kind: "nodes" })).metadata,
    fileNodes,
    fileChecksum,
    edgesByKind,
    importsFrom: () => edgesByKind(["IMPORTS_FROM"]),
    calls: () => edgesByKind(["CALLS"]),
    testedBy: () => edgesByKind(["TESTED_BY"])
  };

  async function preload(requirements: readonly ValidationGraphQueryRequirement[]): Promise<void> {
    for (const requirement of mergeGraphRequirements(requirements)) {
      switch (requirement.operation) {
        case "factQuery":
        case "facts":
          await facts(requirement.selector);
          break;
        case "namedQuery":
          await namedQuery(requirement);
          break;
        case "impact":
          await impact(requirement);
          break;
        case "reviewContext":
          await reviewContext(requirement);
          break;
        case "detectChanges":
          await detectChanges(requirement);
          break;
      }
    }
  }

  async function facts(selector: GraphFactQuerySelector): Promise<GraphFactQueryAvailableResult> {
    const normalizedSelector = normalizeSelector(selector);
    const covered = coveringFactResult(normalizedSelector);
    if (covered !== undefined) return filterFactResult(covered, normalizedSelector);
    const requestPayload = validateGraphFactQueryRequest({
      requestId: requestId("factQuery"),
      repo: request.repo,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      mode: request.graph.mode,
      selector: normalizedSelector
    });
    const key = operationCacheKey(request, "factQuery", { selector: normalizedSelector });
    const cached = factCache.get(key);
    if (cached !== undefined) return cached;
    const promise = runProviderQuery("factQuery", () => requireClient("factQuery").factQuery(requestPayload), validateGraphFactQueryResult).then(
      (result) => {
        const available = requireAvailableFactQueryResult(result);
        rememberFactResult(normalizedSelector, available);
        return available;
      }
    );
    factCache.set(key, promise);
    return promise;
  }

  async function namedQuery(query: ValidationGraphNamedQueryInput): Promise<GraphNamedQueryAvailableResult> {
    const normalized = normalizeNamedQueryInput(query);
    const requestPayload = validateGraphNamedQueryRequest({
      requestId: requestId("namedQuery"),
      repo: request.repo,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      mode: request.graph.mode,
      ...normalized
    });
    const key = operationCacheKey(request, "namedQuery", normalized);
    return cacheQuery(namedQueryCache, key, async () =>
      requireAvailableNamedQueryResult(
        "namedQuery",
        await runProviderQuery("namedQuery", () => requireClient("namedQuery").namedQuery(requestPayload), validateGraphNamedQueryResult)
      )
    );
  }

  async function impact(query: ValidationGraphImpactInput): Promise<GraphImpactAvailableResult> {
    const normalized = normalizeImpactInput(query);
    const requestPayload = validateGraphImpactRequest({
      requestId: requestId("impact"),
      repo: request.repo,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      mode: request.graph.mode,
      ...normalized
    });
    const key = operationCacheKey(request, "impact", normalized);
    return cacheQuery(impactCache, key, async () =>
      requireAvailableImpactResult(
        "impact",
        await runProviderQuery("impact", () => requireClient("impact").impact(requestPayload), validateGraphImpactResult)
      )
    );
  }

  async function reviewContext(query: ValidationGraphReviewContextInput): Promise<GraphReviewContextAvailableResult> {
    const normalized = normalizeReviewContextInput(query);
    const requestPayload = validateGraphReviewContextRequest({
      requestId: requestId("reviewContext"),
      repo: request.repo,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      mode: request.graph.mode,
      ...normalized
    });
    const key = operationCacheKey(request, "reviewContext", normalized);
    return cacheQuery(reviewContextCache, key, async () =>
      requireAvailableReviewContextResult(
        "reviewContext",
        await runProviderQuery("reviewContext", () => requireClient("reviewContext").reviewContext(requestPayload), validateGraphReviewContextResult)
      )
    );
  }

  async function detectChanges(query: ValidationGraphDetectChangesInput): Promise<GraphDetectChangesAvailableResult> {
    const normalized = normalizeDetectChangesInput(query);
    const requestPayload = validateGraphDetectChangesRequest({
      requestId: requestId("detectChanges"),
      repo: request.repo,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      mode: request.graph.mode,
      ...normalized
    });
    const key = operationCacheKey(request, "detectChanges", normalized);
    return cacheQuery(detectChangesCache, key, async () =>
      requireAvailableDetectChangesResult(
        "detectChanges",
        await runProviderQuery("detectChanges", () => requireClient("detectChanges").detectChanges(requestPayload), validateGraphDetectChangesResult)
      )
    );
  }

  async function fileNodes(paths: readonly string[]): Promise<readonly GraphFactNode[]> {
    const normalizedPaths = uniqueSorted(paths.map((path) => validateRepoRelativePath(path)));
    if (normalizedPaths.length === 0) return [];
    const ids = uniqueSorted(normalizedPaths.map(fileNodeId));
    const result = await facts({
      kind: "nodes",
      nodeKinds: ["file", "File"],
      ids
    });
    const pathSet = new Set(normalizedPaths);
    const idSet = new Set(ids);
    return result.nodes.filter((node) => (node.path !== undefined && pathSet.has(node.path)) || idSet.has(node.id));
  }

  async function fileChecksum(path: string): Promise<string | undefined> {
    const [node] = await fileNodes([path]);
    if (node === undefined) return undefined;
    return normalizedChecksum(attributeString(node, "sha256") ?? attributeString(node, "checksum"));
  }

  async function edgesByKind(kinds: readonly GraphEdgeKind[]): Promise<readonly GraphFactEdge[]> {
    const edgeKinds = uniqueSorted(kinds);
    if (edgeKinds.length === 0) return [];
    const result = await facts({
      kind: "edges",
      edgeKinds
    });
    const kindSet = new Set(edgeKinds);
    return result.edges.filter((edge) => kindSet.has(edge.kind));
  }

  function requireClient(operation: ValidationGraphOperation): ValidationGraphProviderClient {
    if (status.state !== "available") throw new ValidationGraphProviderError(operation, nonAvailableStatus(status));
    if (client === undefined) {
      throw new ValidationGraphProviderError(operation, queryFailureStatus(request, operation, "Graph provider client is not configured"));
    }
    return client;
  }

  async function runProviderQuery<Result extends { status: GraphProviderStatus }>(
    operation: Exclude<ValidationGraphOperation, "status">,
    query: () => MaybePromise<Result>,
    validator: (result: Result) => Result
  ): Promise<Result> {
    try {
      const result = validator(await query());
      validateStatusForRequest(result.status, request, `Validation graph ${operation} status`);
      return result;
    } catch (error) {
      if (error instanceof ValidationGraphProviderError) throw error;
      throw new ValidationGraphProviderError(operation, queryFailureStatus(request, operation, error));
    }
  }

  function rememberFactResult(selector: GraphFactQuerySelector, result: GraphFactQueryAvailableResult): void {
    factResults.push({ selector, result });
  }

  function coveringFactResult(selector: GraphFactQuerySelector): GraphFactQueryAvailableResult | undefined {
    return factResults.find((entry) => selectorCovers(entry.selector, selector))?.result;
  }

  return {
    identity: args.identity ?? { kind: "persistent" },
    status,
    queryCapable,
    dispose: () => {},
    preload,
    facts,
    namedQuery,
    impact,
    reviewContext,
    detectChanges,
    factView: () => view,
    ...view
  };
}

export async function resolveValidationGraphProviderStatus(
  request: ValidationRequest,
  client?: ValidationGraphProviderClient,
  explicitStatus?: GraphProviderStatus
): Promise<GraphProviderStatus> {
  return resolveInitialGraphStatus({ request, client, status: explicitStatus });
}

function mergeGraphRequirements(requirements: readonly ValidationGraphQueryRequirement[]): readonly ValidationGraphQueryRequirement[] {
  const mergedFacts = new Map<string, ValidationGraphFactQueryRequirement>();
  const exact: ValidationGraphQueryRequirement[] = [];
  for (const requirement of requirements) {
    assertValidRequirementLimit(requirement);
    if (requirement.operation !== "factQuery" && requirement.operation !== "facts") {
      exact.push(normalizeNonFactRequirement(requirement));
      continue;
    }
    const normalized: ValidationGraphFactQueryRequirement = {
      ...requirement,
      operation: "factQuery",
      selector: normalizeSelector(requirement.selector)
    };
    const mergeKey = factRequirementMergeKey(normalized.selector);
    if (mergeKey === undefined) {
      exact.push(normalized);
      continue;
    }
    const existing = mergedFacts.get(mergeKey);
    if (existing === undefined) {
      mergedFacts.set(mergeKey, normalized);
      continue;
    }
    existing.selector = mergeSelectors(existing.selector, normalized.selector);
  }
  return [...mergedFacts.values(), ...exact];
}

function normalizeNonFactRequirement(requirement: ValidationGraphNonFactRequirement): ValidationGraphQueryRequirement {
  if (requirement.operation === "namedQuery") return { ...requirement, target: requirement.target.trim() };
  if (requirement.operation === "impact") return { ...requirement, files: normalizeFiles(requirement.files) };
  if (requirement.operation === "reviewContext") {
    return { ...requirement, files: requirement.files === undefined ? undefined : normalizeFiles(requirement.files) };
  }
  return { ...requirement, files: requirement.files === undefined ? undefined : normalizeFiles(requirement.files) };
}

function assertValidRequirementLimit(requirement: ValidationGraphQueryRequirement): void {
  const limit = "selector" in requirement ? requirement.selector.limit : "limit" in requirement ? requirement.limit : undefined;
  if (limit !== undefined && requirement.informational !== true) {
    throw new ValidationGraphRequirementError("Graph query requirements with limits must be marked informational");
  }
}

function factRequirementMergeKey(selector: GraphFactQuerySelector): string | undefined {
  if (selector.limit !== undefined) return undefined;
  if (selector.kind !== "nodes" && selector.kind !== "edges") return undefined;
  return stableStringify({
    kind: selector.kind,
    text: selector.text
  });
}

function mergeSelectors(left: GraphFactQuerySelector, right: GraphFactQuerySelector): GraphFactQuerySelector {
  return {
    kind: left.kind,
    nodeKinds: unionOptional(left.nodeKinds, right.nodeKinds),
    edgeKinds: unionOptional(left.edgeKinds, right.edgeKinds),
    ids: unionOptional(left.ids, right.ids),
    text: left.text
  };
}

function normalizeSelector(selector: GraphFactQuerySelector): GraphFactQuerySelector {
  const normalized: GraphFactQuerySelector = {
    kind: selector.kind
  };
  const nodeKinds = normalizeOptionalArray(selector.nodeKinds);
  const edgeKinds = normalizeOptionalArray(selector.edgeKinds);
  const ids = normalizeOptionalArray(selector.ids);
  if (nodeKinds !== undefined) normalized.nodeKinds = nodeKinds;
  if (edgeKinds !== undefined) normalized.edgeKinds = edgeKinds;
  if (ids !== undefined) normalized.ids = ids;
  if (selector.text !== undefined) normalized.text = selector.text.trim();
  if (selector.limit !== undefined) normalized.limit = selector.limit;
  return normalized;
}

function normalizeNamedQueryInput(query: ValidationGraphNamedQueryInput): ValidationGraphNamedQueryInput {
  const normalized: ValidationGraphNamedQueryInput = {
    queryKind: query.queryKind,
    target: query.target.trim()
  };
  if (query.maxDepth !== undefined) normalized.maxDepth = query.maxDepth;
  if (query.limit !== undefined) normalized.limit = query.limit;
  return normalized;
}

function normalizeImpactInput(query: ValidationGraphImpactInput): ValidationGraphImpactInput {
  const normalized: ValidationGraphImpactInput = {
    files: normalizeFiles(query.files)
  };
  if (query.baseRef !== undefined) normalized.baseRef = query.baseRef;
  if (query.maxDepth !== undefined) normalized.maxDepth = query.maxDepth;
  if (query.limit !== undefined) normalized.limit = query.limit;
  return normalized;
}

function normalizeReviewContextInput(query: ValidationGraphReviewContextInput): ValidationGraphReviewContextInput {
  const normalized: ValidationGraphReviewContextInput = {};
  if (query.files !== undefined) normalized.files = normalizeFiles(query.files);
  if (query.baseRef !== undefined) normalized.baseRef = query.baseRef;
  if (query.maxDepth !== undefined) normalized.maxDepth = query.maxDepth;
  if (query.limit !== undefined) normalized.limit = query.limit;
  return normalized;
}

function normalizeDetectChangesInput(query: ValidationGraphDetectChangesInput): ValidationGraphDetectChangesInput {
  const normalized: ValidationGraphDetectChangesInput = {};
  if (query.files !== undefined) normalized.files = normalizeFiles(query.files);
  if (query.baseRef !== undefined) normalized.baseRef = query.baseRef;
  return normalized;
}

async function resolveInitialGraphStatus(args: CreateValidationGraphQuerySessionArgs): Promise<GraphProviderStatus> {
  const provider = args.request.graph.provider ?? defaultValidationGraphProvider;
  let status: GraphProviderStatus | undefined = args.status ?? args.request.graph.status;
  if (status === undefined && args.client !== undefined) {
    try {
      status = (await args.client.status(args.request)) ?? undefined;
    } catch (error) {
      status = queryFailureStatus(args.request, "status", error);
    }
  }
  const resolved = status ?? missingGraphStatus(args.request.graph.mode, provider);
  return validateStatusForRequest(resolved, args.request, "Validation graph provider status");
}

function validateStatusForRequest(status: GraphProviderStatus, request: ValidationRequest, label: string): GraphProviderStatus {
  const validated = validateProviderStatus(status);
  const provider = request.graph.provider ?? defaultValidationGraphProvider;
  if (validated.mode !== request.graph.mode) {
    throw new Error(`${label} mode must match validation graph mode`);
  }
  if (validated.provider !== provider) {
    throw new Error(`${label} provider must match validation graph provider`);
  }
  return validated;
}

function requireAvailableResult<Result extends { status: GraphProviderStatus }>(
  operation: Exclude<ValidationGraphOperation, "status">,
  result: Result
): Result & { status: Extract<GraphProviderStatus, { state: "available" }> } {
  if (result.status.state !== "available") {
    throw new ValidationGraphProviderError(operation, nonAvailableStatus(result.status));
  }
  return result as Result & { status: Extract<GraphProviderStatus, { state: "available" }> };
}

function requireAvailableFactQueryResult(result: GraphFactQueryResult): GraphFactQueryAvailableResult {
  return requireAvailableResult("factQuery", result) as GraphFactQueryAvailableResult;
}

function requireAvailableNamedQueryResult(
  operation: Exclude<ValidationGraphOperation, "status">,
  result: GraphNamedQueryResult
): GraphNamedQueryAvailableResult {
  return requireAvailableResult(operation, result) as GraphNamedQueryAvailableResult;
}

function requireAvailableImpactResult(
  operation: Exclude<ValidationGraphOperation, "status">,
  result: GraphImpactResult
): GraphImpactAvailableResult {
  return requireAvailableResult(operation, result) as GraphImpactAvailableResult;
}

function requireAvailableReviewContextResult(
  operation: Exclude<ValidationGraphOperation, "status">,
  result: GraphReviewContextResult
): GraphReviewContextAvailableResult {
  return requireAvailableResult(operation, result) as GraphReviewContextAvailableResult;
}

function requireAvailableDetectChangesResult(
  operation: Exclude<ValidationGraphOperation, "status">,
  result: GraphDetectChangesResult
): GraphDetectChangesAvailableResult {
  return requireAvailableResult(operation, result) as GraphDetectChangesAvailableResult;
}

function nonAvailableStatus(status: GraphProviderStatus): GraphProviderNonAvailableStatus {
  if (status.state === "available") {
    throw new Error("Graph provider available status cannot be treated as unavailable");
  }
  return status as GraphProviderNonAvailableStatus;
}

function queryFailureStatus(
  request: ValidationRequest,
  operation: ValidationGraphOperation,
  cause: unknown
): GraphProviderNonAvailableStatus {
  const causeMessage = errorMessage(cause);
  const message = `Graph provider ${operation} failed${causeMessage.length > 0 ? `: ${causeMessage}` : ""}`;
  const failure: GraphProviderNonAvailableStatus = {
    state: "error",
    mode: request.graph.mode,
    provider: request.graph.provider ?? defaultValidationGraphProvider,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    message,
    failure: {
      category: "query_failed",
      message
    }
  };
  if (causeMessage.length > 0) failure.failure.cause = causeMessage;
  return validateProviderStatus(failure) as GraphProviderNonAvailableStatus;
}

function graphFailureMessage(status: GraphProviderStatus): string {
  if ("failure" in status) return status.failure.message;
  return status.message ?? `Graph provider is not available: ${status.state}`;
}

function filterFactResult(
  result: GraphFactQueryAvailableResult,
  selector: GraphFactQuerySelector
): GraphFactQueryAvailableResult {
  if (selector.kind === "edges" || selector.kind === "neighbors") {
    const edges = result.edges.filter((edge) => matchesEdgeSelector(edge, selector));
    return {
      ...result,
      nodes: endpointNodes(result.nodes, edges),
      edges
    };
  }

  if (selector.kind === "nodes" || selector.kind === "symbols") {
    const nodes = result.nodes.filter((node) => matchesNodeSelector(node, selector));
    const edges = edgesBetweenSelected(result.edges, nodes);
    return {
      ...result,
      nodes,
      edges
    };
  }

  return {
    ...result,
    nodes: result.nodes.filter((node) => matchesNodeSelector(node, selector)),
    edges: result.edges.filter((edge) => matchesEdgeSelector(edge, selector))
  };
}

function matchesNodeSelector(node: GraphFactNode, selector: GraphFactQuerySelector): boolean {
  if (selector.kind === "edges") return false;
  if (selector.kind === "symbols" && node.kind === "File") return false;
  if (selector.nodeKinds !== undefined && selector.nodeKinds.length > 0 && !selector.nodeKinds.includes(node.kind)) return false;
  if (
    selector.ids !== undefined &&
    selector.ids.length > 0 &&
    !selector.ids.includes(node.id) &&
    (node.path === undefined || !selector.ids.includes(node.path))
  ) {
    return false;
  }
  if (selector.text !== undefined && !nodeContainsText(node, selector.text)) return false;
  return true;
}

function matchesEdgeSelector(edge: GraphFactEdge, selector: GraphFactQuerySelector): boolean {
  if (selector.kind === "nodes" || selector.kind === "symbols") return false;
  if (selector.edgeKinds !== undefined && selector.edgeKinds.length > 0 && !selector.edgeKinds.includes(edge.kind)) return false;
  if (selector.ids !== undefined && selector.ids.length > 0) {
    const endpointMatches = selector.ids.includes(edge.from) || selector.ids.includes(edge.to);
    const edgeIdMatches = edge.id !== undefined && selector.ids.includes(edge.id);
    if (selector.kind === "neighbors") {
      if (!endpointMatches) return false;
    } else if (!endpointMatches && !edgeIdMatches) {
      return false;
    }
  }
  return true;
}

function endpointNodes(nodes: readonly GraphFactNode[], edges: readonly GraphFactEdge[]): readonly GraphFactNode[] {
  const endpointIds = new Set<string>();
  for (const edge of edges) {
    endpointIds.add(edge.from);
    endpointIds.add(edge.to);
  }
  return nodes.filter((node) => endpointIds.has(node.id));
}

function edgesBetweenSelected(edges: readonly GraphFactEdge[], nodes: readonly GraphFactNode[]): readonly GraphFactEdge[] {
  const selectedIds = new Set(nodes.map((node) => node.id));
  return edges.filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to));
}

function nodeContainsText(node: GraphFactNode, text: string): boolean {
  const normalized = text.toLocaleLowerCase();
  return [node.id, node.path, node.name].some((value) => value?.toLocaleLowerCase().includes(normalized));
}

function selectorCovers(covering: GraphFactQuerySelector, requested: GraphFactQuerySelector): boolean {
  if (covering.limit !== undefined) return false;
  if (requested.limit !== undefined) return false;
  if (covering.kind !== requested.kind) return false;
  if (covering.text !== requested.text) return false;
  return (
    optionalArrayCovers(covering.nodeKinds, requested.nodeKinds) &&
    optionalArrayCovers(covering.edgeKinds, requested.edgeKinds) &&
    optionalArrayCovers(covering.ids, requested.ids)
  );
}

function operationCacheKey(request: ValidationRequest, operation: ValidationGraphOperation, payload: unknown): string {
  return stableStringify({
    repo: normalizeRepoIdentity(request.repo),
    mode: request.graph.mode,
    provider: request.graph.provider ?? defaultValidationGraphProvider,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    operation,
    payload
  });
}

function requestId(operation: ValidationGraphOperation): string | undefined {
  return `validation-${operation}`;
}

function normalizeRepoIdentity(repo: RepoIdentity): RepoIdentity {
  const normalized: RepoIdentity = {};
  if (repo.repoId !== undefined) normalized.repoId = repo.repoId;
  if (repo.repoRoot !== undefined) normalized.repoRoot = repo.repoRoot.replaceAll("\\", "/");
  if (repo.remoteUrl !== undefined) normalized.remoteUrl = repo.remoteUrl;
  if (repo.commitSha !== undefined) normalized.commitSha = repo.commitSha;
  return normalized;
}

function normalizeFiles(files: readonly string[]): readonly string[] {
  return uniqueSorted(files.map((file) => validateRepoRelativePath(file)));
}

function fileNodeId(path: string): string {
  return `file:${path}`;
}

function unionOptional<T extends string>(left: readonly T[] | undefined, right: readonly T[] | undefined): readonly T[] | undefined {
  const normalizedLeft = normalizeOptionalArray(left);
  const normalizedRight = normalizeOptionalArray(right);
  if (normalizedLeft === undefined || normalizedRight === undefined) return undefined;
  return uniqueSorted([...normalizedLeft, ...normalizedRight]);
}

function optionalArrayCovers<T extends string>(covering: readonly T[] | undefined, requested: readonly T[] | undefined): boolean {
  const normalizedCovering = normalizeOptionalArray(covering);
  const normalizedRequested = normalizeOptionalArray(requested);
  if (normalizedRequested === undefined) return normalizedCovering === undefined;
  if (normalizedCovering === undefined) return true;
  const coveringSet = new Set(normalizedCovering);
  return normalizedRequested.every((entry) => coveringSet.has(entry));
}

function normalizeOptionalArray<T extends string>(values: readonly T[] | undefined): readonly T[] | undefined {
  if (values === undefined) return undefined;
  const normalized = uniqueSorted(values);
  return normalized.length === 0 ? undefined : normalized;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort();
}

function cacheQuery<T>(cache: Map<string, Promise<T>>, key: string, query: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const promise = query();
  cache.set(key, promise);
  return promise;
}

function attributeString(node: GraphFactNode, key: string): string | undefined {
  const value = node.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}

function normalizedChecksum(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const normalized = value.trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(normalized)) return `sha256:${normalized.slice("sha256:".length).toLowerCase()}`;
  if (/^[a-f0-9]{64}$/i.test(normalized)) return `sha256:${normalized.toLowerCase()}`;
  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, JsonValue | undefined>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    const entry = object[key];
    if (entry !== undefined) result[key] = stableValue(entry);
  }
  return result;
}

function errorMessage(error: unknown): string {
  if (error === undefined) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}
