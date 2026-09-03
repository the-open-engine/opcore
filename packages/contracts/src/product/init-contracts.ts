import type { GraphProviderStatusState } from "../graph/vocabulary-01.js";
import type { PythonProjectContext } from "../validation/python-project-contracts-02.js";
import type { ValidationResultStatus } from "../validation/vocabulary-01.js";

const opcoreInitScopes = ["repo", "global"] as const;

export { opcoreInitScopes };

type OpcoreInitScope = (typeof opcoreInitScopes)[number];

export type { OpcoreInitScope };

interface OpcoreInitAction {
  kind: "write" | "upsert_block" | "create_hook" | "wire_harness" | "restore" | "remove";
  path: string;
  targetScope: OpcoreInitScope;
  summary: string;
  requiresApproval: boolean;
  outsideOpcore: boolean;
}

export type { OpcoreInitAction };

interface OpcoreInitScanSummary {
  totalFiles: number;
  graphSupportedFiles: number;
  validationSupportedFiles: number;
  validationRetainedFiles: number;
  unsupportedFiles: number;
  languages: readonly {
    language: string;
    files: number;
    graphSupported: boolean;
    validationSupported: boolean;
  }[];
  unsupportedStacks: readonly {
    extension: string;
    language: string;
    count: number;
    examples: readonly string[];
  }[];
  degradedRustTools: readonly {
    adapter: string;
    tool: string;
    failureMessage?: string;
  }[];
  diagnosticCount: number;
  validationStatus: ValidationResultStatus;
  failedChecks: readonly string[];
  graphState: GraphProviderStatusState;
  activationLevel: "ready" | "degraded" | "blocked";
}

export type { OpcoreInitScanSummary };

interface OpcoreInitLanguageSetting {
  language: string;
  files: number;
  state: "supported" | "retained" | "unsupported" | "degraded";
  graph: "supported" | "unsupported";
  validation: "supported" | "retained" | "unsupported" | "degraded";
  checks: readonly string[];
  notes: readonly string[];
}

export type { OpcoreInitLanguageSetting };

interface OpcoreInitPythonEnvironment {
  dependencyManagers: readonly {
    kind: "pyproject" | "requirements" | "pipfile" | "poetry" | "uv";
    path: string;
  }[];
  virtualEnvironments: readonly {
    kind: "venv";
    path: string;
  }[];
  notes: readonly string[];
  contexts?: readonly PythonProjectContext[];
}

export type { OpcoreInitPythonEnvironment };

interface OpcoreInitSettings {
  languages: readonly OpcoreInitLanguageSetting[];
  python?: OpcoreInitPythonEnvironment;
}

export type { OpcoreInitSettings };

interface OpcoreInitInteraction {
  tty: boolean;
  promptState: "not_requested" | "requested" | "approved" | "declined";
}

export type { OpcoreInitInteraction };

interface OpcoreInitTiming {
  scanMs: number;
  planMs: number;
  promptMs: number;
  applyMs: number;
  totalMs: number;
  firstOutputMs: number;
}

export type { OpcoreInitTiming };

interface OpcoreInitPlanPayload {
  schemaVersion: 1;
  mode: "plan" | "apply" | "undo";
  approved: boolean;
  repo: {
    root: string;
    requestedPath: string;
  };
  options: {
    scope: OpcoreInitScope;
    failClosedHook: boolean;
    dryRun: boolean;
  };
  agentFiles: readonly string[];
  actions: readonly OpcoreInitAction[];
  warnings: readonly string[];
  nextActions: readonly string[];
  undoAvailable: boolean;
  scan: OpcoreInitScanSummary;
  settings: OpcoreInitSettings;
  interaction: OpcoreInitInteraction;
  timings: OpcoreInitTiming;
}

export type { OpcoreInitPlanPayload };
