import type { ValidationScopeKind } from "@the-open-engine/lattice-contracts";
import { validationScopeKinds } from "@the-open-engine/lattice-contracts";

export const rustCheckOwner = "validation";
export const rustCheckAdapter = "rust";
export const validationRustAdapterName = rustCheckAdapter;
export const supportedRustValidationScopes: readonly ValidationScopeKind[] = validationScopeKinds;

export const ownedClippyLints = [
  "clippy::unwrap_used",
  "clippy::expect_used",
  "clippy::panic",
  "clippy::todo",
  "clippy::unimplemented",
  "clippy::unreachable",
  "clippy::indexing_slicing",
  "clippy::cast_possible_truncation",
  "clippy::cast_sign_loss",
  "unused_imports"
] as const;

export const defaultRustFunctionMetricThresholds = {
  maxFunctionLines: 80,
  maxComplexity: 10,
  maxParams: 4
} as const;

export const defaultRustFileLengthThresholds = {
  maxFileLines: 500
} as const;
