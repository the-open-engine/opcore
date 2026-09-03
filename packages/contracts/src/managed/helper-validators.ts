import { includesString } from "../shared/primitives.js";
import type {
  GraphCoreNativePackageName,
  GraphCoreNativeSupportedTarget} from "../release/graph-vocabulary-02.js";
import {
  graphCoreNativePackageNames,
  graphCoreNativePackageNamesByTarget,
  graphCoreNativeSupportedTargets,
} from "../release/graph-vocabulary-02.js";
import type {
  ReleaseReceiptCommandGroupName,
  ReleaseReceiptPackageName,
  ReleaseReceiptReportId} from "../release/vocabulary-01.js";
import {
  releaseReceiptCommandGroups,
  releaseReceiptPackageNames,
  releaseReceiptReportIds,
} from "../release/vocabulary-01.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString } from "../shared/validators-01.js";
import type { ManagedToolDescriptorArtifactReference} from "./contracts.js";
import { managedToolDescriptorArtifactTypes } from "./contracts.js";

function validateManagedToolDescriptorPackageReference(
  reference: ManagedToolDescriptorArtifactReference,
  packageName: ReleaseReceiptPackageName,
): void {
  if (!reference || typeof reference !== "object") throw new Error("Release receipt descriptor reference is required");
  validateNonEmptyString(reference.id, "Release receipt descriptor reference id");
  if (reference.packageName !== packageName) {
    throw new Error(`Release receipt descriptor reference packageName must be ${packageName}`);
  }
  validateRepoRelativePath(reference.path);
  if (!includesString(managedToolDescriptorArtifactTypes, reference.type)) {
    throw new Error(`Unknown release receipt descriptor reference type: ${String(reference.type)}`);
  }
  if (typeof reference.required !== "boolean")
    throw new Error("Release receipt descriptor reference required must be boolean");
  if (reference.checksumRef !== undefined)
    validateNonEmptyString(reference.checksumRef, "Release receipt descriptor reference checksumRef");
}

export { validateManagedToolDescriptorPackageReference };

function validateReleaseReceiptPackageName(value: unknown, label: string): ReleaseReceiptPackageName {
  if (!includesString(releaseReceiptPackageNames, value)) {
    throw new Error(`${label} must be one of ${releaseReceiptPackageNames.join(", ")}`);
  }
  return value;
}

export { validateReleaseReceiptPackageName };

function isGraphCoreNativePackageName(value: unknown): value is GraphCoreNativePackageName {
  return includesString(graphCoreNativePackageNames, value);
}

export { isGraphCoreNativePackageName };

function bundledGraphCoreNativePath(
  packageName: GraphCoreNativePackageName,
  file: "metadata.json" | "opcore-graph-core" | "opcore-graph-core.sha256",
): string {
  return `node_modules/${packageName}/${file}`;
}

export { bundledGraphCoreNativePath };

function graphCoreNativeTargetForPackageName(packageName: GraphCoreNativePackageName): GraphCoreNativeSupportedTarget {
  const target = graphCoreNativeSupportedTargets.find(
    (entry) => graphCoreNativePackageNamesByTarget[entry] === packageName,
  );
  if (!target) throw new Error(`Unknown Opcore graph-core native package: ${packageName}`);
  return target;
}

export { graphCoreNativeTargetForPackageName };

function validateReleaseReceiptCommandGroupName(value: unknown, label: string): ReleaseReceiptCommandGroupName {
  if (!includesString(releaseReceiptCommandGroups, value)) {
    throw new Error(`${label} must be one of ${releaseReceiptCommandGroups.join(", ")}`);
  }
  return value;
}

export { validateReleaseReceiptCommandGroupName };

function validateReleaseReceiptReportId(value: unknown, label: string): ReleaseReceiptReportId {
  if (!includesString(releaseReceiptReportIds, value)) {
    throw new Error(`${label} must be one of ${releaseReceiptReportIds.join(", ")}`);
  }
  return value;
}

export { validateReleaseReceiptReportId };

function validateStringRecord(value: Readonly<Record<string, string>>, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const [key, recordValue] of Object.entries(value)) {
    validateNonEmptyString(key, `${label} key`);
    validateNonEmptyString(recordValue, `${label}.${key}`);
  }
}

export { validateStringRecord };
