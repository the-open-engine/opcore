import type {
  CommandTiming,
  CommandTimingPhase,
  GraphProviderStatus,
  GraphProviderMode,
  HypotheticalOverlay,
  ValidationDiagnostic,
  ValidationRequest,
  ValidationResult
} from "@the-open-engine/opcore-contracts";
import { validateCommandTiming, validateRepoRelativePath } from "@the-open-engine/opcore-contracts";
import type { JsonRpcPeer } from "./json-rpc.js";
import { changesetDigest as computeChangesetDigest, diagnosticFingerprint, digestJson } from "./digests.js";
import type {
  Assessment,
  AssessmentStatus,
  Baseline,
  Change,
  CoveragePart,
  EvaluateChangesetParams,
  InitializedParams,
  InitializeParams,
  JsonObject,
  ProviderCoverageDegradation
} from "./protocol.js";
import {
  ASP_PROTOCOL_VERSION,
  OPCORE_PROVIDER_ID,
  OPCORE_PROVIDER_PACKAGE,
  OPCORE_PROVIDER_VERSION
} from "./protocol.js";
import { createAspHostValidationWorkspace } from "./workspace.js";
import {
  createAspProviderValidationRunner,
  defaultAspProviderValidationCheckIds,
  defaultAspProviderValidationManifest,
  selectedValidationChecks
} from "./validation-composition.js";

const providerSource = OPCORE_PROVIDER_ID;
const capabilityVersion = "check/0.1";
const supportedComparison = "all";
const partiallyGraphBackedChecks = new Set(["typescript.import-graph"]);
let firstAssessmentTiming = true;

export function initializeResult(params: InitializeParams): JsonObject {
  if (params.protocolVersion !== ASP_PROTOCOL_VERSION) {
    throw new Error(`Unsupported initialize protocolVersion: ${params.protocolVersion ?? "missing"}.`);
  }
  return stripForbiddenKeys({
    serverInfo: {
      name: OPCORE_PROVIDER_ID,
      version: OPCORE_PROVIDER_VERSION,
      fingerprint: digestJson({ packageName: OPCORE_PROVIDER_PACKAGE, version: OPCORE_PROVIDER_VERSION })
    },
    capabilityFamilies: ["check"],
    capabilities: {
      check: {
        diagnosticSources: [OPCORE_PROVIDER_ID],
        rules: defaultAspProviderValidationCheckIds,
        manifest: defaultAspProviderValidationManifest,
        scopes: ["changeset", "paths"],
        comparisons: [supportedComparison],
        fixes: false
      }
    },
    requestedPermissions: {
      read: ["**/*"],
      write: false,
      network: false
    },
    provenance: {
      publisher: "the-open-engine",
      packageName: OPCORE_PROVIDER_PACKAGE,
      version: OPCORE_PROVIDER_VERSION,
      source: "opcore-validation"
    }
  }) as JsonObject;
}

export async function evaluateChangeset(
  peer: JsonRpcPeer,
  initialize: InitializeParams,
  initialized: InitializedParams,
  rawParams: unknown
): Promise<Assessment> {
  const timing = createAssessmentTiming();
  const params = normalizeEvaluateParams(rawParams);
  const digest = params.changesetDigest ?? computeChangesetDigest(params.changeset);
  const selectedIds = normalizeRequestedChecks(params.checks);
  const selectedChecks = selectedValidationChecks(selectedIds);
  const changedPaths = changedScopePaths(params.changeset.changes);
  const workspace = timing.timeSync("host_workspace_binding", () =>
    createAspHostValidationWorkspace(peer, initialize, initialized, params.changeset)
  );
  let validationResult: ValidationResult;
  let request: ValidationRequest;
  const mappingDegradations = comparisonDegradations(params.comparison ?? "introduced");

  try {
    request = await timing.timeAsync("changeset_overlay_mapping", async () => {
      const overlays = await overlaysForChanges(params.changeset.changes, workspace);
      const graphMode = graphModeFor(params.callSite, selectedChecks);
      return {
        requestId: digest,
        repo: {
          repoRoot: initialize.workspace?.root ?? process.cwd()
        },
        scope: {
          kind: "files",
          files: changedPaths
        },
        graph: {
          mode: graphMode,
          provider: "opcore-graph"
        },
        checks: selectedIds,
        overlays
      };
    });
    validationResult = await timing.timeAsync("validation", () =>
      createAspProviderValidationRunner(workspace.workspace).runValidation(request)
    );
  } catch (error) {
    const validationFailure = errorAssessment({
      baseline: params.changeset.baseline,
      changesetDigest: digest,
      changedPaths,
      selectedIds,
      timing: timing.finish(),
      readBlobIds: workspace.readBlobIds(),
      degradation: {
        source: providerSource,
        reason: "malformed",
        requirement: "changeset",
        detail: error instanceof Error ? error.message : String(error)
      }
    });
    return stripForbiddenKeys(validationFailure) as Assessment;
  }

  const assessment = assessmentFromValidationResult({
    validationResult,
    baseline: params.changeset.baseline,
    changesetDigest: digest,
    changedPaths,
    selectedIds,
    requestedComparison: params.comparison ?? "introduced",
    mappingDegradations,
    readBlobIds: workspace.readBlobIds(),
    timing: timing.finish(validationResult)
  });
  return stripForbiddenKeys(assessment) as Assessment;
}

