import { validateGraphProviderArtifactMetadata } from "../graph/protocol-validators.js";
import type { ManagedToolDescriptorChecksumReference } from "../managed/contracts.js";
import {
  bundledGraphCoreNativePath,
  graphCoreNativeTargetForPackageName,
  isGraphCoreNativePackageName,
  validateReleaseReceiptPackageName,
} from "../managed/helper-validators.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  packageEvidenceIncludesFile,
  validateExactStringSet,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateSha256,
} from "../shared/validators-01.js";
import {
  validateExactValue,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { graphCoreNativeSupportedTargets } from "./graph-vocabulary-02.js";
import type {
  ReleaseReceiptDescriptorEvidence,
  ReleaseReceiptLicenseEvidence,
  ReleaseReceiptNativeArtifactEvidence,
  ReleaseReceiptPackageEvidence,
  ReleaseReceiptProvenanceEvidence,
  ReleaseReceiptResolvedChecksumEvidence,
  ReleaseReceiptSecretHistoryEvidence,
} from "./receipt-contracts-01.js";
import { releaseReceiptPackageNames } from "./vocabulary-01.js";

function validateReleaseResolvedChecksums(
  resolvedChecksums: readonly ReleaseReceiptResolvedChecksumEvidence[],
  descriptorChecksums: readonly ManagedToolDescriptorChecksumReference[],
  packages: readonly ReleaseReceiptPackageEvidence[],
): void {
  validateNonEmptyArray(resolvedChecksums, "Release receipt descriptor resolvedChecksums");
  validateExactStringSet(
    resolvedChecksums.map((entry) => entry.id),
    descriptorChecksums.map((entry) => entry.id),
    "Release receipt descriptor resolved checksum ids",
  );
  for (const resolved of resolvedChecksums) {
    validateReleaseResolvedChecksum(resolved, descriptorChecksums, packages);
  }
}

export { validateReleaseResolvedChecksums };

function validateReleaseResolvedChecksum(
  resolved: ReleaseReceiptResolvedChecksumEvidence,
  descriptorChecksums: readonly ManagedToolDescriptorChecksumReference[],
  packages: readonly ReleaseReceiptPackageEvidence[],
): void {
  validateReleaseReceiptPackageName(resolved.packageName, "Release receipt descriptor resolved checksum packageName");
  validateRepoRelativePath(resolved.path);
  validateExactValue(
    resolved.algorithm,
    "sha256",
    "Release receipt descriptor checksum algorithm must be sha256",
  );
  validateExactValue(
    resolved.packageFile,
    true,
    `Release receipt resolved checksum ${resolved.id} must resolve to a package file`,
  );
  validateSha256(resolved.value, "Release receipt descriptor checksum value");
  const descriptorChecksum = descriptorChecksums.find((entry) => entry.id === resolved.id);
  if (!descriptorChecksum) {
    throw new Error(`Release receipt resolved checksum is not declared by descriptor: ${resolved.id}`);
  }
  validateReleaseResolvedChecksumMirror(resolved, descriptorChecksum);
  if (!packageEvidenceIncludesFile(packages, resolved.packageName, resolved.path)) {
    throw new Error(`Release receipt resolved checksum ${resolved.id} is not present in packed package files`);
  }
}

function validateReleaseResolvedChecksumMirror(
  resolved: ReleaseReceiptResolvedChecksumEvidence,
  descriptorChecksum: ManagedToolDescriptorChecksumReference,
): void {
  if (
    descriptorChecksum.packageName !== resolved.packageName ||
    descriptorChecksum.path !== resolved.path ||
    descriptorChecksum.algorithm !== resolved.algorithm ||
    descriptorChecksum.artifactRef !== resolved.artifactRef ||
    descriptorChecksum.required !== resolved.required
  ) {
    throw new Error(`Release receipt resolved checksum must mirror descriptor: ${resolved.id}`);
  }
  if (descriptorChecksum.value !== undefined && descriptorChecksum.value !== resolved.value) {
    throw new Error(`Release receipt resolved checksum value must match descriptor: ${resolved.id}`);
  }
}

function validateReleaseReceiptNativeArtifacts(
  nativeArtifacts: readonly ReleaseReceiptNativeArtifactEvidence[],
  packages: readonly ReleaseReceiptPackageEvidence[],
  descriptorEvidence: ReleaseReceiptDescriptorEvidence,
): void {
  validateNonEmptyArray(nativeArtifacts, "Release receipt native artifacts");
  validateExactStringSet(
    nativeArtifacts.map((artifact) => artifact.targetPlatform),
    graphCoreNativeSupportedTargets,
    "Release receipt native artifact targets",
  );
  for (const nativeArtifact of nativeArtifacts) {
    validateReleaseReceiptNativeArtifactBinding(nativeArtifact, packages, descriptorEvidence);
  }
}

export { validateReleaseReceiptNativeArtifacts };

function validateReleaseReceiptNativeArtifactBinding(
  nativeArtifact: ReleaseReceiptNativeArtifactEvidence,
  packages: readonly ReleaseReceiptPackageEvidence[],
  descriptorEvidence: ReleaseReceiptDescriptorEvidence,
): void {
  validateReleaseReceiptNativeArtifact(nativeArtifact);
  validateReleaseReceiptNativeArtifactFiles(nativeArtifact, packages);
  const binaryArtifact = descriptorEvidence.resolvedArtifacts.find(
    (artifact) => artifact.id === nativeArtifact.descriptorArtifactId,
  );
  if (
    !binaryArtifact ||
    binaryArtifact.packageName !== nativeArtifact.packageName ||
    binaryArtifact.path !== nativeArtifact.binaryPath
  ) {
    throw new Error("Release receipt native artifact binary must resolve from descriptor artifacts");
  }
  const checksum = descriptorEvidence.resolvedChecksums.find(
    (entry) => entry.id === nativeArtifact.descriptorChecksumId,
  );
  if (
    !checksum ||
    checksum.packageName !== nativeArtifact.packageName ||
    checksum.path !== nativeArtifact.checksumPath ||
    checksum.value !== nativeArtifact.binarySha256
  ) {
    throw new Error("Release receipt native artifact checksum must resolve from descriptor checksum evidence");
  }
}

function validateReleaseReceiptNativeArtifactFiles(
  nativeArtifact: ReleaseReceiptNativeArtifactEvidence,
  packages: readonly ReleaseReceiptPackageEvidence[],
): void {
  const files = [
    [nativeArtifact.binaryPath, "binary"],
    [nativeArtifact.checksumPath, "checksum"],
    [nativeArtifact.metadataPath, "metadata"],
  ] as const;
  for (const [path, label] of files) {
    if (!packageEvidenceIncludesFile(packages, nativeArtifact.packageName, path)) {
      throw new Error(`Release receipt native artifact ${label} must be present in native package files`);
    }
  }
}

function validateReleaseReceiptNativeArtifact(nativeArtifact: ReleaseReceiptNativeArtifactEvidence): void {
  validateRequiredObject(nativeArtifact, "Release receipt native artifact evidence is required");
  validateExactValue(
    nativeArtifact.packageName,
    "opcore",
    "Release receipt native artifact packageName must be opcore",
  );
  if (!isGraphCoreNativePackageName(nativeArtifact.bundledPackageName)) {
    throw new Error("Release receipt native artifact bundledPackageName must be an Opcore graph-core native package");
  }
  const expectedTarget = graphCoreNativeTargetForPackageName(nativeArtifact.bundledPackageName);
  validateExactValue(
    nativeArtifact.targetPlatform,
    expectedTarget,
    `Release receipt native artifact targetPlatform must be ${expectedTarget}`,
  );
  validateExactValue(
    nativeArtifact.binaryPath,
    bundledGraphCoreNativePath(nativeArtifact.bundledPackageName, "opcore-graph-core"),
    "Release receipt native artifact binaryPath must point at the bundled native binary",
  );
  validateExactValue(
    nativeArtifact.checksumPath,
    bundledGraphCoreNativePath(nativeArtifact.bundledPackageName, "opcore-graph-core.sha256"),
    "Release receipt native artifact checksumPath must point at the bundled native checksum",
  );
  validateExactValue(
    nativeArtifact.metadataPath,
    bundledGraphCoreNativePath(nativeArtifact.bundledPackageName, "metadata.json"),
    "Release receipt native artifact metadataPath must point at the bundled native metadata",
  );
  validateGraphProviderArtifactMetadata(nativeArtifact.metadata);
  validateRepoRelativePath(nativeArtifact.binaryPath);
  validateRepoRelativePath(nativeArtifact.checksumPath);
  validateRepoRelativePath(nativeArtifact.metadataPath);
  validateSha256(nativeArtifact.binarySha256, "Release receipt native artifact binarySha256");
  validateSha256(nativeArtifact.checksumFileSha256, "Release receipt native artifact checksumFileSha256");
  validateSha256(nativeArtifact.metadataSha256, "Release receipt native artifact metadataSha256");
  validateNonEmptyString(nativeArtifact.descriptorArtifactId, "Release receipt native artifact descriptorArtifactId");
  validateNonEmptyString(nativeArtifact.descriptorChecksumId, "Release receipt native artifact descriptorChecksumId");
  validateReleaseReceiptNativeArtifactMetadata(nativeArtifact);
}

export { validateReleaseReceiptNativeArtifact };

function validateReleaseReceiptNativeArtifactMetadata(nativeArtifact: ReleaseReceiptNativeArtifactEvidence): void {
  validateExactValue(
    nativeArtifact.metadata.targetPlatform,
    nativeArtifact.targetPlatform,
    "Release receipt native artifact targetPlatform must match metadata",
  );
  validateExactValue(
    nativeArtifact.metadata.binaryPath,
    "opcore-graph-core",
    "Release receipt native artifact binaryPath must match metadata",
  );
  validateExactValue(
    nativeArtifact.metadata.checksumPath,
    "opcore-graph-core.sha256",
    "Release receipt native artifact checksumPath must match metadata",
  );
  validateExactValue(
    nativeArtifact.metadata.checksumSha256,
    nativeArtifact.binarySha256,
    "Release receipt native artifact binary sha256 must match metadata checksum",
  );
}

function validateReleaseReceiptLicense(license: ReleaseReceiptLicenseEvidence): void {
  if (!license || typeof license !== "object") throw new Error("Release receipt license evidence is required");
  validateRepoRelativePath(license.reportPath);
  validateSha256(license.reportSha256, "Release receipt license reportSha256");
  validateNonNegativeInteger(license.productionDependencyCount, "Release receipt license productionDependencyCount");
  validateNonNegativeInteger(license.bundledDependencyCount, "Release receipt license bundledDependencyCount");
  validateNonNegativeInteger(license.workspacePackageCount, "Release receipt license workspacePackageCount");
  if (license.workspacePackageCount < releaseReceiptPackageNames.length) {
    throw new Error(
      `Release receipt license workspacePackageCount must be at least ${releaseReceiptPackageNames.length}`,
    );
  }
  if (license.unresolvedLicenseCount !== 0) throw new Error("Release receipt license unresolvedLicenseCount must be 0");
  if (!Array.isArray(license.packages)) throw new Error("Release receipt license packages must be an array");
  for (const packageEvidence of license.packages) {
    validateNonEmptyString(packageEvidence.name, "Release receipt license package name");
    validateNonEmptyString(packageEvidence.version, "Release receipt license package version");
    validateNonEmptyString(packageEvidence.license, "Release receipt license package license");
    validateNonEmptyString(packageEvidence.source, "Release receipt license package source");
    if (typeof packageEvidence.bundled !== "boolean")
      throw new Error("Release receipt license package bundled must be boolean");
  }
}

export { validateReleaseReceiptLicense };

function validateReleaseReceiptProvenance(provenance: ReleaseReceiptProvenanceEvidence): void {
  if (!provenance || typeof provenance !== "object") throw new Error("Release receipt provenance evidence is required");
  validateRepoRelativePath(provenance.reportPath);
  validateSha256(provenance.reportSha256, "Release receipt provenance reportSha256");
  validateNonNegativeInteger(provenance.scannedFileCount, "Release receipt provenance scannedFileCount");
  validateNonNegativeInteger(provenance.historyCommitCount, "Release receipt provenance historyCommitCount");
  if (provenance.findingCount !== 0 || provenance.findings.length !== 0) {
    throw new Error("Release receipt provenance findings must be empty");
  }
}

export { validateReleaseReceiptProvenance };

function validateReleaseReceiptSecretHistory(secretHistory: ReleaseReceiptSecretHistoryEvidence): void {
  if (!secretHistory || typeof secretHistory !== "object")
    throw new Error("Release receipt secret history evidence is required");
  validateRepoRelativePath(secretHistory.allowlistPath);
  validateSha256(secretHistory.allowlistSha256, "Release receipt secret history allowlistSha256");
  validateNonNegativeInteger(
    secretHistory.currentTreeScannedFileCount,
    "Release receipt secret history currentTreeScannedFileCount",
  );
  validateNonNegativeInteger(
    secretHistory.gitHistoryScannedCommitCount,
    "Release receipt secret history gitHistoryScannedCommitCount",
  );
  if (secretHistory.findingCount !== 0 || secretHistory.findings.length !== 0) {
    throw new Error("Release receipt secret findings must be empty");
  }
}

export { validateReleaseReceiptSecretHistory };
