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
import {
  validateCommandTiming,
  validatePythonValidationCapabilityRun,
  validateRepoRelativePath
} from "@the-open-engine/opcore-contracts";
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
  aspProviderValidationChecks,
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
        fixes: false,
        pythonProjectContext: {
          schemaId: "opcore.python.project-context.v1",
          outcomes: ["resolved", "degraded", "unsupported", "ambiguous"],
          readOnly: true,
          installs: false
        }
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
  const changedPaths = changedScopePaths(params.changeset.changes);
  const workspace = timing.timeSync("host_workspace_binding", () =>
    createAspHostValidationWorkspace(peer, initialize, initialized, params.changeset)
  );
  let selectedIds: readonly string[] = [];
  let policyChecks: Awaited<ReturnType<typeof aspProviderValidationChecks>> = [];
  let validationResult: ValidationResult;
  let request: ValidationRequest;
  const mappingDegradations = comparisonDegradations(params.comparison ?? "introduced");

  try {
    request = await timing.timeAsync("changeset_overlay_mapping", async () => {
      const overlays = await overlaysForChanges(params.changeset.changes, workspace);
      policyChecks = await aspProviderValidationChecks(workspace.workspace, workspace.pythonWorkspace, overlays);
      selectedIds = normalizeRequestedChecks(params.checks, policyChecks);
      const selectedChecks = selectedValidationChecks(policyChecks, selectedIds);
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
        checks: params.checks === undefined ? undefined : selectedIds,
        overlays
      };
    });
    validationResult = await timing.timeAsync("validation", () =>
      createAspProviderValidationRunner(workspace.workspace, policyChecks).runValidation(request)
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

function normalizeRequestedChecks(
  checks: readonly string[] | undefined,
  policyChecks: readonly { id: string; supportedScopes: readonly string[]; defaultScopes?: readonly string[] }[]
): readonly string[] {
  if (checks === undefined) {
    return policyChecks
      .filter((check) => (check.defaultScopes ?? check.supportedScopes).includes("files"))
      .map((check) => check.id);
  }
  const selected: string[] = [];
  const known = new Set(policyChecks.map((check) => check.id));
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
    evidence: validationEvidence(args.validationResult, args.selectedIds),
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
  const range = diagnosticRange(diagnostic);
  if (range !== undefined) location.range = range;
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
      range,
      severity: diagnostic.severity,
      message: diagnostic.message,
      changesetDigest
    }),
    ...(requestedComparison === "all" ? {} : {})
  };
}

function diagnosticRange(diagnostic: ValidationDiagnostic): JsonObject | undefined {
  if (diagnostic.line === undefined) return undefined;
  const start: JsonObject = { line: diagnostic.line };
  if (diagnostic.column !== undefined) start.column = diagnostic.column;
  const range: JsonObject = { start };
  if (diagnostic.endLine !== undefined) {
    const end: JsonObject = { line: diagnostic.endLine };
    if (diagnostic.endColumn !== undefined) end.column = diagnostic.endColumn;
    range.end = end;
  }
  return range;
}

