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
} from "@the-open-engine/opcore-contracts";
import {
  TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
  TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
  TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
  TYPE_SCRIPT_SYNTAX_CHECK_ID,
  TYPE_SCRIPT_TYPES_CHECK_ID
} from "@the-open-engine/opcore-validation-typescript";
import { rustValidationCheckIds } from "@the-open-engine/opcore-validation-rust";

export const descriptorArtifactPath = "dist/descriptors/lattice.managed-tool.json" as const;

const commandGroupPackageNames: Record<ManagedToolDescriptorCommandGroupName, string> = {
  graph: "@the-open-engine/opcore-graph",
  inspect: "@the-open-engine/opcore",
  edit: "@the-open-engine/opcore-edit",
  check: "@the-open-engine/opcore-validation",
  validate: "@the-open-engine/opcore-validation",
  status: "@the-open-engine/opcore",
  doctor: "@the-open-engine/opcore"
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
      packageName: "@the-open-engine/opcore",
      ...(options.version ? { version: options.version } : {})
    },
    packageIdentity: {
      packageName: "@the-open-engine/opcore",
      artifactName: "@the-open-engine/opcore",
      ...(options.version ? { version: options.version } : {})
    },
    entrypoints: [
      {
        bin: "lattice",
        packageName: "@the-open-engine/opcore",
        path: "dist/lattice/index.js",
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
        packageName: "@the-open-engine/opcore",
        path: "dist/lattice/index.js",
        type: "entrypoint",
        required: true
      },
      {
        id: "descriptor",
        packageName: "@the-open-engine/opcore",
        path: descriptorArtifactPath,
        type: "descriptor",
        required: true
      },
      {
        id: "contracts-schema",
        packageName: "@the-open-engine/opcore-contracts",
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
