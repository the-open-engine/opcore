import { validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import {
  validateExactStringSet,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256,
  validateStringArray,
} from "../shared/validators-01.js";
import { collectStrings } from "../shared/validators-02.js";
import type {
  AspDogfoodAuthorityEvidence,
  AspDogfoodCommandRunReceipt,
  AspDogfoodForbiddenMarkerScan,
  AspDogfoodParityBlocker,
  AspDogfoodReceipt,
  AspDogfoodUnsupportedSurfaceEvidence,
} from "./asp-contracts-01.js";
import { aspDogfoodForbiddenProviderMarkers, aspDogfoodUnsupportedSurfaceIds } from "./vocabulary-02.js";

function validateAspDogfoodUnsupportedSurfaces(surfaces: readonly AspDogfoodUnsupportedSurfaceEvidence[]): void {
  validateNonEmptyArray(surfaces, "ASP dogfood unsupported surfaces");
  validateExactStringSet(
    surfaces.map((entry) => entry.surface),
    aspDogfoodUnsupportedSurfaceIds,
    "ASP dogfood unsupported surfaces",
  );
  for (const entry of surfaces) {
    if (!entry || typeof entry !== "object") throw new Error("ASP dogfood unsupported surface entry is required");
    if (!includesString(aspDogfoodUnsupportedSurfaceIds, entry.surface)) {
      throw new Error(`Unknown ASP dogfood unsupported surface: ${String(entry.surface)}`);
    }
    if (!includesString(["degraded", "parity-blocker"] as const, entry.status)) {
      throw new Error("ASP dogfood unsupported surface status must be degraded or parity-blocker");
    }
    if (entry.cleanCoverage !== false)
      throw new Error("ASP dogfood unsupported inspect/edit surfaces must not be represented as clean coverage");
    validateNonEmptyString(entry.blocker, "ASP dogfood unsupported surface blocker");
  }
}

export { validateAspDogfoodUnsupportedSurfaces };

function validateAspDogfoodParityBlockers(blockers: readonly AspDogfoodParityBlocker[]): void {
  if (!Array.isArray(blockers)) throw new Error("ASP dogfood parity blockers must be an array");
  for (const blocker of blockers) {
    if (!blocker || typeof blocker !== "object") throw new Error("ASP dogfood parity blocker is required");
    validateNonEmptyString(blocker.source, "ASP dogfood parity blocker source");
    validateNonEmptyString(blocker.detail, "ASP dogfood parity blocker detail");
  }
}

export { validateAspDogfoodParityBlockers };

function validateAspDogfoodAuthority(authority: AspDogfoodAuthorityEvidence): void {
  if (!authority || typeof authority !== "object") throw new Error("ASP dogfood authority evidence is required");
  if (authority.hostOwnsDecisions !== true) throw new Error("ASP dogfood host must own decisions");
  if (authority.providerOutputIsHostDecision !== false)
    throw new Error("ASP dogfood provider output must not be treated as host decision");
  validateRequiredObject(authority.localAuthorityOverride, "ASP dogfood local authority override evidence is required");
  if (
    authority.localAuthorityOverride.present !== false ||
    authority.localAuthorityOverride.sharedAuthorityWeakened !== false
  ) {
    throw new Error("ASP dogfood must not silently weaken shared authority through local override");
  }
}

export { validateAspDogfoodAuthority };

function validateAspDogfoodForbiddenMarkerScan(scan: AspDogfoodForbiddenMarkerScan): void {
  if (!scan || typeof scan !== "object") throw new Error("ASP dogfood forbidden marker scan is required");
  validatePositiveInteger(scan.scannedTextCount, "ASP dogfood forbidden marker scannedTextCount");
  if (scan.findingCount !== 0) throw new Error("ASP dogfood forbidden marker findingCount must be 0");
  validateExactStringSet(
    scan.markersBlocked,
    aspDogfoodForbiddenProviderMarkers,
    "ASP dogfood forbidden provider markers",
  );
}

export { validateAspDogfoodForbiddenMarkerScan };

function validateAspDogfoodCommandRun(receipt: AspDogfoodCommandRunReceipt, expectedId: string, label: string): void {
  if (!receipt || typeof receipt !== "object") throw new Error(`${label} receipt is required`);
  if (receipt.id !== expectedId) throw new Error(`${label} id must be ${expectedId}`);
  validateStringArray(receipt.command, `${label} command`, {
    allowEmpty: false,
  });
  if (!includesString(["passed", "failed", "retained-not-run"] as const, receipt.status)) {
    throw new Error(`${label} status must be passed, failed, or retained-not-run`);
  }
  if (receipt.status === "passed" && receipt.exitCode !== 0)
    throw new Error(`${label} passed status must use exitCode 0`);
  if (receipt.status === "retained-not-run" && receipt.exitCode !== null) {
    throw new Error(`${label} retained-not-run status must use null exitCode`);
  }
  if (receipt.status === "failed") validateNonNegativeInteger(receipt.exitCode, `${label} exitCode`);
  validateSha256(receipt.stdoutSha256, `${label} stdoutSha256`);
  validateSha256(receipt.stderrSha256, `${label} stderrSha256`);
  validateNonEmptyString(receipt.assertion, `${label} assertion`);
}

export { validateAspDogfoodCommandRun };

function validateAspDogfoodPassedCommandRun(
  receipt: AspDogfoodCommandRunReceipt,
  expectedId: string,
  label: string,
): void {
  validateAspDogfoodCommandRun(receipt, expectedId, label);
  if (receipt.status !== "passed") throw new Error(`${label} status must be passed`);
  if (receipt.exitCode !== 0) throw new Error(`${label} passed status must use exitCode 0`);
}

export { validateAspDogfoodPassedCommandRun };

function validateAspDogfoodForbiddenProviderEntrypoint(receipt: AspDogfoodReceipt): void {
  const providerTexts = collectStrings(receipt.provider);
  const findings: string[] = [];
  for (const text of providerTexts) {
    const normalized = text.replaceAll("\\", "/").toLowerCase();
    for (const marker of aspDogfoodForbiddenProviderMarkers) {
      if (normalized.includes(marker.toLowerCase())) findings.push(marker);
    }
  }
  if (findings.length > 0) {
    throw new Error(`ASP dogfood provider entrypoint contains forbidden marker: ${[...new Set(findings)].join(", ")}`);
  }
}

export { validateAspDogfoodForbiddenProviderEntrypoint };

function assertNoAspDogfoodHostOwnedFields(value: unknown, path = "$"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAspDogfoodHostOwnedFields(entry, `${path}[${index}]`));
    return;
  }
  const forbidden = new Set([
    "decision",
    "verdict",
    "pass",
    "authority",
    "authorityEvidence",
    "assurance",
    "transactionGuarantee",
    "applyReceipt",
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`ASP dogfood provider output contains host-owned field ${path}.${key}`);
    assertNoAspDogfoodHostOwnedFields(child, `${path}.${key}`);
  }
}

export { assertNoAspDogfoodHostOwnedFields };