function checkIdForDiagnostic(diagnostic: ValidationDiagnostic): string {
  const code = diagnostic.code ?? "";
  if (code.startsWith("PY_RUFF_LINT_")) return "python.ruff-lint";
  if (code.startsWith("PY_RUFF_FORMAT_")) return "python.ruff-format";
  if (diagnostic.category === "syntax") return diagnostic.path?.endsWith(".py") || diagnostic.path?.endsWith(".pyi")
    ? "python.syntax"
    : "typescript.syntax";
  if (diagnostic.category === "types") return diagnostic.path?.endsWith(".py") || diagnostic.path?.endsWith(".pyi")
    ? "python.types"
    : "typescript.types";
  if (diagnostic.category === "test") return "typescript.relevant-tests";
  if (diagnostic.category === "graph") return "typescript.import-graph";
  if (diagnostic.code === "TS_FILE_LINES") return "typescript.file-length";
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
  if (code.startsWith("PY_RUFF_LINT_")) return "python.ruff-lint";
  if (code.startsWith("PY_RUFF_FORMAT_")) return "python.ruff-format";
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
  for (const context of result.pythonProjectContexts ?? []) {
    const relevantReasons = context.reasons.filter((reason) => pythonContextReasonIsRelevant(reason.tool, selectedIds));
    if (relevantReasons.length === 0) continue;
    const reason = context.outcome === "unsupported" ? "unsupported" : "unavailable";
    const entry = {
      source: providerSource,
      reason,
      requirement: `python-project-context:${context.target}`,
      detail: relevantReasons.map((item) => `${item.code}: ${item.message}`).join("; ") ||
        `Python project context ${context.outcome}`
    };
    degraded.push(entry);
    if (reason === "unsupported") unsupported.push(entry);
  }
  for (const skipped of result.manifest?.skippedChecks ?? []) {
    const entry = {
      source: providerSource,
      reason: "unavailable",
      requirement: skipped.checkId,
      detail: skipped.message
    };
    degraded.push(entry);
  }
  // WHY: opt-in checks the host did not select record inactive runs; they are not coverage gaps
  // for the requested rules.
  const selected = new Set(selectedIds);
  for (const run of result.manifest?.runs ?? []) {
    if (!selected.has(run.checkId)) continue;
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

function pythonContextReasonIsRelevant(tool: string | undefined, selectedIds: readonly string[]): boolean {
  const selected = new Set(selectedIds);
  if (tool === "ruff") {
    return selected.has("python.ruff-lint") || selected.has("python.ruff-format");
  }
  if (tool === "mypy" || tool === "pyright") return selected.has("python.types");
  if (tool === "pytest") return selected.has("python.relevant-tests");
  if (tool === "python") {
    return selected.has("python.syntax") ||
      selected.has("python.types") ||
      selected.has("python.relevant-tests");
  }
  return selectedIds.some((checkId) => checkId.startsWith("python."));
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

function validationEvidence(result: ValidationResult, selectedIds: readonly string[]): JsonObject[] {
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
  const evidence: JsonObject[] = [
    {
      kind: "message",
      message: "Opcore validation result mapped to ASP Core check assessment.",
      data
    }
  ];
  for (const context of result.pythonProjectContexts ?? []) {
    evidence.push({
      kind: "python_project_context",
      message: `Canonical Python project context for ${context.target}.`,
      data: {
        schemaId: context.schemaId,
        target: context.target,
        projectRoot: context.projectRoot,
        projectKey: context.projectKey,
        contextFingerprint: context.contextFingerprint,
        outcome: context.outcome,
        interpreter: context.interpreter === undefined
          ? null
          : {
              executable: context.interpreter.executable,
              argv: [...context.interpreter.argv],
              cwd: context.interpreter.cwd,
              source: context.interpreter.source,
              ...(context.interpreter.version === undefined ? {} : { version: context.interpreter.version }),
              ...(context.interpreter.implementation === undefined ? {} : { implementation: context.interpreter.implementation }),
              ...(context.interpreter.platform === undefined ? {} : { platform: context.interpreter.platform }),
              ...(context.interpreter.architecture === undefined ? {} : { architecture: context.interpreter.architecture }),
              ...(context.interpreter.abi === undefined ? {} : { abi: context.interpreter.abi }),
              ...(context.interpreter.soabi === undefined ? {} : { soabi: context.interpreter.soabi })
            },
        tools: context.tools.map((tool) => ({
          tool: tool.tool,
          available: tool.available,
          executable: tool.executable,
          argv: [...tool.argv],
          cwd: tool.cwd,
          source: tool.source,
          ...(tool.configFile === undefined ? {} : { configFile: tool.configFile }),
          ...(tool.version === undefined ? {} : { version: tool.version })
        })),
        reasons: context.reasons.map((reason) => ({ code: reason.code, message: reason.message }))
      }
    });
  }
  for (const run of result.pythonCapabilityRuns ?? []) {
    if (!selectedIds.includes(run.checkId)) continue;
    validatePythonValidationCapabilityRun(run);
    if (run.capability === "types") {
      evidence.push({
        kind: "python_validation_capability_run",
        message: `Python types capability evidence for ${run.projectRoot}.`,
        data: {
          schemaId: run.schemaId,
          schemaVersion: run.schemaVersion,
          capability: run.capability,
          checkId: run.checkId,
          projectKey: run.projectKey,
          contextFingerprint: run.contextFingerprint,
          projectRoot: run.projectRoot,
          targets: [...run.targets],
          selectedSourcePaths: [...run.selectedSourcePaths],
          selectedConfigPaths: [...run.selectedConfigPaths],
          afterStateManifestFingerprint: run.afterStateManifestFingerprint,
          ...(run.authority === undefined ? {} : { checker: run.authority }),
          ...(run.authoritySource === undefined ? {} : { checkerSource: run.authoritySource }),
          status: run.status,
          durationMs: run.durationMs,
          diagnosticCount: run.diagnosticCount,
          errorCount: run.errorCount,
          warningCount: run.warningCount,
          noteCount: run.noteCount,
          ...(run.tool === undefined ? {} : { tool: {
            name: run.tool.name,
            executable: run.tool.executable,
            argv: [...run.tool.argv],
            cwd: run.tool.cwd,
            source: run.tool.source,
            ...(run.tool.version === undefined ? {} : { version: run.tool.version }),
            ...(run.tool.configFile === undefined ? {} : { configFile: run.tool.configFile })
          } }),
          ...(run.execution === undefined ? {} : { execution: { ...run.execution } })
        }
      });
      continue;
    }
    evidence.push({
      kind: "python_validation_capability_run",
      message: `Python ${run.capability} capability evidence for ${run.checkId}.`,
      data: {
        schemaId: run.schemaId,
        schemaVersion: run.schemaVersion,
        checkId: run.checkId,
        capability: run.capability,
        state: run.state,
        ...(run.projectKey === undefined ? {} : { projectKey: run.projectKey }),
        ...(run.contextFingerprint === undefined ? {} : { contextFingerprint: run.contextFingerprint }),
        ...(run.afterStateManifestFingerprint === undefined
          ? {}
          : { afterStateManifestFingerprint: run.afterStateManifestFingerprint }),
        ...(run.sourcePaths === undefined ? {} : { sourcePaths: [...run.sourcePaths] }),
        ...(run.configPaths === undefined ? {} : { configPaths: [...run.configPaths] }),
        ...(run.executable === undefined ? {} : { executable: run.executable }),
        ...(run.command === undefined ? {} : { command: run.command }),
        ...(run.argv === undefined ? {} : { argv: [...run.argv] }),
        ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
        ...(run.configPath === undefined ? {} : { configPath: run.configPath }),
        ...(run.toolVersion === undefined ? {} : { toolVersion: run.toolVersion }),
        ...(run.toolSource === undefined ? {} : { toolSource: run.toolSource }),
        ...(run.termination === undefined ? {} : { termination: run.termination }),
        ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
        ...(run.signal === undefined ? {} : { signal: run.signal }),
        ...(run.invocations === undefined
          ? {}
          : {
              invocations: run.invocations.map((invocation) => ({
                argv: [...invocation.argv],
                termination: invocation.termination,
                ...(invocation.exitCode === undefined ? {} : { exitCode: invocation.exitCode }),
                ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
                durationMs: invocation.durationMs
              }))
            }),
        durationMs: run.durationMs,
        diagnosticCount: run.diagnosticCount,
        ...(run.failureMessage === undefined ? {} : { failureMessage: run.failureMessage })
      }
    });
  }
  return evidence;
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
