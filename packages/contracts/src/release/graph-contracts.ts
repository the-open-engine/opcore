import type { GraphProviderArtifactMetadata } from "../graph/provider-contracts-01.js";
import type {
  GraphReleaseBenchmarkMetric,
  GraphReleaseCoreCommandId,
  GraphReleaseDeferredChild,
  GraphReleaseHandoffIssue,
  GraphReleaseOptionalAnalysisSurface,
  GraphReleaseRustCommandId,
  GraphReleaseSurfaceClassification,
} from "./graph-vocabulary-01.js";
import type {
  GraphCoreNativePackageName,
  GraphCoreNativeSupportedTarget,
  GraphReleaseDirectSqliteQueryId,
  GraphReleaseReportReceiptId,
  GraphReleaseServeTransportId,
} from "./graph-vocabulary-02.js";

interface GraphReleaseCommandCoverage {
  id: GraphReleaseCoreCommandId;
  bin: "opcore";
  command: readonly string[];
  canonicalCommand: readonly string[];
  status: "passed";
  exitCode: 0;
  fixture: string;
  durationMs: number;
}

export type { GraphReleaseCommandCoverage };

interface GraphReleaseRustCommandCoverage {
  id: GraphReleaseRustCommandId;
  bin: "opcore";
  command: readonly string[];
  canonicalCommand: readonly string[];
  status: "passed";
  exitCode: 0;
  fixture: string;
  durationMs: number;
}

export type { GraphReleaseRustCommandCoverage };

interface GraphReleaseDirectSqliteQueryReceipt {
  id: GraphReleaseDirectSqliteQueryId;
  query: string;
  status: "passed";
  rowCount: number;
  fixture: string;
}

export type { GraphReleaseDirectSqliteQueryReceipt };

interface GraphReleaseServeTransportReceipt {
  id: GraphReleaseServeTransportId;
  protocol: "opcore.graph.daemon" | "jsonrpc-2.0" | (string & {});
  operation: "ping" | "status" | "query" | "search" | "shutdown" | (string & {});
  status: "passed";
  exitCode: 0;
}

export type { GraphReleaseServeTransportReceipt };

interface GraphReleaseBenchmarkReceipt {
  metric: GraphReleaseBenchmarkMetric;
  value: number;
  unit: "ms" | "bytes";
  baselineIssue: "#19";
  baselineReceipt: string;
  comparison: "recorded" | "within_baseline" | "above_baseline" | "below_baseline";
}

export type { GraphReleaseBenchmarkReceipt };

interface GraphReleasePackageInspection {
  packageName: "@the-open-engine/opcore-graph";
  tarballName: string;
  fileCount: number;
  files: readonly string[];
  forbiddenMarkersAbsent: true;
  generatedBuildMetadataAbsent: true;
  privatePathsAbsent: true;
  sourceProvenanceAbsent: true;
  packageMetadataAbsent: true;
  gitHistoryAbsent: true;
  foreignImplementationNamesAbsent: true;
  inspections: readonly string[];
}

export type { GraphReleasePackageInspection };

interface GraphReleaseNativeArtifactEvidence {
  packageName: GraphCoreNativePackageName;
  targetPlatform: GraphCoreNativeSupportedTarget;
  metadata: GraphProviderArtifactMetadata;
  binaryPath: "opcore-graph-core";
  checksumPath: "opcore-graph-core.sha256";
  metadataPath: "metadata.json";
  binarySha256: string;
  checksumFileSha256: string;
  metadataSha256: string;
  packageFiles: readonly string[];
}

export type { GraphReleaseNativeArtifactEvidence };

interface GraphReleaseReportReceipt {
  id: GraphReleaseReportReceiptId;
  command: readonly string[];
  status: "passed";
  exitCode: 0;
  path: string;
  checksumSha256?: string;
}

export type { GraphReleaseReportReceipt };

interface GraphReleaseOptionalSurfaceReceipt {
  issue: GraphReleaseDeferredChild;
  id: GraphReleaseOptionalAnalysisSurface["id"] | (string & {});
  classification: GraphReleaseSurfaceClassification;
  status: "unsupported" | "deferred";
}

export type { GraphReleaseOptionalSurfaceReceipt };

interface GraphReleaseHandoffReceipt {
  issue: GraphReleaseHandoffIssue;
  receiptPath: string;
  checksumSha256: string;
  rollbackNote: string;
}

export type { GraphReleaseHandoffReceipt };

interface GraphReleasePackageVersion {
  packageName: string;
  version: string;
}

export type { GraphReleasePackageVersion };

interface GraphReleaseReceiptIdentity {
  schemaVersion: 1;
  issue: "#17";
  origin: "covibes-authored-synthetic";
  generatedAt: string;
  commitSha: string;
  graphPackageVersions: readonly GraphReleasePackageVersion[];
  graphProviderSchemaVersion: 1;
  requiredChildren: readonly string[];
  deferredChildren: readonly string[];
}

export type { GraphReleaseReceiptIdentity };

interface GraphReleaseReceiptEvidence {
  commandCoverage: readonly GraphReleaseCommandCoverage[];
  rustCommandCoverage: readonly GraphReleaseRustCommandCoverage[];
  directSqliteQueries: readonly GraphReleaseDirectSqliteQueryReceipt[];
  serveTransport: readonly GraphReleaseServeTransportReceipt[];
  benchmarks: readonly GraphReleaseBenchmarkReceipt[];
  packageInspection: GraphReleasePackageInspection;
  supportedNativeTargets: readonly GraphCoreNativeSupportedTarget[];
  nativeArtifacts: readonly GraphReleaseNativeArtifactEvidence[];
  reportReceipts: readonly GraphReleaseReportReceipt[];
  graphArtifact: GraphProviderArtifactMetadata;
  optionalSurfaces: readonly GraphReleaseOptionalSurfaceReceipt[];
  handoff: readonly GraphReleaseHandoffReceipt[];
}

export type { GraphReleaseReceiptEvidence };

interface GraphReleaseReceipt extends GraphReleaseReceiptIdentity, GraphReleaseReceiptEvidence {}

export type { GraphReleaseReceipt };
