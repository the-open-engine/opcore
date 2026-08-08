import { validateExactValue, validateOptional, validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateRepoRelativePaths } from "../shared/path-validators.js";
import { CLONE_PROTOCOL } from "../graph/vocabulary-01.js";
import { validateRepoIdentity, validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStringArray,
} from "../shared/validators-01.js";
import type {
  CloneAnalysisRequest,
  CloneAnalysisResult,
  CloneAnalysisSummary,
  CloneFinding,
  CloneReportMode,
  CloneSourceReadMode} from "../validation/request-contracts.js";
import {
  cloneReportModes,
  cloneSourceReadModes,
} from "../validation/request-contracts.js";
import { validateHypotheticalOverlays } from "../validation/request-validators-01.js";

function validateCloneAnalysisRequest(request: CloneAnalysisRequest): CloneAnalysisRequest {
  validateRequiredObject(request, "Clone analysis request is required");
  validateExactValue(
    request.protocol,
    CLONE_PROTOCOL,
    `Clone analysis request protocol must be ${CLONE_PROTOCOL}`,
  );
  validateOptional(request.requestId, (value) =>
    validateNonEmptyString(value, "Clone analysis request requestId"),
  );
  validateExactValue(request.schemaVersion, 1, "Clone analysis request schemaVersion must be 1");
  validateRepoIdentity(request.repo);
  validateCloneReportMode(request.reportMode, "Clone analysis request reportMode");
  validateOptional(request.paths, (value) => validateRepoRelativePaths(value, "Clone analysis request paths"));
  validateOptional(request.sourcePaths, (value) =>
    validateRepoRelativePaths(value, "Clone analysis request sourcePaths"),
  );
  validateOptional(request.sourceReadMode, (value) =>
    validateCloneSourceReadMode(value, "Clone analysis request sourceReadMode"),
  );
  validateOptional(request.sourceTreeRef, (value) =>
    validateNonEmptyString(value, "Clone analysis request sourceTreeRef"),
  );
  validateHypotheticalOverlays(request.overlays);
  validateOptional(request.windowSize, (value) =>
    validatePositiveInteger(value, "Clone analysis request windowSize"),
  );
  validateOptional(request.minLines, (value) =>
    validatePositiveInteger(value, "Clone analysis request minLines"),
  );
  validateOptional(request.minTokens, (value) =>
    validatePositiveInteger(value, "Clone analysis request minTokens"),
  );
  validateOptional(request.threshold, (value) =>
    validatePositiveInteger(value, "Clone analysis request threshold"),
  );
  validateOptional(request.partitions, validateCloneAnalysisPartitions);
  validateOptional(request.exclude, (value) =>
    validateStringArray(value, "Clone analysis request exclude", {
      allowEmpty: true,
    }),
  );
  validateOptional(request.modes, (value) =>
    validateStringArray(value, "Clone analysis request modes", {
      allowEmpty: true,
    }),
  );
  return request;
}

export { validateCloneAnalysisRequest };

function validateCloneSourceReadMode(value: unknown, label: string): asserts value is CloneSourceReadMode {
  if (!cloneSourceReadModes.includes(value as CloneSourceReadMode)) {
    throw new Error(`${label} must be one of ${cloneSourceReadModes.join(", ")}`);
  }
}

export { validateCloneSourceReadMode };

function validateCloneAnalysisPartitions(partitions: readonly (readonly string[])[]): void {
  if (!Array.isArray(partitions)) throw new Error("Clone analysis request partitions must be an array");
  for (const [index, partition] of partitions.entries()) {
    validateStringArray(partition, `Clone analysis request partitions[${index}]`, { allowEmpty: false });
  }
}

export { validateCloneAnalysisPartitions };

