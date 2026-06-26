import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeEditWorkspace,
  createPatchEditPlan,
  parseCodexApplyPatch,
  previewEditPlan
} from "../packages/edit/dist/index.js";

test("Codex apply_patch add/delete/update/move/EOF plans without writes", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "src/a.ts"), "one\nkeep\n", "utf8");
    await writeFile(join(root, "src/remove.ts"), "remove\n", "utf8");
    await writeFile(join(root, "src/old-name.ts"), "move old\n", "utf8");
    await writeFile(join(root, "src/eof.ts"), "head\ntail\n", "utf8");
    const workspace = await createNodeEditWorkspace({ repoRoot: root });
    const planned = await createPatchEditPlan(workspace, {
      repo: { repoRoot: root },
      validation: { required: false },
      patch: codexPatch([
        "*** Add File: src/new.ts",
        "+created",
        "+file",
        "*** Delete File: src/remove.ts",
        "*** Update File: src/a.ts",
        "@@",
        "-one",
        "+two",
        " keep",
        "*** Update File: src/old-name.ts",
        "*** Move to: src/new-name.ts",
        "@@",
        "-move old",
        "+move new",
        "*** Update File: src/eof.ts",
        "@@",
        " tail",
        "*** End of File"
      ])
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.afterState["src/a.ts"], "two\nkeep\n");
    assert.equal(planned.afterState["src/new.ts"], "created\nfile\n");
    assert.equal(planned.afterState["src/remove.ts"], null);
    assert.equal(planned.afterState["src/old-name.ts"], null);
    assert.equal(planned.afterState["src/new-name.ts"], "move new\n");
    assert.equal(planned.afterState["src/eof.ts"], undefined);
    assert.equal((await previewEditPlan(workspace, planned.plan)).ok, true);
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "one\nkeep\n");
    await assert.rejects(() => readFile(join(root, "src/new.ts"), "utf8"), { code: "ENOENT" });
  });
});

test("Codex repeated sections apply cumulatively and contradictory sections refuse", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "src/repeat.ts"), "a\nb\nc\n", "utf8");
    const workspace = await createNodeEditWorkspace({ repoRoot: root });
    const planned = await createPatchEditPlan(workspace, {
      repo: { repoRoot: root },
      validation: { required: false },
      patch: codexPatch([
        "*** Update File: src/repeat.ts",
        "@@",
        "-a",
        "+aa",
        " b",
        "*** Update File: src/repeat.ts",
        "@@",
        " aa",
        "-b",
        "+bb"
      ])
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.afterState["src/repeat.ts"], "aa\nbb\nc\n");
    assert.equal(await readFile(join(root, "src/repeat.ts"), "utf8"), "a\nb\nc\n");
    const contradictory = await createPatchEditPlan(workspace, {
      repo: { repoRoot: root },
      patch: codexPatch(["*** Add File: src/contradict.ts", "+created", "*** Delete File: src/contradict.ts"])
    });
    assert.equal(contradictory.ok, false);
    assert.equal(contradictory.refusal.category, "conflict");
  });
});

test("Codex parser returns typed sections and malformed/unsupported refusals", () => {
  const parsed = parseCodexApplyPatch(codexPatch([
    "*** Add File: src/new.ts",
    "+new",
    "*** Delete File: src/remove.ts",
    "*** Update File: src/a.ts",
    "*** Move to: src/b.ts",
    "@@ function old",
    "-old",
    "+new",
    "*** End of File"
  ]));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.sections.map((section) => section.kind), ["add", "delete", "update"]);
  assert.equal(parsed.sections[2].moveTo, "src/b.ts");
  assert.equal(parsed.sections[2].hunks[0].endOfFile, true);
  for (const [label, patch] of malformedCodexPatches()) {
    const malformed = parseCodexApplyPatch(patch);
    assert.equal(malformed.ok, false, label);
    assert.equal(malformed.refusal.category, "unsupported_change", label);
  }
});

test("unified patch 3way and stale dirty hunks refuse without writes", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "src/a.ts"), "dirty\n", "utf8");
    const workspace = await createNodeEditWorkspace({ repoRoot: root });
    const threeWay = await createPatchEditPlan(workspace, { repo: { repoRoot: root }, patch: patchFor("src/a.ts", "dirty", "merged"), threeWay: true });
    assert.equal(threeWay.ok, false);
    assert.equal(threeWay.refusal.category, "unsupported_change");
    const stale = await createPatchEditPlan(workspace, { repo: { repoRoot: root }, patch: patchFor("src/a.ts", "clean", "merged") });
    assert.equal(stale.ok, false);
    assert.equal(stale.refusal.category, "conflict");
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "dirty\n");
  });
});

function malformedCodexPatches() {
  return [
    ["missing end", "*** Begin Patch\n*** Add File: src/a.ts\n+x\n"],
    ["trailing content", "*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch\nx\n"],
    ["mode", "*** Begin Patch\n*** Update File: src/a.ts\nold mode 100644\nnew mode 100755\n*** End Patch\n"],
    ["submodule", "*** Begin Patch\n*** Update File: src/a.ts\nnew file mode 160000\n*** End Patch\n"],
    ["binary", "*** Begin Patch\n*** Update File: src/a.ts\nGIT binary patch\n*** End Patch\n"],
    ["malformed add", "*** Begin Patch\n*** Add File: src/a.ts\nx\n*** End Patch\n"]
  ];
}

function patchFor(path, before, after) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-${before}`, `+${after}`, ""].join("\n");
}

function codexPatch(lines) {
  return ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");
}

async function withTempRepo(run) {
  const root = await mkdtemp(join(tmpdir(), "lattice-edit-codex-patch-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
