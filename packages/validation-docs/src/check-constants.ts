import type { ValidationScopeKind } from "@the-open-engine/opcore-contracts";
import { validationScopeKinds } from "@the-open-engine/opcore-contracts";

export const docsCheckOwner = "validation";
export const docsCheckAdapter = "docs";
export const validationDocsAdapterName = docsCheckAdapter;
export const supportedDocsValidationScopes: readonly ValidationScopeKind[] = validationScopeKinds;
export const repoWideDocsValidationScopes: readonly ValidationScopeKind[] = ["all", "repo", "package"];
export const optInDocsDefaultScopes: readonly ValidationScopeKind[] = [];

export const defaultDocsHistoryThresholds = {
  maxStaleDays: 90
} as const;

export const defaultDocsHubCoverageThresholds = {
  minFanIn: 2
} as const;
