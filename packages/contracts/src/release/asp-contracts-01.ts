import type { OpcoreSelfValidationReceipt, ReleaseCutoverInstalledPackageEvidence } from "./cutover-contracts.js";
import type { ReleaseReceiptPackageName } from "./vocabulary-01.js";
import type { AspDogfoodForbiddenProviderMarker, AspDogfoodUnsupportedSurfaceId } from "./vocabulary-02.js";

interface AspDogfoodManagerEvidence {
  bootstrapSource: "local-sibling";
  aspRepoPath: string;
  aspBinPath: string;
  cliPath: string;
  commitSha: string;
}

export type { AspDogfoodManagerEvidence };

interface AspDogfoodAspHomeEvidence {
  path: string;
  temp: true;
  isolated: true;
  sharedStateMutated: false;
  pathSanitized: true;
}

export type { AspDogfoodAspHomeEvidence };

interface AspDogfoodHostFixtureEvidence {
  repo: string;
  temp: true;
  sourceRepoMutated: false;
  baselineCommitted: true;
  changedPaths: readonly string[];
}

export type { AspDogfoodHostFixtureEvidence };

interface AspDogfoodCommandRunReceipt {
  id: string;
  command: readonly string[];
  status: "passed" | "failed" | "retained-not-run";
  exitCode: number | null;
  stdoutSha256: string;
  stderrSha256: string;
  output?: unknown;
  assertion: string;
}

export type { AspDogfoodCommandRunReceipt };

interface AspDogfoodProviderManifestEvidence {
  manifestPath: string;
  manifestSha256: string;
  manifest: unknown;
}

export type { AspDogfoodProviderManifestEvidence };

interface AspDogfoodProviderEvidence {
  providerId: "opcore";
  packageName: "opcore";
  binPath: string;
  indexPath: string;
  indexSha256: string;
  command: readonly ["opcore-asp-provider", "--stdio"];
  entrypoint: {
    transport: "stdio";
    bin: string;
    args: readonly ["--stdio"];
  };
  manifest: AspDogfoodProviderManifestEvidence;
}

export type { AspDogfoodProviderEvidence };

interface AspDogfoodRepoEnrollmentEvidence {
  repo: string;
  mode: "advisory" | "shadow";
  repoAdd: AspDogfoodCommandRunReceipt;
  repoEnable: AspDogfoodCommandRunReceipt;
  repoStatus: AspDogfoodCommandRunReceipt;
}

export type { AspDogfoodRepoEnrollmentEvidence };

interface AspDogfoodManagerStateEvidence {
  status: AspDogfoodCommandRunReceipt;
  serverAdd: AspDogfoodCommandRunReceipt;
  serverStatus: AspDogfoodCommandRunReceipt;
}

export type { AspDogfoodManagerStateEvidence };

interface AspDogfoodHostCheckEvidence extends AspDogfoodCommandRunReceipt {
  hostDecision: unknown;
  receipt: unknown;
  assurance: {
    mode: string;
    transactionGuarantee: string;
  };
}

export type { AspDogfoodHostCheckEvidence };

interface AspDogfoodHostEvaluationEvidence {
  check: AspDogfoodHostCheckEvidence;
  ciVerify?: AspDogfoodCommandRunReceipt;
}

export type { AspDogfoodHostEvaluationEvidence };

interface AspDogfoodProviderProbeEvidence extends AspDogfoodCommandRunReceipt {
  assessment: unknown;
  validAsOf: unknown;
  coverage: unknown;
  diagnosticsCount: number;
  hostOwnedFieldLeak: false;
}

export type { AspDogfoodProviderProbeEvidence };

interface AspDogfoodUnsupportedSurfaceEvidence {
  surface: AspDogfoodUnsupportedSurfaceId;
  status: "degraded" | "parity-blocker";
  cleanCoverage: false;
  blocker: string;
}

export type { AspDogfoodUnsupportedSurfaceEvidence };

interface AspDogfoodParityBlocker {
  source: string;
  detail: string;
}

export type { AspDogfoodParityBlocker };

interface AspDogfoodAuthorityEvidence {
  hostOwnsDecisions: true;
  providerOutputIsHostDecision: false;
  localAuthorityOverride: {
    present: false;
    sharedAuthorityWeakened: false;
  };
}

export type { AspDogfoodAuthorityEvidence };

interface AspDogfoodForbiddenMarkerScan {
  scannedTextCount: number;
  findingCount: 0;
  markersBlocked: readonly AspDogfoodForbiddenProviderMarker[];
}

export type { AspDogfoodForbiddenMarkerScan };

interface AspDogfoodReceiptIdentity {
  schemaVersion: 1;
  issue: "#120";
  origin: "covibes-authored-asp-dogfood-proof";
  generatedAt: string;
  commitSha: string;
  privateRepo: true;
  bootstrapSource: "local-sibling";
  packageNames: readonly ReleaseReceiptPackageName[];
  installedPackages: readonly ReleaseCutoverInstalledPackageEvidence[];
}

export type { AspDogfoodReceiptIdentity };

interface AspDogfoodReceiptEvidence {
  manager: AspDogfoodManagerEvidence;
  aspHome: AspDogfoodAspHomeEvidence;
  hostFixture: AspDogfoodHostFixtureEvidence;
  provider: AspDogfoodProviderEvidence;
  managerState: AspDogfoodManagerStateEvidence;
  repoEnrollment: AspDogfoodRepoEnrollmentEvidence;
  hostEvaluation: AspDogfoodHostEvaluationEvidence;
  providerProbe: AspDogfoodProviderProbeEvidence;
  selfValidation: OpcoreSelfValidationReceipt;
  unsupportedSurfaces: readonly AspDogfoodUnsupportedSurfaceEvidence[];
  parityBlockers: readonly AspDogfoodParityBlocker[];
  authority: AspDogfoodAuthorityEvidence;
  publicReleaseActions: readonly [];
  forbiddenMarkerScan: AspDogfoodForbiddenMarkerScan;
}

export type { AspDogfoodReceiptEvidence };

interface AspDogfoodReceipt extends AspDogfoodReceiptIdentity, AspDogfoodReceiptEvidence {}

export type { AspDogfoodReceipt };
