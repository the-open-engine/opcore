import type {
  PythonProjectToolProvenance,
  PythonValidationAuthority,
  PythonValidationAuthoritySource,
  PythonTypesValidationCapabilityRun,
  PythonValidationCapabilityToolProvenance,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type {
  MaterializedPythonTypeWorkspace,
  PythonTypeCapabilityPreparation
} from "./type-capability-run.js";

export interface TypeCapabilityResult {
  run: PythonTypesValidationCapabilityRun;
  diagnostics: readonly ValidationDiagnostic[];
  failureMessage?: string;
}

export interface TypeCapabilityArgs {
  preparation: PythonTypeCapabilityPreparation;
  checker: PythonProjectToolProvenance;
  authority: PythonValidationAuthority;
  authoritySource: PythonValidationAuthoritySource;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
}

export interface TypeExecutionContext {
  args: TypeCapabilityArgs;
  workspace: MaterializedPythonTypeWorkspace;
  tool: PythonValidationCapabilityToolProvenance;
  startedAt: number;
}
