import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition,
  ValidationCheckResult
} from "@the-open-engine/opcore-validation";
import {
  docsCheckAdapter,
  docsCheckOwner,
  optInDocsDefaultScopes
} from "./check-constants.js";

type DocsCheckRunner = (
  context: ValidationCheckContext
) => Promise<ValidationCheckResult> | ValidationCheckResult;

export function docsCheck(
  id: string,
  defaultSeverity: ValidationDiagnostic["severity"],
  supportedScopes: readonly ValidationCheckDefinition["supportedScopes"][number][],
  run: DocsCheckRunner
): ValidationCheckDefinition {
  return {
    id,
    owner: docsCheckOwner,
    adapter: docsCheckAdapter,
    defaultSeverity,
    supportedScopes,
    defaultScopes: optInDocsDefaultScopes,
    requiresGraph: false,
    run
  };
}
