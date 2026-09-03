import { validateOptional, validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateRepoIdentity } from "../shared/path-validators.js";
import { validateGraphFreshness, validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import { validateGraphDaemonOperation, validateGraphProviderQueryKind } from "./helper-validators.js";
import {
  validateGraphExtractionDiagnostics,
  validateGraphProviderArtifactMetadata,
  validateGraphWalCheckpointSummary,
  validateGraphWatchLifecycle,
} from "./protocol-validators.js";
import type { GraphProviderCapabilityHandshake } from "./provider-contracts-01.js";
import type { GraphProviderFailureStatus, GraphProviderStatus } from "./provider-contracts-02.js";
import {
  graphProviderFailureCategoriesByState,
  graphProviderModes,
  graphProviderStatusStates,
  providerFailureCategories,
} from "./vocabulary-01.js";

function validateProviderStatus(status: GraphProviderStatus): GraphProviderStatus {
  validateRequiredObject(status, "Graph provider status is required");
  validateProviderStatusHeader(status);
  if (status.state === "available") return validateAvailableProviderStatus(status);
  if (status.state === "warming") return validateWarmingProviderStatus(status);
  validateProviderFailureStatus(status);
  return status;
}

export { validateProviderStatus };

function validateProviderStatusHeader(status: GraphProviderStatus): void {
  if (!includesString(graphProviderStatusStates, status.state)) {
    throw new Error(`Unknown graph provider status state: ${String(status.state)}`);
  }
  if (!includesString(graphProviderModes, status.mode)) {
    throw new Error(`Unknown graph provider mode: ${String(status.mode)}`);
  }
  if (typeof status.provider !== "string" || status.provider.length === 0) {
    throw new Error("Graph provider status must include provider");
  }
  if (typeof status.schemaVersion !== "number") {
    throw new Error("Graph provider status must include numeric schemaVersion");
  }
  if (status.state === "skipped" && status.mode !== "optional") {
    throw new Error("Skipped graph provider status must use optional mode");
  }
  if (status.state === "required_missing" && status.mode !== "required") {
    throw new Error("Required-missing graph provider status must use required mode");
  }
}

function validateAvailableProviderStatus(
  status: Extract<GraphProviderStatus, { state: "available" }>,
): GraphProviderStatus {
  validateRepoIdentity(status.repo);
  validateGraphFreshness(status.freshness, "Available");
  validateGraphKindCounts(status.nodes_by_kind, "nodes_by_kind");
  validateGraphKindCounts(status.edges_by_kind, "edges_by_kind");
  validateOptional(status.handshake, validateGraphProviderCapabilityHandshake);
  validateOptional(status.walCheckpoint, validateGraphWalCheckpointSummary);
  return status;
}

function validateWarmingProviderStatus(
  status: Extract<GraphProviderStatus, { state: "warming" }>,
): GraphProviderStatus {
  validateRepoIdentity(status.repo);
  validateGraphFreshness(status.freshness, "Warming");
  validateOptional(status.lifecycle, validateGraphWatchLifecycle);
  return status;
}

function validateGraphKindCounts(counts: Readonly<Record<string, number>>, label: string): void {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error(`Graph provider status ${label} must be an object`);
  }
  for (const [kind, count] of Object.entries(counts)) {
    if (kind.length === 0) throw new Error(`Graph provider status ${label} kind must not be empty`);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Graph provider status ${label}.${kind} must be a non-negative integer`);
    }
  }
}

export { validateGraphKindCounts };

function validateProviderFailureStatus(status: GraphProviderFailureStatus): void {
  if (!status.failure?.category) {
    throw new Error(`Graph provider ${status.state} status must include failure.category`);
  }
  if (!includesString(providerFailureCategories, status.failure.category)) {
    throw new Error(`Unknown graph provider failure category: ${status.failure.category}`);
  }
  const allowedCategories = graphProviderFailureCategoriesByState[status.state];
  if (!includesString(allowedCategories, status.failure.category)) {
    throw new Error(
      `Graph provider ${status.state} failure category must be one of ${allowedCategories.join(", ")}; ` +
        `got ${status.failure.category}`,
    );
  }
  validateStaleProviderStatus(status);
  validateSchemaMismatchProviderStatus(status);
  validateErrorProviderStatus(status);
}

export { validateProviderFailureStatus };

function validateStaleProviderStatus(status: GraphProviderFailureStatus): void {
  if (status.state !== "stale") return;
  if (!status.repo) throw new Error("Stale graph provider status must include repo");
  validateRepoIdentity(status.repo);
  validateGraphFreshness(status.freshness, "Stale");
}

function validateSchemaMismatchProviderStatus(status: GraphProviderFailureStatus): void {
  if (status.state !== "schema_mismatch") return;
  if (typeof status.expectedSchemaVersion !== "number") {
    throw new Error("Schema-mismatch graph provider status must include expectedSchemaVersion");
  }
  if (typeof status.actualSchemaVersion !== "number") {
    throw new Error("Schema-mismatch graph provider status must include actualSchemaVersion");
  }
}

function validateErrorProviderStatus(status: GraphProviderFailureStatus): void {
  if (status.state === "error") validateOptional(status.diagnostics, validateGraphExtractionDiagnostics);
}

function validateGraphProviderCapabilityHandshake(
  handshake: GraphProviderCapabilityHandshake,
): GraphProviderCapabilityHandshake {
  validateRequiredObject(handshake, "Graph provider capability handshake is required");
  validateNonEmptyString(handshake.provider, "Graph provider capability handshake provider");
  if (typeof handshake.graphSchemaVersion !== "number") {
    throw new Error("Graph provider capability handshake graphSchemaVersion must be numeric");
  }
  validateNonEmptyString(handshake.artifactName, "Graph provider capability handshake artifactName");
  validateNonEmptyString(handshake.artifactVersion, "Graph provider capability handshake artifactVersion");
  validateNonEmptyString(handshake.targetPlatform, "Graph provider capability handshake targetPlatform");
  validateStringArray(handshake.supportedOperations, "Graph provider capability handshake supportedOperations", {
    allowEmpty: false,
  });
  for (const operation of handshake.supportedOperations) validateGraphDaemonOperation(operation);
  validateStringArray(handshake.nodeKinds, "Graph provider capability handshake nodeKinds", { allowEmpty: false });
  validateStringArray(handshake.edgeKinds, "Graph provider capability handshake edgeKinds", { allowEmpty: false });
  validateStringArray(handshake.queryKinds, "Graph provider capability handshake queryKinds", { allowEmpty: false });
  for (const queryKind of handshake.queryKinds) validateGraphProviderQueryKind(queryKind);
  validateGraphProviderArtifactMetadata(handshake.artifact);
  if (handshake.artifact.artifactName !== handshake.artifactName) {
    throw new Error("Graph provider capability handshake artifactName must match artifact metadata");
  }
  if (handshake.artifact.targetPlatform !== handshake.targetPlatform) {
    throw new Error("Graph provider capability handshake targetPlatform must match artifact metadata");
  }
  return handshake;
}

export { validateGraphProviderCapabilityHandshake };
