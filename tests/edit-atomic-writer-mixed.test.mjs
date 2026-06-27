import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEditPlan, calculateEditChecksum, createNodeEditWorkspace } from "../packages/edit/dist/index.js";

test("atomic writer rolls back mixed create, delete, and replace failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "lattice-edit-mixed-rollback-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/delete.ts"), "delete before\n", "utf8");
    await writeFile(join(root, "src/replace.ts"), "replace before\n", "utf8");
    const workspace = await createNodeEditWorkspace({
      repoRoot: root,
      failureHooks: { afterCommit(change) { if (change.path === "src/create.ts") throw new Error("injected mixed failure"); } }
    });
    const applied = await applyEditPlan(workspace, mixedPlan(root));
    assert.equal(applied.ok, false);
    assert.equal(applied.rollback.completed, true);
    assert.equal(applied.rollback.restoredPaths.includes("src/create.ts"), true);
    assert.equal(applied.rollback.restoredPaths.includes("src/delete.ts"), true);
    assert.equal(applied.rollback.restoredPaths.includes("src/replace.ts"), true);
    await assert.rejects(() => readFile(join(root, "src/create.ts"), "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "src/delete.ts"), "utf8"), "delete before\n");
    assert.equal(await readFile(join(root, "src/replace.ts"), "utf8"), "replace before\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function mixedPlan(repoRoot) {
  return {
    planId: "mixed-rollback",
    repo: { repoRoot },
    changes: [createChange(), deleteChange(), replaceChange()],
    atomic: { strategy: "all_or_nothing", planHash: "sha256:mixed-rollback" },
    validation: {
      required: true,
      request: {
        repo: { repoRoot },
        scope: { kind: "files", files: ["src/create.ts", "src/delete.ts", "src/replace.ts"] },
        graph: { mode: "required", provider: "opcore-graph" },
        overlays: []
      }
    }
  };
}

function createChange() {
  return { kind: "create", path: "src/create.ts", content: "create after\n", checksumAfter: calculateEditChecksum("create after\n") };
}

function deleteChange() {
  return { kind: "delete", path: "src/delete.ts", checksumBefore: calculateEditChecksum("delete before\n") };
}

function replaceChange() {
  return {
    kind: "replace",
    path: "src/replace.ts",
    content: "replace after\n",
    checksumBefore: calculateEditChecksum("replace before\n"),
    checksumAfter: calculateEditChecksum("replace after\n")
  };
}
