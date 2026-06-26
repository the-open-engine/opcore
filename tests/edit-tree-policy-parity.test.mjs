import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeEditWorkspace, createTreeEditPlan } from "../packages/edit/dist/index.js";

test("tree planning refuses duplicate paths, private roots, unsafe paths, and symlink escapes", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "src/a.ts"), "old\n", "utf8");
    const outside = await mkdtemp(join(tmpdir(), "lattice-tree-outside-"));
    try {
      await writeFile(join(outside, "escaped.ts"), "outside\n", "utf8");
      await symlink(outside, join(root, "link"));
      const workspace = await createNodeEditWorkspace({ repoRoot: root });
      const cases = [
        ["conflict", { files: [{ path: "src/a.ts", content: "one\n" }, { path: "src/a.ts", content: "two\n" }] }],
        ["unsupported_change", { files: [{ path: ".ace/runtime/state.json", content: "{}\n" }] }],
        ["unsupported_change", { files: [{ path: ".rox-cache/state.json", content: "{}\n" }] }],
        ["unsupported_change", { files: [{ path: "node_modules/pkg/index.js", content: "module.exports = {}\n" }] }],
        ["unsupported_change", { files: [{ path: "target/debug/out.txt", content: "out\n" }] }],
        ["parent_directory", { files: [{ path: "../escape.ts", content: "x\n" }] }],
        ["absolute_path", { files: [{ path: "/tmp/escape.ts", content: "x\n" }] }],
        ["absolute_path", { files: [{ path: "//server/share/escape.ts", content: "x\n" }] }],
        ["unsafe_edit", { files: [{ path: "link/escaped.ts", content: "inside\n" }] }]
      ];
      for (const [category, request] of cases) {
        const planned = await createTreeEditPlan(workspace, { repo: { repoRoot: root }, ...request });
        assert.equal(planned.ok, false, JSON.stringify(request));
        assert.equal(planned.refusal.category, category, JSON.stringify(request));
      }
      assert.equal(await readFile(join(outside, "escaped.ts"), "utf8"), "outside\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

async function withTempRepo(run) {
  const root = await mkdtemp(join(tmpdir(), "lattice-edit-tree-policy-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
