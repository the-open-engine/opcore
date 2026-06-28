import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { assertGitHistoryAvailable, latestCommitIso } from "./history.js";
import {
  isDocsPath,
  materializeDocsSnapshot,
  uniqueSorted,
  type DocsDocument,
  type DocsPolicyOptions,
  type DocsSnapshot
} from "./snapshot.js";

type FreshnessHistoryOutcome =
  | { status: "diagnostics"; diagnostics: readonly ValidationDiagnostic[] }
  | { status: "skipped"; result: ValidationCheckResult };
type LatestCommittedPath = { path: string; iso: string };

export async function runDocsFreshnessCheck(
  context: ValidationCheckContext,
  options: DocsPolicyOptions = {}
): Promise<ValidationCheckResult> {
  const snapshot = await materializeDocsSnapshot(context, options);
  const precheck = docsFreshnessPrecheck(snapshot);
  if (precheck !== undefined) return precheck;

  const referenceDiagnostics = await staleReferenceDiagnostics(context, snapshot.docs);
  const historyOutcome = docsFreshnessHistoryDiagnostics(context, snapshot);
  if (historyOutcome.status === "skipped") return freshnessFallbackResult(referenceDiagnostics, historyOutcome.result);
  return { diagnostics: sortDiagnostics([...referenceDiagnostics, ...historyOutcome.diagnostics]) };
}

function docsFreshnessPrecheck(snapshot: DocsSnapshot): ValidationCheckResult | undefined {
  if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
  return undefined;
}

function freshnessFallbackResult(
  diagnostics: readonly ValidationDiagnostic[],
  skipped: ValidationCheckResult
): ValidationCheckResult {
  return diagnostics.length > 0 ? { diagnostics: sortDiagnostics(diagnostics) } : skipped;
}

function docsFreshnessHistoryDiagnostics(
  context: ValidationCheckContext,
  snapshot: DocsSnapshot
): FreshnessHistoryOutcome {
  if (snapshot.hasOverlays) {
    return freshnessSkippedOutcome("Documentation Git-history checks require committed state and skip when overlays are present.");
  }
  const history = docsFreshnessHistoryRoot(context);
  if (history.status === "skipped") return history;
  const sourcePaths = snapshot.scopeFiles.filter((path) => !isDocsPath(path, snapshot.policy));
  if (sourcePaths.length === 0) return freshnessDiagnosticsOutcome([]);
  return latestPathFreshnessDiagnostics(history.repoRoot, snapshot.docs.map((doc) => doc.path), sourcePaths);
}

function docsFreshnessHistoryRoot(
  context: ValidationCheckContext
): { status: "available"; repoRoot: string } | { status: "skipped"; result: ValidationCheckResult } {
  const repoRoot = context.request.repo.repoRoot;
  if (repoRoot === undefined) {
    return {
      status: "skipped",
      result: skippedHistoryUnavailableResult("Git history is unavailable: request.repo.repoRoot is missing.")
    };
  }
  const available = assertGitHistoryAvailable(repoRoot);
  return available.ok
    ? { status: "available", repoRoot }
    : { status: "skipped", result: skippedHistoryUnavailableResult(available.message) };
}

function latestPathFreshnessDiagnostics(
  repoRoot: string,
  docPaths: readonly string[],
  sourcePaths: readonly string[]
): FreshnessHistoryOutcome {
  const latestDoc = latestCommittedPath(repoRoot, docPaths);
  if (!latestDoc.ok) return freshnessSkippedOutcome(latestDoc.message);
  if (latestDoc.value === undefined) return freshnessSkippedOutcome("Git history is unavailable for selected documentation files.");
  return latestSourceFreshnessDiagnostics(repoRoot, latestDoc.value, sourcePaths);
}

