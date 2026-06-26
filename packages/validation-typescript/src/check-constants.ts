import type { ValidationScopeKind } from "@the-open-engine/opcore-contracts";
import { validationScopeKinds } from "@the-open-engine/opcore-contracts";

export const typeScriptCheckOwner = "validation";
export const typeScriptCheckAdapter = "typescript";
export const supportedTypeScriptValidationScopes: readonly ValidationScopeKind[] = validationScopeKinds;
