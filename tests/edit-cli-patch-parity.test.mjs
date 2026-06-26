import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeCommand } from "../packages/opcore/dist/lattice/index.js";
import { createEditCommandAdapter } from "../packages/edit/dist/index.js";

test("patch CLI accepts stdin, raw request-file, and request-json payloads", async () => {
  await withTempRepo(async (repo) => {
    writeFileSync(join(repo, "src/a.ts"), "one\n");
    const stdin = await routeEditWithAdapter(["patch", "--repo", repo, "--stdin", "--dry-run"], {
      readStdin: async () => codexPatch(["*** Update File: src/a.ts", "@@", "-one", "+two"])
    });
    assert.equal(stdin.status, "ok");
    assert.equal(stdin.editPlan.changes[0].content, "two\n");
    const requestFile = join(repo, "patch.diff");
    writeFileSync(requestFile, patchFor("src/a.ts", "one", "three"));
    const file = await routeCommand(["edit", "patch", "--repo", repo, "--request-file", requestFile, "--dry-run", "--json"], "lattice");
    assert.equal(file.status, "ok");
    assert.equal(file.editPlan.changes[0].content, "three\n");
    const json = await routeCommand(["edit", "patch", "--repo", repo, "--request-json", JSON.stringify({ patch: patchFor("src/a.ts", "one", "four") }), "--dry-run", "--json"], "lattice");
    assert.equal(json.status, "ok");
    assert.equal(json.editPlan.changes[0].content, "four\n");
    assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "one\n");
  });
});

test("patch CLI check validates, dry-run skips validation, and apply is validation-gated", async () => {
  await withTempRepo(async (repo) => {
    writeFileSync(join(repo, "src/a.ts"), "one\n");
    const runner = recordingRunner(passedValidation());
    const checked = await routeEditWithAdapter(["patch", "--repo", repo, "--stdin", "--check"], {
      readStdin: async () => patchFor("src/a.ts", "one", "checked"),
      validationRunner: runner
    });
    assert.equal(checked.status, "ok");
    assert.equal(checked.editResult.applied, false);
    assert.equal(checked.editResult.validation.status, "passed");
    assert.equal(runner.requests.length, 1);
    const dryRun = await routeEditWithAdapter(["patch", "--repo", repo, "--stdin", "--dry-run"], {
      readStdin: async () => patchFor("src/a.ts", "one", "dry"),
      validationRunner: throwingRunner(new Error("dry-run must not validate"))
    });
    assert.equal(dryRun.status, "ok");
    assert.equal(dryRun.editResult.validation, undefined);
    const apply = await routeEditWithAdapter(["patch", "--repo", repo, "--stdin", "--apply"], {
      readStdin: async () => patchFor("src/a.ts", "one", "applied")
    });
    assert.equal(apply.status, "error");
    assert.equal(apply.editResult.applied, false);
    assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "one\n");
  });
});

async function routeEditWithAdapter(args, options) {
  const adapter = createEditCommandAdapter(options);
  return adapter({
    schemaVersion: 1,
    bin: "lattice",
    argv: ["edit", ...args, "--json"],
    args,
    json: true,
    group: { name: "edit", owner: "edit", canonicalCommand: ["lattice", "edit"], commands: [args[0]], summary: "test" },
    canonicalCommand: ["lattice", "edit", ...args]
  });
}

function recordingRunner(result) {
  const requests = [];
  return { requests, async runValidation(request) { requests.push(request); return result; } };
}

function throwingRunner(error) {
  return { requests: [], async runValidation() { throw error; } };
}

function passedValidation() {
  return { ok: true, status: "passed", diagnostics: [] };
}

function patchFor(path, before, after) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-${before}`, `+${after}`, ""].join("\n");
}

function codexPatch(lines) {
  return ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");
}

async function withTempRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), "lattice-edit-cli-patch-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    await run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
