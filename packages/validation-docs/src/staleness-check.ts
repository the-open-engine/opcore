import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition,
  ValidationCheckResult
} from "@the-open-engine/opcore-validation";
import {
  defaultDocsHistoryThresholds,
  supportedDocsValidationScopes
} from "./check-constants.js";
import { DOCS_STALENESS_CHECK_ID } from "./check-ids.js";
import { docsCheck } from "./check-definition.js";
import {
  skippedDocsResult,
  skippedHistoryUnavailableResult
} from "./check-results.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { assertGitHistoryAvailable, latestCommitIso } from "./history.js";
import type {
  CreateDocsValidationChecksOptions,
  DocsHistoryOptions
} from "./options.js";
import { materializeDocsSnapshot } from "./snapshot.js";

export function createDocsStalenessCheck(
  options: CreateDocsValidationChecksOptions = {}
): ValidationCheckDefinition {
  return docsCheck(
    DOCS_STALENESS_CHECK_ID,
    "warning",
    supportedDocsValidationScopes,
    async (context) => runStalenessCheck(context, options)
  );
}

async function runStalenessCheck(
  context: ValidationCheckContext,
  options: CreateDocsValidationChecksOptions
): Promise<ValidationCheckResult> {
  const skipped = await skippedHistoryResult(context, options);
  if (skipped !== undefined) return skipped;
  const snapshot = await materializeDocsSnapshot(context, options);
  if (snapshot.docs.length === 0) {
    return skippedDocsResult("No documentation files were selected.");
  }
  const repoRoot = context.request.repo.repoRoot;
  if (repoRoot === undefined) {
    return skippedHistoryUnavailableResult(
      "Git history is unavailable: request.repo.repoRoot is missing."
    );
  }
  const now = historyNow(options.history);
  const maxStaleDays =
    options.history?.maxStaleDays ??
    defaultDocsHistoryThresholds.maxStaleDays;
  const diagnostics: ValidationDiagnostic[] = [];
  for (const doc of snapshot.docs) {
    const committed = latestCommitIso(repoRoot, doc.path);
    if (!committed.ok) {
      return skippedHistoryUnavailableResult(committed.message);
    }
    if (committed.value === undefined) continue;
    const ageDays = elapsedDays(committed.value, now);
    if (ageDays <= maxStaleDays) continue;
    diagnostics.push(
      diagnostic({
        severity: "warning",
        path: doc.path,
        code: "DOCS_STALE",
        message:
          `Documentation was last committed ${Math.floor(ageDays)} days ago, ` +
          `over the ${maxStaleDays}-day staleness threshold.`
      })
    );
  }
  return { diagnostics: sortDiagnostics(diagnostics) };
}

async function skippedHistoryResult(
  context: ValidationCheckContext,
  options: CreateDocsValidationChecksOptions
): Promise<ValidationCheckResult | undefined> {
  const snapshot = await materializeDocsSnapshot(context, options);
  if (snapshot.hasOverlays) {
    return skippedDocsResult(
      "Documentation Git-history checks require committed state and skip when overlays are present."
    );
  }
  const repoRoot = context.request.repo.repoRoot;
  if (repoRoot === undefined) {
    return skippedHistoryUnavailableResult(
      "Git history is unavailable: request.repo.repoRoot is missing."
    );
  }
  const available = assertGitHistoryAvailable(repoRoot);
  return available.ok
    ? undefined
    : skippedHistoryUnavailableResult(available.message);
}

function historyNow(options: DocsHistoryOptions | undefined): Date {
  if (options?.now instanceof Date) return options.now;
  if (typeof options?.now === "string") return new Date(options.now);
  return new Date();
}

function elapsedDays(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / (24 * 60 * 60 * 1000);
}
