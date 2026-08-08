import {
  validateBoolean,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { validateEditCommandResult, validateEditPlanPayload } from "../edit/validators.js";
import { validateGraphPipelineResult } from "../graph/daemon-validators-01.js";
import { validateGraphServeTransportStatus } from "../graph/daemon-validators-02.js";
import { isNamedQueryResult } from "../graph/payload-validators.js";
import { validateProviderStatus } from "../graph/provider-validators.js";
import {
  validateGraphDetectChangesResult,
  validateGraphFactQueryResult,
  validateGraphImpactResult,
  validateGraphNamedQueryResult,
  validateGraphReviewContextResult,
} from "../graph/query-validators.js";
import { validateGraphSearchResult } from "../graph/search-validators.js";
import { validateInspectRouteResult } from "../inspect/validators.js";
import {
  validateOpcoreDoctorPayload,
  validateOpcoreInitPlanPayload,
  validateOpcoreRuntimeInfoPayload,
} from "../product/init-validators-01.js";
import { validateCommandTiming } from "../product/metrics-validators-01.js";
import { validateOpcoreMeasureDelta, validateOpcoreTryPayload } from "../product/metrics-validators-03.js";
import { validateOpcoreRepoStatePayload } from "../product/status-validators.js";
import { validateExitCodeForStatus, validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import {
  validatePreWriteValidationReceipt,
  validateValidationStatusPayload,
} from "../validation/prewrite-status-validators-01.js";
import { validateValidationResultPayload } from "../validation/result-validator.js";
import type { CommandGroupContract, CommandRouterManifest } from "./contracts.js";
import { validateCommandOwner, validateCommandRouteStatus } from "./helper-validators.js";
import type { CommandRouterResult } from "./router-contracts.js";

function validateCommandRouterManifestHeader(manifest: CommandRouterManifest): void {
  validateRequiredObject(manifest, "Command router manifest is required");
  if (manifest.schemaVersion !== 1) {
    throw new Error("Command router manifest schemaVersion must be 1");
  }
  if (typeof manifest.packageName !== "string" || manifest.packageName.length === 0) {
    throw new Error("Command router manifest packageName must be a non-empty string");
  }
}

export { validateCommandRouterManifestHeader };

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

export { validateManifestBins };

function validateManifestGroups(commandGroups: readonly CommandGroupContract[]): Set<string> {
  const groupNames = new Set<string>();
  for (const group of commandGroups) {
    validateCommandOwner(group.owner);
    validateNonEmptyString(group.name, "Command group name");
    validateStringArray(group.canonicalCommand, "Command group canonicalCommand", { allowEmpty: false });
    validateStringArray(group.commands, "Command group commands", {
      allowEmpty: false,
    });
    validateNonEmptyString(group.summary, "Command group summary");
    groupNames.add(group.name);
  }

  return groupNames;
}

export { validateManifestGroups };

function validateManifestOwnershipBoundaries(boundaries: CommandRouterManifest["ownershipBoundaries"]): void {
  for (const boundary of boundaries) {
    validateCommandOwner(boundary.owner);
    validateNonEmptyString(boundary.summary, "Command ownership boundary summary");
  }
}

export { validateManifestOwnershipBoundaries };

function validateCommandRouterResult(result: CommandRouterResult): CommandRouterResult {
  validateRequiredObject(result, "Command router result is required");
  if (result.schemaVersion !== 1) {
    throw new Error("Command router result schemaVersion must be 1");
  }
  validateNonEmptyString(result.bin, "Command router result bin");
  validateStringArray(result.argv, "Command router result argv", {
    allowEmpty: true,
    allowEmptyValues: true,
  });
  validateStringArray(result.canonicalCommand, "Command router result canonicalCommand", { allowEmpty: false });
  validateCommandOwner(result.owner);
  validateCommandRouteStatus(result.status);
  validateExitCodeForStatus(result.exitCode, result.status);
  validateNonEmptyString(result.message, "Command router result message");
  validateBoolean(result.json, "Command router result json");
  validateCommandRouterGraphPayloads(result);
  validateCommandRouterValidationPayloads(result);
  validateCommandRouterProductPayloads(result);
  validateCommandRouterPayloadOwners(result);
  validateCommandRouterEditMessage(result);
  return result;
}

export { validateCommandRouterResult };

function validateCommandRouterGraphPayloads(result: CommandRouterResult): void {
  validateOptional(result.providerStatus, validateProviderStatus);
  validateOptional(result.graphPipeline, validateGraphPipelineResult);
  validateOptional(result.graphQuery, (query) => {
    if (isNamedQueryResult(query)) validateGraphNamedQueryResult(query);
    else validateGraphFactQueryResult(query);
  });
  validateOptional(result.graphSearch, validateGraphSearchResult);
  validateOptional(result.inspectResult, validateInspectRouteResult);
  validateOptional(result.graphImpact, validateGraphImpactResult);
  validateOptional(result.graphReviewContext, validateGraphReviewContextResult);
  validateOptional(result.graphChanges, validateGraphDetectChangesResult);
  validateOptional(result.graphServe, validateGraphServeTransportStatus);
}

export { validateCommandRouterGraphPayloads };

function validateCommandRouterValidationPayloads(result: CommandRouterResult): void {
  validateOptional(result.validationResult, validateValidationResultPayload);
  validateOptional(result.validationStatus, validateValidationStatusPayload);
  validateOptional(result.receipt, validatePreWriteValidationReceipt);
  validateOptional(result.editPlan, validateEditPlanPayload);
  validateOptional(result.editResult, validateEditCommandResult);
}

export { validateCommandRouterValidationPayloads };

function validateCommandRouterProductPayloads(result: CommandRouterResult): void {
  validateOptional(result.repoState, validateOpcoreRepoStatePayload);
  validateOptional(result.runtimeInfo, validateOpcoreRuntimeInfoPayload);
  validateOptional(result.opcoreDoctor, validateOpcoreDoctorPayload);
  validateOptional(result.opcoreInit, validateOpcoreInitPlanPayload);
  validateOptional(result.opcoreMeasure, validateOpcoreMeasureDelta);
  validateOptional(result.opcoreTry, validateOpcoreTryPayload);
  validateOptional(result.timing, validateCommandTiming);
}

export { validateCommandRouterProductPayloads };

function validateCommandRouterPayloadOwners(result: CommandRouterResult): void {
  validatePayloadOwner(result.repoState, result.owner, "runtime", "Opcore repoState payload requires runtime owner");
  validatePayloadOwner(
    result.runtimeInfo,
    result.owner,
    "runtime",
    "Opcore runtime info payload requires runtime owner",
  );
  validatePayloadOwner(result.opcoreDoctor, result.owner, "runtime", "Opcore doctor payload requires runtime owner");
  validatePayloadOwner(result.opcoreInit, result.owner, "runtime", "Opcore init payload requires runtime owner");
  validatePayloadOwner(result.opcoreMeasure, result.owner, "runtime", "Opcore measure payload requires runtime owner");
  validatePayloadOwner(result.opcoreTry, result.owner, "runtime", "Opcore try payload requires runtime owner");
  validatePayloadOwner(result.editPlan, result.owner, "edit", "Edit router payloads require edit owner");
  validatePayloadOwner(result.editResult, result.owner, "edit", "Edit router payloads require edit owner");
}

export { validateCommandRouterPayloadOwners };

function validatePayloadOwner(
  payload: unknown,
  owner: CommandRouterResult["owner"],
  expectedOwner: CommandRouterResult["owner"],
  message: string,
): void {
  if (payload !== undefined && owner !== expectedOwner) throw new Error(message);
}

export { validatePayloadOwner };

function validateCommandRouterEditMessage(result: CommandRouterResult): void {
  if (result.owner !== "edit" || result.status !== "ok") return;
  if (result.editPlan !== undefined || result.editResult !== undefined) return;
  const hiddenPayloadPattern = /"?(editPlan|editResult|planId|changes|afterState)"?\s*[:{[]/;
  if (hiddenPayloadPattern.test(result.message)) {
    throw new Error("Edit router payloads must use editPlan/editResult fields, not message strings");
  }
}

export { validateCommandRouterEditMessage };
