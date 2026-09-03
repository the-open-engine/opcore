import {
  validateExactValue,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { validateCommandOwner, validateCommandRouteStatus } from "../command/helper-validators.js";
import { includesString } from "../shared/primitives.js";
import { managedToolDescriptorArtifactTypes } from "../managed/contracts.js";
import { bundledGraphCoreNativePath, validateReleaseReceiptPackageName } from "../managed/helper-validators.js";
import { validateManagedToolDescriptor } from "../managed/validators-01.js";
import {
  validateExactStringSequence,
  validateExactStringSet,
  validateExitCodeForStatus,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateSha256,
  validateStringArray,
} from "../shared/validators-01.js";
import type {
  ReleaseCutoverCommandReceipt,
  ReleaseCutoverDescriptorEvidence,
  ReleaseCutoverEnvironmentIsolationEvidence,
  ReleaseCutoverInstalledPackageEvidence,
} from "./cutover-contracts.js";
import { validateReleaseCutoverExpectedCommand } from "./cutover-validators-02.js";
import { graphCoreNativePackageNameForTarget, graphCoreNativeSupportedTargets } from "./graph-vocabulary-02.js";
import { validateReleaseReceiptBins } from "./receipt-validators-03.js";
import { releaseCutoverRequiredCommandIds, releaseReceiptPackageNames } from "./vocabulary-01.js";
import { releaseCutoverCommandExpectations } from "./vocabulary-03.js";

function validateReleaseCutoverInstalledPackages(packages: readonly ReleaseCutoverInstalledPackageEvidence[]): void {
  validateNonEmptyArray(packages, "Release cutover installed package evidence");
  validateReleaseCutoverInstalledPackageSet(packages.map((entry) => entry.packageName));
  for (const entry of packages) {
    if (!entry || typeof entry !== "object")
      throw new Error("Release cutover installed package evidence entry is required");
    validateReleaseReceiptPackageName(entry.packageName, "Release cutover installed package packageName");
    validateNonEmptyString(entry.version, "Release cutover installed package version");
    if (!entry.tarball || typeof entry.tarball !== "object")
      throw new Error("Release cutover tarball evidence is required");
    validateNonEmptyString(entry.tarball.filename, "Release cutover tarball filename");
    validateSha256(entry.tarball.sha256, "Release cutover tarball sha256");
    validateRequiredObject(entry.installedManifest, "Release cutover installed manifest evidence is required");
    validateNonEmptyString(entry.installedManifest.path, "Release cutover installed manifest path");
    if (
      !entry.installedManifest.path.includes("node_modules/") ||
      !entry.installedManifest.path.endsWith("package.json")
    ) {
      throw new Error("Release cutover installed manifest path must be inside node_modules and end with package.json");
    }
    validateSha256(entry.installedManifest.sha256, "Release cutover installed manifest sha256");
    validateReleaseReceiptBins(entry.installedManifest.bins, entry.packageName);
    validateReleaseCutoverInstalledFiles(entry);
  }
}

export { validateReleaseCutoverInstalledPackages };

function validateReleaseCutoverInstalledFiles(entry: ReleaseCutoverInstalledPackageEvidence): void {
  validateNonEmptyArray(entry.installedFiles, "Release cutover installed files");
  const prefix = `node_modules/${entry.packageName}/`;
  const paths = [];
  for (const file of entry.installedFiles) {
    if (!file || typeof file !== "object") throw new Error("Release cutover installed file evidence entry is required");
    validateNonEmptyString(file.path, "Release cutover installed file path");
    if (!file.path.startsWith(prefix)) {
      throw new Error(`Release cutover installed file path must be inside ${prefix}`);
    }
    validateSha256(file.sha256, "Release cutover installed file sha256");
    paths.push(file.path);
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("Release cutover installed file paths must be unique");
  }
  if (!paths.includes(entry.installedManifest.path)) {
    throw new Error("Release cutover installed files must include package.json");
  }
  const binPaths = Object.values(entry.installedManifest.bins).map((path) => `${prefix}${path}`);
  for (const binPath of binPaths) {
    if (!paths.includes(binPath)) throw new Error(`Release cutover installed files must include bin target ${binPath}`);
  }
  if (entry.packageName === "opcore") validateReleaseCutoverOpcoreFiles(paths);
}

export { validateReleaseCutoverInstalledFiles };

function validateReleaseCutoverOpcoreFiles(paths: readonly string[]): void {
  const aspManifest =
    "node_modules/opcore/node_modules/@the-open-engine/opcore-asp-provider/dist/manifests/asp-server.json";
  if (!paths.includes(aspManifest)) {
    throw new Error("Release cutover Opcore installed files must include bundled canonical asp-server.json");
  }
  for (const target of graphCoreNativeSupportedTargets) {
    const bundledPackageName = graphCoreNativePackageNameForTarget(target);
    const binary = `node_modules/opcore/${bundledGraphCoreNativePath(bundledPackageName, "opcore-graph-core")}`;
    if (!paths.includes(binary)) {
      throw new Error(`Release cutover Opcore installed files must include bundled native binary for ${target}`);
    }
  }
}

function validateReleaseCutoverInstalledPackageSet(packageNames: readonly string[]): void {
  validateExactStringSet(packageNames, releaseReceiptPackageNames, "Release cutover installed package evidence");
  for (const packageName of packageNames) {
    validateReleaseReceiptPackageName(packageName, "Release cutover installed package packageName");
  }
}

export { validateReleaseCutoverInstalledPackageSet };

function validateReleaseCutoverDescriptor(descriptorEvidence: ReleaseCutoverDescriptorEvidence): void {
  if (!descriptorEvidence || typeof descriptorEvidence !== "object")
    throw new Error("Release cutover descriptor evidence is required");
  validateNonEmptyString(descriptorEvidence.path, "Release cutover descriptor path");
  if (descriptorEvidence.packageName !== "opcore") {
    throw new Error("Release cutover descriptor packageName must be opcore");
  }
  validateSha256(descriptorEvidence.checksumSha256, "Release cutover descriptor checksumSha256");
  const descriptor = validateManagedToolDescriptor(descriptorEvidence.descriptor);
  validateNonEmptyArray(descriptorEvidence.resolvedArtifacts, "Release cutover descriptor resolvedArtifacts");
  validateExactStringSet(
    descriptorEvidence.resolvedArtifacts.map((entry) => entry.id),
    descriptor.artifacts.map((entry) => entry.id),
    "Release cutover descriptor resolved artifact ids",
  );
  for (const artifact of descriptorEvidence.resolvedArtifacts) {
    validateReleaseReceiptPackageName(artifact.packageName, "Release cutover descriptor resolved artifact packageName");
    validateNonEmptyString(artifact.path, "Release cutover descriptor resolved artifact path");
    validateNonEmptyString(artifact.id, "Release cutover descriptor resolved artifact id");
    if (!includesString(managedToolDescriptorArtifactTypes, artifact.type)) {
      throw new Error(`Unknown release cutover descriptor resolved artifact type: ${String(artifact.type)}`);
    }
    if (artifact.packageFile !== true)
      throw new Error("Release cutover descriptor resolved artifacts must be package files");
  }
  validateNonEmptyArray(descriptorEvidence.resolvedChecksums, "Release cutover descriptor resolvedChecksums");
  validateExactStringSet(
    descriptorEvidence.resolvedChecksums.map((entry) => entry.id),
    descriptor.checksums.map((entry) => entry.id),
    "Release cutover descriptor resolved checksum ids",
  );
  for (const checksum of descriptorEvidence.resolvedChecksums) {
    validateReleaseReceiptPackageName(checksum.packageName, "Release cutover descriptor resolved checksum packageName");
    validateNonEmptyString(checksum.path, "Release cutover descriptor resolved checksum path");
    validateNonEmptyString(checksum.id, "Release cutover descriptor resolved checksum id");
    if (checksum.algorithm !== "sha256")
      throw new Error("Release cutover descriptor checksum algorithm must be sha256");
    validateSha256(checksum.value, "Release cutover descriptor resolved checksum value");
    if (checksum.packageFile !== true)
      throw new Error("Release cutover descriptor resolved checksums must be package files");
  }
}

export { validateReleaseCutoverDescriptor };

function validateReleaseCutoverEnvironmentIsolation(environment: ReleaseCutoverEnvironmentIsolationEvidence): void {
  if (!environment || typeof environment !== "object")
    throw new Error("Release cutover environmentIsolation is required");
  if (environment.pathSanitized !== true) throw new Error("Release cutover PATH must be sanitized");
  if (environment.siblingRepositoriesExcluded !== true) {
    throw new Error("Release cutover sibling repository paths must be excluded");
  }
  if (environment.opcoreBinsVerified !== true) {
    throw new Error("Release cutover installed project bins must be verified");
  }
}

export { validateReleaseCutoverEnvironmentIsolation };

function validateReleaseCutoverCommandReceipts(receipts: readonly ReleaseCutoverCommandReceipt[]): void {
  validateNonEmptyArray(receipts, "Release cutover command receipts");
  validateExactStringSet(
    receipts.map((entry) => entry.id),
    releaseCutoverRequiredCommandIds,
    "Release cutover command receipts",
  );
  for (const receipt of receipts) validateReleaseCutoverCommandReceipt(receipt);
}

export { validateReleaseCutoverCommandReceipts };

function validateReleaseCutoverCommandReceipt(receipt: ReleaseCutoverCommandReceipt): void {
  validateRequiredObject(receipt, "Release cutover command receipt is required");
  if (!includesString(releaseCutoverRequiredCommandIds, receipt.id)) {
    throw new Error(`Unknown release cutover command receipt id: ${String(receipt.id)}`);
  }
  validateStringArray(receipt.command, "Release cutover command receipt command", { allowEmpty: false });
  validateStringArray(receipt.canonicalCommand, "Release cutover command receipt canonicalCommand", {
    allowEmpty: false,
  });
  validateExactStringSequence(receipt.command, receipt.canonicalCommand, `Release cutover ${receipt.id} command`);
  const expected = releaseCutoverCommandExpectations[receipt.id];
  validateExactValue(
    receipt.command[0],
    expected.bin,
    `Release cutover command ${receipt.id} command must use canonical ${expected.bin} bin`,
  );
  validateExactValue(
    receipt.canonicalCommand[0],
    expected.bin,
    `Release cutover command ${receipt.id} canonicalCommand must use canonical ${expected.bin} bin`,
  );
  validateCommandOwner(receipt.owner);
  validateReleaseCutoverExpectedCommand(receipt.canonicalCommand, expected, receipt.id);
  validateExactValue(
    receipt.owner,
    expected.owner,
    `Release cutover command ${receipt.id} owner must match expected ${expected.owner}`,
  );
  const status = validateCommandRouteStatus(receipt.status);
  if (receipt.status === "not_implemented") {
    throw new Error("Release cutover command receipts must not be not_implemented");
  }
  validateExactValue(
    status,
    expected.status,
    `Release cutover command ${receipt.id} status must match expected ${expected.status}`,
  );
  validateExitCodeForStatus(receipt.exitCode, status);
  validateExactValue(
    receipt.exitCode,
    expected.exitCode,
    `Release cutover command ${receipt.id} exitCode must match expected ${expected.exitCode}`,
  );
  validateNonEmptyString(receipt.binPath, "Release cutover command receipt binPath");
  if (!receipt.binPath.endsWith(`node_modules/.bin/${expected.bin}`)) {
    throw new Error(`Release cutover command receipt binPath must use installed node_modules/.bin/${expected.bin}`);
  }
  validateSha256(receipt.stdoutSha256, "Release cutover command receipt stdoutSha256");
  validateSha256(receipt.stderrSha256, "Release cutover command receipt stderrSha256");
  validateNonEmptyString(receipt.assertion, "Release cutover command receipt assertion");
}