function normalizeEvaluateParams(value: unknown): EvaluateChangesetParams {
  if (!value || typeof value !== "object") throw new Error("check/evaluate params are required");
  const params = value as Partial<EvaluateChangesetParams>;
  if (params.callSite !== "interactive" && params.callSite !== "gate" && params.callSite !== "sweep") {
    throw new Error("check/evaluate callSite must be interactive, gate, or sweep");
  }
  if (!params.changeset || typeof params.changeset !== "object") throw new Error("check/evaluate changeset is required");
  if (!Array.isArray(params.changeset.changes)) throw new Error("check/evaluate changeset.changes must be an array");
  if (!params.changeset.baseline || typeof params.changeset.baseline.rev !== "string") {
    throw new Error("check/evaluate changeset.baseline.rev is required");
  }
  if (params.comparison !== undefined && params.comparison !== "all" && params.comparison !== "introduced") {
    throw new Error(`Unsupported check/evaluate comparison: ${String(params.comparison)}`);
  }
  return {
    callSite: params.callSite,
    changeset: params.changeset,
    changesetDigest: typeof params.changesetDigest === "string" ? params.changesetDigest : undefined,
    comparison: params.comparison,
    timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
    basePolicyDigest: typeof params.basePolicyDigest === "string" ? params.basePolicyDigest : undefined,
    requiredCheck: typeof params.requiredCheck === "string" ? params.requiredCheck : undefined,
    checks: Array.isArray(params.checks) ? params.checks : undefined,
    scope: params.scope
  };
}

function normalizeRequestedChecks(checks: readonly string[] | undefined): readonly string[] {
  if (checks === undefined) return defaultAspProviderValidationCheckIds;
  const selected: string[] = [];
  const known = new Set(defaultAspProviderValidationCheckIds);
  for (const check of checks) {
    if (typeof check !== "string" || check.trim().length === 0) throw new Error("Requested checks must be non-empty strings");
    const normalized = check.trim();
    if (!known.has(normalized)) throw new Error(`Unsupported Opcore provider check: ${normalized}`);
    if (!selected.includes(normalized)) selected.push(normalized);
  }
  if (selected.length === 0) throw new Error("At least one requested check is required");
  return selected;
}

async function overlaysForChanges(
  changes: readonly Change[],
  workspace: ReturnType<typeof createAspHostValidationWorkspace>
): Promise<readonly HypotheticalOverlay[]> {
  const overlays: HypotheticalOverlay[] = [];
  for (const [index, change] of changes.entries()) {
    const path = normalizeChangePath(change.path, `changes[${index}].path`);
    if (change.kind === "create") {
      overlays.push({
        path,
        action: "write",
        content: await workspace.readInlineOrBlobText(change.after, `changes[${index}].after`)
      });
      continue;
    }
    if (change.kind === "modify") {
      overlays.push({
        path,
        action: "write",
        content: await workspace.readInlineOrBlobText(change.after, `changes[${index}].after`),
        checksumBefore: typeof change.before === "string" ? await workspace.checksumForBlob(change.before) : undefined
      });
      continue;
    }
    if (change.kind === "delete") {
      overlays.push({
        path,
        action: "delete",
        checksumBefore: typeof change.before === "string" ? await workspace.checksumForBlob(change.before) : undefined
      });
      continue;
    }
    if (change.kind === "rename") {
      const fromPath = normalizeChangePath(change.from, `changes[${index}].from`);
      overlays.push({
        path: fromPath,
        action: "delete",
        checksumBefore: typeof change.before === "string" ? await workspace.checksumForBlob(change.before) : undefined
      });
      overlays.push({
        path,
        action: "write",
        content: await workspace.readInlineOrBlobText(change.after, `changes[${index}].after`)
      });
      continue;
    }
    throw new Error(`Unsupported changeset change kind: ${String((change as { kind?: unknown }).kind)}`);
  }
  return overlays;
}

