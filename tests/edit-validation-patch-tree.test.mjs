import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeCommandAdapter } from "../packages/contracts/dist/index.js";
import { calculateEditChecksum, createEditCommandAdapter } from "../packages/edit/dist/index.js";

test("patch and tree check mode return validation envelopes without writing", async () => {
  await withTempRepo(async (repo) => {
    writeFileSync(join(repo, "src/a.ts"), "old\n");
    const patchRunner = recordingRunner(passedValidation());
    const patch = await routeEdit(["patch", "--repo", repo, "--request-json", JSON.stringify({ patch: patchFor("src/a.ts", "old", "patched") }), "--check"], patchRunner);
    assert.equal(patch.status, "ok");
    assert.equal(patch.editResult.applied, false);
    assert.equal(patch.editResult.validation.status, "passed");
    assert.deepEqual(patchRunner.requests[0].overlays, [writeOverlay("src/a.ts", "patched\n", "old\n")]);
    assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");
    const treeRunner = recordingRunner(passedValidation());
    const tree = await routeEdit(["tree", "--repo", repo, "--request-json", JSON.stringify({ files: [{ path: "src/a.ts", content: "tree\n" }] }), "--check"], treeRunner);
    assert.equal(tree.status, "ok");
    assert.equal(tree.editResult.applied, false);
    assert.equal(tree.editResult.validation.status, "passed");
    assert.deepEqual(treeRunner.requests[0].overlays, [writeOverlay("src/a.ts", "tree\n", "old\n")]);
    assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");
  });
});

async function routeEdit(args, validationRunner) {
  return routeCommandAdapter({
    bin: "opcore",
    argv: [...args, "--json"],
    groupName: "edit",
    adapter: createEditCommandAdapter({ validationRunner })
  });
}

function writeOverlay(path, content, before) {
  return { path, action: "write", content, checksumBefore: calculateEditChecksum(before) };
}

function recordingRunner(result) {
  const requests = [];
  return { requests, async runValidation(request) { requests.push(request); return result; } };
}

function passedValidation() {
  return { ok: true, status: "passed", diagnostics: [] };
}

function patchFor(path, before, after) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-${before}`, `+${after}`, ""].join("\n");
}

async function withTempRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), "lattice-edit-validation-patch-tree-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    await run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
