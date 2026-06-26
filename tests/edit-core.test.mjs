import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateEditChecksum,
  createExactEditPlan,
  createMultiEditPlan,
  createSearchReplaceEditPlan,
  createSearchReplaceFilesEditPlan
} from "../packages/edit/dist/index.js";

const repo = { repoId: "core-tests" };

describe("edit core planners", () => {
  it("creates deterministic exact edit plans", () => {
    const request = {
      repo,
      path: "src/example.ts",
      content: "const value = oldName;\n",
      expectedText: "oldName",
      replacementText: "newName"
    };

    const first = createExactEditPlan(request);
    const second = createExactEditPlan(request);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.plan.planId, second.plan.planId);
    assert.equal(first.plan.atomic.planHash, second.plan.atomic.planHash);
    assert.deepEqual(first.plan.changes, [
      {
        kind: "replace",
        path: "src/example.ts",
        content: "const value = newName;\n",
        checksumBefore: calculateEditChecksum("const value = oldName;\n"),
        checksumAfter: calculateEditChecksum("const value = newName;\n")
      }
    ]);
    assert.deepEqual(first.plan.validation.request.overlays, [
      {
        path: "src/example.ts",
        action: "write",
        content: "const value = newName;\n",
        checksumBefore: calculateEditChecksum("const value = oldName;\n")
      }
    ]);
  });

  it("requires exact edits to identify a unique match unless occurrence is explicit", () => {
    const duplicate = createExactEditPlan({
      repo,
      path: "src/example.ts",
      content: "old old old",
      expectedText: "old",
      replacementText: "new"
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.refusal.category, "unsafe_edit");
    assert.equal(duplicate.matchCount, 3);

    const occurrence = createExactEditPlan({
      repo,
      path: "src/example.ts",
      content: "old old old",
      expectedText: "old",
      replacementText: "new",
      occurrence: 1
    });
    assert.equal(occurrence.ok, true);
    assert.equal(occurrence.plan.changes[0].content, "old new old");
  });

  it("returns typed refusals for unsafe exact edit outcomes", () => {
    const base = {
      repo,
      path: "src/example.ts",
      content: "const value = 1;\n",
      expectedText: "value",
      replacementText: "name"
    };

    assert.equal(createExactEditPlan({ ...base, expectedText: "missing" }).refusal.category, "unsafe_edit");
    assert.equal(
      createExactEditPlan({ ...base, checksumBefore: "sha256:stale" }).refusal.category,
      "conflict"
    );
    assert.equal(
      createExactEditPlan({ ...base, replacementText: "value" }).refusal.category,
      "unsafe_edit"
    );
    assert.equal(createExactEditPlan({ ...base, path: "/tmp/file.ts" }).refusal.category, "absolute_path");
    assert.equal(createExactEditPlan({ ...base, path: "../file.ts" }).refusal.category, "parent_directory");
    assert.equal(
      createExactEditPlan({ ...base, repo: { repoId: "a", repoRoot: "/repo" } }).refusal.category,
      "ambiguous_repo_identity"
    );
  });

  it("merges duplicate multi-edit files and chains intermediate content", () => {
    const result = createMultiEditPlan({
      repo,
      files: [
        {
          path: "src/example.ts",
          content: "first middle last",
          operations: [
            { expectedText: "first", replacementText: "1" },
            { expectedText: "last", replacementText: "3" },
            { expectedText: "middle", replacementText: "2" }
          ]
        },
        {
          path: "src/example.ts",
          content: "1 2 3",
          operations: [
            { expectedText: "1 2", replacementText: "12" }
          ]
        }
      ]
    });

    assert.equal(result.ok, true);
    assert.equal(result.plan.changes[0].content, "12 3");
  });

  it("validates duplicate multi-edit file metadata before merging operations", () => {
    const staleChecksum = createMultiEditPlan({
      repo,
      files: [
        {
          path: "src/example.ts",
          content: "a b",
          checksumBefore: calculateEditChecksum("a b"),
          operations: [{ expectedText: "a", replacementText: "AA" }]
        },
        {
          path: "src/example.ts",
          content: "STALE",
          checksumBefore: "sha256:not-real",
          operations: [{ expectedText: "AA", replacementText: "BB" }]
        }
      ]
    });
    assert.equal(staleChecksum.ok, false);
    assert.equal(staleChecksum.refusal.category, "conflict");

    const mismatchedContent = createMultiEditPlan({
      repo,
      files: [
        {
          path: "src/example.ts",
          content: "a b",
          operations: [{ expectedText: "a", replacementText: "AA" }]
        },
        {
          path: "src/example.ts",
          content: "unrelated",
          operations: [{ expectedText: "AA", replacementText: "BB" }]
        }
      ]
    });
    assert.equal(mismatchedContent.ok, false);
    assert.equal(mismatchedContent.refusal.category, "conflict");
  });

  it("rejects duplicate non-replaceAll matches in multi-edit operations", () => {
    const duplicate = createMultiEditPlan({
      repo,
      files: [
        {
          path: "src/example.ts",
          content: "alpha beta",
          operations: [
            { expectedText: "alpha", replacementText: "one" },
            { expectedText: "alpha", replacementText: "two" }
          ]
        }
      ]
    });

    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.refusal.category, "unsafe_edit");

    const replaceAll = createMultiEditPlan({
      repo,
      files: [
        {
          path: "src/example.ts",
          content: "alpha alpha",
          operations: [
            { expectedText: "alpha", replacementText: "one", replaceAll: true }
          ]
        }
      ]
    });
    assert.equal(replaceAll.ok, true);
    assert.equal(replaceAll.plan.changes[0].content, "one one");
  });

  it("plans literal search-replace with explicit ambiguity controls", () => {
    const ambiguous = createSearchReplaceEditPlan({
      repo,
      path: "src/example.ts",
      content: "red blue red",
      search: "red",
      replace: "green"
    });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.refusal.category, "unsafe_edit");
    assert.equal(ambiguous.matchCount, 2);

    const all = createSearchReplaceEditPlan({
      repo,
      path: "src/example.ts",
      content: "red blue red",
      search: "red",
      replace: "green",
      replaceAll: true
    });
    assert.equal(all.ok, true);
    assert.equal(all.matchCount, 2);
    assert.equal(all.plan.changes[0].content, "green blue green");

    const expectedCountWithoutReplaceAll = createSearchReplaceEditPlan({
      repo,
      path: "src/example.ts",
      content: "red blue red",
      search: "red",
      replace: "green",
      expectedCount: 2
    });
    assert.equal(expectedCountWithoutReplaceAll.ok, false);
    assert.equal(expectedCountWithoutReplaceAll.refusal.category, "unsafe_edit");

    const expectedCount = createSearchReplaceEditPlan({
      repo,
      path: "src/example.ts",
      content: "red blue red",
      search: "red",
      replace: "green",
      expectedCount: 2,
      replaceAll: true
    });
    assert.equal(expectedCount.ok, true);
    assert.equal(expectedCount.plan.changes[0].content, "green blue green");
  });

  it("plans file search-replace no-ops and regex backrefs", () => {
    const noMatch = createSearchReplaceFilesEditPlan({
      repo,
      files: [{ path: "src/example.ts", content: "red blue" }],
      operations: [{ search: "missing", replace: "green" }]
    });
    assert.equal(noMatch.ok, true);
    assert.equal(noMatch.matchCount, 0);
    assert.deepEqual(noMatch.plan.changes, []);

    const regex = createSearchReplaceFilesEditPlan({
      repo,
      files: [{ path: "src/example.ts", content: "Name: ALPHA\n" }],
      operations: [{ search: "name: (alpha)", replace: "id:$1", regex: true, caseInsensitive: true }]
    });
    assert.equal(regex.ok, true);
    assert.equal(regex.plan.changes[0].content, "id:ALPHA\n");
  });

  it("rejects duplicate file search-replace matches unless replaceAll is true", () => {
    const duplicate = createSearchReplaceFilesEditPlan({
      repo,
      files: [{ path: "src/example.ts", content: "red blue red" }],
      operations: [{ search: "red", replace: "green" }]
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.refusal.category, "unsafe_edit");
    assert.equal(duplicate.matchCount, 2);

    const replaceAll = createSearchReplaceFilesEditPlan({
      repo,
      files: [{ path: "src/example.ts", content: "red blue red" }],
      operations: [{ search: "red", replace: "green", replaceAll: true }]
    });
    assert.equal(replaceAll.ok, true);
    assert.equal(replaceAll.matchCount, 2);
    assert.equal(replaceAll.plan.changes[0].content, "green blue green");
  });
});
