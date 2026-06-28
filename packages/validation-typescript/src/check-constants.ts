import type { ValidationScopeKind } from "@the-open-engine/opcore-contracts";
import { validationScopeKinds } from "@the-open-engine/opcore-contracts";

export const typeScriptCheckOwner = "validation";
export const typeScriptCheckAdapter = "typescript";
export const supportedTypeScriptValidationScopes: readonly ValidationScopeKind[] = validationScopeKinds;
export const defaultTypeScriptFunctionMetricThresholds = {
  maxFunctionLines: 80,
  maxComplexity: 10,
  maxParams: 4
} as const;
