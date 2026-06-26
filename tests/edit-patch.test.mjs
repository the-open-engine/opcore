import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeEditWorkspace,
  createPatchEditPlan,
  parseUnifiedDiffPatch,
  previewEditPlan
} from "../packages/edit/dist/index.js";

describe("edit patch planning", () => {
  it("plans deterministic replace, create, and delete changes without writing", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/a.ts"), "one\ntwo\n", "utf8");
      await writeFile(join(root, "src/remove.ts"), "bye\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createPatchEditPlan(workspace, {
        repo: { repoRoot: root },
        validation: { required: false },
        patch: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,2 +1,2 @@",
          " one",
          "-two",
          "+three",
          "diff --git a/src/new.ts b/src/new.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/new.ts",
          "@@ -0,0 +1,2 @@",
          "+new",
          "+file",
          "diff --git a/src/remove.ts b/src/remove.ts",
          "deleted file mode 100644",
          "--- a/src/remove.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-bye",
          ""
        ].join("\n")
      });

      assert.equal(planned.ok, true);
      assert.deepEqual(planned.plan.changes.map((change) => `${change.kind}:${change.path}`), [
        "replace:src/a.ts",
        "create:src/new.ts",
        "delete:src/remove.ts"
      ]);
      assert.equal(planned.afterState["src/a.ts"], "one\nthree\n");
      assert.equal(planned.afterState["src/new.ts"], "new\nfile\n");
      assert.equal(planned.afterState["src/remove.ts"], null);

      const preview = await previewEditPlan(workspace, planned.plan);
      assert.equal(preview.ok, true);
      assert.equal(preview.afterState["src/a.ts"], "one\nthree\n");
      assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "one\ntwo\n");
      await assert.rejects(() => readFile(join(root, "src/new.ts"), "utf8"), { code: "ENOENT" });
      assert.equal(await readFile(join(root, "src/remove.ts"), "utf8"), "bye\n");
    });
  });

  it("preserves CRLF, UTF-8 BOM, and missing final newline markers", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/bom.ts"), "\uFEFFalpha\r\nbeta", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createPatchEditPlan(workspace, {
        repo: { repoRoot: root },
        patch: [
          "diff --git a/src/bom.ts b/src/bom.ts",
          "--- a/src/bom.ts",
          "+++ b/src/bom.ts",
          "@@ -1,2 +1,2 @@",
          " \uFEFFalpha\r",
          "-beta",
          "\\ No newline at end of file",
          "+beta2",
          "\\ No newline at end of file",
          ""
        ].join("\n")
      });

      assert.equal(planned.ok, true);
      assert.equal(planned.plan.changes[0].content, "\uFEFFalpha\r\nbeta2");
    });
  });

  it("parses deleted content lines that look like file headers", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/header-like.ts"), "keep\n-- heading\nend\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createPatchEditPlan(workspace, {
        repo: { repoRoot: root },
        patch: [
          "diff --git a/src/header-like.ts b/src/header-like.ts",
          "--- a/src/header-like.ts",
          "+++ b/src/header-like.ts",
          "@@ -1,3 +1,2 @@",
          " keep",
          "--- heading",
          " end",
          ""
        ].join("\n")
      });

      assert.equal(planned.ok, true);
      assert.equal(planned.plan.changes[0].content, "keep\nend\n");
    });
  });

  it("plans zero-context insertions after the old-side anchor line", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/a.ts"), "a\nb\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createPatchEditPlan(workspace, {
        repo: { repoRoot: root },
        patch: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,0 +2 @@",
          "+x",
          ""
        ].join("\n")
      });

      assert.equal(planned.ok, true);
      assert.equal(planned.plan.changes[0].content, "a\nx\nb\n");
    });
  });

  it("plans later zero-context insertions against old-file anchors", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/a.ts"), "a\nb\nc\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createPatchEditPlan(workspace, {
        repo: { repoRoot: root },
        patch: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,0 +2 @@",
          "+x",
          "@@ -2,0 +4 @@",
          "+y",
          ""
        ].join("\n")
      });

      assert.equal(planned.ok, true);
      assert.equal(planned.plan.changes[0].content, "a\nx\nb\ny\nc\n");
    });
  });

  it("plans zero-context insertions after deletions using old-file anchors", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/a.ts"), "a\nb\nc\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createPatchEditPlan(workspace, {
        repo: { repoRoot: root },
        patch: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -2 +1,0 @@ a",
          "-b",
          "@@ -3,0 +3 @@ c",
          "+y",
          ""
        ].join("\n")
      });

      assert.equal(planned.ok, true);
      assert.equal(planned.plan.changes[0].content, "a\nc\ny\n");
    });
  });

  it("plans zero-context insertions at beginning", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/a.ts"), "a\nb\n", "utf8");
      const workspace = await createNodeEditWorkspace({ repoRoot: root });

      const planned = await createPatchEditPlan(workspace, {
        repo: { repoRoot: root },
        patch: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -0,0 +1 @@",
          "+x",
          ""
        ].join("\n")
      });

      assert.equal(planned.ok, true);
      assert.equal(planned.plan.changes[0].content, "x\na\nb\n");
    });
  });

  it("returns typed parser refusals for unsupported patch features", () => {
    const validPatch = ["diff --git a/c.ts b/c.ts", "--- a/c.ts", "+++ b/c.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
    const cases = [
      ["garbage before valid file", `garbage\n${validPatch}`],
      ["rename metadata before valid file", `rename from a.ts\nrename to b.ts\n${validPatch}`],
      ["binary", "diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ\n"],
      ["mode", "diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n"],
      ["submodule", "diff --git a/sub b/sub\nnew file mode 160000\n--- /dev/null\n+++ b/sub\n@@ -0,0 +1 @@\n+abc\n"],
      ["rename", "diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n"],
      [
        "rename-only before valid file",
        [
          "diff --git a/a.ts b/b.ts",
          "similarity index 100%",
          "rename from a.ts",
          "rename to b.ts",
          "diff --git a/c.ts b/c.ts",
          "--- a/c.ts",
          "+++ b/c.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          ""
        ].join("\n")
      ],
      ["malformed", "--- a/a.ts\n+++ b/a.ts\n@@ nope @@\n x\n"],
      ["trailing garbage", "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ngarbage\n"],
      ["out-of-order", "--- a/a.ts\n+++ b/a.ts\n@@ -2 +2 @@\n-b\n+c\n@@ -1 +1 @@\n-a\n+d\n"]
    ];
    for (const [label, patch] of cases) {
      const parsed = parseUnifiedDiffPatch(patch);
      assert.equal(parsed.ok, false, label);
      assert.equal(typeof parsed.refusal.category, "string", label);
    }
  });

  it("refuses stale context, unsafe paths, generated targets, symlink escapes, and binary content", async () => {
    await withTempRepo(async (root) => {
      await writeFile(join(root, "src/a.ts"), "actual\n", "utf8");
      await mkdir(join(root, ".lattice/graph"), { recursive: true });
      await writeFile(join(root, ".lattice/graph/state.json"), "old\n", "utf8");
      await writeFile(join(root, "src/binary.bin"), new Uint8Array([0, 1, 2, 3]));
      const outside = await mkdtemp(join(tmpdir(), "lattice-patch-outside-"));
      try {
        await writeFile(join(outside, "escaped.ts"), "outside\n", "utf8");
        await symlink(outside, join(root, "link"));
        const workspace = await createNodeEditWorkspace({ repoRoot: root });
        const cases = [
          ["conflict", patchFor("src/a.ts", "missing", "next")],
          ["parent_directory", patchFor("../escape.ts", "old", "new")],
          ["absolute_path", "--- /tmp/a.ts\n+++ /tmp/a.ts\n@@ -1 +1 @@\n-old\n+new\n"],
          ["absolute_path", "--- //server/share/a.ts\n+++ //server/share/a.ts\n@@ -1 +1 @@\n-old\n+new\n"],
          ["unsafe_edit", patchFor("link/escaped.ts", "outside", "inside")],
          ["unsupported_change", patchFor(".lattice/graph/state.json", "old", "new")],
          ["unsupported_change", patchFor("src/binary.bin", "\u0000\u0001\u0002\u0003", "text")]
        ];
        for (const [category, patch] of cases) {
          const planned = await createPatchEditPlan(workspace, { repo: { repoRoot: root }, patch });
          assert.equal(planned.ok, false, category);
          assert.equal(planned.refusal.category, category);
        }
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("refuses patch targets whose parent directories are ignored by root gitignore globs", async () => {
    await withTempRepo(async (root) => {
      await writeFile(
        join(root, ".gitignore"),
        ".zeroshot/*\n!.zeroshot/\n!.zeroshot/settings.json\nignored/**\n",
        "utf8"
      );
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const cases = [
        createPatchFor(".zeroshot/worktrees/a.ts", "new\n"),
        createPatchFor("ignored/deep/a.ts", "new\n")
      ];

      for (const patch of cases) {
        const planned = await createPatchEditPlan(workspace, { repo: { repoRoot: root }, patch });
        assert.equal(planned.ok, false, patch);
        assert.equal(planned.refusal.category, "unsupported_change", patch);
      }
    });
  });
});

function patchFor(path, before, after) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}

function createPatchFor(path, content) {
  return [
    `diff --git a/${path} b/${path}`,
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    `+${content.replace(/\n$/, "")}`,
    ""
  ].join("\n");
}

async function withTempRepo(run) {
  const root = await mkdtemp(join(tmpdir(), "lattice-edit-patch-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
