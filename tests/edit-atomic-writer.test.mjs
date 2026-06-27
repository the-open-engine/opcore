import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEditPlan,
  calculateEditChecksum,
  createExactEditPlan,
  createNodeEditWorkspace,
  previewEditPlan
} from "../packages/edit/dist/index.js";

describe("edit atomic writer", () => {
  it("previews after-state and validation overlays without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lattice-edit-preview-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/example.ts"), "before\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const planned = createExactEditPlan({
        repo: { repoRoot: root },
        path: "src/example.ts",
        content: "before\n",
        expectedText: "before",
        replacementText: "after"
      });
      assert.equal(planned.ok, true);

      const preview = await previewEditPlan(workspace, planned.plan);

      assert.equal(preview.ok, true);
      assert.deepEqual(preview.afterState, { "src/example.ts": "after\n" });
      assert.deepEqual(preview.validationRequest.overlays, [
        {
          path: "src/example.ts",
          action: "write",
          content: "after\n",
          checksumBefore: calculateEditChecksum("before\n")
        }
      ]);
      assert.equal(await readFile(join(root, "src/example.ts"), "utf8"), "before\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies create, delete, and rename-like changes inside the repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "lattice-edit-kinds-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/remove.ts"), "remove\n", "utf8");
      await writeFile(join(root, "src/old.ts"), "rename\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const plan = {
        planId: "edit-kinds",
        repo: { repoRoot: root },
        changes: [
          {
            kind: "create",
            path: "src/create.ts",
            content: "create\n",
            checksumAfter: calculateEditChecksum("create\n")
          },
          {
            kind: "delete",
            path: "src/remove.ts",
            checksumBefore: calculateEditChecksum("remove\n")
          },
          {
            kind: "rename",
            path: "src/old.ts",
            toPath: "src/new.ts",
            checksumBefore: calculateEditChecksum("rename\n")
          }
        ],
        atomic: {
          strategy: "all_or_nothing",
          planHash: "sha256:kinds"
        },
        validation: {
          required: true,
          request: {
            repo: { repoRoot: root },
            scope: { kind: "files", files: ["src/create.ts"] },
            graph: { mode: "required", provider: "opcore-graph" },
            overlays: []
          }
        }
      };

      const applied = await applyEditPlan(workspace, plan);

      assert.equal(applied.ok, true);
      assert.deepEqual(applied.afterState, {
        "src/create.ts": "create\n",
        "src/new.ts": "rename\n",
        "src/old.ts": null,
        "src/remove.ts": null
      });
      assert.equal(await readFile(join(root, "src/create.ts"), "utf8"), "create\n");
      assert.equal(await readFile(join(root, "src/new.ts"), "utf8"), "rename\n");
      await assert.rejects(() => readFile(join(root, "src/remove.ts"), "utf8"), { code: "ENOENT" });
      await assert.rejects(() => readFile(join(root, "src/old.ts"), "utf8"), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("previews and applies rename-like changes for empty files", async () => {
    const root = await mkdtemp(join(tmpdir(), "lattice-edit-empty-rename-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/empty.ts"), "", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const plan = {
        planId: "empty-rename",
        repo: { repoRoot: root },
        changes: [
          {
            kind: "rename",
            path: "src/empty.ts",
            toPath: "src/renamed.ts",
            checksumBefore: calculateEditChecksum("")
          }
        ],
        atomic: {
          strategy: "all_or_nothing",
          planHash: "sha256:empty-rename"
        },
        validation: {
          required: true,
          request: {
            repo: { repoRoot: root },
            scope: { kind: "files", files: ["src/renamed.ts"] },
            graph: { mode: "required", provider: "opcore-graph" },
            overlays: []
          }
        }
      };

      const preview = await previewEditPlan(workspace, plan);
      assert.equal(preview.ok, true);
      assert.deepEqual(preview.afterState, {
        "src/empty.ts": null,
        "src/renamed.ts": ""
      });

      const applied = await applyEditPlan(workspace, plan);
      assert.equal(applied.ok, true);
      assert.equal(await readFile(join(root, "src/renamed.ts"), "utf8"), "");
      await assert.rejects(() => readFile(join(root, "src/empty.ts"), "utf8"), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses paths that escape the repo through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "lattice-edit-symlink-root-"));
    const outside = await mkdtemp(join(tmpdir(), "lattice-edit-symlink-outside-"));
    try {
      await writeFile(join(outside, "escaped.ts"), "outside\n", "utf8");
      await symlink(outside, join(root, "link"));
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const plan = createExactEditPlan({
        repo: { repoRoot: root },
        path: "link/escaped.ts",
        content: "outside\n",
        expectedText: "outside",
        replacementText: "inside"
      });
      assert.equal(plan.ok, true);

      const applied = await applyEditPlan(workspace, plan.plan);

      assert.equal(applied.ok, false);
      assert.equal(applied.refusal.category, "unsafe_edit");
      assert.match(applied.refusal.message, /outside repository|symlink/i);
      assert.equal(await readFile(join(outside, "escaped.ts"), "utf8"), "outside\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("preserves mode and ownership metadata when replacing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "lattice-edit-mode-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      const target = join(root, "src/example.sh");
      await writeFile(target, "echo before\n", { mode: 0o755 });
      await chmodIfSupported(target, 0o755);
      const before = await stat(target);
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const plan = createExactEditPlan({
        repo: { repoRoot: root },
        path: "src/example.sh",
        content: "echo before\n",
        expectedText: "before",
        replacementText: "after"
      });
      assert.equal(plan.ok, true);

      const applied = await applyEditPlan(workspace, plan.plan);

      assert.equal(applied.ok, true);
      assert.equal(await readFile(target, "utf8"), "echo after\n");
      const after = await stat(target);
      assert.equal(after.mode & 0o777, before.mode & 0o777);
      assert.equal(after.uid, before.uid);
      assert.equal(after.gid, before.gid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back all changed files after an injected multi-file failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "lattice-edit-rollback-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/a.ts"), "a before\n", "utf8");
      await writeFile(join(root, "src/b.ts"), "b before\n", "utf8");
      const workspace = await createNodeEditWorkspace({
        repoRoot: root,
        failureHooks: {
          afterCommit(change) {
            if (change.path === "src/a.ts") throw new Error("injected after first commit");
          }
        }
      });
      const planA = createExactEditPlan({
        repo: { repoRoot: root },
        path: "src/a.ts",
        content: "a before\n",
        expectedText: "before",
        replacementText: "after"
      });
      const planB = createExactEditPlan({
        repo: { repoRoot: root },
        path: "src/b.ts",
        content: "b before\n",
        expectedText: "before",
        replacementText: "after"
      });
      assert.equal(planA.ok, true);
      assert.equal(planB.ok, true);
      const combined = {
        ...planA.plan,
        changes: [...planA.plan.changes, ...planB.plan.changes].sort((a, b) => a.path.localeCompare(b.path))
      };

      const applied = await applyEditPlan(workspace, combined);

      assert.equal(applied.ok, false);
      assert.equal(applied.rollback.completed, true);
      assert.equal(applied.rollback.restoredPaths.includes("src/a.ts"), true);
      assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "a before\n");
      assert.equal(await readFile(join(root, "src/b.ts"), "utf8"), "b before\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports temp cleanup failures after a failed atomic apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "lattice-edit-cleanup-failure-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/a.ts"), "a before\n", "utf8");
      await writeFile(join(root, "src/b.ts"), "b before\n", "utf8");
      const workspace = await createNodeEditWorkspace({
        repoRoot: root,
        failureHooks: {
          afterCommit(change) {
            if (change.path === "src/a.ts") throw new Error("injected after first commit");
          }
        }
      });
      const originalRm = workspace.fileSystem.rm;
      workspace.fileSystem.rm = async (path, options) => {
        if (path.includes(".lattice-edit-")) {
          throw Object.assign(new Error("injected temp cleanup failure"), { code: "EACCES" });
        }
        return originalRm(path, options);
      };
      const planA = createExactEditPlan({
        repo: { repoRoot: root },
        path: "src/a.ts",
        content: "a before\n",
        expectedText: "before",
        replacementText: "after"
      });
      const planB = createExactEditPlan({
        repo: { repoRoot: root },
        path: "src/b.ts",
        content: "b before\n",
        expectedText: "before",
        replacementText: "after"
      });
      assert.equal(planA.ok, true);
      assert.equal(planB.ok, true);
      const combined = {
        ...planA.plan,
        changes: [...planA.plan.changes, ...planB.plan.changes].sort((a, b) => a.path.localeCompare(b.path))
      };

      const applied = await applyEditPlan(workspace, combined);

      assert.equal(applied.ok, false);
      assert.equal(applied.rollback.completed, false);
      assert.ok(applied.rollback.cleanupFailedPaths.length >= 1);
      assert.equal(applied.rollback.cleanupFailedPaths.every((path) => path.includes(".lattice-edit-")), true);
      assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "a before\n");
      assert.equal(await readFile(join(root, "src/b.ts"), "utf8"), "b before\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function chmodIfSupported(path, mode) {
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, mode);
  } catch (error) {
    if (!["EPERM", "ENOTSUP"].includes(error?.code)) throw error;
  }
}
