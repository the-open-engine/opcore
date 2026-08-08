import type { GraphProviderArtifactMetadata } from "../graph/provider-contracts-01.js";
import type {
  ManagedToolDescriptor,
  ManagedToolDescriptorArtifactReference,
  ManagedToolDescriptorArtifactType,
} from "../managed/contracts.js";
import type { GraphCoreNativePackageName, GraphCoreNativeSupportedTarget } from "./graph-vocabulary-02.js";
import type {
  ReleaseReceiptCommandGroupName,
  ReleaseReceiptPackageName,
  ReleaseReceiptReportId,
  ReleaseReceiptSecretFindingScope,
} from "./vocabulary-01.js";

interface ReleaseReceiptTarballEvidence {
  filename: string;
  path: string;
  sha256: string;
  integrity?: string;
  shasum?: string;
}

export type { ReleaseReceiptTarballEvidence };

interface ReleaseReceiptPackageManifestMetadata {
  name: ReleaseReceiptPackageName;
  version: string;
  license: string;
  main?: string;
  types?: string;
  files: readonly string[];
  bins: Readonly<Record<string, string>>;
  dependencies: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  bundledDependencies: readonly string[];
  os?: readonly string[];
  cpu?: readonly string[];
}

export type { ReleaseReceiptPackageManifestMetadata };

interface ReleaseReceiptNativeArtifactEvidence {
  packageName: "opcore";
  bundledPackageName: GraphCoreNativePackageName;
  targetPlatform: GraphCoreNativeSupportedTarget;
  metadata: GraphProviderArtifactMetadata;
  binaryPath: string;
  checksumPath: string;
  metadataPath: string;
  binarySha256: string;
  checksumFileSha256: string;
  metadataSha256: string;
  descriptorArtifactId: string;
  descriptorChecksumId: string;
}

export type { ReleaseReceiptNativeArtifactEvidence };

interface ReleaseReceiptPackageEvidence {
  packageName: ReleaseReceiptPackageName;
  packageRoot: string;
  version: string;
  manifest: ReleaseReceiptPackageManifestMetadata;
  tarball: ReleaseReceiptTarballEvidence;
  files: readonly string[];
  fileCount: number;
  expectedFiles: readonly string[];
  expectedFileCount: number;
  bins: Readonly<Record<string, string>>;
  descriptorReferences: readonly ManagedToolDescriptorArtifactReference[];
  nativeArtifacts: readonly ReleaseReceiptNativeArtifactEvidence[];
}

export type { ReleaseReceiptPackageEvidence };

interface ReleaseReceiptDescriptorCommandGroupEvidence {
  name: ReleaseReceiptCommandGroupName;
  canonicalCommand: readonly string[];
  packageName: string;
}

export type { ReleaseReceiptDescriptorCommandGroupEvidence };

interface ReleaseReceiptResolvedArtifactEvidence {
  id: string;
  packageName: ReleaseReceiptPackageName;
  path: string;
  type: ManagedToolDescriptorArtifactType;
  required: boolean;
  packageFile: true;
  checksumRef?: string;
}

export type { ReleaseReceiptResolvedArtifactEvidence };

interface ReleaseReceiptResolvedChecksumEvidence {
  id: string;
  packageName: ReleaseReceiptPackageName;
  path: string;
  algorithm: "sha256";
  artifactRef: string;
  required: boolean;
  packageFile: true;
  value: string;
}

export type { ReleaseReceiptResolvedChecksumEvidence };

interface ReleaseReceiptDescriptorEvidence {
  path: string;
  packageName: "opcore";
  checksumSha256: string;
  descriptor: ManagedToolDescriptor;
  commandGroups: readonly ReleaseReceiptDescriptorCommandGroupEvidence[];
  resolvedArtifacts: readonly ReleaseReceiptResolvedArtifactEvidence[];
  resolvedChecksums: readonly ReleaseReceiptResolvedChecksumEvidence[];
}

export type { ReleaseReceiptDescriptorEvidence };

interface ReleaseReceiptLicensePackageEvidence {
  name: string;
  version: string;
  license: string;
  source: string;
  bundled: boolean;
}

export type { ReleaseReceiptLicensePackageEvidence };

interface ReleaseReceiptLicenseEvidence {
  reportPath: string;
  reportSha256: string;
  productionDependencyCount: number;
  bundledDependencyCount: number;
  workspacePackageCount: number;
  unresolvedLicenseCount: 0;
  packages: readonly ReleaseReceiptLicensePackageEvidence[];
}

export type { ReleaseReceiptLicenseEvidence };

interface ReleaseReceiptProvenanceFinding {
  scope: "current-tree" | "git-history";
  marker: string;
  path?: string;
  commit?: string;
  line?: number;
}

export type { ReleaseReceiptProvenanceFinding };

interface ReleaseReceiptProvenanceEvidence {
  reportPath: string;
  reportSha256: string;
  scannedFileCount: number;
  historyCommitCount: number;
  findingCount: 0;
  findings: readonly ReleaseReceiptProvenanceFinding[];
}

export type { ReleaseReceiptProvenanceEvidence };

interface ReleaseReceiptSecretFinding {
  scope: ReleaseReceiptSecretFindingScope;
  kind: string;
  path?: string;
  commit?: string;
  line?: number;
  fingerprint: string;
  allowlisted: boolean;
}

export type { ReleaseReceiptSecretFinding };

interface ReleaseReceiptSecretHistoryEvidence {
  allowlistPath: string;
  allowlistSha256: string;
  currentTreeScannedFileCount: number;
  gitHistoryScannedCommitCount: number;
  findingCount: 0;
  findings: readonly ReleaseReceiptSecretFinding[];
}

export type { ReleaseReceiptSecretHistoryEvidence };

interface ReleaseReceiptReport {
  id: ReleaseReceiptReportId;
  command: readonly string[];
  status: "passed";
  exitCode: 0;
  path?: string;
  checksumSha256?: string;
  summary: string;
}

export type { ReleaseReceiptReport };

interface ReleaseReceiptGraphReleaseEvidence {
  path: string;
  issue: "#17";
  checksumSha256: string;
}

export type { ReleaseReceiptGraphReleaseEvidence };
