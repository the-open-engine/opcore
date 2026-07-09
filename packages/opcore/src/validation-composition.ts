import type {
  CommandAdapter,
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
import {
  opcoreGraphDetectChanges,
  opcoreGraphFactQuery,
  opcoreGraphImpact,
  opcoreGraphNamedQuery,
  opcoreGraphReviewContext,
  opcoreGraphStatus
} from "./graph-provider-client.js";
import {
  defaultValidationChecks,
  validationChecksForRepoPolicy
} from "./repo-validation-policy.js";
import { commonSkippedPathSegments } from "./source-policy.js";

declare const process: {
  cwd(): string;
};

export const opcorePublicValidationRuntimePolicy: ValidationRuntimePolicy = {
  persistentCaches: "disabled"
};

export const checkCommandAdapter = createOpcoreCheckCommandAdapter();

export function createOpcoreCheckCommandAdapter(
  options: Pick<ValidationCommandAdapterOptions, "streamWriter" | "defaultRepoRoot"> = {}
): CommandAdapter {
  return createCheckCommandAdapter({
    ...defaultValidationAdapterOptions(options.defaultRepoRoot),
    ...options
  });
}

export const opcoreValidationRunner = {
  runValidation(request: ValidationRequest): Promise<ValidationResult> {
    const repoRoot = request.repo.repoRoot ?? process.cwd();
    return createValidationRunner({
      workspace: createNodeValidationWorkspace({
        repoRoot,
        skippedPathSegments: commonSkippedPathSegments
      }),
      checks: validationChecksForRepoPolicy(repoRoot),
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
    checks: validationChecksForRepoPolicy(options.repoRoot),
    adapters: [createRustValidationAdapterStatus(), createPythonValidationAdapterStatus()],
    graphMode,
    graphStatus: opcoreGraphStatus({ repoRoot: options.repoRoot }, graphMode)
  });
}

function defaultValidationAdapterOptions(repoRoot = process.cwd()): ValidationCommandAdapterOptions {
  return {
    checksFactory: validationChecksForRepoPolicy,
    graphProviderClient: createOpcoreValidationGraphProviderClient(),
    runtime: opcorePublicValidationRuntimePolicy,
    defaultRepoRoot: repoRoot,
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
