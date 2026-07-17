import type {
  PythonProjectToolProvenance,
  PythonValidationCapabilityRun,
  PythonValidationCapabilityToolProvenance,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type {
  MaterializedPythonTypeWorkspace,
  PythonTypeCapabilityPreparation
} from "./type-capability-run.js";

export interface MypyCapabilityResult {
  run: PythonValidationCapabilityRun;
  diagnostics: readonly ValidationDiagnostic[];
  failureMessage?: string;
}

export interface MypyCapabilityArgs {
  preparation: PythonTypeCapabilityPreparation;
  checker: PythonProjectToolProvenance;
  authoritySource: "explicit" | "project_config";
  env?: Record<string, string | undefined>;
  timeoutMs: number;
}

export interface MypyExecutionContext {
  args: MypyCapabilityArgs;
  workspace: MaterializedPythonTypeWorkspace;
  tool: PythonValidationCapabilityToolProvenance;
  startedAt: number;
}
