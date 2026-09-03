import type { RepoIdentity } from "../graph/provider-contracts-01.js";
import type { GraphProviderStatus } from "../graph/provider-contracts-02.js";
import type { CLONE_PROTOCOL, GraphProviderMode } from "../graph/vocabulary-01.js";
import type { ValidationFailureCategory, ValidationReportMode } from "./vocabulary-01.js";

const validationScopeKinds = ["files", "changed", "staged", "tree", "all", "repo", "package"] as const;

export { validationScopeKinds };

type ValidationScopeKind = (typeof validationScopeKinds)[number];

export type { ValidationScopeKind };

type ValidationScope =
  | {
      kind: "files";
      files: readonly string[];
    }
  | {
      kind: "changed";
      baseRef: string;
    }
  | {
      kind: "staged";
    }
  | {
      kind: "tree";
      treeRef: string;
      changedFrom: string;
    }
  | {
      kind: "all";
    }
  | {
      kind: "repo";
    }
  | {
      kind: "package";
      packageName: string;
      packageRoot: string;
    };

export type { ValidationScope };

type HypotheticalOverlay =
  | {
      path: string;
      action: "write";
      content: string;
      checksumBefore?: string;
    }
  | {
      path: string;
      action: "delete";
      checksumBefore?: string;
    };

export type { HypotheticalOverlay };

const cloneReportModes = ["all", "introduced"] as const;

export { cloneReportModes };

type CloneReportMode = (typeof cloneReportModes)[number];

export type { CloneReportMode };

const cloneSourceReadModes = ["disk", "gitIndex", "gitTree"] as const;

export { cloneSourceReadModes };

type CloneSourceReadMode = (typeof cloneSourceReadModes)[number];

export type { CloneSourceReadMode };

interface CloneAnalysisRequest {
  protocol: typeof CLONE_PROTOCOL;
  requestId?: string;
  schemaVersion: 1;
  repo: RepoIdentity;
  reportMode: CloneReportMode;
  paths?: readonly string[];
  sourcePaths?: readonly string[];
  sourceReadMode?: CloneSourceReadMode;
  sourceTreeRef?: string;
  overlays: readonly HypotheticalOverlay[];
  windowSize?: number;
  minLines?: number;
  minTokens?: number;
  threshold?: number;
  partitions?: readonly (readonly string[])[];
  exclude?: readonly string[];
  modes?: readonly string[];
}

export type { CloneAnalysisRequest };

interface CloneFinding {
  cloneClassId: string;
  contentHash: string;
  path: string;
  peerPath: string;
  paths: readonly string[];
  lineCount: number;
  tokenCount: number;
  introduced: boolean;
}

export type { CloneFinding };

interface CloneAnalysisSummary {
  analyzedFiles: number;
  cloneClassCount: number;
  findingCount: number;
  overlayCount: number;
}

export type { CloneAnalysisSummary };

interface CloneAnalysisResult {
  protocol: typeof CLONE_PROTOCOL;
  requestId?: string;
  schemaVersion: 1;
  repo: RepoIdentity;
  reportMode: CloneReportMode;
  status: "passed";
  persisted: boolean;
  dbPath?: string;
  findings: readonly CloneFinding[];
  summary: CloneAnalysisSummary;
}

export type { CloneAnalysisResult };

interface ValidationFailure {
  category: ValidationFailureCategory;
  message: string;
  retryable?: boolean;
  cause?: string;
}

export type { ValidationFailure };

interface ValidationGraphConfig {
  mode: GraphProviderMode;
  provider?: string;
  maxAgeMs?: number;
  status?: GraphProviderStatus;
}

export type { ValidationGraphConfig };

interface ValidationRequest {
  requestId?: string;
  repo: RepoIdentity;
  scope: ValidationScope;
  graph: ValidationGraphConfig;
  overlays: readonly HypotheticalOverlay[];
  checks?: readonly string[];
  reportMode?: ValidationReportMode;
}

export type { ValidationRequest };
