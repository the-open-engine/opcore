export const GRAPH_SCHEMA_VERSION = 1 as const;

export const graphProviderModes = ["optional", "required"] as const;
export type GraphProviderMode = (typeof graphProviderModes)[number];

export const graphProviderStatusStates = [
  "available",
  "warming",
  "skipped",
  "required_missing",
  "stale",
  "schema_mismatch",
  "daemon_unavailable",
  "error"
] as const;
export type GraphProviderStatusState = (typeof graphProviderStatusStates)[number];

export const requiredGraphNodeKinds = [
  "repo",
  "package",
  "file",
  "symbol",
  "test",
  "File",
  "Module",
  "Class",
  "Function",
  "Variable",
  "Type",
  "Test",
  "Struct",
  "Enum",
  "Trait",
  "Impl",
  "Method",
  "TypeAlias",
  "Const",
  "Static",
  "Macro"
] as const;
export type GraphNodeKind = (typeof requiredGraphNodeKinds)[number] | (string & {});

export const requiredGraphEdgeKinds = [
  "CONTAINS",
  "DECLARES",
  "IMPORTS_FROM",
  "CALLS",
  "TESTED_BY",
  "INHERITS",
  "IMPLEMENTS",
  "DEPENDS_ON"
] as const;
export type GraphEdgeKind = (typeof requiredGraphEdgeKinds)[number] | (string & {});

export const graphSnapshotMetadataKeys = [
  "schemaVersion",
  "provider",
  "repo",
  "generatedAt",
  "freshness",
  "nodeKinds",
  "edgeKinds"
] as const;
export type GraphSnapshotMetadataKey = (typeof graphSnapshotMetadataKeys)[number];

export const providerFailureCategories = [
  "provider_missing",
  "daemon_unavailable",
  "schema_mismatch",
  "stale_snapshot",
  "query_failed",
  "incompatible_provider",
  "provider_error",
  "permission_denied",
  "unsupported_mode",
  "unknown"
] as const;
export type ProviderFailureCategory = (typeof providerFailureCategories)[number];

export const graphProviderFailureCategoriesByState = {
  skipped: ["provider_missing"],
  required_missing: ["provider_missing"],
  stale: ["stale_snapshot"],
  schema_mismatch: ["schema_mismatch"],
  daemon_unavailable: ["daemon_unavailable"],
  error: ["query_failed", "incompatible_provider", "provider_error", "permission_denied", "unsupported_mode", "unknown"]
} as const satisfies Record<Exclude<GraphProviderStatusState, "available" | "warming">, readonly ProviderFailureCategory[]>;
export type GraphProviderErrorFailureCategory = (typeof graphProviderFailureCategoriesByState.error)[number];

export const graphExtractionDiagnosticCategories = [
  "missing_tsconfig",
  "malformed_tsconfig",
  "unsupported_language",
  "parse_error",
  "missing_parser",
  "unresolved_import",
  "max_files_exceeded",
  "max_depth_exceeded",
  "path_traversal",
  "io_error"
] as const;
export type GraphExtractionDiagnosticCategory = (typeof graphExtractionDiagnosticCategories)[number];

export const editRefusalCategories = [
  "absolute_path",
  "parent_directory",
  "ambiguous_repo_identity",
  "validation_failed",
  "provider_required_missing",
  "schema_mismatch",
  "unsafe_edit",
  "conflict",
  "unsupported_change"
] as const;
export type EditRefusalCategory = (typeof editRefusalCategories)[number];

export const validationDiagnosticCategories = [
  "syntax",
  "types",
  "lint",
  "test",
  "graph",
  "policy",
  "provider",
  "infrastructure",
  "edit_safety"
] as const;
export type ValidationDiagnosticCategory = (typeof validationDiagnosticCategories)[number];

export const validationResultStatuses = [
  "passed",
  "policy_failure",
  "infrastructure_failure",
  "provider_failure",
  "unsupported_request",
  "invalid_payload",
  "skipped",
  "refused"
] as const;
export type ValidationResultStatus = (typeof validationResultStatuses)[number];

export const validationFailureCategories = [
  "policy_failure",
  "infrastructure_failure",
  "provider_failure",
  "unsupported_request",
  "invalid_payload",
  "skipped"
] as const;
export type ValidationFailureCategory = (typeof validationFailureCategories)[number];

export const validationCheckRunStatuses = [
  "passed",
  "policy_failure",
  "infrastructure_failure",
  "provider_failure",
  "unsupported_request",
  "skipped"
] as const;
export type ValidationCheckRunStatus = (typeof validationCheckRunStatuses)[number];

export const validationSkippedCheckReasons = [
  "graph_unavailable",
  "unsupported_scope",
  "not_requested",
  "no_files",
  "provider_failure"
] as const;
export type ValidationSkippedCheckReason = (typeof validationSkippedCheckReasons)[number];

export const validationCheckIdPattern = "^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$" as const;
const validationCheckIdRegex = new RegExp(validationCheckIdPattern);
const latencyStableIdRegex = /^[a-z][a-z0-9_-]*$/;
const latencyTelemetryCommandTokenRegex = /^(?=.*[A-Za-z0-9])[-@A-Za-z0-9._,:=]+$/;
const latencyTelemetrySourceFileExtensionRegex =
  /\.(?:[cm]?[tj]sx?|mjs|cjs|jsonl?|rs|pyi?|mdx?|toml|lock|ya?ml|txt|inc|css|s[ac]ss|html?|vue|svelte|go|java|rb|php|swift|kts?|scala|lua|cs|c|cc|cpp|h|hpp)(?:$|[,=:])/i;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface RepoIdentity {
  repoId?: string;
  repoRoot?: string;
  remoteUrl?: string;
  commitSha?: string;
}

export interface GraphFreshness {
  generatedAt: string;
  ageMs: number;
  maxAgeMs?: number;
  stale: boolean;
  reason?: string;
}

export interface GraphProviderArtifactMetadata {
  artifactName: "lattice-graph-core" | (string & {});
  artifactVersion: string;
  targetPlatform: string;
  binaryPath: string;
  checksumPath: string;
  checksumSha256: string;
  buildProfile: string;
}

export interface GraphProviderCapabilityHandshake {
  provider: "lattice-graph" | (string & {});
  graphSchemaVersion: number;
  artifactName: "lattice-graph-core" | (string & {});
  artifactVersion: string;
  targetPlatform: string;
  supportedOperations: readonly GraphDaemonOperation[];
  nodeKinds: readonly GraphNodeKind[];
  edgeKinds: readonly GraphEdgeKind[];
  queryKinds: readonly GraphProviderQueryKind[];
  artifact: GraphProviderArtifactMetadata;
}

export interface ProviderFailure {
  category: ProviderFailureCategory;
  message: string;
  retryable?: boolean;
  cause?: string;
}
export type ProviderFailureWithCategory<Category extends ProviderFailureCategory> = ProviderFailure & { category: Category };

export interface GraphExtractionDiagnostic {
  category: GraphExtractionDiagnosticCategory;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
  language?: string;
}

export interface GraphProviderStatusBase {
  state: GraphProviderStatusState;
  mode: GraphProviderMode;
  provider: string;
  schemaVersion: number;
  message?: string;
}

export interface GraphProviderAvailableStatus extends GraphProviderStatusBase {
  state: "available";
  repo: RepoIdentity;
  freshness: GraphFreshness;
  dbPath?: string;
  capabilities?: readonly string[];
  handshake?: GraphProviderCapabilityHandshake;
  walCheckpoint?: GraphWalCheckpointSummary;
}

export interface GraphProviderWarmingStatus extends GraphProviderStatusBase {
  state: "warming";
  repo: RepoIdentity;
  freshness: GraphFreshness;
  lifecycle?: GraphWatchLifecycle;
}

export interface GraphProviderSkippedStatus extends GraphProviderStatusBase {
  state: "skipped";
  mode: "optional";
  failure: ProviderFailureWithCategory<"provider_missing">;
}

export interface GraphProviderRequiredMissingStatus extends GraphProviderStatusBase {
  state: "required_missing";
  mode: "required";
  failure: ProviderFailureWithCategory<"provider_missing">;
}

export interface GraphProviderStaleStatus extends GraphProviderStatusBase {
  state: "stale";
  repo: RepoIdentity;
  freshness: GraphFreshness;
  failure: ProviderFailureWithCategory<"stale_snapshot">;
}

export interface GraphProviderSchemaMismatchStatus extends GraphProviderStatusBase {
  state: "schema_mismatch";
  expectedSchemaVersion: number;
  actualSchemaVersion: number;
  failure: ProviderFailureWithCategory<"schema_mismatch">;
}

export interface GraphProviderDaemonUnavailableStatus extends GraphProviderStatusBase {
  state: "daemon_unavailable";
  failure: ProviderFailureWithCategory<"daemon_unavailable">;
}

export interface GraphProviderErrorStatus extends GraphProviderStatusBase {
  state: "error";
  failure: ProviderFailureWithCategory<GraphProviderErrorFailureCategory>;
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type GraphProviderStatus =
  | GraphProviderAvailableStatus
  | GraphProviderWarmingStatus
  | GraphProviderSkippedStatus
  | GraphProviderRequiredMissingStatus
  | GraphProviderStaleStatus
  | GraphProviderSchemaMismatchStatus
  | GraphProviderDaemonUnavailableStatus
  | GraphProviderErrorStatus;

export type GraphProviderFailureStatus = Exclude<GraphProviderStatus, GraphProviderAvailableStatus | GraphProviderWarmingStatus>;
export type GraphProviderNonAvailableStatus = Exclude<GraphProviderStatus, GraphProviderAvailableStatus>;

export interface GraphFactNode {
  id: string;
  kind: GraphNodeKind;
  path?: string;
  name?: string;
  attributes?: Record<string, JsonValue>;
}

export interface GraphFactEdge {
  id?: string;
  kind: GraphEdgeKind;
  from: string;
  to: string;
  attributes?: Record<string, JsonValue>;
}

export interface GraphSnapshotMetadata {
  schemaVersion: number;
  provider: string;
  repo: RepoIdentity;
  generatedAt: string;
  freshness: GraphFreshness;
  nodeKinds: readonly GraphNodeKind[];
  edgeKinds: readonly GraphEdgeKind[];
}

export interface GraphFactQuerySelector {
  kind: "nodes" | "edges" | "neighbors" | "symbols" | "impact";
  nodeKinds?: readonly GraphNodeKind[];
  edgeKinds?: readonly GraphEdgeKind[];
  ids?: readonly string[];
  text?: string;
  limit?: number;
}

export const graphFactQueryKinds = ["nodes", "edges", "neighbors", "symbols", "impact"] as const;

export const graphNamedQueryKinds = [
  "callers_of",
  "callees_of",
  "importers_of",
  "imports_of",
  "tests_for",
  "children_of",
  "file_summary"
] as const;
export type GraphNamedQueryKind = (typeof graphNamedQueryKinds)[number];
export type GraphProviderQueryKind = GraphFactQuerySelector["kind"] | GraphNamedQueryKind | "review_context" | "detect_changes" | "search";

export interface GraphFactQueryRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  selector: GraphFactQuerySelector;
}

export interface GraphFactQueryAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  nodes: readonly GraphFactNode[];
  edges: readonly GraphFactEdge[];
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export interface GraphFactQueryFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type GraphFactQueryResult = GraphFactQueryAvailableResult | GraphFactQueryFailureResult;

export interface GraphTraversalMetadata {
  maxDepth: number;
  truncated: boolean;
  total: number;
  empty: boolean;
}

export interface GraphNamedQueryRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  queryKind: GraphNamedQueryKind;
  target: string;
  maxDepth?: number;
  limit?: number;
}

export interface GraphNamedQueryAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  queryKind: GraphNamedQueryKind;
  target: string;
  nodes: readonly GraphFactNode[];
  edges: readonly GraphFactEdge[];
  traversal: GraphTraversalMetadata;
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export interface GraphNamedQueryFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type GraphNamedQueryResult = GraphNamedQueryAvailableResult | GraphNamedQueryFailureResult;

export interface GraphImpactRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  files: readonly string[];
  baseRef?: string;
  maxDepth?: number;
  limit?: number;
}

export interface GraphImpactAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  changedFiles: readonly string[];
  impactedFiles: readonly string[];
  impactedSymbols: readonly string[];
  tests: readonly string[];
  nodes: readonly GraphFactNode[];
  edges: readonly GraphFactEdge[];
  traversal: GraphTraversalMetadata;
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export interface GraphImpactFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type GraphImpactResult = GraphImpactAvailableResult | GraphImpactFailureResult;

export interface GraphRenamedFile {
  fromPath: string;
  toPath: string;
  checksumBefore?: string;
  checksumAfter?: string;
}

export interface GraphDetectChangesRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  files?: readonly string[];
  baseRef?: string;
}

export interface GraphDetectChangesAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  changedFiles: readonly string[];
  deletedFiles: readonly string[];
  renamedFiles: readonly GraphRenamedFile[];
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export interface GraphDetectChangesFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type GraphDetectChangesResult = GraphDetectChangesAvailableResult | GraphDetectChangesFailureResult;

export interface GraphReviewContextRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  files?: readonly string[];
  baseRef?: string;
  maxDepth?: number;
  limit?: number;
}

export interface GraphReviewContextAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  changedFiles: readonly string[];
  deletedFiles: readonly string[];
  renamedFiles: readonly GraphRenamedFile[];
  impactedFiles: readonly string[];
  impactedSymbols: readonly string[];
  tests: readonly string[];
  nodes: readonly GraphFactNode[];
  edges: readonly GraphFactEdge[];
  traversal: GraphTraversalMetadata;
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export interface GraphReviewContextFailureResult {
  requestId?: string;
  status: GraphProviderFailureStatus;
}

export type GraphReviewContextResult = GraphReviewContextAvailableResult | GraphReviewContextFailureResult;

export interface InspectSymbolTarget {
  kind: "node" | "file_symbol";
  nodeId?: string;
  path?: string;
  symbolName?: string;
  line?: number;
  column?: number;
}

export type InspectReferenceTarget = InspectSymbolTarget;

export interface InspectTextSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startOffset?: number;
  endOffset?: number;
}

export type InspectReferenceSpan = InspectTextSpan;

export interface InspectSymbolSummary {
  id: string;
  name: string;
  kind?: GraphNodeKind;
}

export interface InspectSymbolEvidence {
  graphNodeIds: readonly string[];
  resolver: "graph" | "language_service";
}

export interface InspectReferenceEntry {
  file: string;
  line: number;
  column: number;
  text: string;
  span: InspectTextSpan;
  symbol: InspectSymbolSummary;
  isDefinition: boolean;
  isDeclaration?: boolean;
  evidence: InspectSymbolEvidence;
}

export const inspectSignatureKinds = [
  "function",
  "method",
  "constructor",
  "interface",
  "type_alias",
  "class",
  "variable_function"
] as const;
export type InspectSignatureKind = (typeof inspectSignatureKinds)[number];

export interface InspectSignatureParameter {
  name: string;
  type: string;
  optional: boolean;
  rest?: boolean;
  defaultValue?: string;
}

export interface InspectSignatureTypeParameter {
  name: string;
  constraint?: string;
  default?: string;
}

export interface InspectSignatureEntry {
  file: string;
  line: number;
  column: number;
  text: string;
  signature: string;
  kind: InspectSignatureKind;
  parameters: readonly InspectSignatureParameter[];
  typeParameters: readonly InspectSignatureTypeParameter[];
  exported: boolean;
  async: boolean;
  returnType?: string;
  span: InspectTextSpan;
  symbol: InspectSymbolSummary;
  overloadIndex?: number;
  evidence: InspectSymbolEvidence;
}

export const inspectImplementationKinds = ["implements", "inherited_implements", "extends", "interface_extends"] as const;
export type InspectImplementationKind = (typeof inspectImplementationKinds)[number];

export interface InspectImplementationEntry {
  file: string;
  line: number;
  column: number;
  text: string;
  span: InspectTextSpan;
  kind: InspectImplementationKind;
  symbol: InspectSymbolSummary;
  target: InspectSymbolSummary;
  isDeclaration?: boolean;
  evidence: InspectSymbolEvidence;
}

export const inspectFailureCategories = [
  "graph_unavailable",
  "target_ambiguous",
  "target_not_found",
  "unsupported_language",
  "malformed_target",
  "language_service_error",
  "unsupported_route"
] as const;
export type InspectFailureCategory = (typeof inspectFailureCategories)[number];

export interface InspectRouteFailure {
  category: InspectFailureCategory;
  message: string;
  candidates?: readonly InspectSymbolTarget[];
}

export interface InspectReferenceResult {
  route: "references";
  status: "ok";
  target: InspectSymbolTarget;
  providerStatus: GraphProviderStatus;
  references: readonly InspectReferenceEntry[];
}

export interface InspectSignatureResult {
  route: "signature";
  status: "ok";
  target: InspectSymbolTarget;
  providerStatus: GraphProviderStatus;
  signatures: readonly InspectSignatureEntry[];
}

export interface InspectImplementationResult {
  route: "implementations";
  status: "ok";
  target: InspectSymbolTarget;
  providerStatus: GraphProviderStatus;
  implementations: readonly InspectImplementationEntry[];
}

export interface InspectRouteErrorResult {
  route: "references" | "signature" | "implementations";
  status: "error" | "degraded";
  target?: InspectSymbolTarget;
  providerStatus?: GraphProviderStatus;
  failure: InspectRouteFailure;
}

export type InspectRouteResult =
  | InspectReferenceResult
  | InspectSignatureResult
  | InspectImplementationResult
  | InspectRouteErrorResult;

export interface GraphSearchRequest {
  requestId?: string;
  repo: RepoIdentity;
  schemaVersion: number;
  mode: GraphProviderMode;
  query: string;
  limit?: number;
  files?: readonly string[];
}

export interface GraphSearchMode {
  engine: "fts5" | (string & {});
  querySyntax: "fts5" | (string & {});
  limit: number;
  contextFiles: readonly string[];
}

export interface GraphSearchResultEntry {
  nodeId: string;
  kind: GraphNodeKind;
  path?: string;
  name?: string;
  qualifiedName: string;
  filePath?: string;
  signature: string;
  score: number;
  rank: number;
  matches: readonly string[];
}

export interface GraphSearchSummary {
  query: string;
  total: number;
  returned: number;
  limit: number;
  indexedNodeKinds: readonly GraphNodeKind[];
  contextFiles: readonly string[];
}

export interface GraphSearchAvailableResult {
  requestId?: string;
  status: GraphProviderAvailableStatus;
  metadata: GraphSnapshotMetadata;
  query: string;
  searchMode: GraphSearchMode;
  summary: GraphSearchSummary;
  results: readonly GraphSearchResultEntry[];
  hints: readonly string[];
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export interface GraphSearchFailureResult {
  requestId?: string;
  status: GraphProviderNonAvailableStatus;
  hints?: readonly string[];
  diagnostics?: readonly GraphExtractionDiagnostic[];
}

export type GraphSearchResult = GraphSearchAvailableResult | GraphSearchFailureResult;

export type GraphPipelineOperation = "build" | "update" | "watch";

export interface GraphPipelinePhaseTiming {
  phase: "discovery" | "extraction" | "store" | "watch" | "status" | (string & {});
  startedAt: string;
  completedAt: string;
  durationMs: number;
  fileCount?: number;
}

export interface GraphWalCheckpointSummary {
  walPath: string;
  bytesBefore: number;
  bytesAfter: number;
  budgetBytes: number;
  checkpointed: boolean;
}

export interface GraphPipelineSummary {
  operation: GraphPipelineOperation;
  repo: RepoIdentity;
  storePath?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  discoveredFiles: number;
  parsedFiles: number;
  changedFiles: readonly string[];
  deletedFiles: readonly string[];
  unchangedFiles: number;
  fullRebuildRequired: boolean;
  diagnosticsCount: number;
  phaseTimings: readonly GraphPipelinePhaseTiming[];
  baseRef?: string;
  watchPaths?: readonly string[];
  walCheckpoint?: GraphWalCheckpointSummary;
}

export interface GraphWatchLifecycle {
  state: "warming" | "available" | "error" | "stopped";
  pid?: number;
  startedAt: string;
  updatedAt: string;
  pidPath: string;
  statePath: string;
  logPath: string;
  pollIntervalMs: number;
  idleTimeoutMs: number;
  watchPaths?: readonly string[];
  message?: string;
}

export interface GraphServeTransportStatus {
  schemaVersion: 1;
  protocol: "lattice.graph.daemon";
  transport: "stdio";
  state: "ready" | "error" | "stopped";
  repo: RepoIdentity;
  provider: "lattice-graph" | (string & {});
  pid?: number;
  artifact?: GraphProviderArtifactMetadata;
  failure?: ProviderFailure;
  message?: string;
}

export interface GraphPipelineResult {
  summary: GraphPipelineSummary;
  status: GraphProviderStatus;
  lifecycle?: GraphWatchLifecycle;
}

export type GraphDaemonOperation = "build" | "update" | "watch" | "status" | "query" | "ping" | "health" | "shutdown";
export const graphDaemonOperations = ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"] as const;

export interface GraphDaemonRequest {
  protocol: "lattice.graph.daemon";
  requestId: string;
  schemaVersion: number;
  operation: GraphDaemonOperation;
  repo: RepoIdentity;
  query?: GraphFactQueryRequest;
  namedQuery?: GraphNamedQueryRequest;
  impact?: GraphImpactRequest;
  reviewContext?: GraphReviewContextRequest;
  changes?: GraphDetectChangesRequest;
  search?: GraphSearchRequest;
  baseRef?: string;
  paths?: readonly string[];
  watchPaths?: readonly string[];
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  once?: boolean;
  maxWalBytes?: number;
}

export interface GraphDaemonResponse {
  protocol: "lattice.graph.daemon";
  requestId: string;
  schemaVersion: number;
  status: GraphProviderStatus;
  result?: GraphFactQueryResult;
  namedQuery?: GraphNamedQueryResult;
  impact?: GraphImpactResult;
  reviewContext?: GraphReviewContextResult;
  changes?: GraphDetectChangesResult;
  search?: GraphSearchResult;
  pipeline?: GraphPipelineResult;
  lifecycle?: GraphWatchLifecycle;
}

export interface RepoRelativeChangeBase {
  path: string;
  checksumBefore?: string;
  checksumAfter?: string;
}

export type RepoRelativeChange =
  | (RepoRelativeChangeBase & {
      kind: "create" | "replace";
      content: string;
    })
  | (RepoRelativeChangeBase & {
      kind: "delete";
    })
  | {
      kind: "rename";
      path: string;
      toPath: string;
      checksumBefore?: string;
    };

export interface AtomicApplyMetadata {
  strategy: "all_or_nothing";
  planHash?: string;
  expectedBaseSha?: string;
}

export interface EditPlanValidationRequirement {
  required: boolean;
  request: ValidationRequest;
}

export interface EditPlan {
  planId: string;
  repo: RepoIdentity;
  changes: readonly RepoRelativeChange[];
  atomic: AtomicApplyMetadata;
  validation: EditPlanValidationRequirement;
}

export interface EditRefusal {
  category: EditRefusalCategory;
  message: string;
  path?: string;
}

export interface EditPlanResult {
  planId: string;
  ok: boolean;
  applied: boolean;
  appliedAt?: string;
  refusal?: EditRefusal;
  validation?: ValidationResult;
}

export interface EditPlanRollbackState {
  completed: boolean;
  restoredPaths: readonly string[];
  failedPaths: readonly string[];
  cleanupFailedPaths: readonly string[];
}

export interface EditCommandResult {
  ok: boolean;
  applied: boolean;
  planId?: string;
  planHash?: string;
  appliedAt?: string;
  matchCount?: number;
  afterState?: Readonly<Record<string, string | null>>;
  validationRequest?: ValidationRequest;
  validation?: ValidationResult;
  refusal?: EditRefusal;
  rollback?: EditPlanRollbackState;
}

export const validationScopeKinds = ["files", "changed", "staged", "tree", "all", "repo", "package"] as const;
export type ValidationScopeKind = (typeof validationScopeKinds)[number];

export type ValidationScope =
  | {
      kind: "files";
      files: readonly string[];
    }
  | {
      kind: "changed";
      baseRef: string;
    }
  | {
      kind: "staged";
    }
  | {
      kind: "tree";
      treeRef: string;
      changedFrom: string;
    }
  | {
      kind: "all";
    }
  | {
      kind: "repo";
    }
  | {
      kind: "package";
      packageName: string;
      packageRoot: string;
    };

export type HypotheticalOverlay =
  | {
      path: string;
      action: "write";
      content: string;
      checksumBefore?: string;
    }
  | {
      path: string;
      action: "delete";
      checksumBefore?: string;
    };

export interface ValidationFailure {
  category: ValidationFailureCategory;
  message: string;
  retryable?: boolean;
  cause?: string;
}

export interface ValidationGraphConfig {
  mode: GraphProviderMode;
  provider?: string;
  maxAgeMs?: number;
  status?: GraphProviderStatus;
}

export interface ValidationRequest {
  requestId?: string;
  repo: RepoIdentity;
  scope: ValidationScope;
  graph: ValidationGraphConfig;
  overlays: readonly HypotheticalOverlay[];
  checks?: readonly string[];
}

export interface ValidationDiagnostic {
  category: ValidationDiagnosticCategory;
  message: string;
  path?: string;
  severity: "info" | "warning" | "error";
  code?: string;
}

export interface ValidationCheckManifestEntry {
  checkId: string;
  owner: string;
  adapter: string;
  defaultSeverity: ValidationDiagnostic["severity"];
  supportedScopes: readonly ValidationScopeKind[];
  requiresGraph: boolean;
}

export interface ValidationCheckRunSummary {
  checkId: string;
  status: ValidationCheckRunStatus;
  durationMs?: number;
  diagnosticCount?: number;
  failureMessage?: string;
}

export interface ValidationSkippedCheck {
  checkId: string;
  reason: ValidationSkippedCheckReason;
  message: string;
}

export interface ValidationResultManifest {
  schemaVersion: number;
  checks: readonly string[];
  generatedAt: string;
  entries?: readonly ValidationCheckManifestEntry[];
  durationMs?: number;
  runs?: readonly ValidationCheckRunSummary[];
  skippedChecks?: readonly ValidationSkippedCheck[];
}

export interface ValidationResult {
  ok: boolean;
  status: ValidationResultStatus;
  diagnostics: readonly ValidationDiagnostic[];
  graphStatus?: GraphProviderStatus;
  failure?: ValidationFailure;
  refusal?: EditRefusal;
  manifest?: ValidationResultManifest;
}

export interface PreWriteValidationOverlaySummary {
  count: number;
  writeCount: number;
  deleteCount: number;
  paths: readonly string[];
}

export interface PreWriteValidationFailureSummary {
  category: ValidationResultStatus;
  message: string;
  cause?: string;
  retryable?: boolean;
}

export interface PreWriteValidationReceipt {
  schemaVersion: 1;
  kind: "pre_write_validation";
  route: "validate.pre-write";
  canonicalCommand: readonly string[];
  generatedAt: string;
  durationMs: number;
  timeoutMs: number;
  ok: boolean;
  requestId?: string;
  repo?: RepoIdentity;
  scope?: ValidationScope;
  checks?: readonly string[];
  graph?: {
    mode: GraphProviderMode;
    provider?: string;
    status?: GraphProviderStatus;
  };
  overlays?: PreWriteValidationOverlaySummary;
  validationStatus: ValidationResultStatus;
  diagnosticCount: number;
  failureSummary?: PreWriteValidationFailureSummary;
}

export const validationDaemonReadinessStates = ["not_configured", "ready", "unavailable", "error"] as const;
export type ValidationDaemonReadinessState = (typeof validationDaemonReadinessStates)[number];

export const validationAdapterRuntimeStates = ["available", "degraded", "unavailable"] as const;
export type ValidationAdapterRuntimeState = (typeof validationAdapterRuntimeStates)[number];

export interface ValidationAdapterToolchainStatus {
  tool: string;
  available: boolean;
  command?: string;
  version?: string;
  failureMessage?: string;
}

export interface ValidationAdapterDegradedCheckStatus {
  checkId: string;
  status: ValidationCheckRunStatus;
  reason: string;
  message: string;
  requiredTool?: string;
  retainedCompatibility?: boolean;
  followUpIssue?: string;
  currentUsage?: {
    lattice: boolean;
    orchestra: boolean;
    covibes: boolean;
    gateway: boolean;
  };
}

export interface ValidationAdapterRuntimeStatus {
  adapter: string;
  status: ValidationAdapterRuntimeState;
  checkIds: readonly string[];
  toolchain?: readonly ValidationAdapterToolchainStatus[];
  degradedChecks?: readonly ValidationAdapterDegradedCheckStatus[];
  tempWorkspaceRequired?: boolean;
}

export interface ValidationStatusPayload {
  schemaVersion: 1;
  ready: boolean;
  generatedAt: string;
  adapterRegistry: {
    checkRoutes: readonly string[];
    validateRoutes: readonly string[];
    checkIds: readonly string[];
    entries: readonly ValidationCheckManifestEntry[];
    adapters?: readonly ValidationAdapterRuntimeStatus[];
  };
  graph: {
    mode: GraphProviderMode;
    status: GraphProviderStatus;
  };
  daemon?: {
    state: ValidationDaemonReadinessState;
    message?: string;
  };
}

export const managedToolDescriptorCommandGroups = ["graph", "inspect", "edit", "check", "validate", "status", "doctor"] as const;
export type ManagedToolDescriptorCommandGroupName = (typeof managedToolDescriptorCommandGroups)[number];

const managedToolDescriptorCommandGroupPackageNames: Record<ManagedToolDescriptorCommandGroupName, string> = {
  graph: "@the-open-engine/opcore-graph",
  inspect: "@the-open-engine/opcore",
  edit: "@the-open-engine/opcore-edit",
  check: "@the-open-engine/opcore-validation",
  validate: "@the-open-engine/opcore-validation",
  status: "@the-open-engine/opcore",
  doctor: "@the-open-engine/opcore"
};

export const managedToolDescriptorArtifactTypes = [
  "entrypoint",
  "descriptor",
  "schema",
  "manifest",
  "native_binary",
  "checksum",
  "receipt"
] as const;
export type ManagedToolDescriptorArtifactType = (typeof managedToolDescriptorArtifactTypes)[number];

export interface ManagedToolDescriptor {
  schemaVersion: 1;
  descriptorKind: "aggregate_lattice";
  aggregateIdentity: {
    name: "lattice";
    releaseLine: "lattice";
    packageName: "@the-open-engine/opcore";
    version?: string;
  };
  packageIdentity: {
    packageName: "@the-open-engine/opcore";
    artifactName: "@the-open-engine/opcore";
    version?: string;
  };
  entrypoints: readonly ManagedToolDescriptorEntrypoint[];
  commandGroups: readonly ManagedToolDescriptorCommandGroup[];
  healthProbes: readonly ManagedToolDescriptorHealthProbe[];
  capabilities: ManagedToolDescriptorCapabilities;
  artifacts: readonly ManagedToolDescriptorArtifactReference[];
  checksums: readonly ManagedToolDescriptorChecksumReference[];
  provenanceHooks: readonly ManagedToolDescriptorProvenanceHook[];
  optionalSurfaces: readonly GraphReleaseOptionalSurfaceReceipt[];
}

export interface ManagedToolDescriptorEntrypoint {
  bin: "lattice";
  packageName: "@the-open-engine/opcore";
  path: string;
  command: readonly string[];
}

export interface ManagedToolDescriptorCommandGroup {
  name: ManagedToolDescriptorCommandGroupName;
  canonicalCommand: readonly string[];
  commands: readonly string[];
  packageName: string;
}

export interface ManagedToolDescriptorHealthProbe {
  id: string;
  command: readonly string[];
  expectedExitCode: 0;
  output: "json";
}

export interface ManagedToolDescriptorCapabilities {
  graph: {
    provider: "lattice-graph";
    schemaVersion: 1;
    commands: readonly string[];
    queryKinds: readonly string[];
    daemonOperations: readonly string[];
    nativeArtifacts: readonly ManagedToolDescriptorNativeArtifact[];
  };
  edit: {
    commands: readonly string[];
    safeEditModes: readonly string[];
    symbolEditModes: readonly string[];
    validationRequiredForApply: true;
    dryRun: true;
  };
  validation: {
    checkRoutes: readonly string[];
    validateRoutes: readonly string[];
    scopeModes: readonly ValidationScopeKind[];
    graphModes: readonly GraphProviderMode[];
    hypothetical: true;
    statusSurfaces: readonly ("status" | "doctor")[];
    checkIds: readonly string[];
  };
}

export interface ManagedToolDescriptorNativeArtifact {
  targetPlatform: GraphCoreNativeSupportedTarget;
  packageName: GraphCoreNativePackageName;
  binaryPath: "lattice-graph-core";
  metadataPath: "metadata.json";
  checksumPath: "lattice-graph-core.sha256";
  artifactIds: {
      binaryArtifactId: string;
      metadataArtifactId: string;
      checksumId: string;
      checksumArtifactId: string;
    };
}

export interface ManagedToolDescriptorArtifactReference {
  id: string;
  packageName: string;
  path: string;
  type: ManagedToolDescriptorArtifactType;
  required: boolean;
  checksumRef?: string;
}

export interface ManagedToolDescriptorChecksumReference {
  id: string;
  packageName: string;
  path: string;
  algorithm: "sha256";
  artifactRef: string;
  required: boolean;
  value?: string;
}

export interface ManagedToolDescriptorProvenanceHook {
  id: string;
  command: readonly string[];
  expectedExitCode: 0;
}

export const commandOwners = ["graph", "inspect", "edit", "validation", "runtime"] as const;
export type CommandOwner = (typeof commandOwners)[number];

export const commandRouteStatuses = ["ok", "error", "not_implemented", "unsupported"] as const;
export type CommandRouteStatus = (typeof commandRouteStatuses)[number];

export const commandTimingProcessStates = ["cold", "warm"] as const;
export type CommandTimingProcessState = (typeof commandTimingProcessStates)[number];

export const commandTimingDegradationReasons = ["no_source", "no_paths"] as const;
export type CommandTimingDegradationReason = (typeof commandTimingDegradationReasons)[number];

export const latencyBudgetResultStatuses = ["pass", "over"] as const;
export type LatencyBudgetResultStatus = (typeof latencyBudgetResultStatuses)[number];

export const commandLatencyTelemetryBins = ["lattice", "opcore", "opcore-asp-provider"] as const;
export type CommandLatencyTelemetryBin = (typeof commandLatencyTelemetryBins)[number];

export const commandLatencyTelemetryArtifactPolicy = {
  path: ".opcore/telemetry.jsonl",
  maxRecords: 500,
  maxBytes: 1024 * 1024,
  rotation: "ring_buffer"
} as const;

export const graphReferenceEvidenceClassifications = ["required", "supporting", "optional", "deferred"] as const;
export type GraphReferenceEvidenceClassification = (typeof graphReferenceEvidenceClassifications)[number];

export const graphReleaseCoreCommandIds = [
  "lattice-graph-build",
  "lattice-graph-update",
  "lattice-graph-watch",
  "lattice-graph-status",
  "lattice-graph-query",
  "lattice-graph-impact",
  "lattice-graph-search",
  "lattice-graph-serve"
] as const;
export type GraphReleaseCoreCommandId = (typeof graphReleaseCoreCommandIds)[number];

export const graphReleaseBenchmarkMetrics = [
  "install_setup_ms",
  "cold_build_ms",
  "incremental_update_ms",
  "impact_cold_ms",
  "impact_hot_ms",
  "search_ms",
  "daemon_startup_ms",
  "daemon_query_ms",
  "db_size_bytes",
  "wal_size_bytes"
] as const;
export type GraphReleaseBenchmarkMetric = (typeof graphReleaseBenchmarkMetrics)[number];

export const graphReleaseRequiredChildren = ["#35", "#8", "#9", "#10", "#11", "#12", "#19", "#47"] as const;
export type GraphReleaseRequiredChild = (typeof graphReleaseRequiredChildren)[number];

export const graphReleaseDeferredChildren = ["#13", "#14", "#15", "#16"] as const;
export type GraphReleaseDeferredChild = (typeof graphReleaseDeferredChildren)[number];

export const graphReleaseOptionalAnalysisSurfaces = [
  {
    issue: "#13",
    id: "coverage",
    classification: "deferred",
    status: "deferred"
  },
  {
    issue: "#14",
    id: "flows",
    classification: "optional",
    status: "deferred"
  },
  {
    issue: "#15",
    id: "communities",
    classification: "optional",
    status: "deferred"
  },
  {
    issue: "#16",
    id: "read_only_suggestions",
    classification: "supporting",
    status: "deferred"
  }
] as const;
export type GraphReleaseOptionalAnalysisSurface = (typeof graphReleaseOptionalAnalysisSurfaces)[number];

export const graphReleaseHandoffIssues = ["#7", "#28", "#29"] as const;
export type GraphReleaseHandoffIssue = (typeof graphReleaseHandoffIssues)[number];

export const graphReleaseDirectSqliteQueryIds = [
  "status-counts",
  "status-edge-counts",
  "impact-edges-from-file",
  "search-by-name",
  "freshness-metadata"
] as const;
export type GraphReleaseDirectSqliteQueryId = (typeof graphReleaseDirectSqliteQueryIds)[number];

export const graphReleaseServeTransportIds = [
  "serve-jsonl-ping",
  "serve-jsonl-status",
  "serve-jsonl-query",
  "serve-jsonl-search",
  "serve-jsonl-shutdown"
] as const;
export type GraphReleaseServeTransportId = (typeof graphReleaseServeTransportIds)[number];

export const graphReleaseReportReceiptIds = ["conformance", "pack", "license", "provenance"] as const;
export type GraphReleaseReportReceiptId = (typeof graphReleaseReportReceiptIds)[number];

export const graphCoreNativeSupportedTargets = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
export type GraphCoreNativeSupportedTarget = (typeof graphCoreNativeSupportedTargets)[number];

export const graphCoreNativePackageNames = [
  "@the-open-engine/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64"
] as const;
export type GraphCoreNativePackageName = (typeof graphCoreNativePackageNames)[number];

export const graphCoreNativePackageNamesByTarget = {
  "darwin-arm64": "@the-open-engine/opcore-graph-core-darwin-arm64",
  "darwin-x64": "@the-open-engine/opcore-graph-core-darwin-x64",
  "linux-x64": "@the-open-engine/opcore-graph-core-linux-x64"
} as const satisfies Record<GraphCoreNativeSupportedTarget, GraphCoreNativePackageName>;

export function graphCoreNativePackageNameForTarget(target: GraphCoreNativeSupportedTarget): GraphCoreNativePackageName {
  return graphCoreNativePackageNamesByTarget[target];
}

export const releaseReceiptPackageNames = [
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore",
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  "@the-open-engine/opcore-asp-provider"
] as const;
export type ReleaseReceiptPackageName = (typeof releaseReceiptPackageNames)[number];

export const releaseReceiptCommandGroups = ["graph", "inspect", "edit", "check", "validate", "status", "doctor"] as const;
export type ReleaseReceiptCommandGroupName = (typeof releaseReceiptCommandGroups)[number];

export const releaseReceiptReportIds = [
  "package-inspection",
  "license",
  "provenance",
  "release-hygiene",
  "graph-release",
  "secret-history"
] as const;
export type ReleaseReceiptReportId = (typeof releaseReceiptReportIds)[number];

export const releaseReceiptSecretFindingScopes = ["current-tree", "git-history"] as const;
export type ReleaseReceiptSecretFindingScope = (typeof releaseReceiptSecretFindingScopes)[number];

export const releaseCutoverRequiredCommandIds = [
  "opcore-scan",
  "opcore-status",
  "opcore-check-changed",
  "opcore-measure",
  "opcore-try",
  "status",
  "doctor",
  "graph-build",
  "graph-status",
  "graph-query",
  "graph-impact",
  "graph-review-context",
  "graph-detect-changes",
  "graph-search",
  "graph-serve",
  "inspect-symbols",
  "inspect-definition",
  "inspect-references",
  "inspect-signature",
  "inspect-implementations",
  "inspect-search",
  "edit-preview",
  "edit-apply",
  "edit-refused",
  "check-files",
  "validate-request",
  "validate-pre-write-pass",
  "validate-pre-write-fail"
] as const;
export type ReleaseCutoverCommandId = (typeof releaseCutoverRequiredCommandIds)[number];

export const releaseCutoverInputIssues = ["#17", "#29", "#58"] as const;
export type ReleaseCutoverInputIssue = (typeof releaseCutoverInputIssues)[number];

export const aspDogfoodRequiredGuardrailIds = ["current-tools-validate-changed", "current-tools-validate-rust-graph"] as const;
export type AspDogfoodRequiredGuardrailId = (typeof aspDogfoodRequiredGuardrailIds)[number];

export const aspDogfoodOptionalGuardrailIds = ["current-tools-validate-all"] as const;
export type AspDogfoodOptionalGuardrailId = (typeof aspDogfoodOptionalGuardrailIds)[number];

export const aspDogfoodGuardrailIds = [...aspDogfoodRequiredGuardrailIds, ...aspDogfoodOptionalGuardrailIds] as const;
export type AspDogfoodGuardrailId = (typeof aspDogfoodGuardrailIds)[number];

export const aspDogfoodUnsupportedSurfaceIds = ["inspect", "edit"] as const;
export type AspDogfoodUnsupportedSurfaceId = (typeof aspDogfoodUnsupportedSurfaceIds)[number];

export const aspDogfoodForbiddenProviderMarkers = ["lattice asp serve", "lattice asp", "dist/bin/lattice", ".ace/runtime"] as const;
export type AspDogfoodForbiddenProviderMarker = (typeof aspDogfoodForbiddenProviderMarkers)[number];
const legacyAspProviderBinMarker = ["lattice", "asp", "provider"].join("-");

const releaseCutoverRequestFilePlaceholder = "<request-file>";

type ReleaseCutoverExpectedCommandStatus = CommandRouteStatus;

interface ReleaseCutoverCommandExpectation {
  readonly canonicalCommand: readonly string[];
  readonly requestFileBasename?: string;
  readonly owner: CommandOwner;
  readonly status: ReleaseCutoverExpectedCommandStatus;
  readonly exitCode: 0 | 1 | 2 | 64;
  readonly bin: "lattice" | "opcore";
}

const releaseCutoverCommandExpectations = {
  "opcore-scan": { canonicalCommand: ["opcore", "scan"], owner: "runtime", status: "ok", exitCode: 0, bin: "opcore" },
  "opcore-status": { canonicalCommand: ["opcore", "status"], owner: "runtime", status: "ok", exitCode: 0, bin: "opcore" },
  "opcore-check-changed": {
    canonicalCommand: ["opcore", "check", "changed", "--base", "HEAD", "--checks", "typescript.syntax"],
    owner: "validation",
    status: "ok",
    exitCode: 0,
    bin: "opcore"
  },
  "opcore-measure": { canonicalCommand: ["opcore", "measure"], owner: "runtime", status: "ok", exitCode: 0, bin: "opcore" },
  "opcore-try": { canonicalCommand: ["opcore", "try"], owner: "runtime", status: "ok", exitCode: 0, bin: "opcore" },
  status: { canonicalCommand: ["lattice", "status"], owner: "runtime", status: "ok", exitCode: 0, bin: "lattice" },
  doctor: { canonicalCommand: ["lattice", "doctor"], owner: "runtime", status: "ok", exitCode: 0, bin: "lattice" },
  "graph-build": { canonicalCommand: ["lattice", "graph", "build"], owner: "graph", status: "ok", exitCode: 0, bin: "lattice" },
  "graph-status": { canonicalCommand: ["lattice", "graph", "status"], owner: "graph", status: "ok", exitCode: 0, bin: "lattice" },
  "graph-query": { canonicalCommand: ["lattice", "graph", "query"], owner: "graph", status: "ok", exitCode: 0, bin: "lattice" },
  "graph-impact": {
    canonicalCommand: ["lattice", "graph", "impact", "--files", "src/components/GreetingCard.tsx"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "graph-review-context": {
    canonicalCommand: ["lattice", "graph", "review-context", "--files", "src/components/GreetingCard.tsx"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "graph-detect-changes": {
    canonicalCommand: ["lattice", "graph", "detect-changes", "--files", "src/components/GreetingCard.tsx"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "graph-search": {
    canonicalCommand: ["lattice", "graph", "search", "Greeting", "--limit", "5"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "graph-serve": { canonicalCommand: ["lattice", "graph", "serve"], owner: "graph", status: "ok", exitCode: 0, bin: "lattice" },
  "inspect-symbols": {
    canonicalCommand: ["lattice", "inspect", "symbols", "Greeting", "--limit", "5"],
    owner: "inspect",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "inspect-definition": {
    canonicalCommand: ["lattice", "inspect", "definition", "GreetingCard"],
    owner: "inspect",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "inspect-references": {
    canonicalCommand: ["lattice", "inspect", "references", "function:src/components/GreetingCard.tsx#GreetingCard", "--limit", "5"],
    owner: "inspect",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "inspect-signature": {
    canonicalCommand: ["lattice", "inspect", "signature", "function:src/components/GreetingCard.tsx#GreetingCard"],
    owner: "inspect",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "inspect-implementations": {
    canonicalCommand: ["lattice", "inspect", "implementations", "class:src/models.ts#GreetingModel"],
    owner: "inspect",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "inspect-search": {
    canonicalCommand: ["lattice", "inspect", "search", "Greeting", "--limit", "5"],
    owner: "inspect",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "edit-preview": {
    canonicalCommand: [
      "lattice",
      "edit",
      "exact",
      "--path",
      "src/cutover.ts",
      "--expected",
      "export const cutoverValue: number = 1;",
      "--replacement",
      "export const cutoverValue: number = 2;"
    ],
    owner: "edit",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "edit-apply": {
    canonicalCommand: [
      "lattice",
      "edit",
      "exact",
      "--path",
      "src/cutover.ts",
      "--expected",
      "export const cutoverValue: number = 1;",
      "--replacement",
      "export const cutoverValue: number = 2;",
      "--apply"
    ],
    owner: "edit",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "edit-refused": {
    canonicalCommand: [
      "lattice",
      "edit",
      "exact",
      "--path",
      "src/cutover.ts",
      "--expected",
      "export const cutoverValue: number = 2;",
      "--replacement",
      "export const cutoverValue: number = missingCutoverSymbol;",
      "--apply"
    ],
    owner: "edit",
    status: "error",
    exitCode: 1,
    bin: "lattice"
  },
  "check-files": {
    canonicalCommand: ["lattice", "check", "files", "src/cutover.ts", "--checks", "typescript.syntax,typescript.types"],
    owner: "validation",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "validate-request": {
    canonicalCommand: ["lattice", "validate", "request", "--request-file", releaseCutoverRequestFilePlaceholder],
    requestFileBasename: "validate-request.json",
    owner: "validation",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "validate-pre-write-pass": {
    canonicalCommand: [
      "lattice",
      "validate",
      "pre-write",
      "--request-file",
      releaseCutoverRequestFilePlaceholder,
      "--timeout-ms",
      "30000"
    ],
    requestFileBasename: "pre-write-pass.json",
    owner: "validation",
    status: "ok",
    exitCode: 0,
    bin: "lattice"
  },
  "validate-pre-write-fail": {
    canonicalCommand: [
      "lattice",
      "validate",
      "pre-write",
      "--request-file",
      releaseCutoverRequestFilePlaceholder,
      "--timeout-ms",
      "30000"
    ],
    requestFileBasename: "pre-write-fail.json",
    owner: "validation",
    status: "error",
    exitCode: 1,
    bin: "lattice"
  }
} as const satisfies Record<ReleaseCutoverCommandId, ReleaseCutoverCommandExpectation>;

export interface CommandExitSemantics {
  ok: 0;
  error: 1;
  notImplemented: 2;
  unsupported: 64;
  jsonStable: boolean;
}

export interface CommandGroupContract {
  name: string;
  owner: CommandOwner;
  canonicalCommand: readonly string[];
  commands: readonly string[];
  summary: string;
}

export interface CommandRouterManifest {
  schemaVersion: 1;
  packageName: "@the-open-engine/opcore" | (string & {});
  bins: readonly string[];
  exitSemantics: CommandExitSemantics;
  ownershipBoundaries: readonly {
    owner: CommandOwner;
    summary: string;
  }[];
  commandGroups: readonly CommandGroupContract[];
}

export interface OpcoreRepoStatePayload {
  schemaVersion: 1;
  repo: {
    root: string;
    requestedPath: string;
    git: {
      available: boolean;
      branch?: string;
      changed?: number;
      staged?: number;
      unstaged?: number;
      untracked?: number;
      conflicted?: number;
      clean?: boolean;
    };
  };
  coverage: {
    totalFiles: number;
    languages: readonly {
      language: string;
      files: number;
      graphSupported: boolean;
      validationSupported: boolean;
    }[];
    graph: {
      supportedFiles: number;
      extensions: readonly {
        extension: string;
        count: number;
      }[];
    };
    validation: {
      supportedFiles: number;
      retainedFiles: number;
      extensions: readonly {
        extension: string;
        count: number;
      }[];
    };
    unsupported: {
      totalFiles: number;
      stacks: readonly {
        extension: string;
        language: string;
        count: number;
        examples: readonly string[];
      }[];
    };
  };
  graph: {
    state: GraphProviderStatusState;
    mode: GraphProviderMode;
    provider: string;
    action: string;
    message?: string;
    status: GraphProviderStatus;
  };
  validation: {
    ready: boolean;
    checkCount: number;
    adapters: readonly {
      adapter: string;
      status: ValidationAdapterRuntimeState;
      checkCount: number;
      degradedChecks: readonly string[];
      missingTools: readonly string[];
    }[];
    degradedToolchains: readonly {
      adapter: string;
      tool: string;
      failureMessage?: string;
    }[];
  };
  activation: {
    ready: boolean;
    level: "ready" | "degraded" | "blocked";
    summary: string;
    asp: {
      state: "enrolled" | "not_enrolled";
      paths: readonly string[];
    };
  };
  warnings: readonly string[];
  blockers: readonly string[];
  nextActions: readonly string[];
}

export interface OpcoreInitAction {
  kind: "write" | "upsert_block" | "create_hook" | "restore" | "remove";
  path: string;
  summary: string;
  requiresApproval: boolean;
  outsideOpcore: boolean;
}

export interface OpcoreInitScanSummary {
  totalFiles: number;
  graphSupportedFiles: number;
  validationSupportedFiles: number;
  validationRetainedFiles: number;
  unsupportedFiles: number;
  languages: readonly {
    language: string;
    files: number;
    graphSupported: boolean;
    validationSupported: boolean;
  }[];
  unsupportedStacks: readonly {
    extension: string;
    language: string;
    count: number;
    examples: readonly string[];
  }[];
  degradedRustTools: readonly {
    adapter: string;
    tool: string;
    failureMessage?: string;
  }[];
  diagnosticCount: number;
  validationStatus: ValidationResultStatus;
  failedChecks: readonly string[];
  graphState: GraphProviderStatusState;
  activationLevel: "ready" | "degraded" | "blocked";
}

export interface OpcoreInitLanguageSetting {
  language: string;
  files: number;
  state: "supported" | "retained" | "unsupported" | "degraded";
  graph: "supported" | "unsupported";
  validation: "supported" | "retained" | "unsupported" | "degraded";
  checks: readonly string[];
  notes: readonly string[];
}

export interface OpcoreInitSettings {
  languages: readonly OpcoreInitLanguageSetting[];
}

export interface OpcoreInitInteraction {
  tty: boolean;
  promptState: "not_requested" | "requested" | "approved" | "declined";
}

export interface OpcoreInitTiming {
  scanMs: number;
  planMs: number;
  promptMs: number;
  applyMs: number;
  totalMs: number;
  firstOutputMs: number;
}

export interface OpcoreInitPlanPayload {
  schemaVersion: 1;
  mode: "plan" | "apply" | "undo";
  approved: boolean;
  repo: {
    root: string;
    requestedPath: string;
  };
  options: {
    failClosedHook: boolean;
    dryRun: boolean;
  };
  agentFiles: readonly string[];
  actions: readonly OpcoreInitAction[];
  warnings: readonly string[];
  nextActions: readonly string[];
  undoAvailable: boolean;
  scan: OpcoreInitScanSummary;
  settings: OpcoreInitSettings;
  interaction: OpcoreInitInteraction;
  timings: OpcoreInitTiming;
}

export interface OpcoreMetricEvidence {
  source: string;
  path: string;
  message: string;
  checkId?: string;
  code?: string;
  line?: number;
  column?: number;
}

export interface OpcoreMetricSignal {
  id: string;
  title: string;
  category: "coverage" | "typescript" | "rust" | "graph" | (string & {});
  severity: "info" | "warning" | "error";
  count: number;
  evidence: readonly OpcoreMetricEvidence[];
}

export interface OpcoreMetricDegradation {
  id: string;
  title: string;
  source: string;
  severity: "info" | "warning" | "error";
  message: string;
  checkId?: string;
  requiredTool?: string;
}

export interface OpcoreMetricReport {
  schemaVersion: 1;
  kind: "opcore_metric_report";
  generatedAt: string;
  repo: {
    root: string;
    requestedPath: string;
    git: OpcoreRepoStatePayload["repo"]["git"];
  };
  coverage: OpcoreRepoStatePayload["coverage"];
  graph: {
    state: GraphProviderStatusState;
    mode: GraphProviderMode;
    provider: string;
  };
  validation: {
    status?: ValidationResultStatus;
    diagnosticCount: number;
    checkCount: number;
  };
  signals: readonly OpcoreMetricSignal[];
  degradations: readonly OpcoreMetricDegradation[];
  warnings: readonly string[];
  nextActions: readonly string[];
}

export interface OpcoreMetricHistoryEntry {
  schemaVersion: 1;
  kind: "opcore_metric_history_entry";
  recordedAt: string;
  report: OpcoreMetricReport;
}

export interface OpcoreMeasureSignalCount {
  id: string;
  title: string;
  count: number;
}

export interface OpcoreMeasureSignalDelta {
  id: string;
  title: string;
  currentCount: number;
  comparisonCount: number;
  delta: number;
}

export interface OpcoreMeasureComparison {
  recordedAt: string;
  generatedAt: string;
  coverage: OpcoreMetricReport["coverage"];
  signals: readonly OpcoreMeasureSignalCount[];
  deltas: readonly OpcoreMeasureSignalDelta[];
}

export interface OpcoreMeasureDelta {
  schemaVersion: 1;
  kind: "opcore_measure_delta";
  generatedAt: string;
  current: {
    generatedAt: string;
    coverage: OpcoreMetricReport["coverage"];
    signals: readonly OpcoreMeasureSignalCount[];
  };
  baseline?: OpcoreMeasureComparison;
  previous?: OpcoreMeasureComparison;
  warnings: readonly string[];
  degradations: readonly OpcoreMetricDegradation[];
  nextActions: readonly string[];
}

export interface OpcoreTrySignalSummary {
  id: string;
  title: string;
  count: number;
  delta: number;
}

export interface OpcoreTryScenario {
  id: string;
  repoRoot: string;
  title: string;
  commands: readonly string[];
  coverage: {
    totalFiles: number;
    validationSupportedFiles: number;
    unsupportedFiles: number;
  };
  signals: readonly OpcoreTrySignalSummary[];
}

export interface OpcoreTryCommandSummary {
  scenarioId: string;
  command: readonly string[];
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  exitCode: number;
}

export interface OpcoreTryPayload {
  schemaVersion: 1;
  sampleRoot: string;
  published: false;
  scenarios: readonly OpcoreTryScenario[];
  commands: readonly OpcoreTryCommandSummary[];
}

export type CommandTimingPhase = Pick<GraphPipelinePhaseTiming, "phase" | "durationMs" | "fileCount">;

export interface CommandTiming {
  durationMs: number;
  phases: readonly CommandTimingPhase[];
  processState: CommandTimingProcessState;
  degradations?: readonly CommandTimingDegradationReason[];
}

export interface RepoShapeFingerprint {
  totalFiles: number;
  languages: readonly {
    language: string;
    files: number;
  }[];
  graph: {
    supportedFiles: number;
    unsupportedFiles: number;
  };
  git: {
    available: boolean;
    clean?: boolean;
  };
}

export interface CommandLatencyRecord {
  schemaVersion: 1;
  recordedAt: string;
  bin: string;
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  exitCode: number;
  repo: RepoShapeFingerprint;
  timing: CommandTiming;
  opcoreVersion: string;
}

export interface LatencyPhaseBudget {
  phase: string;
  budgetMs: number;
}

export interface LatencyBudget {
  schemaVersion: 1;
  canonicalCommand: readonly string[];
  scope: string;
  repoShapeBucket: string;
  budgetMs: number;
  phaseBudgets?: readonly LatencyPhaseBudget[];
}

export interface LatencyBudgetResult {
  schemaVersion: 1;
  status: LatencyBudgetResultStatus;
  budget: LatencyBudget;
  observed: {
    canonicalCommand: readonly string[];
    phase: string;
    durationMs: number;
  };
  evidence: {
    canonicalCommand: readonly string[];
    phase: string;
    repoShapeBucket: string;
    observedMs: number;
    budgetMs: number;
    overByMs: number;
  };
}

export interface CommandRouterResult {
  schemaVersion: 1;
  bin: string;
  argv: readonly string[];
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  exitCode: number;
  message: string;
  json: boolean;
  providerStatus?: GraphProviderStatus;
  graphPipeline?: GraphPipelineResult;
  graphQuery?: GraphFactQueryResult | GraphNamedQueryResult;
  graphSearch?: GraphSearchResult;
  inspectResult?: InspectRouteResult;
  graphImpact?: GraphImpactResult;
  graphReviewContext?: GraphReviewContextResult;
  graphChanges?: GraphDetectChangesResult;
  graphServe?: GraphServeTransportStatus;
  validationResult?: ValidationResult;
  validationStatus?: ValidationStatusPayload;
  receipt?: PreWriteValidationReceipt;
  editPlan?: EditPlan;
  editResult?: EditCommandResult;
  repoState?: OpcoreRepoStatePayload;
  opcoreInit?: OpcoreInitPlanPayload;
  opcoreMeasure?: OpcoreMeasureDelta;
  opcoreTry?: OpcoreTryPayload;
  timing?: CommandTiming;
}

export interface ParsedCommandArgv {
  args: readonly string[];
  json: boolean;
}

export interface CommandRouterResultInput {
  bin: string;
  argv: readonly string[];
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  json: boolean;
  message: string;
  providerStatus?: GraphProviderStatus;
  graphPipeline?: GraphPipelineResult;
  graphQuery?: GraphFactQueryResult | GraphNamedQueryResult;
  graphSearch?: GraphSearchResult;
  inspectResult?: InspectRouteResult;
  graphImpact?: GraphImpactResult;
  graphReviewContext?: GraphReviewContextResult;
  graphChanges?: GraphDetectChangesResult;
  graphServe?: GraphServeTransportStatus;
  validationResult?: ValidationResult;
  validationStatus?: ValidationStatusPayload;
  receipt?: PreWriteValidationReceipt;
  editPlan?: EditPlan;
  editResult?: EditCommandResult;
  repoState?: OpcoreRepoStatePayload;
  opcoreInit?: OpcoreInitPlanPayload;
  opcoreMeasure?: OpcoreMeasureDelta;
  opcoreTry?: OpcoreTryPayload;
  timing?: CommandTiming;
}

export interface CommandAdapterRequest {
  schemaVersion: 1;
  bin: string;
  argv: readonly string[];
  args: readonly string[];
  json: boolean;
  group: CommandGroupContract;
  canonicalCommand: readonly string[];
}

export type CommandAdapter = (request: CommandAdapterRequest) => CommandRouterResult | Promise<CommandRouterResult>;

export type CommandRouterWriter = (text: string) => void;

export interface RouteCommandAdapterOptions {
  bin: string;
  argv: readonly string[];
  groupName: string;
  adapter: CommandAdapter;
  args?: readonly string[];
  json?: boolean;
  showHelpOnEmpty?: boolean;
  validateFirstRouteArg?: boolean;
}

export interface RunCommandAdapterCliOptions extends Omit<RouteCommandAdapterOptions, "argv"> {
  argv?: readonly string[];
  stdout?: CommandRouterWriter;
  stderr?: CommandRouterWriter;
}

export const commandExitSemantics: CommandExitSemantics = {
  ok: 0,
  error: 1,
  notImplemented: 2,
  unsupported: 64,
  jsonStable: true
};

export const commandRouterManifest: CommandRouterManifest = {
  schemaVersion: 1,
  packageName: "@the-open-engine/opcore",
  bins: ["lattice"],
  exitSemantics: commandExitSemantics,
  ownershipBoundaries: [
    {
      owner: "graph",
      summary: "Graph provider owns extraction, persistent facts, freshness, query, search, and impact contracts."
    },
    {
      owner: "inspect",
      summary: "Inspect owns read-only code intelligence over graph facts and language-service surfaces."
    },
    {
      owner: "edit",
      summary: "Edit planner owns symbol-aware rename, move, signature, patch, and tree edit orchestration."
    },
    {
      owner: "validation",
      summary: "Validation owns checks, hypothetical validation, manifests, failure policy, and check status."
    },
    {
      owner: "runtime",
      summary: "Runtime owns shared router health, help, and doctor surfaces."
    }
  ],
  commandGroups: [
    {
      name: "graph",
      owner: "graph",
      canonicalCommand: ["lattice", "graph"],
      commands: [
        "build",
        "update",
        "watch",
        "status",
        "query",
        "serve",
        "impact",
        "review-context",
        "detect-changes",
        "search"
      ],
      summary:
        "GraphProvider build, update, watch, status, query, impact, review context, change detection, daemon lifecycle, and freshness behavior."
    },
    {
      name: "inspect",
      owner: "inspect",
      canonicalCommand: ["lattice", "inspect"],
      commands: ["symbols", "definition", "references", "signature", "implementations", "search"],
      summary: "Read-only code intelligence over graph and inspect-owned language services."
    },
    {
      name: "edit",
      owner: "edit",
      canonicalCommand: ["lattice", "edit"],
      commands: ["exact", "multi", "search-replace", "check", "apply", "patch", "tree", "rename", "move", "signature"],
      summary: "Exact edit, multi-edit, search-replace, patch/tree, graph-backed symbol rename/move/signature, preview/check, and apply routes."
    },
    {
      name: "check",
      owner: "validation",
      canonicalCommand: ["lattice", "check"],
      commands: ["files", "staged", "changed", "tree", "all", "manifest"],
      summary: "Mechanical check execution and check manifest behavior."
    },
    {
      name: "validate",
      owner: "validation",
      canonicalCommand: ["lattice", "validate"],
      commands: ["request", "hypothetical", "pre-write", "manifest"],
      summary: "Hypothetical, pre-write, and validation request behavior."
    },
    {
      name: "status",
      owner: "runtime",
      canonicalCommand: ["lattice", "status"],
      commands: ["status"],
      summary: "Shared router and runtime health status."
    },
    {
      name: "doctor",
      owner: "runtime",
      canonicalCommand: ["lattice", "doctor"],
      commands: ["doctor"],
      summary: "Shared runtime diagnostic summary."
    }
  ]
};

export interface GraphReferenceEvidenceSurfaceBase {
  id: string;
  classification: GraphReferenceEvidenceClassification;
  fixtures: readonly string[];
}

export interface GraphReferenceEvidenceExitSemantics {
  success: 0;
  failure: string;
}

export interface GraphReferenceEvidenceCommandSurface extends GraphReferenceEvidenceSurfaceBase {
  referenceTool: string;
  referenceCommand: readonly string[];
  canonicalCommand: readonly string[];
  flags: readonly string[];
  positionals: readonly string[];
  exitSemantics: GraphReferenceEvidenceExitSemantics;
}

export interface GraphReferenceEvidenceJsonOutputSurface extends GraphReferenceEvidenceSurfaceBase {
  command: string;
  requiredFields: readonly string[];
  exitSemantics: GraphReferenceEvidenceExitSemantics;
}

export interface GraphReferenceEvidenceSqliteFixture extends GraphReferenceEvidenceSurfaceBase {
  fixture: string;
  tables: readonly string[];
  indexes: readonly string[];
  metadataKeys: readonly string[];
  nodeKinds: readonly string[];
  edgeKinds: readonly string[];
  directReaderQueries: readonly string[];
}

export interface GraphReferenceEvidenceDaemonFixture extends GraphReferenceEvidenceSurfaceBase {
  fixture: string;
  protocol: "lattice.graph.daemon" | "reference-mcp-stdio-baseline-only" | (string & {});
  envelopes: readonly string[];
}

export interface GraphReferenceEvidenceBaselineReceipt extends GraphReferenceEvidenceSurfaceBase {
  metric: string;
  receipt: string;
  label: "reference_evidence_non_implementation_input";
  sourceAvailability: "available" | "unavailable";
  nonImplementationInput: true;
}

export interface GraphReferenceEvidenceOptionalAnalysisSurface extends GraphReferenceEvidenceSurfaceBase {
  issue: GraphReleaseDeferredChild;
  id: GraphReleaseOptionalAnalysisSurface["id"] | (string & {});
  status: "deferred";
}

export interface GraphReferenceEvidenceGoldenCorpusRef extends GraphReferenceEvidenceSurfaceBase {
  fixture: string;
  covers: readonly string[];
}

export interface GraphReferenceEvidenceProvenance {
  containsPythonCrgSource: false;
  containsPackageMetadata: false;
  containsGitHistory: false;
  referenceReceiptsAreImplementationInput: false;
  implementationPackageNames: readonly string[];
  allowedMentionPaths: readonly string[];
}

export interface GraphReferenceEvidenceManifest {
  schemaVersion: 1;
  issue: "#19";
  origin: "covibes-authored-synthetic";
  fixtureRefs: readonly string[];
  commandSurfaces: readonly GraphReferenceEvidenceCommandSurface[];
  jsonOutputSurfaces: readonly GraphReferenceEvidenceJsonOutputSurface[];
  sqliteFixtures: readonly GraphReferenceEvidenceSqliteFixture[];
  daemonFixtures: readonly GraphReferenceEvidenceDaemonFixture[];
  baselineReceipts: readonly GraphReferenceEvidenceBaselineReceipt[];
  optionalAnalysisSurfaces: readonly GraphReferenceEvidenceOptionalAnalysisSurface[];
  goldenCorpus: GraphReferenceEvidenceGoldenCorpusRef;
  provenance: GraphReferenceEvidenceProvenance;
}

export interface GraphReleaseCommandCoverage {
  id: GraphReleaseCoreCommandId;
  bin: "lattice";
  command: readonly string[];
  canonicalCommand: readonly string[];
  status: "passed";
  exitCode: 0;
  fixture: string;
  durationMs: number;
}

export interface GraphReleaseDirectSqliteQueryReceipt {
  id: GraphReleaseDirectSqliteQueryId;
  query: string;
  status: "passed";
  rowCount: number;
  fixture: string;
}

export interface GraphReleaseServeTransportReceipt {
  id: GraphReleaseServeTransportId;
  protocol: "lattice.graph.daemon" | "jsonrpc-2.0" | (string & {});
  operation: "ping" | "status" | "query" | "search" | "shutdown" | (string & {});
  status: "passed";
  exitCode: 0;
}

export interface GraphReleaseBenchmarkReceipt {
  metric: GraphReleaseBenchmarkMetric;
  value: number;
  unit: "ms" | "bytes";
  baselineIssue: "#19";
  baselineReceipt: string;
  comparison: "recorded" | "within_baseline" | "above_baseline" | "below_baseline";
}

export interface GraphReleasePackageInspection {
  packageName: "@the-open-engine/opcore-graph";
  tarballName: string;
  fileCount: number;
  files: readonly string[];
  forbiddenMarkersAbsent: true;
  generatedBuildMetadataAbsent: true;
  privatePathsAbsent: true;
  pythonCrgSourceAbsent: true;
  pythonGraphPackageMetadataAbsent: true;
  pythonCrgGitHistoryAbsent: true;
  forbiddenImplementationPackageNamesAbsent: true;
  inspections: readonly string[];
}

export interface GraphReleaseNativeArtifactEvidence {
  packageName: GraphCoreNativePackageName;
  targetPlatform: GraphCoreNativeSupportedTarget;
  metadata: GraphProviderArtifactMetadata;
  binaryPath: "lattice-graph-core";
  checksumPath: "lattice-graph-core.sha256";
  metadataPath: "metadata.json";
  binarySha256: string;
  checksumFileSha256: string;
  metadataSha256: string;
  packageFiles: readonly string[];
}

export interface GraphReleaseReportReceipt {
  id: GraphReleaseReportReceiptId;
  command: readonly string[];
  status: "passed";
  exitCode: 0;
  path: string;
  checksumSha256?: string;
}

export interface GraphReleaseOptionalSurfaceReceipt {
  issue: GraphReleaseDeferredChild;
  id: GraphReleaseOptionalAnalysisSurface["id"] | (string & {});
  classification: GraphReferenceEvidenceClassification;
  status: "unsupported" | "deferred";
}

export interface GraphReleaseHandoffReceipt {
  issue: GraphReleaseHandoffIssue;
  receiptPath: string;
  checksumSha256: string;
  rollbackNote: string;
}

export interface GraphReleasePackageVersion {
  packageName: string;
  version: string;
}

export interface GraphReleaseReceipt {
  schemaVersion: 1;
  issue: "#17";
  origin: "covibes-authored-synthetic";
  generatedAt: string;
  commitSha: string;
  graphPackageVersions: readonly GraphReleasePackageVersion[];
  graphProviderSchemaVersion: 1;
  requiredChildren: readonly string[];
  deferredChildren: readonly string[];
  commandCoverage: readonly GraphReleaseCommandCoverage[];
  directSqliteQueries: readonly GraphReleaseDirectSqliteQueryReceipt[];
  serveTransport: readonly GraphReleaseServeTransportReceipt[];
  benchmarks: readonly GraphReleaseBenchmarkReceipt[];
  packageInspection: GraphReleasePackageInspection;
  supportedNativeTargets: readonly GraphCoreNativeSupportedTarget[];
  nativeArtifacts: readonly GraphReleaseNativeArtifactEvidence[];
  reportReceipts: readonly GraphReleaseReportReceipt[];
  graphArtifact: GraphProviderArtifactMetadata;
  optionalSurfaces: readonly GraphReleaseOptionalSurfaceReceipt[];
  handoff: readonly GraphReleaseHandoffReceipt[];
}

export interface ReleaseReceiptTarballEvidence {
  filename: string;
  path: string;
  sha256: string;
  integrity?: string;
  shasum?: string;
}

export interface ReleaseReceiptPackageManifestMetadata {
  name: ReleaseReceiptPackageName;
  version: string;
  license: string;
  main?: string;
  types?: string;
  files: readonly string[];
  bins: Readonly<Record<string, string>>;
  dependencies: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  bundledDependencies: readonly string[];
  os?: readonly string[];
  cpu?: readonly string[];
}

export interface ReleaseReceiptNativeArtifactEvidence {
  packageName: GraphCoreNativePackageName;
  targetPlatform: GraphCoreNativeSupportedTarget;
  metadata: GraphProviderArtifactMetadata;
  binaryPath: string;
  checksumPath: string;
  metadataPath: string;
  binarySha256: string;
  checksumFileSha256: string;
  metadataSha256: string;
  descriptorArtifactId: string;
  descriptorChecksumId: string;
}

export interface ReleaseReceiptPackageEvidence {
  packageName: ReleaseReceiptPackageName;
  packageRoot: string;
  version: string;
  manifest: ReleaseReceiptPackageManifestMetadata;
  tarball: ReleaseReceiptTarballEvidence;
  files: readonly string[];
  fileCount: number;
  expectedFiles: readonly string[];
  expectedFileCount: number;
  bins: Readonly<Record<string, string>>;
  descriptorReferences: readonly ManagedToolDescriptorArtifactReference[];
  nativeArtifacts: readonly ReleaseReceiptNativeArtifactEvidence[];
}

export interface ReleaseReceiptDescriptorCommandGroupEvidence {
  name: ReleaseReceiptCommandGroupName;
  canonicalCommand: readonly string[];
  packageName: string;
}

export interface ReleaseReceiptResolvedArtifactEvidence {
  id: string;
  packageName: ReleaseReceiptPackageName;
  path: string;
  type: ManagedToolDescriptorArtifactType;
  required: boolean;
  packageFile: true;
  checksumRef?: string;
}

export interface ReleaseReceiptResolvedChecksumEvidence {
  id: string;
  packageName: ReleaseReceiptPackageName;
  path: string;
  algorithm: "sha256";
  artifactRef: string;
  required: boolean;
  packageFile: true;
  value: string;
}

export interface ReleaseReceiptDescriptorEvidence {
  path: string;
  packageName: "@the-open-engine/opcore";
  checksumSha256: string;
  descriptor: ManagedToolDescriptor;
  commandGroups: readonly ReleaseReceiptDescriptorCommandGroupEvidence[];
  resolvedArtifacts: readonly ReleaseReceiptResolvedArtifactEvidence[];
  resolvedChecksums: readonly ReleaseReceiptResolvedChecksumEvidence[];
}

export interface ReleaseReceiptLicensePackageEvidence {
  name: string;
  version: string;
  license: string;
  source: string;
  bundled: boolean;
}

export interface ReleaseReceiptLicenseEvidence {
  reportPath: string;
  reportSha256: string;
  productionDependencyCount: number;
  bundledDependencyCount: number;
  workspacePackageCount: number;
  unresolvedLicenseCount: 0;
  packages: readonly ReleaseReceiptLicensePackageEvidence[];
}

export interface ReleaseReceiptProvenanceFinding {
  scope: "current-tree" | "git-history";
  marker: string;
  path?: string;
  commit?: string;
  line?: number;
}

export interface ReleaseReceiptProvenanceEvidence {
  reportPath: string;
  reportSha256: string;
  scannedFileCount: number;
  historyCommitCount: number;
  findingCount: 0;
  findings: readonly ReleaseReceiptProvenanceFinding[];
}

export interface ReleaseReceiptSecretFinding {
  scope: ReleaseReceiptSecretFindingScope;
  kind: string;
  path?: string;
  commit?: string;
  line?: number;
  fingerprint: string;
  allowlisted: boolean;
}

export interface ReleaseReceiptSecretHistoryEvidence {
  allowlistPath: string;
  allowlistSha256: string;
  currentTreeScannedFileCount: number;
  gitHistoryScannedCommitCount: number;
  findingCount: 0;
  findings: readonly ReleaseReceiptSecretFinding[];
}

export interface ReleaseReceiptReport {
  id: ReleaseReceiptReportId;
  command: readonly string[];
  status: "passed";
  exitCode: 0;
  path?: string;
  checksumSha256?: string;
  summary: string;
}

export interface ReleaseReceiptGraphReleaseEvidence {
  path: string;
  issue: "#17";
  checksumSha256: string;
}

export interface ReleaseReceipt {
  schemaVersion: 1;
  issue: "#29";
  origin: "covibes-authored-release-proof";
  generatedAt: string;
  commitSha: string;
  privateRepo: true;
  packageNames: readonly ReleaseReceiptPackageName[];
  commandGroups: readonly ReleaseReceiptCommandGroupName[];
  packages: readonly ReleaseReceiptPackageEvidence[];
  descriptor: ReleaseReceiptDescriptorEvidence;
  nativeArtifacts: readonly ReleaseReceiptNativeArtifactEvidence[];
  license: ReleaseReceiptLicenseEvidence;
  provenance: ReleaseReceiptProvenanceEvidence;
  secretHistory: ReleaseReceiptSecretHistoryEvidence;
  reports: readonly ReleaseReceiptReport[];
  graphReleaseReceipt: ReleaseReceiptGraphReleaseEvidence;
}

export interface ReleaseCutoverTarballEvidence {
  filename: string;
  sha256: string;
}

export interface ReleaseCutoverInstalledManifestEvidence {
  path: string;
  sha256: string;
  bins: Readonly<Record<string, string>>;
}

export interface ReleaseCutoverInstalledFileEvidence {
  path: string;
  sha256: string;
}

export interface ReleaseCutoverInstalledPackageEvidence {
  packageName: ReleaseReceiptPackageName;
  version: string;
  tarball: ReleaseCutoverTarballEvidence;
  installedManifest: ReleaseCutoverInstalledManifestEvidence;
  installedFiles: readonly ReleaseCutoverInstalledFileEvidence[];
}

export interface ReleaseCutoverDescriptorEvidence {
  path: string;
  packageName: "@the-open-engine/opcore";
  checksumSha256: string;
  descriptor: ManagedToolDescriptor;
  resolvedArtifacts: readonly ReleaseReceiptResolvedArtifactEvidence[];
  resolvedChecksums: readonly ReleaseReceiptResolvedChecksumEvidence[];
}

export interface ReleaseCutoverEnvironmentIsolationEvidence {
  currentToolEnvCleared: true;
  clearedEnvVarCount: number;
  pathSanitized: true;
  aceRuntimeBinExcluded: true;
  siblingCovibesExcluded: true;
  latticeBinOnly: true;
  oldBinsAbsent: {
    crg: true;
    cix: true;
    rox: true;
  };
}

export interface ReleaseCutoverCommandReceipt {
  id: ReleaseCutoverCommandId;
  command: readonly string[];
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  exitCode: number;
  binPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  assertion: string;
}

export interface ReleaseCutoverNegativeCheck {
  id: string;
  command: readonly string[];
  status: "passed";
  exitCode: 0;
  assertion: string;
}

export interface ReleaseCutoverForbiddenMarkerScan {
  scannedTextCount: number;
  findingCount: 0;
  markersBlocked: readonly string[];
}

export interface ReleaseCutoverInputEvidence {
  issue: ReleaseCutoverInputIssue;
  path: string;
  checksumSha256: string;
}

export interface ReleaseCutoverReceipt {
  schemaVersion: 1;
  issue: "#30";
  origin: "covibes-authored-cutover-proof";
  generatedAt: string;
  commitSha: string;
  privateRepo: true;
  packageNames: readonly ReleaseReceiptPackageName[];
  installedPackages: readonly ReleaseCutoverInstalledPackageEvidence[];
  descriptor: ReleaseCutoverDescriptorEvidence;
  environmentIsolation: ReleaseCutoverEnvironmentIsolationEvidence;
  commandReceipts: readonly ReleaseCutoverCommandReceipt[];
  negativeChecks: readonly ReleaseCutoverNegativeCheck[];
  forbiddenMarkerScan: ReleaseCutoverForbiddenMarkerScan;
  inputEvidence: readonly ReleaseCutoverInputEvidence[];
}

export interface AspDogfoodManagerEvidence {
  bootstrapSource: "local-sibling";
  aspRepoPath: string;
  aspBinPath: string;
  cliPath: string;
  commitSha: string;
}

export interface AspDogfoodAspHomeEvidence {
  path: string;
  temp: true;
  isolated: true;
  sharedStateMutated: false;
  pathSanitized: true;
  aceRuntimeBinExcluded: true;
}

export interface AspDogfoodHostFixtureEvidence {
  repo: string;
  temp: true;
  sourceRepoMutated: false;
  baselineCommitted: true;
  changedPaths: readonly string[];
}

export interface AspDogfoodCommandRunReceipt {
  id: string;
  command: readonly string[];
  status: "passed" | "failed" | "retained-not-run";
  exitCode: number | null;
  stdoutSha256: string;
  stderrSha256: string;
  output?: unknown;
  assertion: string;
}

export interface AspDogfoodProviderManifestEvidence {
  manifestPath: string;
  manifestSha256: string;
  manifest: unknown;
}

export interface AspDogfoodProviderEvidence {
  providerId: "opcore";
  packageName: "@the-open-engine/opcore-asp-provider";
  binPath: string;
  indexPath: string;
  indexSha256: string;
  command: readonly ["opcore-asp-provider", "--stdio"];
  entrypoint: {
    transport: "stdio";
    bin: string;
    args: readonly ["--stdio"];
  };
  manifest: AspDogfoodProviderManifestEvidence;
}

export interface AspDogfoodRepoEnrollmentEvidence {
  repo: string;
  mode: "advisory" | "shadow";
  repoAdd: AspDogfoodCommandRunReceipt;
  repoEnable: AspDogfoodCommandRunReceipt;
  repoStatus: AspDogfoodCommandRunReceipt;
}

export interface AspDogfoodManagerStateEvidence {
  status: AspDogfoodCommandRunReceipt;
  serverAdd: AspDogfoodCommandRunReceipt;
  serverStatus: AspDogfoodCommandRunReceipt;
}

export interface AspDogfoodHostCheckEvidence extends AspDogfoodCommandRunReceipt {
  hostDecision: unknown;
  receipt: unknown;
  assurance: {
    mode: string;
    transactionGuarantee: string;
  };
}

export interface AspDogfoodHostEvaluationEvidence {
  check: AspDogfoodHostCheckEvidence;
  ciVerify?: AspDogfoodCommandRunReceipt;
}

export interface AspDogfoodProviderProbeEvidence extends AspDogfoodCommandRunReceipt {
  assessment: unknown;
  validAsOf: unknown;
  coverage: unknown;
  diagnosticsCount: number;
  hostOwnedFieldLeak: false;
}

export interface AspDogfoodGuardrailReceipt extends AspDogfoodCommandRunReceipt {
  id: AspDogfoodGuardrailId;
  retained: true;
}

export interface AspDogfoodUnsupportedSurfaceEvidence {
  surface: AspDogfoodUnsupportedSurfaceId;
  status: "degraded" | "retained-old-tool-gate" | "parity-blocker";
  cleanCoverage: false;
  blocker: string;
}

export interface AspDogfoodParityBlocker {
  source: string;
  detail: string;
}

export interface AspDogfoodAuthorityEvidence {
  hostOwnsDecisions: true;
  providerOutputIsHostDecision: false;
  localAuthorityOverride: {
    present: false;
    sharedAuthorityWeakened: false;
  };
}

export interface AspDogfoodForbiddenMarkerScan {
  scannedTextCount: number;
  findingCount: 0;
  markersBlocked: readonly AspDogfoodForbiddenProviderMarker[];
}

export interface AspDogfoodReceipt {
  schemaVersion: 1;
  issue: "#120";
  origin: "covibes-authored-asp-dogfood-proof";
  generatedAt: string;
  commitSha: string;
  privateRepo: true;
  bootstrapSource: "local-sibling";
  packageNames: readonly ReleaseReceiptPackageName[];
  installedPackages: readonly ReleaseCutoverInstalledPackageEvidence[];
  manager: AspDogfoodManagerEvidence;
  aspHome: AspDogfoodAspHomeEvidence;
  hostFixture: AspDogfoodHostFixtureEvidence;
  provider: AspDogfoodProviderEvidence;
  managerState: AspDogfoodManagerStateEvidence;
  repoEnrollment: AspDogfoodRepoEnrollmentEvidence;
  hostEvaluation: AspDogfoodHostEvaluationEvidence;
  providerProbe: AspDogfoodProviderProbeEvidence;
  currentToolGuardrails: readonly AspDogfoodGuardrailReceipt[];
  unsupportedSurfaces: readonly AspDogfoodUnsupportedSurfaceEvidence[];
  parityBlockers: readonly AspDogfoodParityBlocker[];
  authority: AspDogfoodAuthorityEvidence;
  publicReleaseActions: readonly [];
  oldToolReplacementClaimed: false;
  forbiddenMarkerScan: AspDogfoodForbiddenMarkerScan;
}

declare const process: {
  argv: string[];
  stdout: {
    write(text: string): void;
  };
  stderr: {
    write(text: string): void;
  };
};

const commandHelpArgs = new Set(["--help", "-h", "help"]);

export function parseCommandArgv(argv: readonly string[]): ParsedCommandArgv {
  return {
    args: argv.filter((arg) => arg !== "--json"),
    json: argv.includes("--json")
  };
}

export function normalizeCommandBin(bin: string): string {
  const normalized = bin.replaceAll("\\", "/").split("/").at(-1) ?? bin;
  return normalized.endsWith(".js") ? "lattice" : normalized;
}

export function commandExitCodeForStatus(status: CommandRouteStatus): number {
  if (status === "ok") return commandRouterManifest.exitSemantics.ok;
  if (status === "error") return commandRouterManifest.exitSemantics.error;
  if (status === "not_implemented") return commandRouterManifest.exitSemantics.notImplemented;
  return commandRouterManifest.exitSemantics.unsupported;
}

export function createCommandRouterResult(input: CommandRouterResultInput): CommandRouterResult {
  return validateCommandRouterResult(withoutUndefinedProperties({
    schemaVersion: 1,
    bin: input.bin,
    argv: input.argv,
    canonicalCommand: input.canonicalCommand,
    owner: input.owner,
    status: input.status,
    exitCode: commandExitCodeForStatus(input.status),
    message: input.message,
    json: input.json,
    providerStatus: input.providerStatus,
    graphPipeline: input.graphPipeline,
    graphQuery: input.graphQuery,
    graphSearch: input.graphSearch,
    inspectResult: input.inspectResult,
    graphImpact: input.graphImpact,
    graphReviewContext: input.graphReviewContext,
    graphChanges: input.graphChanges,
    graphServe: input.graphServe,
    validationResult: input.validationResult,
    validationStatus: input.validationStatus,
    receipt: input.receipt,
    editPlan: input.editPlan,
    editResult: input.editResult,
    repoState: input.repoState,
    opcoreInit: input.opcoreInit,
    opcoreMeasure: input.opcoreMeasure,
    opcoreTry: input.opcoreTry,
    timing: input.timing
  }) as CommandRouterResult);
}

export function commandGroupByName(groupName: string): CommandGroupContract | undefined {
  return commandRouterManifest.commandGroups.find((group) => group.name === groupName);
}

export async function routeCommandAdapter(options: RouteCommandAdapterOptions): Promise<CommandRouterResult> {
  const parsedArgv = parseCommandArgv(options.argv);
  const parsed = {
    args: options.args ?? parsedArgv.args,
    json: options.json ?? parsedArgv.json
  };
  const bin = normalizeCommandBin(options.bin);
  const group = commandGroupByName(options.groupName);
  if (!group) {
    return createCommandRouterResult({
      bin,
      argv: options.argv,
      canonicalCommand: ["lattice", options.groupName],
      owner: "runtime",
      status: "unsupported",
      json: parsed.json,
      message: `Unsupported lattice command group: ${options.groupName}`
    });
  }

  const showHelpOnEmpty = options.showHelpOnEmpty ?? group.name !== "check";
  if (parsed.args.some((arg) => commandHelpArgs.has(arg)) || (parsed.args.length === 0 && showHelpOnEmpty)) {
    return commandHelpResult(bin, options.argv, parsed.json, group.name);
  }

  const canonicalCommand = [...group.canonicalCommand, ...parsed.args];
  const firstRouteArg = parsed.args.find((arg) => !arg.startsWith("-"));
  const validateFirstRouteArg = options.validateFirstRouteArg ?? true;
  if (validateFirstRouteArg && firstRouteArg && !group.commands.includes(firstRouteArg)) {
    return createCommandRouterResult({
      bin,
      argv: options.argv,
      canonicalCommand,
      owner: group.owner,
      status: "unsupported",
      json: parsed.json,
      message: `${canonicalCommand.join(" ")} is not a supported ${group.name} route.`
    });
  }

  const adapterRequest = validateCommandAdapterRequest({
    schemaVersion: 1,
    bin,
    argv: options.argv,
    args: parsed.args,
    json: parsed.json,
    group,
    canonicalCommand
  });
  try {
    return validateCommandRouterResult(await options.adapter(adapterRequest));
  } catch (error) {
    return createCommandRouterResult({
      bin,
      argv: options.argv,
      canonicalCommand,
      owner: group.owner,
      status: "error",
      json: parsed.json,
      message: `${canonicalCommand.join(" ")} failed: ${errorMessage(error)}`
    });
  }
}

export async function runCommandAdapterCli(options: RunCommandAdapterCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const argv = options.argv ?? process.argv.slice(2);
  const routed = await routeCommandAdapter({
    ...options,
    argv
  });
  const text = routed.json ? JSON.stringify(routed) : routed.message;
  const write = routed.json || routed.status === "ok" ? stdout : stderr;
  write(`${text}\n`);
  return routed.exitCode;
}

function commandHelpResult(
  bin: string,
  argv: readonly string[],
  json: boolean,
  groupName?: string
): CommandRouterResult {
  const group = groupName ? commandGroupByName(groupName) : undefined;
  const canonicalCommand = group ? [...group.canonicalCommand, "help"] : ["lattice", "help"];
  return createCommandRouterResult({
    bin,
    argv,
    canonicalCommand,
    owner: group?.owner ?? "runtime",
    status: "ok",
    json,
    message: commandHelpMessage(groupName)
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandHelpMessage(groupName?: string): string {
  if (!groupName) {
    return [
      "Lattice - local code intelligence and edit safety for coding agents.",
      "Groups: graph, inspect, edit, check, validate, status, doctor"
    ].join("\n");
  }
  const group = commandGroupByName(groupName);
  if (!group) return `Unknown lattice command group: ${groupName}`;
  return [
    `${group.canonicalCommand.join(" ")} - ${group.summary}`,
    `Commands: ${group.commands.join(", ")}`,
    `Example: ${contractHelpExample(groupName)}`
  ].join("\n");
}

function contractHelpExample(groupName: string): string {
  if (groupName === "graph") return 'lattice graph search "GreetingCard" --repo . --limit 5';
  if (groupName === "inspect") return "lattice inspect definition GreetingCard --repo .";
  if (groupName === "edit") return 'lattice edit exact --path src/a.ts --expected "old" --replacement "new" --json';
  if (groupName === "check") return "lattice check files --files src/index.ts --json";
  if (groupName === "validate") return "lattice validate pre-write --request-file ./validation-request.json --timeout-ms 30000 --json";
  if (groupName === "status") return "lattice status";
  if (groupName === "doctor") return "lattice doctor --json";
  return `lattice ${groupName} --help`;
}

export function validateCommandRouterManifest(manifest: CommandRouterManifest): CommandRouterManifest {
  validateCommandRouterManifestHeader(manifest);
  validateManifestBins(manifest.bins);
  validateCommandExitSemantics(manifest.exitSemantics);

  validateManifestGroups(manifest.commandGroups);
  validateManifestOwnershipBoundaries(manifest.ownershipBoundaries);

  return manifest;
}

export function validateManagedToolDescriptor(descriptor: ManagedToolDescriptor): ManagedToolDescriptor {
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error("Managed tool descriptor is required");
  }
  if (descriptor.schemaVersion !== 1) throw new Error("Managed tool descriptor schemaVersion must be 1");
  if (descriptor.descriptorKind !== "aggregate_lattice") {
    throw new Error("Managed tool descriptor descriptorKind must be aggregate_lattice");
  }
  validateManagedToolIdentity(descriptor);
  validateManagedToolEntrypoints(descriptor.entrypoints);
  validateManagedToolCommandGroups(descriptor.commandGroups);
  validateManagedToolHealthProbes(descriptor.healthProbes);
  validateManagedToolCapabilities(descriptor.capabilities);
  const artifactReferences = validateManagedToolArtifacts(descriptor.artifacts);
  validateManagedToolChecksums(descriptor.checksums, artifactReferences);
  validateManagedToolProvenanceHooks(descriptor.provenanceHooks);
  validateGraphReleaseOptionalSurfaces(descriptor.optionalSurfaces);
  validateManagedToolDescriptorForbiddenStrings(descriptor);
  return descriptor;
}

function validateManagedToolIdentity(descriptor: ManagedToolDescriptor): void {
  const aggregate = descriptor.aggregateIdentity;
  if (!aggregate || typeof aggregate !== "object") throw new Error("Managed tool descriptor aggregateIdentity is required");
  if (aggregate.name !== "lattice") throw new Error("Managed tool descriptor aggregateIdentity.name must be lattice");
  if (aggregate.releaseLine !== "lattice") throw new Error("Managed tool descriptor aggregateIdentity.releaseLine must be lattice");
  if (aggregate.packageName !== "@the-open-engine/opcore") {
    throw new Error("Managed tool descriptor aggregateIdentity.packageName must be @the-open-engine/opcore");
  }
  if (aggregate.version !== undefined) validateNonEmptyString(aggregate.version, "Managed tool descriptor aggregateIdentity.version");

  const packageIdentity = descriptor.packageIdentity;
  if (!packageIdentity || typeof packageIdentity !== "object") {
    throw new Error("Managed tool descriptor packageIdentity is required");
  }
  if (packageIdentity.packageName !== "@the-open-engine/opcore") {
    throw new Error("Managed tool descriptor packageIdentity.packageName must be @the-open-engine/opcore");
  }
  if (packageIdentity.artifactName !== "@the-open-engine/opcore") {
    throw new Error("Managed tool descriptor packageIdentity.artifactName must be @the-open-engine/opcore");
  }
  if (packageIdentity.version !== undefined) validateNonEmptyString(packageIdentity.version, "Managed tool descriptor packageIdentity.version");
}

function validateManagedToolEntrypoints(entrypoints: readonly ManagedToolDescriptorEntrypoint[]): void {
  validateNonEmptyArray(entrypoints, "Managed tool descriptor entrypoints");
  for (const entrypoint of entrypoints) {
    if (entrypoint?.bin !== "lattice" && ["crg", "cix", "rox"].includes(String(entrypoint?.bin))) {
      throw new Error("Managed tool descriptor must not reference old public aliases");
    }
  }
  validateExactStringSet(
    entrypoints.map((entrypoint) => entrypoint.bin),
    ["lattice"],
    "Managed tool descriptor entrypoint bins"
  );
  for (const entrypoint of entrypoints) {
    if (!entrypoint || typeof entrypoint !== "object") throw new Error("Managed tool descriptor entrypoint is required");
    if (entrypoint.bin !== "lattice") throw new Error("Managed tool descriptor must not reference old public aliases");
    if (entrypoint.packageName !== "@the-open-engine/opcore") {
      throw new Error("Managed tool descriptor entrypoint packageName must be @the-open-engine/opcore");
    }
    validateManagedToolPackagePath(entrypoint.path, "Managed tool descriptor entrypoint path");
    if (entrypoint.path !== "dist/lattice/index.js") {
      throw new Error("Managed tool descriptor entrypoint path must be dist/lattice/index.js");
    }
    validateExactStringSequence(entrypoint.command, ["lattice"], "Managed tool descriptor entrypoint command");
  }
}

function validateManagedToolCommandGroups(commandGroups: readonly ManagedToolDescriptorCommandGroup[]): void {
  validateNonEmptyArray(commandGroups, "Managed tool descriptor command groups");
  validateExactStringSet(
    commandGroups.map((group) => group.name),
    managedToolDescriptorCommandGroups,
    "Managed tool descriptor command groups"
  );
  for (const group of commandGroups) {
    if (!group || typeof group !== "object") throw new Error("Managed tool descriptor command group is required");
    if (!includesString(managedToolDescriptorCommandGroups, group.name)) {
      throw new Error(`Unknown managed tool descriptor command group: ${String(group.name)}`);
    }
    const expectedCanonical = ["lattice", group.name];
    validateExactStringSequence(group.canonicalCommand, expectedCanonical, `Managed tool descriptor ${group.name} canonicalCommand`);
    validateStringArray(group.commands, `Managed tool descriptor ${group.name} commands`, { allowEmpty: false });
    const expectedPackageName = managedToolDescriptorCommandGroupPackageNames[group.name];
    if (group.packageName !== expectedPackageName) {
      throw new Error(`Managed tool descriptor ${group.name} packageName must be ${expectedPackageName}`);
    }
    validateManagedToolCommandTokens(group.commands, `Managed tool descriptor ${group.name} commands`);
  }
}

function validateManagedToolHealthProbes(healthProbes: readonly ManagedToolDescriptorHealthProbe[]): void {
  validateNonEmptyArray(healthProbes, "Managed tool descriptor health probes");
  let hasStatus = false;
  let hasDoctor = false;
  for (const probe of healthProbes) {
    if (!probe || typeof probe !== "object") throw new Error("Managed tool descriptor health probe is required");
    validateNonEmptyString(probe.id, "Managed tool descriptor health probe id");
    validateStringArray(probe.command, "Managed tool descriptor health probe command", { allowEmpty: false });
    validateManagedToolCommandTokens(probe.command, "Managed tool descriptor health probe command");
    if (probe.command[0] !== "lattice") throw new Error("Managed tool descriptor health probes must use lattice commands");
    if (probe.expectedExitCode !== 0) throw new Error("Managed tool descriptor health probe expectedExitCode must be 0");
    if (probe.output !== "json") throw new Error("Managed tool descriptor health probe output must be json");
    if (sameStringArray(probe.command, ["lattice", "status", "--json"])) hasStatus = true;
    if (sameStringArray(probe.command, ["lattice", "doctor", "--json"])) hasDoctor = true;
  }
  if (!hasStatus) throw new Error("Managed tool descriptor health probes must include status");
  if (!hasDoctor) throw new Error("Managed tool descriptor health probes must include doctor");
}

function validateManagedToolCapabilities(capabilities: ManagedToolDescriptorCapabilities): void {
  if (!capabilities || typeof capabilities !== "object") throw new Error("Managed tool descriptor capabilities are required");
  validateManagedToolGraphCapabilities(capabilities.graph);
  validateManagedToolEditCapabilities(capabilities.edit);
  validateManagedToolValidationCapabilities(capabilities.validation);
}

function validateManagedToolGraphCapabilities(graph: ManagedToolDescriptorCapabilities["graph"]): void {
  if (!graph || typeof graph !== "object") throw new Error("Managed tool descriptor graph capabilities are required");
  if (graph.provider !== "lattice-graph") throw new Error("Managed tool descriptor graph provider must be lattice-graph");
  if (graph.schemaVersion !== 1) throw new Error("Managed tool descriptor graph schemaVersion must be 1");
  validateExactStringSet(
    graph.commands,
    ["build", "update", "watch", "status", "query", "impact", "review-context", "detect-changes", "search", "serve"],
    "Managed tool descriptor graph commands"
  );
  validateStringArray(graph.queryKinds, "Managed tool descriptor graph queryKinds", { allowEmpty: false });
  validateExactStringSet(
    graph.daemonOperations,
    ["ping", "status", "query", "search", "shutdown"],
    "Managed tool descriptor graph daemonOperations"
  );
  if (!Array.isArray(graph.nativeArtifacts)) {
    throw new Error("Managed tool descriptor graph native artifacts are required");
  }
  validateExactStringSet(
    graph.nativeArtifacts.map((artifact) => artifact?.targetPlatform),
    graphCoreNativeSupportedTargets,
    "Managed tool descriptor graph native targets"
  );
  for (const artifact of graph.nativeArtifacts) {
    if (!artifact || typeof artifact !== "object") throw new Error("Managed tool descriptor graph native artifact is required");
    const expectedPackageName = graphCoreNativePackageNameForTarget(artifact.targetPlatform);
    if (artifact.packageName !== expectedPackageName) {
      throw new Error(`Managed tool descriptor graph native packageName for ${artifact.targetPlatform} must be ${expectedPackageName}`);
    }
    if (artifact.binaryPath !== "lattice-graph-core") throw new Error("Managed tool descriptor graph native binaryPath must be lattice-graph-core");
    if (artifact.metadataPath !== "metadata.json") throw new Error("Managed tool descriptor graph native metadataPath must be metadata.json");
    if (artifact.checksumPath !== "lattice-graph-core.sha256") {
      throw new Error("Managed tool descriptor graph native checksumPath must be lattice-graph-core.sha256");
    }
    if (!artifact.artifactIds || typeof artifact.artifactIds !== "object") {
      throw new Error("Managed tool descriptor graph native artifact ids are required");
    }
    const suffix = artifact.targetPlatform;
    if (artifact.artifactIds.binaryArtifactId !== `graph-core-binary-${suffix}`) {
      throw new Error(`Managed tool descriptor graph native binary artifact id must be graph-core-binary-${suffix}`);
    }
    if (artifact.artifactIds.metadataArtifactId !== `graph-core-metadata-${suffix}`) {
      throw new Error(`Managed tool descriptor graph native metadata artifact id must be graph-core-metadata-${suffix}`);
    }
    if (artifact.artifactIds.checksumArtifactId !== `graph-core-checksum-${suffix}`) {
      throw new Error(`Managed tool descriptor graph native checksum artifact id must be graph-core-checksum-${suffix}`);
    }
    if (artifact.artifactIds.checksumId !== `graph-core-binary-sha256-${suffix}`) {
      throw new Error(`Managed tool descriptor graph native checksum id must be graph-core-binary-sha256-${suffix}`);
    }
  }
}

function validateManagedToolEditCapabilities(edit: ManagedToolDescriptorCapabilities["edit"]): void {
  if (!edit || typeof edit !== "object") throw new Error("Managed tool descriptor edit capabilities are required");
  validateExactStringSet(
    edit.commands,
    ["exact", "multi", "search-replace", "patch", "tree", "rename", "move", "signature", "check", "apply"],
    "Managed tool descriptor edit commands"
  );
  validateExactStringSet(edit.safeEditModes, ["exact", "multi", "search-replace", "patch", "tree"], "Managed tool descriptor safe edit modes");
  validateExactStringSet(edit.symbolEditModes, ["rename", "move", "signature"], "Managed tool descriptor symbol edit modes");
  if (edit.validationRequiredForApply !== true) {
    throw new Error("Managed tool descriptor edit validationRequiredForApply must be true");
  }
  if (edit.dryRun !== true) throw new Error("Managed tool descriptor edit dryRun must be true");
}

function validateManagedToolValidationCapabilities(validation: ManagedToolDescriptorCapabilities["validation"]): void {
  if (!validation || typeof validation !== "object") throw new Error("Managed tool descriptor validation capabilities are required");
  validateExactStringSet(
    validation.checkRoutes,
    ["files", "staged", "changed", "tree", "all", "manifest"],
    "Managed tool descriptor check routes"
  );
  validateExactStringSet(validation.validateRoutes, ["request", "hypothetical", "pre-write", "manifest"], "Managed tool descriptor validate routes");
  validateExactStringSet(validation.scopeModes, validationScopeKinds, "Managed tool descriptor validation scope modes");
  validateExactStringSet(validation.graphModes, graphProviderModes, "Managed tool descriptor validation graph modes");
  if (validation.hypothetical !== true) throw new Error("Managed tool descriptor validation hypothetical must be true");
  validateExactStringSet(validation.statusSurfaces, ["status", "doctor"], "Managed tool descriptor validation status surfaces");
  validateValidationChecks(validation.checkIds, "Managed tool descriptor validation checkIds");
}

interface ManagedToolDescriptorArtifactValidationState {
  artifactIds: Set<string>;
  artifactChecksumRefs: readonly { artifactId: string; checksumRef: string }[];
}

function validateManagedToolArtifacts(artifacts: readonly ManagedToolDescriptorArtifactReference[]): ManagedToolDescriptorArtifactValidationState {
  validateNonEmptyArray(artifacts, "Managed tool descriptor artifacts");
  const artifactIds = new Set<string>();
  const artifactChecksumRefs: { artifactId: string; checksumRef: string }[] = [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") throw new Error("Managed tool descriptor artifact is required");
    validateNonEmptyString(artifact.id, "Managed tool descriptor artifact id");
    if (artifactIds.has(artifact.id)) throw new Error(`Managed tool descriptor artifact id must be unique: ${artifact.id}`);
    artifactIds.add(artifact.id);
    validateNonEmptyString(artifact.packageName, "Managed tool descriptor artifact packageName");
    validateManagedToolPackagePath(artifact.path, "Managed tool descriptor artifact path");
    if (!includesString(managedToolDescriptorArtifactTypes, artifact.type)) {
      throw new Error(`Unknown managed tool descriptor artifact type: ${String(artifact.type)}`);
    }
    if (typeof artifact.required !== "boolean") throw new Error("Managed tool descriptor artifact required must be boolean");
    if (artifact.checksumRef !== undefined) {
      validateNonEmptyString(artifact.checksumRef, "Managed tool descriptor artifact checksumRef");
      artifactChecksumRefs.push({ artifactId: artifact.id, checksumRef: artifact.checksumRef });
    }
  }

  for (const target of graphCoreNativeSupportedTargets) {
    const packageName = graphCoreNativePackageNameForTarget(target);
    const binary = artifacts.find((artifact) => artifact.id === `graph-core-binary-${target}`);
    const metadata = artifacts.find((artifact) => artifact.id === `graph-core-metadata-${target}`);
    const checksum = artifacts.find((artifact) => artifact.id === `graph-core-checksum-${target}`);
    if (
      !binary ||
      binary.packageName !== packageName ||
      binary.type !== "native_binary" ||
      !binary.required ||
      binary.path !== "lattice-graph-core" ||
      binary.checksumRef !== `graph-core-binary-sha256-${target}`
    ) {
      throw new Error(`Managed tool descriptor must include graph native binary artifact for ${target}`);
    }
    if (!metadata || metadata.packageName !== packageName || metadata.type !== "manifest" || !metadata.required || metadata.path !== "metadata.json") {
      throw new Error(`Managed tool descriptor must include graph native metadata artifact for ${target}`);
    }
    if (
      !checksum ||
      checksum.packageName !== packageName ||
      checksum.type !== "checksum" ||
      !checksum.required ||
      checksum.path !== "lattice-graph-core.sha256"
    ) {
      throw new Error(`Managed tool descriptor must include graph native checksum artifact for ${target}`);
    }
  }
  if (
    !artifacts.some(
      (artifact) =>
        artifact.id === "descriptor" &&
        artifact.packageName === "@the-open-engine/opcore" &&
        artifact.path === "dist/descriptors/lattice.managed-tool.json" &&
        artifact.type === "descriptor" &&
        artifact.required
    )
  ) {
    throw new Error("Managed tool descriptor must include packaged descriptor artifact");
  }
  return { artifactIds, artifactChecksumRefs };
}

function validateManagedToolChecksums(
  checksums: readonly ManagedToolDescriptorChecksumReference[],
  artifactReferences: ManagedToolDescriptorArtifactValidationState
): void {
  validateNonEmptyArray(checksums, "Managed tool descriptor checksums");
  const checksumIds = new Set<string>();
  for (const checksum of checksums) {
    if (!checksum || typeof checksum !== "object") throw new Error("Managed tool descriptor checksum is required");
    validateNonEmptyString(checksum.id, "Managed tool descriptor checksum id");
    if (checksumIds.has(checksum.id)) throw new Error(`Managed tool descriptor checksum id must be unique: ${checksum.id}`);
    checksumIds.add(checksum.id);
    validateNonEmptyString(checksum.packageName, "Managed tool descriptor checksum packageName");
    validateManagedToolPackagePath(checksum.path, "Managed tool descriptor checksum path");
    if (checksum.algorithm !== "sha256") throw new Error("Managed tool descriptor checksum algorithm must be sha256");
    validateNonEmptyString(checksum.artifactRef, "Managed tool descriptor checksum artifactRef");
    if (!artifactReferences.artifactIds.has(checksum.artifactRef)) {
      throw new Error(`Managed tool descriptor checksum artifactRef must reference an artifact: ${checksum.artifactRef}`);
    }
    if (typeof checksum.required !== "boolean") throw new Error("Managed tool descriptor checksum required must be boolean");
    if (checksum.value !== undefined && !/^[a-f0-9]{64}$/i.test(checksum.value)) {
      throw new Error("Managed tool descriptor checksum value must be a sha256 hex digest");
    }
  }
  for (const target of graphCoreNativeSupportedTargets) {
    if (!checksums.some((checksum) => checksum.id === `graph-core-binary-sha256-${target}` && checksum.artifactRef === `graph-core-binary-${target}`)) {
      throw new Error(`Managed tool descriptor must include graph native checksum reference for ${target}`);
    }
  }
  for (const artifactChecksumRef of artifactReferences.artifactChecksumRefs) {
    if (!checksumIds.has(artifactChecksumRef.checksumRef)) {
      throw new Error(
        `Managed tool descriptor artifact checksumRef must reference a checksum: ${artifactChecksumRef.artifactId} -> ${artifactChecksumRef.checksumRef}`
      );
    }
  }
}

function validateManagedToolProvenanceHooks(provenanceHooks: readonly ManagedToolDescriptorProvenanceHook[]): void {
  validateNonEmptyArray(provenanceHooks, "Managed tool descriptor provenance hooks");
  for (const hook of provenanceHooks) {
    if (!hook || typeof hook !== "object") throw new Error("Managed tool descriptor provenance hook is required");
    validateNonEmptyString(hook.id, "Managed tool descriptor provenance hook id");
    validateStringArray(hook.command, "Managed tool descriptor provenance hook command", { allowEmpty: false });
    validateManagedToolCommandTokens(hook.command, "Managed tool descriptor provenance hook command");
    if (hook.expectedExitCode !== 0) throw new Error("Managed tool descriptor provenance hook expectedExitCode must be 0");
  }
}

const managedToolPrivateRuntimePathPattern = /(?:^|\/)(?:\.ace|\.agents|\.claude|\.codex|\.gemini|\.opencode)(?:\/|$)/;

function normalizeManagedToolDescriptorString(value: string): string {
  return value.replaceAll("\\", "/");
}

function validateManagedToolPackagePath(path: string, label: string): string {
  const normalized = validateRepoRelativePath(path);
  if (normalized === "~" || normalized.startsWith("~/")) {
    throw new Error(`${label} must not reference private home paths`);
  }
  if (managedToolPrivateRuntimePathPattern.test(normalized)) {
    throw new Error(`${label} must not reference private runtime paths`);
  }
  if (normalized.includes("LATTICE_CURRENT_TOOLS_DIR")) {
    throw new Error(`${label} must not reference current-tool environment variables`);
  }
  return normalized;
}

function validateManagedToolCommandTokens(tokens: readonly string[], label: string): void {
  for (const token of tokens) {
    validateNonEmptyString(token, label);
    if (["crg", "cix", "rox"].includes(token)) throw new Error("Managed tool descriptor must not reference old public aliases");
    const normalizedToken = normalizeManagedToolDescriptorString(token);
    if (managedToolPrivateRuntimePathPattern.test(normalizedToken) || normalizedToken.includes("LATTICE_CURRENT_TOOLS_DIR")) {
      throw new Error("Managed tool descriptor must not reference current-tool runtime paths");
    }
  }
}

function validateManagedToolDescriptorForbiddenStrings(value: unknown): void {
  const oldAliasPattern = /(^|[\\/\s])(?:crg|cix|rox)(?:$|[\\/\s])/i;
  for (const text of collectStrings(value)) {
    if (oldAliasPattern.test(text)) throw new Error("Managed tool descriptor must not reference old public aliases");
    const normalizedText = normalizeManagedToolDescriptorString(text);
    if (managedToolPrivateRuntimePathPattern.test(normalizedText) || normalizedText.includes("LATTICE_CURRENT_TOOLS_DIR")) {
      throw new Error("Managed tool descriptor must not reference current-tool runtime paths");
    }
    if (normalizedText.includes("/Users/tom")) {
      throw new Error("Managed tool descriptor must not reference private paths");
    }
  }
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function withoutUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function validateCommandRouterManifestHeader(manifest: CommandRouterManifest): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Command router manifest is required");
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("Command router manifest schemaVersion must be 1");
  }
  if (typeof manifest.packageName !== "string" || manifest.packageName.length === 0) {
    throw new Error("Command router manifest packageName must be a non-empty string");
  }
}

function validateManifestBins(bins: readonly string[]): void {
  if (!Array.isArray(bins) || bins.length === 0) {
    throw new Error("Command router manifest must include bins");
  }
  for (const bin of bins) {
    if (typeof bin !== "string" || bin.length === 0) {
      throw new Error("Command router manifest bins must be non-empty strings");
    }
  }
}

function validateManifestGroups(commandGroups: readonly CommandGroupContract[]): Set<string> {
  const groupNames = new Set<string>();
  for (const group of commandGroups) {
    validateCommandOwner(group.owner);
    validateNonEmptyString(group.name, "Command group name");
    validateStringArray(group.canonicalCommand, "Command group canonicalCommand", { allowEmpty: false });
    validateStringArray(group.commands, "Command group commands", { allowEmpty: false });
    validateNonEmptyString(group.summary, "Command group summary");
    groupNames.add(group.name);
  }

  return groupNames;
}

function validateManifestOwnershipBoundaries(boundaries: CommandRouterManifest["ownershipBoundaries"]): void {
  for (const boundary of boundaries) {
    validateCommandOwner(boundary.owner);
    validateNonEmptyString(boundary.summary, "Command ownership boundary summary");
  }
}

export function validateCommandRouterResult(result: CommandRouterResult): CommandRouterResult {
  if (!result || typeof result !== "object") {
    throw new Error("Command router result is required");
  }
  if (result.schemaVersion !== 1) {
    throw new Error("Command router result schemaVersion must be 1");
  }
  validateNonEmptyString(result.bin, "Command router result bin");
  validateStringArray(result.argv, "Command router result argv", { allowEmpty: true });
  validateStringArray(result.canonicalCommand, "Command router result canonicalCommand", { allowEmpty: false });
  validateCommandOwner(result.owner);
  validateCommandRouteStatus(result.status);
  validateExitCodeForStatus(result.exitCode, result.status);
  validateNonEmptyString(result.message, "Command router result message");
  if (typeof result.json !== "boolean") {
    throw new Error("Command router result json must be boolean");
  }
  if (result.providerStatus !== undefined) validateProviderStatus(result.providerStatus);
  if (result.graphPipeline !== undefined) validateGraphPipelineResult(result.graphPipeline);
  if (result.graphQuery !== undefined) {
    if (isNamedQueryResult(result.graphQuery)) validateGraphNamedQueryResult(result.graphQuery);
    else validateGraphFactQueryResult(result.graphQuery);
  }
  if (result.graphSearch !== undefined) validateGraphSearchResult(result.graphSearch);
  if (result.inspectResult !== undefined) validateInspectRouteResult(result.inspectResult);
  if (result.graphImpact !== undefined) validateGraphImpactResult(result.graphImpact);
  if (result.graphReviewContext !== undefined) validateGraphReviewContextResult(result.graphReviewContext);
  if (result.graphChanges !== undefined) validateGraphDetectChangesResult(result.graphChanges);
  if (result.graphServe !== undefined) validateGraphServeTransportStatus(result.graphServe);
  if (result.validationResult !== undefined) validateValidationResultPayload(result.validationResult);
  if (result.validationStatus !== undefined) validateValidationStatusPayload(result.validationStatus);
  if (result.receipt !== undefined) validatePreWriteValidationReceipt(result.receipt);
  if (result.editPlan !== undefined) validateEditPlanPayload(result.editPlan);
  if (result.editResult !== undefined) validateEditCommandResult(result.editResult);
  if (result.repoState !== undefined) validateOpcoreRepoStatePayload(result.repoState);
  if (result.opcoreInit !== undefined) validateOpcoreInitPlanPayload(result.opcoreInit);
  if (result.opcoreMeasure !== undefined) validateOpcoreMeasureDelta(result.opcoreMeasure);
  if (result.opcoreTry !== undefined) validateOpcoreTryPayload(result.opcoreTry);
  if (result.timing !== undefined) validateCommandTiming(result.timing);
  if (result.repoState !== undefined && result.owner !== "runtime") {
    throw new Error("Opcore repoState payload requires runtime owner");
  }
  if (result.opcoreInit !== undefined && result.owner !== "runtime") {
    throw new Error("Opcore init payload requires runtime owner");
  }
  if (result.opcoreMeasure !== undefined && result.owner !== "runtime") {
    throw new Error("Opcore measure payload requires runtime owner");
  }
  if (result.opcoreTry !== undefined && result.owner !== "runtime") {
    throw new Error("Opcore try payload requires runtime owner");
  }
  if ((result.editPlan !== undefined || result.editResult !== undefined) && result.owner !== "edit") {
    throw new Error("Edit router payloads require edit owner");
  }
  if (result.owner === "edit" && result.status === "ok" && result.editPlan === undefined && result.editResult === undefined) {
    const hiddenPayloadPattern = /"?(editPlan|editResult|planId|changes|afterState)"?\s*[:{[]/;
    if (hiddenPayloadPattern.test(result.message)) {
      throw new Error("Edit router payloads must use editPlan/editResult fields, not message strings");
    }
  }
  return result;
}

export function validateOpcoreRepoStatePayload(payload: OpcoreRepoStatePayload): OpcoreRepoStatePayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Opcore repo state payload is required");
  }
  if (payload.schemaVersion !== 1) {
    throw new Error("Opcore repo state payload schemaVersion must be 1");
  }
  if (!payload.repo || typeof payload.repo !== "object") {
    throw new Error("Opcore repo state repo is required");
  }
  validateNonEmptyString(payload.repo.root, "Opcore repo state repo root");
  validateNonEmptyString(payload.repo.requestedPath, "Opcore repo state requested path");
  if (!payload.repo.git || typeof payload.repo.git !== "object") {
    throw new Error("Opcore repo state git payload is required");
  }
  if (typeof payload.repo.git.available !== "boolean") {
    throw new Error("Opcore repo state git available must be boolean");
  }
  if (payload.repo.git.branch !== undefined) validateNonEmptyString(payload.repo.git.branch, "Opcore repo state git branch");
  for (const [key, value] of Object.entries(payload.repo.git)) {
    if (key === "available" || key === "branch" || key === "clean") continue;
    validateNonNegativeInteger(value, `Opcore repo state git ${key}`);
  }
  if (payload.repo.git.clean !== undefined && typeof payload.repo.git.clean !== "boolean") {
    throw new Error("Opcore repo state git clean must be boolean");
  }

  if (!payload.coverage || typeof payload.coverage !== "object") {
    throw new Error("Opcore repo state coverage is required");
  }
  validateNonNegativeInteger(payload.coverage.totalFiles, "Opcore repo state coverage totalFiles");
  if (!Array.isArray(payload.coverage.languages)) {
    throw new Error("Opcore repo state coverage languages must be an array");
  }
  for (const language of payload.coverage.languages) {
    validateNonEmptyString(language.language, "Opcore repo state language");
    validateNonNegativeInteger(language.files, "Opcore repo state language files");
    if (typeof language.graphSupported !== "boolean" || typeof language.validationSupported !== "boolean") {
      throw new Error("Opcore repo state language support flags must be boolean");
    }
  }
  validateOpcoreCoverageCounts(payload.coverage.graph, "graph");
  validateOpcoreCoverageCounts(payload.coverage.validation, "validation");
  validateNonNegativeInteger(payload.coverage.validation.retainedFiles, "Opcore repo state validation retainedFiles");
  if (!payload.coverage.unsupported || typeof payload.coverage.unsupported !== "object") {
    throw new Error("Opcore repo state unsupported coverage is required");
  }
  validateNonNegativeInteger(payload.coverage.unsupported.totalFiles, "Opcore repo state unsupported totalFiles");
  if (!Array.isArray(payload.coverage.unsupported.stacks)) {
    throw new Error("Opcore repo state unsupported stacks must be an array");
  }
  for (const stack of payload.coverage.unsupported.stacks) {
    validateNonEmptyString(stack.extension, "Opcore repo state unsupported extension");
    validateNonEmptyString(stack.language, "Opcore repo state unsupported language");
    validateNonNegativeInteger(stack.count, "Opcore repo state unsupported count");
    validateStringArray(stack.examples, "Opcore repo state unsupported examples", { allowEmpty: true });
  }

  if (!payload.graph || typeof payload.graph !== "object") {
    throw new Error("Opcore repo state graph is required");
  }
  if (!includesString(graphProviderStatusStates, payload.graph.state)) {
    throw new Error(`Unknown Opcore repo state graph state: ${String(payload.graph.state)}`);
  }
  if (!includesString(graphProviderModes, payload.graph.mode)) {
    throw new Error(`Unknown Opcore repo state graph mode: ${String(payload.graph.mode)}`);
  }
  validateNonEmptyString(payload.graph.provider, "Opcore repo state graph provider");
  validateNonEmptyString(payload.graph.action, "Opcore repo state graph action");
  if (payload.graph.message !== undefined) validateNonEmptyString(payload.graph.message, "Opcore repo state graph message");
  const graphStatus = validateProviderStatus(payload.graph.status);
  if (graphStatus.state !== payload.graph.state || graphStatus.mode !== payload.graph.mode || graphStatus.provider !== payload.graph.provider) {
    throw new Error("Opcore repo state graph summary must match provider status");
  }

  if (!payload.validation || typeof payload.validation !== "object") {
    throw new Error("Opcore repo state validation is required");
  }
  if (typeof payload.validation.ready !== "boolean") {
    throw new Error("Opcore repo state validation ready must be boolean");
  }
  validateNonNegativeInteger(payload.validation.checkCount, "Opcore repo state validation checkCount");
  if (!Array.isArray(payload.validation.adapters)) {
    throw new Error("Opcore repo state validation adapters must be an array");
  }
  for (const adapter of payload.validation.adapters) {
    validateNonEmptyString(adapter.adapter, "Opcore repo state validation adapter");
    if (!includesString(validationAdapterRuntimeStates, adapter.status)) {
      throw new Error(`Unknown Opcore validation adapter status: ${String(adapter.status)}`);
    }
    validateNonNegativeInteger(adapter.checkCount, "Opcore repo state validation adapter checkCount");
    validateStringArray(adapter.degradedChecks, "Opcore repo state validation degradedChecks", { allowEmpty: true });
    validateStringArray(adapter.missingTools, "Opcore repo state validation missingTools", { allowEmpty: true });
  }
  if (!Array.isArray(payload.validation.degradedToolchains)) {
    throw new Error("Opcore repo state validation degradedToolchains must be an array");
  }
  for (const tool of payload.validation.degradedToolchains) {
    validateNonEmptyString(tool.adapter, "Opcore repo state validation degraded adapter");
    validateNonEmptyString(tool.tool, "Opcore repo state validation degraded tool");
    if (tool.failureMessage !== undefined) {
      validateNonEmptyString(tool.failureMessage, "Opcore repo state validation degraded failureMessage");
    }
  }

  if (!payload.activation || typeof payload.activation !== "object") {
    throw new Error("Opcore repo state activation is required");
  }
  if (typeof payload.activation.ready !== "boolean") {
    throw new Error("Opcore repo state activation ready must be boolean");
  }
  if (!includesString(["ready", "degraded", "blocked"] as const, payload.activation.level)) {
    throw new Error(`Unknown Opcore activation level: ${String(payload.activation.level)}`);
  }
  validateNonEmptyString(payload.activation.summary, "Opcore repo state activation summary");
  if (!payload.activation.asp || typeof payload.activation.asp !== "object") {
    throw new Error("Opcore repo state ASP status is required");
  }
  if (!includesString(["enrolled", "not_enrolled"] as const, payload.activation.asp.state)) {
    throw new Error(`Unknown Opcore ASP state: ${String(payload.activation.asp.state)}`);
  }
  validateStringArray(payload.activation.asp.paths, "Opcore repo state ASP paths", { allowEmpty: true });
  validateStringArray(payload.warnings, "Opcore repo state warnings", { allowEmpty: true });
  validateStringArray(payload.blockers, "Opcore repo state blockers", { allowEmpty: true });
  validateStringArray(payload.nextActions, "Opcore repo state nextActions", { allowEmpty: false });
  return payload;
}

export function validateOpcoreInitPlanPayload(payload: OpcoreInitPlanPayload): OpcoreInitPlanPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Opcore init payload is required");
  }
  if (payload.schemaVersion !== 1) {
    throw new Error("Opcore init payload schemaVersion must be 1");
  }
  if (!includesString(["plan", "apply", "undo"] as const, payload.mode)) {
    throw new Error(`Unknown Opcore init mode: ${String(payload.mode)}`);
  }
  if (typeof payload.approved !== "boolean") {
    throw new Error("Opcore init approved must be boolean");
  }
  if (payload.mode === "plan" && payload.approved) {
    throw new Error("Opcore init approved plan must use apply mode");
  }
  if (payload.mode === "apply" && !payload.approved) {
    throw new Error("Opcore init apply mode requires approval");
  }
  if (!payload.repo || typeof payload.repo !== "object") {
    throw new Error("Opcore init repo is required");
  }
  validateNonEmptyString(payload.repo.root, "Opcore init repo root");
  validateNonEmptyString(payload.repo.requestedPath, "Opcore init requested path");
  if (!payload.options || typeof payload.options !== "object") {
    throw new Error("Opcore init options are required");
  }
  if (typeof payload.options.failClosedHook !== "boolean") {
    throw new Error("Opcore init failClosedHook option must be boolean");
  }
  if (typeof payload.options.dryRun !== "boolean") {
    throw new Error("Opcore init dryRun option must be boolean");
  }
  validateStringArray(payload.agentFiles, "Opcore init agentFiles", { allowEmpty: true });
  for (const agentFile of payload.agentFiles) validateRepoRelativePath(agentFile);
  validateNonEmptyArray(payload.actions, "Opcore init actions");
  for (const action of payload.actions) validateOpcoreInitAction(action);
  validateStringArray(payload.warnings, "Opcore init warnings", { allowEmpty: true });
  validateStringArray(payload.nextActions, "Opcore init nextActions", { allowEmpty: false });
  if (typeof payload.undoAvailable !== "boolean") {
    throw new Error("Opcore init undoAvailable must be boolean");
  }
  validateOpcoreInitScanSummary(payload.scan);
  validateOpcoreInitSettings(payload.settings);
  validateOpcoreInitInteraction(payload.interaction);
  validateOpcoreInitTiming(payload.timings);
  return payload;
}

function validateOpcoreInitScanSummary(scan: OpcoreInitScanSummary): OpcoreInitScanSummary {
  if (!scan || typeof scan !== "object") {
    throw new Error("Opcore init scan summary is required");
  }
  validateNonNegativeInteger(scan.totalFiles, "Opcore init scan totalFiles");
  validateNonNegativeInteger(scan.graphSupportedFiles, "Opcore init scan graphSupportedFiles");
  validateNonNegativeInteger(scan.validationSupportedFiles, "Opcore init scan validationSupportedFiles");
  validateNonNegativeInteger(scan.validationRetainedFiles, "Opcore init scan validationRetainedFiles");
  validateNonNegativeInteger(scan.unsupportedFiles, "Opcore init scan unsupportedFiles");
  validateOpcoreCoverageLanguages(scan.languages, "Opcore init scan");
  validateOpcoreUnsupportedStacks(scan.unsupportedStacks, "Opcore init scan");
  if (!Array.isArray(scan.degradedRustTools)) {
    throw new Error("Opcore init scan degradedRustTools must be an array");
  }
  for (const tool of scan.degradedRustTools) {
    if (!tool || typeof tool !== "object") {
      throw new Error("Opcore init scan degraded Rust tool is required");
    }
    validateNonEmptyString(tool.adapter, "Opcore init scan degraded Rust adapter");
    validateNonEmptyString(tool.tool, "Opcore init scan degraded Rust tool");
    if (tool.failureMessage !== undefined) validateNonEmptyString(tool.failureMessage, "Opcore init scan degraded Rust failureMessage");
  }
  validateNonNegativeInteger(scan.diagnosticCount, "Opcore init scan diagnosticCount");
  if (!includesString(validationResultStatuses, scan.validationStatus)) {
    throw new Error(`Unknown Opcore init scan validationStatus: ${String(scan.validationStatus)}`);
  }
  validateStringArray(scan.failedChecks, "Opcore init scan failedChecks", { allowEmpty: true });
  if (!includesString(graphProviderStatusStates, scan.graphState)) {
    throw new Error(`Unknown Opcore init scan graphState: ${String(scan.graphState)}`);
  }
  if (!includesString(["ready", "degraded", "blocked"] as const, scan.activationLevel)) {
    throw new Error(`Unknown Opcore init scan activationLevel: ${String(scan.activationLevel)}`);
  }
  return scan;
}

function validateOpcoreInitSettings(settings: OpcoreInitSettings): OpcoreInitSettings {
  if (!settings || typeof settings !== "object") {
    throw new Error("Opcore init settings are required");
  }
  if (!Array.isArray(settings.languages)) {
    throw new Error("Opcore init settings languages must be an array");
  }
  for (const language of settings.languages) {
    validateOpcoreInitLanguageSetting(language);
  }
  return settings;
}

function validateOpcoreInitLanguageSetting(setting: OpcoreInitLanguageSetting): OpcoreInitLanguageSetting {
  if (!setting || typeof setting !== "object") {
    throw new Error("Opcore init language setting is required");
  }
  validateNonEmptyString(setting.language, "Opcore init language setting language");
  validateNonNegativeInteger(setting.files, "Opcore init language setting files");
  if (!includesString(["supported", "retained", "unsupported", "degraded"] as const, setting.state)) {
    throw new Error(`Unknown Opcore init language setting state: ${String(setting.state)}`);
  }
  if (!includesString(["supported", "unsupported"] as const, setting.graph)) {
    throw new Error(`Unknown Opcore init language setting graph: ${String(setting.graph)}`);
  }
  if (!includesString(["supported", "retained", "unsupported", "degraded"] as const, setting.validation)) {
    throw new Error(`Unknown Opcore init language setting validation: ${String(setting.validation)}`);
  }
  validateValidationChecks(setting.checks, "Opcore init language setting checks");
  validateStringArray(setting.notes, "Opcore init language setting notes", { allowEmpty: true });
  return setting;
}

function validateOpcoreInitInteraction(interaction: OpcoreInitInteraction): OpcoreInitInteraction {
  if (!interaction || typeof interaction !== "object") {
    throw new Error("Opcore init interaction is required");
  }
  if (typeof interaction.tty !== "boolean") {
    throw new Error("Opcore init interaction tty must be boolean");
  }
  if (!includesString(["not_requested", "requested", "approved", "declined"] as const, interaction.promptState)) {
    throw new Error(`Unknown Opcore init interaction promptState: ${String(interaction.promptState)}`);
  }
  return interaction;
}

function validateOpcoreInitTiming(timing: OpcoreInitTiming): OpcoreInitTiming {
  if (!timing || typeof timing !== "object") {
    throw new Error("Opcore init timings are required");
  }
  validateNonNegativeNumber(timing.scanMs, "Opcore init timing scanMs");
  validateNonNegativeNumber(timing.planMs, "Opcore init timing planMs");
  validateNonNegativeNumber(timing.promptMs, "Opcore init timing promptMs");
  validateNonNegativeNumber(timing.applyMs, "Opcore init timing applyMs");
  validateNonNegativeNumber(timing.totalMs, "Opcore init timing totalMs");
  validateNonNegativeNumber(timing.firstOutputMs, "Opcore init timing firstOutputMs");
  return timing;
}

export function validateCommandTiming(timing: CommandTiming): CommandTiming {
  assertNoOpaqueScoreFields(timing, "Command timing");
  assertNoTelemetrySourceFields(timing, "Command timing");
  if (!timing || typeof timing !== "object") {
    throw new Error("Command timing is required");
  }
  validateNonNegativeNumber(timing.durationMs, "Command timing durationMs");
  if (!Array.isArray(timing.phases)) {
    throw new Error("Command timing phases must be an array");
  }
  for (const phase of timing.phases) validateCommandTimingPhase(phase);
  if (!includesString(commandTimingProcessStates, timing.processState)) {
    throw new Error(`Unknown command timing processState: ${String(timing.processState)}`);
  }
  if (timing.degradations !== undefined) {
    validateStringArray(timing.degradations, "Command timing degradations", { allowEmpty: true });
    for (const degradation of timing.degradations) {
      if (!includesString(commandTimingDegradationReasons, degradation)) {
        throw new Error(`Unknown command timing degradation: ${String(degradation)}`);
      }
    }
  }
  return timing;
}

export function validateRepoShapeFingerprint(fingerprint: RepoShapeFingerprint): RepoShapeFingerprint {
  assertNoOpaqueScoreFields(fingerprint, "Repo shape fingerprint");
  assertNoTelemetrySourceFields(fingerprint, "Repo shape fingerprint");
  if (!fingerprint || typeof fingerprint !== "object") {
    throw new Error("Repo shape fingerprint is required");
  }
  validateNonNegativeInteger(fingerprint.totalFiles, "Repo shape fingerprint totalFiles");
  if (!Array.isArray(fingerprint.languages)) {
    throw new Error("Repo shape fingerprint languages must be an array");
  }
  for (const language of fingerprint.languages) {
    validateNonEmptyString(language.language, "Repo shape fingerprint language");
    validateNonNegativeInteger(language.files, "Repo shape fingerprint language files");
  }
  if (!fingerprint.graph || typeof fingerprint.graph !== "object") {
    throw new Error("Repo shape fingerprint graph is required");
  }
  validateNonNegativeInteger(fingerprint.graph.supportedFiles, "Repo shape fingerprint graph supportedFiles");
  validateNonNegativeInteger(fingerprint.graph.unsupportedFiles, "Repo shape fingerprint graph unsupportedFiles");
  if (!fingerprint.git || typeof fingerprint.git !== "object") {
    throw new Error("Repo shape fingerprint git is required");
  }
  if (typeof fingerprint.git.available !== "boolean") {
    throw new Error("Repo shape fingerprint git available must be boolean");
  }
  if (fingerprint.git.clean !== undefined && typeof fingerprint.git.clean !== "boolean") {
    throw new Error("Repo shape fingerprint git clean must be boolean");
  }
  return fingerprint;
}

export function validateCommandLatencyRecord(record: CommandLatencyRecord): CommandLatencyRecord {
  assertNoOpaqueScoreFields(record, "Command latency record");
  assertNoTelemetrySourceFields(record, "Command latency record");
  if (!record || typeof record !== "object") {
    throw new Error("Command latency record is required");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("Command latency record schemaVersion must be 1");
  }
  validateNonEmptyString(record.recordedAt, "Command latency record recordedAt");
  validateLatencyTelemetryCommandBin(record.bin, "Command latency record bin");
  validateLatencyCanonicalCommand(record.canonicalCommand, "Command latency record canonicalCommand");
  validateCommandOwner(record.owner);
  const status = validateCommandRouteStatus(record.status);
  validateExitCodeForStatus(record.exitCode, status);
  validateRepoShapeFingerprint(record.repo);
  validateCommandTiming(record.timing);
  validateNonEmptyString(record.opcoreVersion, "Command latency record opcoreVersion");
  return record;
}

export function validateLatencyBudget(budget: LatencyBudget): LatencyBudget {
  assertNoOpaqueScoreFields(budget, "Latency budget");
  assertNoTelemetrySourceFields(budget, "Latency budget");
  if (!budget || typeof budget !== "object") {
    throw new Error("Latency budget is required");
  }
  if (budget.schemaVersion !== 1) {
    throw new Error("Latency budget schemaVersion must be 1");
  }
  validateLatencyCanonicalCommand(budget.canonicalCommand, "Latency budget canonicalCommand");
  validateLatencyStableId(budget.scope, "Latency budget scope");
  validateLatencyStableId(budget.repoShapeBucket, "Latency budget repoShapeBucket");
  validateNonNegativeNumber(budget.budgetMs, "Latency budget budgetMs");
  if (budget.phaseBudgets !== undefined) {
    if (!Array.isArray(budget.phaseBudgets)) {
      throw new Error("Latency budget phaseBudgets must be an array");
    }
    const phases = new Set<string>();
    for (const phaseBudget of budget.phaseBudgets) {
      const validatedPhaseBudget = validateLatencyPhaseBudget(phaseBudget);
      if (phases.has(validatedPhaseBudget.phase)) {
        throw new Error("Latency budget phaseBudgets must not include duplicate phases");
      }
      phases.add(validatedPhaseBudget.phase);
    }
  }
  return budget;
}

export function validateLatencyBudgetResult(result: LatencyBudgetResult): LatencyBudgetResult {
  assertNoOpaqueScoreFields(result, "Latency budget result");
  assertNoTelemetrySourceFields(result, "Latency budget result");
  if (!result || typeof result !== "object") {
    throw new Error("Latency budget result is required");
  }
  if (result.schemaVersion !== 1) {
    throw new Error("Latency budget result schemaVersion must be 1");
  }
  if (!includesString(latencyBudgetResultStatuses, result.status)) {
    throw new Error(`Unknown latency budget result status: ${String(result.status)}`);
  }
  const budget = validateLatencyBudget(result.budget);
  if (!result.observed || typeof result.observed !== "object") {
    throw new Error("Latency budget result observed is required");
  }
  validateLatencyCanonicalCommand(result.observed.canonicalCommand, "Latency budget result observed canonicalCommand");
  validateLatencyStableId(result.observed.phase, "Latency budget result observed phase");
  validateNonNegativeNumber(result.observed.durationMs, "Latency budget result observed durationMs");
  if (!result.evidence || typeof result.evidence !== "object") {
    throw new Error("Latency budget result evidence is required");
  }
  validateLatencyCanonicalCommand(result.evidence.canonicalCommand, "Latency budget result evidence canonicalCommand");
  validateLatencyStableId(result.evidence.phase, "Latency budget result evidence phase");
  validateLatencyStableId(result.evidence.repoShapeBucket, "Latency budget result evidence repoShapeBucket");
  validateNonNegativeNumber(result.evidence.observedMs, "Latency budget result evidence observedMs");
  validateNonNegativeNumber(result.evidence.budgetMs, "Latency budget result evidence budgetMs");
  validateNonNegativeNumber(result.evidence.overByMs, "Latency budget result evidence overByMs");
  if (!sameStringArray(result.observed.canonicalCommand, result.evidence.canonicalCommand)) {
    throw new Error("Latency budget result observed and evidence commands must match");
  }
  if (!sameStringArray(budget.canonicalCommand, result.evidence.canonicalCommand)) {
    throw new Error("Latency budget result evidence command must match budget command");
  }
  if (result.observed.phase !== result.evidence.phase) {
    throw new Error("Latency budget result observed and evidence phases must match");
  }
  if (budget.repoShapeBucket !== result.evidence.repoShapeBucket) {
    throw new Error("Latency budget result evidence bucket must match budget bucket");
  }
  if (result.observed.durationMs !== result.evidence.observedMs) {
    throw new Error("Latency budget result observed duration must match evidence observedMs");
  }
  const appliedBudgetMs = resolveLatencyAppliedBudgetMs(budget, result.evidence.phase);
  if (result.evidence.budgetMs !== appliedBudgetMs) {
    throw new Error("Latency budget result evidence budgetMs must match the applied budget");
  }
  const computedOverByMs = Math.max(0, result.evidence.observedMs - appliedBudgetMs);
  if (result.evidence.overByMs !== computedOverByMs) {
    throw new Error("Latency budget result overByMs must equal observedMs over budgetMs");
  }
  if (result.status === "pass" && result.evidence.overByMs !== 0) {
    throw new Error("Latency budget pass result must not exceed budget");
  }
  if (result.status === "over" && result.evidence.overByMs <= 0) {
    throw new Error("Latency budget over result must exceed budget");
  }
  return result;
}

function validateOpcoreInitAction(action: OpcoreInitAction): OpcoreInitAction {
  if (!action || typeof action !== "object") {
    throw new Error("Opcore init action is required");
  }
  if (!includesString(["write", "upsert_block", "create_hook", "restore", "remove"] as const, action.kind)) {
    throw new Error(`Unknown Opcore init action kind: ${String(action.kind)}`);
  }
  const path = validateRepoRelativePath(validateNonEmptyString(action.path, "Opcore init action path"));
  validateNonEmptyString(action.summary, "Opcore init action summary");
  if (typeof action.requiresApproval !== "boolean") {
    throw new Error("Opcore init action requiresApproval must be boolean");
  }
  if (typeof action.outsideOpcore !== "boolean") {
    throw new Error("Opcore init action outsideOpcore must be boolean");
  }
  const insideOpcore = path === ".opcore" || path.startsWith(".opcore/");
  if (action.outsideOpcore === insideOpcore) {
    throw new Error("Opcore init action outsideOpcore must match action path");
  }
  if (action.outsideOpcore && !action.requiresApproval) {
    throw new Error("Opcore init action outside .opcore requires approval");
  }
  return action;
}

export function validateOpcoreMetricReport(report: OpcoreMetricReport): OpcoreMetricReport {
  assertNoOpaqueScoreFields(report, "Opcore metric report");
  if (!report || typeof report !== "object") {
    throw new Error("Opcore metric report is required");
  }
  if (report.schemaVersion !== 1) {
    throw new Error("Opcore metric report schemaVersion must be 1");
  }
  if (report.kind !== "opcore_metric_report") {
    throw new Error("Opcore metric report kind must be opcore_metric_report");
  }
  validateNonEmptyString(report.generatedAt, "Opcore metric report generatedAt");
  if (!report.repo || typeof report.repo !== "object") {
    throw new Error("Opcore metric report repo is required");
  }
  validateNonEmptyString(report.repo.root, "Opcore metric report repo root");
  validateNonEmptyString(report.repo.requestedPath, "Opcore metric report repo requestedPath");
  if (!report.repo.git || typeof report.repo.git !== "object") {
    throw new Error("Opcore metric report repo git is required");
  }
  if (typeof report.repo.git.available !== "boolean") {
    throw new Error("Opcore metric report repo git available must be boolean");
  }
  if (report.repo.git.branch !== undefined) validateNonEmptyString(report.repo.git.branch, "Opcore metric report git branch");
  for (const [key, value] of Object.entries(report.repo.git)) {
    if (key === "available" || key === "branch" || key === "clean") continue;
    validateNonNegativeInteger(value, `Opcore metric report git ${key}`);
  }
  if (report.repo.git.clean !== undefined && typeof report.repo.git.clean !== "boolean") {
    throw new Error("Opcore metric report git clean must be boolean");
  }
  validateOpcoreMetricCoverage(report.coverage, "Opcore metric report coverage");
  if (!report.graph || typeof report.graph !== "object") {
    throw new Error("Opcore metric report graph is required");
  }
  if (!includesString(graphProviderStatusStates, report.graph.state)) {
    throw new Error(`Unknown Opcore metric graph state: ${String(report.graph.state)}`);
  }
  if (!includesString(graphProviderModes, report.graph.mode)) {
    throw new Error(`Unknown Opcore metric graph mode: ${String(report.graph.mode)}`);
  }
  validateNonEmptyString(report.graph.provider, "Opcore metric report graph provider");
  if (!report.validation || typeof report.validation !== "object") {
    throw new Error("Opcore metric report validation is required");
  }
  if (report.validation.status !== undefined && !includesString(validationResultStatuses, report.validation.status)) {
    throw new Error(`Unknown Opcore metric validation status: ${String(report.validation.status)}`);
  }
  validateNonNegativeInteger(report.validation.diagnosticCount, "Opcore metric report diagnosticCount");
  validateNonNegativeInteger(report.validation.checkCount, "Opcore metric report checkCount");
  if (!Array.isArray(report.signals)) {
    throw new Error("Opcore metric report signals must be an array");
  }
  for (const signal of report.signals) validateOpcoreMetricSignal(signal);
  if (!Array.isArray(report.degradations)) {
    throw new Error("Opcore metric report degradations must be an array");
  }
  for (const degradation of report.degradations) validateOpcoreMetricDegradation(degradation);
  validateStringArray(report.warnings, "Opcore metric report warnings", { allowEmpty: true });
  validateStringArray(report.nextActions, "Opcore metric report nextActions", { allowEmpty: false });
  return report;
}

export function validateOpcoreMetricHistoryEntry(entry: OpcoreMetricHistoryEntry): OpcoreMetricHistoryEntry {
  assertNoOpaqueScoreFields(entry, "Opcore metric history entry");
  if (!entry || typeof entry !== "object") {
    throw new Error("Opcore metric history entry is required");
  }
  if (entry.schemaVersion !== 1) {
    throw new Error("Opcore metric history entry schemaVersion must be 1");
  }
  if (entry.kind !== "opcore_metric_history_entry") {
    throw new Error("Opcore metric history entry kind must be opcore_metric_history_entry");
  }
  validateNonEmptyString(entry.recordedAt, "Opcore metric history entry recordedAt");
  validateOpcoreMetricReport(entry.report);
  return entry;
}

export function validateOpcoreMeasureDelta(delta: OpcoreMeasureDelta): OpcoreMeasureDelta {
  assertNoOpaqueScoreFields(delta, "Opcore measure delta");
  if (!delta || typeof delta !== "object") {
    throw new Error("Opcore measure delta is required");
  }
  if (delta.schemaVersion !== 1) {
    throw new Error("Opcore measure delta schemaVersion must be 1");
  }
  if (delta.kind !== "opcore_measure_delta") {
    throw new Error("Opcore measure delta kind must be opcore_measure_delta");
  }
  validateNonEmptyString(delta.generatedAt, "Opcore measure delta generatedAt");
  if (!delta.current || typeof delta.current !== "object") {
    throw new Error("Opcore measure delta current is required");
  }
  validateNonEmptyString(delta.current.generatedAt, "Opcore measure delta current generatedAt");
  validateOpcoreMetricCoverage(delta.current.coverage, "Opcore measure delta current coverage");
  validateOpcoreMeasureSignalCounts(delta.current.signals, "Opcore measure delta current signals");
  if (delta.baseline !== undefined) validateOpcoreMeasureComparison(delta.baseline, "baseline");
  if (delta.previous !== undefined) validateOpcoreMeasureComparison(delta.previous, "previous");
  validateStringArray(delta.warnings, "Opcore measure delta warnings", { allowEmpty: true });
  if (!Array.isArray(delta.degradations)) {
    throw new Error("Opcore measure delta degradations must be an array");
  }
  for (const degradation of delta.degradations) validateOpcoreMetricDegradation(degradation);
  validateStringArray(delta.nextActions, "Opcore measure delta nextActions", { allowEmpty: false });
  return delta;
}

export function validateOpcoreTryPayload(payload: OpcoreTryPayload): OpcoreTryPayload {
  assertNoOpaqueScoreFields(payload, "Opcore try payload");
  if (!payload || typeof payload !== "object") {
    throw new Error("Opcore try payload is required");
  }
  if (payload.schemaVersion !== 1) {
    throw new Error("Opcore try payload schemaVersion must be 1");
  }
  validateNonEmptyString(payload.sampleRoot, "Opcore try sampleRoot");
  if (payload.published !== false) {
    throw new Error("Opcore try published must be false");
  }
  validateNonEmptyArray(payload.scenarios, "Opcore try scenarios");
  for (const scenario of payload.scenarios) validateOpcoreTryScenario(scenario);
  validateNonEmptyArray(payload.commands, "Opcore try commands");
  for (const command of payload.commands) validateOpcoreTryCommand(command);
  return payload;
}

function validateOpcoreTryScenario(scenario: OpcoreTryScenario): OpcoreTryScenario {
  if (!scenario || typeof scenario !== "object") {
    throw new Error("Opcore try scenario is required");
  }
  validateNonEmptyString(scenario.id, "Opcore try scenario id");
  validateNonEmptyString(scenario.repoRoot, "Opcore try scenario repoRoot");
  validateNonEmptyString(scenario.title, "Opcore try scenario title");
  validateStringArray(scenario.commands, "Opcore try scenario commands", { allowEmpty: false });
  if (!scenario.coverage || typeof scenario.coverage !== "object") {
    throw new Error("Opcore try scenario coverage is required");
  }
  validateNonNegativeInteger(scenario.coverage.totalFiles, "Opcore try scenario totalFiles");
  validateNonNegativeInteger(scenario.coverage.validationSupportedFiles, "Opcore try scenario validationSupportedFiles");
  validateNonNegativeInteger(scenario.coverage.unsupportedFiles, "Opcore try scenario unsupportedFiles");
  if (!Array.isArray(scenario.signals)) {
    throw new Error("Opcore try scenario signals must be an array");
  }
  for (const signal of scenario.signals) validateOpcoreTrySignal(signal);
  return scenario;
}

function validateOpcoreTrySignal(signal: OpcoreTrySignalSummary): OpcoreTrySignalSummary {
  if (!signal || typeof signal !== "object") {
    throw new Error("Opcore try signal is required");
  }
  validateNonEmptyString(signal.id, "Opcore try signal id");
  validateNonEmptyString(signal.title, "Opcore try signal title");
  validateNonNegativeInteger(signal.count, "Opcore try signal count");
  if (!Number.isInteger(signal.delta)) {
    throw new Error("Opcore try signal delta must be an integer");
  }
  return signal;
}

function validateOpcoreTryCommand(command: OpcoreTryCommandSummary): OpcoreTryCommandSummary {
  if (!command || typeof command !== "object") {
    throw new Error("Opcore try command is required");
  }
  validateNonEmptyString(command.scenarioId, "Opcore try command scenarioId");
  validateStringArray(command.command, "Opcore try command", { allowEmpty: false });
  validateStringArray(command.canonicalCommand, "Opcore try command canonicalCommand", { allowEmpty: false });
  validateCommandOwner(command.owner);
  validateCommandRouteStatus(command.status);
  validateExitCodeForStatus(command.exitCode, command.status);
  return command;
}

function validateOpcoreMetricCoverage(coverage: OpcoreRepoStatePayload["coverage"], label: string): void {
  if (!coverage || typeof coverage !== "object") {
    throw new Error(`${label} is required`);
  }
  validateNonNegativeInteger(coverage.totalFiles, `${label} totalFiles`);
  validateOpcoreCoverageLanguages(coverage.languages, label);
  validateOpcoreCoverageCounts(coverage.graph, "graph");
  validateOpcoreCoverageCounts(coverage.validation, "validation");
  validateNonNegativeInteger(coverage.validation.retainedFiles, `${label} validation retainedFiles`);
  validateOpcoreUnsupportedSection(coverage.unsupported, label);
}

function validateOpcoreCoverageLanguages(
  languages: OpcoreRepoStatePayload["coverage"]["languages"],
  label: string
): void {
  if (!Array.isArray(languages)) {
    throw new Error(`${label} languages must be an array`);
  }
  for (const language of languages) {
    validateNonEmptyString(language.language, `${label} language`);
    validateNonNegativeInteger(language.files, `${label} language files`);
    if (typeof language.graphSupported !== "boolean" || typeof language.validationSupported !== "boolean") {
      throw new Error(`${label} language support flags must be boolean`);
    }
  }
}

function validateOpcoreUnsupportedSection(
  unsupported: OpcoreRepoStatePayload["coverage"]["unsupported"],
  label: string
): void {
  if (!unsupported || typeof unsupported !== "object") {
    throw new Error(`${label} unsupported is required`);
  }
  validateNonNegativeInteger(unsupported.totalFiles, `${label} unsupported totalFiles`);
  validateOpcoreUnsupportedStacks(unsupported.stacks, label);
}

function validateOpcoreUnsupportedStacks(
  stacks: OpcoreRepoStatePayload["coverage"]["unsupported"]["stacks"],
  label: string
): void {
  if (!Array.isArray(stacks)) {
    throw new Error(`${label} unsupported stacks must be an array`);
  }
  for (const stack of stacks) {
    validateNonEmptyString(stack.extension, `${label} unsupported extension`);
    validateNonEmptyString(stack.language, `${label} unsupported language`);
    validateNonNegativeInteger(stack.count, `${label} unsupported count`);
    validateStringArray(stack.examples, `${label} unsupported examples`, { allowEmpty: true });
  }
}

function validateOpcoreMetricSignal(signal: OpcoreMetricSignal): OpcoreMetricSignal {
  if (!signal || typeof signal !== "object") {
    throw new Error("Opcore metric signal is required");
  }
  validateNonEmptyString(signal.id, "Opcore metric signal id");
  validateNonEmptyString(signal.title, "Opcore metric signal title");
  validateNonEmptyString(signal.category, "Opcore metric signal category");
  if (!includesString(["info", "warning", "error"] as const, signal.severity)) {
    throw new Error(`Unknown Opcore metric signal severity: ${String(signal.severity)}`);
  }
  if (!Number.isInteger(signal.count) || signal.count <= 0) {
    throw new Error("Opcore metric signal count must be a positive integer");
  }
  if (!Array.isArray(signal.evidence) || signal.evidence.length === 0) {
    throw new Error("Opcore metric signal evidence must be a non-empty array");
  }
  for (const evidence of signal.evidence) validateOpcoreMetricEvidence(evidence);
  return signal;
}

function validateOpcoreMetricEvidence(evidence: OpcoreMetricEvidence): OpcoreMetricEvidence {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Opcore metric evidence is required");
  }
  validateNonEmptyString(evidence.source, "Opcore metric evidence source");
  validateRepoRelativePath(validateNonEmptyString(evidence.path, "Opcore metric evidence path"));
  validateNonEmptyString(evidence.message, "Opcore metric evidence message");
  if (evidence.checkId !== undefined) validateValidationCheckId(evidence.checkId, "Opcore metric evidence checkId");
  if (evidence.code !== undefined) validateNonEmptyString(evidence.code, "Opcore metric evidence code");
  if (evidence.line !== undefined && (!Number.isInteger(evidence.line) || evidence.line < 1)) {
    throw new Error("Opcore metric evidence line must be a positive integer");
  }
  if (evidence.column !== undefined && (!Number.isInteger(evidence.column) || evidence.column < 1)) {
    throw new Error("Opcore metric evidence column must be a positive integer");
  }
  return evidence;
}

function validateOpcoreMetricDegradation(degradation: OpcoreMetricDegradation): OpcoreMetricDegradation {
  if (!degradation || typeof degradation !== "object") {
    throw new Error("Opcore metric degradation is required");
  }
  validateNonEmptyString(degradation.id, "Opcore metric degradation id");
  validateNonEmptyString(degradation.title, "Opcore metric degradation title");
  validateNonEmptyString(degradation.source, "Opcore metric degradation source");
  if (!includesString(["info", "warning", "error"] as const, degradation.severity)) {
    throw new Error(`Unknown Opcore metric degradation severity: ${String(degradation.severity)}`);
  }
  validateNonEmptyString(degradation.message, "Opcore metric degradation message");
  if (degradation.checkId !== undefined) validateValidationCheckId(degradation.checkId, "Opcore metric degradation checkId");
  if (degradation.requiredTool !== undefined) {
    validateNonEmptyString(degradation.requiredTool, "Opcore metric degradation requiredTool");
  }
  return degradation;
}

function validateOpcoreMeasureComparison(comparison: OpcoreMeasureComparison, label: string): OpcoreMeasureComparison {
  if (!comparison || typeof comparison !== "object") {
    throw new Error(`Opcore measure delta ${label} comparison is required`);
  }
  validateNonEmptyString(comparison.recordedAt, `Opcore measure delta ${label} recordedAt`);
  validateNonEmptyString(comparison.generatedAt, `Opcore measure delta ${label} generatedAt`);
  validateOpcoreMetricCoverage(comparison.coverage, `Opcore measure delta ${label} coverage`);
  validateOpcoreMeasureSignalCounts(comparison.signals, `Opcore measure delta ${label} signals`);
  if (!Array.isArray(comparison.deltas)) {
    throw new Error(`Opcore measure delta ${label} deltas must be an array`);
  }
  for (const entry of comparison.deltas) validateOpcoreMeasureSignalDelta(entry, label);
  return comparison;
}

function validateOpcoreMeasureSignalCounts(counts: readonly OpcoreMeasureSignalCount[], label: string): void {
  if (!Array.isArray(counts)) {
    throw new Error(`${label} must be an array`);
  }
  for (const count of counts) {
    if (!count || typeof count !== "object") {
      throw new Error(`${label} entry is required`);
    }
    validateNonEmptyString(count.id, `${label} id`);
    validateNonEmptyString(count.title, `${label} title`);
    validateNonNegativeInteger(count.count, `${label} count`);
  }
}

function validateOpcoreMeasureSignalDelta(delta: OpcoreMeasureSignalDelta, label: string): OpcoreMeasureSignalDelta {
  if (!delta || typeof delta !== "object") {
    throw new Error(`Opcore measure delta ${label} entry is required`);
  }
  validateNonEmptyString(delta.id, `Opcore measure delta ${label} id`);
  validateNonEmptyString(delta.title, `Opcore measure delta ${label} title`);
  validateNonNegativeInteger(delta.currentCount, `Opcore measure delta ${label} currentCount`);
  validateNonNegativeInteger(delta.comparisonCount, `Opcore measure delta ${label} comparisonCount`);
  if (!Number.isInteger(delta.delta)) {
    throw new Error(`Opcore measure delta ${label} delta must be an integer`);
  }
  return delta;
}

function assertNoOpaqueScoreFields(value: unknown, label: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoOpaqueScoreFields(entry, label);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "score" || key === "blendedScore") {
      throw new Error(`${label} must not include opaque score fields`);
    }
    assertNoOpaqueScoreFields(entry, label);
  }
}

function assertNoTelemetrySourceFields(value: unknown, label: string): void {
  const blockedKeys = new Set([
    "root",
    "requestedPath",
    "path",
    "paths",
    "examples",
    "content",
    "contents",
    "source",
    "secret",
    "secrets",
    "token",
    "tokens",
    "apiKey",
    "password"
  ]);
  visitTelemetryValue(value);

  function visitTelemetryValue(entry: unknown): void {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const item of entry) visitTelemetryValue(item);
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (blockedKeys.has(key)) {
        throw new Error(`${label} must remain source-safe and must not include ${key}`);
      }
      visitTelemetryValue(child);
    }
  }
}

function validateCommandTimingPhase(phase: CommandTimingPhase): CommandTimingPhase {
  if (!phase || typeof phase !== "object") {
    throw new Error("Command timing phase is required");
  }
  validateLatencyStableId(phase.phase, "Command timing phase");
  validateNonNegativeNumber(phase.durationMs, "Command timing phase durationMs");
  if (phase.fileCount !== undefined) validateNonNegativeInteger(phase.fileCount, "Command timing phase fileCount");
  return phase;
}

function validateLatencyPhaseBudget(phaseBudget: LatencyPhaseBudget): LatencyPhaseBudget {
  if (!phaseBudget || typeof phaseBudget !== "object") {
    throw new Error("Latency phase budget is required");
  }
  validateLatencyStableId(phaseBudget.phase, "Latency phase budget phase");
  validateNonNegativeNumber(phaseBudget.budgetMs, "Latency phase budget budgetMs");
  return phaseBudget;
}

function resolveLatencyAppliedBudgetMs(budget: LatencyBudget, phase: string): number {
  if (phase === "total") return budget.budgetMs;
  const phaseBudget = budget.phaseBudgets?.find((entry) => entry.phase === phase);
  if (!phaseBudget) {
    throw new Error("Latency budget result phase must match total or a configured phase budget");
  }
  return phaseBudget.budgetMs;
}

function validateLatencyStableId(value: unknown, label: string): string {
  const stableId = validateNonEmptyString(value, label);
  if (!latencyStableIdRegex.test(stableId)) {
    throw new Error(`${label} must be a stable latency id`);
  }
  return stableId;
}

function validateLatencyTelemetryCommandBin(value: unknown, label: string): CommandLatencyTelemetryBin {
  const bin = validateNonEmptyString(value, label);
  if (!includesString(commandLatencyTelemetryBins, bin)) {
    throw new Error(`${label} must be a source-safe command bin`);
  }
  return bin;
}

function validateLatencyCanonicalCommand(command: readonly string[], label: string): readonly string[] {
  const parts = validateStringArray(command, label, { allowEmpty: false });
  for (const [index, part] of parts.entries()) {
    validateLatencyCanonicalCommandToken(part, `${label} entry ${index}`);
  }
  return parts;
}

function validateLatencyCanonicalCommandToken(value: string, label: string): string {
  if (!latencyTelemetryCommandTokenRegex.test(value)) {
    throw new Error(`${label} must be a source-safe canonicalCommand token`);
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    value.startsWith("~") ||
    /^[A-Za-z]:/.test(value) ||
    /^file:/i.test(value) ||
    latencyTelemetrySourceFileExtensionRegex.test(value)
  ) {
    throw new Error(`${label} must be a source-safe canonicalCommand token`);
  }
  return value;
}

function validateOpcoreCoverageCounts(
  section:
    | OpcoreRepoStatePayload["coverage"]["graph"]
    | OpcoreRepoStatePayload["coverage"]["validation"],
  label: string
): void {
  if (!section || typeof section !== "object") {
    throw new Error(`Opcore repo state ${label} coverage is required`);
  }
  validateNonNegativeInteger(section.supportedFiles, `Opcore repo state ${label} supportedFiles`);
  if (!Array.isArray(section.extensions)) {
    throw new Error(`Opcore repo state ${label} extensions must be an array`);
  }
  for (const entry of section.extensions) {
    validateNonEmptyString(entry.extension, `Opcore repo state ${label} extension`);
    validateNonNegativeInteger(entry.count, `Opcore repo state ${label} count`);
  }
}

export function validateCommandAdapterRequest(request: CommandAdapterRequest): CommandAdapterRequest {
  if (!request || typeof request !== "object") {
    throw new Error("Command adapter request is required");
  }
  if (request.schemaVersion !== 1) {
    throw new Error("Command adapter request schemaVersion must be 1");
  }
  validateNonEmptyString(request.bin, "Command adapter request bin");
  validateStringArray(request.argv, "Command adapter request argv", { allowEmpty: true });
  validateStringArray(request.args, "Command adapter request args", { allowEmpty: true });
  if (typeof request.json !== "boolean") {
    throw new Error("Command adapter request json must be boolean");
  }
  if (!request.group || typeof request.group !== "object") {
    throw new Error("Command adapter request group is required");
  }
  validateManifestGroups([request.group]);
  validateStringArray(request.canonicalCommand, "Command adapter request canonicalCommand", { allowEmpty: false });
  if (!request.group.canonicalCommand.every((part, index) => request.canonicalCommand[index] === part)) {
    throw new Error("Command adapter request canonicalCommand must start with the group canonicalCommand");
  }
  return request;
}

export function validateGraphReferenceEvidenceManifest(manifest: GraphReferenceEvidenceManifest): GraphReferenceEvidenceManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Graph reference evidence manifest is required");
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("Graph reference evidence manifest schemaVersion must be 1");
  }
  if (manifest.issue !== "#19") {
    throw new Error("Graph reference evidence manifest issue must be #19");
  }
  if (manifest.origin !== "covibes-authored-synthetic") {
    throw new Error("Graph reference evidence manifest origin must be covibes-authored-synthetic");
  }

  validateStringArray(manifest.fixtureRefs, "Graph reference evidence manifest fixtureRefs", { allowEmpty: false });
  validateGraphReferenceEvidenceCommandSurfaces(manifest.commandSurfaces);
  validateGraphReferenceEvidenceJsonOutputSurfaces(manifest.jsonOutputSurfaces);
  validateGraphReferenceEvidenceSqliteFixtures(manifest.sqliteFixtures);
  validateGraphReferenceEvidenceDaemonFixtures(manifest.daemonFixtures);
  validateGraphReferenceEvidenceBaselineReceipts(manifest.baselineReceipts);
  validateGraphReferenceEvidenceOptionalSurfaces(manifest.optionalAnalysisSurfaces);
  validateGraphReferenceEvidenceGoldenCorpus(manifest.goldenCorpus);
  validateGraphReferenceEvidenceProvenance(manifest.provenance);
  validateGraphReferenceEvidenceSourceFreeStrings(manifest);

  return manifest;
}

export function validateGraphReleaseReceipt(receipt: GraphReleaseReceipt): GraphReleaseReceipt {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("Graph release receipt is required");
  }
  if (receipt.schemaVersion !== 1) {
    throw new Error("Graph release receipt schemaVersion must be 1");
  }
  if (receipt.issue !== "#17") {
    throw new Error("Graph release receipt issue must be #17");
  }
  if (receipt.origin !== "covibes-authored-synthetic") {
    throw new Error("Graph release receipt origin must be covibes-authored-synthetic");
  }

  validateNonEmptyString(receipt.generatedAt, "Graph release receipt generatedAt");
  validateNonEmptyString(receipt.commitSha, "Graph release receipt commitSha");
  if (receipt.graphProviderSchemaVersion !== 1) {
    throw new Error("Graph release receipt graphProviderSchemaVersion must be 1");
  }
  validateGraphReleasePackageVersions(receipt.graphPackageVersions);
  validateExactStringSet(receipt.requiredChildren, graphReleaseRequiredChildren, "Graph release required children");
  validateExactStringSet(receipt.deferredChildren, graphReleaseDeferredChildren, "Graph release deferred children");
  validateGraphReleaseCommandCoverage(receipt.commandCoverage);
  validateGraphReleaseDirectSqliteQueries(receipt.directSqliteQueries);
  validateGraphReleaseServeTransport(receipt.serveTransport);
  validateGraphReleaseBenchmarks(receipt.benchmarks);
  validateGraphReleasePackageInspection(receipt.packageInspection);
  validateExactStringSet(receipt.supportedNativeTargets, graphCoreNativeSupportedTargets, "Graph release supported native targets");
  validateGraphReleaseNativeArtifacts(receipt.nativeArtifacts);
  validateGraphReleaseReportReceipts(receipt.reportReceipts);
  validateGraphProviderArtifactMetadata(receipt.graphArtifact);
  validateGraphReleaseOptionalSurfaces(receipt.optionalSurfaces);
  validateGraphReleaseHandoff(receipt.handoff);
  validateGraphReleaseSourceFreeStrings(receipt);

  return receipt;
}

export function validateReleaseReceipt(receipt: ReleaseReceipt): ReleaseReceipt {
  if (!receipt || typeof receipt !== "object") throw new Error("Release receipt is required");
  if (receipt.schemaVersion !== 1) throw new Error("Release receipt schemaVersion must be 1");
  if (receipt.issue !== "#29") throw new Error("Release receipt issue must be #29");
  if (receipt.origin !== "covibes-authored-release-proof") {
    throw new Error("Release receipt origin must be covibes-authored-release-proof");
  }
  validateNonEmptyString(receipt.generatedAt, "Release receipt generatedAt");
  validateNonEmptyString(receipt.commitSha, "Release receipt commitSha");
  if (receipt.privateRepo !== true) throw new Error("Release receipt maintainer evidence marker must be true");
  validateExactStringSet(receipt.packageNames, releaseReceiptPackageNames, "Release receipt package names");
  validateExactStringSet(receipt.commandGroups, releaseReceiptCommandGroups, "Release receipt command groups");
  validateReleaseReceiptPackages(receipt.packages);
  validateReleaseReceiptDescriptor(receipt.descriptor, receipt.packages);
  validateReleaseReceiptNativeArtifacts(receipt.nativeArtifacts, receipt.packages, receipt.descriptor);
  validateReleaseReceiptLicense(receipt.license);
  validateReleaseReceiptProvenance(receipt.provenance);
  validateReleaseReceiptSecretHistory(receipt.secretHistory);
  validateReleaseReceiptReports(receipt.reports);
  validateReleaseReceiptGraphReleaseEvidence(receipt.graphReleaseReceipt);
  return receipt;
}

export function validateReleaseCutoverReceipt(receipt: ReleaseCutoverReceipt): ReleaseCutoverReceipt {
  if (!receipt || typeof receipt !== "object") throw new Error("Release cutover receipt is required");
  if (receipt.schemaVersion !== 1) throw new Error("Release cutover receipt schemaVersion must be 1");
  if (receipt.issue !== "#30") throw new Error("Release cutover receipt issue must be #30");
  if (receipt.origin !== "covibes-authored-cutover-proof") {
    throw new Error("Release cutover receipt origin must be covibes-authored-cutover-proof");
  }
  validateNonEmptyString(receipt.generatedAt, "Release cutover receipt generatedAt");
  validateNonEmptyString(receipt.commitSha, "Release cutover receipt commitSha");
  if (receipt.privateRepo !== true) throw new Error("Release cutover receipt maintainer evidence marker must be true");
  validateExactStringSet(receipt.packageNames, releaseReceiptPackageNames, "Release cutover receipt package names");
  validateReleaseCutoverInstalledPackages(receipt.installedPackages);
  validateReleaseCutoverDescriptor(receipt.descriptor);
  validateReleaseCutoverEnvironmentIsolation(receipt.environmentIsolation);
  validateReleaseCutoverCommandReceipts(receipt.commandReceipts);
  validateReleaseCutoverNegativeChecks(receipt.negativeChecks);
  validateReleaseCutoverForbiddenMarkerScan(receipt.forbiddenMarkerScan);
  validateReleaseCutoverInputEvidence(receipt.inputEvidence);
  return receipt;
}

export function validateAspDogfoodReceipt(receipt: AspDogfoodReceipt): AspDogfoodReceipt {
  if (!receipt || typeof receipt !== "object") throw new Error("ASP dogfood receipt is required");
  if (receipt.schemaVersion !== 1) throw new Error("ASP dogfood receipt schemaVersion must be 1");
  if (receipt.issue !== "#120") throw new Error("ASP dogfood receipt issue must be #120");
  if (receipt.origin !== "covibes-authored-asp-dogfood-proof") {
    throw new Error("ASP dogfood receipt origin must be covibes-authored-asp-dogfood-proof");
  }
  validateNonEmptyString(receipt.generatedAt, "ASP dogfood receipt generatedAt");
  validateNonEmptyString(receipt.commitSha, "ASP dogfood receipt commitSha");
  if (receipt.privateRepo !== true) throw new Error("ASP dogfood receipt privateRepo must be true");
  if (receipt.bootstrapSource !== "local-sibling") throw new Error("ASP dogfood bootstrapSource must be local-sibling");
  validateExactStringSet(receipt.packageNames, releaseReceiptPackageNames, "ASP dogfood receipt package names");
  validateReleaseCutoverInstalledPackages(receipt.installedPackages);
  validateAspDogfoodManager(receipt.manager);
  validateAspDogfoodAspHome(receipt.aspHome);
  validateAspDogfoodHostFixture(receipt.hostFixture);
  validateAspDogfoodProvider(receipt.provider);
  validateAspDogfoodManagerState(receipt.managerState);
  validateAspDogfoodRepoEnrollment(receipt.repoEnrollment);
  validateAspDogfoodHostEvaluation(receipt.hostEvaluation);
  validateAspDogfoodProviderProbe(receipt.providerProbe);
  validateAspDogfoodGuardrails(receipt.currentToolGuardrails);
  validateAspDogfoodUnsupportedSurfaces(receipt.unsupportedSurfaces);
  validateAspDogfoodParityBlockers(receipt.parityBlockers);
  validateAspDogfoodAuthority(receipt.authority);
  if (!Array.isArray(receipt.publicReleaseActions) || receipt.publicReleaseActions.length !== 0) {
    throw new Error("ASP dogfood receipt must not record public publish, registry, or standard-readiness actions");
  }
  if (receipt.oldToolReplacementClaimed !== false) throw new Error("ASP dogfood receipt must not claim old-tool replacement");
  validateAspDogfoodForbiddenMarkerScan(receipt.forbiddenMarkerScan);
  validateAspDogfoodForbiddenProviderEntrypoint(receipt);
  return receipt;
}

export function validateRepoRelativePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Repo-relative path must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new Error(`Repo-relative path contains a null byte: ${path}`);
  }
  if (/^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`Repo-relative path must not be absolute: ${path}`);
  }
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(`Repo-relative path must not escape the repository: ${path}`);
  }
  return normalized;
}

export function validateRepoIdentity(repo: RepoIdentity): RepoIdentity {
  if (!repo || typeof repo !== "object") {
    throw new Error("Repo identity is required");
  }
  if (repo.repoId && repo.repoRoot) {
    throw new Error("Repo identity is ambiguous: use repoId or repoRoot, not both");
  }
  if (!repo.repoId && !repo.repoRoot && !repo.remoteUrl) {
    throw new Error("Repo identity must include repoId, repoRoot, or remoteUrl");
  }
  return repo;
}

export function validateProviderStatus(status: GraphProviderStatus): GraphProviderStatus {
  if (!status || typeof status !== "object") {
    throw new Error("Graph provider status is required");
  }
  if (!includesString(graphProviderStatusStates, status.state)) {
    throw new Error(`Unknown graph provider status state: ${String(status.state)}`);
  }
  if (!includesString(graphProviderModes, status.mode)) {
    throw new Error(`Unknown graph provider mode: ${String(status.mode)}`);
  }
  if (typeof status.provider !== "string" || status.provider.length === 0) {
    throw new Error("Graph provider status must include provider");
  }
  if (typeof status.schemaVersion !== "number") {
    throw new Error("Graph provider status must include numeric schemaVersion");
  }
  if (status.state === "skipped" && status.mode !== "optional") {
    throw new Error("Skipped graph provider status must use optional mode");
  }
  if (status.state === "required_missing" && status.mode !== "required") {
    throw new Error("Required-missing graph provider status must use required mode");
  }
  if (status.state === "available") {
    validateRepoIdentity(status.repo);
    validateGraphFreshness(status.freshness, "Available");
    if (status.handshake !== undefined) validateGraphProviderCapabilityHandshake(status.handshake);
    if (status.walCheckpoint !== undefined) validateGraphWalCheckpointSummary(status.walCheckpoint);
    return status;
  }
  if (status.state === "warming") {
    validateRepoIdentity(status.repo);
    validateGraphFreshness(status.freshness, "Warming");
    if (status.lifecycle !== undefined) validateGraphWatchLifecycle(status.lifecycle);
    return status;
  }
  validateProviderFailureStatus(status);
  return status;
}

function validateProviderFailureStatus(status: GraphProviderFailureStatus): void {
  if (!status.failure?.category) {
    throw new Error(`Graph provider ${status.state} status must include failure.category`);
  }
  if (!includesString(providerFailureCategories, status.failure.category)) {
    throw new Error(`Unknown graph provider failure category: ${status.failure.category}`);
  }
  const allowedCategories = graphProviderFailureCategoriesByState[status.state];
  if (!includesString(allowedCategories, status.failure.category)) {
    throw new Error(
      `Graph provider ${status.state} failure category must be one of ${allowedCategories.join(", ")}; got ${status.failure.category}`
    );
  }
  if (status.state === "stale") {
    if (!status.repo) {
      throw new Error("Stale graph provider status must include repo");
    }
    validateRepoIdentity(status.repo);
    validateGraphFreshness(status.freshness, "Stale");
  }
  if (status.state === "schema_mismatch") {
    if (typeof status.expectedSchemaVersion !== "number") {
      throw new Error("Schema-mismatch graph provider status must include expectedSchemaVersion");
    }
    if (typeof status.actualSchemaVersion !== "number") {
      throw new Error("Schema-mismatch graph provider status must include actualSchemaVersion");
    }
  }
  if (status.state === "error" && status.diagnostics !== undefined) {
    validateGraphExtractionDiagnostics(status.diagnostics);
  }
}

export function validateGraphProviderArtifactMetadata(
  metadata: GraphProviderArtifactMetadata
): GraphProviderArtifactMetadata {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Graph provider artifact metadata is required");
  }
  for (const key of [
    "artifactName",
    "artifactVersion",
    "targetPlatform",
    "binaryPath",
    "checksumPath",
    "checksumSha256",
    "buildProfile"
  ] as const) {
    validateNonEmptyString(metadata[key], `Graph provider artifact metadata ${key}`);
  }
  for (const key of ["binaryPath", "checksumPath"] as const) {
    validateRepoRelativePath(metadata[key]);
    if (metadata[key].startsWith("packages/") || metadata[key].startsWith("../")) {
      throw new Error(`Graph provider artifact metadata ${key} must be package-relative`);
    }
  }
  return metadata;
}

export function validateGraphProviderCapabilityHandshake(
  handshake: GraphProviderCapabilityHandshake
): GraphProviderCapabilityHandshake {
  if (!handshake || typeof handshake !== "object") {
    throw new Error("Graph provider capability handshake is required");
  }
  validateNonEmptyString(handshake.provider, "Graph provider capability handshake provider");
  if (typeof handshake.graphSchemaVersion !== "number") {
    throw new Error("Graph provider capability handshake graphSchemaVersion must be numeric");
  }
  validateNonEmptyString(handshake.artifactName, "Graph provider capability handshake artifactName");
  validateNonEmptyString(handshake.artifactVersion, "Graph provider capability handshake artifactVersion");
  validateNonEmptyString(handshake.targetPlatform, "Graph provider capability handshake targetPlatform");
  validateStringArray(handshake.supportedOperations, "Graph provider capability handshake supportedOperations", {
    allowEmpty: false
  });
  for (const operation of handshake.supportedOperations) validateGraphDaemonOperation(operation);
  validateStringArray(handshake.nodeKinds, "Graph provider capability handshake nodeKinds", { allowEmpty: false });
  validateStringArray(handshake.edgeKinds, "Graph provider capability handshake edgeKinds", { allowEmpty: false });
  validateStringArray(handshake.queryKinds, "Graph provider capability handshake queryKinds", { allowEmpty: false });
  for (const queryKind of handshake.queryKinds) validateGraphProviderQueryKind(queryKind);
  validateGraphProviderArtifactMetadata(handshake.artifact);
  if (handshake.artifact.artifactName !== handshake.artifactName) {
    throw new Error("Graph provider capability handshake artifactName must match artifact metadata");
  }
  if (handshake.artifact.targetPlatform !== handshake.targetPlatform) {
    throw new Error("Graph provider capability handshake targetPlatform must match artifact metadata");
  }
  return handshake;
}

export function validateGraphFactQueryRequest(request: GraphFactQueryRequest): GraphFactQueryRequest {
  if (!request || typeof request !== "object") {
    throw new Error("Graph fact query request is required");
  }
  if (request.requestId !== undefined) validateNonEmptyString(request.requestId, "Graph fact query request requestId");
  validateRepoIdentity(request.repo);
  if (request.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(`Graph fact query request schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  }
  if (!includesString(graphProviderModes, request.mode)) {
    throw new Error(`Unknown graph fact query request mode: ${String(request.mode)}`);
  }
  if (!request.selector || typeof request.selector !== "object") {
    throw new Error("Graph fact query request selector is required");
  }
  validateGraphFactQueryKind(request.selector.kind);
  if (request.selector.nodeKinds !== undefined) {
    validateStringArray(request.selector.nodeKinds, "Graph fact query selector nodeKinds", { allowEmpty: true });
  }
  if (request.selector.edgeKinds !== undefined) {
    validateStringArray(request.selector.edgeKinds, "Graph fact query selector edgeKinds", { allowEmpty: true });
  }
  if (request.selector.ids !== undefined) {
    validateStringArray(request.selector.ids, "Graph fact query selector ids", { allowEmpty: true });
  }
  if (request.selector.limit !== undefined && (typeof request.selector.limit !== "number" || request.selector.limit < 1)) {
    throw new Error("Graph fact query selector limit must be a positive number");
  }
  return request;
}

export function validateGraphFactQueryResult(result: GraphFactQueryResult): GraphFactQueryResult {
  if (!result || typeof result !== "object") {
    throw new Error("Graph fact query result is required");
  }
  if (result.requestId !== undefined) validateNonEmptyString(result.requestId, "Graph fact query result requestId");
  const status = validateProviderStatus(result.status);
  const payload = result as {
    metadata?: unknown;
    nodes?: unknown;
    edges?: unknown;
    diagnostics?: unknown;
  };
  const hasGraphData =
    Object.hasOwn(payload, "metadata") || Object.hasOwn(payload, "nodes") || Object.hasOwn(payload, "edges");
  if (status.state !== "available") {
    if (hasGraphData) {
      throw new Error(`Graph query ${status.state} result must not include graph data`);
    }
    return result;
  }
  if (!payload.metadata || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    throw new Error("Available graph query result must include metadata, nodes, and edges");
  }
  validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
  for (const node of payload.nodes) validateGraphFactNode(node as GraphFactNode);
  for (const edge of payload.edges) validateGraphFactEdge(edge as GraphFactEdge);
  if (payload.diagnostics !== undefined) {
    validateGraphExtractionDiagnostics(payload.diagnostics as readonly GraphExtractionDiagnostic[]);
  }
  return result;
}

export function validateGraphNamedQueryRequest(request: GraphNamedQueryRequest): GraphNamedQueryRequest {
  validateGraphQueryRequestBase(request, "Graph named query request");
  validateGraphNamedQueryKind(request.queryKind);
  validateNonEmptyString(request.target, "Graph named query request target");
  validateTraversalOptions(request.maxDepth, request.limit, "Graph named query request");
  return request;
}

export function validateGraphNamedQueryResult(result: GraphNamedQueryResult): GraphNamedQueryResult {
  validateGraphPayloadResult(result, "Graph named query result", (payload) => {
    validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
    validateGraphNamedQueryKind(payload.queryKind);
    validateNonEmptyString(payload.target, "Graph named query result target");
    for (const node of payload.nodes as readonly GraphFactNode[]) validateGraphFactNode(node);
    for (const edge of payload.edges as readonly GraphFactEdge[]) validateGraphFactEdge(edge);
    validateGraphTraversalMetadata(payload.traversal as GraphTraversalMetadata);
  });
  return result;
}

export function validateGraphImpactRequest(request: GraphImpactRequest): GraphImpactRequest {
  validateGraphQueryRequestBase(request, "Graph impact request");
  validateStringArray(request.files, "Graph impact request files", { allowEmpty: false });
  for (const file of request.files) validateRepoRelativePath(file);
  if (request.baseRef !== undefined) validateNonEmptyString(request.baseRef, "Graph impact request baseRef");
  validateTraversalOptions(request.maxDepth, request.limit, "Graph impact request");
  return request;
}

export function validateGraphImpactResult(result: GraphImpactResult): GraphImpactResult {
  validateGraphPayloadResult(result, "Graph impact result", (payload) => {
    validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
    validateRepoRelativePaths(payload.changedFiles, "Graph impact result changedFiles");
    validateRepoRelativePaths(payload.impactedFiles, "Graph impact result impactedFiles");
    validateStringArray(payload.impactedSymbols as readonly string[], "Graph impact result impactedSymbols", { allowEmpty: true });
    validateRepoRelativePaths(payload.tests, "Graph impact result tests");
    for (const node of payload.nodes as readonly GraphFactNode[]) validateGraphFactNode(node);
    for (const edge of payload.edges as readonly GraphFactEdge[]) validateGraphFactEdge(edge);
    validateGraphTraversalMetadata(payload.traversal as GraphTraversalMetadata);
  });
  return result;
}

export function validateGraphDetectChangesRequest(request: GraphDetectChangesRequest): GraphDetectChangesRequest {
  validateGraphQueryRequestBase(request, "Graph detect-changes request");
  if (request.files !== undefined) validateRepoRelativePaths(request.files, "Graph detect-changes request files");
  if (request.baseRef !== undefined) validateNonEmptyString(request.baseRef, "Graph detect-changes request baseRef");
  return request;
}

export function validateGraphDetectChangesResult(result: GraphDetectChangesResult): GraphDetectChangesResult {
  validateGraphPayloadResult(result, "Graph detect-changes result", (payload) => {
    validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
    validateRepoRelativePaths(payload.changedFiles, "Graph detect-changes result changedFiles");
    validateRepoRelativePaths(payload.deletedFiles, "Graph detect-changes result deletedFiles");
    validateRenamedFiles(payload.renamedFiles as readonly GraphRenamedFile[]);
  });
  return result;
}

export function validateGraphReviewContextRequest(request: GraphReviewContextRequest): GraphReviewContextRequest {
  validateGraphQueryRequestBase(request, "Graph review-context request");
  if (request.files !== undefined) validateRepoRelativePaths(request.files, "Graph review-context request files");
  if (request.baseRef !== undefined) validateNonEmptyString(request.baseRef, "Graph review-context request baseRef");
  validateTraversalOptions(request.maxDepth, request.limit, "Graph review-context request");
  return request;
}

export function validateGraphReviewContextResult(result: GraphReviewContextResult): GraphReviewContextResult {
  validateGraphPayloadResult(result, "Graph review-context result", (payload) => {
    validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
    validateRepoRelativePaths(payload.changedFiles, "Graph review-context result changedFiles");
    validateRepoRelativePaths(payload.deletedFiles, "Graph review-context result deletedFiles");
    validateRenamedFiles(payload.renamedFiles as readonly GraphRenamedFile[]);
    validateRepoRelativePaths(payload.impactedFiles, "Graph review-context result impactedFiles");
    validateStringArray(payload.impactedSymbols as readonly string[], "Graph review-context result impactedSymbols", { allowEmpty: true });
    validateRepoRelativePaths(payload.tests, "Graph review-context result tests");
    for (const node of payload.nodes as readonly GraphFactNode[]) validateGraphFactNode(node);
    for (const edge of payload.edges as readonly GraphFactEdge[]) validateGraphFactEdge(edge);
    validateGraphTraversalMetadata(payload.traversal as GraphTraversalMetadata);
  });
  return result;
}

export function validateGraphSearchRequest(request: GraphSearchRequest): GraphSearchRequest {
  validateGraphQueryRequestBase(request, "Graph search request");
  validateNonEmptyString(request.query, "Graph search request query");
  if (request.query.trim().length === 0) throw new Error("Graph search request query must not be empty");
  if (request.limit !== undefined && (!Number.isFinite(request.limit) || request.limit < 1)) {
    throw new Error("Graph search request limit must be a positive number");
  }
  if (request.files !== undefined) validateRepoRelativePaths(request.files, "Graph search request files");
  return request;
}

export function validateGraphSearchResult(result: GraphSearchResult): GraphSearchResult {
  if (!result || typeof result !== "object") throw new Error("Graph search result is required");
  if (result.requestId !== undefined) validateNonEmptyString(result.requestId, "Graph search result requestId");
  const status = validateProviderStatus(result.status);
  const payload = result as {
    metadata?: unknown;
    query?: unknown;
    searchMode?: unknown;
    summary?: unknown;
    results?: unknown;
    hints?: unknown;
    diagnostics?: unknown;
  };
  const hasSearchData =
    Object.hasOwn(payload, "metadata") ||
    Object.hasOwn(payload, "query") ||
    Object.hasOwn(payload, "searchMode") ||
    Object.hasOwn(payload, "summary") ||
    Object.hasOwn(payload, "results");
  if (status.state !== "available") {
    if (hasSearchData) throw new Error(`Graph search ${status.state} result must not include search data`);
    if (payload.hints !== undefined) validateStringArray(payload.hints as readonly string[], "Graph search result hints", { allowEmpty: true });
    if (payload.diagnostics !== undefined) validateGraphExtractionDiagnostics(payload.diagnostics as readonly GraphExtractionDiagnostic[]);
    return result;
  }
  if (!payload.metadata || typeof payload.query !== "string" || !payload.searchMode || !payload.summary || !Array.isArray(payload.results)) {
    throw new Error("Available graph search result must include metadata, query, searchMode, summary, and results");
  }
  validateGraphSnapshotMetadata(payload.metadata as GraphSnapshotMetadata);
  validateNonEmptyString(payload.query, "Graph search result query");
  validateGraphSearchMode(payload.searchMode as GraphSearchMode);
  validateGraphSearchSummary(payload.summary as GraphSearchSummary);
  for (const entry of payload.results as readonly GraphSearchResultEntry[]) validateGraphSearchResultEntry(entry);
  if (payload.hints !== undefined) validateStringArray(payload.hints as readonly string[], "Graph search result hints", { allowEmpty: true });
  if (payload.diagnostics !== undefined) validateGraphExtractionDiagnostics(payload.diagnostics as readonly GraphExtractionDiagnostic[]);
  return result;
}

export function validateInspectRouteResult(result: InspectRouteResult): InspectRouteResult {
  if (!result || typeof result !== "object") throw new Error("Inspect route result is required");
  const route = validateInspectRouteName((result as { route?: unknown }).route);
  if (!includesString(["ok", "error", "degraded"] as const, result.status)) {
    throw new Error(`Unknown inspect route result status: ${String((result as { status?: unknown }).status)}`);
  }
  if (result.providerStatus !== undefined) validateProviderStatus(result.providerStatus);
  if (result.status === "ok") {
    validateInspectSymbolTarget(result.target, `Inspect ${route} target`);
    if (result.providerStatus === undefined || result.providerStatus.state !== "available") {
      throw new Error(`Successful inspect ${route} result requires available providerStatus`);
    }
    validateInspectRoutePayload(result, route);
    if (Object.hasOwn(result, "failure")) throw new Error(`Successful inspect ${route} result must not include failure`);
  } else {
    if (result.target !== undefined) validateInspectSymbolTarget(result.target, `Inspect ${route} target`);
    validateInspectRouteFailure(result.failure);
    for (const field of ["references", "signatures", "implementations"] as const) {
      if (Object.hasOwn(result, field)) throw new Error(`Failed inspect ${route} result must not include ${field}`);
    }
  }
  return result;
}

export function validateGraphDaemonRequest(request: GraphDaemonRequest): GraphDaemonRequest {
  if (!request || typeof request !== "object") {
    throw new Error("Graph daemon request is required");
  }
  if (request.protocol !== "lattice.graph.daemon") {
    throw new Error("Graph daemon request protocol must be lattice.graph.daemon");
  }
  validateNonEmptyString(request.requestId, "Graph daemon request requestId");
  if (request.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(`Graph daemon request schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  }
  validateGraphDaemonOperation(request.operation);
  validateRepoIdentity(request.repo);
  if (request.query !== undefined) validateGraphFactQueryRequest(request.query);
  if (request.namedQuery !== undefined) validateGraphNamedQueryRequest(request.namedQuery);
  if (request.impact !== undefined) validateGraphImpactRequest(request.impact);
  if (request.reviewContext !== undefined) validateGraphReviewContextRequest(request.reviewContext);
  if (request.changes !== undefined) validateGraphDetectChangesRequest(request.changes);
  if (request.search !== undefined) validateGraphSearchRequest(request.search);
  if (request.operation === "query" && request.query === undefined) {
    const hasQueryEnvelope =
      request.namedQuery !== undefined ||
      request.impact !== undefined ||
      request.reviewContext !== undefined ||
      request.changes !== undefined ||
      request.search !== undefined;
    if (!hasQueryEnvelope) throw new Error("Graph daemon query request must include query");
  }
  if (request.baseRef !== undefined) validateNonEmptyString(request.baseRef, "Graph daemon request baseRef");
  if (request.paths !== undefined) {
    validateStringArray(request.paths, "Graph daemon request paths", { allowEmpty: true });
    for (const path of request.paths) validateRepoRelativePath(path);
  }
  if (request.watchPaths !== undefined) {
    validateStringArray(request.watchPaths, "Graph daemon request watchPaths", { allowEmpty: true });
    for (const path of request.watchPaths) validateRepoRelativePath(path);
  }
  if (
    request.pollIntervalMs !== undefined &&
    (!Number.isFinite(request.pollIntervalMs) || request.pollIntervalMs < 1)
  ) {
    throw new Error("Graph daemon request pollIntervalMs must be positive");
  }
  if (
    request.idleTimeoutMs !== undefined &&
    (!Number.isFinite(request.idleTimeoutMs) || request.idleTimeoutMs < 0)
  ) {
    throw new Error("Graph daemon request idleTimeoutMs must be a non-negative number");
  }
  if (request.once !== undefined && typeof request.once !== "boolean") {
    throw new Error("Graph daemon request once must be boolean");
  }
  if (request.maxWalBytes !== undefined && (!Number.isFinite(request.maxWalBytes) || request.maxWalBytes < 1)) {
    throw new Error("Graph daemon request maxWalBytes must be positive");
  }
  return request;
}

export function validateGraphDaemonResponse(response: GraphDaemonResponse): GraphDaemonResponse {
  if (!response || typeof response !== "object") {
    throw new Error("Graph daemon response is required");
  }
  if (response.protocol !== "lattice.graph.daemon") {
    throw new Error("Graph daemon response protocol must be lattice.graph.daemon");
  }
  validateNonEmptyString(response.requestId, "Graph daemon response requestId");
  if (response.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(`Graph daemon response schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  }
  validateProviderStatus(response.status);
  if (response.result !== undefined) validateGraphFactQueryResult(response.result);
  if (response.namedQuery !== undefined) validateGraphNamedQueryResult(response.namedQuery);
  if (response.impact !== undefined) validateGraphImpactResult(response.impact);
  if (response.reviewContext !== undefined) validateGraphReviewContextResult(response.reviewContext);
  if (response.changes !== undefined) validateGraphDetectChangesResult(response.changes);
  if (response.search !== undefined) validateGraphSearchResult(response.search);
  if (response.pipeline !== undefined) validateGraphPipelineResult(response.pipeline);
  if (response.lifecycle !== undefined) validateGraphWatchLifecycle(response.lifecycle);
  return response;
}

export function validateGraphPipelineResult(result: GraphPipelineResult): GraphPipelineResult {
  if (!result || typeof result !== "object") {
    throw new Error("Graph pipeline result is required");
  }
  validateGraphPipelineSummary(result.summary);
  validateProviderStatus(result.status);
  if (result.lifecycle !== undefined) validateGraphWatchLifecycle(result.lifecycle);
  return result;
}

export function validateGraphPipelineSummary(summary: GraphPipelineSummary): GraphPipelineSummary {
  if (!summary || typeof summary !== "object") {
    throw new Error("Graph pipeline summary is required");
  }
  if (!["build", "update", "watch"].includes(summary.operation)) {
    throw new Error(`Unknown graph pipeline operation: ${String(summary.operation)}`);
  }
  validateRepoIdentity(summary.repo);
  if (summary.storePath !== undefined) validateNonEmptyString(summary.storePath, "Graph pipeline summary storePath");
  validateNonEmptyString(summary.startedAt, "Graph pipeline summary startedAt");
  validateNonEmptyString(summary.completedAt, "Graph pipeline summary completedAt");
  for (const key of ["durationMs", "discoveredFiles", "parsedFiles", "unchangedFiles", "diagnosticsCount"] as const) {
    if (typeof summary[key] !== "number" || summary[key] < 0) {
      throw new Error(`Graph pipeline summary ${key} must be a non-negative number`);
    }
  }
  validateStringArray(summary.changedFiles, "Graph pipeline summary changedFiles", { allowEmpty: true });
  validateStringArray(summary.deletedFiles, "Graph pipeline summary deletedFiles", { allowEmpty: true });
  for (const path of summary.changedFiles) validateRepoRelativePath(path);
  for (const path of summary.deletedFiles) validateRepoRelativePath(path);
  if (typeof summary.fullRebuildRequired !== "boolean") {
    throw new Error("Graph pipeline summary fullRebuildRequired must be boolean");
  }
  if (!Array.isArray(summary.phaseTimings) || summary.phaseTimings.length === 0) {
    throw new Error("Graph pipeline summary phaseTimings must be non-empty");
  }
  for (const timing of summary.phaseTimings) validateGraphPipelinePhaseTiming(timing);
  if (summary.baseRef !== undefined) validateNonEmptyString(summary.baseRef, "Graph pipeline summary baseRef");
  if (summary.watchPaths !== undefined) {
    validateStringArray(summary.watchPaths, "Graph pipeline summary watchPaths", { allowEmpty: true });
    for (const path of summary.watchPaths) validateRepoRelativePath(path);
  }
  if (summary.walCheckpoint !== undefined) validateGraphWalCheckpointSummary(summary.walCheckpoint);
  return summary;
}

function validateGraphPipelinePhaseTiming(timing: GraphPipelinePhaseTiming): GraphPipelinePhaseTiming {
  if (!timing || typeof timing !== "object") {
    throw new Error("Graph pipeline phase timing is required");
  }
  validateNonEmptyString(timing.phase, "Graph pipeline phase timing phase");
  validateNonEmptyString(timing.startedAt, "Graph pipeline phase timing startedAt");
  validateNonEmptyString(timing.completedAt, "Graph pipeline phase timing completedAt");
  if (typeof timing.durationMs !== "number" || timing.durationMs < 0) {
    throw new Error("Graph pipeline phase timing durationMs must be non-negative");
  }
  if (timing.fileCount !== undefined && (typeof timing.fileCount !== "number" || timing.fileCount < 0)) {
    throw new Error("Graph pipeline phase timing fileCount must be non-negative");
  }
  return timing;
}

function validateGraphWalCheckpointSummary(summary: GraphWalCheckpointSummary): GraphWalCheckpointSummary {
  validateNonEmptyString(summary.walPath, "Graph WAL checkpoint walPath");
  for (const key of ["bytesBefore", "bytesAfter", "budgetBytes"] as const) {
    if (typeof summary[key] !== "number" || summary[key] < 0) {
      throw new Error(`Graph WAL checkpoint ${key} must be non-negative`);
    }
  }
  if (typeof summary.checkpointed !== "boolean") {
    throw new Error("Graph WAL checkpoint checkpointed must be boolean");
  }
  return summary;
}

export function validateGraphWatchLifecycle(lifecycle: GraphWatchLifecycle): GraphWatchLifecycle {
  if (!lifecycle || typeof lifecycle !== "object") {
    throw new Error("Graph watch lifecycle is required");
  }
  if (!["warming", "available", "error", "stopped"].includes(lifecycle.state)) {
    throw new Error(`Unknown graph watch lifecycle state: ${String(lifecycle.state)}`);
  }
  if (lifecycle.pid !== undefined && (!Number.isInteger(lifecycle.pid) || lifecycle.pid < 1)) {
    throw new Error("Graph watch lifecycle pid must be positive");
  }
  validateNonEmptyString(lifecycle.startedAt, "Graph watch lifecycle startedAt");
  validateNonEmptyString(lifecycle.updatedAt, "Graph watch lifecycle updatedAt");
  validateNonEmptyString(lifecycle.pidPath, "Graph watch lifecycle pidPath");
  validateNonEmptyString(lifecycle.statePath, "Graph watch lifecycle statePath");
  validateNonEmptyString(lifecycle.logPath, "Graph watch lifecycle logPath");
  if (typeof lifecycle.pollIntervalMs !== "number" || lifecycle.pollIntervalMs < 1) {
    throw new Error("Graph watch lifecycle pollIntervalMs must be positive");
  }
  if (
    typeof lifecycle.idleTimeoutMs !== "number" ||
    !Number.isFinite(lifecycle.idleTimeoutMs) ||
    lifecycle.idleTimeoutMs < 0
  ) {
    throw new Error("Graph watch lifecycle idleTimeoutMs must be a non-negative number");
  }
  if (lifecycle.watchPaths !== undefined) {
    validateStringArray(lifecycle.watchPaths, "Graph watch lifecycle watchPaths", { allowEmpty: true });
    for (const path of lifecycle.watchPaths) validateRepoRelativePath(path);
  }
  if (lifecycle.message !== undefined) validateNonEmptyString(lifecycle.message, "Graph watch lifecycle message");
  return lifecycle;
}

export function validateGraphServeTransportStatus(status: GraphServeTransportStatus): GraphServeTransportStatus {
  if (!status || typeof status !== "object") {
    throw new Error("Graph serve transport status is required");
  }
  if (status.schemaVersion !== 1) {
    throw new Error("Graph serve transport status schemaVersion must be 1");
  }
  if (status.protocol !== "lattice.graph.daemon") {
    throw new Error("Graph serve transport status protocol must be lattice.graph.daemon");
  }
  if (status.transport !== "stdio") {
    throw new Error("Graph serve transport status transport must be stdio");
  }
  if (!includesString(["ready", "error", "stopped"] as const, status.state)) {
    throw new Error(`Unknown graph serve transport state: ${String(status.state)}`);
  }
  validateRepoIdentity(status.repo);
  validateNonEmptyString(status.provider, "Graph serve transport status provider");
  if (status.pid !== undefined && (!Number.isInteger(status.pid) || status.pid < 1)) {
    throw new Error("Graph serve transport status pid must be positive");
  }
  if (status.artifact !== undefined) validateGraphProviderArtifactMetadata(status.artifact);
  if (status.failure !== undefined) validateProviderFailure(status.failure);
  if (status.state === "error" && status.failure === undefined) {
    throw new Error("Graph serve transport error status must include failure");
  }
  if (status.message !== undefined) validateNonEmptyString(status.message, "Graph serve transport status message");
  return status;
}

export function validateValidationRequestPayload(request: ValidationRequest): ValidationRequest {
  if (!request || typeof request !== "object") {
    throw new Error("Validation request is required");
  }
  if (request.requestId !== undefined) validateNonEmptyString(request.requestId, "Validation request requestId");
  validateRepoIdentity(request.repo);
  validateValidationScope(request.scope);
  validateValidationGraphConfig(request.graph);
  validateHypotheticalOverlays(request.overlays);
  if (request.checks !== undefined) validateValidationChecks(request.checks, "Validation request checks");
  return request;
}

export function validateValidationResultPayload(result: ValidationResult): ValidationResult {
  if (!result || typeof result !== "object") {
    throw new Error("Validation result is required");
  }
  if (typeof result.ok !== "boolean") {
    throw new Error("Validation result ok must be boolean");
  }
  if (!includesString(validationResultStatuses, result.status)) {
    throw new Error(`Unknown validation result status: ${String(result.status)}`);
  }
  if (result.status === "passed" && !result.ok) {
    throw new Error("Validation passed result must use ok=true");
  }
  if (result.ok && result.status !== "passed") {
    throw new Error("Validation result ok=true must use passed status");
  }
  validateValidationDiagnostics(result.diagnostics);
  if (result.graphStatus !== undefined) validateProviderStatus(result.graphStatus);
  if (result.failure !== undefined) validateValidationFailure(result.failure);
  if (result.refusal !== undefined) validateEditRefusal(result.refusal);
  if (result.status === "refused" && result.refusal === undefined) {
    throw new Error("Validation refused result must include refusal");
  }
  if (result.status === "refused" && result.failure !== undefined) {
    throw new Error("Validation refused result must not include failure");
  }
  if (includesString(validationFailureCategories, result.status) && result.failure === undefined) {
    throw new Error(`Validation ${result.status} result must include failure`);
  }
  if (includesString(validationFailureCategories, result.status)) {
    if (result.failure?.category !== result.status) {
      throw new Error("Validation failure category must match result status");
    }
    if (result.refusal !== undefined) {
      throw new Error("Validation failure result must not include refusal");
    }
  }
  if (result.status === "passed" && (result.failure !== undefined || result.refusal !== undefined)) {
    throw new Error("Validation passed result must not include failure or refusal");
  }
  if (result.manifest !== undefined) {
    validateValidationResultManifest(result.manifest);
  }
  return result;
}

export function validatePreWriteValidationReceipt(receipt: PreWriteValidationReceipt): PreWriteValidationReceipt {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("Pre-write validation receipt is required");
  }
  if (receipt.schemaVersion !== 1) {
    throw new Error("Pre-write validation receipt schemaVersion must be 1");
  }
  if (receipt.kind !== "pre_write_validation") {
    throw new Error("Pre-write validation receipt kind must be pre_write_validation");
  }
  if (receipt.route !== "validate.pre-write") {
    throw new Error("Pre-write validation receipt route must be validate.pre-write");
  }
  validateStringArray(receipt.canonicalCommand, "Pre-write validation receipt canonicalCommand", { allowEmpty: false });
  validateNonEmptyString(receipt.generatedAt, "Pre-write validation receipt generatedAt");
  validateNonNegativeNumber(receipt.durationMs, "Pre-write validation receipt durationMs");
  if (!Number.isInteger(receipt.timeoutMs) || receipt.timeoutMs < 1) {
    throw new Error("Pre-write validation receipt timeoutMs must be a positive integer");
  }
  if (typeof receipt.ok !== "boolean") {
    throw new Error("Pre-write validation receipt ok must be boolean");
  }
  if (receipt.requestId !== undefined) validateNonEmptyString(receipt.requestId, "Pre-write validation receipt requestId");
  if (receipt.repo !== undefined) validateRepoIdentity(receipt.repo);
  if (receipt.scope !== undefined) validateValidationScope(receipt.scope);
  if (receipt.checks !== undefined) validateValidationChecks(receipt.checks, "Pre-write validation receipt checks");
  if (receipt.graph !== undefined) validatePreWriteValidationGraph(receipt.graph);
  if (receipt.overlays !== undefined) validatePreWriteValidationOverlaySummary(receipt.overlays);
  if (!includesString(validationResultStatuses, receipt.validationStatus)) {
    throw new Error(`Unknown pre-write validation receipt status: ${String(receipt.validationStatus)}`);
  }
  if (!Number.isInteger(receipt.diagnosticCount) || receipt.diagnosticCount < 0) {
    throw new Error("Pre-write validation receipt diagnosticCount must be a non-negative integer");
  }
  if (receipt.failureSummary !== undefined) validatePreWriteValidationFailureSummary(receipt.failureSummary);
  if (receipt.ok) {
    if (receipt.validationStatus !== "passed") {
      throw new Error("Pre-write validation pass receipt must use passed validationStatus");
    }
    if (
      receipt.repo === undefined ||
      receipt.scope === undefined ||
      receipt.checks === undefined ||
      receipt.graph === undefined ||
      receipt.overlays === undefined
    ) {
      throw new Error("Pre-write validation pass receipt must include repo, scope, checks, graph, and overlays");
    }
    if (receipt.failureSummary !== undefined) {
      throw new Error("Pre-write validation pass receipt must not include failureSummary");
    }
  } else {
    if (receipt.validationStatus === "passed") {
      throw new Error("Pre-write validation failure receipt must not use passed validationStatus");
    }
    if (receipt.failureSummary === undefined) {
      throw new Error("Pre-write validation failure receipt must include failureSummary");
    }
  }
  return receipt;
}

export function validateValidationStatusPayload(payload: ValidationStatusPayload): ValidationStatusPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Validation status payload is required");
  }
  if (payload.schemaVersion !== 1) {
    throw new Error("Validation status payload schemaVersion must be 1");
  }
  if (typeof payload.ready !== "boolean") {
    throw new Error("Validation status payload ready must be boolean");
  }
  validateNonEmptyString(payload.generatedAt, "Validation status payload generatedAt");
  if (!payload.adapterRegistry || typeof payload.adapterRegistry !== "object") {
    throw new Error("Validation status payload adapterRegistry is required");
  }
  validateExactStringSet(
    payload.adapterRegistry.checkRoutes,
    ["files", "staged", "changed", "tree", "all", "manifest"],
    "Validation status payload checkRoutes"
  );
  validateExactStringSet(
    payload.adapterRegistry.validateRoutes,
    ["request", "hypothetical", "pre-write", "manifest"],
    "Validation status payload validateRoutes"
  );
  validateValidationChecks(payload.adapterRegistry.checkIds, "Validation status payload checkIds");
  if (!Array.isArray(payload.adapterRegistry.entries)) {
    throw new Error("Validation status payload entries must be an array");
  }
  for (const entry of payload.adapterRegistry.entries) validateValidationCheckManifestEntry(entry);
  if (payload.adapterRegistry.adapters !== undefined) {
    if (!Array.isArray(payload.adapterRegistry.adapters)) {
      throw new Error("Validation status payload adapters must be an array");
    }
    for (const adapter of payload.adapterRegistry.adapters) validateValidationAdapterRuntimeStatus(adapter);
  }
  if (!payload.graph || typeof payload.graph !== "object") {
    throw new Error("Validation status payload graph is required");
  }
  if (!includesString(graphProviderModes, payload.graph.mode)) {
    throw new Error(`Unknown validation status graph mode: ${String(payload.graph.mode)}`);
  }
  const graphStatus = validateProviderStatus(payload.graph.status);
  if (graphStatus.mode !== payload.graph.mode) {
    throw new Error("Validation status graph status mode must match graph mode");
  }
  if (payload.daemon !== undefined) {
    if (!payload.daemon || typeof payload.daemon !== "object") {
      throw new Error("Validation status daemon must be an object");
    }
    if (!includesString(validationDaemonReadinessStates, payload.daemon.state)) {
      throw new Error(`Unknown validation daemon readiness state: ${String(payload.daemon.state)}`);
    }
    if (payload.daemon.message !== undefined) validateNonEmptyString(payload.daemon.message, "Validation status daemon message");
  }
  return payload;
}

function validateValidationAdapterRuntimeStatus(status: ValidationAdapterRuntimeStatus): ValidationAdapterRuntimeStatus {
  if (!status || typeof status !== "object") {
    throw new Error("Validation adapter runtime status is required");
  }
  validateNonEmptyString(status.adapter, "Validation adapter runtime status adapter");
  if (!includesString(validationAdapterRuntimeStates, status.status)) {
    throw new Error(`Unknown validation adapter runtime status: ${String(status.status)}`);
  }
  validateValidationChecks(status.checkIds, "Validation adapter runtime status checkIds");
  if (status.toolchain !== undefined) {
    if (!Array.isArray(status.toolchain)) {
      throw new Error("Validation adapter runtime status toolchain must be an array");
    }
    for (const tool of status.toolchain) validateValidationAdapterToolchainStatus(tool);
  }
  if (status.degradedChecks !== undefined) {
    if (!Array.isArray(status.degradedChecks)) {
      throw new Error("Validation adapter runtime status degradedChecks must be an array");
    }
    for (const degradedCheck of status.degradedChecks) validateValidationAdapterDegradedCheckStatus(degradedCheck);
  }
  if (status.tempWorkspaceRequired !== undefined && typeof status.tempWorkspaceRequired !== "boolean") {
    throw new Error("Validation adapter runtime status tempWorkspaceRequired must be boolean");
  }
  return status;
}

function validateValidationAdapterToolchainStatus(status: ValidationAdapterToolchainStatus): ValidationAdapterToolchainStatus {
  if (!status || typeof status !== "object") {
    throw new Error("Validation adapter toolchain status is required");
  }
  validateNonEmptyString(status.tool, "Validation adapter toolchain status tool");
  if (typeof status.available !== "boolean") {
    throw new Error("Validation adapter toolchain status available must be boolean");
  }
  if (status.command !== undefined) validateNonEmptyString(status.command, "Validation adapter toolchain status command");
  if (status.version !== undefined) validateNonEmptyString(status.version, "Validation adapter toolchain status version");
  if (status.failureMessage !== undefined) {
    validateNonEmptyString(status.failureMessage, "Validation adapter toolchain status failureMessage");
  }
  return status;
}

function validateValidationAdapterDegradedCheckStatus(
  status: ValidationAdapterDegradedCheckStatus
): ValidationAdapterDegradedCheckStatus {
  if (!status || typeof status !== "object") {
    throw new Error("Validation adapter degraded check status is required");
  }
  validateValidationCheckId(status.checkId, "Validation adapter degraded check status checkId");
  if (!includesString(validationCheckRunStatuses, status.status)) {
    throw new Error(`Unknown validation adapter degraded check status: ${String(status.status)}`);
  }
  validateNonEmptyString(status.reason, "Validation adapter degraded check status reason");
  validateNonEmptyString(status.message, "Validation adapter degraded check status message");
  if (status.requiredTool !== undefined) {
    validateNonEmptyString(status.requiredTool, "Validation adapter degraded check status requiredTool");
  }
  if (status.retainedCompatibility !== undefined && typeof status.retainedCompatibility !== "boolean") {
    throw new Error("Validation adapter degraded check status retainedCompatibility must be boolean");
  }
  if (status.followUpIssue !== undefined) {
    validateNonEmptyString(status.followUpIssue, "Validation adapter degraded check status followUpIssue");
  }
  if (status.currentUsage !== undefined) {
    validateValidationAdapterCurrentUsage(status.currentUsage);
  }
  return status;
}

function validateValidationAdapterCurrentUsage(
  currentUsage: ValidationAdapterDegradedCheckStatus["currentUsage"]
): NonNullable<ValidationAdapterDegradedCheckStatus["currentUsage"]> {
  if (!currentUsage || typeof currentUsage !== "object") {
    throw new Error("Validation adapter degraded check status currentUsage is required when present");
  }
  for (const key of ["lattice", "orchestra", "covibes", "gateway"] as const) {
    if (typeof currentUsage[key] !== "boolean") {
      throw new Error(`Validation adapter degraded check status currentUsage.${key} must be boolean`);
    }
  }
  return currentUsage;
}

function validateValidationScope(scope: ValidationScope): ValidationScope {
  if (!scope || typeof scope !== "object") {
    throw new Error("Validation scope is required");
  }
  if (!includesString(validationScopeKinds, scope.kind)) {
    throw new Error(`Unknown validation scope kind: ${String((scope as { kind?: unknown }).kind)}`);
  }
  if (scope.kind === "files") {
    validateStringArray(scope.files, "Validation scope files", { allowEmpty: false });
    for (const file of scope.files) validateRepoRelativePath(file);
  }
  if (scope.kind === "changed") {
    validateNonEmptyString(scope.baseRef, "Validation changed scope baseRef");
  }
  if (scope.kind === "tree") {
    validateNonEmptyString(scope.treeRef, "Validation tree scope treeRef");
    validateNonEmptyString(scope.changedFrom, "Validation tree scope changedFrom");
  }
  if (scope.kind === "package") {
    validateNonEmptyString(scope.packageName, "Validation package scope packageName");
    validateRepoRelativePath(scope.packageRoot);
  }
  return scope;
}

function validateValidationGraphConfig(graph: ValidationGraphConfig): ValidationGraphConfig {
  if (!graph || typeof graph !== "object") {
    throw new Error("Validation graph config is required");
  }
  if (!includesString(graphProviderModes, graph.mode)) {
    throw new Error(`Unknown validation graph mode: ${String(graph.mode)}`);
  }
  if (graph.provider !== undefined) validateNonEmptyString(graph.provider, "Validation graph provider");
  if (graph.maxAgeMs !== undefined && (typeof graph.maxAgeMs !== "number" || graph.maxAgeMs < 0)) {
    throw new Error("Validation graph maxAgeMs must be non-negative");
  }
  if (graph.status !== undefined) {
    validateProviderStatus(graph.status);
    if (graph.status.mode !== graph.mode) {
      throw new Error("Validation graph status mode must match graph mode");
    }
    if (graph.provider !== undefined && graph.status.provider !== graph.provider) {
      throw new Error("Validation graph status provider must match graph provider");
    }
  }
  return graph;
}

function validateHypotheticalOverlays(overlays: readonly HypotheticalOverlay[]): readonly HypotheticalOverlay[] {
  if (!Array.isArray(overlays)) {
    throw new Error("Validation request overlays must be an array");
  }
  const normalizedPaths = new Set<string>();
  for (const overlay of overlays) {
    validateHypotheticalOverlay(overlay);
    const normalizedPath = validateRepoRelativePath(overlay.path);
    if (normalizedPaths.has(normalizedPath)) {
      throw new Error(`Validation request overlays include duplicate path: ${normalizedPath}`);
    }
    normalizedPaths.add(normalizedPath);
  }
  return overlays;
}

function validateHypotheticalOverlay(overlay: HypotheticalOverlay): HypotheticalOverlay {
  if (!overlay || typeof overlay !== "object") {
    throw new Error("Validation request overlay is required");
  }
  validateRepoRelativePath(overlay.path);
  if (!includesString(["write", "delete"] as const, overlay.action)) {
    throw new Error(`Unknown validation overlay action: ${String((overlay as { action?: unknown }).action)}`);
  }
  if (overlay.action === "write") {
    if (typeof overlay.content !== "string") {
      throw new Error("Validation write overlay must include content");
    }
  }
  if (overlay.action === "delete" && Object.hasOwn(overlay, "content")) {
    throw new Error("Validation delete overlay must not include content");
  }
  if (overlay.checksumBefore !== undefined) {
    validateNonEmptyString(overlay.checksumBefore, "Validation overlay checksumBefore");
  }
  return overlay;
}

function validateValidationDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  if (!Array.isArray(diagnostics)) {
    throw new Error("Validation result diagnostics must be an array");
  }
  for (const diagnostic of diagnostics) validateValidationDiagnostic(diagnostic);
  return diagnostics;
}

function validateValidationDiagnostic(diagnostic: ValidationDiagnostic): ValidationDiagnostic {
  if (!diagnostic || typeof diagnostic !== "object") {
    throw new Error("Validation diagnostic is required");
  }
  if (!includesString(validationDiagnosticCategories, diagnostic.category)) {
    throw new Error(`Unknown validation diagnostic category: ${String(diagnostic.category)}`);
  }
  validateNonEmptyString(diagnostic.message, "Validation diagnostic message");
  if (diagnostic.path !== undefined) validateRepoRelativePath(diagnostic.path);
  if (!includesString(["info", "warning", "error"] as const, diagnostic.severity)) {
    throw new Error(`Unknown validation diagnostic severity: ${String(diagnostic.severity)}`);
  }
  if (diagnostic.code !== undefined) validateNonEmptyString(diagnostic.code, "Validation diagnostic code");
  return diagnostic;
}

function validateValidationResultManifest(manifest: ValidationResultManifest): ValidationResultManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Validation result manifest is required");
  }
  if (manifest.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(`Validation result manifest schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  }
  validateValidationChecks(manifest.checks, "Validation result manifest checks");
  validateNonEmptyString(manifest.generatedAt, "Validation result manifest generatedAt");
  if (manifest.durationMs !== undefined) validateNonNegativeNumber(manifest.durationMs, "Validation result manifest durationMs");
  if (manifest.entries !== undefined) {
    if (!Array.isArray(manifest.entries)) {
      throw new Error("Validation result manifest entries must be an array");
    }
    for (const entry of manifest.entries) validateValidationCheckManifestEntry(entry);
  }
  if (manifest.runs !== undefined) {
    if (!Array.isArray(manifest.runs)) {
      throw new Error("Validation result manifest runs must be an array");
    }
    for (const run of manifest.runs) validateValidationCheckRunSummary(run);
  }
  if (manifest.skippedChecks !== undefined) {
    if (!Array.isArray(manifest.skippedChecks)) {
      throw new Error("Validation result manifest skippedChecks must be an array");
    }
    for (const skippedCheck of manifest.skippedChecks) validateValidationSkippedCheck(skippedCheck);
  }
  return manifest;
}

function validatePreWriteValidationGraph(graph: PreWriteValidationReceipt["graph"]): void {
  if (!graph || typeof graph !== "object") {
    throw new Error("Pre-write validation receipt graph is required");
  }
  if (!includesString(graphProviderModes, graph.mode)) {
    throw new Error(`Unknown pre-write validation receipt graph mode: ${String(graph.mode)}`);
  }
  if (graph.provider !== undefined) validateNonEmptyString(graph.provider, "Pre-write validation receipt graph provider");
  if (graph.status !== undefined) {
    validateProviderStatus(graph.status);
    if (graph.status.mode !== graph.mode) {
      throw new Error("Pre-write validation receipt graph status mode must match graph mode");
    }
    if (graph.provider !== undefined && graph.status.provider !== graph.provider) {
      throw new Error("Pre-write validation receipt graph status provider must match graph provider");
    }
  }
}

function validatePreWriteValidationOverlaySummary(summary: PreWriteValidationOverlaySummary): void {
  if (!summary || typeof summary !== "object") {
    throw new Error("Pre-write validation receipt overlays are required");
  }
  for (const key of ["count", "writeCount", "deleteCount"] as const) {
    if (!Number.isInteger(summary[key]) || summary[key] < 0) {
      throw new Error(`Pre-write validation receipt overlays ${key} must be a non-negative integer`);
    }
  }
  validateStringArray(summary.paths, "Pre-write validation receipt overlay paths", { allowEmpty: true });
  for (const path of summary.paths) validateRepoRelativePath(path);
  if (summary.count !== summary.writeCount + summary.deleteCount) {
    throw new Error("Pre-write validation receipt overlay count must equal writeCount plus deleteCount");
  }
  if (summary.count !== summary.paths.length) {
    throw new Error("Pre-write validation receipt overlay count must equal paths length");
  }
}

function validatePreWriteValidationFailureSummary(summary: PreWriteValidationFailureSummary): void {
  if (!summary || typeof summary !== "object") {
    throw new Error("Pre-write validation receipt failureSummary is required");
  }
  if (!includesString(validationResultStatuses, summary.category)) {
    throw new Error(`Unknown pre-write validation receipt failure category: ${String(summary.category)}`);
  }
  if (summary.category === "passed") {
    throw new Error("Pre-write validation receipt failure category must not be passed");
  }
  validateNonEmptyString(summary.message, "Pre-write validation receipt failureSummary message");
  if (summary.cause !== undefined) validateNonEmptyString(summary.cause, "Pre-write validation receipt failureSummary cause");
  if (summary.retryable !== undefined && typeof summary.retryable !== "boolean") {
    throw new Error("Pre-write validation receipt failureSummary retryable must be boolean");
  }
}

function validateValidationCheckManifestEntry(entry: ValidationCheckManifestEntry): ValidationCheckManifestEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error("Validation check manifest entry is required");
  }
  validateValidationCheckId(entry.checkId, "Validation check manifest entry checkId");
  validateNonEmptyString(entry.owner, "Validation check manifest entry owner");
  validateNonEmptyString(entry.adapter, "Validation check manifest entry adapter");
  if (!includesString(["info", "warning", "error"] as const, entry.defaultSeverity)) {
    throw new Error(`Unknown validation check manifest entry defaultSeverity: ${String(entry.defaultSeverity)}`);
  }
  if (!Array.isArray(entry.supportedScopes) || entry.supportedScopes.length === 0) {
    throw new Error("Validation check manifest entry supportedScopes must be a non-empty array");
  }
  for (const scopeKind of entry.supportedScopes) {
    if (!includesString(validationScopeKinds, scopeKind)) {
      throw new Error(`Unknown validation check manifest entry supported scope: ${String(scopeKind)}`);
    }
  }
  if (typeof entry.requiresGraph !== "boolean") {
    throw new Error("Validation check manifest entry requiresGraph must be boolean");
  }
  return entry;
}

function validateValidationCheckRunSummary(run: ValidationCheckRunSummary): ValidationCheckRunSummary {
  if (!run || typeof run !== "object") {
    throw new Error("Validation check run summary is required");
  }
  validateValidationCheckId(run.checkId, "Validation check run summary checkId");
  if (!includesString(validationCheckRunStatuses, run.status)) {
    throw new Error(`Unknown validation check run status: ${String(run.status)}`);
  }
  if (run.durationMs !== undefined) validateNonNegativeNumber(run.durationMs, "Validation check run summary durationMs");
  if (run.diagnosticCount !== undefined) validateNonNegativeInteger(run.diagnosticCount, "Validation check run summary diagnosticCount");
  if (run.failureMessage !== undefined) validateNonEmptyString(run.failureMessage, "Validation check run summary failureMessage");
  if (
    includesString(["infrastructure_failure", "provider_failure", "unsupported_request"] as const, run.status) &&
    run.failureMessage === undefined
  ) {
    throw new Error("Validation check run summary failureMessage is required for failure statuses");
  }
  return run;
}

function validateValidationSkippedCheck(skippedCheck: ValidationSkippedCheck): ValidationSkippedCheck {
  if (!skippedCheck || typeof skippedCheck !== "object") {
    throw new Error("Validation skipped check is required");
  }
  validateValidationCheckId(skippedCheck.checkId, "Validation skipped check checkId");
  if (!includesString(validationSkippedCheckReasons, skippedCheck.reason)) {
    throw new Error(`Unknown validation skipped reason: ${String(skippedCheck.reason)}`);
  }
  validateNonEmptyString(skippedCheck.message, "Validation skipped check message");
  return skippedCheck;
}

function validateValidationFailure(failure: ValidationFailure): ValidationFailure {
  if (!failure || typeof failure !== "object") {
    throw new Error("Validation failure is required");
  }
  if (!includesString(validationFailureCategories, failure.category)) {
    throw new Error(`Unknown validation failure category: ${String(failure.category)}`);
  }
  validateNonEmptyString(failure.message, "Validation failure message");
  if (failure.retryable !== undefined && typeof failure.retryable !== "boolean") {
    throw new Error("Validation failure retryable must be boolean");
  }
  if (failure.cause !== undefined) validateNonEmptyString(failure.cause, "Validation failure cause");
  return failure;
}

export function validateEditPlanPayload(plan: EditPlan): EditPlan {
  if (!plan || typeof plan !== "object") {
    throw new Error("Edit plan is required");
  }
  validateNonEmptyString(plan.planId, "Edit plan planId");
  validateRepoIdentity(plan.repo);
  if (!Array.isArray(plan.changes)) {
    throw new Error("Edit plan changes must be an array");
  }
  for (const change of plan.changes) validateRepoRelativeChange(change);
  if (!plan.atomic || typeof plan.atomic !== "object") {
    throw new Error("Edit plan atomic metadata is required");
  }
  if (plan.atomic.strategy !== "all_or_nothing") {
    throw new Error("Edit plan atomic strategy must be all_or_nothing");
  }
  if (plan.atomic.planHash !== undefined) validateNonEmptyString(plan.atomic.planHash, "Edit plan planHash");
  if (plan.atomic.expectedBaseSha !== undefined) validateNonEmptyString(plan.atomic.expectedBaseSha, "Edit plan expectedBaseSha");
  if (!plan.validation || typeof plan.validation !== "object") {
    throw new Error("Edit plan validation requirement is required");
  }
  if (typeof plan.validation.required !== "boolean") {
    throw new Error("Edit plan validation required must be boolean");
  }
  validateValidationRequestPayload(plan.validation.request);
  return plan;
}

export function validateEditCommandResult(result: EditCommandResult): EditCommandResult {
  if (!result || typeof result !== "object") {
    throw new Error("Edit command result is required");
  }
  if (typeof result.ok !== "boolean") {
    throw new Error("Edit command result ok must be boolean");
  }
  if (typeof result.applied !== "boolean") {
    throw new Error("Edit command result applied must be boolean");
  }
  if (result.planId !== undefined) validateNonEmptyString(result.planId, "Edit command result planId");
  if (result.planHash !== undefined) validateNonEmptyString(result.planHash, "Edit command result planHash");
  if (result.appliedAt !== undefined) validateNonEmptyString(result.appliedAt, "Edit command result appliedAt");
  if (result.matchCount !== undefined) validateNonNegativeInteger(result.matchCount, "Edit command result matchCount");
  if (result.afterState !== undefined) validateEditAfterState(result.afterState);
  if (result.validationRequest !== undefined) validateValidationRequestPayload(result.validationRequest);
  if (result.validation !== undefined) validateValidationResultPayload(result.validation);
  if (result.refusal !== undefined) validateEditRefusal(result.refusal);
  if (result.rollback !== undefined) validateEditPlanRollbackState(result.rollback);
  if (!result.ok && result.refusal === undefined) {
    throw new Error("Edit command result refusal is required when ok=false");
  }
  if (result.ok && result.refusal !== undefined) {
    throw new Error("Edit command result ok=true must not include refusal");
  }
  return result;
}

function validateEditPlanRollbackState(rollback: EditPlanRollbackState): EditPlanRollbackState {
  if (!rollback || typeof rollback !== "object") {
    throw new Error("Edit rollback state is required");
  }
  if (typeof rollback.completed !== "boolean") {
    throw new Error("Edit rollback completed must be boolean");
  }
  validateRepoRelativePaths(rollback.restoredPaths, "Edit rollback restoredPaths");
  validateRepoRelativePaths(rollback.failedPaths, "Edit rollback failedPaths");
  if (!Array.isArray(rollback.cleanupFailedPaths)) {
    throw new Error("Edit rollback cleanupFailedPaths must be an array");
  }
  for (const path of rollback.cleanupFailedPaths) {
    validateNonEmptyString(path, "Edit rollback cleanupFailedPaths path");
  }
  return rollback;
}

function validateRepoRelativeChange(change: RepoRelativeChange): RepoRelativeChange {
  if (!change || typeof change !== "object") {
    throw new Error("Repo-relative change is required");
  }
  if (change.kind === "create" || change.kind === "replace") {
    validateRepoRelativePath(change.path);
    if (typeof change.content !== "string") throw new Error("Repo-relative write change content must be string");
    if (change.checksumBefore !== undefined) validateNonEmptyString(change.checksumBefore, "Repo-relative change checksumBefore");
    if (change.checksumAfter !== undefined) validateNonEmptyString(change.checksumAfter, "Repo-relative change checksumAfter");
    return change;
  }
  if (change.kind === "delete") {
    validateRepoRelativePath(change.path);
    if (change.checksumBefore !== undefined) validateNonEmptyString(change.checksumBefore, "Repo-relative change checksumBefore");
    return change;
  }
  if (change.kind === "rename") {
    validateRepoRelativePath(change.path);
    validateRepoRelativePath(change.toPath);
    if (change.checksumBefore !== undefined) validateNonEmptyString(change.checksumBefore, "Repo-relative change checksumBefore");
    return change;
  }
  throw new Error(`Unknown repo-relative change kind: ${String((change as { kind?: unknown }).kind)}`);
}

function validateEditAfterState(afterState: Readonly<Record<string, string | null>>): void {
  if (!afterState || typeof afterState !== "object" || Array.isArray(afterState)) {
    throw new Error("Edit command result afterState must be an object");
  }
  for (const [path, content] of Object.entries(afterState)) {
    validateRepoRelativePath(path);
    if (typeof content !== "string" && content !== null) {
      throw new Error(`Edit command result afterState for ${path} must be string or null`);
    }
  }
}

function validateEditRefusal(refusal: EditRefusal): EditRefusal {
  if (!refusal || typeof refusal !== "object") {
    throw new Error("Edit refusal is required");
  }
  if (!includesString(editRefusalCategories, refusal.category)) {
    throw new Error(`Unknown edit refusal category: ${String(refusal.category)}`);
  }
  validateNonEmptyString(refusal.message, "Edit refusal message");
  if (refusal.path !== undefined) validateRepoRelativePath(refusal.path);
  return refusal;
}

function includesString<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function validateGraphDaemonOperation(operation: unknown): GraphDaemonOperation {
  if (!includesString(graphDaemonOperations, operation)) {
    throw new Error(`Unknown graph daemon operation: ${String(operation)}`);
  }
  return operation;
}

function validateGraphFactQueryKind(kind: unknown): GraphFactQuerySelector["kind"] {
  if (!includesString(graphFactQueryKinds, kind)) {
    throw new Error(`Unknown graph fact query kind: ${String(kind)}`);
  }
  return kind;
}

function validateGraphNamedQueryKind(kind: unknown): GraphNamedQueryKind {
  if (!includesString(graphNamedQueryKinds, kind)) {
    throw new Error(`Unknown graph named query kind: ${String(kind)}`);
  }
  return kind;
}

function validateGraphProviderQueryKind(kind: unknown): GraphProviderQueryKind {
  if (
    !includesString(graphFactQueryKinds, kind) &&
    !includesString(graphNamedQueryKinds, kind) &&
    kind !== "review_context" &&
    kind !== "detect_changes" &&
    kind !== "search"
  ) {
    throw new Error(`Unknown graph provider query kind: ${String(kind)}`);
  }
  return kind;
}

function validateGraphQueryRequestBase(
  request: { requestId?: string; repo: RepoIdentity; schemaVersion: number; mode: GraphProviderMode },
  label: string
): void {
  if (!request || typeof request !== "object") throw new Error(`${label} is required`);
  if (request.requestId !== undefined) validateNonEmptyString(request.requestId, `${label} requestId`);
  validateRepoIdentity(request.repo);
  if (request.schemaVersion !== GRAPH_SCHEMA_VERSION) throw new Error(`${label} schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  if (!includesString(graphProviderModes, request.mode)) throw new Error(`Unknown ${label} mode: ${String(request.mode)}`);
}

function validateTraversalOptions(maxDepth: number | undefined, limit: number | undefined, label: string): void {
  if (maxDepth !== undefined && (!Number.isFinite(maxDepth) || maxDepth < 0)) {
    throw new Error(`${label} maxDepth must be a non-negative number`);
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`${label} limit must be a positive number`);
  }
}

function validateGraphTraversalMetadata(metadata: GraphTraversalMetadata): GraphTraversalMetadata {
  if (!metadata || typeof metadata !== "object") throw new Error("Graph traversal metadata is required");
  if (typeof metadata.maxDepth !== "number" || metadata.maxDepth < 0) {
    throw new Error("Graph traversal metadata maxDepth must be non-negative");
  }
  if (typeof metadata.truncated !== "boolean") throw new Error("Graph traversal metadata truncated must be boolean");
  if (typeof metadata.total !== "number" || metadata.total < 0) throw new Error("Graph traversal metadata total must be non-negative");
  if (typeof metadata.empty !== "boolean") throw new Error("Graph traversal metadata empty must be boolean");
  return metadata;
}

function validateGraphSearchMode(mode: GraphSearchMode): GraphSearchMode {
  if (!mode || typeof mode !== "object") throw new Error("Graph search mode is required");
  validateNonEmptyString(mode.engine, "Graph search mode engine");
  validateNonEmptyString(mode.querySyntax, "Graph search mode querySyntax");
  if (!Number.isFinite(mode.limit) || mode.limit < 1) throw new Error("Graph search mode limit must be a positive number");
  validateRepoRelativePaths(mode.contextFiles, "Graph search mode contextFiles");
  return mode;
}

function validateGraphSearchSummary(summary: GraphSearchSummary): GraphSearchSummary {
  if (!summary || typeof summary !== "object") throw new Error("Graph search summary is required");
  validateNonEmptyString(summary.query, "Graph search summary query");
  for (const key of ["total", "returned", "limit"] as const) {
    if (!Number.isFinite(summary[key]) || summary[key] < (key === "limit" ? 1 : 0)) {
      throw new Error(`Graph search summary ${key} must be a non-negative number`);
    }
  }
  validateStringArray(summary.indexedNodeKinds, "Graph search summary indexedNodeKinds", { allowEmpty: true });
  validateRepoRelativePaths(summary.contextFiles, "Graph search summary contextFiles");
  return summary;
}

function validateGraphSearchResultEntry(entry: GraphSearchResultEntry): GraphSearchResultEntry {
  if (!entry || typeof entry !== "object") throw new Error("Graph search result entry is required");
  validateNonEmptyString(entry.nodeId, "Graph search result entry nodeId");
  validateNonEmptyString(entry.kind, "Graph search result entry kind");
  if (entry.path !== undefined) validateRepoRelativePath(entry.path);
  if (entry.name !== undefined) validateNonEmptyString(entry.name, "Graph search result entry name");
  validateNonEmptyString(entry.qualifiedName, "Graph search result entry qualifiedName");
  if (entry.filePath !== undefined) validateRepoRelativePath(entry.filePath);
  validateNonEmptyString(entry.signature, "Graph search result entry signature");
  if (!Number.isFinite(entry.score)) throw new Error("Graph search result entry score must be numeric");
  if (!Number.isFinite(entry.rank) || entry.rank < 1) throw new Error("Graph search result entry rank must be a positive number");
  validateStringArray(entry.matches, "Graph search result entry matches", { allowEmpty: true });
  return entry;
}

function validateInspectRouteName(route: unknown): InspectRouteResult["route"] {
  if (!includesString(["references", "signature", "implementations"] as const, route)) {
    throw new Error(`Unknown inspect route result route: ${String(route)}`);
  }
  return route;
}

function validateInspectRoutePayload(result: InspectRouteResult, route: InspectRouteResult["route"]): void {
  const payloadFields = ["references", "signatures", "implementations"] as const;
  const expectedField =
    route === "references" ? "references" : route === "signature" ? "signatures" : "implementations";
  for (const field of payloadFields) {
    const hasField = Object.hasOwn(result, field);
    if (field !== expectedField && hasField) {
      throw new Error(`Inspect ${route} result must not include ${field}`);
    }
  }
  const payload = result as unknown as {
    references?: readonly InspectReferenceEntry[];
    signatures?: readonly InspectSignatureEntry[];
    implementations?: readonly InspectImplementationEntry[];
  };
  if (route === "references") {
    if (!Array.isArray(payload.references)) throw new Error("Inspect references result references must be an array");
    for (const reference of payload.references) validateInspectReferenceEntry(reference);
    return;
  }
  if (route === "signature") {
    if (!Array.isArray(payload.signatures)) throw new Error("Inspect signature result signatures must be an array");
    for (const signature of payload.signatures) validateInspectSignatureEntry(signature);
    return;
  }
  if (!Array.isArray(payload.implementations)) throw new Error("Inspect implementations result implementations must be an array");
  for (const implementation of payload.implementations) validateInspectImplementationEntry(implementation);
}

function validateInspectSymbolTarget(target: InspectSymbolTarget, label: string): InspectSymbolTarget {
  if (!target || typeof target !== "object") throw new Error(`${label} is required`);
  if (!includesString(["node", "file_symbol"] as const, target.kind)) {
    throw new Error(`Unknown ${label} kind: ${String((target as { kind?: unknown }).kind)}`);
  }
  if (target.kind === "node") {
    validateNonEmptyString(target.nodeId, `${label} nodeId`);
    if (target.path !== undefined || target.symbolName !== undefined || target.line !== undefined || target.column !== undefined) {
      throw new Error(`${label} node target must not include file-symbol fields`);
    }
  } else {
    validateRepoRelativePath(validateNonEmptyString(target.path, `${label} path`));
    validateNonEmptyString(target.symbolName, `${label} symbolName`);
    if (target.line !== undefined) validatePositiveInteger(target.line, `${label} line`);
    if (target.column !== undefined) validatePositiveInteger(target.column, `${label} column`);
    if (target.nodeId !== undefined) validateNonEmptyString(target.nodeId, `${label} nodeId`);
  }
  return target;
}

const validateInspectReferenceTarget = validateInspectSymbolTarget;

function validateInspectReferenceEntry(entry: InspectReferenceEntry): InspectReferenceEntry {
  if (!entry || typeof entry !== "object") throw new Error("Inspect reference entry is required");
  validateRepoRelativePath(entry.file);
  validatePositiveInteger(entry.line, "Inspect reference entry line");
  validatePositiveInteger(entry.column, "Inspect reference entry column");
  validateNonEmptyString(entry.text, "Inspect reference entry text");
  validateInspectTextSpan(entry.span, "Inspect reference span");
  validateInspectSymbolSummary(entry.symbol, "Inspect reference entry symbol");
  if (typeof entry.isDefinition !== "boolean") throw new Error("Inspect reference entry isDefinition must be boolean");
  if (entry.isDeclaration !== undefined && typeof entry.isDeclaration !== "boolean") {
    throw new Error("Inspect reference entry isDeclaration must be boolean");
  }
  validateInspectSymbolEvidence(entry.evidence, "Inspect reference entry evidence");
  return entry;
}

function validateInspectSignatureEntry(entry: InspectSignatureEntry): InspectSignatureEntry {
  if (!entry || typeof entry !== "object") throw new Error("Inspect signature entry is required");
  validateRepoRelativePath(entry.file);
  validatePositiveInteger(entry.line, "Inspect signature entry line");
  validatePositiveInteger(entry.column, "Inspect signature entry column");
  validateNonEmptyString(entry.text, "Inspect signature entry text");
  validateNonEmptyString(entry.signature, "Inspect signature entry signature");
  if (!includesString(inspectSignatureKinds, entry.kind)) {
    throw new Error(`Unknown inspect signature entry kind: ${String(entry.kind)}`);
  }
  if (!Array.isArray(entry.parameters)) throw new Error("Inspect signature entry parameters must be an array");
  for (const parameter of entry.parameters) validateInspectSignatureParameter(parameter);
  if (!Array.isArray(entry.typeParameters)) throw new Error("Inspect signature entry typeParameters must be an array");
  for (const typeParameter of entry.typeParameters) validateInspectSignatureTypeParameter(typeParameter);
  if (typeof entry.exported !== "boolean") throw new Error("Inspect signature entry exported must be boolean");
  if (typeof entry.async !== "boolean") throw new Error("Inspect signature entry async must be boolean");
  if (entry.returnType !== undefined) validateNonEmptyString(entry.returnType, "Inspect signature entry returnType");
  validateInspectTextSpan(entry.span, "Inspect signature span");
  validateInspectSymbolSummary(entry.symbol, "Inspect signature entry symbol");
  if (entry.overloadIndex !== undefined) validateNonNegativeInteger(entry.overloadIndex, "Inspect signature entry overloadIndex");
  validateInspectSymbolEvidence(entry.evidence, "Inspect signature entry evidence");
  return entry;
}

function validateInspectSignatureParameter(parameter: InspectSignatureParameter): InspectSignatureParameter {
  if (!parameter || typeof parameter !== "object") throw new Error("Inspect signature parameter is required");
  validateNonEmptyString(parameter.name, "Inspect signature parameter name");
  validateNonEmptyString(parameter.type, "Inspect signature parameter type");
  if (typeof parameter.optional !== "boolean") throw new Error("Inspect signature parameter optional must be boolean");
  if (parameter.rest !== undefined && typeof parameter.rest !== "boolean") {
    throw new Error("Inspect signature parameter rest must be boolean");
  }
  if (parameter.defaultValue !== undefined) validateNonEmptyString(parameter.defaultValue, "Inspect signature parameter defaultValue");
  return parameter;
}

function validateInspectSignatureTypeParameter(typeParameter: InspectSignatureTypeParameter): InspectSignatureTypeParameter {
  if (!typeParameter || typeof typeParameter !== "object") throw new Error("Inspect signature typeParameter is required");
  validateNonEmptyString(typeParameter.name, "Inspect signature typeParameter name");
  if (typeParameter.constraint !== undefined) {
    validateNonEmptyString(typeParameter.constraint, "Inspect signature typeParameter constraint");
  }
  if (typeParameter.default !== undefined) {
    validateNonEmptyString(typeParameter.default, "Inspect signature typeParameter default");
  }
  return typeParameter;
}

function validateInspectImplementationEntry(entry: InspectImplementationEntry): InspectImplementationEntry {
  if (!entry || typeof entry !== "object") throw new Error("Inspect implementation entry is required");
  validateRepoRelativePath(entry.file);
  validatePositiveInteger(entry.line, "Inspect implementation entry line");
  validatePositiveInteger(entry.column, "Inspect implementation entry column");
  validateNonEmptyString(entry.text, "Inspect implementation entry text");
  validateInspectTextSpan(entry.span, "Inspect implementation span");
  if (Object.hasOwn(entry, "implements")) throw new Error("Inspect implementation entry must use target, not implements");
  if (!includesString(inspectImplementationKinds, entry.kind)) {
    throw new Error(`Unknown Inspect implementation entry kind: ${String(entry.kind)}`);
  }
  validateInspectSymbolSummary(entry.symbol, "Inspect implementation entry symbol");
  validateInspectSymbolSummary(entry.target, "Inspect implementation entry target");
  if (entry.isDeclaration !== undefined && typeof entry.isDeclaration !== "boolean") {
    throw new Error("Inspect implementation entry isDeclaration must be boolean");
  }
  validateInspectSymbolEvidence(entry.evidence, "Inspect implementation entry evidence");
  return entry;
}

function validateInspectTextSpan(span: InspectTextSpan, label: string): InspectTextSpan {
  if (!span || typeof span !== "object") throw new Error(`${label} is required`);
  validatePositiveInteger(span.startLine, `${label} startLine`);
  validatePositiveInteger(span.startColumn, `${label} startColumn`);
  validatePositiveInteger(span.endLine, `${label} endLine`);
  validatePositiveInteger(span.endColumn, `${label} endColumn`);
  if (span.endLine < span.startLine || (span.endLine === span.startLine && span.endColumn < span.startColumn)) {
    throw new Error(`${label} end must be after start`);
  }
  if (span.startOffset !== undefined) validateNonNegativeInteger(span.startOffset, `${label} startOffset`);
  if (span.endOffset !== undefined) validateNonNegativeInteger(span.endOffset, `${label} endOffset`);
  return span;
}

function validateInspectSymbolSummary(symbol: InspectSymbolSummary, label: string): InspectSymbolSummary {
  if (!symbol || typeof symbol !== "object") throw new Error(`${label} is required`);
  validateNonEmptyString(symbol.id, `${label} id`);
  validateNonEmptyString(symbol.name, `${label} name`);
  if (symbol.kind !== undefined) validateNonEmptyString(symbol.kind, `${label} kind`);
  return symbol;
}

function validateInspectSymbolEvidence(evidence: InspectSymbolEvidence, label: string): InspectSymbolEvidence {
  if (!evidence || typeof evidence !== "object") throw new Error(`${label} is required`);
  validateStringArray(evidence.graphNodeIds, `${label} graphNodeIds`, { allowEmpty: true });
  if (!includesString(["graph", "language_service"] as const, evidence.resolver)) {
    throw new Error(`Unknown ${label} resolver: ${String(evidence.resolver)}`);
  }
  return evidence;
}

function validateInspectRouteFailure(failure: InspectRouteFailure): InspectRouteFailure {
  if (!failure || typeof failure !== "object") throw new Error("Inspect route failure is required");
  if (!includesString(inspectFailureCategories, failure.category)) {
    throw new Error(`Unknown inspect route failure category: ${String(failure.category)}`);
  }
  validateNonEmptyString(failure.message, "Inspect route failure message");
  if (failure.candidates !== undefined) {
    if (!Array.isArray(failure.candidates)) throw new Error("Inspect route failure candidates must be an array");
    for (const candidate of failure.candidates) validateInspectSymbolTarget(candidate, "Inspect route failure candidate");
  }
  return failure;
}

function validateGraphPayloadResult(
  result:
    | GraphNamedQueryResult
    | GraphImpactResult
    | GraphDetectChangesResult
    | GraphReviewContextResult,
  label: string,
  validatePayload: (payload: Record<string, unknown>) => void
): void {
  if (!result || typeof result !== "object") throw new Error(`${label} is required`);
  if (result.requestId !== undefined) validateNonEmptyString(result.requestId, `${label} requestId`);
  const status = validateProviderStatus(result.status);
  const payload = result as unknown as Record<string, unknown>;
  const payloadKeys = Object.keys(payload).filter((key) => key !== "requestId" && key !== "status");
  if (status.state !== "available") {
    if (payloadKeys.length > 0) throw new Error(`${label} ${status.state} result must not include graph data`);
    return;
  }
  validatePayload(payload);
  if (payload.diagnostics !== undefined) {
    validateGraphExtractionDiagnostics(payload.diagnostics as readonly GraphExtractionDiagnostic[]);
  }
}

function validateRepoRelativePaths(paths: unknown, label: string): readonly string[] {
  validateStringArray(paths as readonly string[] | undefined, label, { allowEmpty: true });
  for (const path of paths as readonly string[]) validateRepoRelativePath(path);
  return paths as readonly string[];
}

function validateRenamedFiles(renamedFiles: readonly GraphRenamedFile[]): void {
  if (!Array.isArray(renamedFiles)) throw new Error("Graph renamedFiles must be an array");
  for (const renamed of renamedFiles) {
    validateRepoRelativePath(renamed.fromPath);
    validateRepoRelativePath(renamed.toPath);
  }
}

function isNamedQueryResult(result: GraphFactQueryResult | GraphNamedQueryResult): result is GraphNamedQueryResult {
  return Object.hasOwn(result, "queryKind") || Object.hasOwn(result, "traversal");
}

function validateGraphFactNode(node: GraphFactNode): GraphFactNode {
  if (!node || typeof node !== "object") {
    throw new Error("Graph fact node is required");
  }
  validateNonEmptyString(node.id, "Graph fact node id");
  validateNonEmptyString(node.kind, "Graph fact node kind");
  if (node.path !== undefined) validateRepoRelativePath(node.path);
  if (node.name !== undefined) validateNonEmptyString(node.name, "Graph fact node name");
  return node;
}

function validateGraphFactEdge(edge: GraphFactEdge): GraphFactEdge {
  if (!edge || typeof edge !== "object") {
    throw new Error("Graph fact edge is required");
  }
  if (edge.id !== undefined) validateNonEmptyString(edge.id, "Graph fact edge id");
  validateNonEmptyString(edge.kind, "Graph fact edge kind");
  validateNonEmptyString(edge.from, "Graph fact edge from");
  validateNonEmptyString(edge.to, "Graph fact edge to");
  return edge;
}

function validateGraphExtractionDiagnostics(
  diagnostics: readonly GraphExtractionDiagnostic[]
): readonly GraphExtractionDiagnostic[] {
  if (!Array.isArray(diagnostics)) {
    throw new Error("Graph extraction diagnostics must be an array");
  }
  for (const diagnostic of diagnostics) validateGraphExtractionDiagnostic(diagnostic);
  return diagnostics;
}

function validateGraphExtractionDiagnostic(diagnostic: GraphExtractionDiagnostic): GraphExtractionDiagnostic {
  if (!diagnostic || typeof diagnostic !== "object") {
    throw new Error("Graph extraction diagnostic is required");
  }
  if (!includesString(graphExtractionDiagnosticCategories, diagnostic.category)) {
    throw new Error(`Unknown graph extraction diagnostic category: ${String(diagnostic.category)}`);
  }
  if (!includesString(["info", "warning", "error"] as const, diagnostic.severity)) {
    throw new Error(`Unknown graph extraction diagnostic severity: ${String(diagnostic.severity)}`);
  }
  validateNonEmptyString(diagnostic.message, "Graph extraction diagnostic message");
  if (diagnostic.path !== undefined) validateRepoRelativePath(diagnostic.path);
  if (diagnostic.language !== undefined) validateNonEmptyString(diagnostic.language, "Graph extraction diagnostic language");
  return diagnostic;
}

function validateProviderFailure(failure: ProviderFailure): ProviderFailure {
  if (!failure || typeof failure !== "object") {
    throw new Error("Provider failure is required");
  }
  if (!includesString(providerFailureCategories, failure.category)) {
    throw new Error(`Unknown provider failure category: ${String(failure.category)}`);
  }
  validateNonEmptyString(failure.message, "Provider failure message");
  if (failure.retryable !== undefined && typeof failure.retryable !== "boolean") {
    throw new Error("Provider failure retryable must be boolean");
  }
  if (failure.cause !== undefined) validateNonEmptyString(failure.cause, "Provider failure cause");
  return failure;
}

function validateCommandOwner(owner: unknown): CommandOwner {
  if (!includesString(commandOwners, owner)) {
    throw new Error(`Unknown command owner: ${String(owner)}`);
  }
  return owner;
}

function validateCommandRouteStatus(status: unknown): CommandRouteStatus {
  if (!includesString(commandRouteStatuses, status)) {
    throw new Error(`Unknown command route status: ${String(status)}`);
  }
  return status;
}

function validateGraphReferenceEvidenceSurfaceClassification(classification: unknown): GraphReferenceEvidenceClassification {
  if (!includesString(graphReferenceEvidenceClassifications, classification)) {
    throw new Error(`Unknown graph reference evidence surface classification: ${String(classification)}`);
  }
  return classification;
}

function validateGraphReferenceEvidenceCommandSurfaces(surfaces: readonly GraphReferenceEvidenceCommandSurface[]): void {
  validateNonEmptyArray(surfaces, "Graph reference evidence commandSurfaces");
  for (const surface of surfaces) {
    validateGraphReferenceEvidenceSurfaceBase(surface, "Graph reference evidence command surface");
    validateNonEmptyString(surface.referenceTool, "Graph reference evidence command surface referenceTool");
    validateStringArray(surface.referenceCommand, "Graph reference evidence command surface referenceCommand", { allowEmpty: true });
    validateStringArray(surface.canonicalCommand, "Graph reference evidence command surface canonicalCommand", { allowEmpty: false });
    validateStringArray(surface.flags, "Graph reference evidence command surface flags", { allowEmpty: true });
    validateStringArray(surface.positionals, "Graph reference evidence command surface positionals", { allowEmpty: true });
    validateGraphReferenceEvidenceExitSemantics(surface.exitSemantics, "Graph reference evidence command surface");
  }
}

function validateGraphReferenceEvidenceJsonOutputSurfaces(surfaces: readonly GraphReferenceEvidenceJsonOutputSurface[]): void {
  validateNonEmptyArray(surfaces, "Graph reference evidence jsonOutputSurfaces");
  for (const surface of surfaces) {
    validateGraphReferenceEvidenceSurfaceBase(surface, "Graph reference evidence JSON output surface");
    validateNonEmptyString(surface.command, "Graph reference evidence JSON output surface command");
    validateStringArray(surface.requiredFields, "Graph reference evidence JSON output surface requiredFields", { allowEmpty: false });
    validateGraphReferenceEvidenceExitSemantics(surface.exitSemantics, "Graph reference evidence JSON output surface");
  }
}

function validateGraphReferenceEvidenceSqliteFixtures(fixtures: readonly GraphReferenceEvidenceSqliteFixture[]): void {
  validateNonEmptyArray(fixtures, "Graph reference evidence sqliteFixtures");
  for (const fixture of fixtures) {
    validateGraphReferenceEvidenceSurfaceBase(fixture, "Graph reference evidence SQLite fixture");
    validateNonEmptyString(fixture.fixture, "Graph reference evidence SQLite fixture path");
    validateStringArray(fixture.tables, "Graph reference evidence SQLite fixture tables", { allowEmpty: false });
    validateStringArray(fixture.indexes, "Graph reference evidence SQLite fixture indexes", { allowEmpty: false });
    validateStringArray(fixture.metadataKeys, "Graph reference evidence SQLite fixture metadataKeys", { allowEmpty: false });
    validateStringArray(fixture.nodeKinds, "Graph reference evidence SQLite fixture nodeKinds", { allowEmpty: false });
    validateStringArray(fixture.edgeKinds, "Graph reference evidence SQLite fixture edgeKinds", { allowEmpty: false });
    validateStringArray(fixture.directReaderQueries, "Graph reference evidence SQLite fixture directReaderQueries", { allowEmpty: false });
  }
}

function validateGraphReferenceEvidenceDaemonFixtures(fixtures: readonly GraphReferenceEvidenceDaemonFixture[]): void {
  validateNonEmptyArray(fixtures, "Graph reference evidence daemonFixtures");
  for (const fixture of fixtures) {
    validateGraphReferenceEvidenceSurfaceBase(fixture, "Graph reference evidence daemon fixture");
    validateNonEmptyString(fixture.fixture, "Graph reference evidence daemon fixture path");
    validateNonEmptyString(fixture.protocol, "Graph reference evidence daemon fixture protocol");
    validateStringArray(fixture.envelopes, "Graph reference evidence daemon fixture envelopes", { allowEmpty: false });
  }
}

function validateGraphReferenceEvidenceBaselineReceipts(receipts: readonly GraphReferenceEvidenceBaselineReceipt[]): void {
  validateNonEmptyArray(receipts, "Graph reference evidence baselineReceipts");
  for (const receipt of receipts) {
    validateGraphReferenceEvidenceSurfaceBase(receipt, "Graph reference evidence baseline receipt");
    validateNonEmptyString(receipt.metric, "Graph reference evidence baseline receipt metric");
    validateNonEmptyString(receipt.receipt, "Graph reference evidence baseline receipt path");
    if (receipt.label !== "reference_evidence_non_implementation_input") {
      throw new Error("Graph reference evidence baseline receipt label must be reference_evidence_non_implementation_input");
    }
    if (receipt.sourceAvailability !== "available" && receipt.sourceAvailability !== "unavailable") {
      throw new Error("Graph reference evidence baseline receipt sourceAvailability must be available or unavailable");
    }
    if (receipt.nonImplementationInput !== true) {
      throw new Error("Graph reference evidence baseline receipt must be non-implementation input");
    }
  }
}

function validateGraphReferenceEvidenceOptionalSurfaces(surfaces: readonly GraphReferenceEvidenceOptionalAnalysisSurface[]): void {
  validateNonEmptyArray(surfaces, "Graph reference evidence optionalAnalysisSurfaces");
  for (const surface of surfaces) {
    validateGraphReferenceEvidenceSurfaceBase(surface, "Graph reference evidence optional analysis surface");
    validateGraphReleaseDeferredChild(surface.issue, "Graph reference evidence optional analysis surface issue");
    if (surface.status !== "deferred") throw new Error("Graph reference evidence optional analysis surface status must be deferred");
    if (surface.classification === "required") {
      throw new Error("Graph reference evidence optional analysis surfaces must not mark staged graph release surfaces as required");
    }
  }
  validateGraphReleaseOptionalAnalysisSurfaceSet(
    surfaces,
    "Graph reference evidence optional analysis surfaces"
  );
}

function validateGraphReferenceEvidenceGoldenCorpus(corpus: GraphReferenceEvidenceGoldenCorpusRef): void {
  validateGraphReferenceEvidenceSurfaceBase(corpus, "Graph reference evidence golden corpus");
  validateNonEmptyString(corpus.fixture, "Graph reference evidence golden corpus fixture");
  validateStringArray(corpus.covers, "Graph reference evidence golden corpus covers", { allowEmpty: false });
}

function validateGraphReferenceEvidenceSurfaceBase(surface: GraphReferenceEvidenceSurfaceBase, label: string): void {
  if (!surface || typeof surface !== "object") throw new Error(`${label} is required`);
  validateNonEmptyString(surface.id, `${label} id`);
  validateGraphReferenceEvidenceSurfaceClassification(surface.classification);
  validateStringArray(surface.fixtures, `${label} fixtures`, { allowEmpty: true });
  if (surface.classification === "required" && surface.fixtures.length === 0) {
    throw new Error(`${label} required surface must include fixture coverage`);
  }
}

function validateGraphReferenceEvidenceExitSemantics(exitSemantics: GraphReferenceEvidenceExitSemantics, label: string): void {
  if (!exitSemantics || typeof exitSemantics !== "object") {
    throw new Error(`${label} exitSemantics is required`);
  }
  if (exitSemantics.success !== 0) throw new Error(`${label} exitSemantics success must be 0`);
  validateNonEmptyString(exitSemantics.failure, `${label} exitSemantics failure`);
}

function validateGraphReferenceEvidenceProvenance(provenance: GraphReferenceEvidenceProvenance): void {
  if (!provenance || typeof provenance !== "object") {
    throw new Error("Graph reference evidence provenance is required");
  }
  if (provenance.containsPythonCrgSource !== false) {
    throw new Error("Graph reference evidence manifest must not contain Python CRG source");
  }
  if (provenance.containsPackageMetadata !== false) {
    throw new Error("Graph reference evidence manifest must not contain Python CRG package metadata");
  }
  if (provenance.containsGitHistory !== false) {
    throw new Error("Graph reference evidence manifest must not contain Python CRG git history");
  }
  if (provenance.referenceReceiptsAreImplementationInput !== false) {
    throw new Error("Graph reference evidence receipts must not be implementation input");
  }
  validateStringArray(provenance.implementationPackageNames, "Graph reference evidence implementationPackageNames", {
    allowEmpty: false
  });
  for (const name of provenance.implementationPackageNames) {
    if (/\bcrg\b|code-review-graph|gungnir/i.test(name)) {
      throw new Error(`Graph reference evidence manifest uses a forbidden implementation package name: ${name}`);
    }
  }
  validateStringArray(provenance.allowedMentionPaths, "Graph reference evidence allowedMentionPaths", { allowEmpty: false });
}

function validateGraphReferenceEvidenceSourceFreeStrings(value: unknown): void {
  const forbidden = [/tirth8205/i, /pyproject\.toml/i, /setup\.py/i, /setup\.cfg/i, /Pipfile/i, /git clone/i];
  for (const text of collectStrings(value)) {
    const pattern = forbidden.find((entry) => entry.test(text));
    if (pattern) throw new Error(`Graph reference evidence manifest contains forbidden source provenance: ${text}`);
  }
}

function validateGraphReleasePackageVersions(versions: readonly GraphReleasePackageVersion[]): void {
  validateNonEmptyArray(versions, "Graph release graphPackageVersions");
  for (const version of versions) {
    if (!version || typeof version !== "object") throw new Error("Graph release package version is required");
    validateNonEmptyString(version.packageName, "Graph release package version packageName");
    validateNonEmptyString(version.version, "Graph release package version version");
  }
  if (!versions.some((version) => version.packageName === "@the-open-engine/opcore-graph")) {
    throw new Error("Graph release package versions must include @the-open-engine/opcore-graph");
  }
}

function validateGraphReleaseCommandCoverage(coverage: readonly GraphReleaseCommandCoverage[]): void {
  validateNonEmptyArray(coverage, "Graph release commandCoverage");
  validateExactStringSet(
    coverage.map((entry) => entry.id),
    graphReleaseCoreCommandIds,
    "Graph release command coverage ids"
  );
  for (const entry of coverage) {
    if (!entry || typeof entry !== "object") throw new Error("Graph release command coverage entry is required");
    validateGraphReleaseCoreCommandId(entry.id);
    if (entry.bin !== "lattice") throw new Error(`Unknown graph release command bin: ${String(entry.bin)}`);
    validateStringArray(entry.command, "Graph release command coverage command", { allowEmpty: false });
    validateStringArray(entry.canonicalCommand, "Graph release command coverage canonicalCommand", { allowEmpty: false });
    if (entry.status !== "passed") throw new Error("Graph release command coverage status must be passed");
    if (entry.exitCode !== 0) throw new Error("Graph release command coverage exitCode must be 0");
    validateNonEmptyString(entry.fixture, "Graph release command coverage fixture");
    if (typeof entry.durationMs !== "number" || entry.durationMs <= 0) {
      throw new Error("Graph release command coverage durationMs must be positive");
    }
    const route = graphReleaseRouteForCommandId(entry.id);
    if (entry.bin !== route.bin) throw new Error(`Graph release command ${entry.id} must use ${route.bin}`);
    if (entry.command.join("\0") !== route.command.join("\0")) {
      throw new Error(`Graph release command ${entry.id} command must be ${route.command.join(" ")}`);
    }
    if (entry.canonicalCommand.join("\0") !== route.canonicalCommand.join("\0")) {
      throw new Error(`Graph release command ${entry.id} canonicalCommand must be ${route.canonicalCommand.join(" ")}`);
    }
  }
}

function validateGraphReleaseDirectSqliteQueries(queries: readonly GraphReleaseDirectSqliteQueryReceipt[]): void {
  validateNonEmptyArray(queries, "Graph release directSqliteQueries");
  validateExactStringSet(
    queries.map((entry) => entry.id),
    graphReleaseDirectSqliteQueryIds,
    "Graph release direct SQLite query ids"
  );
  for (const query of queries) {
    if (!query || typeof query !== "object") throw new Error("Graph release direct SQLite query receipt is required");
    if (!includesString(graphReleaseDirectSqliteQueryIds, query.id)) {
      throw new Error(`Unknown graph release direct SQLite query id: ${String(query.id)}`);
    }
    validateNonEmptyString(query.query, "Graph release direct SQLite query query");
    if (query.status !== "passed") throw new Error("Graph release direct SQLite query status must be passed");
    if (typeof query.rowCount !== "number" || query.rowCount < 0) {
      throw new Error("Graph release direct SQLite query rowCount must be non-negative");
    }
    validateNonEmptyString(query.fixture, "Graph release direct SQLite query fixture");
  }
}

function validateGraphReleaseServeTransport(receipts: readonly GraphReleaseServeTransportReceipt[]): void {
  validateNonEmptyArray(receipts, "Graph release serveTransport");
  validateExactStringSet(
    receipts.map((entry) => entry.id),
    graphReleaseServeTransportIds,
    "Graph release serve transport ids"
  );
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") throw new Error("Graph release serve transport receipt is required");
    validateGraphReleaseServeTransportId(receipt.id);
    if (receipt.protocol !== "lattice.graph.daemon") {
      throw new Error("Graph release serve transport protocol must be lattice.graph.daemon");
    }
    validateNonEmptyString(receipt.operation, "Graph release serve transport operation");
    if (receipt.operation !== graphReleaseOperationForServeTransportId(receipt.id)) {
      throw new Error(`Graph release serve transport ${receipt.id} operation must be ${graphReleaseOperationForServeTransportId(receipt.id)}`);
    }
    if (receipt.status !== "passed") throw new Error("Graph release serve transport status must be passed");
    if (receipt.exitCode !== 0) throw new Error("Graph release serve transport exitCode must be 0");
  }
}

function validateGraphReleaseBenchmarks(benchmarks: readonly GraphReleaseBenchmarkReceipt[]): void {
  validateNonEmptyArray(benchmarks, "Graph release benchmarks");
  validateExactStringSet(
    benchmarks.map((entry) => entry.metric),
    graphReleaseBenchmarkMetrics,
    "Graph release benchmark metrics"
  );
  for (const benchmark of benchmarks) {
    if (!benchmark || typeof benchmark !== "object") throw new Error("Graph release benchmark receipt is required");
    validateGraphReleaseBenchmarkMetric(benchmark.metric);
    if (typeof benchmark.value !== "number" || benchmark.value <= 0) {
      throw new Error("Graph release benchmark value must be positive");
    }
    if (benchmark.unit !== "ms" && benchmark.unit !== "bytes") {
      throw new Error("Graph release benchmark unit must be ms or bytes");
    }
    if (benchmark.metric.endsWith("_bytes") && benchmark.unit !== "bytes") {
      throw new Error(`Graph release benchmark ${benchmark.metric} must use bytes`);
    }
    if (!benchmark.metric.endsWith("_bytes") && benchmark.unit !== "ms") {
      throw new Error(`Graph release benchmark ${benchmark.metric} must use ms`);
    }
    if (benchmark.baselineIssue !== "#19") throw new Error("Graph release benchmark baselineIssue must be #19");
    validateNonEmptyString(benchmark.baselineReceipt, "Graph release benchmark baselineReceipt");
    if (!["recorded", "within_baseline", "above_baseline", "below_baseline"].includes(benchmark.comparison)) {
      throw new Error(`Unknown graph release benchmark comparison: ${String(benchmark.comparison)}`);
    }
  }
}

function validateGraphReleasePackageInspection(inspection: GraphReleasePackageInspection): void {
  if (!inspection || typeof inspection !== "object") throw new Error("Graph release packageInspection is required");
  if (inspection.packageName !== "@the-open-engine/opcore-graph") {
    throw new Error("Graph release packageInspection packageName must be @the-open-engine/opcore-graph");
  }
  validateNonEmptyString(inspection.tarballName, "Graph release packageInspection tarballName");
  if (typeof inspection.fileCount !== "number" || inspection.fileCount <= 0) {
    throw new Error("Graph release packageInspection fileCount must be positive");
  }
  validateStringArray(inspection.files, "Graph release packageInspection files", { allowEmpty: false });
  if (inspection.fileCount !== inspection.files.length) {
    throw new Error("Graph release packageInspection fileCount must equal files length");
  }
  validateStringArray(inspection.inspections, "Graph release packageInspection inspections", { allowEmpty: false });
  for (const key of [
    "forbiddenMarkersAbsent",
    "generatedBuildMetadataAbsent",
    "privatePathsAbsent",
    "pythonCrgSourceAbsent",
    "pythonGraphPackageMetadataAbsent",
    "pythonCrgGitHistoryAbsent",
    "forbiddenImplementationPackageNamesAbsent"
  ] as const) {
    if (inspection[key] !== true) throw new Error(`Graph release packageInspection ${key} must be true`);
  }
}

function validateGraphReleaseNativeArtifacts(nativeArtifacts: readonly GraphReleaseNativeArtifactEvidence[]): void {
  validateNonEmptyArray(nativeArtifacts, "Graph release nativeArtifacts");
  validateExactStringSet(
    nativeArtifacts.map((artifact) => artifact.targetPlatform),
    graphCoreNativeSupportedTargets,
    "Graph release native artifact targets"
  );
  for (const nativeArtifact of nativeArtifacts) {
    if (!nativeArtifact || typeof nativeArtifact !== "object") throw new Error("Graph release native artifact evidence is required");
    const expectedPackageName = graphCoreNativePackageNameForTarget(nativeArtifact.targetPlatform);
    if (nativeArtifact.packageName !== expectedPackageName) {
      throw new Error(`Graph release native artifact packageName for ${nativeArtifact.targetPlatform} must be ${expectedPackageName}`);
    }
    validateGraphProviderArtifactMetadata(nativeArtifact.metadata);
    if (nativeArtifact.metadata.targetPlatform !== nativeArtifact.targetPlatform) {
      throw new Error("Graph release native artifact targetPlatform must match metadata");
    }
    if (nativeArtifact.binaryPath !== "lattice-graph-core") throw new Error("Graph release native binaryPath must be lattice-graph-core");
    if (nativeArtifact.checksumPath !== "lattice-graph-core.sha256") {
      throw new Error("Graph release native checksumPath must be lattice-graph-core.sha256");
    }
    if (nativeArtifact.metadataPath !== "metadata.json") throw new Error("Graph release native metadataPath must be metadata.json");
    if (nativeArtifact.metadata.binaryPath !== nativeArtifact.binaryPath) {
      throw new Error("Graph release native artifact binaryPath must match metadata");
    }
    if (nativeArtifact.metadata.checksumPath !== nativeArtifact.checksumPath) {
      throw new Error("Graph release native artifact checksumPath must match metadata");
    }
    if (nativeArtifact.metadata.checksumSha256 !== nativeArtifact.binarySha256) {
      throw new Error("Graph release native artifact metadata checksum must match binary sha256");
    }
    validateSha256(nativeArtifact.binarySha256, "Graph release native artifact binarySha256");
    validateSha256(nativeArtifact.checksumFileSha256, "Graph release native artifact checksumFileSha256");
    validateSha256(nativeArtifact.metadataSha256, "Graph release native artifact metadataSha256");
    validateExactStringSet(
      nativeArtifact.packageFiles,
      ["package.json", "README.md", "lattice-graph-core", "lattice-graph-core.sha256", "metadata.json"],
      `Graph release native package files ${nativeArtifact.targetPlatform}`
    );
  }
}

function validateGraphReleaseReportReceipts(receipts: readonly GraphReleaseReportReceipt[]): void {
  validateNonEmptyArray(receipts, "Graph release reportReceipts");
  validateExactStringSet(
    receipts.map((entry) => entry.id),
    graphReleaseReportReceiptIds,
    "Graph release report receipt ids"
  );
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") throw new Error("Graph release report receipt is required");
    if (!includesString(graphReleaseReportReceiptIds, receipt.id)) {
      throw new Error(`Unknown graph release report receipt id: ${String(receipt.id)}`);
    }
    validateStringArray(receipt.command, "Graph release report receipt command", { allowEmpty: false });
    if (receipt.status !== "passed") throw new Error("Graph release report receipt status must be passed");
    if (receipt.exitCode !== 0) throw new Error("Graph release report receipt exitCode must be 0");
    validateNonEmptyString(receipt.path, "Graph release report receipt path");
    if (receipt.checksumSha256 !== undefined) validateNonEmptyString(receipt.checksumSha256, "Graph release report receipt checksumSha256");
  }
}

function validateGraphReleaseOptionalSurfaces(surfaces: readonly GraphReleaseOptionalSurfaceReceipt[]): void {
  validateNonEmptyArray(surfaces, "Graph release optionalSurfaces");
  for (const surface of surfaces) {
    if (!surface || typeof surface !== "object") throw new Error("Graph release optional surface is required");
    validateGraphReleaseDeferredChild(surface.issue, "Graph release optional surface issue");
    validateNonEmptyString(surface.id, "Graph release optional surface id");
    validateGraphReferenceEvidenceSurfaceClassification(surface.classification);
    if (surface.status !== "unsupported" && surface.status !== "deferred") {
      throw new Error("Graph release optional surface status must be unsupported or deferred");
    }
    if (surface.classification === "required") {
      throw new Error("Graph release optional surfaces must not mark staged graph release surfaces as required");
    }
  }
  validateGraphReleaseOptionalAnalysisSurfaceSet(surfaces, "Graph release optional surfaces");
}

function validateGraphReleaseOptionalAnalysisSurfaceSet(
  surfaces: readonly Pick<GraphReleaseOptionalSurfaceReceipt, "issue" | "id" | "classification" | "status">[],
  label: string
): void {
  const actual = surfaces.map(graphReleaseOptionalSurfaceKey).sort();
  const expected = graphReleaseOptionalAnalysisSurfaces.map(graphReleaseOptionalSurfaceKey).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} must match staged graph release surfaces`);
  }
}

function graphReleaseOptionalSurfaceKey(
  surface: Pick<GraphReleaseOptionalSurfaceReceipt, "issue" | "id" | "classification" | "status">
): string {
  return `${surface.issue}:${surface.id}:${surface.classification}:${surface.status}`;
}

function validateGraphReleaseDeferredChild(issue: unknown, label = "Graph release deferred child"): GraphReleaseDeferredChild {
  if (!includesString(graphReleaseDeferredChildren, issue)) {
    throw new Error(`${label} must be one of ${graphReleaseDeferredChildren.join(", ")}`);
  }
  return issue;
}

function validateGraphReleaseHandoff(handoff: readonly GraphReleaseHandoffReceipt[]): void {
  validateNonEmptyArray(handoff, "Graph release handoff");
  validateExactStringSet(
    handoff.map((entry) => entry.issue),
    graphReleaseHandoffIssues,
    "Graph release handoff issues"
  );
  for (const entry of handoff) {
    if (!entry || typeof entry !== "object") throw new Error("Graph release handoff entry is required");
    validateGraphReleaseHandoffIssue(entry.issue);
    validateNonEmptyString(entry.receiptPath, "Graph release handoff receiptPath");
    validateNonEmptyString(entry.checksumSha256, "Graph release handoff checksumSha256");
    validateNonEmptyString(entry.rollbackNote, "Graph release handoff rollbackNote");
  }
}

function validateGraphReleaseCoreCommandId(id: unknown): GraphReleaseCoreCommandId {
  if (!includesString(graphReleaseCoreCommandIds, id)) {
    throw new Error(`Unknown graph release command id: ${String(id)}`);
  }
  return id;
}

function validateGraphReleaseBenchmarkMetric(metric: unknown): GraphReleaseBenchmarkMetric {
  if (!includesString(graphReleaseBenchmarkMetrics, metric)) {
    throw new Error(`Unknown graph release benchmark metric: ${String(metric)}`);
  }
  return metric;
}

function validateGraphReleaseHandoffIssue(issue: unknown): GraphReleaseHandoffIssue {
  if (!includesString(graphReleaseHandoffIssues, issue)) {
    throw new Error(`Unknown graph release handoff issue: ${String(issue)}`);
  }
  return issue;
}

function validateGraphReleaseServeTransportId(id: unknown): GraphReleaseServeTransportId {
  if (!includesString(graphReleaseServeTransportIds, id)) {
    throw new Error(`Unknown graph release serve transport id: ${String(id)}`);
  }
  return id;
}

function graphReleaseOperationForServeTransportId(id: GraphReleaseServeTransportId): string {
  return id.replace("serve-jsonl-", "");
}

function graphReleaseRouteForCommandId(id: GraphReleaseCoreCommandId): {
  bin: "lattice";
  command: readonly string[];
  canonicalCommand: readonly string[];
} {
  const command = id.replace("lattice-graph-", "");
  return {
    bin: "lattice",
    command: ["graph", command],
    canonicalCommand: ["lattice", "graph", command]
  };
}

function validateReleaseReceiptPackages(packages: readonly ReleaseReceiptPackageEvidence[]): void {
  validateNonEmptyArray(packages, "Release receipt package evidence");
  validateExactStringSet(
    packages.map((entry) => entry.packageName),
    releaseReceiptPackageNames,
    "Release receipt package evidence"
  );
  for (const packageEvidence of packages) validateReleaseReceiptPackage(packageEvidence);
}

function validateReleaseReceiptPackage(packageEvidence: ReleaseReceiptPackageEvidence): void {
  if (!packageEvidence || typeof packageEvidence !== "object") throw new Error("Release receipt package evidence entry is required");
  validateReleaseReceiptPackageName(packageEvidence.packageName, "Release receipt package evidence packageName");
  validateRepoRelativePath(packageEvidence.packageRoot);
  validateNonEmptyString(packageEvidence.version, "Release receipt package evidence version");
  validateReleaseReceiptPackageManifest(packageEvidence.manifest, packageEvidence.packageName);
  validateReleaseReceiptTarball(packageEvidence.tarball);
  validateStringArray(packageEvidence.files, "Release receipt package evidence files", { allowEmpty: false });
  validateStringArray(packageEvidence.expectedFiles, "Release receipt package evidence expectedFiles", { allowEmpty: false });
  if (!Number.isInteger(packageEvidence.fileCount) || packageEvidence.fileCount !== packageEvidence.files.length) {
    throw new Error("Release receipt package evidence fileCount must equal files length");
  }
  if (!Number.isInteger(packageEvidence.expectedFileCount) || packageEvidence.expectedFileCount !== packageEvidence.expectedFiles.length) {
    throw new Error("Release receipt package evidence expectedFileCount must equal expectedFiles length");
  }
  validateExactStringSet(packageEvidence.files, packageEvidence.expectedFiles, `${packageEvidence.packageName} packed files`);
  validateReleaseReceiptBins(packageEvidence.bins, packageEvidence.packageName);
  for (const descriptorReference of packageEvidence.descriptorReferences) {
    validateManagedToolDescriptorPackageReference(descriptorReference, packageEvidence.packageName);
    if (!packageEvidence.files.includes(descriptorReference.path)) {
      throw new Error(`Release receipt descriptor reference ${descriptorReference.id} is not in ${packageEvidence.packageName} packed files`);
    }
  }
  if (isGraphCoreNativePackageName(packageEvidence.packageName)) {
    validateNonEmptyArray(packageEvidence.nativeArtifacts, "Release receipt native package artifacts");
    validateExactStringSet(
      packageEvidence.nativeArtifacts.map((entry) => entry.packageName),
      [packageEvidence.packageName],
      `${packageEvidence.packageName} native artifact packageName`
    );
  } else if (packageEvidence.nativeArtifacts.length > 0) {
    throw new Error(`${packageEvidence.packageName} must not report native graph artifacts`);
  }
  for (const nativeArtifact of packageEvidence.nativeArtifacts) validateReleaseReceiptNativeArtifact(nativeArtifact);
}

function validateReleaseReceiptPackageManifest(
  manifest: ReleaseReceiptPackageManifestMetadata,
  packageName: ReleaseReceiptPackageName
): void {
  if (!manifest || typeof manifest !== "object") throw new Error("Release receipt package manifest is required");
  if (manifest.name !== packageName) throw new Error(`Release receipt package manifest name must match ${packageName}`);
  if (manifest.name.includes("crg") || manifest.name.includes("cix") || manifest.name.includes("rox")) {
    throw new Error(`Release receipt package manifest uses old public package identity: ${manifest.name}`);
  }
  validateNonEmptyString(manifest.version, "Release receipt package manifest version");
  validateNonEmptyString(manifest.license, "Release receipt package manifest license");
  if (isGraphCoreNativePackageName(packageName)) {
    if (manifest.main !== undefined || manifest.types !== undefined) {
      throw new Error("Release receipt native package manifest must not declare main or types");
    }
  } else {
    if (manifest.main === undefined || manifest.types === undefined) {
      throw new Error("Release receipt package manifest must declare main and types");
    }
    validateRepoRelativePath(manifest.main);
    validateRepoRelativePath(manifest.types);
  }
  validateStringArray(manifest.files, "Release receipt package manifest files", { allowEmpty: false });
  validateReleaseReceiptBins(manifest.bins, packageName);
  validateStringRecord(manifest.dependencies, "Release receipt package manifest dependencies");
  if (manifest.optionalDependencies !== undefined) {
    validateStringRecord(manifest.optionalDependencies, "Release receipt package manifest optionalDependencies");
  }
  validateStringArray(manifest.bundledDependencies, "Release receipt package manifest bundledDependencies", { allowEmpty: true });
}

function validateReleaseReceiptTarball(tarball: ReleaseReceiptTarballEvidence): void {
  if (!tarball || typeof tarball !== "object") throw new Error("Release receipt tarball evidence is required");
  validateNonEmptyString(tarball.filename, "Release receipt tarball filename");
  validateRepoRelativePath(tarball.path);
  validateSha256(tarball.sha256, "Release receipt tarball sha256");
  if (tarball.integrity !== undefined) validateNonEmptyString(tarball.integrity, "Release receipt tarball integrity");
  if (tarball.shasum !== undefined) validateNonEmptyString(tarball.shasum, "Release receipt tarball shasum");
}

function validateReleaseReceiptDescriptor(
  descriptorEvidence: ReleaseReceiptDescriptorEvidence,
  packages: readonly ReleaseReceiptPackageEvidence[]
): void {
  if (!descriptorEvidence || typeof descriptorEvidence !== "object") throw new Error("Release receipt descriptor evidence is required");
  validateRepoRelativePath(descriptorEvidence.path);
  if (descriptorEvidence.packageName !== "@the-open-engine/opcore") {
    throw new Error("Release receipt descriptor packageName must be @the-open-engine/opcore");
  }
  validateSha256(descriptorEvidence.checksumSha256, "Release receipt descriptor checksumSha256");
  const descriptor = validateManagedToolDescriptor(descriptorEvidence.descriptor);
  validateExactStringSet(
    descriptorEvidence.commandGroups.map((entry) => entry.name),
    releaseReceiptCommandGroups,
    "Release receipt descriptor command groups"
  );
  for (const group of descriptorEvidence.commandGroups) {
    validateReleaseReceiptCommandGroupName(group.name, "Release receipt descriptor command group name");
    validateExactStringSequence(group.canonicalCommand, ["lattice", group.name], `Release receipt descriptor ${group.name} canonicalCommand`);
    const descriptorGroup = descriptor.commandGroups.find((entry) => entry.name === group.name);
    if (!descriptorGroup) throw new Error(`Release receipt descriptor command group missing from descriptor: ${group.name}`);
    if (group.packageName !== descriptorGroup.packageName) {
      throw new Error(`Release receipt descriptor command group ${group.name} packageName must match descriptor`);
    }
  }
  validateReleaseResolvedArtifacts(descriptorEvidence.resolvedArtifacts, descriptor.artifacts, packages);
  validateReleaseResolvedChecksums(descriptorEvidence.resolvedChecksums, descriptor.checksums, packages);
}

function validateReleaseResolvedArtifacts(
  resolvedArtifacts: readonly ReleaseReceiptResolvedArtifactEvidence[],
  descriptorArtifacts: readonly ManagedToolDescriptorArtifactReference[],
  packages: readonly ReleaseReceiptPackageEvidence[]
): void {
  validateNonEmptyArray(resolvedArtifacts, "Release receipt descriptor resolvedArtifacts");
  validateExactStringSet(
    resolvedArtifacts.map((entry) => entry.id),
    descriptorArtifacts.map((entry) => entry.id),
    "Release receipt descriptor resolved artifact ids"
  );
  for (const resolved of resolvedArtifacts) {
    validateReleaseReceiptPackageName(resolved.packageName, "Release receipt descriptor resolved artifact packageName");
    validateRepoRelativePath(resolved.path);
    if (!includesString(managedToolDescriptorArtifactTypes, resolved.type)) {
      throw new Error(`Unknown release receipt descriptor resolved artifact type: ${String(resolved.type)}`);
    }
    if (resolved.packageFile !== true) throw new Error(`Release receipt resolved artifact ${resolved.id} must resolve to a package file`);
    const descriptorArtifact = descriptorArtifacts.find((entry) => entry.id === resolved.id);
    if (!descriptorArtifact) throw new Error(`Release receipt resolved artifact is not declared by descriptor: ${resolved.id}`);
    if (
      descriptorArtifact.packageName !== resolved.packageName ||
      descriptorArtifact.path !== resolved.path ||
      descriptorArtifact.type !== resolved.type ||
      descriptorArtifact.required !== resolved.required ||
      descriptorArtifact.checksumRef !== resolved.checksumRef
    ) {
      throw new Error(`Release receipt resolved artifact must mirror descriptor: ${resolved.id}`);
    }
    if (!packageEvidenceIncludesFile(packages, resolved.packageName, resolved.path)) {
      throw new Error(`Release receipt resolved artifact ${resolved.id} is not present in packed package files`);
    }
  }
}

function validateReleaseResolvedChecksums(
  resolvedChecksums: readonly ReleaseReceiptResolvedChecksumEvidence[],
  descriptorChecksums: readonly ManagedToolDescriptorChecksumReference[],
  packages: readonly ReleaseReceiptPackageEvidence[]
): void {
  validateNonEmptyArray(resolvedChecksums, "Release receipt descriptor resolvedChecksums");
  validateExactStringSet(
    resolvedChecksums.map((entry) => entry.id),
    descriptorChecksums.map((entry) => entry.id),
    "Release receipt descriptor resolved checksum ids"
  );
  for (const resolved of resolvedChecksums) {
    validateReleaseReceiptPackageName(resolved.packageName, "Release receipt descriptor resolved checksum packageName");
    validateRepoRelativePath(resolved.path);
    if (resolved.algorithm !== "sha256") throw new Error("Release receipt descriptor checksum algorithm must be sha256");
    if (resolved.packageFile !== true) throw new Error(`Release receipt resolved checksum ${resolved.id} must resolve to a package file`);
    validateSha256(resolved.value, "Release receipt descriptor checksum value");
    const descriptorChecksum = descriptorChecksums.find((entry) => entry.id === resolved.id);
    if (!descriptorChecksum) throw new Error(`Release receipt resolved checksum is not declared by descriptor: ${resolved.id}`);
    if (
      descriptorChecksum.packageName !== resolved.packageName ||
      descriptorChecksum.path !== resolved.path ||
      descriptorChecksum.algorithm !== resolved.algorithm ||
      descriptorChecksum.artifactRef !== resolved.artifactRef ||
      descriptorChecksum.required !== resolved.required
    ) {
      throw new Error(`Release receipt resolved checksum must mirror descriptor: ${resolved.id}`);
    }
    if (descriptorChecksum.value !== undefined && descriptorChecksum.value !== resolved.value) {
      throw new Error(`Release receipt resolved checksum value must match descriptor: ${resolved.id}`);
    }
    if (!packageEvidenceIncludesFile(packages, resolved.packageName, resolved.path)) {
      throw new Error(`Release receipt resolved checksum ${resolved.id} is not present in packed package files`);
    }
  }
}

function validateReleaseReceiptNativeArtifacts(
  nativeArtifacts: readonly ReleaseReceiptNativeArtifactEvidence[],
  packages: readonly ReleaseReceiptPackageEvidence[],
  descriptorEvidence: ReleaseReceiptDescriptorEvidence
): void {
  validateNonEmptyArray(nativeArtifacts, "Release receipt native artifacts");
  validateExactStringSet(
    nativeArtifacts.map((artifact) => artifact.targetPlatform),
    graphCoreNativeSupportedTargets,
    "Release receipt native artifact targets"
  );
  for (const nativeArtifact of nativeArtifacts) {
    validateReleaseReceiptNativeArtifact(nativeArtifact);
    if (!packageEvidenceIncludesFile(packages, nativeArtifact.packageName, nativeArtifact.binaryPath)) {
      throw new Error("Release receipt native artifact binary must be present in native package files");
    }
    if (!packageEvidenceIncludesFile(packages, nativeArtifact.packageName, nativeArtifact.checksumPath)) {
      throw new Error("Release receipt native artifact checksum must be present in native package files");
    }
    if (!packageEvidenceIncludesFile(packages, nativeArtifact.packageName, nativeArtifact.metadataPath)) {
      throw new Error("Release receipt native artifact metadata must be present in native package files");
    }
    const binaryArtifact = descriptorEvidence.resolvedArtifacts.find((artifact) => artifact.id === nativeArtifact.descriptorArtifactId);
    if (!binaryArtifact || binaryArtifact.packageName !== nativeArtifact.packageName || binaryArtifact.path !== nativeArtifact.binaryPath) {
      throw new Error("Release receipt native artifact binary must resolve from descriptor artifacts");
    }
    const checksum = descriptorEvidence.resolvedChecksums.find((entry) => entry.id === nativeArtifact.descriptorChecksumId);
    if (
      !checksum ||
      checksum.packageName !== nativeArtifact.packageName ||
      checksum.path !== nativeArtifact.checksumPath ||
      checksum.value !== nativeArtifact.binarySha256
    ) {
      throw new Error("Release receipt native artifact checksum must resolve from descriptor checksum evidence");
    }
  }
}

function validateReleaseReceiptNativeArtifact(nativeArtifact: ReleaseReceiptNativeArtifactEvidence): void {
  if (!nativeArtifact || typeof nativeArtifact !== "object") throw new Error("Release receipt native artifact evidence is required");
  if (!isGraphCoreNativePackageName(nativeArtifact.packageName)) {
    throw new Error("Release receipt native artifact packageName must be an Opcore graph-core native package");
  }
  const expectedTarget = graphCoreNativeTargetForPackageName(nativeArtifact.packageName);
  if (nativeArtifact.targetPlatform !== expectedTarget) {
    throw new Error(`Release receipt native artifact targetPlatform must be ${expectedTarget}`);
  }
  validateGraphProviderArtifactMetadata(nativeArtifact.metadata);
  validateRepoRelativePath(nativeArtifact.binaryPath);
  validateRepoRelativePath(nativeArtifact.checksumPath);
  validateRepoRelativePath(nativeArtifact.metadataPath);
  validateSha256(nativeArtifact.binarySha256, "Release receipt native artifact binarySha256");
  validateSha256(nativeArtifact.checksumFileSha256, "Release receipt native artifact checksumFileSha256");
  validateSha256(nativeArtifact.metadataSha256, "Release receipt native artifact metadataSha256");
  validateNonEmptyString(nativeArtifact.descriptorArtifactId, "Release receipt native artifact descriptorArtifactId");
  validateNonEmptyString(nativeArtifact.descriptorChecksumId, "Release receipt native artifact descriptorChecksumId");
  if (nativeArtifact.metadata.targetPlatform !== nativeArtifact.targetPlatform) {
    throw new Error("Release receipt native artifact targetPlatform must match metadata");
  }
  if (nativeArtifact.metadata.binaryPath !== nativeArtifact.binaryPath) {
    throw new Error("Release receipt native artifact binaryPath must match metadata");
  }
  if (nativeArtifact.metadata.checksumPath !== nativeArtifact.checksumPath) {
    throw new Error("Release receipt native artifact checksumPath must match metadata");
  }
  if (nativeArtifact.metadata.checksumSha256 !== nativeArtifact.binarySha256) {
    throw new Error("Release receipt native artifact binary sha256 must match metadata checksum");
  }
}

function validateReleaseReceiptLicense(license: ReleaseReceiptLicenseEvidence): void {
  if (!license || typeof license !== "object") throw new Error("Release receipt license evidence is required");
  validateRepoRelativePath(license.reportPath);
  validateSha256(license.reportSha256, "Release receipt license reportSha256");
  validateNonNegativeInteger(license.productionDependencyCount, "Release receipt license productionDependencyCount");
  validateNonNegativeInteger(license.bundledDependencyCount, "Release receipt license bundledDependencyCount");
  validateNonNegativeInteger(license.workspacePackageCount, "Release receipt license workspacePackageCount");
  if (license.workspacePackageCount !== releaseReceiptPackageNames.length) {
    throw new Error(`Release receipt license workspacePackageCount must be ${releaseReceiptPackageNames.length}`);
  }
  if (license.unresolvedLicenseCount !== 0) throw new Error("Release receipt license unresolvedLicenseCount must be 0");
  if (!Array.isArray(license.packages)) throw new Error("Release receipt license packages must be an array");
  for (const packageEvidence of license.packages) {
    validateNonEmptyString(packageEvidence.name, "Release receipt license package name");
    validateNonEmptyString(packageEvidence.version, "Release receipt license package version");
    validateNonEmptyString(packageEvidence.license, "Release receipt license package license");
    validateNonEmptyString(packageEvidence.source, "Release receipt license package source");
    if (typeof packageEvidence.bundled !== "boolean") throw new Error("Release receipt license package bundled must be boolean");
  }
}

function validateReleaseReceiptProvenance(provenance: ReleaseReceiptProvenanceEvidence): void {
  if (!provenance || typeof provenance !== "object") throw new Error("Release receipt provenance evidence is required");
  validateRepoRelativePath(provenance.reportPath);
  validateSha256(provenance.reportSha256, "Release receipt provenance reportSha256");
  validateNonNegativeInteger(provenance.scannedFileCount, "Release receipt provenance scannedFileCount");
  validateNonNegativeInteger(provenance.historyCommitCount, "Release receipt provenance historyCommitCount");
  if (provenance.findingCount !== 0 || provenance.findings.length !== 0) {
    throw new Error("Release receipt provenance findings must be empty");
  }
}

function validateReleaseReceiptSecretHistory(secretHistory: ReleaseReceiptSecretHistoryEvidence): void {
  if (!secretHistory || typeof secretHistory !== "object") throw new Error("Release receipt secret history evidence is required");
  validateRepoRelativePath(secretHistory.allowlistPath);
  validateSha256(secretHistory.allowlistSha256, "Release receipt secret history allowlistSha256");
  validateNonNegativeInteger(secretHistory.currentTreeScannedFileCount, "Release receipt secret history currentTreeScannedFileCount");
  validateNonNegativeInteger(secretHistory.gitHistoryScannedCommitCount, "Release receipt secret history gitHistoryScannedCommitCount");
  if (secretHistory.findingCount !== 0 || secretHistory.findings.length !== 0) {
    throw new Error("Release receipt secret findings must be empty");
  }
}

function validateReleaseReceiptReports(reports: readonly ReleaseReceiptReport[]): void {
  validateNonEmptyArray(reports, "Release receipt reports");
  validateExactStringSet(
    reports.map((entry) => entry.id),
    releaseReceiptReportIds,
    "Release receipt reports"
  );
  for (const report of reports) {
    validateReleaseReceiptReportId(report.id, "Release receipt report id");
    validateStringArray(report.command, "Release receipt report command", { allowEmpty: false });
    if (report.status !== "passed") throw new Error("Release receipt report status must be passed");
    if (report.exitCode !== 0) throw new Error("Release receipt report exitCode must be 0");
    if (report.path !== undefined) validateRepoRelativePath(report.path);
    if (report.checksumSha256 !== undefined) validateSha256(report.checksumSha256, "Release receipt report checksumSha256");
    validateNonEmptyString(report.summary, "Release receipt report summary");
  }
}

function validateReleaseReceiptGraphReleaseEvidence(evidence: ReleaseReceiptGraphReleaseEvidence): void {
  if (!evidence || typeof evidence !== "object") throw new Error("Release receipt graph release evidence is required");
  validateRepoRelativePath(evidence.path);
  if (evidence.issue !== "#17") throw new Error("Release receipt graph release evidence issue must be #17");
  validateSha256(evidence.checksumSha256, "Release receipt graph release checksumSha256");
}

function validateReleaseReceiptBins(bins: Readonly<Record<string, string>>, packageName: ReleaseReceiptPackageName): void {
  if (!bins || typeof bins !== "object" || Array.isArray(bins)) throw new Error("Release receipt bins must be an object");
  const binNames = Object.keys(bins);
  for (const bin of binNames) {
    validateNonEmptyString(bin, "Release receipt bin name");
    if (["crg", "cix", "rox"].includes(bin)) throw new Error(`Release receipt package exposes old public bin ${bin}`);
    validateRepoRelativePath(bins[bin]);
  }
  if (packageName === "@the-open-engine/opcore") {
    validateExactStringSet(binNames, ["lattice", "opcore"], "Release receipt Opcore package bins");
  } else if (packageName === "@the-open-engine/opcore-asp-provider") {
    validateExactStringSet(binNames, ["opcore-asp-provider"], "Release receipt ASP provider package bins");
  } else if (binNames.length > 0) {
    throw new Error(`${packageName} must not expose CLI bins`);
  }
}

function validateReleaseCutoverInstalledPackages(packages: readonly ReleaseCutoverInstalledPackageEvidence[]): void {
  validateNonEmptyArray(packages, "Release cutover installed package evidence");
  validateReleaseCutoverInstalledPackageSet(packages.map((entry) => entry.packageName));
  for (const entry of packages) {
    if (!entry || typeof entry !== "object") throw new Error("Release cutover installed package evidence entry is required");
    validateReleaseReceiptPackageName(entry.packageName, "Release cutover installed package packageName");
    validateNonEmptyString(entry.version, "Release cutover installed package version");
    if (!entry.tarball || typeof entry.tarball !== "object") throw new Error("Release cutover tarball evidence is required");
    validateNonEmptyString(entry.tarball.filename, "Release cutover tarball filename");
    validateSha256(entry.tarball.sha256, "Release cutover tarball sha256");
    if (!entry.installedManifest || typeof entry.installedManifest !== "object") {
      throw new Error("Release cutover installed manifest evidence is required");
    }
    validateNonEmptyString(entry.installedManifest.path, "Release cutover installed manifest path");
    if (!entry.installedManifest.path.includes("node_modules/") || !entry.installedManifest.path.endsWith("package.json")) {
      throw new Error("Release cutover installed manifest path must be inside node_modules and end with package.json");
    }
    validateSha256(entry.installedManifest.sha256, "Release cutover installed manifest sha256");
    validateReleaseReceiptBins(entry.installedManifest.bins, entry.packageName);
    validateReleaseCutoverInstalledFiles(entry);
  }
}

function validateReleaseCutoverInstalledFiles(entry: ReleaseCutoverInstalledPackageEvidence): void {
  validateNonEmptyArray(entry.installedFiles, "Release cutover installed files");
  const prefix = `node_modules/${entry.packageName}/`;
  const paths = [];
  for (const file of entry.installedFiles) {
    if (!file || typeof file !== "object") throw new Error("Release cutover installed file evidence entry is required");
    validateNonEmptyString(file.path, "Release cutover installed file path");
    if (!file.path.startsWith(prefix)) {
      throw new Error(`Release cutover installed file path must be inside ${prefix}`);
    }
    validateSha256(file.sha256, "Release cutover installed file sha256");
    paths.push(file.path);
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("Release cutover installed file paths must be unique");
  }
  if (!paths.includes(entry.installedManifest.path)) {
    throw new Error("Release cutover installed files must include package.json");
  }
  const binPaths = Object.values(entry.installedManifest.bins).map((path) => `${prefix}${path}`);
  for (const binPath of binPaths) {
    if (!paths.includes(binPath)) throw new Error(`Release cutover installed files must include bin target ${binPath}`);
  }
  if (
    entry.packageName === "@the-open-engine/opcore-asp-provider" &&
    !paths.includes("node_modules/@the-open-engine/opcore-asp-provider/dist/manifests/asp-server.json")
  ) {
    throw new Error("Release cutover ASP provider installed files must include canonical asp-server.json");
  }
}

function validateReleaseCutoverInstalledPackageSet(packageNames: readonly string[]): void {
  const nativePackages = packageNames.filter((packageName) => includesString(graphCoreNativePackageNames, packageName));
  if (nativePackages.length !== 1) {
    throw new Error("Release cutover installed package evidence must include exactly one platform native package");
  }
  const requiredPortablePackages = releaseReceiptPackageNames.filter((packageName) => !includesString(graphCoreNativePackageNames, packageName));
  validateExactStringSet(
    packageNames.filter((packageName) => !includesString(graphCoreNativePackageNames, packageName)),
    requiredPortablePackages,
    "Release cutover portable installed package evidence"
  );
  for (const packageName of packageNames) {
    validateReleaseReceiptPackageName(packageName, "Release cutover installed package packageName");
  }
}

function validateReleaseCutoverDescriptor(descriptorEvidence: ReleaseCutoverDescriptorEvidence): void {
  if (!descriptorEvidence || typeof descriptorEvidence !== "object") throw new Error("Release cutover descriptor evidence is required");
  validateNonEmptyString(descriptorEvidence.path, "Release cutover descriptor path");
  if (descriptorEvidence.packageName !== "@the-open-engine/opcore") {
    throw new Error("Release cutover descriptor packageName must be @the-open-engine/opcore");
  }
  validateSha256(descriptorEvidence.checksumSha256, "Release cutover descriptor checksumSha256");
  const descriptor = validateManagedToolDescriptor(descriptorEvidence.descriptor);
  validateNonEmptyArray(descriptorEvidence.resolvedArtifacts, "Release cutover descriptor resolvedArtifacts");
  validateExactStringSet(
    descriptorEvidence.resolvedArtifacts.map((entry) => entry.id),
    descriptor.artifacts.map((entry) => entry.id),
    "Release cutover descriptor resolved artifact ids"
  );
  for (const artifact of descriptorEvidence.resolvedArtifacts) {
    validateReleaseReceiptPackageName(artifact.packageName, "Release cutover descriptor resolved artifact packageName");
    validateNonEmptyString(artifact.path, "Release cutover descriptor resolved artifact path");
    validateNonEmptyString(artifact.id, "Release cutover descriptor resolved artifact id");
    if (!includesString(managedToolDescriptorArtifactTypes, artifact.type)) {
      throw new Error(`Unknown release cutover descriptor resolved artifact type: ${String(artifact.type)}`);
    }
    if (artifact.packageFile !== true) throw new Error("Release cutover descriptor resolved artifacts must be package files");
  }
  validateNonEmptyArray(descriptorEvidence.resolvedChecksums, "Release cutover descriptor resolvedChecksums");
  validateExactStringSet(
    descriptorEvidence.resolvedChecksums.map((entry) => entry.id),
    descriptor.checksums.map((entry) => entry.id),
    "Release cutover descriptor resolved checksum ids"
  );
  for (const checksum of descriptorEvidence.resolvedChecksums) {
    validateReleaseReceiptPackageName(checksum.packageName, "Release cutover descriptor resolved checksum packageName");
    validateNonEmptyString(checksum.path, "Release cutover descriptor resolved checksum path");
    validateNonEmptyString(checksum.id, "Release cutover descriptor resolved checksum id");
    if (checksum.algorithm !== "sha256") throw new Error("Release cutover descriptor checksum algorithm must be sha256");
    validateSha256(checksum.value, "Release cutover descriptor resolved checksum value");
    if (checksum.packageFile !== true) throw new Error("Release cutover descriptor resolved checksums must be package files");
  }
}

function validateReleaseCutoverEnvironmentIsolation(environment: ReleaseCutoverEnvironmentIsolationEvidence): void {
  if (!environment || typeof environment !== "object") throw new Error("Release cutover environmentIsolation is required");
  if (environment.currentToolEnvCleared !== true) throw new Error("Release cutover current-tool environment must be cleared");
  if (!Number.isInteger(environment.clearedEnvVarCount) || environment.clearedEnvVarCount < 5) {
    throw new Error("Release cutover clearedEnvVarCount must be at least 5");
  }
  if (environment.pathSanitized !== true) throw new Error("Release cutover PATH must be sanitized");
  if (environment.aceRuntimeBinExcluded !== true) throw new Error("Release cutover ACE runtime bin must be excluded");
  if (environment.siblingCovibesExcluded !== true) throw new Error("Release cutover sibling Covibes paths must be excluded");
  if (environment.latticeBinOnly !== true) throw new Error("Release cutover installed project must expose only lattice bin");
  const oldBins = environment.oldBinsAbsent;
  if (!oldBins || oldBins.crg !== true || oldBins.cix !== true || oldBins.rox !== true) {
    throw new Error("Release cutover old public bins must be absent");
  }
}

function validateReleaseCutoverCommandReceipts(receipts: readonly ReleaseCutoverCommandReceipt[]): void {
  validateNonEmptyArray(receipts, "Release cutover command receipts");
  validateExactStringSet(
    receipts.map((entry) => entry.id),
    releaseCutoverRequiredCommandIds,
    "Release cutover command receipts"
  );
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") throw new Error("Release cutover command receipt is required");
    if (!includesString(releaseCutoverRequiredCommandIds, receipt.id)) {
      throw new Error(`Unknown release cutover command receipt id: ${String(receipt.id)}`);
    }
    validateStringArray(receipt.command, "Release cutover command receipt command", { allowEmpty: false });
    validateStringArray(receipt.canonicalCommand, "Release cutover command receipt canonicalCommand", { allowEmpty: false });
    validateExactStringSequence(receipt.command, receipt.canonicalCommand, `Release cutover ${receipt.id} command`);
    const expected = releaseCutoverCommandExpectations[receipt.id];
    if (receipt.command[0] !== expected.bin) {
      throw new Error(`Release cutover command ${receipt.id} command must use canonical ${expected.bin} bin`);
    }
    if (receipt.canonicalCommand[0] !== expected.bin) {
      throw new Error(`Release cutover command ${receipt.id} canonicalCommand must use canonical ${expected.bin} bin`);
    }
    validateCommandOwner(receipt.owner);
    validateReleaseCutoverExpectedCommand(receipt.canonicalCommand, expected, receipt.id);
    if (receipt.owner !== expected.owner) {
      throw new Error(`Release cutover command ${receipt.id} owner must match expected ${expected.owner}`);
    }
    const status = validateCommandRouteStatus(receipt.status);
    if (receipt.status === "not_implemented") {
      throw new Error("Release cutover command receipts must not be not_implemented");
    }
    if (status !== expected.status) {
      throw new Error(`Release cutover command ${receipt.id} status must match expected ${expected.status}`);
    }
    validateExitCodeForStatus(receipt.exitCode, status);
    if (receipt.exitCode !== expected.exitCode) {
      throw new Error(`Release cutover command ${receipt.id} exitCode must match expected ${expected.exitCode}`);
    }
    validateNonEmptyString(receipt.binPath, "Release cutover command receipt binPath");
    if (!receipt.binPath.endsWith(`node_modules/.bin/${expected.bin}`)) {
      throw new Error(`Release cutover command receipt binPath must use installed node_modules/.bin/${expected.bin}`);
    }
    validateSha256(receipt.stdoutSha256, "Release cutover command receipt stdoutSha256");
    validateSha256(receipt.stderrSha256, "Release cutover command receipt stderrSha256");
    validateNonEmptyString(receipt.assertion, "Release cutover command receipt assertion");
  }
}

function validateReleaseCutoverExpectedCommand(
  command: readonly string[],
  expectation: ReleaseCutoverCommandExpectation,
  id: ReleaseCutoverCommandId
): void {
  if (!releaseCutoverCommandMatchesExpectation(command, expectation)) {
    throw new Error(`Release cutover command ${id} canonicalCommand must match expected ${formatReleaseCutoverCommand(expectation)}`);
  }
}

function releaseCutoverCommandMatchesExpectation(
  command: readonly string[],
  expectation: ReleaseCutoverCommandExpectation
): boolean {
  if (command.length !== expectation.canonicalCommand.length) return false;
  return expectation.canonicalCommand.every((expected, index) => {
    const actual = command[index];
    if (expected !== releaseCutoverRequestFilePlaceholder) return actual === expected;
    return releaseCutoverPathBasename(actual) === expectation.requestFileBasename;
  });
}

function releaseCutoverPathBasename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

function formatReleaseCutoverCommand(expectation: ReleaseCutoverCommandExpectation): string {
  return expectation.canonicalCommand
    .map((part) => (part === releaseCutoverRequestFilePlaceholder ? `<${expectation.requestFileBasename}>` : part))
    .join(" ");
}

function validateReleaseCutoverNegativeChecks(checks: readonly ReleaseCutoverNegativeCheck[]): void {
  validateNonEmptyArray(checks, "Release cutover negative checks");
  for (const check of checks) {
    if (!check || typeof check !== "object") throw new Error("Release cutover negative check is required");
    validateNonEmptyString(check.id, "Release cutover negative check id");
    validateStringArray(check.command, "Release cutover negative check command", { allowEmpty: false });
    if (check.command[0] !== "lattice") throw new Error("Release cutover negative check command must be canonical lattice");
    if (check.status !== "passed") throw new Error("Release cutover negative check status must be passed");
    if (check.exitCode !== 0) throw new Error("Release cutover negative check exitCode must be 0");
    validateNonEmptyString(check.assertion, "Release cutover negative check assertion");
  }
}

function validateReleaseCutoverForbiddenMarkerScan(scan: ReleaseCutoverForbiddenMarkerScan): void {
  if (!scan || typeof scan !== "object") throw new Error("Release cutover forbiddenMarkerScan is required");
  validateNonNegativeInteger(scan.scannedTextCount, "Release cutover forbidden marker scannedTextCount");
  if (scan.scannedTextCount === 0) throw new Error("Release cutover forbidden marker scan must scan at least one text");
  if (scan.findingCount !== 0) throw new Error("Release cutover forbidden marker findingCount must be 0");
  validateStringArray(scan.markersBlocked, "Release cutover forbidden marker labels", { allowEmpty: false });
}

function validateReleaseCutoverInputEvidence(evidence: readonly ReleaseCutoverInputEvidence[]): void {
  validateNonEmptyArray(evidence, "Release cutover input evidence");
  validateExactStringSet(
    evidence.map((entry) => entry.issue),
    releaseCutoverInputIssues,
    "Release cutover input evidence issues"
  );
  for (const entry of evidence) {
    if (!entry || typeof entry !== "object") throw new Error("Release cutover input evidence entry is required");
    if (!includesString(releaseCutoverInputIssues, entry.issue)) {
      throw new Error(`Unknown release cutover input evidence issue: ${String(entry.issue)}`);
    }
    validateNonEmptyString(entry.path, "Release cutover input evidence path");
    validateSha256(entry.checksumSha256, "Release cutover input evidence checksumSha256");
  }
}

function validateAspDogfoodManager(manager: AspDogfoodManagerEvidence): void {
  if (!manager || typeof manager !== "object") throw new Error("ASP dogfood manager evidence is required");
  if (manager.bootstrapSource !== "local-sibling") throw new Error("ASP dogfood bootstrapSource must be local-sibling");
  validateNonEmptyString(manager.aspRepoPath, "ASP dogfood manager aspRepoPath");
  validateNonEmptyString(manager.aspBinPath, "ASP dogfood manager aspBinPath");
  validateNonEmptyString(manager.cliPath, "ASP dogfood manager cliPath");
  validateNonEmptyString(manager.commitSha, "ASP dogfood manager commitSha");
}

function validateAspDogfoodAspHome(aspHome: AspDogfoodAspHomeEvidence): void {
  if (!aspHome || typeof aspHome !== "object") throw new Error("ASP dogfood ASP_HOME evidence is required");
  validateNonEmptyString(aspHome.path, "ASP dogfood ASP_HOME path");
  if (aspHome.temp !== true) throw new Error("ASP dogfood ASP_HOME must be temporary");
  if (aspHome.isolated !== true) throw new Error("ASP dogfood ASP_HOME must be isolated");
  if (aspHome.sharedStateMutated !== false) throw new Error("ASP dogfood shared ASP state must not be mutated");
  if (aspHome.pathSanitized !== true) throw new Error("ASP dogfood PATH must be sanitized for manager execution");
  if (aspHome.aceRuntimeBinExcluded !== true) throw new Error("ASP dogfood manager PATH must exclude .ace/runtime");
}

function validateAspDogfoodHostFixture(fixture: AspDogfoodHostFixtureEvidence): void {
  if (!fixture || typeof fixture !== "object") throw new Error("ASP dogfood host fixture evidence is required");
  validateNonEmptyString(fixture.repo, "ASP dogfood host fixture repo");
  if (fixture.temp !== true) throw new Error("ASP dogfood host fixture repo must be temporary");
  if (fixture.sourceRepoMutated !== false) throw new Error("ASP dogfood host fixture must not mutate the source repo");
  if (fixture.baselineCommitted !== true) throw new Error("ASP dogfood host fixture must commit a baseline");
  validateStringArray(fixture.changedPaths, "ASP dogfood host fixture changedPaths", { allowEmpty: false });
  for (const path of fixture.changedPaths) validateRepoRelativePath(path);
}

function validateAspDogfoodProvider(provider: AspDogfoodProviderEvidence): void {
  if (!provider || typeof provider !== "object") throw new Error("ASP dogfood provider evidence is required");
  if (provider.providerId !== "opcore") throw new Error("ASP dogfood providerId must be opcore");
  if (provider.packageName !== "@the-open-engine/opcore-asp-provider") {
    throw new Error("ASP dogfood provider package must be @the-open-engine/opcore-asp-provider");
  }
  validateNonEmptyString(provider.binPath, "ASP dogfood provider binPath");
  if (!provider.binPath.endsWith("node_modules/.bin/opcore-asp-provider")) {
    throw new Error("ASP dogfood provider binPath must use installed node_modules/.bin/opcore-asp-provider");
  }
  validateNonEmptyString(provider.indexPath, "ASP dogfood provider indexPath");
  if (!provider.indexPath.endsWith("node_modules/@the-open-engine/opcore-asp-provider/dist/index.js")) {
    throw new Error("ASP dogfood provider indexPath must be installed opcore-asp-provider dist/index.js");
  }
  validateSha256(provider.indexSha256, "ASP dogfood provider indexSha256");
  validateExactStringSequence(provider.command, ["opcore-asp-provider", "--stdio"], "ASP dogfood provider command");
  if (!provider.entrypoint || typeof provider.entrypoint !== "object") throw new Error("ASP dogfood provider entrypoint is required");
  if (provider.entrypoint.transport !== "stdio") throw new Error("ASP dogfood provider entrypoint transport must be stdio");
  validateAspDogfoodProviderBinPath(provider.entrypoint.bin, "ASP dogfood provider entrypoint bin");
  validateExactStringSequence(provider.entrypoint.args, ["--stdio"], "ASP dogfood provider entrypoint args");
  validateAspDogfoodProviderManifest(provider.manifest);
}

function validateAspDogfoodProviderManifest(manifestEvidence: AspDogfoodProviderManifestEvidence): void {
  if (!manifestEvidence || typeof manifestEvidence !== "object") throw new Error("ASP dogfood provider manifest evidence is required");
  validateNonEmptyString(manifestEvidence.manifestPath, "ASP dogfood provider manifestPath");
  validateSha256(manifestEvidence.manifestSha256, "ASP dogfood provider manifestSha256");
  if (!manifestEvidence.manifest || typeof manifestEvidence.manifest !== "object") {
    throw new Error("ASP dogfood provider manifest must be structured metadata");
  }
  const manifest = manifestEvidence.manifest as Record<string, unknown>;
  if (manifest.manifestVersion !== "asp-server/0.1") throw new Error("ASP dogfood provider manifestVersion must be asp-server/0.1");
  const server = manifest.server as Record<string, unknown> | undefined;
  if (!server || server.id !== "opcore") throw new Error("ASP dogfood provider manifest server.id must be opcore");
  const entrypoint = manifest.entrypoint as Record<string, unknown> | undefined;
  if (!entrypoint || entrypoint.transport !== "stdio" || typeof entrypoint.bin !== "string") {
    throw new Error("ASP dogfood provider manifest entrypoint must be opcore-asp-provider --stdio");
  }
  validateAspDogfoodProviderBinPath(entrypoint.bin, "ASP dogfood provider manifest entrypoint bin");
  validateExactStringSequence(entrypoint.args as readonly string[], ["--stdio"], "ASP dogfood provider manifest entrypoint args");
  validateExactStringSet((manifest.capabilities as readonly string[]) ?? [], ["check"], "ASP dogfood provider manifest capabilities");
}

function validateAspDogfoodProviderBinPath(value: unknown, label: string): void {
  validateNonEmptyString(value, label);
  const normalized = String(value).replaceAll("\\", "/");
  if (!/node_modules\/\.bin\/opcore-asp-provider(?:\.cmd)?$/.test(normalized)) {
    throw new Error(`${label} must use installed node_modules/.bin/opcore-asp-provider`);
  }
}

function validateAspDogfoodManagerState(state: AspDogfoodManagerStateEvidence): void {
  if (!state || typeof state !== "object") throw new Error("ASP dogfood managerState is required");
  validateAspDogfoodPassedCommandRun(state.status, "asp-status", "ASP dogfood manager status");
  validateAspDogfoodPassedCommandRun(state.serverAdd, "asp-server-add", "ASP dogfood manager server add");
  validateAspDogfoodPassedCommandRun(state.serverStatus, "asp-server-status", "ASP dogfood manager server status");
  if (!state.serverStatus.output || typeof state.serverStatus.output !== "object") {
    throw new Error("ASP dogfood server status output is required");
  }
}

function validateAspDogfoodRepoEnrollment(enrollment: AspDogfoodRepoEnrollmentEvidence): void {
  if (!enrollment || typeof enrollment !== "object") throw new Error("ASP dogfood repo enrollment is required");
  validateNonEmptyString(enrollment.repo, "ASP dogfood repo enrollment repo");
  if (enrollment.mode !== "advisory" && enrollment.mode !== "shadow") {
    throw new Error("ASP dogfood repo enrollment mode must be advisory or shadow");
  }
  validateAspDogfoodPassedCommandRun(enrollment.repoAdd, "asp-repo-add", "ASP dogfood repo add");
  validateAspDogfoodPassedCommandRun(enrollment.repoEnable, "asp-repo-enable", "ASP dogfood repo enable");
  validateAspDogfoodPassedCommandRun(enrollment.repoStatus, "asp-repo-status", "ASP dogfood repo status");
}

function validateAspDogfoodHostEvaluation(evaluation: AspDogfoodHostEvaluationEvidence): void {
  if (!evaluation || typeof evaluation !== "object") throw new Error("ASP dogfood host evaluation is required");
  validateAspDogfoodPassedCommandRun(evaluation.check, "asp-check-changed", "ASP dogfood host check");
  if (!evaluation.check.command.includes("check")) throw new Error("ASP dogfood host check must run asp check");
  if (!evaluation.check.hostDecision || typeof evaluation.check.hostDecision !== "object") {
    throw new Error("ASP dogfood host decision is required");
  }
  if (!evaluation.check.receipt || typeof evaluation.check.receipt !== "object") {
    throw new Error("ASP dogfood host receipt is required");
  }
  validateAspDogfoodHostAuthorityEvidence(evaluation.check.hostDecision, "ASP dogfood host decision", { requireProviderProvenance: false });
  validateAspDogfoodHostAuthorityEvidence(evaluation.check.receipt, "ASP dogfood host receipt", { requireProviderProvenance: true });
  if (!evaluation.check.assurance || typeof evaluation.check.assurance !== "object") {
    throw new Error("ASP dogfood host assurance is required");
  }
  validateNonEmptyString(evaluation.check.assurance.mode, "ASP dogfood host assurance mode");
  validateNonEmptyString(evaluation.check.assurance.transactionGuarantee, "ASP dogfood host transactionGuarantee");
  if (evaluation.ciVerify !== undefined) {
    validateAspDogfoodCommandRun(evaluation.ciVerify, "asp-ci-verify", "ASP dogfood CI verify");
    if (!evaluation.ciVerify.command.includes("ci") || !evaluation.ciVerify.command.includes("verify")) {
      throw new Error("ASP dogfood CI verifier must run asp ci verify");
    }
  }
}

function validateAspDogfoodHostAuthorityEvidence(
  value: unknown,
  label: string,
  options: { requireProviderProvenance: boolean }
): void {
  if (!value || typeof value !== "object") throw new Error(`${label} is required`);
  const record = value as Record<string, unknown>;
  const authorityEvidence = record.authorityEvidence;
  if (!Array.isArray(authorityEvidence) || authorityEvidence.length === 0) {
    throw new Error(`${label} must include host authorityEvidence`);
  }
  const providerProvenance = record.providerProvenance;
  if (options.requireProviderProvenance && (!Array.isArray(providerProvenance) || providerProvenance.length === 0)) {
    throw new Error(`${label} must include providerProvenance`);
  }
}

function validateAspDogfoodProviderProbe(probe: AspDogfoodProviderProbeEvidence): void {
  if (!probe || typeof probe !== "object") throw new Error("ASP dogfood provider probe is required");
  validateAspDogfoodPassedCommandRun(probe, "provider-probe", "ASP dogfood provider probe");
  validateExactStringSequence(probe.command, ["opcore-asp-provider", "--stdio"], "ASP dogfood provider probe command");
  if (!probe.assessment || typeof probe.assessment !== "object") throw new Error("ASP dogfood provider probe assessment is required");
  if (!probe.validAsOf || typeof probe.validAsOf !== "object") throw new Error("ASP dogfood provider probe validAsOf is required");
  if (!probe.coverage || typeof probe.coverage !== "object") throw new Error("ASP dogfood provider probe coverage is required");
  validateNonNegativeInteger(probe.diagnosticsCount, "ASP dogfood provider probe diagnosticsCount");
  if (probe.hostOwnedFieldLeak !== false) throw new Error("ASP dogfood provider output must not contain host-owned decision fields");
  assertNoAspDogfoodHostOwnedFields(probe.assessment);
}

function validateAspDogfoodGuardrails(guardrails: readonly AspDogfoodGuardrailReceipt[]): void {
  validateNonEmptyArray(guardrails, "ASP dogfood current-tool guardrails");
  validateExactStringSet(
    guardrails.map((entry) => entry.id),
    aspDogfoodGuardrailIds,
    "ASP dogfood current-tool guardrail ids"
  );
  for (const guardrail of guardrails) {
    if (!includesString(aspDogfoodGuardrailIds, guardrail.id)) {
      throw new Error(`Unknown ASP dogfood guardrail id: ${String(guardrail.id)}`);
    }
    validateAspDogfoodCommandRun(guardrail, guardrail.id, `ASP dogfood guardrail ${guardrail.id}`);
    if (guardrail.retained !== true) throw new Error("ASP dogfood old-tool guardrails must be retained");
    if (includesString(aspDogfoodRequiredGuardrailIds, guardrail.id) && guardrail.status !== "passed") {
      throw new Error(`ASP dogfood required guardrail ${guardrail.id} must pass`);
    }
    if (guardrail.id === "current-tools-validate-all" && guardrail.status !== "passed" && guardrail.status !== "retained-not-run") {
      throw new Error("ASP dogfood current-tools-validate-all must pass or be retained-not-run");
    }
  }
}

function validateAspDogfoodUnsupportedSurfaces(surfaces: readonly AspDogfoodUnsupportedSurfaceEvidence[]): void {
  validateNonEmptyArray(surfaces, "ASP dogfood unsupported surfaces");
  validateExactStringSet(
    surfaces.map((entry) => entry.surface),
    aspDogfoodUnsupportedSurfaceIds,
    "ASP dogfood unsupported surfaces"
  );
  for (const entry of surfaces) {
    if (!entry || typeof entry !== "object") throw new Error("ASP dogfood unsupported surface entry is required");
    if (!includesString(aspDogfoodUnsupportedSurfaceIds, entry.surface)) {
      throw new Error(`Unknown ASP dogfood unsupported surface: ${String(entry.surface)}`);
    }
    if (!includesString(["degraded", "retained-old-tool-gate", "parity-blocker"] as const, entry.status)) {
      throw new Error("ASP dogfood unsupported surface status must be degraded, retained-old-tool-gate, or parity-blocker");
    }
    if (entry.cleanCoverage !== false) throw new Error("ASP dogfood unsupported inspect/edit surfaces must not be represented as clean coverage");
    validateNonEmptyString(entry.blocker, "ASP dogfood unsupported surface blocker");
  }
}

function validateAspDogfoodParityBlockers(blockers: readonly AspDogfoodParityBlocker[]): void {
  validateNonEmptyArray(blockers, "ASP dogfood parity blockers");
  for (const blocker of blockers) {
    if (!blocker || typeof blocker !== "object") throw new Error("ASP dogfood parity blocker is required");
    validateNonEmptyString(blocker.source, "ASP dogfood parity blocker source");
    validateNonEmptyString(blocker.detail, "ASP dogfood parity blocker detail");
  }
}

function validateAspDogfoodAuthority(authority: AspDogfoodAuthorityEvidence): void {
  if (!authority || typeof authority !== "object") throw new Error("ASP dogfood authority evidence is required");
  if (authority.hostOwnsDecisions !== true) throw new Error("ASP dogfood host must own decisions");
  if (authority.providerOutputIsHostDecision !== false) throw new Error("ASP dogfood provider output must not be treated as host decision");
  if (!authority.localAuthorityOverride || typeof authority.localAuthorityOverride !== "object") {
    throw new Error("ASP dogfood local authority override evidence is required");
  }
  if (authority.localAuthorityOverride.present !== false || authority.localAuthorityOverride.sharedAuthorityWeakened !== false) {
    throw new Error("ASP dogfood must not silently weaken shared authority through local override");
  }
}

function validateAspDogfoodForbiddenMarkerScan(scan: AspDogfoodForbiddenMarkerScan): void {
  if (!scan || typeof scan !== "object") throw new Error("ASP dogfood forbidden marker scan is required");
  validatePositiveInteger(scan.scannedTextCount, "ASP dogfood forbidden marker scannedTextCount");
  if (scan.findingCount !== 0) throw new Error("ASP dogfood forbidden marker findingCount must be 0");
  validateExactStringSet(scan.markersBlocked, aspDogfoodForbiddenProviderMarkers, "ASP dogfood forbidden provider markers");
}

function validateAspDogfoodCommandRun(receipt: AspDogfoodCommandRunReceipt, expectedId: string, label: string): void {
  if (!receipt || typeof receipt !== "object") throw new Error(`${label} receipt is required`);
  if (receipt.id !== expectedId) throw new Error(`${label} id must be ${expectedId}`);
  validateStringArray(receipt.command, `${label} command`, { allowEmpty: false });
  if (!includesString(["passed", "failed", "retained-not-run"] as const, receipt.status)) {
    throw new Error(`${label} status must be passed, failed, or retained-not-run`);
  }
  if (receipt.status === "passed" && receipt.exitCode !== 0) throw new Error(`${label} passed status must use exitCode 0`);
  if (receipt.status === "retained-not-run" && receipt.exitCode !== null) {
    throw new Error(`${label} retained-not-run status must use null exitCode`);
  }
  if (receipt.status === "failed") validateNonNegativeInteger(receipt.exitCode, `${label} exitCode`);
  validateSha256(receipt.stdoutSha256, `${label} stdoutSha256`);
  validateSha256(receipt.stderrSha256, `${label} stderrSha256`);
  validateNonEmptyString(receipt.assertion, `${label} assertion`);
}

function validateAspDogfoodPassedCommandRun(receipt: AspDogfoodCommandRunReceipt, expectedId: string, label: string): void {
  validateAspDogfoodCommandRun(receipt, expectedId, label);
  if (receipt.status !== "passed") throw new Error(`${label} status must be passed`);
  if (receipt.exitCode !== 0) throw new Error(`${label} passed status must use exitCode 0`);
}

function validateAspDogfoodForbiddenProviderEntrypoint(receipt: AspDogfoodReceipt): void {
  const providerTexts = collectStrings(receipt.provider);
  const findings: string[] = [];
  for (const text of providerTexts) {
    const normalized = text.replaceAll("\\", "/").toLowerCase();
    for (const marker of [...aspDogfoodForbiddenProviderMarkers, legacyAspProviderBinMarker]) {
      if (normalized.includes(marker.toLowerCase())) findings.push(marker);
    }
  }
  if (findings.length > 0) {
    throw new Error(`ASP dogfood provider entrypoint contains forbidden marker: ${[...new Set(findings)].join(", ")}`);
  }
}

function assertNoAspDogfoodHostOwnedFields(value: unknown, path = "$"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAspDogfoodHostOwnedFields(entry, `${path}[${index}]`));
    return;
  }
  const forbidden = new Set(["decision", "verdict", "pass", "authority", "authorityEvidence", "assurance", "transactionGuarantee", "applyReceipt"]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`ASP dogfood provider output contains host-owned field ${path}.${key}`);
    assertNoAspDogfoodHostOwnedFields(child, `${path}.${key}`);
  }
}

function validateManagedToolDescriptorPackageReference(
  reference: ManagedToolDescriptorArtifactReference,
  packageName: ReleaseReceiptPackageName
): void {
  if (!reference || typeof reference !== "object") throw new Error("Release receipt descriptor reference is required");
  validateNonEmptyString(reference.id, "Release receipt descriptor reference id");
  if (reference.packageName !== packageName) {
    throw new Error(`Release receipt descriptor reference packageName must be ${packageName}`);
  }
  validateRepoRelativePath(reference.path);
  if (!includesString(managedToolDescriptorArtifactTypes, reference.type)) {
    throw new Error(`Unknown release receipt descriptor reference type: ${String(reference.type)}`);
  }
  if (typeof reference.required !== "boolean") throw new Error("Release receipt descriptor reference required must be boolean");
  if (reference.checksumRef !== undefined) validateNonEmptyString(reference.checksumRef, "Release receipt descriptor reference checksumRef");
}

function validateReleaseReceiptPackageName(value: unknown, label: string): ReleaseReceiptPackageName {
  if (!includesString(releaseReceiptPackageNames, value)) {
    throw new Error(`${label} must be one of ${releaseReceiptPackageNames.join(", ")}`);
  }
  return value;
}

function isGraphCoreNativePackageName(value: unknown): value is GraphCoreNativePackageName {
  return includesString(graphCoreNativePackageNames, value);
}

function graphCoreNativeTargetForPackageName(packageName: GraphCoreNativePackageName): GraphCoreNativeSupportedTarget {
  const target = graphCoreNativeSupportedTargets.find((entry) => graphCoreNativePackageNamesByTarget[entry] === packageName);
  if (!target) throw new Error(`Unknown Opcore graph-core native package: ${packageName}`);
  return target;
}

function validateReleaseReceiptCommandGroupName(value: unknown, label: string): ReleaseReceiptCommandGroupName {
  if (!includesString(releaseReceiptCommandGroups, value)) {
    throw new Error(`${label} must be one of ${releaseReceiptCommandGroups.join(", ")}`);
  }
  return value;
}

function validateReleaseReceiptReportId(value: unknown, label: string): ReleaseReceiptReportId {
  if (!includesString(releaseReceiptReportIds, value)) {
    throw new Error(`${label} must be one of ${releaseReceiptReportIds.join(", ")}`);
  }
  return value;
}

function validateStringRecord(value: Readonly<Record<string, string>>, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const [key, recordValue] of Object.entries(value)) {
    validateNonEmptyString(key, `${label} key`);
    validateNonEmptyString(recordValue, `${label}.${key}`);
  }
}

function packageEvidenceIncludesFile(
  packages: readonly ReleaseReceiptPackageEvidence[],
  packageName: ReleaseReceiptPackageName,
  path: string
): boolean {
  return packages.find((entry) => entry.packageName === packageName)?.files.includes(path) ?? false;
}

function validateSha256(value: unknown, label: string): string {
  const text = validateNonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error(`${label} must be a sha256 hex digest`);
  return text;
}

function validateExactStringSet(actual: readonly string[], expected: readonly string[], label: string): void {
  validateStringArray(actual, label, { allowEmpty: false });
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw new Error(`${label} must exactly match ${expected.join(", ")}`);
  }
}

function validateExactStringSequence(actual: readonly string[], expected: readonly string[], label: string): void {
  validateStringArray(actual, label, { allowEmpty: false });
  if (!sameStringArray(actual, expected)) {
    throw new Error(`${label} must exactly match ${expected.join(" ")}`);
  }
}

function validateGraphReleaseSourceFreeStrings(value: unknown): void {
  const forbidden = [/tirth8205/i, /pyproject\.toml/i, /setup\.py/i, /setup\.cfg/i, /Pipfile/i, /git clone/i, /code-review-graph/i, /gungnir/i];
  for (const text of collectStrings(value)) {
    const pattern = forbidden.find((entry) => entry.test(text));
    if (pattern) throw new Error(`Graph release receipt contains forbidden source provenance: ${text}`);
  }
}

function validateCommandExitSemantics(exitSemantics: CommandExitSemantics): CommandExitSemantics {
  if (!exitSemantics || typeof exitSemantics !== "object") {
    throw new Error("Command router manifest must include exitSemantics");
  }
  if (exitSemantics.ok !== 0) throw new Error("Command exit semantics ok must be 0");
  if (exitSemantics.error !== 1) throw new Error("Command exit semantics error must be 1");
  if (exitSemantics.notImplemented !== 2) throw new Error("Command exit semantics notImplemented must be 2");
  if (exitSemantics.unsupported !== 64) throw new Error("Command exit semantics unsupported must be 64");
  if (typeof exitSemantics.jsonStable !== "boolean") {
    throw new Error("Command exit semantics jsonStable must be boolean");
  }
  return exitSemantics;
}

function validateExitCodeForStatus(exitCode: unknown, status: CommandRouteStatus): number {
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0) {
    throw new Error("Command route exitCode must be a non-negative integer");
  }
  if (status === "ok" && exitCode !== 0) throw new Error("Command route ok status must use exitCode 0");
  if (status === "error" && exitCode !== 1) throw new Error("Command route error status must use exitCode 1");
  if (status === "not_implemented" && exitCode !== 2) {
    throw new Error("Command route not_implemented status must use exitCode 2");
  }
  if (status === "unsupported" && exitCode !== 64) {
    throw new Error("Command route unsupported status must use exitCode 64");
  }
  return exitCode;
}

function validateStringArray(
  values: readonly string[] | undefined,
  label: string,
  options: { allowEmpty: boolean }
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }
  if (!options.allowEmpty && values.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  for (const value of values) validateNonEmptyString(value, label);
  return values;
}

function validateValidationChecks(checks: readonly string[], label: string): readonly string[] {
  validateStringArray(checks, label, { allowEmpty: true });
  for (const check of checks) {
    if (check.trim().length === 0) {
      throw new Error(`${label} entries must include non-whitespace content`);
    }
    validateValidationCheckId(check, `${label} entry`);
  }
  return checks;
}

function validateValidationCheckId(checkId: unknown, label: string): string {
  const value = validateNonEmptyString(checkId, label);
  if (!validationCheckIdRegex.test(value)) {
    throw new Error(`${label} must be a stable validation check id`);
  }
  return value;
}

function validateNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function validateNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function validatePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function validateNonEmptyArray(values: readonly unknown[] | undefined, label: string): readonly unknown[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return values;
}

function validateNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function validateGraphFreshness(freshness: GraphFreshness | undefined, label: string): GraphFreshness {
  if (!freshness || typeof freshness !== "object") {
    throw new Error(`${label} graph provider status must include freshness`);
  }
  if (typeof freshness.generatedAt !== "string" || freshness.generatedAt.length === 0) {
    throw new Error(`${label} graph provider freshness must include generatedAt`);
  }
  if (typeof freshness.ageMs !== "number") {
    throw new Error(`${label} graph provider freshness must include numeric ageMs`);
  }
  if (typeof freshness.stale !== "boolean") {
    throw new Error(`${label} graph provider freshness must include stale`);
  }
  return freshness;
}

function validateGraphSnapshotMetadata(metadata: GraphSnapshotMetadata): GraphSnapshotMetadata {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Graph snapshot metadata is required");
  }
  if (typeof metadata.schemaVersion !== "number") {
    throw new Error("Graph snapshot metadata must include numeric schemaVersion");
  }
  if (typeof metadata.provider !== "string" || metadata.provider.length === 0) {
    throw new Error("Graph snapshot metadata must include provider");
  }
  validateRepoIdentity(metadata.repo);
  validateGraphFreshness(metadata.freshness, "Graph snapshot");
  if (!Array.isArray(metadata.nodeKinds) || !Array.isArray(metadata.edgeKinds)) {
    throw new Error("Graph snapshot metadata must include nodeKinds and edgeKinds");
  }
  return metadata;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry));
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((entry) => collectStrings(entry));
}
