import type {
  PYTHON_PROJECT_CONTEXT_SCHEMA_ID,
  PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID,
  PythonProjectContextOutcome,
  PythonProjectContextReason,
  PythonProjectExecutableSource,
  PythonProjectFileEvidence,
  PythonProjectLayoutKind,
  PythonProjectManagerKind,
  PythonProjectToolKind,
} from "./python-project-contracts-01.js";
import type { PythonValidationAuthority, PythonValidationCapabilityRunStatus } from "./vocabulary-01.js";
import type { PythonValidationAuthoritySource, PythonValidationCapabilityTerminationKind } from "./vocabulary-02.js";

interface PythonProjectManagerEvidence {
  kind: PythonProjectManagerKind;
  configFiles: readonly string[];
  lockFiles: readonly string[];
}

export type { PythonProjectManagerEvidence };

interface PythonProjectExecutableProvenance {
  executable: string;
  argv: readonly string[];
  cwd: string;
  source: PythonProjectExecutableSource;
  version?: string;
  configFile?: string;
}

export type { PythonProjectExecutableProvenance };

interface PythonInterpreterProvenance extends PythonProjectExecutableProvenance {
  version: string;
  implementation: string;
  platform: string;
  architecture: string;
  abi: string;
  soabi: string;
}

export type { PythonInterpreterProvenance };

interface PythonProjectToolProvenance extends PythonProjectExecutableProvenance {
  tool: PythonProjectToolKind;
  available: boolean;
}

export type { PythonProjectToolProvenance };

interface PythonProjectTarget {
  requiresPython?: string;
  version?: string;
  platform?: string;
  implementation?: string;
  conflicts: readonly string[];
}

export type { PythonProjectTarget };

interface PythonProjectLayoutEvidence {
  kinds: readonly PythonProjectLayoutKind[];
  paths: readonly string[];
}

export type { PythonProjectLayoutEvidence };

interface PythonProjectBuildSystem {
  configFile: string;
  backend?: string;
  requires: readonly string[];
}

export type { PythonProjectBuildSystem };

interface PythonProjectContext {
  schemaId: typeof PYTHON_PROJECT_CONTEXT_SCHEMA_ID;
  schemaVersion: 1;
  target: string;
  repositoryRoot: string;
  projectRoot: string;
  projectBoundary: string;
  sourceRoots: readonly string[];
  layout: PythonProjectLayoutEvidence;
  evidence: readonly PythonProjectFileEvidence[];
  targetRuntime: PythonProjectTarget;
  managers: readonly PythonProjectManagerEvidence[];
  buildSystem?: PythonProjectBuildSystem;
  interpreter?: PythonInterpreterProvenance;
  tools: readonly PythonProjectToolProvenance[];
  projectKey: string;
  contextFingerprint: string;
  outcome: PythonProjectContextOutcome;
  reasons: readonly PythonProjectContextReason[];
}

export type { PythonProjectContext };

interface PythonValidationCapabilityToolProvenance {
  name: PythonValidationAuthority;
  /** Portable executable locator: repo:, project:, path:, or external:. */
  executable: string;
  argv: readonly string[];
  cwd: string;
  source: PythonProjectExecutableSource;
  version?: string;
  configFile?: string;
}

export type { PythonValidationCapabilityToolProvenance };

interface PythonValidationCapabilityExecution {
  termination: PythonValidationCapabilityTerminationKind;
  exitCode?: number;
  signal?: string;
  failureSummary?: string;
}

export type { PythonValidationCapabilityExecution };

interface PythonTypesCapabilityIdentity {
  schemaId: typeof PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID;
  schemaVersion: 1;
  capability: "types";
  checkId: "python.types";
  projectKey: string;
  contextFingerprint: string;
  projectRoot: string;
  targets: readonly string[];
  selectedSourcePaths: readonly string[];
  selectedConfigPaths: readonly string[];
  afterStateManifestFingerprint: string;
  authority?: PythonValidationAuthority;
  authoritySource?: PythonValidationAuthoritySource;
}

export type { PythonTypesCapabilityIdentity };

interface PythonTypesCapabilityOutcome {
  status: PythonValidationCapabilityRunStatus;
  tool?: PythonValidationCapabilityToolProvenance;
  execution?: PythonValidationCapabilityExecution;
  durationMs: number;
  diagnosticCount: number;
  errorCount: number;
  warningCount: number;
  noteCount: number;
}

export type { PythonTypesCapabilityOutcome };

/** Portable, source-free evidence for one attempted Python capability in one canonical project. */
interface PythonTypesValidationCapabilityRun extends PythonTypesCapabilityIdentity, PythonTypesCapabilityOutcome {}

export type { PythonTypesValidationCapabilityRun };
