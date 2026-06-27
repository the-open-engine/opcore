import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveValidationScope } from "../packages/validation/dist/index.js";

describe("validation scope resolution", () => {
  it("normalizes, dedupes, sorts files scope paths and includes overlays", async () => {
    const resolved = await resolveValidationScope(
      request({
        scope: {
          kind: "files",
          files: ["src\\b.ts", "src/a.ts", "src/a.ts"]
        },
        overlays: [
          {
            path: "src\\overlay.ts",
            action: "write",
            content: "export {};"
          }
        ]
      }),
      workspace()
    );

    assert.deepEqual(resolved.files, ["src/a.ts", "src/b.ts", "src/overlay.ts"]);
    assert.equal(resolved.kind, "files");
  });

  it("rejects absolute, parent traversal, and UNC paths", async () => {
    for (const path of ["/tmp/a.ts", "../a.ts", "\\tmp\\a.ts", "\\\\server\\share\\a.ts"]) {
      await assert.rejects(
        () =>
          resolveValidationScope(
            request({
              scope: {
                kind: "files",
                files: [path]
              }
            }),
            workspace()
          ),
        /absolute|escape/
      );
    }
  });

  it("restricts package scope expansion to packageRoot", async () => {
    await assert.rejects(
      () =>
        resolveValidationScope(
          request({
            scope: {
              kind: "package",
              packageName: "@covibes/app",
              packageRoot: "packages/app"
            }
          }),
          workspace({
            listPackageFiles: () => ({
              files: ["packages/app/src/index.ts", "packages/other/src/index.ts"]
            })
          })
        ),
      /outside package root/
    );

    const resolved = await resolveValidationScope(
      request({
        scope: {
          kind: "package",
          packageName: "@covibes/app",
          packageRoot: "packages/app"
        }
      }),
      workspace({
        listPackageFiles: () => ({
          files: ["packages/app/src/b.ts", "packages/app/src/a.ts"]
        })
      })
    );

    assert.deepEqual(resolved.files, ["packages/app/src/a.ts", "packages/app/src/b.ts"]);
    assert.equal(resolved.packageRoot, "packages/app");
  });

  it("distinguishes changed and staged unavailable state from valid empty sets", async () => {
    await assert.rejects(
      () =>
        resolveValidationScope(
          request({
            scope: {
              kind: "changed",
              baseRef: "origin/main"
            }
          }),
          workspace({
            listChangedFiles: () => ({
              unavailable: true,
              message: "Git worktree unavailable",
              files: []
            })
          })
        ),
      /Git worktree unavailable/
    );

    const changed = await resolveValidationScope(
      request({
        scope: {
          kind: "changed",
          baseRef: "origin/main"
        }
      }),
      workspace({
        listChangedFiles: () => ({
          files: []
        })
      })
    );
    const staged = await resolveValidationScope(
      request({
        scope: {
          kind: "staged"
        }
      }),
      workspace({
        listStagedFiles: () => ({
          files: []
        })
      })
    );

    assert.deepEqual(changed.files, []);
    assert.deepEqual(staged.files, []);
  });

  it("resolves tree scope from workspace tree files and includes tree metadata", async () => {
    const resolved = await resolveValidationScope(
      request({
        scope: {
          kind: "tree",
          treeRef: "HEAD",
          changedFrom: "origin/main"
        }
      }),
      workspace({
        listTreeFiles: (treeRef, changedFrom) => ({
          files: [
            { path: "src/deleted.ts", status: "deleted" },
            { path: "src/tree.ts", status: "modified" }
          ],
          treeRef,
          changedFrom
        })
      })
    );

    assert.equal(resolved.kind, "tree");
    assert.equal(resolved.treeRef, "HEAD");
    assert.equal(resolved.changedFrom, "origin/main");
    assert.deepEqual(resolved.files, ["src/deleted.ts", "src/tree.ts"]);
    assert.equal(resolved.workspaceFiles.find((file) => file.path === "src/deleted.ts").status, "deleted");
  });

  it("resolves all and repo through the workspace without shelling out", async () => {
    for (const kind of ["all", "repo"]) {
      const resolved = await resolveValidationScope(
        request({
          scope: {
            kind
          }
        }),
        workspace({
          listRepoFiles: () => ({
            files: ["src/z.ts", "src/a.ts"]
          })
        })
      );
      assert.deepEqual(resolved.files, ["src/a.ts", "src/z.ts"]);
    }
  });
});

function request(overrides = {}) {
  return {
    requestId: "validation-1",
    repo: {
      repoId: "opcore"
    },
    scope: {
      kind: "files",
      files: ["src/index.ts"]
    },
    graph: {
      mode: "optional",
      provider: "opcore-graph"
    },
    overlays: [],
    ...overrides
  };
}

function workspace(overrides = {}) {
  const files = new Map([["src/index.ts", "export const value = true;"]]);
  return {
    readFile: (path) => (files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }),
    listChangedFiles: () => ({
      files: ["src/changed.ts"]
    }),
    listTreeFiles: () => ({
      files: ["src/tree.ts"]
    }),
    listStagedFiles: () => ({
      files: ["src/staged.ts"]
    }),
    listRepoFiles: () => ({
      files: ["src/index.ts"]
    }),
    ...overrides
  };
}
