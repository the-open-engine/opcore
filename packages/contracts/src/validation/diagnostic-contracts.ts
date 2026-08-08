import type { PythonPytestValidationCapabilityRun } from "./capability-contracts.js";
import type {
  PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID,
  PythonProjectExecutableSource,
} from "./python-project-contracts-01.js";
import type { PythonTypesValidationCapabilityRun } from "./python-project-contracts-02.js";
import type { ValidationScopeKind } from "./request-contracts.js";
import type {
  ValidationCheckOutcome,
  ValidationCheckRunStatus,
  ValidationDiagnosticCategory,
} from "./vocabulary-01.js";
import type {
  PythonValidationCapabilityState,
  PythonValidationCapabilityTermination,
  ValidationSkippedCheckReason,
} from "./vocabulary-02.js";

interface ValidationDiagnostic {
  category: ValidationDiagnosticCategory;
  message: string;
  path?: string;
  severity: "info" | "warning" | "error";
  code?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  tool?: ValidationDiagnosticToolProvenance;
}

export type { ValidationDiagnostic };

interface ValidationDiagnosticToolProvenance {
  name: string;
  command: string;
  version?: string;
  source?: string;
  cwd?: string;
}

export type { ValidationDiagnosticToolProvenance };

interface ValidationCheckManifestEntry {
  checkId: string;
  owner: string;
  adapter: string;
  defaultSeverity: ValidationDiagnostic["severity"];
  supportedScopes: readonly ValidationScopeKind[];
  requiresGraph: boolean;
}

export type { ValidationCheckManifestEntry };

interface PythonRuffCapabilityIdentity {
  schemaId: typeof PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID;
  schemaVersion: 1;
  checkId: "python.ruff-lint" | "python.ruff-format";
  capability: "ruff_lint" | "ruff_format";
  state: PythonValidationCapabilityState;
  projectKey?: string;
  contextFingerprint?: string;
  afterStateManifestFingerprint?: string;
  sourcePaths?: readonly string[];
  configPaths?: readonly string[];
  executable?: string;
  command?: string;
}

export type { PythonRuffCapabilityIdentity };

interface PythonRuffCapabilityExecution {
  argv?: readonly string[];
  cwd?: string;
  configPath?: string;
  toolVersion?: string;
  toolSource?: PythonProjectExecutableSource;
  termination?: PythonValidationCapabilityTermination;
  exitCode?: number;
  signal?: string;
  invocations?: readonly PythonValidationCapabilityInvocation[];
  durationMs: number;
  diagnosticCount: number;
  failureMessage?: string;
}

export type { PythonRuffCapabilityExecution };

interface PythonRuffValidationCapabilityRun extends PythonRuffCapabilityIdentity, PythonRuffCapabilityExecution {}

export type { PythonRuffValidationCapabilityRun };

type PythonValidationCapabilityRun =
  | PythonTypesValidationCapabilityRun
  | PythonRuffValidationCapabilityRun
  | PythonPytestValidationCapabilityRun;

export type { PythonValidationCapabilityRun };

interface PythonValidationCapabilityInvocation {
  argv: readonly string[];
  termination: PythonValidationCapabilityTermination;
  exitCode?: number;
  signal?: string;
  durationMs: number;
}

export type { PythonValidationCapabilityInvocation };

interface ValidationCheckRunSummary {
  checkId: string;
  status: ValidationCheckRunStatus;
  outcome?: ValidationCheckOutcome;
  durationMs?: number;
  diagnosticCount?: number;
  failureMessage?: string;
  pythonCapabilityRuns?: readonly PythonValidationCapabilityRun[];
}

export type { ValidationCheckRunSummary };

interface ValidationSkippedCheck {
  checkId: string;
  reason: ValidationSkippedCheckReason;
  message: string;
}

export type { ValidationSkippedCheck };

interface ValidationResultManifest {
  schemaVersion: number;
  checks: readonly string[];
  generatedAt: string;
  entries?: readonly ValidationCheckManifestEntry[];
  durationMs?: number;
  runs?: readonly ValidationCheckRunSummary[];
  skippedChecks?: readonly ValidationSkippedCheck[];
}

export type { ValidationResultManifest };
