import type { CommandOwner, CommandRouteStatus } from "../command/vocabulary.js";
import type { ManagedToolDescriptor } from "../managed/contracts.js";
import type {
  ReleaseReceiptResolvedArtifactEvidence,
  ReleaseReceiptResolvedChecksumEvidence,
} from "./receipt-contracts-01.js";
import type {
  ReleaseCutoverCommandId,
  ReleaseCutoverPythonCommandId,
  ReleaseCutoverRustCommandId,
  ReleaseReceiptPackageName,
} from "./vocabulary-01.js";
import type { ReleaseCutoverInputIssue, ReleaseCutoverNegativeCheckId } from "./vocabulary-02.js";

interface ReleaseCutoverTarballEvidence {
  filename: string;
  sha256: string;
}

export type { ReleaseCutoverTarballEvidence };

interface ReleaseCutoverInstalledManifestEvidence {
  path: string;
  sha256: string;
  bins: Readonly<Record<string, string>>;
}

export type { ReleaseCutoverInstalledManifestEvidence };

interface ReleaseCutoverInstalledFileEvidence {
  path: string;
  sha256: string;
}

export type { ReleaseCutoverInstalledFileEvidence };

interface ReleaseCutoverInstalledPackageEvidence {
  packageName: ReleaseReceiptPackageName;
  version: string;
  tarball: ReleaseCutoverTarballEvidence;
  installedManifest: ReleaseCutoverInstalledManifestEvidence;
  installedFiles: readonly ReleaseCutoverInstalledFileEvidence[];
}

export type { ReleaseCutoverInstalledPackageEvidence };

interface ReleaseCutoverDescriptorEvidence {
  path: string;
  packageName: "opcore";
  checksumSha256: string;
  descriptor: ManagedToolDescriptor;
  resolvedArtifacts: readonly ReleaseReceiptResolvedArtifactEvidence[];
  resolvedChecksums: readonly ReleaseReceiptResolvedChecksumEvidence[];
}

export type { ReleaseCutoverDescriptorEvidence };

interface ReleaseCutoverEnvironmentIsolationEvidence {
  pathSanitized: true;
  siblingRepositoriesExcluded: true;
  opcoreBinsVerified: true;
}

export type { ReleaseCutoverEnvironmentIsolationEvidence };

interface ReleaseCutoverCommandReceipt {
  id: ReleaseCutoverCommandId;
  command: readonly string[];
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  exitCode: number;
  binPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  assertion: string;
}

export type { ReleaseCutoverCommandReceipt };

interface ReleaseCutoverRustCommandReceipt {
  id: ReleaseCutoverRustCommandId;
  command: readonly string[];
  canonicalCommand: readonly string[];
  owner: "graph";
  status: "ok";
  exitCode: 0;
  binPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  assertion: string;
}

export type { ReleaseCutoverRustCommandReceipt };

interface ReleaseCutoverPythonCommandReceipt {
  id: ReleaseCutoverPythonCommandId;
  command: readonly string[];
  canonicalCommand: readonly string[];
  evidence: readonly string[];
  owner: CommandOwner;
  status: "ok";
  exitCode: 0;
  binPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  assertion: string;
}

export type { ReleaseCutoverPythonCommandReceipt };

interface ReleaseCutoverNegativeCheck {
  id: ReleaseCutoverNegativeCheckId;
  command: readonly string[];
  status: "passed";
  exitCode: 0;
  assertion: string;
}

export type { ReleaseCutoverNegativeCheck };

interface OpcoreSelfValidationReceipt {
  id: "opcore-self-check";
  command: readonly ["npm", "run", "opcore:self-check"];
  status: "passed";
  exitCode: 0;
  stdoutSha256: string;
  stderrSha256: string;
  assertion: string;
}

export type { OpcoreSelfValidationReceipt };

interface ReleaseCutoverForbiddenMarkerScan {
  scannedTextCount: number;
  findingCount: 0;
  markersBlocked: readonly string[];
}

export type { ReleaseCutoverForbiddenMarkerScan };

interface ReleaseCutoverInputEvidence {
  issue: ReleaseCutoverInputIssue;
  path: string;
  checksumSha256: string;
}

export type { ReleaseCutoverInputEvidence };

interface ReleaseCutoverReceipt {
  schemaVersion: 1;
  issue: "#30";
  origin: "covibes-authored-cutover-proof";
  generatedAt: string;
  commitSha: string;
  privateRepo: true;
  packageNames: readonly ReleaseReceiptPackageName[];
  installedPackages: readonly ReleaseCutoverInstalledPackageEvidence[];
  descriptor: ReleaseCutoverDescriptorEvidence;
  environmentIsolation: ReleaseCutoverEnvironmentIsolationEvidence;
  commandReceipts: readonly ReleaseCutoverCommandReceipt[];
  rustCommandReceipts: readonly ReleaseCutoverRustCommandReceipt[];
  pythonCommandReceipts: readonly ReleaseCutoverPythonCommandReceipt[];
  negativeChecks: readonly ReleaseCutoverNegativeCheck[];
  selfValidation: OpcoreSelfValidationReceipt;
  forbiddenMarkerScan: ReleaseCutoverForbiddenMarkerScan;
  inputEvidence: readonly ReleaseCutoverInputEvidence[];
}

export type { ReleaseCutoverReceipt };
