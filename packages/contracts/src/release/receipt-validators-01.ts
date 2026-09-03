import { includesString } from "../shared/primitives.js";
import type { ManagedToolDescriptorArtifactReference} from "../managed/contracts.js";
import { managedToolDescriptorArtifactTypes } from "../managed/contracts.js";
import {
  isGraphCoreNativePackageName,
  validateManagedToolDescriptorPackageReference,
  validateReleaseReceiptCommandGroupName,
  validateReleaseReceiptPackageName,
  validateStringRecord,
} from "../managed/helper-validators.js";
import { validateManagedToolDescriptor } from "../managed/validators-01.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  packageEvidenceIncludesFile,
  validateExactStringSequence,
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
import { graphCoreNativeSupportedTargets } from "./graph-vocabulary-02.js";
import type {
  ReleaseReceiptDescriptorEvidence,
  ReleaseReceiptPackageEvidence,
  ReleaseReceiptPackageManifestMetadata,
  ReleaseReceiptResolvedArtifactEvidence,
  ReleaseReceiptTarballEvidence,
} from "./receipt-contracts-01.js";
import { validateReleaseReceiptNativeArtifact, validateReleaseResolvedChecksums } from "./receipt-validators-02.js";
import { validateReleaseReceiptBins } from "./receipt-validators-03.js";
import type { ReleaseReceiptPackageName} from "./vocabulary-01.js";
import { releaseReceiptCommandGroups } from "./vocabulary-01.js";

function validateReleaseReceiptPackage(packageEvidence: ReleaseReceiptPackageEvidence): void {
  validateRequiredObject(packageEvidence, "Release receipt package evidence entry is required");
  validateReleaseReceiptPackageName(packageEvidence.packageName, "Release receipt package evidence packageName");
  validateRepoRelativePath(packageEvidence.packageRoot);
  validateNonEmptyString(packageEvidence.version, "Release receipt package evidence version");
  validateReleaseReceiptPackageManifest(packageEvidence.manifest, packageEvidence.packageName);
  validateReleaseReceiptTarball(packageEvidence.tarball);
  validateStringArray(packageEvidence.files, "Release receipt package evidence files", { allowEmpty: false });
  validateStringArray(packageEvidence.expectedFiles, "Release receipt package evidence expectedFiles", {
    allowEmpty: false,
  });
  validateReleaseReceiptPackageCounts(packageEvidence);
  validateExactStringSet(
    packageEvidence.files,
    packageEvidence.expectedFiles,
    `${packageEvidence.packageName} packed files`,
  );
  validateReleaseReceiptBins(packageEvidence.bins, packageEvidence.packageName);
  validateReleaseReceiptDescriptorReferences(packageEvidence);
  validateReleaseReceiptPackageNativeArtifacts(packageEvidence);
  for (const nativeArtifact of packageEvidence.nativeArtifacts) validateReleaseReceiptNativeArtifact(nativeArtifact);
}

export { validateReleaseReceiptPackage };

function validateReleaseReceiptPackageCounts(packageEvidence: ReleaseReceiptPackageEvidence): void {
  if (!Number.isInteger(packageEvidence.fileCount) || packageEvidence.fileCount !== packageEvidence.files.length) {
    throw new Error("Release receipt package evidence fileCount must equal files length");
  }
  if (
    !Number.isInteger(packageEvidence.expectedFileCount) ||
    packageEvidence.expectedFileCount !== packageEvidence.expectedFiles.length
  ) {
    throw new Error("Release receipt package evidence expectedFileCount must equal expectedFiles length");
  }
}

function validateReleaseReceiptDescriptorReferences(packageEvidence: ReleaseReceiptPackageEvidence): void {
  for (const descriptorReference of packageEvidence.descriptorReferences) {
    validateManagedToolDescriptorPackageReference(descriptorReference, packageEvidence.packageName);
    if (!packageEvidence.files.includes(descriptorReference.path)) {
      throw new Error(
        `Release receipt descriptor reference ${descriptorReference.id} is not in ` +
          `${packageEvidence.packageName} packed files`,
      );
    }
  }
}

