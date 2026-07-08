import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAspHostFixtureRepo, runCurrentToolGuardrails } from "../scripts/asp-dogfood-receipt-support.mjs";
import { validateAspDogfoodReceipt } from "../packages/contracts/dist/index.js";
import { invalidAspDogfoodCases, validAspDogfoodReceipt } from "./helpers/asp-dogfood-fixture.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "generate-asp-dogfood-receipt.mjs");

describe("ASP dogfood receipt", () => {
  it("validates a receipt file through the dogfood script without requiring sibling ASP", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-asp-dogfood-test-"));
    try {
      const receiptPath = join(temp, "receipt.json");
      writeFileSync(receiptPath, `${JSON.stringify(validAspDogfoodReceipt(), null, 2)}\n`);
      const result = spawnSync(process.execPath, [script, "--validate-receipt-file", receiptPath, "--json"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).oldToolReplacementClaimed, false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects all #120 dogfood overclaim and trust-loop negative cases", () => {
    for (const [name, invalidReceipt, pattern] of invalidAspDogfoodCases(validAspDogfoodReceipt())) {
      assert.throws(() => validateAspDogfoodReceipt(invalidReceipt), pattern, name);
    }
  });

  it("allows failed optional ASP CI verify evidence while required dogfood commands pass", () => {
    const receipt = validAspDogfoodReceipt();
    const ciVerify = receipt.hostEvaluation.ciVerify;
    receipt.hostEvaluation.ciVerify = { ...ciVerify, status: "failed", exitCode: 1, assertion: "asp ci verify failed evidence recorded" };
    assert.equal(validateAspDogfoodReceipt(receipt).issue, "#120");
  });

  it("can reuse recorded retained current-tool guardrails for receipt refreshes", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-asp-dogfood-guardrails-test-"));
    const previous = process.env.OPCORE_ASP_DOGFOOD_REUSE_CURRENT_TOOL_GUARDRAILS;
    try {
      mkdirSync(join(temp, "docs", "release"), { recursive: true });
      const receipt = validAspDogfoodReceipt();
      writeFileSync(join(temp, "docs", "release", "asp-dogfood-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      process.env.OPCORE_ASP_DOGFOOD_REUSE_CURRENT_TOOL_GUARDRAILS = "1";
      assert.deepEqual(runCurrentToolGuardrails(temp, true), receipt.currentToolGuardrails);
    } finally {
      if (previous === undefined) delete process.env.OPCORE_ASP_DOGFOOD_REUSE_CURRENT_TOOL_GUARDRAILS;
      else process.env.OPCORE_ASP_DOGFOOD_REUSE_CURRENT_TOOL_GUARDRAILS = previous;
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("creates an isolated changed fixture repo for clean-tree host dogfood", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-asp-dogfood-fixture-test-"));
    try {
      const fixture = createAspHostFixtureRepo(temp);
      const diff = spawnSync("git", ["diff", "--name-only", "HEAD", "--"], {
        cwd: fixture.repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      assert.equal(diff.status, 0, diff.stderr);
      assert.deepEqual(diff.stdout.trim().split(/\r?\n/), ["src/dogfood.ts"]);
      assert.equal(fixture.temp, true);
      assert.equal(fixture.sourceRepoMutated, false);
      assert.equal(fixture.baselineCommitted, true);
      assert.deepEqual(fixture.changedPaths, ["src/dogfood.ts"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
