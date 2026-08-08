#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "packages", "opcore", "dist", "index.js");
const configPath = join(repoRoot, ".opcore", "config");
const requestedBase =
  process.env.OPCORE_SELF_CHECK_BASE_REF ??
  process.env.OPCORE_LOCAL_CI_BASE_REF ??
  "origin/dev";

if (!existsSync(cliPath)) {
  fail("Opcore self-check requires built packages; run npm run build first.");
}

const baseRef = commitExists(requestedBase) ? requestedBase : "HEAD";
const manifestRun = runOpcore("validation manifest", [
  "check",
  "manifest",
  "--repo",
  repoRoot,
  "--json"
]);
const entries = manifestRun.payload.validationResult?.manifest?.entries;
if (!Array.isArray(entries) || entries.length === 0) {
  fail("Opcore self-check manifest did not contain validation check entries.");
}
const availableChecks = entries.map((entry) => entry.checkId);
assertUniqueStrings(availableChecks, "validation manifest check ids");
assertStrictConfig(entries);

const changedChecks = entries
  .filter((entry) => entry.supportedScopes?.includes("changed"))
  .map((entry) => entry.checkId);
const repoChecks = entries
  .filter((entry) => !entry.supportedScopes?.includes("changed"))
  .map((entry) => entry.checkId);

for (const entry of entries.filter((candidate) => repoChecks.includes(candidate.checkId))) {
  if (!entry.supportedScopes?.includes("all")) {
    fail(`Opcore self-check cannot execute ${entry.checkId}: neither changed nor all scope is supported.`);
  }
}

const changedRun = runOpcore(`changed validation against ${baseRef}`, [
  "check",
  "changed",
  "--repo",
  repoRoot,
  "--base",
  baseRef,
  "--report-mode",
  "introduced",
  "--json"
]);
assertValidationRun(changedRun.payload, changedChecks, `changed validation against ${baseRef}`);

if (repoChecks.length > 0) {
  if (entries.some((entry) => repoChecks.includes(entry.checkId) && entry.requiresGraph === true)) {
    assertGraphBuild(runOpcore("repo-wide graph preparation", [
      "graph",
      "build",
      "--repo",
      repoRoot,
      "--json"
    ]).payload);
  }
  const repoRun = runOpcore("repo-wide validation", [
    "check",
    "all",
    "--repo",
    repoRoot,
    "--checks",
    repoChecks.join(","),
    "--json"
  ]);
  assertValidationRun(repoRun.payload, repoChecks, "repo-wide validation");
}

assertSameStringSet([...changedChecks, ...repoChecks], availableChecks, "self-check scope coverage");
process.stdout.write(
  `Opcore self-check passed against ${baseRef}: ${availableChecks.length} checks across ` +
    `${repoChecks.length > 0 ? 2 : 1} scopes, 0 diagnostics.\n`
);

function runOpcore(label, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) fail(`Unable to run Opcore ${label}: ${result.error.message}`);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    fail(`Opcore ${label} returned malformed JSON.\n${result.stderr || result.stdout}`);
  }
  if (result.status !== 0 || payload.exitCode !== 0 || payload.status !== "ok") {
    fail(commandFailure(label, result, payload));
  }
  return { payload, stderr: result.stderr };
}

function commandFailure(label, result, payload) {
  return [
    `Opcore self-check ${label} failed.`,
    `router status=${String(payload.status)} exit=${String(payload.exitCode)} process=${String(result.status)}`,
    diagnosticSummary(payload.validationResult?.diagnostics),
    result.stderr.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

function assertValidationRun(payload, expectedChecks, label) {
  const validationResult = payload.validationResult;
  if (validationResult?.status !== "passed" || validationResult.ok !== true) {
    fail(`Opcore self-check ${label} returned validation status ${String(validationResult?.status)}.`);
  }
  assertExactStrings(validationResult.manifest?.checks, expectedChecks, `${label} manifest`);
  const diagnostics = validationResult.diagnostics ?? [];
  if (diagnostics.length > 0) {
    fail(`Opcore self-check ${label} returned diagnostics.\n${diagnosticSummary(diagnostics)}`);
  }
}

function assertGraphBuild(payload) {
  if (
    payload.providerStatus?.state !== "available" ||
    payload.graphPipeline?.summary?.operation !== "build"
  ) {
    fail("Opcore self-check repo-wide graph preparation did not produce an available build.");
  }
}

function assertStrictConfig(entries) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`Opcore self-check could not read strict policy: ${errorMessage(error)}`);
  }
  const checks = config?.validation?.checks;
  assertExactStrings(checks?.defaults, entries.map((entry) => entry.checkId), "validation.checks.defaults");
  assertExactStrings(checks?.disabled, [], "validation.checks.disabled");
  assertExactStrings(
    config?.validation?.adapters,
    [...new Set(entries.map((entry) => entry.adapter))],
    "validation.adapters"
  );
}

function assertExactStrings(actual, expected, label) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string")) {
    fail(`Opcore self-check ${label} must be a string array.`);
  }
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(
      `Opcore self-check ${label} mismatch.\n` +
        `expected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`
    );
  }
}

function assertUniqueStrings(values, label) {
  if (new Set(values).size !== values.length) {
    fail(`Opcore self-check ${label} must be unique.`);
  }
}

function assertSameStringSet(actual, expected, label) {
  assertUniqueStrings(actual, label);
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assertExactStrings(actualSorted, expectedSorted, label);
}

function diagnosticSummary(diagnostics = []) {
  return diagnostics
    .slice(0, 20)
    .map((diagnostic) => {
      const location = diagnostic.path ? `${diagnostic.path}: ` : "";
      const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
      return `${location}${diagnostic.message ?? "validation diagnostic"}${code}`;
    })
    .join("\n");
}

function commitExists(ref) {
  const probe = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"]
  });
  return probe.status === 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