function normalizeChangePath(path: unknown, label: string): string {
  if (typeof path !== "string") throw new Error(`${label} must be a repo-relative path`);
  return validateRepoRelativePath(path);
}

function graphModeFor(callSite: EvaluateChangesetParams["callSite"], checks: readonly { requiresGraph?: boolean }[]): GraphProviderMode {
  return callSite === "gate" && checks.some((check) => check.requiresGraph === true) ? "required" : "optional";
}

function changedScopePaths(changes: readonly Change[]): readonly string[] {
  const paths = new Set<string>();
  for (const [index, change] of changes.entries()) {
    paths.add(normalizeChangePath(change.path, `changes[${index}].path`));
    if (change.kind === "rename") paths.add(normalizeChangePath(change.from, `changes[${index}].from`));
  }
  if (paths.size === 0) throw new Error("check/evaluate changeset must include at least one changed path");
  return [...paths].sort();
}

function assessmentFromValidationResult(args: {
  validationResult: ValidationResult;
  baseline: Baseline;
  changesetDigest: string;
  changedPaths: readonly string[];
  selectedIds: readonly string[];
  requestedComparison: string;
  mappingDegradations: readonly ProviderCoverageDegradation[];
  readBlobIds: readonly string[];
  timing: CommandTiming;
}): Assessment {
  const resultDegradations = validationCoverageDegradations(args.validationResult, args.selectedIds);
  const degraded = uniqueDegradations([...args.mappingDegradations, ...resultDegradations.degraded]);
  const unsupported = uniqueDegradations(resultDegradations.unsupported);
  const status = assessmentStatus(args.validationResult.status, degraded, unsupported);
  return {
    status,
    diagnostics: args.validationResult.diagnostics.map((diagnostic) =>
      mapDiagnostic(diagnostic, args.changesetDigest, args.requestedComparison)
    ),
    evidence: validationEvidence(args.validationResult),
    coverage: {
      requested: coveragePart(args.changedPaths, args.selectedIds, args.requestedComparison),
      covered: coveragePart(args.changedPaths, coveredRules(args.validationResult, args.selectedIds), supportedComparison),
      degraded,
      unsupported,
      exhaustive: status === "complete" && degraded.length === 0 && unsupported.length === 0,
      truncated: status === "incomplete"
    },
    validAsOf: {
      baseline: args.baseline,
      changesetDigest: args.changesetDigest,
      blobs: [...args.readBlobIds].sort()
    },
    provider: providerMetadata(),
    timing: args.timing,
    cache: {
      status: "disabled"
    }
  };
}

function errorAssessment(args: {
  baseline: Baseline;
  changesetDigest: string;
  changedPaths: readonly string[];
  selectedIds: readonly string[];
  timing: CommandTiming;
  readBlobIds: readonly string[];
  degradation: ProviderCoverageDegradation;
}): Assessment {
  return {
    status: "error",
    diagnostics: [],
    evidence: [
      {
        kind: "message",
        message: "Opcore ASP provider could not map the Core changeset into validation overlays.",
        data: {
          category: "invalid_payload",
          detail: args.degradation.detail
        }
      }
    ],
    coverage: {
      requested: coveragePart(args.changedPaths, args.selectedIds, supportedComparison),
      covered: coveragePart(args.changedPaths, [], supportedComparison),
      degraded: [args.degradation],
      unsupported: [],
      exhaustive: false,
      truncated: false
    },
    validAsOf: {
      baseline: args.baseline,
      changesetDigest: args.changesetDigest,
      blobs: [...args.readBlobIds].sort()
    },
    provider: providerMetadata(),
    timing: args.timing,
    cache: {
      status: "disabled"
    }
  };
}

function mapDiagnostic(diagnostic: ValidationDiagnostic, changesetDigest: string, requestedComparison: string) {
  const checkId = checkIdForDiagnostic(diagnostic);
  const source = diagnosticSource(checkId);
  const code = `${source}/${checkId}/${sanitizeCode(diagnostic.code ?? diagnostic.category)}`;
  const location: JsonObject = {};
  if (diagnostic.path !== undefined) location.path = diagnostic.path;
  return {
    source,
    code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    location,
    fingerprint: diagnosticFingerprint({
      providerId: OPCORE_PROVIDER_ID,
      source,
      code,
      path: diagnostic.path,
      severity: diagnostic.severity,
      message: diagnostic.message,
      changesetDigest
    }),
    ...(requestedComparison === "all" ? {} : {})
  };
}

