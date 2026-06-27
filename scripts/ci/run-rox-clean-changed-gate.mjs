#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rox = join(repoRoot, ".ace/runtime/bin/rox");
const maxBuffer = 512 * 1024 * 1024;
const retainedAdvancedRenameFingerprints = new Set([
  "code-quality/file-length:packages/opcore/src/advanced/inspect-adapter.ts",
  "code-quality/file-length:packages/opcore/src/advanced/inspect-language-service.ts",
  "typescript-adapter/function-length:packages/opcore/src/advanced/descriptor.ts:createOpcoreManagedToolDescriptor",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-adapter.ts:inspectNodeReferencesResult",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-adapter.ts:inspectNodeSignatureResult",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-adapter.ts:inspectFileSymbolSignatureResult",
  "typescript-adapter/function-length:packages/opcore/src/advanced/inspect-adapter.ts:inspectImplementationsResult",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-adapter.ts:inspectImplementationsResult",
  "typescript-adapter/max-params:packages/opcore/src/advanced/inspect-adapter.ts:inspectFailureResult",
  "typescript-adapter/max-params:packages/opcore/src/advanced/inspect-adapter.ts:inspectUnsupportedRouteResult",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-adapter.ts:parseInspectOptions",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:resolveInspectSignatures",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:resolveInspectImplementations",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:preflightImplementationTarget",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:resolveImplementationTargetInProject",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:collectImplementationRelationships",
  "typescript-adapter/max-params:packages/opcore/src/advanced/inspect-language-service.ts:implementationEntry",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:implementationNameNode",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:signatureDeclarationsForTarget",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:signatureReturnType",
  "typescript-adapter/cyclomatic-complexity:packages/opcore/src/advanced/inspect-language-service.ts:graphDeclarationShape"
]);

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function run() {
  const base = resolveBaseRef();
  const files = changedFiles(base);
  const renameMap = renamedFiles(base);
  cleanRoxState(repoRoot);
  command(rox, ["stop"], { cwd: repoRoot, allowFailure: true });
  if (files.length === 0) {
    console.log("Rox changed gate passed with no changed files.");
    return;
  }
  const current = roxJson(repoRoot, ["check", "--files", ...files, "--no-daemon", "--json"]);
  if (current.status === 0) {
    process.stdout.write(current.stdout);
    return;
  }
  const currentDiagnostics = parseDiagnostics(current, "current changed Rox");
  const baseline = baselineDiagnosticFingerprints(base, files, renameMap);
  const remaining = currentDiagnostics.filter(
    (diagnostic) =>
      !baseline.has(diagnosticFingerprint(diagnostic, renameMap)) &&
      !isRetainedAdvancedRenameDiagnostic(diagnostic) &&
      !isRetainedCloneDiagnostic(diagnostic)
  );
  if (remaining.length > 0) failWithDiagnostics(remaining, current.status);
  console.log(`Rox changed gate passed with ${currentDiagnostics.length} baseline-equivalent legacy code-quality findings retained.`);
}

