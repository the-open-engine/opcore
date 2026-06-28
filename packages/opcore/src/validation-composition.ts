import type {
  GraphProviderMode,
  ValidationRequest,
  ValidationResult,
  ValidationStatusPayload
} from "@the-open-engine/opcore-contracts";
import {
  createCheckCommandAdapter,
  createNodeValidationWorkspace,
  createValidationRunner,
  createValidationStatusPayload,
  type ValidationCommandAdapterOptions,
  type ValidationGraphProviderClient,
  type ValidationRuntimePolicy
} from "@the-open-engine/opcore-validation";
import { createPythonValidationAdapterStatus, createPythonValidationChecks } from "@the-open-engine/opcore-validation-python";
import { createRustValidationAdapterStatus, createRustValidationChecks } from "@the-open-engine/opcore-validation-rust";
import { createTypeScriptValidationChecks } from "@the-open-engine/opcore-validation-typescript";
import {
  opcoreGraphDetectChanges,
  opcoreGraphFactQuery,
  opcoreGraphImpact,
  opcoreGraphNamedQuery,
  opcoreGraphReviewContext,
  opcoreGraphStatus
} from "./graph-provider-client.js";
import { commonSkippedPathSegments } from "./source-policy.js";

declare const process: {
  cwd(): string;
};

export const defaultValidationChecks = [
  ...createTypeScriptValidationChecks(),
  ...createRustValidationChecks(),
  ...createPythonValidationChecks()
];

export const opcorePublicValidationRuntimePolicy: ValidationRuntimePolicy = {
  persistentCaches: "disabled"
};

export const checkCommandAdapter = createCheckCommandAdapter(defaultValidationAdapterOptions());

export const opcoreValidationRunner = {
  runValidation(request: ValidationRequest): Promise<ValidationResult> {
    return createValidationRunner({
      workspace: createNodeValidationWorkspace({
        repoRoot: request.repo.repoRoot ?? process.cwd(),
        skippedPathSegments: commonSkippedPathSegments
      }),
      checks: defaultValidationChecks,
      graphProviderClient: createOpcoreValidationGraphProviderClient(),
      runtime: opcorePublicValidationRuntimePolicy
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
    adapters: [createRustValidationAdapterStatus(), createPythonValidationAdapterStatus()],
    graphMode,
    graphStatus: opcoreGraphStatus({ repoRoot: options.repoRoot }, graphMode)
  });
}

function defaultValidationAdapterOptions(): ValidationCommandAdapterOptions {
  return {
    checks: defaultValidationChecks,
    graphProviderClient: createOpcoreValidationGraphProviderClient(),
    runtime: opcorePublicValidationRuntimePolicy,
    workspaceFactory: (repoRoot) =>
      createNodeValidationWorkspace({
        repoRoot,
        skippedPathSegments: commonSkippedPathSegments
      })
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
