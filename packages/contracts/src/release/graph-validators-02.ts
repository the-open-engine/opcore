import { includesString } from "../shared/primitives.js";
import { validateGraphProviderArtifactMetadata } from "../graph/protocol-validators.js";
import {
  validateExactStringSet,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateSha256,
  validateStringArray,
} from "../shared/validators-01.js";
import {
  validateExactValue,
  validateRequiredObject,
} from "../shared/validators-02.js";
import type {
  GraphReleaseHandoffReceipt,
  GraphReleaseNativeArtifactEvidence,
  GraphReleasePackageInspection,
  GraphReleaseReportReceipt,
} from "./graph-contracts.js";
import { validateGraphReleaseHandoffIssue } from "./graph-validators-03.js";
import type {
  GraphReleaseBenchmarkMetric,
  GraphReleaseCoreCommandId,
  GraphReleaseRustCommandId} from "./graph-vocabulary-01.js";
import {
  graphReleaseBenchmarkMetrics,
  graphReleaseCoreCommandIds,
  graphReleaseHandoffIssues,
  graphReleaseRustCommandIds,
} from "./graph-vocabulary-01.js";
import {
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets,
  graphReleaseReportReceiptIds,
} from "./graph-vocabulary-02.js";

function validateGraphReleasePackageInspection(inspection: GraphReleasePackageInspection): void {
  if (!inspection || typeof inspection !== "object") throw new Error("Graph release packageInspection is required");
  if (inspection.packageName !== "@the-open-engine/opcore-graph") {
    throw new Error("Graph release packageInspection packageName must be @the-open-engine/opcore-graph");
  }
  validateNonEmptyString(inspection.tarballName, "Graph release packageInspection tarballName");
  if (typeof inspection.fileCount !== "number" || inspection.fileCount <= 0) {
    throw new Error("Graph release packageInspection fileCount must be positive");
  }
  validateStringArray(inspection.files, "Graph release packageInspection files", { allowEmpty: false });
  if (inspection.fileCount !== inspection.files.length) {
    throw new Error("Graph release packageInspection fileCount must equal files length");
  }
  validateStringArray(inspection.inspections, "Graph release packageInspection inspections", { allowEmpty: false });
  for (const key of [
    "forbiddenMarkersAbsent",
    "generatedBuildMetadataAbsent",
    "privatePathsAbsent",
    "sourceProvenanceAbsent",
    "packageMetadataAbsent",
    "gitHistoryAbsent",
    "foreignImplementationNamesAbsent",
  ] as const) {
    if (inspection[key] !== true) throw new Error(`Graph release packageInspection ${key} must be true`);
  }
}

export { validateGraphReleasePackageInspection };

function validateGraphReleaseNativeArtifacts(nativeArtifacts: readonly GraphReleaseNativeArtifactEvidence[]): void {
  validateNonEmptyArray(nativeArtifacts, "Graph release nativeArtifacts");
  validateExactStringSet(
    nativeArtifacts.map((artifact) => artifact.targetPlatform),
    graphCoreNativeSupportedTargets,
    "Graph release native artifact targets",
  );
  for (const nativeArtifact of nativeArtifacts) validateGraphReleaseNativeArtifact(nativeArtifact);
}

export { validateGraphReleaseNativeArtifacts };