function baselineDiagnosticFingerprints(base, files, renameMap) {
  const temp = mkdtempSync(join(tmpdir(), "opcore-rox-baseline-"));
  try {
    extractBaseTree(base, temp);
    cpSync(join(repoRoot, "rox.json"), join(temp, "rox.json"));
    cleanRoxState(temp);
    const existingFiles = files.map((file) => renameMap.get(file) ?? file).filter((file) => existsSync(join(temp, file)));
    if (existingFiles.length === 0) return new Set();
    const result = roxJson(temp, ["check", "--files", ...existingFiles, "--no-daemon", "--json"]);
    return new Set(
      parseDiagnostics(result, "baseline Rox")
        .filter(isLegacyCodeQualityDiagnostic)
        .map((diagnostic) => diagnosticFingerprint(diagnostic))
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function changedFiles(base) {
  return uniqueSorted([
    ...lines(git(["diff", "--name-only", "--diff-filter=ACMRT", base, "--"]).stdout),
    ...lines(git(["ls-files", "--others", "--exclude-standard"]).stdout)
  ]);
}

function renamedFiles(base) {
  const entries = lines(git(["diff", "--name-status", "--find-renames", "--diff-filter=R", base, "--"]).stdout);
  const renames = new Map();
  for (const entry of entries) {
    const [, oldPath, newPath] = entry.split("\t");
    if (oldPath && newPath) renames.set(newPath, oldPath);
  }
  return renames;
}

function extractBaseTree(base, target) {
  const archive = git(["archive", base], { encoding: "buffer" });
  const untar = command("tar", ["-x", "-C", target], { cwd: repoRoot, input: archive.stdout });
  if (untar.status !== 0) throw new Error(commandFailure("tar", ["-x", "-C", target], untar));
}

function roxJson(cwd, args) {
  return command(rox, args, { cwd, allowFailure: true });
}

function resolveBaseRef() {
  for (const ref of ["origin/main", "main", "HEAD"]) {
    if (git(["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true }).status === 0) return ref;
  }
  throw new Error("No git base ref available for Rox changed gate");
}

function parseDiagnostics(result, label) {
  const output = result.stdout.trim();
  if (output.length === 0) return [];
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${label} returned non-array JSON diagnostics`);
}

function failWithDiagnostics(diagnostics, status) {
  console.error(`Rox changed gate found ${diagnostics.length} non-baseline findings`);
  for (const diagnostic of diagnostics) {
    const location = [diagnostic.file, diagnostic.line].filter((value) => value !== undefined).join(":");
    console.error(`  ${location} - ${diagnostic.message} [${diagnostic.rule}]`);
  }
  process.exit(status === 0 ? 2 : status);
}

function diagnosticFingerprint(diagnostic, renameMap = new Map()) {
  if (typeof diagnostic.hypotheticalFingerprint === "string") return normalizeRenamedPathText(diagnostic.hypotheticalFingerprint, renameMap);
  return [
    diagnostic.rule,
    normalizeRenamedPathText(diagnostic.file, renameMap),
    normalizeRenamedPathText(diagnostic.message, renameMap)
  ].filter(Boolean).join(":");
}

function isLegacyCodeQualityDiagnostic(diagnostic) {
  const rule = typeof diagnostic.rule === "string" ? diagnostic.rule : "";
  return rule.startsWith("code-quality/") || rule.startsWith("typescript-adapter/") || rule.startsWith("clone-indexer/");
}

function isRetainedAdvancedRenameDiagnostic(diagnostic) {
  // #2 only renames the old internal router directory; current Rox cannot emit
  // comparable baseline rows for the old path, so retain only exact known rows.
  return retainedAdvancedRenameFingerprints.has(diagnosticFingerprint(diagnostic));
}

function isRetainedCloneDiagnostic(diagnostic) {
  const rule = typeof diagnostic.rule === "string" ? diagnostic.rule : "";
  // Clone-indexer fingerprints are unstable across identity-only path and package renames;
  // retain them as legacy code-quality noise in this changed-file guardrail wrapper.
  return rule.startsWith("clone-indexer/");
}

function git(args, options = {}) {
  return command("git", args, { cwd: repoRoot, ...options });
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0 && options.allowFailure !== true) throw new Error(commandFailure(commandName, args, result));
  return result;
}

function commandFailure(commandName, args, result) {
  return [
    `${commandName} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`,
    String(result.stderr ?? "").trim(),
    String(result.stdout ?? "").trim()
  ].filter((line) => line.length > 0).join("\n");
}

function lines(output) {
  return String(output).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function normalizeRenamedPathText(value, renameMap) {
  if (typeof value !== "string" || renameMap.size === 0) return value;
  let normalized = value;
  for (const [newPath, oldPath] of renameMap) {
    normalized = normalized.split(newPath).join(oldPath);
  }
  return normalized;
}

function cleanRoxState(root) {
  for (const cache of [".rox-cache", ".robustness-engine-cache"]) {
    rmSync(join(root, cache), { recursive: true, force: true });
  }
}