function checkIdForDiagnostic(diagnostic: ValidationDiagnostic): string {
  if (diagnostic.category === "syntax") return "typescript.syntax";
  if (diagnostic.category === "types") return "typescript.types";
  if (diagnostic.category === "test") return "typescript.relevant-tests";
  if (diagnostic.category === "graph") return "typescript.import-graph";
  if (diagnostic.category === "lint") return "rust.clippy";
  if (diagnostic.category === "policy") return policyCheckIdForDiagnostic(diagnostic);
  if (diagnostic.category === "provider") return "opcore.provider";
  if (diagnostic.category === "infrastructure") return "opcore.infrastructure";
  return `opcore.${diagnostic.category}`;
}

function policyCheckIdForDiagnostic(diagnostic: ValidationDiagnostic): string {
  const code = diagnostic.code ?? "";
  if (code.startsWith("TS_FUNCTION_")) return "typescript.function-metrics";
  if (code.startsWith("TS_FILE_")) return "typescript.file-length";
  if (code.startsWith("PY_SOURCE_")) return "python.source-hygiene";
  if (code.startsWith("RUST_FILE_")) return "rust.file-length";
  if (code.startsWith("RUST_FUNCTION_")) return "rust.function-metrics";
  if (code.startsWith("RUST_SOURCE_")) return "rust.source-hygiene";
  if (code.startsWith("RUST_UNUSED_")) return "rust.unused-deps";
  return "rust.source-hygiene";
}

function sanitizeCode(code: string): string {
  return code.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "diagnostic";
}

function validationCoverageDegradations(result: ValidationResult, selectedIds: readonly string[]): {
  degraded: readonly ProviderCoverageDegradation[];
  unsupported: readonly ProviderCoverageDegradation[];
} {
  const degraded: ProviderCoverageDegradation[] = [];
  const unsupported: ProviderCoverageDegradation[] = [];
  for (const skipped of result.manifest?.skippedChecks ?? []) {
    const entry = {
      source: providerSource,
      reason: "unavailable",
      requirement: skipped.checkId,
      detail: skipped.message
    };
    degraded.push(entry);
  }
  for (const run of result.manifest?.runs ?? []) {
    if (run.status === "passed" || run.status === "policy_failure") continue;
    const reason = run.status === "unsupported_request" ? "unsupported" : run.status === "skipped" ? "unavailable" : "error";
    const entry = {
      source: providerSource,
      reason,
      requirement: run.checkId,
      detail: run.failureMessage ?? `Validation check ${run.checkId} returned ${run.status}`
    };
    degraded.push(entry);
    if (reason === "unsupported") unsupported.push(entry);
  }
  if (result.graphStatus !== undefined && result.graphStatus.state !== "available") {
    for (const checkId of selectedIds) {
      if (!partiallyGraphBackedChecks.has(checkId)) continue;
      degraded.push({
        source: providerSource,
        reason: "unavailable",
        requirement: checkId,
        detail: graphStatusMessage(result.graphStatus)
      });
    }
  }
  if (result.status !== "passed" && result.status !== "policy_failure") {
    const reason = result.status === "unsupported_request" ? "unsupported" : result.status === "skipped" ? "incomplete" : "error";
    const entry = {
      source: providerSource,
      reason,
      requirement: "validation-result",
      detail: result.failure?.message ?? result.refusal?.message ?? `Validation result status ${result.status}`
    };
    degraded.push(entry);
    if (reason === "unsupported") unsupported.push(entry);
  }
  return { degraded, unsupported };
}

function graphStatusMessage(status: GraphProviderStatus): string {
  if ("failure" in status) return status.failure.message;
  return status.message ?? `Graph provider is not available: ${status.state}`;
}

function comparisonDegradations(requested: string): readonly ProviderCoverageDegradation[] {
  if (requested === supportedComparison) return [];
  return [
    {
      source: providerSource,
      reason: "unsupported",
      requirement: `comparison:${requested}`,
      detail: "Opcore ASP provider reports all-diagnostics coverage; introduced-only comparison is not supported in this facade."
    }
  ];
}

function assessmentStatus(
  validationStatus: ValidationResult["status"],
  degraded: readonly ProviderCoverageDegradation[],
  unsupported: readonly ProviderCoverageDegradation[]
): AssessmentStatus {
  if (validationStatus === "unsupported_request" || unsupported.length > 0) return "unsupported";
  if (validationStatus === "provider_failure" || validationStatus === "infrastructure_failure" || validationStatus === "invalid_payload") return "error";
  if (validationStatus === "refused") return "error";
  if (validationStatus === "skipped") return "incomplete";
  if (degraded.length > 0) return "incomplete";
  return "complete";
}

