import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createValidationRequest, createValidationRequestFromChanges, createValidationRequestFromPlan } from "../packages/edit/dist/index.js";

describe("edit validation request contract boundary", () => {
  it("builds graph-required validation requests from public contracts", () => {
    const request = createValidationRequest(
      ["src\\index.ts"],
      "current-worktree",
      [
        {
          path: "src\\index.ts",
          action: "write",
          content: "export {};",
          checksumBefore: "sha256:before"
        },
        {
          path: "src/remove.ts",
          action: "delete"
        }
      ]
    );
    assert.deepEqual(request.repo, { repoId: "current-worktree" });
    assert.deepEqual(request.scope, { kind: "files", files: ["src/index.ts"] });
    assert.deepEqual(request.graph, { mode: "required", provider: "lattice-graph" });
    assert.deepEqual(
      request.overlays.map((overlay) => overlay.path),
      ["src/index.ts", "src/remove.ts"]
    );
  });

  it("rejects invalid files and overlays through contract validation", () => {
    assert.throws(() => createValidationRequest(["../src/index.ts"]), /escape/);
    assert.throws(
      () =>
        createValidationRequest(["src/index.ts"], "current-worktree", [
          {
            path: "src/index.ts",
            action: "write"
          }
        ]),
      /content/
    );
    assert.throws(
      () =>
        createValidationRequest(["src/index.ts"], "current-worktree", [
          {
            path: "src/index.ts",
            action: "delete",
            content: ""
          }
        ]),
      /must not include content/
    );
  });

  it("keeps edit source independent of validation implementation package", () => {
    const sources = readdirSync(new URL("../packages/edit/src", import.meta.url))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => readFileSync(new URL(`../packages/edit/src/${entry}`, import.meta.url), "utf8"));
    assert.equal(sources.some((source) => source.includes("@the-open-engine/lattice-validation")), false);
    assert.equal(sources.some((source) => source.includes("@the-open-engine/lattice-contracts")), true);
  });

  it("converts create, replace, delete, and rename changes to validation overlays", () => {
    const plan = {
      planId: "edit-test",
      repo: { repoId: "current-worktree" },
      changes: [
        {
          kind: "create",
          path: "src/create.ts",
          content: "created\n"
        },
        {
          kind: "replace",
          path: "src/replace.ts",
          content: "after\n",
          checksumBefore: "sha256:before"
        },
        {
          kind: "delete",
          path: "src/delete.ts",
          checksumBefore: "sha256:delete"
        },
        {
          kind: "rename",
          path: "src/old.ts",
          toPath: "src/new.ts",
          checksumBefore: "sha256:old"
        }
      ],
      atomic: {
        strategy: "all_or_nothing",
        planHash: "sha256:plan"
      },
      validation: {
        required: true,
        request: {
          requestId: "edit-validation-1",
          repo: { repoId: "seed-repo" },
          scope: { kind: "files", files: ["src/seed.ts", "src/create.ts"] },
          graph: { mode: "optional", provider: "custom-graph" },
          checks: ["typescript.syntax", "typescript.types"],
          overlays: []
        }
      }
    };

    const request = createValidationRequestFromPlan(plan, {
      "src/create.ts": "created\n",
      "src/replace.ts": "after\n",
      "src/delete.ts": null,
      "src/old.ts": null,
      "src/new.ts": "renamed\n"
    });

    assert.equal(request.requestId, "edit-validation-1");
    assert.deepEqual(request.repo, { repoId: "current-worktree" });
    assert.deepEqual(request.graph, { mode: "optional", provider: "custom-graph" });
    assert.deepEqual(request.checks, ["typescript.syntax", "typescript.types"]);
    assert.deepEqual(request.scope.files, [
      "src/create.ts",
      "src/delete.ts",
      "src/new.ts",
      "src/old.ts",
      "src/replace.ts",
      "src/seed.ts"
    ]);
    assert.deepEqual(request.overlays, [
      {
        path: "src/create.ts",
        action: "write",
        content: "created\n",
        checksumBefore: undefined
      },
      {
        path: "src/replace.ts",
        action: "write",
        content: "after\n",
        checksumBefore: "sha256:before"
      },
      {
        path: "src/delete.ts",
        action: "delete",
        checksumBefore: "sha256:delete"
      },
      {
        path: "src/old.ts",
        action: "delete",
        checksumBefore: "sha256:old"
      },
      {
        path: "src/new.ts",
        action: "write",
        content: "renamed\n",
        checksumBefore: undefined
      }
    ]);
  });

  it("requires rename after-state content instead of fabricating empty validation overlays", () => {
    assert.throws(
      () => createValidationRequestFromChanges(
        { repoId: "current-worktree" },
        [{ kind: "rename", path: "src/old.md", toPath: "src/new.md", checksumBefore: "sha256:old" }],
        { "src/old.md": null }
      ),
      /Planned after-state content is required for src\/new\.md/
    );
  });

  it("preserves non-files validation scope while still emitting after-state overlays", () => {
    const plan = {
      planId: "edit-test",
      repo: { repoRoot: "/repo" },
      changes: [
        {
          kind: "replace",
          path: "src/replace.ts",
          content: "after\n"
        }
      ],
      atomic: {
        strategy: "all_or_nothing",
        planHash: "sha256:plan"
      },
      validation: {
        required: true,
        request: {
          requestId: "repo-wide",
          repo: { repoRoot: "/other" },
          scope: { kind: "repo" },
          graph: { mode: "required", provider: "lattice-graph" },
          overlays: []
        }
      }
    };

    const request = createValidationRequestFromPlan(plan, {
      "src/replace.ts": "after\n"
    });

    assert.deepEqual(request.repo, { repoRoot: "/repo" });
    assert.deepEqual(request.scope, { kind: "repo" });
    assert.deepEqual(request.overlays, [
      {
        path: "src/replace.ts",
        action: "write",
        content: "after\n",
        checksumBefore: undefined
      }
    ]);
  });
});
