import { validateCommandOwner } from "../command/helper-validators.js";
import { includesString } from "../shared/primitives.js";
import {
  validateExactValue,
  validateRequiredObject,
} from "../shared/validators-02.js";
import {
  validateExactStringSequence,
  validateExactStringSet,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateSha256,
  validateStringArray,
} from "../shared/validators-01.js";
import type {
  ReleaseCutoverForbiddenMarkerScan,
  ReleaseCutoverInputEvidence,
  ReleaseCutoverNegativeCheck,
  ReleaseCutoverPythonCommandReceipt,
  ReleaseCutoverRustCommandReceipt,
} from "./cutover-contracts.js";
import type {
  ReleaseCutoverCommandId,
  ReleaseCutoverPythonCommandId,
  ReleaseCutoverRustCommandId} from "./vocabulary-01.js";
import {
  releaseCutoverNegativeCheckIds,
  releaseCutoverPythonCommandIds,
  releaseCutoverRustCommandIds,
} from "./vocabulary-01.js";
import type {
  ReleaseCutoverCommandExpectation} from "./vocabulary-02.js";
import {
  releaseCutoverInputIssues,
  releaseCutoverRequestFilePlaceholder,
} from "./vocabulary-02.js";
import {
  releaseCutoverNegativeCheckExpectations,
  releaseCutoverPythonCommandExpectations,
  releaseCutoverPythonEvidenceExpectations,
  releaseCutoverRustCommandExpectations,
} from "./vocabulary-04.js";

function validateReleaseCutoverRustCommandReceipts(receipts: readonly ReleaseCutoverRustCommandReceipt[]): void {
  validateNonEmptyArray(receipts, "Release cutover Rust command receipts");
  validateExactStringSet(
    receipts.map((entry) => entry.id),
    releaseCutoverRustCommandIds,
    "Release cutover Rust command receipts",
  );
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") throw new Error("Release cutover Rust command receipt is required");
    if (!includesString(releaseCutoverRustCommandIds, receipt.id)) {
      throw new Error(`Unknown release cutover Rust command receipt id: ${String(receipt.id)}`);
    }
    validateStringArray(receipt.command, "Release cutover Rust command receipt command", { allowEmpty: false });
    validateStringArray(receipt.canonicalCommand, "Release cutover Rust command receipt canonicalCommand", {
      allowEmpty: false,
    });
    validateExactStringSequence(
      receipt.command,
      receipt.canonicalCommand,
      `Release cutover Rust ${receipt.id} command`,
    );
    const expected = releaseCutoverRustCommandExpectations[receipt.id];
    validateReleaseCutoverExpectedCommand(receipt.canonicalCommand, expected, receipt.id);
    if (receipt.owner !== "graph") throw new Error(`Release cutover Rust command ${receipt.id} owner must be graph`);
    if (receipt.status !== "ok") throw new Error(`Release cutover Rust command ${receipt.id} status must be ok`);
    if (receipt.exitCode !== 0) throw new Error(`Release cutover Rust command ${receipt.id} exitCode must be 0`);
    validateNonEmptyString(receipt.binPath, "Release cutover Rust command receipt binPath");
    if (!receipt.binPath.endsWith("node_modules/.bin/opcore")) {
      throw new Error("Release cutover Rust command receipt binPath must use installed node_modules/.bin/opcore");
    }
    validateSha256(receipt.stdoutSha256, "Release cutover Rust command receipt stdoutSha256");
    validateSha256(receipt.stderrSha256, "Release cutover Rust command receipt stderrSha256");
    validateNonEmptyString(receipt.assertion, "Release cutover Rust command receipt assertion");
  }
}

export { validateReleaseCutoverRustCommandReceipts };

function validateReleaseCutoverPythonCommandReceipts(receipts: readonly ReleaseCutoverPythonCommandReceipt[]): void {
  validateNonEmptyArray(receipts, "Release cutover Python command receipts");
  validateExactStringSet(
    receipts.map((entry) => entry.id),
    releaseCutoverPythonCommandIds,
    "Release cutover Python command receipts",
  );
  for (const receipt of receipts) validateReleaseCutoverPythonCommandReceipt(receipt);
}

export { validateReleaseCutoverPythonCommandReceipts };

function validateReleaseCutoverPythonCommandReceipt(receipt: ReleaseCutoverPythonCommandReceipt): void {
  validateRequiredObject(receipt, "Release cutover Python command receipt is required");
  if (!includesString(releaseCutoverPythonCommandIds, receipt.id)) {
    throw new Error(`Unknown release cutover Python command receipt id: ${String(receipt.id)}`);
  }
  validateStringArray(receipt.command, "Release cutover Python command receipt command", { allowEmpty: false });
  validateStringArray(receipt.canonicalCommand, "Release cutover Python command receipt canonicalCommand", {
    allowEmpty: false,
  });
  validateStringArray(receipt.evidence, "Release cutover Python command receipt evidence", { allowEmpty: false });
  validateExactStringSequence(
    receipt.command,
    receipt.canonicalCommand,
    `Release cutover Python ${receipt.id} command`,
  );
  const expected = releaseCutoverPythonCommandExpectations[receipt.id];
  validateExactStringSet(
    receipt.evidence,
    releaseCutoverPythonEvidenceExpectations[receipt.id],
    `Release cutover Python command ${receipt.id} evidence`,
  );
  validateExactValue(
    receipt.command[0],
    expected.bin,
    `Release cutover Python command ${receipt.id} command must use canonical ${expected.bin} bin`,
  );
  validateExactValue(
    receipt.canonicalCommand[0],
    expected.bin,
    `Release cutover Python command ${receipt.id} canonicalCommand must use canonical ${expected.bin} bin`,
  );
  validateCommandOwner(receipt.owner);
  validateReleaseCutoverExpectedCommand(receipt.canonicalCommand, expected, receipt.id);
  validateExactValue(
    receipt.owner,
    expected.owner,
    `Release cutover Python command ${receipt.id} owner must match expected ${expected.owner}`,
  );
  validateExactValue(receipt.status, "ok", `Release cutover Python command ${receipt.id} status must be ok`);
  validateExactValue(receipt.exitCode, 0, `Release cutover Python command ${receipt.id} exitCode must be 0`);
  validateNonEmptyString(receipt.binPath, "Release cutover Python command receipt binPath");
  if (!receipt.binPath.endsWith(`node_modules/.bin/${expected.bin}`)) {
    throw new Error(
      `Release cutover Python command receipt binPath must use installed node_modules/.bin/${expected.bin}`,
    );
  }
  validateSha256(receipt.stdoutSha256, "Release cutover Python command receipt stdoutSha256");
  validateSha256(receipt.stderrSha256, "Release cutover Python command receipt stderrSha256");
  validateNonEmptyString(receipt.assertion, "Release cutover Python command receipt assertion");
}

