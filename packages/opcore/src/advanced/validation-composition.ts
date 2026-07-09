import type {
  CommandAdapter,
  GraphProviderMode,
  ValidationRequest,
  ValidationResult,
  ValidationStatusPayload
} from "@the-open-engine/opcore-contracts";
import {
  createCheckCommandAdapter,
  createValidateCommandAdapter,
  createNodeValidationWorkspace,
  createValidationRunner,
  createValidationStatusPayload,
  type ValidationCommandAdapterOptions,
  type ValidationGraphProviderClient
} from "@the-open-engine/opcore-validation";
import { createPythonValidationAdapterStatus, createPythonValidationChecks } from "@the-open-engine/opcore-validation-python";
import { createRustValidationAdapterStatus, createRustValidationChecks } from "@the-open-engine/opcore-validation-rust";
import {
  cliGraphDetectChanges,
  cliGraphFactQuery,
  cliGraphImpact,
  cliGraphNamedQuery,
  cliGraphReviewContext,
  cliGraphStatus
} from "./graph-provider-client.js";
import {
  defaultValidationChecks,
  validationChecksForRepoPolicy
} from "../repo-validation-policy.js";
import { commonSkippedPathSegments } from "../source-policy.js";

export const checkCommandAdapter = createCliCheckCommandAdapter();
export const validateCommandAdapter = createCliValidateCommandAdapter();

export function createCliCheckCommandAdapter(
  options: Pick<ValidationCommandAdapterOptions, "streamWriter" | "defaultRepoRoot"> = {}
): CommandAdapter {
  return createCheckCommandAdapter({
    ...defaultValidationAdapterOptions(options.defaultRepoRoot),
    ...options
  });
}

export function createCliValidateCommandAdapter(
  options: Pick<ValidationCommandAdapterOptions, "streamWriter" | "defaultRepoRoot"> = {}
): CommandAdapter {
  return createValidateCommandAdapter({
    ...defaultValidationAdapterOptions(options.defaultRepoRoot),
    ...options
  });
}

export const editValidationRunner = {
  runValidation(request: ValidationRequest): Promise<ValidationResult> {
    const repoRoot = request.repo.repoRoot ?? process.cwd();
    return createValidationRunner({
      workspace: createNodeValidationWorkspace({
        repoRoot,
        skippedPathSegments: commonSkippedPathSegments
      }),
      checks: validationChecksForRepoPolicy(repoRoot),
      graphProviderClient: createCliValidationGraphProviderClient()
    }).runValidation(request);
  }
};

declare const process: {
  cwd(): string;
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
    graphStatus: cliGraphStatus({ repoRoot: options.repoRoot }, graphMode)
  });
}

function defaultValidationAdapterOptions(repoRoot = process.cwd()): ValidationCommandAdapterOptions {
  return {
    checksFactory: validationChecksForRepoPolicy,
    graphProviderClient: createCliValidationGraphProviderClient(),
    defaultRepoRoot: repoRoot,
    workspaceFactory: (repoRoot) =>
      createNodeValidationWorkspace({
        repoRoot,
        skippedPathSegments: commonSkippedPathSegments
      })
  };
}

function createCliValidationGraphProviderClient(): ValidationGraphProviderClient {
  return {
    status: (request) => cliGraphStatus(request.repo, request.graph.mode),
    factQuery: cliGraphFactQuery,
    namedQuery: cliGraphNamedQuery,
    impact: cliGraphImpact,
    reviewContext: cliGraphReviewContext,
    detectChanges: cliGraphDetectChanges
  };
}
