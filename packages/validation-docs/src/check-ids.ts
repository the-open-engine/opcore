export const DOCS_EXISTENCE_CHECK_ID = "docs.existence";
export const DOCS_STALENESS_CHECK_ID = "docs.staleness";
export const DOCS_FRESHNESS_CHECK_ID = "docs.freshness";
export const DOCS_LENGTH_CHECK_ID = "docs.length";
export const DOCS_DRY_CHECK_ID = "docs.dry";
export const DOCS_CONTENT_QUALITY_CHECK_ID = "docs.content-quality";
export const DOCS_CODE_BLOCKS_CHECK_ID = "docs.code-blocks";
export const DOCS_RULES_WHY_CHECK_ID = "docs.rules-why";
export const DOCS_HUB_COVERAGE_CHECK_ID = "docs.hub-coverage";
export const DOCS_SUBTREE_COVERAGE_CHECK_ID = "docs.subtree-coverage";

export const docsValidationCheckIds = [
  DOCS_EXISTENCE_CHECK_ID,
  DOCS_STALENESS_CHECK_ID,
  DOCS_FRESHNESS_CHECK_ID,
  DOCS_LENGTH_CHECK_ID,
  DOCS_DRY_CHECK_ID,
  DOCS_CONTENT_QUALITY_CHECK_ID,
  DOCS_CODE_BLOCKS_CHECK_ID,
  DOCS_RULES_WHY_CHECK_ID,
  DOCS_HUB_COVERAGE_CHECK_ID,
  DOCS_SUBTREE_COVERAGE_CHECK_ID
] as const;

export type DocsValidationCheckId = (typeof docsValidationCheckIds)[number];
