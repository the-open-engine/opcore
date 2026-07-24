import type {
  CommandAdapter,
  GraphProviderMode,
  PythonProjectContext,
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
  type ValidationGraphProviderClient,
  type ValidationGraphSessionFactory
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
import { createOpcoreGraphSessionFactory } from "../validation-graph-session.js";

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
    const graphProviderClient = createCliValidationGraphProviderClient();
    return createValidationRunner({
      workspace: createNodeValidationWorkspace({
        repoRoot,
        skippedPathSegments: commonSkippedPathSegments
      }),
      checks: validationChecksForRepoPolicy(repoRoot),
      graphProviderClient,
      graphSessionFactory: createCliValidationGraphSessionFactory(graphProviderClient)
    }).runValidation(request);
  }
};

declare const process: {
  cwd(): string;
};

export function createDefaultValidationStatusPayload(options: {
  repoRoot: string;
  graphMode?: GraphProviderMode;
  pythonProjectContexts?: readonly PythonProjectContext[];
}): ValidationStatusPayload {
  const graphMode = options.graphMode ?? "optional";
  const checks = validationChecksForRepoPolicy(options.repoRoot);
  return createValidationStatusPayload({
    checks,
    adapters: [
      createRustValidationAdapterStatus(),
      createPythonValidationAdapterStatus({
        repoRoot: options.repoRoot,
        contexts: options.pythonProjectContexts,
        activeCheckIds: checks
          .filter((check) => (check.defaultScopes ?? check.supportedScopes).length > 0)
          .map((check) => check.id)
      })
    ],
    graphMode,
    graphStatus: cliGraphStatus({ repoRoot: options.repoRoot }, graphMode)
  });
}

function defaultValidationAdapterOptions(repoRoot = process.cwd()): ValidationCommandAdapterOptions {
  const graphProviderClient = createCliValidationGraphProviderClient();
  return {
    checksFactory: validationChecksForRepoPolicy,
    graphProviderClient,
    graphSessionFactory: createCliValidationGraphSessionFactory(graphProviderClient),
    defaultRepoRoot: repoRoot,
    workspaceFactory: (targetRepoRoot) =>
      createNodeValidationWorkspace({
        repoRoot: targetRepoRoot,
        skippedPathSegments: commonSkippedPathSegments
      })
  };
}

export function createCliValidationGraphSessionFactory(
  persistentClient: ValidationGraphProviderClient = createCliValidationGraphProviderClient()
): ValidationGraphSessionFactory {
  return createOpcoreGraphSessionFactory(persistentClient);
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

export { defaultValidationChecks, createPythonValidationChecks, createRustValidationChecks };