function validateReleaseReceiptPackageNativeArtifacts(packageEvidence: ReleaseReceiptPackageEvidence): void {
  if (packageEvidence.packageName === "opcore") {
    validateNonEmptyArray(packageEvidence.nativeArtifacts, "Release receipt native package artifacts");
    validateExactStringSet(
      packageEvidence.nativeArtifacts.map((entry) => entry.targetPlatform),
      graphCoreNativeSupportedTargets,
      "Release receipt Opcore bundled native artifact targets",
    );
  } else if (isGraphCoreNativePackageName(packageEvidence.packageName)) {
    throw new Error("Release receipt must not publish native graph-core packages separately");
  } else if (packageEvidence.nativeArtifacts.length > 0) {
    throw new Error(`${packageEvidence.packageName} must not report native graph artifacts`);
  }
}

function validateReleaseReceiptPackageManifest(
  manifest: ReleaseReceiptPackageManifestMetadata,
  packageName: ReleaseReceiptPackageName,
): void {
  if (!manifest || typeof manifest !== "object") throw new Error("Release receipt package manifest is required");
  if (manifest.name !== packageName) throw new Error(`Release receipt package manifest name must match ${packageName}`);
  validateNonEmptyString(manifest.version, "Release receipt package manifest version");
  validateNonEmptyString(manifest.license, "Release receipt package manifest license");
  if (isGraphCoreNativePackageName(packageName)) {
    if (manifest.main !== undefined || manifest.types !== undefined) {
      throw new Error("Release receipt native package manifest must not declare main or types");
    }
  } else {
    if (manifest.main === undefined || manifest.types === undefined) {
      throw new Error("Release receipt package manifest must declare main and types");
    }
    validateRepoRelativePath(manifest.main);
    validateRepoRelativePath(manifest.types);
  }
  validateStringArray(manifest.files, "Release receipt package manifest files", { allowEmpty: false });
  validateReleaseReceiptBins(manifest.bins, packageName);
  validateStringRecord(manifest.dependencies, "Release receipt package manifest dependencies");
  if (manifest.optionalDependencies !== undefined) {
    validateStringRecord(manifest.optionalDependencies, "Release receipt package manifest optionalDependencies");
  }
  validateStringArray(manifest.bundledDependencies, "Release receipt package manifest bundledDependencies", {
    allowEmpty: true,
  });
}

export { validateReleaseReceiptPackageManifest };

function validateReleaseReceiptTarball(tarball: ReleaseReceiptTarballEvidence): void {
  if (!tarball || typeof tarball !== "object") throw new Error("Release receipt tarball evidence is required");
  validateNonEmptyString(tarball.filename, "Release receipt tarball filename");
  validateRepoRelativePath(tarball.path);
  validateSha256(tarball.sha256, "Release receipt tarball sha256");
  if (tarball.integrity !== undefined) validateNonEmptyString(tarball.integrity, "Release receipt tarball integrity");
  if (tarball.shasum !== undefined) validateNonEmptyString(tarball.shasum, "Release receipt tarball shasum");
}

export { validateReleaseReceiptTarball };

