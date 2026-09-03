import { includesString } from "../shared/primitives.js";
import {
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets,
} from "../release/graph-vocabulary-02.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyArray, validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import {
  collectStrings,
  validateBoolean,
  validateExactValue,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import type {
  ManagedToolDescriptorArtifactReference,
  ManagedToolDescriptorChecksumReference,
  ManagedToolDescriptorProvenanceHook} from "./contracts.js";
import {
  managedToolDescriptorArtifactTypes,
} from "./contracts.js";
import { bundledGraphCoreNativePath } from "./helper-validators.js";
import type { ManagedToolDescriptorArtifactValidationState } from "./validators-02.js";

function validateManagedToolArtifacts(
  artifacts: readonly ManagedToolDescriptorArtifactReference[],
): ManagedToolDescriptorArtifactValidationState {
  validateNonEmptyArray(artifacts, "Managed tool descriptor artifacts");
  const artifactIds = new Set<string>();
  const artifactChecksumRefs: { artifactId: string; checksumRef: string }[] = [];
  for (const artifact of artifacts) {
    validateManagedToolArtifact(artifact, artifactIds, artifactChecksumRefs);
  }

  for (const target of graphCoreNativeSupportedTargets) validateGraphNativeArtifacts(artifacts, target);
  if (!artifacts.some(isPackagedManagedToolDescriptor)) {
    throw new Error("Managed tool descriptor must include packaged descriptor artifact");
  }
  return { artifactIds, artifactChecksumRefs };
}

export { validateManagedToolArtifacts };

function validateManagedToolArtifact(
  artifact: ManagedToolDescriptorArtifactReference,
  artifactIds: Set<string>,
  artifactChecksumRefs: { artifactId: string; checksumRef: string }[],
): void {
  validateRequiredObject(artifact, "Managed tool descriptor artifact is required");
  validateNonEmptyString(artifact.id, "Managed tool descriptor artifact id");
  if (artifactIds.has(artifact.id)) {
    throw new Error(`Managed tool descriptor artifact id must be unique: ${artifact.id}`);
  }
  artifactIds.add(artifact.id);
  validateNonEmptyString(artifact.packageName, "Managed tool descriptor artifact packageName");
  validateManagedToolPackagePath(artifact.path, "Managed tool descriptor artifact path");
  if (!includesString(managedToolDescriptorArtifactTypes, artifact.type)) {
    throw new Error(`Unknown managed tool descriptor artifact type: ${String(artifact.type)}`);
  }
  validateBoolean(artifact.required, "Managed tool descriptor artifact required");
  validateOptional(artifact.checksumRef, (checksumRef) => {
    validateNonEmptyString(checksumRef, "Managed tool descriptor artifact checksumRef");
    artifactChecksumRefs.push({ artifactId: artifact.id, checksumRef });
  });
}

export { validateManagedToolArtifact };

function validateGraphNativeArtifacts(
  artifacts: readonly ManagedToolDescriptorArtifactReference[],
  target: (typeof graphCoreNativeSupportedTargets)[number],
): void {
  const bundledPackage = graphCoreNativePackageNameForTarget(target);
  validateGraphNativeArtifact(
    artifacts.find((artifact) => artifact.id === `graph-core-binary-${target}`),
    {
      type: "native_binary",
      path: bundledGraphCoreNativePath(bundledPackage, "opcore-graph-core"),
      checksumRef: `graph-core-binary-sha256-${target}`,
    },
    `Managed tool descriptor must include graph native binary artifact for ${target}`,
  );
  validateGraphNativeArtifact(
    artifacts.find((artifact) => artifact.id === `graph-core-metadata-${target}`),
    {
      type: "manifest",
      path: bundledGraphCoreNativePath(bundledPackage, "metadata.json"),
    },
    `Managed tool descriptor must include graph native metadata artifact for ${target}`,
  );
  validateGraphNativeArtifact(
    artifacts.find((artifact) => artifact.id === `graph-core-checksum-${target}`),
    {
      type: "checksum",
      path: bundledGraphCoreNativePath(bundledPackage, "opcore-graph-core.sha256"),
    },
    `Managed tool descriptor must include graph native checksum artifact for ${target}`,
  );
}

export { validateGraphNativeArtifacts };

interface ExpectedGraphNativeArtifact {
  type: ManagedToolDescriptorArtifactReference["type"];
  path: string;
  checksumRef?: string;
}

function validateGraphNativeArtifact(
  artifact: ManagedToolDescriptorArtifactReference | undefined,
  expected: ExpectedGraphNativeArtifact,
  message: string,
): void {
  if (!artifact) throw new Error(message);
  validateExactValue(artifact.packageName, "opcore", message);
  validateExactValue(artifact.type, expected.type, message);
  validateExactValue(artifact.required, true, message);
  validateExactValue(artifact.path, expected.path, message);
  validateOptional(expected.checksumRef, (checksumRef) =>
    validateExactValue(artifact.checksumRef, checksumRef, message),
  );
}

export { validateGraphNativeArtifact };

function isPackagedManagedToolDescriptor(artifact: ManagedToolDescriptorArtifactReference): boolean {
  return (
    artifact.id === "descriptor" &&
    artifact.packageName === "opcore" &&
    artifact.path === "dist/descriptors/opcore.managed-tool.json" &&
    artifact.type === "descriptor" &&
    artifact.required
  );
}

export { isPackagedManagedToolDescriptor };