function validateGraphReleaseNativeArtifact(nativeArtifact: GraphReleaseNativeArtifactEvidence): void {
  validateRequiredObject(nativeArtifact, "Graph release native artifact evidence is required");
  const expectedPackageName = graphCoreNativePackageNameForTarget(nativeArtifact.targetPlatform);
  validateExactValue(
    nativeArtifact.packageName,
    expectedPackageName,
    `Graph release native artifact packageName for ${nativeArtifact.targetPlatform} must be ${expectedPackageName}`,
  );
  validateGraphProviderArtifactMetadata(nativeArtifact.metadata);
  validateExactValue(
    nativeArtifact.metadata.targetPlatform,
    nativeArtifact.targetPlatform,
    "Graph release native artifact targetPlatform must match metadata",
  );
  validateExactValue(
    nativeArtifact.binaryPath,
    "opcore-graph-core",
    "Graph release native binaryPath must be opcore-graph-core",
  );
  validateExactValue(
    nativeArtifact.checksumPath,
    "opcore-graph-core.sha256",
    "Graph release native checksumPath must be opcore-graph-core.sha256",
  );
  validateExactValue(
    nativeArtifact.metadataPath,
    "metadata.json",
    "Graph release native metadataPath must be metadata.json",
  );
  validateExactValue(
    nativeArtifact.metadata.binaryPath,
    nativeArtifact.binaryPath,
    "Graph release native artifact binaryPath must match metadata",
  );
  validateExactValue(
    nativeArtifact.metadata.checksumPath,
    nativeArtifact.checksumPath,
    "Graph release native artifact checksumPath must match metadata",
  );
  validateExactValue(
    nativeArtifact.metadata.checksumSha256,
    nativeArtifact.binarySha256,
    "Graph release native artifact metadata checksum must match binary sha256",
  );
  validateSha256(nativeArtifact.binarySha256, "Graph release native artifact binarySha256");
  validateSha256(nativeArtifact.checksumFileSha256, "Graph release native artifact checksumFileSha256");
  validateSha256(nativeArtifact.metadataSha256, "Graph release native artifact metadataSha256");
  validateExactStringSet(
    nativeArtifact.packageFiles,
    ["package.json", "README.md", "opcore-graph-core", "opcore-graph-core.sha256", "metadata.json"],
    `Graph release native package files ${nativeArtifact.targetPlatform}`,
  );
}

function validateGraphReleaseReportReceipts(receipts: readonly GraphReleaseReportReceipt[]): void {
  validateNonEmptyArray(receipts, "Graph release reportReceipts");
  validateExactStringSet(
    receipts.map((entry) => entry.id),
    graphReleaseReportReceiptIds,
    "Graph release report receipt ids",
  );
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") throw new Error("Graph release report receipt is required");
    if (!includesString(graphReleaseReportReceiptIds, receipt.id)) {
      throw new Error(`Unknown graph release report receipt id: ${String(receipt.id)}`);
    }
    validateStringArray(receipt.command, "Graph release report receipt command", { allowEmpty: false });
    if (receipt.status !== "passed") throw new Error("Graph release report receipt status must be passed");
    if (receipt.exitCode !== 0) throw new Error("Graph release report receipt exitCode must be 0");
    validateNonEmptyString(receipt.path, "Graph release report receipt path");
    if (receipt.checksumSha256 !== undefined)
      validateNonEmptyString(receipt.checksumSha256, "Graph release report receipt checksumSha256");
  }
}

export { validateGraphReleaseReportReceipts };

function validateGraphReleaseHandoff(handoff: readonly GraphReleaseHandoffReceipt[]): void {
  validateNonEmptyArray(handoff, "Graph release handoff");
  validateExactStringSet(
    handoff.map((entry) => entry.issue),
    graphReleaseHandoffIssues,
    "Graph release handoff issues",
  );
  for (const entry of handoff) {
    if (!entry || typeof entry !== "object") throw new Error("Graph release handoff entry is required");
    validateGraphReleaseHandoffIssue(entry.issue);
    validateNonEmptyString(entry.receiptPath, "Graph release handoff receiptPath");
    validateNonEmptyString(entry.checksumSha256, "Graph release handoff checksumSha256");
    validateNonEmptyString(entry.rollbackNote, "Graph release handoff rollbackNote");
  }
}

export { validateGraphReleaseHandoff };

function validateGraphReleaseCoreCommandId(id: unknown): GraphReleaseCoreCommandId {
  if (!includesString(graphReleaseCoreCommandIds, id)) {
    throw new Error(`Unknown graph release command id: ${String(id)}`);
  }
  return id;
}

export { validateGraphReleaseCoreCommandId };

function validateGraphReleaseRustCommandId(id: unknown): GraphReleaseRustCommandId {
  if (!includesString(graphReleaseRustCommandIds, id)) {
    throw new Error(`Unknown graph release Rust command id: ${String(id)}`);
  }
  return id;
}

export { validateGraphReleaseRustCommandId };

function validateGraphReleaseBenchmarkMetric(metric: unknown): GraphReleaseBenchmarkMetric {
  if (!includesString(graphReleaseBenchmarkMetrics, metric)) {
    throw new Error(`Unknown graph release benchmark metric: ${String(metric)}`);
  }
  return metric;
}

export { validateGraphReleaseBenchmarkMetric };
