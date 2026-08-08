import type { GraphProviderStatus } from "../graph/provider-contracts-02.js";
import type { GraphProviderMode, GraphProviderStatusState } from "../graph/vocabulary-01.js";
import type { PythonProjectContext } from "../validation/python-project-contracts-02.js";
import type { ValidationAdapterRuntimeState } from "../validation/status-contracts.js";

interface OpcoreRepoStatePayload {
  schemaVersion: 1;
  repo: {
    root: string;
    requestedPath: string;
    git: {
      available: boolean;
      branch?: string;
      changed?: number;
      staged?: number;
      unstaged?: number;
      untracked?: number;
      conflicted?: number;
      clean?: boolean;
    };
  };
  coverage: {
    totalFiles: number;
    languages: readonly {
      language: string;
      files: number;
      graphSupported: boolean;
      validationSupported: boolean;
    }[];
    graph: {
      supportedFiles: number;
      extensions: readonly {
        extension: string;
        count: number;
      }[];
    };
    validation: {
      supportedFiles: number;
      retainedFiles: number;
      extensions: readonly {
        extension: string;
        count: number;
      }[];
    };
    unsupported: {
      totalFiles: number;
      stacks: readonly {
        extension: string;
        language: string;
        count: number;
        examples: readonly string[];
      }[];
    };
  };
  graph: {
    state: GraphProviderStatusState;
    mode: GraphProviderMode;
    provider: string;
    action: string;
    message?: string;
    status: GraphProviderStatus;
  };
  validation: {
    ready: boolean;
    checkCount: number;
    policy: OpcoreValidationPolicySummary;
    adapters: readonly {
      adapter: string;
      status: ValidationAdapterRuntimeState;
      checkCount: number;
      degradedChecks: readonly string[];
      missingTools: readonly string[];
    }[];
    degradedToolchains: readonly {
      adapter: string;
      tool: string;
      failureMessage?: string;
    }[];
    pythonProjectContexts?: readonly PythonProjectContext[];
  };
  activation: {
    ready: boolean;
    level: "ready" | "degraded" | "blocked";
    summary: string;
    asp: {
      state: "enrolled" | "not_enrolled";
      paths: readonly string[];
    };
  };
  warnings: readonly string[];
  blockers: readonly string[];
  nextActions: readonly string[];
}

export type { OpcoreRepoStatePayload };

interface OpcoreValidationPolicySummary {
  path: ".opcore/config";
  state: "missing" | "loaded";
  adapters: readonly string[];
  packs: readonly string[];
  disabledChecks: readonly string[];
  defaultChecks: readonly string[];
  configuredChecks: readonly string[];
}

export type { OpcoreValidationPolicySummary };

const opcoreRuntimeArtifactSources = ["source_checkout", "installed_package", "unknown"] as const;

export { opcoreRuntimeArtifactSources };

type OpcoreRuntimeArtifactSource = (typeof opcoreRuntimeArtifactSources)[number];

export type { OpcoreRuntimeArtifactSource };

interface OpcoreRuntimeInfoPayload {
  schemaVersion: 1;
  packageName: "opcore";
  version: string;
  bin: "opcore";
  artifactSource: OpcoreRuntimeArtifactSource;
  packageRoot: string;
  entrypoint: string;
}

export type { OpcoreRuntimeInfoPayload };

interface OpcoreDoctorPayload {
  schemaVersion: 1;
  runtime: OpcoreRuntimeInfoPayload;
  repo: {
    root: string;
    requestedPath: string;
  };
  config: {
    path: ".opcore/config";
    state: "found" | "missing" | "unreadable";
    message?: string;
  };
  checks: {
    count: number;
    ids: readonly string[];
  };
  policy: OpcoreValidationPolicySummary;
  graph: GraphProviderStatus;
  generatedState: {
    ignored: readonly string[];
    guidance: string;
  };
  nextActions: readonly string[];
}

export type { OpcoreDoctorPayload };