function validateManagedToolChecksums(
  checksums: readonly ManagedToolDescriptorChecksumReference[],
  artifactReferences: ManagedToolDescriptorArtifactValidationState,
): void {
  validateNonEmptyArray(checksums, "Managed tool descriptor checksums");
  const checksumIds = new Set<string>();
  for (const checksum of checksums) {
    validateManagedToolChecksum(checksum, checksumIds, artifactReferences.artifactIds);
  }
  for (const target of graphCoreNativeSupportedTargets) {
    if (
      !checksums.some(
        (checksum) =>
          checksum.id === `graph-core-binary-sha256-${target}` &&
          checksum.artifactRef === `graph-core-binary-${target}`,
      )
    ) {
      throw new Error(`Managed tool descriptor must include graph native checksum reference for ${target}`);
    }
  }
  for (const artifactChecksumRef of artifactReferences.artifactChecksumRefs) {
    if (!checksumIds.has(artifactChecksumRef.checksumRef)) {
      throw new Error(
        `Managed tool descriptor artifact checksumRef must reference a checksum: ${artifactChecksumRef.artifactId} ` +
          `-> ${artifactChecksumRef.checksumRef}`,
      );
    }
  }
}

export { validateManagedToolChecksums };

function validateManagedToolChecksum(
  checksum: ManagedToolDescriptorChecksumReference,
  checksumIds: Set<string>,
  artifactIds: Set<string>,
): void {
  validateRequiredObject(checksum, "Managed tool descriptor checksum is required");
  validateNonEmptyString(checksum.id, "Managed tool descriptor checksum id");
  if (checksumIds.has(checksum.id)) {
    throw new Error(`Managed tool descriptor checksum id must be unique: ${checksum.id}`);
  }
  checksumIds.add(checksum.id);
  validateNonEmptyString(checksum.packageName, "Managed tool descriptor checksum packageName");
  validateManagedToolPackagePath(checksum.path, "Managed tool descriptor checksum path");
  validateExactValue(
    checksum.algorithm,
    "sha256",
    "Managed tool descriptor checksum algorithm must be sha256",
  );
  validateNonEmptyString(checksum.artifactRef, "Managed tool descriptor checksum artifactRef");
  if (!artifactIds.has(checksum.artifactRef)) {
    throw new Error(`Managed tool descriptor checksum artifactRef must reference an artifact: ${checksum.artifactRef}`);
  }
  validateBoolean(checksum.required, "Managed tool descriptor checksum required");
  validateOptional(checksum.value, validateManagedToolChecksumValue);
}

export { validateManagedToolChecksum };

function validateManagedToolChecksumValue(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Managed tool descriptor checksum value must be a sha256 hex digest");
  }
}

export { validateManagedToolChecksumValue };

function validateManagedToolProvenanceHooks(provenanceHooks: readonly ManagedToolDescriptorProvenanceHook[]): void {
  validateNonEmptyArray(provenanceHooks, "Managed tool descriptor provenance hooks");
  for (const hook of provenanceHooks) {
    if (!hook || typeof hook !== "object") throw new Error("Managed tool descriptor provenance hook is required");
    validateNonEmptyString(hook.id, "Managed tool descriptor provenance hook id");
    validateStringArray(hook.command, "Managed tool descriptor provenance hook command", { allowEmpty: false });
    validateManagedToolCommandTokens(hook.command, "Managed tool descriptor provenance hook command");
    if (hook.expectedExitCode !== 0)
      throw new Error("Managed tool descriptor provenance hook expectedExitCode must be 0");
  }
}

export { validateManagedToolProvenanceHooks };

const managedToolPrivateRuntimePathPattern = /(?:^|\/)(?:\.agents|\.claude|\.codex|\.gemini|\.opencode)(?:\/|$)/;

export { managedToolPrivateRuntimePathPattern };

function normalizeManagedToolDescriptorString(value: string): string {
  return value.replaceAll("\\", "/");
}

export { normalizeManagedToolDescriptorString };

function validateManagedToolPackagePath(path: string, label: string): string {
  const normalized = validateRepoRelativePath(path);
  if (normalized === "~" || normalized.startsWith("~/")) {
    throw new Error(`${label} must not reference private home paths`);
  }
  if (managedToolPrivateRuntimePathPattern.test(normalized)) {
    throw new Error(`${label} must not reference private runtime paths`);
  }
  return normalized;
}

export { validateManagedToolPackagePath };

function validateManagedToolCommandTokens(tokens: readonly string[], label: string): void {
  for (const token of tokens) {
    validateNonEmptyString(token, label);
    const normalizedToken = normalizeManagedToolDescriptorString(token);
    if (managedToolPrivateRuntimePathPattern.test(normalizedToken)) {
      throw new Error("Managed tool descriptor must not reference private runtime paths");
    }
  }
}

export { validateManagedToolCommandTokens };

function validateManagedToolDescriptorForbiddenStrings(value: unknown): void {
  for (const text of collectStrings(value)) {
    const normalizedText = normalizeManagedToolDescriptorString(text);
    if (managedToolPrivateRuntimePathPattern.test(normalizedText)) {
      throw new Error("Managed tool descriptor must not reference private runtime paths");
    }
    if (normalizedText.includes("/Users/tom")) {
      throw new Error("Managed tool descriptor must not reference private paths");
    }
  }
}

export { validateManagedToolDescriptorForbiddenStrings };
