import type {
  GraphProviderMode,
  ValidationRequest,
  ValidationResult,
  ValidationStatusPayload
} from "@the-open-engine/lattice-contracts";
import {
  createCheckCommandAdapter,
  createNodeValidationWorkspace,
  createValidationRunner,
  createValidationStatusPayload,
  type ValidationCommandAdapterOptions,
  type ValidationGraphProviderClient
} from "@the-open-engine/lattice-validation";
import { createRustValidationAdapterStatus, createRustValidationChecks } from "@the-open-engine/lattice-validation-rust";
import { createTypeScriptValidationChecks } from "@the-open-engine/lattice-validation-typescript";
import {
  opcoreGraphDetectChanges,
  opcoreGraphFactQuery,
  opcoreGraphImpact,
  opcoreGraphNamedQuery,
  opcoreGraphReviewContext,
  opcoreGraphStatus
} from "./graph-provider-client.js";

declare const process: {
  cwd(): string;
};

export const defaultValidationChecks = [...createTypeScriptValidationChecks(), ...createRustValidationChecks()];

export const checkCommandAdapter = createCheckCommandAdapter(defaultValidationAdapterOptions());

export const opcoreValidationRunner = {
  runValidation(request: ValidationRequest): Promise<ValidationResult> {
    return createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: request.repo.repoRoot ?? process.cwd() }),
      checks: defaultValidationChecks,
      graphProviderClient: createOpcoreValidationGraphProviderClient()
    }).runValidation(request);
  }
};

export function createDefaultValidationStatusPayload(options: {
  repoRoot: string;
  graphMode?: GraphProviderMode;
}): ValidationStatusPayload {
  const graphMode = options.graphMode ?? "optional";
  return createValidationStatusPayload({
    checks: defaultValidationChecks,
    adapters: [createRustValidationAdapterStatus()],
    graphMode,
    graphStatus: opcoreGraphStatus({ repoRoot: options.repoRoot }, graphMode)
  });
}

function defaultValidationAdapterOptions(): ValidationCommandAdapterOptions {
  return {
    checks: defaultValidationChecks,
    graphProviderClient: createOpcoreValidationGraphProviderClient()
  };
}

export function createOpcoreValidationGraphProviderClient(): ValidationGraphProviderClient {
  return {
    status: (request) => opcoreGraphStatus(request.repo, request.graph.mode),
    factQuery: opcoreGraphFactQuery,
    namedQuery: opcoreGraphNamedQuery,
    impact: opcoreGraphImpact,
    reviewContext: opcoreGraphReviewContext,
    detectChanges: opcoreGraphDetectChanges
  };
}