function validateReleaseCutoverExpectedCommand(
  command: readonly string[],
  expectation: ReleaseCutoverCommandExpectation,
  id: ReleaseCutoverCommandId | ReleaseCutoverRustCommandId | ReleaseCutoverPythonCommandId,
): void {
  if (!releaseCutoverCommandMatchesExpectation(command, expectation)) {
    throw new Error(
      `Release cutover command ${id} canonicalCommand must match expected ${formatReleaseCutoverCommand(expectation)}`,
    );
  }
}

export { validateReleaseCutoverExpectedCommand };

function releaseCutoverCommandMatchesExpectation(
  command: readonly string[],
  expectation: ReleaseCutoverCommandExpectation,
): boolean {
  if (command.length !== expectation.canonicalCommand.length) return false;
  return expectation.canonicalCommand.every((expected, index) => {
    const actual = command[index];
    if (expected !== releaseCutoverRequestFilePlaceholder) return actual === expected;
    return releaseCutoverPathBasename(actual) === expectation.requestFileBasename;
  });
}

export { releaseCutoverCommandMatchesExpectation };

function releaseCutoverPathBasename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

export { releaseCutoverPathBasename };

function formatReleaseCutoverCommand(expectation: ReleaseCutoverCommandExpectation): string {
  return expectation.canonicalCommand
    .map((part) => (part === releaseCutoverRequestFilePlaceholder ? `<${expectation.requestFileBasename}>` : part))
    .join(" ");
}

export { formatReleaseCutoverCommand };

function validateReleaseCutoverNegativeChecks(checks: readonly ReleaseCutoverNegativeCheck[]): void {
  validateNonEmptyArray(checks, "Release cutover negative checks");
  validateExactStringSet(
    checks.map((entry) => entry.id),
    releaseCutoverNegativeCheckIds,
    "Release cutover negative checks",
  );
  for (const check of checks) {
    if (!check || typeof check !== "object") throw new Error("Release cutover negative check is required");
    validateNonEmptyString(check.id, "Release cutover negative check id");
    if (!includesString(releaseCutoverNegativeCheckIds, check.id)) {
      throw new Error(`Unknown release cutover negative check id: ${String(check.id)}`);
    }
    validateStringArray(check.command, "Release cutover negative check command", { allowEmpty: false });
    validateExactStringSequence(
      check.command,
      releaseCutoverNegativeCheckExpectations[check.id],
      `Release cutover negative check ${check.id} command`,
    );
    if (check.status !== "passed") throw new Error("Release cutover negative check status must be passed");
    if (check.exitCode !== 0) throw new Error("Release cutover negative check exitCode must be 0");
    validateNonEmptyString(check.assertion, "Release cutover negative check assertion");
  }
}

export { validateReleaseCutoverNegativeChecks };

function validateReleaseCutoverForbiddenMarkerScan(scan: ReleaseCutoverForbiddenMarkerScan): void {
  if (!scan || typeof scan !== "object") throw new Error("Release cutover forbiddenMarkerScan is required");
  validateNonNegativeInteger(scan.scannedTextCount, "Release cutover forbidden marker scannedTextCount");
  if (scan.scannedTextCount === 0) throw new Error("Release cutover forbidden marker scan must scan at least one text");
  if (scan.findingCount !== 0) throw new Error("Release cutover forbidden marker findingCount must be 0");
  validateStringArray(scan.markersBlocked, "Release cutover forbidden marker labels", { allowEmpty: false });
}

export { validateReleaseCutoverForbiddenMarkerScan };

function validateReleaseCutoverInputEvidence(evidence: readonly ReleaseCutoverInputEvidence[]): void {
  validateNonEmptyArray(evidence, "Release cutover input evidence");
  validateExactStringSet(
    evidence.map((entry) => entry.issue),
    releaseCutoverInputIssues,
    "Release cutover input evidence issues",
  );
  for (const entry of evidence) {
    if (!entry || typeof entry !== "object") throw new Error("Release cutover input evidence entry is required");
    if (!includesString(releaseCutoverInputIssues, entry.issue)) {
      throw new Error(`Unknown release cutover input evidence issue: ${String(entry.issue)}`);
    }
    validateNonEmptyString(entry.path, "Release cutover input evidence path");
    validateSha256(entry.checksumSha256, "Release cutover input evidence checksumSha256");
  }
}

export { validateReleaseCutoverInputEvidence };
