import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createCheckCommandAdapter,
  createValidateCommandAdapter,
  createNodeValidationWorkspace
} from "../packages/validation/dist/index.js";

describe("validation command adapters", () => {
  it("builds files, staged, changed, tree, and all scope requests", async () => {
    const observed = [];
    const adapter = createCheckCommandAdapter({
      checks: [scopeCheck(observed)],
      workspace: workspace()
    });

    const filesResult = await adapter(request(["--files", "src/index.ts"]));
    assert.equal(filesResult.validationResult.status, "passed");
    assert.equal(filesResult.message, "opcore validation complete.");
    assert.equal((await adapter(request(["files", "--files", "src/index.ts"]))).validationResult.status, "passed");
    assert.equal((await adapter(request(["staged"]))).validationResult.status, "passed");
    assert.equal((await adapter(request(["changed", "--base", "HEAD"]))).validationResult.status, "passed");
    assert.equal((await adapter(request(["tree", "--tree", "HEAD", "--changed-from", "origin/main"]))).validationResult.status, "passed");
    assert.equal((await adapter(request(["all"]))).validationResult.status, "passed");
    assert.deepEqual(observed.map((entry) => entry.kind), ["files", "files", "staged", "changed", "tree", "all"]);
    assert.equal(observed.find((entry) => entry.kind === "changed").baseRef, "HEAD");
    assert.deepEqual(
      observed.find((entry) => entry.kind === "tree"),
      {
        kind: "tree",
        treeRef: "HEAD",
        changedFrom: "origin/main",
        files: ["src/tree.ts"]
      }
    );
  });

  it("returns manifest inventory and invalid_payload for malformed arguments", async () => {
    const adapter = createCheckCommandAdapter({
      checks: [scopeCheck([])]
    });
    const manifest = await adapter(request(["manifest"]));
    const malformed = await adapter(request(["--files"]));
    const escaped = await adapter(request(["--files", "../outside.ts"]));
    const manifestWithScope = await adapter(request(["manifest", "--files", "src/index.ts"]));

    assert.equal(manifest.status, "ok");
    assert.equal(manifest.message, "opcore check manifest: validation check manifest ready.");
    assert.deepEqual(manifest.validationResult.manifest.entries.map((entry) => entry.checkId), ["validation.scope"]);
    assert.equal(malformed.status, "error");
    assert.equal(malformed.validationResult.status, "invalid_payload");
    assert.equal(escaped.validationResult.status, "invalid_payload");
    assert.equal(manifestWithScope.status, "error");
    assert.equal(manifestWithScope.validationResult.status, "invalid_payload");
    assert.match(manifestWithScope.validationResult.failure.cause, /manifest.*--files/);

    const validateManifest = await createValidateCommandAdapter({
      checks: [scopeCheck([])]
    })(request(["manifest"], "validate"));
    assert.equal(validateManifest.status, "ok");
    assert.equal(validateManifest.message, "opcore validate manifest: validation check manifest ready.");
  });

  it("rejects manifest routes with execution-only flags", async () => {
    const checkAdapter = createCheckCommandAdapter({ checks: [scopeCheck([])] });
    const validateAdapter = createValidateCommandAdapter({ checks: [scopeCheck([])] });

    const checkManifest = await checkAdapter(request(["manifest", "--request-file", "request.json"]));
    const validateManifest = await validateAdapter(request(["manifest", "--request-file", "does-not-exist.json"], "validate"));

    assert.equal(checkManifest.status, "error");
    assert.equal(checkManifest.validationResult.status, "invalid_payload");
    assert.match(checkManifest.validationResult.failure.cause, /manifest.*--request-file/);
    assert.equal(validateManifest.status, "error");
    assert.equal(validateManifest.validationResult.status, "invalid_payload");
    assert.match(validateManifest.validationResult.failure.cause, /manifest.*--request-file/);
  });

  it("maps malformed request JSON to invalid_payload", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-adapter-"));
    try {
      const requestPath = join(temp, "request.json");
      writeFileSync(requestPath, "{");
      const result = await createValidateCommandAdapter({ checks: [scopeCheck([])] })(
        request(["--request-file", requestPath], "validate")
      );
      assert.equal(result.status, "error");
      assert.equal(result.validationResult.status, "invalid_payload");
      assert.match(result.validationResult.failure.cause, /malformed JSON/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies validate --repo to both request context and workspace reads", async () => {
    const repoA = mkdtempSync(join(tmpdir(), "lattice-validation-repo-a-"));
    const repoB = mkdtempSync(join(tmpdir(), "lattice-validation-repo-b-"));
    try {
      mkdirSync(join(repoA, "src"), { recursive: true });
      mkdirSync(join(repoB, "src"), { recursive: true });
      writeFileSync(join(repoA, "src/index.ts"), "export const repo = 'a';\n");
      writeFileSync(join(repoB, "src/index.ts"), "export const repo = 'b';\n");
      const requestPath = join(repoA, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          validRequest(repoA, {
            checks: ["validation.repo"],
            graph: {
              mode: "optional",
              provider: "opcore-graph",
              status: availableGraphStatus(repoA)
            }
          })
        )
      );

      let observed;
      const result = await createValidateCommandAdapter({
        checks: [
          {
            id: "validation.repo",
            owner: "validation",
            adapter: "test",
            defaultSeverity: "error",
            supportedScopes: ["files"],
            run: async (context) => {
              const after = await context.fileView.readAfter("src/index.ts");
              observed = {
                repoRoot: context.request.repo.repoRoot,
                graphState: context.graphStatus.state,
                content: after.content
              };
              return { diagnostics: [] };
            }
          }
        ],
        workspaceFactory: (repoRoot) => createNodeValidationWorkspace({ repoRoot })
      })(request(["--request-file", requestPath, "--repo", repoB], "validate"));

      assert.equal(result.validationResult.status, "passed");
      assert.equal(observed.repoRoot, repoB);
      assert.equal(observed.graphState, "skipped");
      assert.equal(observed.content, "export const repo = 'b';\n");
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  it("applies validate --graph-mode required to graph policy", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-graph-mode-"));
    try {
      mkdirSync(join(temp, "src"));
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");
      const requestPath = join(temp, "request.json");
      writeFileSync(requestPath, JSON.stringify(validRequest(temp, { checks: ["validation.graph"] })));

      const result = await createValidateCommandAdapter({
        checks: [graphCheck()],
        workspaceFactory: (repoRoot) => createNodeValidationWorkspace({ repoRoot })
      })(request(["--request-file", requestPath, "--graph-mode", "required"], "validate"));

      assert.equal(result.validationResult.status, "provider_failure");
      assert.equal(result.validationResult.graphStatus.mode, "required");
      assert.equal(result.validationResult.graphStatus.state, "required_missing");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("validates overlays through fileView without writing to disk", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-overlay-"));
    try {
      mkdirSync(join(temp, "src"));
      const filePath = join(temp, "src/index.ts");
      const requestPath = join(temp, "request.json");
      writeFileSync(filePath, "export const value = 'disk';");
      writeFileSync(
        requestPath,
        JSON.stringify({
          repo: { repoRoot: temp },
          scope: { kind: "files", files: ["src/index.ts"] },
          graph: { mode: "optional", provider: "opcore-graph" },
          overlays: [{ path: "src/index.ts", action: "write", content: "export const value = 'overlay';" }]
        })
      );
      let observed;
      const result = await createValidateCommandAdapter({
        checks: [
          {
            ...scopeCheck([]),
            run: async (context) => {
              observed = await context.fileView.readAfter("src/index.ts");
              return { diagnostics: [] };
            }
          }
        ],
        workspaceFactory: (repoRoot) => createNodeValidationWorkspace({ repoRoot })
      })(request(["hypothetical", "--request-file", requestPath], "validate"));

      assert.equal(result.validationResult.status, "passed");
      assert.equal(observed.content, "export const value = 'overlay';");
      assert.equal(readFileSync(filePath, "utf8"), "export const value = 'disk';");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs pre-write validation with pass receipts and hypothetical overlays", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-pre-write-"));
    try {
      mkdirSync(join(temp, "src"));
      const filePath = join(temp, "src/index.ts");
      const requestPath = join(temp, "request.json");
      writeFileSync(filePath, "export const value = 'disk';");
      writeFileSync(
        requestPath,
        JSON.stringify({
          requestId: "pre-write-1",
          repo: { repoRoot: temp },
          scope: { kind: "files", files: ["src/index.ts"] },
          graph: { mode: "optional", provider: "opcore-graph" },
          overlays: [{ path: "src/index.ts", action: "write", content: "export const value = 'overlay';" }]
        })
      );
      let observed;
      const result = await createValidateCommandAdapter({
        checks: [
          {
            ...scopeCheck([]),
            run: async (context) => {
              observed = await context.fileView.readAfter("src/index.ts");
              return { diagnostics: [] };
            }
          }
        ],
        workspaceFactory: (repoRoot) => createNodeValidationWorkspace({ repoRoot })
      })(request(["pre-write", "--request-file", requestPath, "--timeout-ms", "100"], "validate"));

      assert.equal(result.status, "ok");
      assert.equal(result.validationResult.status, "passed");
      assert.equal(result.receipt.ok, true);
      assert.equal(result.receipt.route, "validate.pre-write");
      assert.equal(result.receipt.timeoutMs, 100);
      assert.equal(result.receipt.requestId, "pre-write-1");
      assert.deepEqual(result.receipt.overlays, {
        count: 1,
        writeCount: 1,
        deleteCount: 0,
        paths: ["src/index.ts"]
      });
      assert.equal(observed.content, "export const value = 'overlay';");
      assert.equal(readFileSync(filePath, "utf8"), "export const value = 'disk';");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns pre-write failure receipts for policy failures", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-pre-write-policy-"));
    try {
      mkdirSync(join(temp, "src"));
      const requestPath = join(temp, "request.json");
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;");
      writeFileSync(requestPath, JSON.stringify(validRequest(temp, { checks: ["validation.policy"] })));

      const result = await createValidateCommandAdapter({
        checks: [policyCheck()],
        workspaceFactory: (repoRoot) => createNodeValidationWorkspace({ repoRoot })
      })(request(["pre-write", "--request-file", requestPath], "validate"));

      assert.equal(result.status, "error");
      assert.equal(result.validationResult.status, "policy_failure");
      assert.equal(result.receipt.ok, false);
      assert.equal(result.receipt.failureSummary.category, "policy_failure");
      assert.equal(result.receipt.diagnosticCount, 1);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("fails closed on pre-write timeout", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-pre-write-timeout-"));
    try {
      mkdirSync(join(temp, "src"));
      const requestPath = join(temp, "request.json");
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;");
      writeFileSync(requestPath, JSON.stringify(validRequest(temp, { checks: ["validation.never"] })));

      const result = await createValidateCommandAdapter({
        checks: [neverCheck()],
        workspaceFactory: (repoRoot) => createNodeValidationWorkspace({ repoRoot })
      })(request(["pre-write", "--request-file", requestPath, "--timeout-ms", "1"], "validate"));

      assert.equal(result.status, "error");
      assert.equal(result.validationResult.status, "infrastructure_failure");
      assert.match(result.validationResult.failure.message, /timed out/);
      assert.equal(result.receipt.ok, false);
      assert.equal(result.receipt.timeoutMs, 1);
      assert.equal(result.receipt.failureSummary.category, "infrastructure_failure");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns pre-write invalid-payload receipts for malformed and invalid request files", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-pre-write-invalid-"));
    try {
      const malformedPath = join(temp, "malformed.json");
      const invalidPath = join(temp, "invalid.json");
      writeFileSync(malformedPath, "{");
      writeFileSync(invalidPath, JSON.stringify({ repo: { repoRoot: temp }, overlays: [] }));
      const adapter = createValidateCommandAdapter({ checks: [scopeCheck([])] });

      for (const requestPath of [malformedPath, invalidPath]) {
        const result = await adapter(request(["pre-write", "--request-file", requestPath], "validate"));
        assert.equal(result.status, "error");
        assert.equal(result.validationResult.status, "invalid_payload");
        assert.equal(result.receipt.ok, false);
        assert.equal(result.receipt.failureSummary.category, "invalid_payload");
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns pre-write provider-failure receipts for missing, stale, and schema-mismatch required graph providers", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-pre-write-provider-"));
    try {
      mkdirSync(join(temp, "src"));
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;");
      const adapter = createValidateCommandAdapter({
        checks: [scopeCheck([])],
        workspaceFactory: (repoRoot) => createNodeValidationWorkspace({ repoRoot })
      });

      for (const graph of [
        { mode: "required", provider: "opcore-graph" },
        { mode: "required", provider: "opcore-graph", status: staleGraphStatus(temp) },
        { mode: "required", provider: "opcore-graph", status: schemaMismatchGraphStatus() }
      ]) {
        const requestPath = join(temp, `request-${graph.status?.state ?? "missing"}.json`);
        writeFileSync(requestPath, JSON.stringify(validRequest(temp, { graph })));
        const result = await adapter(request(["pre-write", "--request-file", requestPath], "validate"));
        assert.equal(result.status, "error");
        assert.equal(result.validationResult.status, "provider_failure");
        assert.equal(result.receipt.ok, false);
        assert.equal(result.receipt.failureSummary.category, "provider_failure");
        assert.equal(result.receipt.graph.mode, "required");
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("skips optional graph checks and fails closed for required graph checks", async () => {
    const optional = await createCheckCommandAdapter({
      checks: [scopeCheck([]), graphCheck()],
      workspace: workspace()
    })(request(["--files", "src/index.ts"]));
    const required = await createCheckCommandAdapter({
      checks: [graphCheck()],
      workspace: workspace()
    })(request(["--files", "src/index.ts", "--graph-mode", "required"]));

    assert.equal(optional.validationResult.status, "passed");
    assert.deepEqual(optional.validationResult.manifest.skippedChecks.map((skip) => skip.checkId), ["validation.graph"]);
    assert.equal(required.validationResult.status, "provider_failure");
    assert.equal(required.validationResult.graphStatus.state, "required_missing");
  });

  it("discovers changed deleted renamed and untracked files through the Node workspace", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-workspace-"));
    try {
      mkdirSync(join(temp, "src"));
      writeFileSync(join(temp, "src/modified.ts"), "export const modified = 1;\n");
      writeFileSync(join(temp, "src/deleted.ts"), "export const deleted = 1;\n");
      writeFileSync(join(temp, "src/renamed-old.ts"), "export const renamed = 1;\n");
      initializeGitSnapshot(temp, ["src/modified.ts", "src/deleted.ts", "src/renamed-old.ts"]);
      writeFileSync(join(temp, "src/modified.ts"), "export const modified = 2;\n");
      unlinkSync(join(temp, "src/deleted.ts"));
      renameSync(join(temp, "src/renamed-old.ts"), join(temp, "src/renamed-new.ts"));
      stageRenameForDiff(temp, "src/renamed-old.ts", "src/renamed-new.ts");
      writeFileSync(join(temp, "src/untracked.ts"), "export const untracked = 1;\n");

      const files = createNodeValidationWorkspace({ repoRoot: temp }).listChangedFiles("HEAD").files;
      const byPath = new Map(files.map((file) => [typeof file === "string" ? file : file.path, file]));

      assert.equal(byPath.get("src/modified.ts").status, "modified");
      assert.equal(byPath.get("src/deleted.ts").status, "deleted");
      assert.equal(byPath.get("src/renamed-new.ts").status, "renamed");
      assert.equal(byPath.get("src/renamed-new.ts").fromPath, "src/renamed-old.ts");
      assert.equal(byPath.get("src/untracked.ts").status, "added");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("discovers tracked and untracked files from unborn HEAD changed scope", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-unborn-head-"));
    try {
      mkdirSync(join(temp, "src"));
      git(temp, ["init", "-q"]);
      git(temp, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      writeFileSync(join(temp, "src/tracked.ts"), "export const tracked = 1;\n");
      writeFileSync(join(temp, "src/untracked.ts"), "export const untracked = 1;\n");
      trackGitFile(temp, "src/tracked.ts");

      const result = createNodeValidationWorkspace({ repoRoot: temp }).listChangedFiles("HEAD");
      const byPath = new Map(result.files.map((file) => [typeof file === "string" ? file : file.path, file]));

      assert.equal(Boolean(result.unavailable), false);
      assert.equal(byPath.get("src/tracked.ts").status, "added");
      assert.equal(byPath.get("src/untracked.ts").status, "added");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("discovers untracked-only files from unborn HEAD changed scope", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-unborn-untracked-"));
    try {
      mkdirSync(join(temp, "src"));
      git(temp, ["init", "-q"]);
      git(temp, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      writeFileSync(join(temp, "src/untracked.ts"), "export const untracked = 1;\n");

      const result = createNodeValidationWorkspace({ repoRoot: temp }).listChangedFiles("HEAD");
      const byPath = new Map(result.files.map((file) => [typeof file === "string" ? file : file.path, file]));

      assert.equal(Boolean(result.unavailable), false);
      assert.equal(byPath.get("src/untracked.ts").status, "added");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns typed unavailable changed scope outside Git repositories", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-non-git-"));
    try {
      const result = createNodeValidationWorkspace({ repoRoot: temp }).listChangedFiles("HEAD");

      assert.equal(result.unavailable, true);
      assert.equal(result.message, "Changed validation scope requires a Git repository");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns typed unavailable changed scope for unresolved explicit base refs", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-bad-base-"));
    try {
      mkdirSync(join(temp, "src"));
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");
      initializeGitSnapshot(temp, ["src/index.ts"]);

      const result = createNodeValidationWorkspace({ repoRoot: temp }).listChangedFiles("definitely-missing");

      assert.equal(result.unavailable, true);
      assert.equal(result.message, "Changed validation base ref is unavailable");
      assert.equal(result.cause, "Cannot resolve --base definitely-missing to a commit");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs tree scope against committed tree content without reading dirty worktree files", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-tree-"));
    try {
      mkdirSync(join(temp, "src"));
      writeFileSync(join(temp, "src/tree.ts"), "export const value: string = 'base';\n");
      const baseCommit = initializeGitSnapshot(temp, ["src/tree.ts"]);
      writeFileSync(join(temp, "src/tree.ts"), "export const value: string = 'tree';\n");
      const treeCommit = commitWorktreeFile(temp, "src/tree.ts", "tree");
      writeFileSync(join(temp, "src/tree.ts"), "export const value: string = 1;\n");

      let observed;
      const result = await createCheckCommandAdapter({
        checks: [
          {
            ...scopeCheck([]),
            id: "validation.tree-content",
            supportedScopes: ["tree"],
            run: async (context) => {
              const after = await context.fileView.readAfter("src/tree.ts");
              observed = {
                kind: context.scope.kind,
                files: context.scope.files,
                content: after.status === "found" ? after.content : "<missing>"
              };
              return { diagnostics: [] };
            }
          }
        ],
        workspaceFactory: (repoRoot) => createNodeValidationWorkspace({ repoRoot })
      })(request(["tree", "--tree", treeCommit, "--changed-from", baseCommit, "--repo", temp]));

      assert.equal(result.validationResult.status, "passed", JSON.stringify(result.validationResult, null, 2));
      assert.deepEqual(observed, {
        kind: "tree",
        files: ["src/tree.ts"],
        content: "export const value: string = 'tree';\n"
      });
      assert.equal(readFileSync(join(temp, "src/tree.ts"), "utf8"), "export const value: string = 1;\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function request(args, groupName = "check") {
  return {
    schemaVersion: 1,
    bin: "opcore",
    argv: [groupName, ...args, "--json"],
    args,
    json: true,
    group: {
      name: groupName,
      owner: "validation",
      canonicalCommand: ["opcore", groupName],
      commands:
        groupName === "check"
          ? ["files", "staged", "changed", "tree", "all", "manifest"]
          : ["request", "hypothetical", "pre-write", "manifest"],
      summary: "validation"
    },
    canonicalCommand: ["opcore", groupName, ...args]
  };
}

function validRequest(repoRoot, overrides = {}) {
  return {
    repo: { repoRoot },
    scope: { kind: "files", files: ["src/index.ts"] },
    graph: { mode: "optional", provider: "opcore-graph" },
    overlays: [],
    ...overrides
  };
}

function availableGraphStatus(repoRoot) {
  return {
    state: "available",
    mode: "optional",
    provider: "opcore-graph",
    schemaVersion: 1,
    repo: { repoRoot },
    freshness: {
      generatedAt: "2026-06-05T00:00:00.000Z",
      ageMs: 0,
      stale: false
    },
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function workspace() {
  const files = new Map([
    ["src/index.ts", "export const value = 1;"],
    ["src/staged.ts", "export const staged = 1;"],
    ["src/changed.ts", "export const changed = 1;"]
  ]);
  return {
    readFile: (path) => (files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }),
    listStagedFiles: () => ({ files: ["src/staged.ts"] }),
    listChangedFiles: () => ({ files: ["src/changed.ts"] }),
    listTreeFiles: () => ({ files: ["src/tree.ts"] }),
    listRepoFiles: () => ({ files: ["src/index.ts"] })
  };
}

function scopeCheck(observed) {
  return {
    id: "validation.scope",
    owner: "validation",
    adapter: "test",
    defaultSeverity: "error",
    supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
    run: (context) => {
      const entry = {
        kind: context.scope.kind,
        files: context.scope.files
      };
      if (context.scope.baseRef !== undefined) entry.baseRef = context.scope.baseRef;
      if (context.scope.treeRef !== undefined) entry.treeRef = context.scope.treeRef;
      if (context.scope.changedFrom !== undefined) entry.changedFrom = context.scope.changedFrom;
      observed.push(entry);
      return { diagnostics: [] };
    }
  };
}

function graphCheck() {
  return {
    id: "validation.graph",
    owner: "validation",
    adapter: "test",
    defaultSeverity: "warning",
    supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
    requiresGraph: true,
    graphRequirements: () => [{ operation: "factQuery", selector: { kind: "nodes" } }],
    run: () => ({ diagnostics: [] })
  };
}

function policyCheck() {
  return {
    id: "validation.policy",
    owner: "validation",
    adapter: "test",
    defaultSeverity: "error",
    supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
    run: () => ({
      diagnostics: [
        {
          category: "policy",
          severity: "error",
          message: "pre-write policy failure",
          path: "src/index.ts"
        }
      ]
    })
  };
}

function neverCheck() {
  return {
    id: "validation.never",
    owner: "validation",
    adapter: "test",
    defaultSeverity: "error",
    supportedScopes: ["files"],
    run: async () => new Promise(() => {})
  };
}

function staleGraphStatus(repoRoot) {
  return {
    state: "stale",
    mode: "required",
    provider: "opcore-graph",
    schemaVersion: 1,
    repo: { repoRoot },
    freshness: {
      generatedAt: "2026-06-05T00:00:00.000Z",
      ageMs: 60000,
      stale: true,
      reason: "graph snapshot is stale"
    },
    failure: {
      category: "stale_snapshot",
      message: "graph snapshot is stale"
    }
  };
}

function schemaMismatchGraphStatus() {
  return {
    state: "schema_mismatch",
    mode: "required",
    provider: "opcore-graph",
    schemaVersion: 2,
    expectedSchemaVersion: 1,
    actualSchemaVersion: 2,
    failure: {
      category: "schema_mismatch",
      message: "graph schema mismatch"
    }
  };
}

function initializeGitSnapshot(repoRoot, files) {
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  for (const file of files) {
    trackGitFile(repoRoot, file);
  }
  const tree = git(repoRoot, ["write-tree"]).stdout.trim();
  const commit = git(repoRoot, ["commit-tree", tree, "-m", "initial"], {
    GIT_AUTHOR_NAME: "Opcore",
    GIT_AUTHOR_EMAIL: "lattice@example.invalid",
    GIT_AUTHOR_DATE: "2026-06-05T00:00:00Z",
    GIT_COMMITTER_NAME: "Opcore",
    GIT_COMMITTER_EMAIL: "lattice@example.invalid",
    GIT_COMMITTER_DATE: "2026-06-05T00:00:00Z"
  }).stdout.trim();
  git(repoRoot, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

function commitWorktreeFile(repoRoot, file, message) {
  trackGitFile(repoRoot, file);
  const tree = git(repoRoot, ["write-tree"]).stdout.trim();
  const commit = git(repoRoot, ["commit-tree", tree, "-p", "HEAD", "-m", message], {
    GIT_AUTHOR_NAME: "Opcore",
    GIT_AUTHOR_EMAIL: "lattice@example.invalid",
    GIT_AUTHOR_DATE: "2026-06-05T00:01:00Z",
    GIT_COMMITTER_NAME: "Opcore",
    GIT_COMMITTER_EMAIL: "lattice@example.invalid",
    GIT_COMMITTER_DATE: "2026-06-05T00:01:00Z"
  }).stdout.trim();
  git(repoRoot, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

function trackGitFile(repoRoot, file) {
  const object = git(repoRoot, ["hash-object", "-w", file]).stdout.trim();
  git(repoRoot, ["update-index", "--add", "--cacheinfo", "100644", object, file]);
}

function stageRenameForDiff(repoRoot, fromPath, toPath) {
  const object = git(repoRoot, ["hash-object", "-w", toPath]).stdout.trim();
  git(repoRoot, ["update-index", "--remove", fromPath]);
  git(repoRoot, ["update-index", "--add", "--cacheinfo", "100644", object, toPath]);
}

function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error([`git ${args.join(" ")} failed`, result.stdout, result.stderr].join("\n"));
  }
  return result;
}
