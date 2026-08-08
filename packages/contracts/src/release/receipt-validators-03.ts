import { validateReleaseReceiptReportId } from "../managed/helper-validators.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateExactStringSet,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateSha256,
  validateStringArray,
} from "../shared/validators-01.js";
import type { ReleaseReceiptGraphReleaseEvidence, ReleaseReceiptReport } from "./receipt-contracts-01.js";
import type { ReleaseReceiptPackageName} from "./vocabulary-01.js";
import { releaseReceiptReportIds } from "./vocabulary-01.js";

function validateReleaseReceiptReports(reports: readonly ReleaseReceiptReport[]): void {
  validateNonEmptyArray(reports, "Release receipt reports");
  validateExactStringSet(
    reports.map((entry) => entry.id),
    releaseReceiptReportIds,
    "Release receipt reports",
  );
  for (const report of reports) {
    validateReleaseReceiptReportId(report.id, "Release receipt report id");
    validateStringArray(report.command, "Release receipt report command", {
      allowEmpty: false,
    });
    if (report.status !== "passed") throw new Error("Release receipt report status must be passed");
    if (report.exitCode !== 0) throw new Error("Release receipt report exitCode must be 0");
    if (report.path !== undefined) validateRepoRelativePath(report.path);
    if (report.checksumSha256 !== undefined)
      validateSha256(report.checksumSha256, "Release receipt report checksumSha256");
    validateNonEmptyString(report.summary, "Release receipt report summary");
  }
}

export { validateReleaseReceiptReports };

function validateReleaseReceiptGraphReleaseEvidence(evidence: ReleaseReceiptGraphReleaseEvidence): void {
  if (!evidence || typeof evidence !== "object") throw new Error("Release receipt graph release evidence is required");
  validateRepoRelativePath(evidence.path);
  if (evidence.issue !== "#17") throw new Error("Release receipt graph release evidence issue must be #17");
  validateSha256(evidence.checksumSha256, "Release receipt graph release checksumSha256");
}

export { validateReleaseReceiptGraphReleaseEvidence };

function validateReleaseReceiptBins(
  bins: Readonly<Record<string, string>>,
  packageName: ReleaseReceiptPackageName,
): void {
  if (!bins || typeof bins !== "object" || Array.isArray(bins))
    throw new Error("Release receipt bins must be an object");
  const binNames = Object.keys(bins);
  for (const bin of binNames) {
    validateNonEmptyString(bin, "Release receipt bin name");
    validateRepoRelativePath(bins[bin]);
  }
  if (packageName === "opcore") {
    validateExactStringSet(binNames, ["opcore", "opcore-asp-provider"], "Release receipt Opcore package bins");
  } else if (binNames.length > 0) {
    throw new Error(`${packageName} must not expose CLI bins`);
  }
}

export { validateReleaseReceiptBins };
