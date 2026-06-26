import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEditPlan,
  calculateEditChecksum,
  createNodeEditWorkspace,
  createTreeEditPlan,
  previewEditPlan
} from "../packages/edit/dist/index.js";

describe("edit tree planning", () => {
  it("plans sorted create, replace, delete, no-op, and rename-like delete/create changes", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/replace.ts"), "old\n", "utf8");
      await writeFile(join(root, "src/delete.ts"), "remove\n", "utf8");
      await writeFile(join(root, "src/old-name.ts"), "move me\n", "utf8");
      await writeFile(join(root, "src/noop.ts"), "same\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createTreeEditPlan(workspace, {
        repo: { repoRoot: root },
        validation: { required: false },
        files: [
          { path: "src/new-name.ts", content: "move me\n" },
          { path: "src/noop.ts", content: "same\n" },
          { path: "src/create.ts", content: "created\n" },
          { path: "src/delete.ts", delete: true },
          { path: "src/replace.ts", content: "new\n" },
          { path: "src/old-name.ts", delete: true }
        ]
      });

      assert.equal(planned.ok, true);
      assert.deepEqual(planned.plan.changes.map((change) => `${change.kind}:${change.path}`), [
        "create:src/create.ts",
        "delete:src/delete.ts",
        "create:src/new-name.ts",
        "delete:src/old-name.ts",
        "replace:src/replace.ts"
      ]);
      assert.equal(planned.afterState["src/noop.ts"], undefined);
    });
  });

  it("refuses checksum conflicts, ignored targets, generated targets, and binary content", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, ".gitignore"), "ignored/\n", "utf8");
      await mkdir(join(root, "ignored"), { recursive: true });
      await mkdir(join(root, ".lattice/graph"), { recursive: true });
      await writeFile(join(root, "src/a.ts"), "old\n", "utf8");
      await writeFile(join(root, "src/binary.bin"), new Uint8Array([0, 1, 2]));
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const cases = [
        ["conflict", { files: [{ path: "src/a.ts", content: "new\n", checksumBefore: "sha256:stale" }] }],
        ["unsupported_change", { files: [{ path: "ignored/a.ts", content: "new\n" }] }],
        ["unsupported_change", { files: [{ path: ".lattice/graph/state.json", content: "new\n" }] }],
        ["unsupported_change", { files: [{ path: "src/binary.bin", content: "text\n" }] }],
        ["unsupported_change", { files: [{ path: "src/proposed.ts", content: "\u0000bad" }] }]
      ];
      for (const [category, request] of cases) {
        const planned = await createTreeEditPlan(workspace, { repo: { repoRoot: root }, ...request });
        assert.equal(planned.ok, false, category);
        assert.equal(planned.refusal.category, category);
      }
    });
  });

  it("honors ordered .gitignore negations for explicitly unignored targets", async () => {
    await withTempRepo(async (root) => {
      await writeFile(
        join(root, ".gitignore"),
        ".zeroshot/*\n!.zeroshot/settings.json\n.env.*\n!.env.example\nignored/**\n!ignored/keep.ts\n",
        "utf8"
      );
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createTreeEditPlan(workspace, {
        repo: { repoRoot: root },
        files: [
          { path: ".zeroshot/settings.json", content: "{}\n" },
          { path: ".env.example", content: "EXAMPLE=1\n" },
          { path: "ignored/keep.ts", content: "keep\n" }
        ]
      });

      assert.equal(planned.ok, true);
      assert.deepEqual(planned.plan.changes.map((change) => change.path), [
        ".env.example",
        ".zeroshot/settings.json",
        "ignored/keep.ts"
      ]);
    });
  });

  it("refuses descendants whose parent directories are ignored by root gitignore globs", async () => {
    await withTempRepo(async (root) => {
      await writeFile(
        join(root, ".gitignore"),
        ".zeroshot/*\n!.zeroshot/\n!.zeroshot/settings.json\nignored/**\n",
        "utf8"
      );
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const cases = [
        ".zeroshot/worktrees/a.ts",
        "ignored/deep/a.ts"
      ];

      for (const path of cases) {
        const planned = await createTreeEditPlan(workspace, {
          repo: { repoRoot: root },
          files: [{ path, content: "new\n" }]
        });

        assert.equal(planned.ok, false, path);
        assert.equal(planned.refusal.category, "unsupported_change", path);
      }
    });
  });

  it("refuses nested directory targets ignored by root gitignore", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, ".gitignore"), "ignored/\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createTreeEditPlan(workspace, {
        repo: { repoRoot: root },
        files: [{ path: "src/ignored/a.ts", content: "new\n" }]
      });

      assert.equal(planned.ok, false);
      assert.equal(planned.refusal.category, "unsupported_change");
    });
  });

  it("narrows large file sets with fileContains", async () => {
    await withTempRepo(async (root) => {
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const planned = await createTreeEditPlan(workspace, {
        repo: { repoRoot: root },
        fileContains: "KEEP",
        files: Array.from({ length: 25 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          content: index === 17 ? "export const marker = 'KEEP';\n" : "export const marker = 'skip';\n"
        }))
      });

      assert.equal(planned.ok, true);
      assert.deepEqual(planned.plan.changes.map((change) => change.path), ["src/file-17.ts"]);
    });
  });

  it("previews without writes and rolls back multi-file apply failures", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/a.ts"), "a before\n", "utf8");
      await writeFile(join(root, "src/b.ts"), "b before\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const planned = await createTreeEditPlan(workspace, {
        repo: { repoRoot: root },
        validation: { required: false },
        files: [
          { path: "src/a.ts", content: "a after\n", checksumBefore: calculateEditChecksum("a before\n") },
          { path: "src/b.ts", content: "b after\n", checksumBefore: calculateEditChecksum("b before\n") }
        ]
      });
      assert.equal(planned.ok, true);

      const preview = await previewEditPlan(workspace, planned.plan);
      assert.equal(preview.ok, true);
      assert.equal(preview.afterState["src/a.ts"], "a after\n");
      assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "a before\n");

      const failingWorkspace = await createNodeEditWorkspace({
        repoRoot: root,
        failureHooks: {
          afterCommit(change) {
            if (change.path === "src/a.ts") throw new Error("injected tree failure");
          }
        }
      });
      const applied = await applyEditPlan(failingWorkspace, planned.plan);
      assert.equal(applied.ok, false);
      assert.equal(applied.rollback.completed, true);
      assert.deepEqual(applied.rollback.failedPaths, []);
      assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "a before\n");
      assert.equal(await readFile(join(root, "src/b.ts"), "utf8"), "b before\n");
    });
  });
});

async function withTempRepo(run) {
  const root = await mkdtemp(join(tmpdir(), "lattice-edit-tree-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