function coveragePart(paths: readonly string[], rules: readonly string[], comparison: string): CoveragePart {
  return {
    scope: { paths: [...paths].sort() },
    diagnosticSources: rules.length > 0 ? [OPCORE_PROVIDER_ID] : [],
    rules: [...rules],
    comparison
  };
}

function coveredRules(result: ValidationResult, selectedIds: readonly string[]): readonly string[] {
  const skipped = new Set((result.manifest?.skippedChecks ?? []).map((entry) => entry.checkId));
  const failed = new Set(
    (result.manifest?.runs ?? [])
      .filter((run) => run.status !== "passed" && run.status !== "policy_failure")
      .map((run) => run.checkId)
  );
  return selectedIds.filter((checkId) => !skipped.has(checkId) && !failed.has(checkId));
}

function validationEvidence(result: ValidationResult): JsonObject[] {
  const data: JsonObject = {
    validationStatus: result.status,
    checkCount: result.manifest?.checks.length ?? 0,
    diagnosticCount: result.diagnostics.length
  };
  if (result.failure !== undefined) {
    data.failureCategory = result.failure.category;
    data.failureMessage = result.failure.message;
  }
  if (result.refusal !== undefined) {
    data.refusalCategory = result.refusal.category;
    data.refusalMessage = result.refusal.message;
  }
  return [
    {
      kind: "message",
      message: "Opcore validation result mapped to ASP Core check assessment.",
      data
    }
  ];
}

function providerMetadata(): Assessment["provider"] {
  return {
    id: OPCORE_PROVIDER_ID,
    version: OPCORE_PROVIDER_VERSION,
    configDigest: digestJson({
      packageName: OPCORE_PROVIDER_PACKAGE,
      checks: defaultAspProviderValidationCheckIds,
      comparison: supportedComparison
    }),
    capabilityVersion,
    buildDigest: digestJson({ packageName: OPCORE_PROVIDER_PACKAGE, version: OPCORE_PROVIDER_VERSION }),
    capabilityFamily: "check"
  };
}

function diagnosticSource(_checkId: string): string {
  return OPCORE_PROVIDER_ID;
}

type AssessmentTimingRecorder = {
  timeSync<T>(phase: string, action: () => T): T;
  timeAsync<T>(phase: string, action: () => Promise<T>): Promise<T>;
  finish(validationResult?: ValidationResult): CommandTiming;
};

function createAssessmentTiming(): AssessmentTimingRecorder {
  const startedAt = Date.now();
  const processState = nextAssessmentProcessState();
  const phases: CommandTimingPhase[] = [];
  return {
    timeSync<T>(phase: string, action: () => T): T {
      const phaseStartedAt = Date.now();
      try {
        return action();
      } finally {
        phases.push({
          phase,
          durationMs: elapsedMs(phaseStartedAt)
        });
      }
    },
    async timeAsync<T>(phase: string, action: () => Promise<T>): Promise<T> {
      const phaseStartedAt = Date.now();
      try {
        return await action();
      } finally {
        phases.push({
          phase,
          durationMs: elapsedMs(phaseStartedAt)
        });
      }
    },
    finish(validationResult) {
      const durationMs = elapsedMs(startedAt);
      return validateCommandTiming({
        durationMs,
        phases: [
          ...phases,
          ...validationCheckPhases(validationResult)
        ],
        processState
      });
    }
  };
}

function nextAssessmentProcessState(): CommandTiming["processState"] {
  if (firstAssessmentTiming) {
    firstAssessmentTiming = false;
    return "cold";
  }
  return "warm";
}

function validationCheckPhases(result: ValidationResult | undefined): CommandTimingPhase[] {
  return (result?.manifest?.runs ?? [])
    .filter((run) => isNonNegativeFiniteNumber(run.durationMs))
    .map((run) => ({
      phase: `validation_${normalizePhaseId(run.checkId, "check")}`,
      durationMs: run.durationMs as number
    }));
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

function uniqueDegradations(entries: readonly ProviderCoverageDegradation[]): ProviderCoverageDegradation[] {
  const seen = new Set<string>();
  const unique: ProviderCoverageDegradation[] = [];
  for (const entry of entries) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function stripForbiddenKeys(value: unknown): unknown {
  const forbidden = new Set(["decision", "verdict", "pass", "authority", "assurance", "transactionGuarantee", "applyReceipt"]);
  if (Array.isArray(value)) return value.map(stripForbiddenKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !forbidden.has(key))
      .map(([key, child]) => [key, stripForbiddenKeys(child)])
  );
}
