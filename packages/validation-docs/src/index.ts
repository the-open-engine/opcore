import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import {
  createDocsCodeBlocksCheck,
  createDocsContentQualityCheck,
  createDocsDryCheck,
  createDocsExistenceCheck,
  createDocsFreshnessCheck,
  createDocsHubCoverageCheck,
  createDocsLengthCheck,
  createDocsRulesWhyCheck,
  createDocsStalenessCheck,
  type CreateDocsValidationChecksOptions,
  type DocsHistoryOptions,
  type DocsHubCoverageOptions
} from "./checks.js";

export {
  DOCS_CODE_BLOCKS_CHECK_ID,
  DOCS_CONTENT_QUALITY_CHECK_ID,
  DOCS_DRY_CHECK_ID,
  DOCS_EXISTENCE_CHECK_ID,
  DOCS_FRESHNESS_CHECK_ID,
  DOCS_HUB_COVERAGE_CHECK_ID,
  DOCS_LENGTH_CHECK_ID,
  DOCS_RULES_WHY_CHECK_ID,
  DOCS_STALENESS_CHECK_ID,
  docsValidationCheckIds,
  type DocsValidationCheckId
} from "./check-ids.js";
export { validationDocsAdapterName } from "./check-constants.js";
export {
  createDocsCodeBlocksCheck,
  createDocsContentQualityCheck,
  createDocsDryCheck,
  createDocsExistenceCheck,
  createDocsFreshnessCheck,
  createDocsHubCoverageCheck,
  createDocsLengthCheck,
  createDocsRulesWhyCheck,
  createDocsStalenessCheck,
  type CreateDocsValidationChecksOptions,
  type DocsHistoryOptions,
  type DocsHubCoverageOptions
} from "./checks.js";

export function createDocsValidationChecks(
  options: CreateDocsValidationChecksOptions = {}
): readonly ValidationCheckDefinition[] {
  return [
    createDocsExistenceCheck(options),
    createDocsStalenessCheck(options),
    createDocsFreshnessCheck(options),
    createDocsLengthCheck(options),
    createDocsDryCheck(options),
    createDocsContentQualityCheck(options),
    createDocsCodeBlocksCheck(options),
    createDocsRulesWhyCheck(options),
    createDocsHubCoverageCheck(options)
  ];
}