function latestSourceFreshnessDiagnostics(
  repoRoot: string,
  latestDoc: LatestCommittedPath,
  sourcePaths: readonly string[]
): FreshnessHistoryOutcome {
  const latestSource = latestCommittedPath(repoRoot, sourcePaths);
  if (!latestSource.ok) return freshnessSkippedOutcome(latestSource.message);
  if (latestSource.value === undefined) return freshnessDiagnosticsOutcome([]);
  const diagnosticResult = olderDocsDiagnostic(latestDoc, latestSource.value);
  return freshnessDiagnosticsOutcome(diagnosticResult === undefined ? [] : [diagnosticResult]);
}

function olderDocsDiagnostic(
  latestDoc: LatestCommittedPath,
  latestSource: LatestCommittedPath
): ValidationDiagnostic | undefined {
  if (Date.parse(latestDoc.iso) >= Date.parse(latestSource.iso)) return undefined;
  return diagnostic({
    severity: "warning",
    path: latestDoc.path,
    code: "DOCS_OLDER_THAN_CODE",
    message: `Newest selected documentation commit (${latestDoc.path}) is older than selected implementation changes (${latestSource.path}).`
  });
}

function freshnessDiagnosticsOutcome(diagnostics: readonly ValidationDiagnostic[]): FreshnessHistoryOutcome {
  return { status: "diagnostics", diagnostics };
}

function freshnessSkippedOutcome(message: string): FreshnessHistoryOutcome {
  return { status: "skipped", result: skippedHistoryUnavailableResult(message) };
}

function skippedDocsResult(message: string): ValidationCheckResult {
  return {
    status: "skipped",
    diagnostics: [],
    failureMessage: message
  };
}

function skippedHistoryUnavailableResult(message: string): ValidationCheckResult {
  return skippedDocsResult(message.startsWith("Git history is unavailable") ? message : `Git history is unavailable: ${message}`);
}

function latestCommittedPath(
  repoRoot: string,
  paths: readonly string[]
): { ok: true; value: LatestCommittedPath | undefined } | { ok: false; message: string } {
  let latest: LatestCommittedPath | undefined;
  for (const path of uniqueSorted(paths)) {
    const committed = latestCommitIso(repoRoot, path);
    if (!committed.ok) return committed;
    if (committed.value === undefined) continue;
    if (latest === undefined || Date.parse(committed.value) > Date.parse(latest.iso)) {
      latest = { path, iso: committed.value };
    }
  }
  return { ok: true, value: latest };
}

async function staleReferenceDiagnostics(
  context: ValidationCheckContext,
  docs: readonly DocsDocument[]
): Promise<readonly ValidationDiagnostic[]> {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const doc of docs) {
    for (const reference of referencedRepoPaths(doc.content)) {
      if (await context.fileView.exists(reference)) continue;
      diagnostics.push(
        diagnostic({
          path: doc.path,
          code: "DOCS_STALE_REFERENCE",
          message: `Documentation references a missing repository path: ${reference}.`
        })
      );
    }
  }
  return sortDiagnostics(diagnostics);
}

function referencedRepoPaths(content: string): readonly string[] {
  const references = new Set<string>();
  const pathPattern =
    /`([^`\n]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|rs|toml|json|jsonc|md|mdx|yml|yaml|sh|txt|css|scss|html))`|\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|rs|toml|json|jsonc|md|mdx|yml|yaml|sh|txt|css|scss|html))\b/gu;
  for (const match of content.matchAll(pathPattern)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined) continue;
    const normalized = normalizeReferencePath(raw);
    if (normalized !== undefined) references.add(normalized);
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}

function normalizeReferencePath(raw: string): string | undefined {
  const value = raw.trim().replace(/^['"]|['"]$/gu, "");
  if (value.length === 0 || value.startsWith("/") || value.includes("://") || value.startsWith("#")) return undefined;
  if (value.startsWith("../") || value.includes("/../") || value.endsWith("/..")) return undefined;
  if (value.startsWith("./")) return value.slice(2);
  return value;
}