function validateCloneAnalysisResult(result: CloneAnalysisResult): CloneAnalysisResult {
  validateRequiredObject(result, "Clone analysis result is required");
  if (result.protocol !== CLONE_PROTOCOL) {
    throw new Error(`Clone analysis result protocol must be ${CLONE_PROTOCOL}`);
  }
  if (result.requestId !== undefined) validateNonEmptyString(result.requestId, "Clone analysis result requestId");
  if (result.schemaVersion !== 1) {
    throw new Error("Clone analysis result schemaVersion must be 1");
  }
  validateRepoIdentity(result.repo);
  validateCloneReportMode(result.reportMode, "Clone analysis result reportMode");
  if (result.status !== "passed") {
    throw new Error("Clone analysis result status must be passed");
  }
  if (typeof result.persisted !== "boolean") {
    throw new Error("Clone analysis result persisted must be boolean");
  }
  if (result.dbPath !== undefined) validateRepoRelativePath(result.dbPath);
  if (!Array.isArray(result.findings)) {
    throw new Error("Clone analysis result findings must be an array");
  }
  for (const finding of result.findings) validateCloneFinding(finding);
  validateCloneAnalysisSummary(result.summary, result.findings.length);
  return result;
}

export { validateCloneAnalysisResult };

function validateCloneReportMode(mode: unknown, label: string): CloneReportMode {
  if (!includesString(cloneReportModes, mode)) {
    throw new Error(`Unknown ${label}: ${String(mode)}`);
  }
  return mode;
}

export { validateCloneReportMode };

function validateCloneFinding(finding: CloneFinding): CloneFinding {
  validateRequiredObject(finding, "Clone finding is required");
  for (const forbidden of ["line", "column", "startLine", "endLine", "startColumn", "endColumn"]) {
    if (Object.hasOwn(finding, forbidden)) {
      throw new Error("Clone finding identity must stay line-free");
    }
  }
  validateCloneClassId(finding.cloneClassId, "Clone finding cloneClassId");
  validateSha256Hex(finding.contentHash, "Clone finding contentHash");
  const path = validateRepoRelativePath(finding.path);
  const peerPath = validateRepoRelativePath(finding.peerPath);
  if (path === peerPath) {
    throw new Error("Clone finding path and peerPath must be distinct");
  }
  validateRepoRelativePaths(finding.paths, "Clone finding paths");
  if (!finding.paths.includes(path) || !finding.paths.includes(peerPath)) {
    throw new Error("Clone finding paths must include path and peerPath");
  }
  validatePositiveInteger(finding.lineCount, "Clone finding lineCount");
  validatePositiveInteger(finding.tokenCount, "Clone finding tokenCount");
  if (typeof finding.introduced !== "boolean") {
    throw new Error("Clone finding introduced must be boolean");
  }
  return finding;
}

export { validateCloneFinding };

function validateCloneAnalysisSummary(summary: CloneAnalysisSummary, findingsLength: number): CloneAnalysisSummary {
  validateRequiredObject(summary, "Clone analysis summary is required");
  validateNonNegativeInteger(summary.analyzedFiles, "Clone analysis summary analyzedFiles");
  validateNonNegativeInteger(summary.cloneClassCount, "Clone analysis summary cloneClassCount");
  validateNonNegativeInteger(summary.findingCount, "Clone analysis summary findingCount");
  validateNonNegativeInteger(summary.overlayCount, "Clone analysis summary overlayCount");
  if (summary.findingCount !== findingsLength) {
    throw new Error("Clone analysis summary findingCount must equal findings length");
  }
  return summary;
}

export { validateCloneAnalysisSummary };

function validateCloneClassId(value: unknown, label: string): string {
  const id = validateNonEmptyString(value, label);
  if (!/^clone-[a-f0-9]{16}$/u.test(id)) {
    throw new Error(`${label} must be a stable clone id`);
  }
  return id;
}

export { validateCloneClassId };

function validateSha256Hex(value: unknown, label: string): string {
  const sha = validateNonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(sha)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return sha;
}

export { validateSha256Hex };
