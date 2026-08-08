import { graphCoreNativePackageNames } from "./graph-vocabulary-02.js";

const releaseReceiptPackageNames = ["opcore"] as const;

export { releaseReceiptPackageNames };

type ReleaseReceiptPackageName = (typeof releaseReceiptPackageNames)[number];

export type { ReleaseReceiptPackageName };

const releaseReceiptBundledPackageNames = [
  "@the-open-engine/opcore-asp-provider",
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-clone",
  "@the-open-engine/opcore-validation-docs",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  ...graphCoreNativePackageNames,
] as const;

export { releaseReceiptBundledPackageNames };

const releaseReceiptCommandGroups = ["graph", "inspect", "edit", "check", "validate", "status", "doctor"] as const;

export { releaseReceiptCommandGroups };

type ReleaseReceiptCommandGroupName = (typeof releaseReceiptCommandGroups)[number];

export type { ReleaseReceiptCommandGroupName };

const releaseReceiptReportIds = [
  "package-inspection",
  "license",
  "provenance",
  "release-hygiene",
  "graph-release",
  "secret-history",
] as const;

export { releaseReceiptReportIds };

type ReleaseReceiptReportId = (typeof releaseReceiptReportIds)[number];

export type { ReleaseReceiptReportId };

const releaseReceiptSecretFindingScopes = ["current-tree", "git-history"] as const;

export { releaseReceiptSecretFindingScopes };

type ReleaseReceiptSecretFindingScope = (typeof releaseReceiptSecretFindingScopes)[number];

export type { ReleaseReceiptSecretFindingScope };

const releaseCutoverRequiredCommandIds = [
  "opcore-scan",
  "opcore-status",
  "opcore-check-changed",
  "opcore-measure",
  "opcore-try",
  "status",
  "doctor",
  "graph-build",
  "graph-status",
  "graph-query",
  "graph-impact",
  "graph-review-context",
  "graph-detect-changes",
  "graph-search",
  "graph-serve",
  "inspect-symbols",
  "inspect-definition",
  "inspect-references",
  "inspect-signature",
  "inspect-implementations",
  "inspect-search",
  "edit-preview",
  "edit-apply",
  "edit-refused",
  "check-files",
  "validate-request",
  "validate-pre-write-pass",
  "validate-pre-write-fail",
] as const;

export { releaseCutoverRequiredCommandIds };

type ReleaseCutoverCommandId = (typeof releaseCutoverRequiredCommandIds)[number];

export type { ReleaseCutoverCommandId };

const releaseCutoverRustCommandIds = [
  "graph-rust-build",
  "graph-rust-status",
  "graph-rust-query",
  "graph-rust-impact",
  "graph-rust-review-context",
  "graph-rust-detect-changes",
  "graph-rust-search",
] as const;

export { releaseCutoverRustCommandIds };

type ReleaseCutoverRustCommandId = (typeof releaseCutoverRustCommandIds)[number];

export type { ReleaseCutoverRustCommandId };

const releaseCutoverPythonCommandIds = [
  "opcore-python-scan",
  "opcore-python-status",
  "opcore-python-check-changed",
  "opcore-python-measure",
  "graph-python-build",
  "graph-python-status",
  "graph-python-query",
  "graph-python-search",
] as const;

export { releaseCutoverPythonCommandIds };

type ReleaseCutoverPythonCommandId = (typeof releaseCutoverPythonCommandIds)[number];

export type { ReleaseCutoverPythonCommandId };

const releaseCutoverNegativeCheckIds = [
  "missing-required-graph-check",
  "missing-required-graph-validate",
  "python-types-degraded-no-tools",
  "python-source-hygiene-no-ruff",
  "python-relevant-tests-no-pytest",
  "python-toolchain-degraded-no-tools",
] as const;

export { releaseCutoverNegativeCheckIds };
