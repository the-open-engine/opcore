import type {
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
import { createTypeScriptValidationChecks } from "@the-open-engine/opcore-validation-typescript";
import {
  cliGraphDetectChanges,
  cliGraphFactQuery,
  cliGraphImpact,
  cliGraphNamedQuery,
  cliGraphReviewContext,
  cliGraphStatus
} from "./graph-provider-client.js";

export const defaultValidationChecks = [
  ...createTypeScriptValidationChecks(),
  ...createRustValidationChecks(),
  ...createPythonValidationChecks()
];

export const checkCommandAdapter = createCheckCommandAdapter(defaultValidationAdapterOptions());
export const validateCommandAdapter = createValidateCommandAdapter(defaultValidationAdapterOptions());
export const editValidationRunner = {
  runValidation(request: ValidationRequest): Promise<ValidationResult> {
    return createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: request.repo.repoRoot ?? process.cwd() }),
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
    graphProviderClient: createCliValidationGraphProviderClient()
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
