#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "packages", "opcore", "dist", "index.js");
const requestedBase =
  process.env.OPCORE_SELF_CHECK_BASE_REF ??
  process.env.OPCORE_LOCAL_CI_BASE_REF ??
  "origin/dev";

if (!existsSync(cliPath)) {
  fail("Opcore self-check requires built packages; run npm run build first.");
}

const baseRef = commitExists(requestedBase) ? requestedBase : "HEAD";
const command = [
  cliPath,
  "check",
  "changed",
  "--base",
  baseRef,
  "--report-mode",
  "introduced",
  "--json"
];
const result = spawnSync(process.execPath, command, {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 64 * 1024 * 1024
});

if (result.error) fail(`Unable to run Opcore self-check: ${result.error.message}`);

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch {
  fail(`Opcore self-check returned malformed JSON.\n${result.stderr || result.stdout}`);
}

const diagnostics = payload.validationResult?.diagnostics ?? [];
if (result.status !== 0 || payload.exitCode !== 0 || payload.status !== "ok" || diagnostics.length > 0) {
  const summary = diagnostics
    .slice(0, 20)
    .map((diagnostic) => {
      const location = diagnostic.path ? `${diagnostic.path}: ` : "";
      const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
      return `${location}${diagnostic.message ?? "validation diagnostic"}${code}`;
    })
    .join("\n");
  fail(
    [
      `Opcore self-check failed against ${baseRef}.`,
      `router status=${String(payload.status)} exit=${String(payload.exitCode)} process=${String(result.status)}`,
      summary,
      result.stderr.trim()
    ]
      .filter(Boolean)
      .join("\n")
  );
}

const checkCount = payload.validationResult?.manifest?.checks?.length ?? 0;
process.stdout.write(
  `Opcore self-check passed against ${baseRef}: ${checkCount} checks, ${diagnostics.length} diagnostics.\n`
);

function commitExists(ref) {
  const probe = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"]
  });
  return probe.status === 0;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
