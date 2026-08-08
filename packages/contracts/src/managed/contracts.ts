import type { GraphProviderMode } from "../graph/vocabulary-01.js";
import type { OpcoreInitScope } from "../product/init-contracts.js";
import type { GraphReleaseOptionalSurfaceReceipt } from "../release/graph-contracts.js";
import type { GraphCoreNativePackageName, GraphCoreNativeSupportedTarget } from "../release/graph-vocabulary-02.js";
import type {
  PYTHON_PROJECT_CONTEXT_SCHEMA_ID,
  PythonProjectContextOutcome,
} from "../validation/python-project-contracts-01.js";
import type { ValidationScopeKind } from "../validation/request-contracts.js";

const managedToolDescriptorCommandGroups = [
  "graph",
  "inspect",
  "edit",
  "check",
  "validate",
  "status",
  "doctor",
] as const;

export { managedToolDescriptorCommandGroups };

type ManagedToolDescriptorCommandGroupName = (typeof managedToolDescriptorCommandGroups)[number];

export type { ManagedToolDescriptorCommandGroupName };

const managedToolDescriptorCommandGroupPackageNames: Record<ManagedToolDescriptorCommandGroupName, string> = {
  graph: "opcore",
  inspect: "opcore",
  edit: "opcore",
  check: "opcore",
  validate: "opcore",
  status: "opcore",
  doctor: "opcore",
};

export { managedToolDescriptorCommandGroupPackageNames };

const managedToolDescriptorArtifactTypes = [
  "entrypoint",
  "descriptor",
  "schema",
  "manifest",
  "native_binary",
  "checksum",
  "receipt",
] as const;

export { managedToolDescriptorArtifactTypes };

type ManagedToolDescriptorArtifactType = (typeof managedToolDescriptorArtifactTypes)[number];

export type { ManagedToolDescriptorArtifactType };

interface ManagedToolDescriptor {
  schemaVersion: 1;
  descriptorKind: "aggregate_opcore";
  aggregateIdentity: {
    name: "opcore";
    releaseLine: "opcore";
    packageName: "opcore";
    version?: string;
  };
  packageIdentity: {
    packageName: "opcore";
    artifactName: "opcore";
    version?: string;
  };
  entrypoints: readonly ManagedToolDescriptorEntrypoint[];
  commandGroups: readonly ManagedToolDescriptorCommandGroup[];
  healthProbes: readonly ManagedToolDescriptorHealthProbe[];
  capabilities: ManagedToolDescriptorCapabilities;
  artifacts: readonly ManagedToolDescriptorArtifactReference[];
  checksums: readonly ManagedToolDescriptorChecksumReference[];
  provenanceHooks: readonly ManagedToolDescriptorProvenanceHook[];
  optionalSurfaces: readonly GraphReleaseOptionalSurfaceReceipt[];
}

export type { ManagedToolDescriptor };

interface ManagedToolDescriptorEntrypoint {
  bin: "opcore";
  packageName: "opcore";
  path: string;
  command: readonly string[];
}

export type { ManagedToolDescriptorEntrypoint };

interface ManagedToolDescriptorCommandGroup {
  name: ManagedToolDescriptorCommandGroupName;
  canonicalCommand: readonly string[];
  commands: readonly string[];
  packageName: string;
}

export type { ManagedToolDescriptorCommandGroup };

interface ManagedToolDescriptorHealthProbe {
  id: string;
  command: readonly string[];
  expectedExitCode: 0;
  output: "json";
}

export type { ManagedToolDescriptorHealthProbe };

interface ManagedToolDescriptorCapabilities {
  graph: {
    provider: "opcore-graph";
    schemaVersion: 1;
    commands: readonly string[];
    queryKinds: readonly string[];
    daemonOperations: readonly string[];
    nativeArtifacts: readonly ManagedToolDescriptorNativeArtifact[];
  };
  edit: {
    commands: readonly string[];
    safeEditModes: readonly string[];
    symbolEditModes: readonly string[];
    validationRequiredForApply: true;
    dryRun: true;
  };
  validation: {
    checkRoutes: readonly string[];
    validateRoutes: readonly string[];
    scopeModes: readonly ValidationScopeKind[];
    graphModes: readonly GraphProviderMode[];
    hypothetical: true;
    statusSurfaces: readonly ("status" | "doctor")[];
    pythonProjectContext: {
      schemaId: typeof PYTHON_PROJECT_CONTEXT_SCHEMA_ID;
      outcomes: readonly PythonProjectContextOutcome[];
      readOnly: true;
      installs: false;
    };
    writeGate: {
      initScopes: readonly OpcoreInitScope[];
      harnesses: readonly ("claude-code" | "codex")[];
      adapterPath: string;
      validationCommand: readonly string[];
      adapterErrorPolicy: "fail_open";
      validationErrorPolicy: "fail_closed";
      codexBoundary: "pretooluse_guardrail";
    };
    checkIds: readonly string[];
  };
}

export type { ManagedToolDescriptorCapabilities };

interface ManagedToolDescriptorNativeArtifact {
  targetPlatform: GraphCoreNativeSupportedTarget;
  packageName: "opcore";
  bundledPackageName: GraphCoreNativePackageName;
  binaryPath: string;
  metadataPath: string;
  checksumPath: string;
  artifactIds: {
    binaryArtifactId: string;
    metadataArtifactId: string;
    checksumId: string;
    checksumArtifactId: string;
  };
}

export type { ManagedToolDescriptorNativeArtifact };

interface ManagedToolDescriptorArtifactReference {
  id: string;
  packageName: string;
  path: string;
  type: ManagedToolDescriptorArtifactType;
  required: boolean;
  checksumRef?: string;
}

export type { ManagedToolDescriptorArtifactReference };

interface ManagedToolDescriptorChecksumReference {
  id: string;
  packageName: string;
  path: string;
  algorithm: "sha256";
  artifactRef: string;
  required: boolean;
  value?: string;
}

export type { ManagedToolDescriptorChecksumReference };

interface ManagedToolDescriptorProvenanceHook {
  id: string;
  command: readonly string[];
  expectedExitCode: 0;
}

export type { ManagedToolDescriptorProvenanceHook };
