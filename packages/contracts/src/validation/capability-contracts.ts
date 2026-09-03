import type { EditRefusal } from "../edit/contracts.js";
import type { GraphProviderStatus } from "../graph/provider-contracts-02.js";
import type {
  PythonValidationCapabilityRun,
  ValidationDiagnostic,
  ValidationResultManifest,
} from "./diagnostic-contracts.js";
import type { PythonProjectContext } from "./python-project-contracts-02.js";
import type { ValidationFailure } from "./request-contracts.js";
import type { ValidationResultStatus } from "./vocabulary-01.js";

const pythonCapabilityActivations = ["enabled", "disabled", "not_applicable"] as const;

export { pythonCapabilityActivations };

type PythonCapabilityActivation = (typeof pythonCapabilityActivations)[number];

export type { PythonCapabilityActivation };

const pythonPytestSelectionModes = ["none", "direct_argv", "manifest"] as const;

export { pythonPytestSelectionModes };

type PythonPytestSelectionMode = (typeof pythonPytestSelectionModes)[number];

export type { PythonPytestSelectionMode };

const pythonCapabilityProcessTerminations = ["exited", "timeout", "signal", "spawn_error", "overflow"] as const;

export { pythonCapabilityProcessTerminations };

type PythonCapabilityProcessTermination = (typeof pythonCapabilityProcessTerminations)[number];

export type { PythonCapabilityProcessTermination };

interface PythonCapabilityCounts {
  candidateCount: number;
  collectedCount: number;
  executedCount: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  xfailedCount: number;
  xpassedCount: number;
  errorCount: number;
}

export type { PythonCapabilityCounts };

interface PythonCapabilityCleanupEvidence {
  attempted: boolean;
  ok: boolean;
  failureMessage?: string;
}

export type { PythonCapabilityCleanupEvidence };

interface PythonCapabilityInvocation {
  stage: "collection" | "execution";
  command: string;
  argsDigest: string;
  argCount: number;
  selectionMode: PythonPytestSelectionMode;
  selectionDigest?: string;
  durationMs: number;
  termination: PythonCapabilityProcessTermination;
  exitCode?: number;
  signal?: string;
  outputBytes: number;
  stdoutDigest?: string;
  stderrDigest?: string;
}

export type { PythonCapabilityInvocation };

interface PythonPytestValidationCapabilityRun {
  capability: "pytest";
  checkId: string;
  activation: PythonCapabilityActivation;
  outcome: string;
  message: string;
  projectKey?: string;
  projectRoot?: string;
  configFile?: string;
  targetCount?: number;
  candidatePaths?: readonly string[];
  collectedNodeIds?: readonly string[];
  afterStateFingerprint?: string;
  selectionMode?: PythonPytestSelectionMode;
  selectionDigest?: string;
  counts?: PythonCapabilityCounts;
  collection?: PythonCapabilityInvocation;
  execution?: PythonCapabilityInvocation;
  cleanup?: PythonCapabilityCleanupEvidence;
}

export type { PythonPytestValidationCapabilityRun };

interface ValidationResult {
  ok: boolean;
  status: ValidationResultStatus;
  diagnostics: readonly ValidationDiagnostic[];
  graphStatus?: GraphProviderStatus;
  failure?: ValidationFailure;
  refusal?: EditRefusal;
  manifest?: ValidationResultManifest;
  pythonProjectContexts?: readonly PythonProjectContext[];
  pythonCapabilityRuns?: readonly PythonValidationCapabilityRun[];
}

export type { ValidationResult };
