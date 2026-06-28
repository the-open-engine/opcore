import type { ValidationScopeKind } from "@the-open-engine/opcore-contracts";
import { validationScopeKinds } from "@the-open-engine/opcore-contracts";

export const cloneCheckOwner = "validation";
export const cloneCheckAdapter = "clone";
export const validationCloneAdapterName = cloneCheckAdapter;
export const supportedCloneValidationScopes: readonly ValidationScopeKind[] = validationScopeKinds;
