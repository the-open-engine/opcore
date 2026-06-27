import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateValidationFileChecksum,
  createValidationFileView,
  createValidationRunner
} from "../packages/validation/dist/index.js";

describe("validation overlays", () => {
  it("reads write overlays after-state without mutating workspace content", async () => {
    const original = "export const value = 'disk';";
    const proposed = "export const value = 'overlay';";
    const workspace = testWorkspace({
      "src/index.ts": original,
      "src/unchanged.ts": "export const unchanged = true;"
    });
    const view = await createValidationFileView({
      request: request({
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: proposed
          }
        ]
      }),
      scope: scope(["src/index.ts", "src/unchanged.ts"]),
      workspace
    });

    const after = await view.readAfter("src/index.ts");
    const before = await view.readBefore("src/index.ts");
    const unchanged = await view.readAfter("src/unchanged.ts");

    assert.equal(after.status, "found");
    assert.equal(after.source, "overlay");
    assert.equal(after.content, proposed);
    assert.equal(after.checksum, calculateValidationFileChecksum(proposed));
    assert.equal(after.sourceMetadata.overlay.action, "write");
    assert.equal(before.status, "found");
    assert.equal(before.source, "workspace");
    assert.equal(before.content, original);
    assert.equal(unchanged.status, "found");
    assert.equal(unchanged.source, "workspace");
    assert.equal(unchanged.content, "export const unchanged = true;");
    assert.equal(workspace.contentOf("src/index.ts"), original);
    assert.equal(await view.exists("src/index.ts"), true);
    assert.equal(view.hasOverlay("src\\index.ts"), true);
    assert.equal(view.overlayFor("src/index.ts").checksum, calculateValidationFileChecksum(proposed));
    assert.deepEqual(
      view.overlays.map((overlay) => overlay.path),
      ["src/index.ts"]
    );
    assert.deepEqual(view.scopeFiles, ["src/index.ts", "src/unchanged.ts"]);
  });

  it("distinguishes delete overlays from missing workspace files", async () => {
    const workspace = testWorkspace({
      "src/remove.ts": "export const remove = true;"
    });
    const view = await createValidationFileView({
      request: request({
        overlays: [
          {
            path: "src/remove.ts",
            action: "delete"
          }
        ]
      }),
      scope: scope(["src/remove.ts", "src/missing.ts"]),
      workspace
    });

    const deletedAfter = await view.readAfter("src/remove.ts");
    const deletedBefore = await view.readBefore("src/remove.ts");
    const missing = await view.readAfter("src/missing.ts");

    assert.equal(deletedAfter.status, "deleted");
    assert.equal(deletedAfter.source, "overlay");
    assert.equal(deletedAfter.sourceMetadata.overlay.action, "delete");
    assert.equal(deletedBefore.status, "found");
    assert.equal(deletedBefore.content, "export const remove = true;");
    assert.equal(missing.status, "missing");
    assert.equal(missing.source, "workspace");
    assert.equal(await view.exists("src/remove.ts"), false);
    assert.equal(await view.exists("src/remove.ts", { state: "before" }), true);
  });

  it("represents rename-style edits as delete plus write overlays", async () => {
    const workspace = testWorkspace({
      "src/old.ts": "export const oldName = true;"
    });
    const view = await createValidationFileView({
      request: request({
        scope: {
          kind: "files",
          files: ["src/old.ts", "src/new.ts"]
        },
        overlays: [
          {
            path: "src/old.ts",
            action: "delete"
          },
          {
            path: "src/new.ts",
            action: "write",
            content: "export const newName = true;"
          }
        ]
      }),
      scope: scope(["src/old.ts", "src/new.ts"]),
      workspace
    });

    const oldAfter = await view.readAfter("src/old.ts");
    const newAfter = await view.readAfter("src/new.ts");

    assert.equal(oldAfter.status, "deleted");
    assert.equal(newAfter.status, "found");
    assert.equal(newAfter.source, "overlay");
    assert.equal(newAfter.content, "export const newName = true;");
    assert.equal(workspace.contentOf("src/old.ts"), "export const oldName = true;");
    assert.deepEqual(
      view.overlays.map((overlay) => `${overlay.action}:${overlay.path}`),
      ["write:src/new.ts", "delete:src/old.ts"]
    );
  });

  it("enforces checksumBefore before checks run", async () => {
    let runCount = 0;
    const result = await createValidationRunner({
      workspace: testWorkspace({
        "src/index.ts": "export const value = 'disk';"
      }),
      checks: [
        check("types", {
          run: () => {
            runCount += 1;
          }
        })
      ]
    }).runValidation(
      request({
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: "export const value = 'overlay';",
            checksumBefore: "sha256:stale"
          }
        ]
      })
    );

    assert.equal(result.status, "refused");
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.refusal.category, "conflict");
    assert.equal(result.refusal.path, "src/index.ts");
    assert.match(result.refusal.message, /checksumBefore conflict/);
    assert.deepEqual(result.manifest.checks, ["types"]);
    assert.deepEqual(result.manifest.runs ?? [], []);
    assert.equal(runCount, 0);
  });

  it("lets checks read valid checksum-protected overlay content through fileView", async () => {
    const disk = "export const value = 'disk';";
    const proposed = "export const value = 'overlay';";
    let observed;
    const result = await createValidationRunner({
      workspace: testWorkspace({
        "src/index.ts": disk
      }),
      checks: [
        check("types", {
          run: async (context) => {
            observed = await context.fileView.readAfter("src/index.ts");
            return { diagnostics: [] };
          }
        })
      ]
    }).runValidation(
      request({
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: proposed,
            checksumBefore: calculateValidationFileChecksum(disk)
          }
        ]
      })
    );

    assert.equal(result.status, "passed");
    assert.equal(observed.status, "found");
    assert.equal(observed.source, "overlay");
    assert.equal(observed.content, proposed);
  });

  it("rejects invalid overlay payloads before checks run", async () => {
    for (const overlays of [
      [
        { path: "src/index.ts", action: "write", content: "a" },
        { path: "src\\index.ts", action: "delete" }
      ],
      [{ path: "/tmp/index.ts", action: "write", content: "a" }],
      [{ path: "../index.ts", action: "write", content: "a" }],
      [{ path: "\\\\server\\share\\index.ts", action: "write", content: "a" }],
      [{ path: "", action: "write", content: "a" }]
    ]) {
      let runCount = 0;
      const result = await createValidationRunner({
        workspace: testWorkspace(),
        checks: [
          check("types", {
            run: () => {
              runCount += 1;
            }
          })
        ]
      }).runValidation(request({ overlays }));

      assert.equal(result.status, "invalid_payload");
      assert.equal(result.failure.category, "invalid_payload");
      assert.equal(runCount, 0);
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
    checks: ["types"],
    ...overrides
  };
}

function scope(files) {
  return {
    kind: "files",
    files: [...files].sort(),
    workspaceFiles: [...files].sort().map((path) => ({ path }))
  };
}

function testWorkspace(files = { "src/index.ts": "export const value = 'disk';" }) {
  const content = new Map(Object.entries(files));
  return {
    readFile: (path) => (content.has(path) ? { status: "found", content: content.get(path) } : { status: "missing" }),
    listChangedFiles: () => ({
      files: [...content.keys()]
    }),
    listStagedFiles: () => ({
      files: [...content.keys()]
    }),
    listRepoFiles: () => ({
      files: [...content.keys()]
    }),
    contentOf: (path) => content.get(path)
  };
}

function check(id, overrides = {}) {
  return {
    id,
    owner: "validation",
    adapter: "generic",
    defaultSeverity: "error",
    supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
    requiresGraph: false,
    run: () => ({
      diagnostics: []
    }),
    ...overrides
  };
}
