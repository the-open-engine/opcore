import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  forbiddenLaunchClaims,
  launchClaimScrubFiles,
  scrubLaunchClaims
} from "../scripts/lib/launch-claim-scrub.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// One positive sample per forbidden label. Each must be a phrase the alpha must never ship.
const overclaimSamples = {
  "public ASP standard claim": "ASP is now the public standard for agent checks.",
  "old-tool replacement claim": "Opcore replaces Rox, CRG, and CIX in your pipeline.",
  "universal stack claim": "Full coverage for every language and platform.",
  "universal agent claim": "Works with every agent on the market.",
  "AI authorship claim": "Opcore detects AI authored code in your diffs.",
  "scanner claim": "A SAST security scanner for your repo.",
  "automatic fix claim": "Opcore automatically fixes your repo.",
  "unsupported coverage claim": "Unsupported languages are fully covered too.",
  "blended score claim": "Get a single robustness score for the whole repo.",
  "asp router command claim": "Run opcore asp serve to start the host.",
  "provider authority claim": "The provider grants gate authority to allow merges.",
  "ACE-managed distribution claim": "Distributed as an ACE-managed tool."
};

test("every forbidden claim label has a catching sample and is detected", () => {
  for (const { label } of forbiddenLaunchClaims) {
    const sample = overclaimSamples[label];
    assert.ok(sample !== undefined, `missing positive sample for forbidden label: ${label}`);
    assert.ok(
      scrubLaunchClaims(sample).includes(label),
      `forbidden sample not caught for label: ${label}`
    );
  }
});

test("honest launch wording passes the scrub", () => {
  const clean = [
    "Opcore is the robustness loop for agent-era repos.",
    "Deep for TypeScript/JavaScript and useful for Rust in alpha; unsupported stacks are counted and reported honestly.",
    "opcore measure prints named deltas, not a score.",
    "Opcore does not blend findings into an opaque score.",
    "Prefer concrete counts and file locations over scores.",
    "Providers assess; ASP hosts decide. Do not treat provider output as a gate decision.",
    "Opcore is an independently installed ASP Core check provider; the host owns allow/deny decisions.",
    "Retain your existing Rox, CRG, and CIX guardrails; this is additive."
  ].join("\n");
  assert.deepEqual(scrubLaunchClaims(clean), []);
});

test("all launch-facing surfaces are currently claim-clean", () => {
  const findings = [];
  for (const path of launchClaimScrubFiles(repoRoot)) {
    const labels = scrubLaunchClaims(readFileSync(path, "utf8"));
    for (const label of labels) findings.push(`${relative(repoRoot, path)}: ${label}`);
  }
  assert.deepEqual(findings, [], `launch claim scrub findings:\n${findings.join("\n")}`);
});

test("claim scrub covers every public package README", () => {
  const covered = new Set(launchClaimScrubFiles(repoRoot).map((path) => relative(repoRoot, path)));
  for (const dir of [
    "opcore",
    "contracts",
    "graph",
    "edit",
    "validation",
    "validation-rust",
    "validation-typescript",
    "asp-provider"
  ]) {
    assert.ok(
      covered.has(`packages/${dir}/README.md`),
      `claim scrub must cover packages/${dir}/README.md`
    );
  }
  assert.ok(
    [...covered].some((path) => path.startsWith("packages/opcore/src/") && path.endsWith(".ts")),
    "claim scrub must cover packages/opcore/src/**/*.ts"
  );
});
