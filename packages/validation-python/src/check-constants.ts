import type { ValidationScopeKind } from "@the-open-engine/opcore-contracts";
import { validationScopeKinds } from "@the-open-engine/opcore-contracts";

export const pythonCheckOwner = "validation";
export const pythonCheckAdapter = "python";
export const validationPythonAdapterName = pythonCheckAdapter;
export const supportedPythonValidationScopes: readonly ValidationScopeKind[] = validationScopeKinds;
