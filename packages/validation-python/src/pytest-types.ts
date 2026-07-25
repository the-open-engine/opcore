import type {
  PythonCapabilityCounts,
  PythonCapabilityInvocation,
  PythonProjectContext,
  PythonPytestValidationCapabilityRun,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";

export type PytestRunOutcome = "passed" | "findings" | "tool_failure" | "timeout" | "invalid_config";

export interface ProjectRunInput {
  context: PythonProjectContext;
  candidatePaths: readonly string[];
}

export interface CleanupState {
  attempted: boolean;
  ok: boolean;
  failureMessages: string[];
}

export interface HookEvent {
  type: "collected" | "collect_error" | "test_report";
  nodeid?: string;
  when?: "setup" | "call" | "teardown";
  outcome?: "passed" | "failed" | "skipped";
  wasxfail?: string;
  message?: string;
}

export interface HookReport {
  events: readonly HookEvent[];
  exitStatus: number;
}

export interface ExecutionEventAnalysis {
  counts: PythonCapabilityCounts;
  diagnostics: ValidationDiagnostic[];
}

export interface ProjectRunResult {
  outcome: PytestRunOutcome;
  diagnostics: ValidationDiagnostic[];
  capabilityRun: PythonPytestValidationCapabilityRun;
}

export interface CollectionRunResult {
  outcome: PytestRunOutcome;
  message: string;
  nodeIds: readonly string[];
  counts: PythonCapabilityCounts;
  invocation: PythonCapabilityInvocation;
  selectionMode: "direct_argv";
  selectionDigest: string;
}

export interface ExecutionRunResult {
  outcome: Exclude<PytestRunOutcome, "invalid_config">;
  message: string;
  diagnostics: ValidationDiagnostic[];
  counts: PythonCapabilityCounts;
  invocation: PythonCapabilityInvocation;
  selectionMode: "direct_argv" | "manifest";
  selectionDigest: string;
}
