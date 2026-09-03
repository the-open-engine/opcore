import type { DocsPolicyOptions } from "./snapshot.js";

export interface DocsHistoryOptions {
  now?: string | Date;
  maxStaleDays?: number;
}

export interface DocsHubCoverageOptions {
  minFanIn?: number;
  minFanOut?: number;
  requireExplicitMention?: boolean;
}

export interface DocsSubtreeCoverageOptions {
  minLoc?: number;
}

export interface CreateDocsValidationChecksOptions extends DocsPolicyOptions {
  history?: DocsHistoryOptions;
  hubCoverage?: DocsHubCoverageOptions;
  subtreeCoverage?: DocsSubtreeCoverageOptions;
}
