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
import { createCloneValidationChecks } from "@the-open-engine/opcore-validation-clone";
import { createPythonValidationAdapterStatus, createPythonValidationChecks } from "@the-open-engine/opcore-validation-python";
import { createRustValidationAdapterStatus, createRustValidationChecks } from "@the-open-engine/opcore-validation-rust";
import { createTypeScriptValidationChecks } from "@the-open-engine/opcore-validation-typescript";
import {
  cliGraphDetectChanges,
  cliGraphFactQuery,
  cliGraphImpact,
  cliGraphNamedQuery,
  cliGraphReviewContext,
  cliGraphStatus
} from "./graph-provider-client.js";
import { invokeCloneAnalysis } from "../clone-invoker.js";
import { commonSkippedPathSegments } from "../source-policy.js";

export const defaultValidationChecks = [
  ...createTypeScriptValidationChecks(),
  ...createRustValidationChecks(),
  ...createPythonValidationChecks(),
  ...createCloneValidationChecks({ invoke: invokeCloneAnalysis })
];

export const checkCommandAdapter = createCliCheckCommandAdapter();
export const validateCommandAdapter = createCliValidateCommandAdapter();

export function createCliCheckCommandAdapter(
  options: Pick<ValidationCommandAdapterOptions, "streamWriter"> = {}
): CommandAdapter {
  return createCheckCommandAdapter({
    ...defaultValidationAdapterOptions(),
    ...options
  });
}

export function createCliValidateCommandAdapter(
  options: Pick<ValidationCommandAdapterOptions, "streamWriter"> = {}
): CommandAdapter {
  return createValidateCommandAdapter({
    ...defaultValidationAdapterOptions(),
    ...options
  });
}

export const editValidationRunner = {
  runValidation(request: ValidationRequest): Promise<ValidationResult> {
    return createValidationRunner({
      workspace: createNodeValidationWorkspace({
        repoRoot: request.repo.repoRoot ?? process.cwd(),
        skippedPathSegments: commonSkippedPathSegments
      }),
      checks: defaultValidationChecks,
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
    checks: defaultValidationChecks,
    adapters: [createRustValidationAdapterStatus(), createPythonValidationAdapterStatus()],
    graphMode,
    graphStatus: cliGraphStatus({ repoRoot: options.repoRoot }, graphMode)
  });
}

function defaultValidationAdapterOptions(): ValidationCommandAdapterOptions {
  return {
    checks: defaultValidationChecks,
    graphProviderClient: createCliValidationGraphProviderClient(),
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
