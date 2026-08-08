import type {
  ReleaseReceiptDescriptorEvidence,
  ReleaseReceiptGraphReleaseEvidence,
  ReleaseReceiptLicenseEvidence,
  ReleaseReceiptNativeArtifactEvidence,
  ReleaseReceiptPackageEvidence,
  ReleaseReceiptProvenanceEvidence,
  ReleaseReceiptReport,
  ReleaseReceiptSecretHistoryEvidence,
} from "./receipt-contracts-01.js";
import type { ReleaseReceiptCommandGroupName, ReleaseReceiptPackageName } from "./vocabulary-01.js";

interface ReleaseReceipt {
  schemaVersion: 1;
  issue: "#29";
  origin: "covibes-authored-release-proof";
  generatedAt: string;
  commitSha: string;
  privateRepo: true;
  packageNames: readonly ReleaseReceiptPackageName[];
  commandGroups: readonly ReleaseReceiptCommandGroupName[];
  packages: readonly ReleaseReceiptPackageEvidence[];
  descriptor: ReleaseReceiptDescriptorEvidence;
  nativeArtifacts: readonly ReleaseReceiptNativeArtifactEvidence[];
  license: ReleaseReceiptLicenseEvidence;
  provenance: ReleaseReceiptProvenanceEvidence;
  secretHistory: ReleaseReceiptSecretHistoryEvidence;
  reports: readonly ReleaseReceiptReport[];
  graphReleaseReceipt: ReleaseReceiptGraphReleaseEvidence;
}

export type { ReleaseReceipt };
