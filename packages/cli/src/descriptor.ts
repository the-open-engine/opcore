import {
  commandRouterManifest,
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets,
  graphFactQueryKinds,
  graphNamedQueryKinds,
  graphProviderModes,
  graphReleaseOptionalAnalysisSurfaces,
  type ManagedToolDescriptor,
  type ManagedToolDescriptorCommandGroupName,
  validateManagedToolDescriptor,
  validationScopeKinds
} from "@the-open-engine/lattice-contracts";
import {
  TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
  TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
  TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
  TYPE_SCRIPT_SYNTAX_CHECK_ID,
  TYPE_SCRIPT_TYPES_CHECK_ID
} from "@the-open-engine/lattice-validation-typescript";
import { rustValidationCheckIds } from "@the-open-engine/lattice-validation-rust";

export const descriptorArtifactPath = "dist/descriptors/lattice.managed-tool.json" as const;

const commandGroupPackageNames: Record<ManagedToolDescriptorCommandGroupName, string> = {
  graph: "@the-open-engine/lattice-graph",
  inspect: "@the-open-engine/lattice-cli",
  edit: "@the-open-engine/lattice-edit",
  check: "@the-open-engine/lattice-validation",
  validate: "@the-open-engine/lattice-validation",
  status: "@the-open-engine/lattice-cli",
  doctor: "@the-open-engine/lattice-cli"
};

export interface LatticeManagedToolDescriptorOptions {
  version?: string;
}

export function createLatticeManagedToolDescriptor(options: LatticeManagedToolDescriptorOptions = {}): ManagedToolDescriptor {
  const nativeArtifacts = graphCoreNativeSupportedTargets.map((targetPlatform) => ({
    targetPlatform,
    packageName: graphCoreNativePackageNameForTarget(targetPlatform),
    binaryPath: "lattice-graph-core" as const,
    metadataPath: "metadata.json" as const,
    checksumPath: "lattice-graph-core.sha256" as const,
    artifactIds: {
      binaryArtifactId: `graph-core-binary-${targetPlatform}`,
      metadataArtifactId: `graph-core-metadata-${targetPlatform}`,
      checksumArtifactId: `graph-core-checksum-${targetPlatform}`,
      checksumId: `graph-core-binary-sha256-${targetPlatform}`
    }
  }));
  const descriptor: ManagedToolDescriptor = {
    schemaVersion: 1,
    descriptorKind: "aggregate_lattice",
    aggregateIdentity: {
      name: "lattice",
      releaseLine: "lattice",
      packageName: "@the-open-engine/lattice-cli",
      ...(options.version ? { version: options.version } : {})
    },
    packageIdentity: {
      packageName: "@the-open-engine/lattice-cli",
      artifactName: "@the-open-engine/lattice-cli",
      ...(options.version ? { version: options.version } : {})
    },
    entrypoints: [
      {
        bin: "lattice",
        packageName: "@the-open-engine/lattice-cli",
        path: "dist/index.js",
        command: ["lattice"]
      }
    ],
    commandGroups: commandRouterManifest.commandGroups.map((group) => ({
      name: group.name as ManagedToolDescriptorCommandGroupName,
      canonicalCommand: group.canonicalCommand,
      commands: group.commands,
      packageName: commandGroupPackageNames[group.name as ManagedToolDescriptorCommandGroupName]
    })),
    healthProbes: [
      {
        id: "status-json",
        command: ["lattice", "status", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "doctor-json",
        command: ["lattice", "doctor", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "graph-status-json",
        command: ["lattice", "graph", "status", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "check-manifest-json",
        command: ["lattice", "check", "manifest", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "validate-manifest-json",
        command: ["lattice", "validate", "manifest", "--json"],
        expectedExitCode: 0,
        output: "json"
      }
    ],
    capabilities: {
      graph: {
        provider: "lattice-graph",
        schemaVersion: 1,
        commands: ["build", "update", "watch", "status", "query", "impact", "review-context", "detect-changes", "search", "serve"],
        queryKinds: [...graphFactQueryKinds, ...graphNamedQueryKinds, "review_context", "detect_changes", "search"],
        daemonOperations: ["ping", "status", "query", "search", "shutdown"],
        nativeArtifacts
      },
      edit: {
        commands: ["exact", "multi", "search-replace", "patch", "tree", "rename", "move", "signature", "check", "apply"],
        safeEditModes: ["exact", "multi", "search-replace", "patch", "tree"],
        symbolEditModes: ["rename", "move", "signature"],
        validationRequiredForApply: true,
        dryRun: true
      },
      validation: {
        checkRoutes: ["files", "staged", "changed", "tree", "all", "manifest"],
        validateRoutes: ["request", "hypothetical", "pre-write", "manifest"],
        scopeModes: validationScopeKinds,
        graphModes: graphProviderModes,
        hypothetical: true,
        statusSurfaces: ["status", "doctor"],
        checkIds: [
          TYPE_SCRIPT_SYNTAX_CHECK_ID,
          TYPE_SCRIPT_TYPES_CHECK_ID,
          TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
          TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
          TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
          ...rustValidationCheckIds
        ]
      }
    },
    artifacts: [
      {
        id: "cli-entrypoint",
        packageName: "@the-open-engine/lattice-cli",
        path: "dist/index.js",
        type: "entrypoint",
        required: true
      },
      {
        id: "descriptor",
        packageName: "@the-open-engine/lattice-cli",
        path: descriptorArtifactPath,
        type: "descriptor",
        required: true
      },
      {
        id: "contracts-schema",
        packageName: "@the-open-engine/lattice-contracts",
        path: "schemas/lattice-contracts.schema.json",
        type: "schema",
        required: true
      },
      ...nativeArtifacts.flatMap((artifact) => [
        {
          id: artifact.artifactIds.binaryArtifactId,
          packageName: artifact.packageName,
          path: artifact.binaryPath,
          type: "native_binary" as const,
          required: true,
          checksumRef: artifact.artifactIds.checksumId
        },
        {
          id: artifact.artifactIds.metadataArtifactId,
          packageName: artifact.packageName,
          path: artifact.metadataPath,
          type: "manifest" as const,
          required: true
        },
        {
          id: artifact.artifactIds.checksumArtifactId,
          packageName: artifact.packageName,
          path: artifact.checksumPath,
          type: "checksum" as const,
          required: true
        }
      ])
    ],
    checksums: nativeArtifacts.map((artifact) => ({
      id: artifact.artifactIds.checksumId,
      packageName: artifact.packageName,
      path: artifact.checksumPath,
      algorithm: "sha256",
      artifactRef: artifact.artifactIds.binaryArtifactId,
      required: true
    })),
    provenanceHooks: [
      {
        id: "pack-check",
        command: ["npm", "run", "pack:check"],
        expectedExitCode: 0
      },
      {
        id: "provenance-check",
        command: ["npm", "run", "provenance:check"],
        expectedExitCode: 0
      }
    ],
    optionalSurfaces: graphReleaseOptionalAnalysisSurfaces
  };
  return validateManagedToolDescriptor(descriptor);
}

export const latticeManagedToolDescriptor = createLatticeManagedToolDescriptor();
