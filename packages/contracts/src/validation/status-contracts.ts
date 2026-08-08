import type { RepoIdentity } from "../graph/provider-contracts-01.js";
import type { GraphProviderStatus } from "../graph/provider-contracts-02.js";
import type { GraphProviderMode } from "../graph/vocabulary-01.js";
import type { ValidationCheckManifestEntry } from "./diagnostic-contracts.js";
import type { ValidationScope } from "./request-contracts.js";
import type { ValidationCheckRunStatus, ValidationResultStatus } from "./vocabulary-01.js";

interface RequiredContextDocPolicy {
  filenames: readonly string[];
  requiredPaths: readonly string[];
  requireRoot?: boolean;
  minimumContentLength: number;
  maxLines?: number;
  maxSectionLines?: number;
}

export type { RequiredContextDocPolicy };

const requiredContextDocPolicy = {
  filenames: ["AGENTS.md", "CLAUDE.md"],
  requiredPaths: ["."],
  requireRoot: true,
  minimumContentLength: 120,
} as const satisfies RequiredContextDocPolicy;

export { requiredContextDocPolicy };

interface PreWriteValidationOverlaySummary {
  count: number;
  writeCount: number;
  deleteCount: number;
  paths: readonly string[];
}

export type { PreWriteValidationOverlaySummary };

interface PreWriteValidationFailureSummary {
  category: ValidationResultStatus;
  message: string;
  cause?: string;
  retryable?: boolean;
}

export type { PreWriteValidationFailureSummary };

interface PreWriteValidationReceipt {
  schemaVersion: 1;
  kind: "pre_write_validation";
  route: "validate.pre-write";
  canonicalCommand: readonly string[];
  generatedAt: string;
  durationMs: number;
  timeoutMs: number;
  ok: boolean;
  requestId?: string;
  repo?: RepoIdentity;
  scope?: ValidationScope;
  checks?: readonly string[];
  graph?: {
    mode: GraphProviderMode;
    provider?: string;
    status?: GraphProviderStatus;
  };
  overlays?: PreWriteValidationOverlaySummary;
  validationStatus: ValidationResultStatus;
  diagnosticCount: number;
  failureSummary?: PreWriteValidationFailureSummary;
}

export type { PreWriteValidationReceipt };

const validationDaemonReadinessStates = ["not_configured", "ready", "unavailable", "error"] as const;

export { validationDaemonReadinessStates };

type ValidationDaemonReadinessState = (typeof validationDaemonReadinessStates)[number];

export type { ValidationDaemonReadinessState };

const validationAdapterRuntimeStates = ["available", "degraded", "unavailable"] as const;

export { validationAdapterRuntimeStates };

type ValidationAdapterRuntimeState = (typeof validationAdapterRuntimeStates)[number];

export type { ValidationAdapterRuntimeState };

interface ValidationAdapterToolchainStatus {
  tool: string;
  available: boolean;
  command?: string;
  version?: string;
  failureMessage?: string;
  cwd?: string;
  configFile?: string;
  source?: string;
}

export type { ValidationAdapterToolchainStatus };

interface ValidationAdapterDegradedCheckStatus {
  checkId: string;
  status: ValidationCheckRunStatus;
  reason: string;
  message: string;
  requiredTool?: string;
  retainedCompatibility?: boolean;
  followUpIssue?: string;
  currentUsage?: {
    opcore: boolean;
    orchestra: boolean;
    covibes: boolean;
    gateway: boolean;
  };
}

export type { ValidationAdapterDegradedCheckStatus };

interface ValidationAdapterRuntimeStatus {
  adapter: string;
  status: ValidationAdapterRuntimeState;
  checkIds: readonly string[];
  toolchain?: readonly ValidationAdapterToolchainStatus[];
  degradedChecks?: readonly ValidationAdapterDegradedCheckStatus[];
  tempWorkspaceRequired?: boolean;
}

export type { ValidationAdapterRuntimeStatus };

interface ValidationStatusPayload {
  schemaVersion: 1;
  ready: boolean;
  generatedAt: string;
  adapterRegistry: {
    checkRoutes: readonly string[];
    validateRoutes: readonly string[];
    checkIds: readonly string[];
    entries: readonly ValidationCheckManifestEntry[];
    adapters?: readonly ValidationAdapterRuntimeStatus[];
  };
  graph: {
    mode: GraphProviderMode;
    status: GraphProviderStatus;
  };
  daemon?: {
    state: ValidationDaemonReadinessState;
    message?: string;
  };
}

export type { ValidationStatusPayload };
