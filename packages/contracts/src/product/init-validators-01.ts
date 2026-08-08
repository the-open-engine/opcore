import {
  includesString,
  validateBoolean,
  validateOptional,
  validateRequiredObject,
} from "../shared/primitives.js";
import { validateProviderStatus } from "../graph/provider-validators.js";
import { graphProviderStatusStates } from "../graph/vocabulary-01.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyArray,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateStringArray,
} from "../shared/validators-01.js";
import { validationResultStatuses } from "../validation/vocabulary-01.js";
import type { OpcoreInitPlanPayload, OpcoreInitScanSummary} from "./init-contracts.js";
import { opcoreInitScopes } from "./init-contracts.js";
import {
  validateOpcoreInitInteraction,
  validateOpcoreInitSettings,
  validateOpcoreInitTiming,
} from "./init-validators-02.js";
import { validateOpcoreInitAction } from "./metrics-validators-02.js";
import {
  validateOpcoreCoverageLanguages,
  validateOpcoreUnsupportedStacks,
} from "./metrics-coverage-validators.js";
import type { OpcoreDoctorPayload, OpcoreRuntimeInfoPayload} from "./status-contracts.js";
import { opcoreRuntimeArtifactSources } from "./status-contracts.js";
import { validateOpcoreValidationPolicySummary } from "./status-validators.js";

function validateOpcoreRuntimeInfoPayload(payload: OpcoreRuntimeInfoPayload): OpcoreRuntimeInfoPayload {
  validateRequiredObject(payload, "Opcore runtime info payload is required");
  if (payload.schemaVersion !== 1) {
    throw new Error("Opcore runtime info schemaVersion must be 1");
  }
  if (payload.packageName !== "opcore") {
    throw new Error("Opcore runtime info packageName must be opcore");
  }
  validateNonEmptyString(payload.version, "Opcore runtime info version");
  if (payload.bin !== "opcore") {
    throw new Error("Opcore runtime info bin must be opcore");
  }
  if (!includesString(opcoreRuntimeArtifactSources, payload.artifactSource)) {
    throw new Error(`Unknown Opcore runtime artifact source: ${String(payload.artifactSource)}`);
  }
  validateNonEmptyString(payload.packageRoot, "Opcore runtime info packageRoot");
  validateNonEmptyString(payload.entrypoint, "Opcore runtime info entrypoint");
  return payload;
}

export { validateOpcoreRuntimeInfoPayload };

function validateOpcoreDoctorPayload(payload: OpcoreDoctorPayload): OpcoreDoctorPayload {
  validateRequiredObject(payload, "Opcore doctor payload is required");
  if (payload.schemaVersion !== 1) {
    throw new Error("Opcore doctor payload schemaVersion must be 1");
  }
  validateOpcoreRuntimeInfoPayload(payload.runtime);
  validateRequiredObject(payload.repo, "Opcore doctor repo is required");
  validateNonEmptyString(payload.repo.root, "Opcore doctor repo root");
  validateNonEmptyString(payload.repo.requestedPath, "Opcore doctor repo requestedPath");
  validateRequiredObject(payload.config, "Opcore doctor config is required");
  if (payload.config.path !== ".opcore/config") {
    throw new Error("Opcore doctor config path must be .opcore/config");
  }
  if (!includesString(["found", "missing", "unreadable"] as const, payload.config.state)) {
    throw new Error(`Unknown Opcore doctor config state: ${String(payload.config.state)}`);
  }
  if (payload.config.message !== undefined)
    validateNonEmptyString(payload.config.message, "Opcore doctor config message");
  validateRequiredObject(payload.checks, "Opcore doctor checks are required");
  validateNonNegativeInteger(payload.checks.count, "Opcore doctor checks count");
  validateStringArray(payload.checks.ids, "Opcore doctor checks ids", {
    allowEmpty: false,
  });
  if (payload.checks.ids.length !== payload.checks.count) {
    throw new Error("Opcore doctor checks count must match ids length");
  }
  validateOpcoreValidationPolicySummary(payload.policy, "Opcore doctor policy");
  validateProviderStatus(payload.graph);
  validateRequiredObject(payload.generatedState, "Opcore doctor generatedState is required");
  validateStringArray(payload.generatedState.ignored, "Opcore doctor generatedState ignored", { allowEmpty: false });
  validateNonEmptyString(payload.generatedState.guidance, "Opcore doctor generatedState guidance");
  validateStringArray(payload.nextActions, "Opcore doctor nextActions", {
    allowEmpty: false,
  });
  return payload;
}

