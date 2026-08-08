import {
  validateExactValue,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { graphProviderModes } from "../graph/vocabulary-01.js";
import { opcoreInitScopes } from "../product/init-contracts.js";
import {
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets,
} from "../release/graph-vocabulary-02.js";
import {
  validateExactStringSequence,
  validateExactStringSet,
  validateStringArray,
  validateValidationChecks,
} from "../shared/validators-01.js";
import {
  PYTHON_PROJECT_CONTEXT_SCHEMA_ID,
  pythonProjectContextOutcomes,
} from "../validation/python-project-contracts-01.js";
import { validationScopeKinds } from "../validation/request-contracts.js";
import type { ManagedToolDescriptorCapabilities } from "./contracts.js";
import { bundledGraphCoreNativePath } from "./helper-validators.js";
import { validateManagedToolPackagePath } from "./validators-03.js";

function validateManagedToolGraphCapabilities(graph: ManagedToolDescriptorCapabilities["graph"]): void {
  if (!graph || typeof graph !== "object") throw new Error("Managed tool descriptor graph capabilities are required");
  if (graph.provider !== "opcore-graph") throw new Error("Managed tool descriptor graph provider must be opcore-graph");
  if (graph.schemaVersion !== 1) throw new Error("Managed tool descriptor graph schemaVersion must be 1");
  validateExactStringSet(
    graph.commands,
    ["build", "update", "watch", "status", "query", "impact", "review-context", "detect-changes", "search", "serve"],
    "Managed tool descriptor graph commands",
  );
  validateStringArray(graph.queryKinds, "Managed tool descriptor graph queryKinds", { allowEmpty: false });
  validateExactStringSet(
    graph.daemonOperations,
    ["ping", "status", "query", "search", "shutdown"],
    "Managed tool descriptor graph daemonOperations",
  );
  validateManagedToolGraphNativeArtifacts(graph.nativeArtifacts);
}

export { validateManagedToolGraphCapabilities };

function validateManagedToolGraphNativeArtifacts(
  nativeArtifacts: ManagedToolDescriptorCapabilities["graph"]["nativeArtifacts"],
): void {
  if (!Array.isArray(nativeArtifacts)) throw new Error("Managed tool descriptor graph native artifacts are required");
  validateExactStringSet(
    nativeArtifacts.map((artifact) => artifact?.targetPlatform),
    graphCoreNativeSupportedTargets,
    "Managed tool descriptor graph native targets",
  );
  for (const artifact of nativeArtifacts) validateManagedToolGraphNativeArtifact(artifact);
}

export { validateManagedToolGraphNativeArtifacts };

function validateManagedToolGraphNativeArtifact(
  artifact: ManagedToolDescriptorCapabilities["graph"]["nativeArtifacts"][number],
): void {
  validateRequiredObject(artifact, "Managed tool descriptor graph native artifact is required");
  const target = artifact.targetPlatform;
  const bundledPackage = graphCoreNativePackageNameForTarget(target);
  validateExactValue(
    artifact.packageName,
    "opcore",
    `Managed tool descriptor graph native packageName for ${target} must be opcore`,
  );
  validateExactValue(
    artifact.bundledPackageName,
    bundledPackage,
    `Managed tool descriptor graph native bundledPackageName for ${target} must be ${bundledPackage}`,
  );
  validateGraphNativeArtifactPaths(artifact, bundledPackage);
  validateGraphNativeArtifactIds(artifact);
}

export { validateManagedToolGraphNativeArtifact };

function validateGraphNativeArtifactPaths(
  artifact: ManagedToolDescriptorCapabilities["graph"]["nativeArtifacts"][number],
  bundledPackage: ReturnType<typeof graphCoreNativePackageNameForTarget>,
): void {
  validateExactValue(
    artifact.binaryPath,
    bundledGraphCoreNativePath(bundledPackage, "opcore-graph-core"),
    "Managed tool descriptor graph native binaryPath must point at bundled opcore-graph-core",
  );
  validateExactValue(
    artifact.metadataPath,
    bundledGraphCoreNativePath(bundledPackage, "metadata.json"),
    "Managed tool descriptor graph native metadataPath must point at bundled metadata.json",
  );
  validateExactValue(
    artifact.checksumPath,
    bundledGraphCoreNativePath(bundledPackage, "opcore-graph-core.sha256"),
    "Managed tool descriptor graph native checksumPath must point at bundled opcore-graph-core.sha256",
  );
}

export { validateGraphNativeArtifactPaths };

function validateGraphNativeArtifactIds(
  artifact: ManagedToolDescriptorCapabilities["graph"]["nativeArtifacts"][number],
): void {
  validateRequiredObject(artifact.artifactIds, "Managed tool descriptor graph native artifact ids are required");
  const suffix = artifact.targetPlatform;
  validateExactValue(
    artifact.artifactIds.binaryArtifactId,
    `graph-core-binary-${suffix}`,
    `Managed tool descriptor graph native binary artifact id must be graph-core-binary-${suffix}`,
  );
  validateExactValue(
    artifact.artifactIds.metadataArtifactId,
    `graph-core-metadata-${suffix}`,
    `Managed tool descriptor graph native metadata artifact id must be graph-core-metadata-${suffix}`,
  );
  validateExactValue(
    artifact.artifactIds.checksumArtifactId,
    `graph-core-checksum-${suffix}`,
    `Managed tool descriptor graph native checksum artifact id must be graph-core-checksum-${suffix}`,
  );
  validateExactValue(
    artifact.artifactIds.checksumId,
    `graph-core-binary-sha256-${suffix}`,
    `Managed tool descriptor graph native checksum id must be graph-core-binary-sha256-${suffix}`,
  );
}

export { validateGraphNativeArtifactIds };

function validateManagedToolEditCapabilities(edit: ManagedToolDescriptorCapabilities["edit"]): void {
  if (!edit || typeof edit !== "object") throw new Error("Managed tool descriptor edit capabilities are required");
  validateExactStringSet(
    edit.commands,
    ["exact", "multi", "search-replace", "patch", "tree", "rename", "move", "signature", "check", "apply"],
    "Managed tool descriptor edit commands",
  );
  validateExactStringSet(
    edit.safeEditModes,
    ["exact", "multi", "search-replace", "patch", "tree"],
    "Managed tool descriptor safe edit modes",
  );
  validateExactStringSet(
    edit.symbolEditModes,
    ["rename", "move", "signature"],
    "Managed tool descriptor symbol edit modes",
  );
  if (edit.validationRequiredForApply !== true) {
    throw new Error("Managed tool descriptor edit validationRequiredForApply must be true");
  }
  if (edit.dryRun !== true) throw new Error("Managed tool descriptor edit dryRun must be true");
}

export { validateManagedToolEditCapabilities };

function validateManagedToolValidationCapabilities(validation: ManagedToolDescriptorCapabilities["validation"]): void {
  if (!validation || typeof validation !== "object")
    throw new Error("Managed tool descriptor validation capabilities are required");
  validateExactStringSet(
    validation.checkRoutes,
    ["files", "staged", "changed", "tree", "all", "manifest"],
    "Managed tool descriptor check routes",
  );
  validateExactStringSet(
    validation.validateRoutes,
    ["request", "hypothetical", "pre-write", "manifest"],
    "Managed tool descriptor validate routes",
  );
  validateExactStringSet(validation.scopeModes, validationScopeKinds, "Managed tool descriptor validation scope modes");
  validateExactStringSet(validation.graphModes, graphProviderModes, "Managed tool descriptor validation graph modes");
  if (validation.hypothetical !== true) throw new Error("Managed tool descriptor validation hypothetical must be true");
  validateExactStringSet(
    validation.statusSurfaces,
    ["status", "doctor"],
    "Managed tool descriptor validation status surfaces",
  );
  validateRequiredObject(
    validation.pythonProjectContext,
    "Managed tool descriptor Python project context capability is required",
  );
  if (validation.pythonProjectContext.schemaId !== PYTHON_PROJECT_CONTEXT_SCHEMA_ID) {
    throw new Error(
      `Managed tool descriptor Python project context schemaId must be ${PYTHON_PROJECT_CONTEXT_SCHEMA_ID}`,
    );
  }
  validateExactStringSet(
    validation.pythonProjectContext.outcomes,
    pythonProjectContextOutcomes,
    "Managed tool descriptor Python project context outcomes",
  );
  if (validation.pythonProjectContext.readOnly !== true || validation.pythonProjectContext.installs !== false) {
    throw new Error("Managed tool descriptor Python project context must be read-only and no-install");
  }
  validateManagedToolValidationWriteGate(validation.writeGate);
  validateValidationChecks(validation.checkIds, "Managed tool descriptor validation checkIds");
}

export { validateManagedToolValidationCapabilities };

function validateManagedToolValidationWriteGate(
  writeGate: ManagedToolDescriptorCapabilities["validation"]["writeGate"],
): void {
  validateRequiredObject(writeGate, "Managed tool descriptor validation writeGate is required");
  validateExactStringSet(writeGate.initScopes, opcoreInitScopes, "Managed tool descriptor writeGate initScopes");
  validateExactStringSet(writeGate.harnesses, ["claude-code", "codex"], "Managed tool descriptor writeGate harnesses");
  validateManagedToolPackagePath(writeGate.adapterPath, "Managed tool descriptor writeGate adapterPath");
  if (writeGate.adapterPath !== "dist/agent-gate.js") {
    throw new Error("Managed tool descriptor writeGate adapterPath must be dist/agent-gate.js");
  }
  validateExactStringSequence(
    writeGate.validationCommand,
    ["opcore", "validate", "pre-write", "--request-file", "<request-file>", "--timeout-ms", "30000", "--json"],
    "Managed tool descriptor writeGate validationCommand",
  );
  if (writeGate.adapterErrorPolicy !== "fail_open") {
    throw new Error("Managed tool descriptor writeGate adapterErrorPolicy must be fail_open");
  }
  if (writeGate.validationErrorPolicy !== "fail_closed") {
    throw new Error("Managed tool descriptor writeGate validationErrorPolicy must be fail_closed");
  }
  if (writeGate.codexBoundary !== "pretooluse_guardrail") {
    throw new Error("Managed tool descriptor writeGate codexBoundary must be pretooluse_guardrail");
  }
}

export { validateManagedToolValidationWriteGate };

interface ManagedToolDescriptorArtifactValidationState {
  artifactIds: Set<string>;
  artifactChecksumRefs: readonly { artifactId: string; checksumRef: string }[];
}

export type { ManagedToolDescriptorArtifactValidationState };
