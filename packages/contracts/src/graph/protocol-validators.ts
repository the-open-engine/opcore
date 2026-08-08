import {
  includesString,
  validateOptional,
  validateRequiredObject,
} from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import type {
  GraphExtractionDiagnostic,
  GraphProviderArtifactMetadata,
  ProviderFailure,
} from "./provider-contracts-01.js";
import type { GraphWalCheckpointSummary, GraphWatchLifecycle } from "./pipeline-contracts.js";
import { providerFailureCategories } from "./vocabulary-01.js";
import { graphExtractionDiagnosticCategories } from "./vocabulary-02.js";

function validateGraphWatchLifecycle(lifecycle: GraphWatchLifecycle): GraphWatchLifecycle {
  validateRequiredObject(lifecycle, "Graph watch lifecycle is required");
  if (!["warming", "available", "error", "stopped"].includes(lifecycle.state)) {
    throw new Error(`Unknown graph watch lifecycle state: ${String(lifecycle.state)}`);
  }
  if (lifecycle.pid !== undefined && (!Number.isInteger(lifecycle.pid) || lifecycle.pid < 1)) {
    throw new Error("Graph watch lifecycle pid must be positive");
  }
  validateNonEmptyString(lifecycle.startedAt, "Graph watch lifecycle startedAt");
  validateNonEmptyString(lifecycle.updatedAt, "Graph watch lifecycle updatedAt");
  validateNonEmptyString(lifecycle.pidPath, "Graph watch lifecycle pidPath");
  validateNonEmptyString(lifecycle.statePath, "Graph watch lifecycle statePath");
  validateNonEmptyString(lifecycle.logPath, "Graph watch lifecycle logPath");
  if (typeof lifecycle.pollIntervalMs !== "number" || lifecycle.pollIntervalMs < 1) {
    throw new Error("Graph watch lifecycle pollIntervalMs must be positive");
  }
  if (
    typeof lifecycle.idleTimeoutMs !== "number" ||
    !Number.isFinite(lifecycle.idleTimeoutMs) ||
    lifecycle.idleTimeoutMs < 0
  ) {
    throw new Error("Graph watch lifecycle idleTimeoutMs must be a non-negative number");
  }
  validateOptional(lifecycle.watchPaths, (paths) => {
    validateStringArray(paths, "Graph watch lifecycle watchPaths", { allowEmpty: true });
    for (const path of paths) validateRepoRelativePath(path);
  });
  validateOptional(lifecycle.message, (value) => validateNonEmptyString(value, "Graph watch lifecycle message"));
  return lifecycle;
}

export { validateGraphWatchLifecycle };

function validateGraphWalCheckpointSummary(summary: GraphWalCheckpointSummary): GraphWalCheckpointSummary {
  validateNonEmptyString(summary.walPath, "Graph WAL checkpoint walPath");
  for (const key of ["bytesBefore", "bytesAfter", "budgetBytes"] as const) {
    if (typeof summary[key] !== "number" || summary[key] < 0) {
      throw new Error(`Graph WAL checkpoint ${key} must be non-negative`);
    }
  }
  if (typeof summary.checkpointed !== "boolean") {
    throw new Error("Graph WAL checkpoint checkpointed must be boolean");
  }
  return summary;
}

export { validateGraphWalCheckpointSummary };

function validateGraphProviderArtifactMetadata(metadata: GraphProviderArtifactMetadata): GraphProviderArtifactMetadata {
  validateRequiredObject(metadata, "Graph provider artifact metadata is required");
  for (const key of [
    "artifactName",
    "artifactVersion",
    "targetPlatform",
    "binaryPath",
    "checksumPath",
    "checksumSha256",
    "buildProfile",
  ] as const) {
    validateNonEmptyString(metadata[key], `Graph provider artifact metadata ${key}`);
  }
  for (const key of ["binaryPath", "checksumPath"] as const) {
    validateRepoRelativePath(metadata[key]);
    if (metadata[key].startsWith("packages/") || metadata[key].startsWith("../")) {
      throw new Error(`Graph provider artifact metadata ${key} must be package-relative`);
    }
  }
  return metadata;
}

export { validateGraphProviderArtifactMetadata };

function validateGraphExtractionDiagnostics(
  diagnostics: readonly GraphExtractionDiagnostic[],
): readonly GraphExtractionDiagnostic[] {
  if (!Array.isArray(diagnostics)) {
    throw new Error("Graph extraction diagnostics must be an array");
  }
  for (const diagnostic of diagnostics) validateGraphExtractionDiagnostic(diagnostic);
  return diagnostics;
}

export { validateGraphExtractionDiagnostics };

function validateGraphExtractionDiagnostic(diagnostic: GraphExtractionDiagnostic): GraphExtractionDiagnostic {
  validateRequiredObject(diagnostic, "Graph extraction diagnostic is required");
  if (!includesString(graphExtractionDiagnosticCategories, diagnostic.category)) {
    throw new Error(`Unknown graph extraction diagnostic category: ${String(diagnostic.category)}`);
  }
  if (!includesString(["info", "warning", "error"] as const, diagnostic.severity)) {
    throw new Error(`Unknown graph extraction diagnostic severity: ${String(diagnostic.severity)}`);
  }
  validateNonEmptyString(diagnostic.message, "Graph extraction diagnostic message");
  if (diagnostic.path !== undefined) validateRepoRelativePath(diagnostic.path);
  if (diagnostic.language !== undefined) {
    validateNonEmptyString(diagnostic.language, "Graph extraction diagnostic language");
  }
  return diagnostic;
}

export { validateGraphExtractionDiagnostic };

function validateProviderFailure(failure: ProviderFailure): ProviderFailure {
  validateRequiredObject(failure, "Provider failure is required");
  if (!includesString(providerFailureCategories, failure.category)) {
    throw new Error(`Unknown provider failure category: ${String(failure.category)}`);
  }
  validateNonEmptyString(failure.message, "Provider failure message");
  if (failure.retryable !== undefined && typeof failure.retryable !== "boolean") {
    throw new Error("Provider failure retryable must be boolean");
  }
  if (failure.cause !== undefined) validateNonEmptyString(failure.cause, "Provider failure cause");
  return failure;
}

export { validateProviderFailure };