function validateReleaseReceiptDescriptor(
  descriptorEvidence: ReleaseReceiptDescriptorEvidence,
  packages: readonly ReleaseReceiptPackageEvidence[],
): void {
  if (!descriptorEvidence || typeof descriptorEvidence !== "object")
    throw new Error("Release receipt descriptor evidence is required");
  validateRepoRelativePath(descriptorEvidence.path);
  if (descriptorEvidence.packageName !== "opcore") {
    throw new Error("Release receipt descriptor packageName must be opcore");
  }
  validateSha256(descriptorEvidence.checksumSha256, "Release receipt descriptor checksumSha256");
  const descriptor = validateManagedToolDescriptor(descriptorEvidence.descriptor);
  validateExactStringSet(
    descriptorEvidence.commandGroups.map((entry) => entry.name),
    releaseReceiptCommandGroups,
    "Release receipt descriptor command groups",
  );
  for (const group of descriptorEvidence.commandGroups) {
    validateReleaseReceiptCommandGroupName(group.name, "Release receipt descriptor command group name");
    validateExactStringSequence(
      group.canonicalCommand,
      ["opcore", group.name],
      `Release receipt descriptor ${group.name} canonicalCommand`,
    );
    const descriptorGroup = descriptor.commandGroups.find((entry) => entry.name === group.name);
    if (!descriptorGroup)
      throw new Error(`Release receipt descriptor command group missing from descriptor: ${group.name}`);
    if (group.packageName !== descriptorGroup.packageName) {
      throw new Error(`Release receipt descriptor command group ${group.name} packageName must match descriptor`);
    }
  }
  validateReleaseResolvedArtifacts(descriptorEvidence.resolvedArtifacts, descriptor.artifacts, packages);
  validateReleaseResolvedChecksums(descriptorEvidence.resolvedChecksums, descriptor.checksums, packages);
}

export { validateReleaseReceiptDescriptor };

function validateReleaseResolvedArtifacts(
  resolvedArtifacts: readonly ReleaseReceiptResolvedArtifactEvidence[],
  descriptorArtifacts: readonly ManagedToolDescriptorArtifactReference[],
  packages: readonly ReleaseReceiptPackageEvidence[],
): void {
  validateNonEmptyArray(resolvedArtifacts, "Release receipt descriptor resolvedArtifacts");
  validateExactStringSet(
    resolvedArtifacts.map((entry) => entry.id),
    descriptorArtifacts.map((entry) => entry.id),
    "Release receipt descriptor resolved artifact ids",
  );
  for (const resolved of resolvedArtifacts) {
    validateReleaseResolvedArtifact(resolved, descriptorArtifacts, packages);
  }
}

export { validateReleaseResolvedArtifacts };

function validateReleaseResolvedArtifact(
  resolved: ReleaseReceiptResolvedArtifactEvidence,
  descriptorArtifacts: readonly ManagedToolDescriptorArtifactReference[],
  packages: readonly ReleaseReceiptPackageEvidence[],
): void {
  validateReleaseReceiptPackageName(resolved.packageName, "Release receipt descriptor resolved artifact packageName");
  validateRepoRelativePath(resolved.path);
  if (!includesString(managedToolDescriptorArtifactTypes, resolved.type)) {
    throw new Error(`Unknown release receipt descriptor resolved artifact type: ${String(resolved.type)}`);
  }
  validateExactValue(
    resolved.packageFile,
    true,
    `Release receipt resolved artifact ${resolved.id} must resolve to a package file`,
  );
  const descriptorArtifact = descriptorArtifacts.find((entry) => entry.id === resolved.id);
  if (!descriptorArtifact) {
    throw new Error(`Release receipt resolved artifact is not declared by descriptor: ${resolved.id}`);
  }
  validateReleaseResolvedArtifactMirror(resolved, descriptorArtifact);
  if (!packageEvidenceIncludesFile(packages, resolved.packageName, resolved.path)) {
    throw new Error(`Release receipt resolved artifact ${resolved.id} is not present in packed package files`);
  }
}

function validateReleaseResolvedArtifactMirror(
  resolved: ReleaseReceiptResolvedArtifactEvidence,
  descriptorArtifact: ManagedToolDescriptorArtifactReference,
): void {
  if (
    descriptorArtifact.packageName !== resolved.packageName ||
    descriptorArtifact.path !== resolved.path ||
    descriptorArtifact.type !== resolved.type ||
    descriptorArtifact.required !== resolved.required ||
    descriptorArtifact.checksumRef !== resolved.checksumRef
  ) {
    throw new Error(`Release receipt resolved artifact must mirror descriptor: ${resolved.id}`);
  }
}