export { validateOpcoreDoctorPayload };

function validateOpcoreInitPlanPayload(payload: OpcoreInitPlanPayload): OpcoreInitPlanPayload {
  validateRequiredObject(payload, "Opcore init payload is required");
  if (payload.schemaVersion !== 1) {
    throw new Error("Opcore init payload schemaVersion must be 1");
  }
  if (!includesString(["plan", "apply", "undo"] as const, payload.mode)) {
    throw new Error(`Unknown Opcore init mode: ${String(payload.mode)}`);
  }
  validateBoolean(payload.approved, "Opcore init approved");
  validateOpcoreInitApproval(payload);
  validateRequiredObject(payload.repo, "Opcore init repo is required");
  validateNonEmptyString(payload.repo.root, "Opcore init repo root");
  validateNonEmptyString(payload.repo.requestedPath, "Opcore init requested path");
  validateRequiredObject(payload.options, "Opcore init options are required");
  if (!includesString(opcoreInitScopes, payload.options.scope)) {
    throw new Error(`Unknown Opcore init scope: ${String(payload.options.scope)}`);
  }
  validateBoolean(payload.options.failClosedHook, "Opcore init failClosedHook option");
  validateBoolean(payload.options.dryRun, "Opcore init dryRun option");
  validateStringArray(payload.agentFiles, "Opcore init agentFiles", {
    allowEmpty: true,
  });
  for (const agentFile of payload.agentFiles) validateRepoRelativePath(agentFile);
  validateNonEmptyArray(payload.actions, "Opcore init actions");
  for (const action of payload.actions) validateOpcoreInitAction(action);
  validateStringArray(payload.warnings, "Opcore init warnings", {
    allowEmpty: true,
  });
  validateStringArray(payload.nextActions, "Opcore init nextActions", {
    allowEmpty: false,
  });
  validateBoolean(payload.undoAvailable, "Opcore init undoAvailable");
  validateOpcoreInitScanSummary(payload.scan);
  validateOpcoreInitSettings(payload.settings);
  validateOpcoreInitInteraction(payload.interaction);
  validateOpcoreInitTiming(payload.timings);
  return payload;
}

export { validateOpcoreInitPlanPayload };

function validateOpcoreInitApproval(payload: OpcoreInitPlanPayload): void {
  if (payload.mode === "plan" && payload.approved) {
    throw new Error("Opcore init approved plan must use apply mode");
  }
  if (payload.mode === "apply" && !payload.approved) {
    throw new Error("Opcore init apply mode requires approval");
  }
}

function validateOpcoreInitScanSummary(scan: OpcoreInitScanSummary): OpcoreInitScanSummary {
  validateRequiredObject(scan, "Opcore init scan summary is required");
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
    validateRequiredObject(tool, "Opcore init scan degraded Rust tool is required");
    validateNonEmptyString(tool.adapter, "Opcore init scan degraded Rust adapter");
    validateNonEmptyString(tool.tool, "Opcore init scan degraded Rust tool");
    validateOptional(tool.failureMessage, (value) =>
      validateNonEmptyString(value, "Opcore init scan degraded Rust failureMessage"),
    );
  }
  validateNonNegativeInteger(scan.diagnosticCount, "Opcore init scan diagnosticCount");
  if (!includesString(validationResultStatuses, scan.validationStatus)) {
    throw new Error(`Unknown Opcore init scan validationStatus: ${String(scan.validationStatus)}`);
  }
  validateStringArray(scan.failedChecks, "Opcore init scan failedChecks", {
    allowEmpty: true,
  });
  if (!includesString(graphProviderStatusStates, scan.graphState)) {
    throw new Error(`Unknown Opcore init scan graphState: ${String(scan.graphState)}`);
  }
  if (!includesString(["ready", "degraded", "blocked"] as const, scan.activationLevel)) {
    throw new Error(`Unknown Opcore init scan activationLevel: ${String(scan.activationLevel)}`);
  }
  return scan;
}

export { validateOpcoreInitScanSummary };
