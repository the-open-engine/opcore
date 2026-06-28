import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { routeCommandAdapter } from "../packages/contracts/dist/index.js";
import {
  calculateEditChecksum,
  createEditCommandAdapter,
  createNodeEditWorkspace,
  createSymbolEditPlan,
  createSymbolEditLanguageServiceProject,
  materializeRenameSymbolEdit
} from "../packages/edit/dist/index.js";

describe("opcore edit symbol operations", () => {
  it("plans deterministic graph-backed rename previews across declaration and references", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export function greet(name: string) {\n  return name;\n}\n");
      writeFileSync(join(repo, "src/b.ts"), "import { greet } from \"./a\";\nexport const message = greet(\"Ada\");\n");
      const graph = fakeGraphClient(repo, [symbolNode("function:src/a.ts#greet", "Function", "src/a.ts", "greet")]);
      const args = [
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, newName: "welcome" })
      ];

      const first = await routeEdit(args, { graphProviderClient: graph });
      const second = await routeEdit(args, { graphProviderClient: graph });

      assert.equal(first.status, "ok");
      assert.equal(second.status, "ok");
      assert.equal(first.editPlan.planId, second.editPlan.planId);
      assert.deepEqual(first.editPlan.changes.map((change) => change.path), ["src/a.ts", "src/b.ts"]);
      assert.match(first.editPlan.changes.find((change) => change.path === "src/a.ts").content, /function welcome/);
      assert.match(first.editPlan.changes.find((change) => change.path === "src/b.ts").content, /welcome\("Ada"\)/);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8").includes("welcome"), false);
    });
  });

  it("loads importer referenced tsconfig path aliases so cross-package rename references are included", async () => {
    await withSymbolRepo(async (repo) => {
      mkdirSync(join(repo, "packages/a/src"), { recursive: true });
      mkdirSync(join(repo, "packages/b/src"), { recursive: true });
      writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({
        files: [],
        references: [{ path: "./packages/a" }, { path: "./packages/b" }]
      }, null, 2));
      writeFileSync(join(repo, "packages/a/tsconfig.json"), JSON.stringify({
        compilerOptions: {
          composite: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
          baseUrl: ".",
          paths: { "@b/*": ["../b/src/*"] }
        },
        include: ["src/**/*"]
      }, null, 2));
      writeFileSync(join(repo, "packages/b/tsconfig.json"), JSON.stringify({
        compilerOptions: {
          composite: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022"
        },
        include: ["src/**/*"]
      }, null, 2));
      writeFileSync(join(repo, "packages/a/src/mod.ts"), "export const unused = 1;\n");
      writeFileSync(join(repo, "packages/b/src/mod.ts"), "export function greet(name: string) {\n  return name;\n}\n");
      writeFileSync(join(repo, "packages/a/src/use.ts"), "import { greet } from \"@b/mod\";\nexport const message = greet(\"Ada\");\n");
      const graph = fakeGraphClient(repo, [symbolNode("function:packages/b/src/mod.ts#greet", "Function", "packages/b/src/mod.ts", "greet")]);

      const result = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "packages/b/src/mod.ts", name: "greet" }, newName: "welcome" })
      ], { graphProviderClient: graph });

      assert.equal(result.status, "ok");
      assert.deepEqual(result.editPlan.changes.map((change) => change.path), ["packages/a/src/use.ts", "packages/b/src/mod.ts"]);
      assert.match(result.editPlan.changes.find((change) => change.path === "packages/a/src/use.ts").content, /import \{ welcome \} from "@b\/mod"/);
      assert.match(result.editPlan.changes.find((change) => change.path === "packages/a/src/use.ts").content, /welcome\("Ada"\)/);
    });
  });

  it("scopes edit language service project construction and reverts injected project mutations", async () => {
    await withSymbolRepo(async (rawRepo) => {
      const repo = realpathSync(rawRepo);
      writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ include: ["src/**/*"] }, null, 2));
      writeFileSync(join(repo, "src/a.ts"), "import { helper } from \"./helper\";\nexport function greet(name: string) {\n  return helper(name);\n}\n");
      writeFileSync(join(repo, "src/helper.ts"), "export function helper(value: string) {\n  return value;\n}\n");
      writeFileSync(join(repo, "src/b.ts"), "import { greet } from \"./a\";\nexport const message = greet(\"Ada\");\n");
      writeFileSync(join(repo, "src/c.ts"), "import { message } from \"./b\";\nexport const relayed = message;\n");
      writeFileSync(join(repo, "src/unrelated.ts"), "import { helper } from \"./helper\";\nexport const unrelated = helper(\"ignored\");\n");

      const defaultProject = createSymbolEditLanguageServiceProject(repo, "src/a.ts");
      assert.deepEqual(projectRepoPaths(repo, defaultProject), ["src/a.ts", "src/b.ts", "src/c.ts", "src/helper.ts"]);

      const scopedProject = createSymbolEditLanguageServiceProject(repo, "src/a.ts", { projectScope: "import_closure" });
      assert.deepEqual(projectRepoPaths(repo, scopedProject), ["src/a.ts", "src/b.ts", "src/c.ts", "src/helper.ts"]);
      const scopedInjectedResult = materializeRenameSymbolEdit(
        repo,
        { target: { path: "src/a.ts", name: "greet" }, newName: "salute" },
        {
          project: scopedProject,
          snapshotProject,
          revertProject
        }
      );
      assert.equal(scopedInjectedResult.ok, true);
      assert.deepEqual(scopedInjectedResult.changes.map((change) => change.path), ["src/a.ts", "src/b.ts"]);
      assert.match(scopedInjectedResult.changes.find((change) => change.path === "src/b.ts").content, /salute\("Ada"\)/);

      const injectedProject = createSymbolEditLanguageServiceProject(repo, "src/a.ts", { projectScope: "whole_repo" });
      const beforeText = injectedProject.getSourceFile(join(repo, "src/a.ts")).getFullText();
      const result = materializeRenameSymbolEdit(
        repo,
        { target: { path: "src/a.ts", name: "greet" }, newName: "welcome" },
        {
          project: injectedProject,
          snapshotProject,
          revertProject
        }
      );

      assert.equal(result.ok, true);
      assert.deepEqual(result.changes.map((change) => change.path), ["src/a.ts", "src/b.ts"]);
      assert.match(result.changes.find((change) => change.path === "src/b.ts").content, /welcome\("Ada"\)/);
      assert.equal(injectedProject.getSourceFile(join(repo, "src/a.ts")).getFullText(), beforeText);
    });
  });

  it("refuses invalid TypeScript identifiers before symbol previews", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export function greet(name: string) {\n  return name;\n}\n");
      const graph = fakeGraphClient(repo, [symbolNode("function:src/a.ts#greet", "Function", "src/a.ts", "greet")]);

      const invalidRename = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, newName: "bad name" })
      ], { graphProviderClient: graph });
      assert.equal(invalidRename.status, "error");
      assert.equal(invalidRename.editResult.refusal.category, "unsupported_change");

      const invalidSignatureAdd = await routeEdit([
        "signature",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, changes: [{ action: "add", name: "bad name", type: "string", defaultValue: "\"x\"" }] })
      ], { graphProviderClient: graph });
      assert.equal(invalidSignatureAdd.status, "error");
      assert.equal(invalidSignatureAdd.editResult.refusal.category, "unsupported_change");

      const invalidSignatureRename = await routeEdit([
        "signature",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, changes: [{ action: "rename", name: "name", newName: "bad name" }] })
      ], { graphProviderClient: graph });
      assert.equal(invalidSignatureRename.status, "error");
      assert.equal(invalidSignatureRename.editResult.refusal.category, "unsupported_change");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export function greet(name: string) {\n  return name;\n}\n");
    });
  });

  it("refuses missing graph, ambiguous targets, missing targets, unsupported languages, stale graph, and changed files before writes", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export const value = 1;\n");
      const missingGraph = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "value" }, newName: "nextValue" })
      ]);
      assert.equal(missingGraph.status, "error");
      assert.equal(missingGraph.editResult.refusal.category, "provider_required_missing");

      const ambiguous = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "value" }, newName: "nextValue" })
      ], {
        graphProviderClient: fakeGraphClient(repo, [
          symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value"),
          symbolNode("function:src/a.ts#value", "Function", "src/a.ts", "value")
        ])
      });
      assert.equal(ambiguous.status, "error");
      assert.equal(ambiguous.editResult.refusal.category, "unsafe_edit");

      const missingTarget = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "missing" }, newName: "nextValue" })
      ], { graphProviderClient: fakeGraphClient(repo, []) });
      assert.equal(missingTarget.status, "error");
      assert.equal(missingTarget.editResult.refusal.category, "unsafe_edit");

      writeFileSync(join(repo, "src/script.py"), "value = 1\n");
      const unsupported = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/script.py", name: "value" }, newName: "nextValue" })
      ], { graphProviderClient: fakeGraphClient(repo, [symbolNode("py:src/script.py#value", "symbol", "src/script.py", "value")]) });
      assert.equal(unsupported.status, "error");
      assert.equal(unsupported.editResult.refusal.category, "unsupported_change");

      const graph = fakeGraphClient(repo, [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")]);
      const preview = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "value" }, newName: "nextValue" })
      ], { graphProviderClient: graph });
      assert.equal(preview.status, "ok");

      graph.setStatus(availableStatus(repo, "freshness-2"));
      const staleGraphApply = await routeEdit([
        "apply",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify(preview.editPlan)
      ], { graphProviderClient: graph, validationRunner: recordingRunner(passedValidation()) });
      assert.equal(staleGraphApply.status, "error");
      assert.equal(staleGraphApply.editResult.refusal.category, "conflict");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const value = 1;\n");

      graph.setStatus(availableStatus(repo, "freshness-1"));
      writeFileSync(join(repo, "src/a.ts"), "export const value = 2;\n");
      const changedFileApply = await routeEdit([
        "apply",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify(preview.editPlan)
      ], { graphProviderClient: graph, validationRunner: recordingRunner(passedValidation()) });
      assert.equal(changedFileApply.status, "error");
      assert.equal(changedFileApply.editResult.refusal.category, "conflict");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const value = 2;\n");
    });
  });

  it("refuses dirty graph change evidence before symbol previews", async () => {
    await withSymbolRepo(async (repo) => {
      mkdirSync(join(repo, "src/feature"), { recursive: true });
      writeFileSync(join(repo, "src/a.ts"), "export const value = 1;\n");
      writeFileSync(join(repo, "src/feature/index.ts"), "export const featureValue = 1;\n");

      const rename = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "value" }, newName: "nextValue" })
      ], {
        graphProviderClient: fakeGraphClient(repo, [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")], { changedFiles: ["src/a.ts"] })
      });
      assert.equal(rename.status, "error");
      assert.equal(rename.editResult.refusal.category, "conflict");
      assert.match(rename.editResult.refusal.message, /dirty|changed/i);

      const move = await routeEdit([
        "move",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ fromPath: "src/feature", toPath: "src/renamed-feature" })
      ], {
        graphProviderClient: fakeGraphClient(repo, [symbolNode("file:src/feature/index.ts", "File", "src/feature/index.ts", "index")], { changedFiles: ["src/feature/index.ts"] })
      });
      assert.equal(move.status, "error");
      assert.equal(move.editResult.refusal.category, "conflict");
      assert.equal(existsSync(join(repo, "src/renamed-feature/index.ts")), false);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const value = 1;\n");
    });
  });

  it("refuses validation bypass payloads for symbol previews", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export const value = 1;\n");
      const graph = fakeGraphClient(repo, [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")]);

      const preview = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "value" }, newName: "nextValue", validation: { required: false } })
      ], { graphProviderClient: graph });

      assert.equal(preview.status, "error");
      assert.equal(preview.editResult.refusal.category, "unsupported_change");
      assert.match(preview.editResult.refusal.message, /validation\.required=true/);
    });
  });

  it("returns typed edit refusals for malformed auxiliary tsconfig references instead of router exceptions", async () => {
    await withSymbolRepo(async (repo) => {
      mkdirSync(join(repo, "packages/a"), { recursive: true });
      mkdirSync(join(repo, "packages/b/src"), { recursive: true });
      writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({
        files: [],
        references: [{ path: "./packages/a" }, { path: "./packages/b" }]
      }, null, 2));
      writeFileSync(join(repo, "packages/a/tsconfig.json"), "{ compilerOptions: ");
      writeFileSync(join(repo, "packages/b/tsconfig.json"), JSON.stringify({
        compilerOptions: {
          composite: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022"
        },
        include: ["src/**/*"]
      }, null, 2));
      writeFileSync(join(repo, "packages/b/src/mod.ts"), "export const value = 1;\n");
      const graph = fakeGraphClient(repo, [symbolNode("const:packages/b/src/mod.ts#value", "symbol", "packages/b/src/mod.ts", "value")]);

      const preview = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "packages/b/src/mod.ts", name: "value" }, newName: "nextValue" })
      ], { graphProviderClient: graph });

      assert.equal(preview.status, "error");
      assert.equal(preview.editResult.refusal.category, "unsafe_edit");
      assert.match(preview.editResult.refusal.message, /tsconfig|TypeScript project/i);
      assert.equal(readFileSync(join(repo, "packages/b/src/mod.ts"), "utf8"), "export const value = 1;\n");
    });
  });

  it("refuses move previews without graph file facts", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export const value = 1;\n");
      const preview = await routeEdit([
        "move",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ fromPath: "src/a.ts", toPath: "src/b.ts" })
      ], { graphProviderClient: fakeGraphClient(repo, []) });

      assert.equal(preview.status, "error");
      assert.equal(preview.editResult.refusal.category, "unsupported_change");
      assert.match(preview.editResult.refusal.message, /GraphProvider.*file.*facts/i);
      assert.equal(existsSync(join(repo, "src/b.ts")), false);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const value = 1;\n");
    });
  });

  it("converts thrown graph evidence failures into typed edit refusals", async () => {
    await withSymbolRepo(async (repo) => {
      mkdirSync(join(repo, "src/feature"), { recursive: true });
      writeFileSync(join(repo, "src/a.ts"), "export const value = 1;\n");
      writeFileSync(join(repo, "src/feature/index.ts"), "export const featureValue = 1;\n");

      const renameRequest = [
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "value" }, newName: "nextValue" })
      ];
      const moveRequest = [
        "move",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ fromPath: "src/feature", toPath: "src/renamed-feature" })
      ];
      const cases = [
        { method: "factQuery", args: renameRequest, nodes: [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")] },
        { method: "search", args: renameRequest, nodes: [] },
        { method: "namedQuery", args: renameRequest, nodes: [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")] },
        { method: "reviewContext", args: renameRequest, nodes: [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")] },
        { method: "detectChanges", args: renameRequest, nodes: [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")] },
        { method: "namedQuery", args: moveRequest, nodes: [symbolNode("file:src/feature/index.ts", "File", "src/feature/index.ts", "index")] },
        { method: "reviewContext", args: moveRequest, nodes: [symbolNode("file:src/feature/index.ts", "File", "src/feature/index.ts", "index")] },
        { method: "detectChanges", args: moveRequest, nodes: [symbolNode("file:src/feature/index.ts", "File", "src/feature/index.ts", "index")] }
      ];

      for (const { method, args, nodes } of cases) {
        const routed = await routeEdit(args, { graphProviderClient: throwingGraphClient(repo, nodes, method) });

        assert.equal(routed.status, "error", method);
        assert.equal(routed.editResult?.refusal?.category, "validation_failed", method);
        assert.match(routed.editResult?.refusal?.message ?? "", /GraphProvider.*provider boom/, method);
      }
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const value = 1;\n");
      assert.equal(existsSync(join(repo, "src/renamed-feature/index.ts")), false);
    });
  });

  it("refuses moving a directory into its own descendant", async () => {
    await withSymbolRepo(async (repo) => {
      mkdirSync(join(repo, "src/feature"), { recursive: true });
      writeFileSync(join(repo, "src/feature/index.ts"), "export const featureValue = 1;\n");
      const routed = await routeEdit([
        "move",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ fromPath: "src/feature", toPath: "src/feature/nested" })
      ], {
        graphProviderClient: fakeGraphClient(repo, [symbolNode("file:src/feature/index.ts", "File", "src/feature/index.ts", "index")])
      });

      assert.equal(routed.status, "error");
      assert.equal(routed.editResult.refusal.category, "conflict");
      assert.match(routed.editResult.refusal.message, /inside.*source|descendant/i);
      assert.equal(existsSync(join(repo, "src/feature/nested/index.ts")), false);
      assert.equal(readFileSync(join(repo, "src/feature/index.ts"), "utf8"), "export const featureValue = 1;\n");
    });
  });

  it("plans and applies moves with import rewrites, explicit js specifiers, index paths, non-source files, and no stale cached files", async () => {
    await withSymbolRepo(async (repo) => {
      mkdirSync(join(repo, "src/feature"), { recursive: true });
      writeFileSync(join(repo, "src/consumer.ts"), "import { featureValue } from \"./feature/index\";\nexport const value = featureValue;\n");
      writeFileSync(join(repo, "src/feature/index.ts"), "import { helperValue } from \"./helper.js\";\nexport const featureValue = helperValue;\n");
      writeFileSync(join(repo, "src/feature/helper.ts"), "export const helperValue = 1;\n");
      writeFileSync(join(repo, "src/feature/README.md"), "# feature\n");
      writeFileSync(join(repo, "src/unrelated.ts"), "export const unrelated = 1;\n");
      const graph = fakeGraphClient(repo, [
        symbolNode("file:src/feature/index.ts", "File", "src/feature/index.ts", "index"),
        symbolNode("file:src/feature/helper.ts", "File", "src/feature/helper.ts", "helper")
      ]);

      const preview = await routeEdit([
        "move",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ fromPath: "src/feature", toPath: "src/renamed-feature" })
      ], { graphProviderClient: graph });

      assert.equal(preview.status, "ok");
      assert.deepEqual(preview.editPlan.changes.map((change) => `${change.kind}:${change.path}`).sort(), [
        "create:src/renamed-feature/helper.ts",
        "create:src/renamed-feature/index.ts",
        "delete:src/feature/helper.ts",
        "delete:src/feature/index.ts",
        "rename:src/feature/README.md",
        "replace:src/consumer.ts"
      ]);
      assert.deepEqual(preview.editPlan.validation.request.overlays.find((overlay) => overlay.path === "src/renamed-feature/README.md"), {
        path: "src/renamed-feature/README.md",
        action: "write",
        content: "# feature\n",
        checksumBefore: undefined
      });
      assert.match(preview.editPlan.changes.find((change) => change.path === "src/consumer.ts").content, /"\.\/renamed-feature\/index"/);
      assert.match(preview.editPlan.changes.find((change) => change.path === "src/renamed-feature/index.ts").content, /"\.\/helper\.js"/);

      writeFileSync(join(repo, "src/unrelated.ts"), "export const unrelated = 2;\n");
      const applied = await routeEdit([
        "move",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ fromPath: "src/feature", toPath: "src/renamed-feature" }),
        "--apply"
      ], { graphProviderClient: graph, validationRunner: recordingRunner(passedValidation()) });

      assert.equal(applied.status, "ok");
      assert.equal(existsSync(join(repo, "src/feature/index.ts")), false);
      assert.equal(readFileSync(join(repo, "src/consumer.ts"), "utf8"), "import { featureValue } from \"./renamed-feature/index\";\nexport const value = featureValue;\n");
      assert.equal(readFileSync(join(repo, "src/renamed-feature/index.ts"), "utf8"), "import { helperValue } from \"./helper.js\";\nexport const featureValue = helperValue;\n");
      assert.equal(readFileSync(join(repo, "src/renamed-feature/README.md"), "utf8"), "# feature\n");
      assert.equal(readFileSync(join(repo, "src/unrelated.ts"), "utf8"), "export const unrelated = 2;\n");
    });
  });

  it("refuses binary non-source files in directory moves without changing bytes", async () => {
    await withSymbolRepo(async (repo) => {
      mkdirSync(join(repo, "src/feature"), { recursive: true });
      writeFileSync(join(repo, "src/feature/index.ts"), "export const featureValue = 1;\n");
      const binaryPath = join(repo, "src/feature/blob.bin");
      const originalBytes = Uint8Array.from([255, 0, 254, 65, 128]);
      writeFileSync(binaryPath, originalBytes);
      const graph = fakeGraphClient(repo, [symbolNode("file:src/feature/index.ts", "File", "src/feature/index.ts", "index")]);

      const applied = await routeEdit([
        "move",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ fromPath: "src/feature", toPath: "src/renamed-feature" }),
        "--apply"
      ], { graphProviderClient: graph, validationRunner: recordingRunner(passedValidation()) });

      assert.equal(applied.status, "error");
      assert.equal(applied.editResult.refusal.category, "unsupported_change");
      assert.deepEqual([...readFileSync(binaryPath)], [...originalBytes]);
      assert.equal(existsSync(join(repo, "src/renamed-feature/blob.bin")), false);
      assert.equal(readFileSync(join(repo, "src/feature/index.ts"), "utf8"), "export const featureValue = 1;\n");
    });
  });

  it("refuses non-source move sources that resolve outside the repository through symlinks", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lattice-edit-symbols-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "TOP_SECRET\n");
      await withSymbolRepo(async (repo) => {
        symlinkSync(join(outside, "secret.md"), join(repo, "src/link.md"));
        const graph = fakeGraphClient(repo, [symbolNode("file:src/link.md", "File", "src/link.md", "link")]);

        const workspace = await createNodeEditWorkspace({ repoRoot: repo });
        const preview = await createSymbolEditPlan(
          workspace,
          { repoRoot: repo },
          { kind: "move", fromPath: "src/link.md", toPath: "src/moved.md" },
          graph
        );

        assert.equal(preview.ok, false);
        assert.equal(preview.refusal.category, "unsafe_edit");
        assert.match(preview.refusal.message, /outside repository|symlink/i);
        assert.equal(JSON.stringify(preview).includes("TOP_SECRET"), false);
        assert.equal(existsSync(join(repo, "src/moved.md")), false);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not read source-file symlinks that resolve outside the repository while planning previews", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lattice-edit-symbols-outside-"));
    try {
      writeFileSync(join(outside, "secret.ts"), "import { value } from \"../src/a\";\nexport const leaked = value + \"TOP_SECRET\";\n");
      await withSymbolRepo(async (repo) => {
        writeFileSync(join(repo, "src/a.ts"), "export const value = 1;\n");
        symlinkSync(join(outside, "secret.ts"), join(repo, "src/link.ts"));
        const graph = fakeGraphClient(repo, [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")]);
        const workspace = await createNodeEditWorkspace({ repoRoot: repo });

        const preview = await createSymbolEditPlan(
          workspace,
          { repoRoot: repo },
          { kind: "rename", target: { path: "src/a.ts", name: "value" }, newName: "nextValue" },
          graph
        );

        assert.equal(JSON.stringify(preview).includes("TOP_SECRET"), false);
        if (preview.ok) {
          assert.equal(preview.plan.changes.some((change) => change.path === "src/link.ts"), false);
          assert.deepEqual(preview.plan.changes.map((change) => change.path), ["src/a.ts"]);
        } else {
          assert.match(preview.refusal.message, /outside repository|symlink/i);
        }
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("plans signature add, remove, and rename call-site edits and refuses unsafe adds", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export function greet(name: string) {\n  return name;\n}\nexport function suffix(name: string, mark: string) {\n  return mark;\n}\n");
      writeFileSync(join(repo, "src/b.ts"), "import { greet, suffix } from \"./a\";\nexport const a = greet(\"Ada\");\nexport const b = suffix(\"Ada\", \"!\");\n");
      const graph = fakeGraphClient(repo, [
        symbolNode("function:src/a.ts#greet", "Function", "src/a.ts", "greet"),
        symbolNode("function:src/a.ts#suffix", "Function", "src/a.ts", "suffix")
      ]);

      const add = await routeEdit([
        "signature",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, changes: [{ action: "add", name: "punctuation", type: "string", defaultValue: "\"!\"", position: 1 }] })
      ], { graphProviderClient: graph });
      assert.equal(add.status, "ok");
      assert.match(add.editPlan.changes.find((change) => change.path === "src/a.ts").content, /greet\(name: string, punctuation: string = "!"\)/);
      assert.match(add.editPlan.changes.find((change) => change.path === "src/b.ts").content, /greet\("Ada", "!"\)/);

      const remove = await routeEdit([
        "signature",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "suffix" }, changes: [{ action: "remove", name: "name" }] })
      ], { graphProviderClient: graph });
      assert.equal(remove.status, "ok");
      assert.match(remove.editPlan.changes.find((change) => change.path === "src/a.ts").content, /suffix\(mark: string\)/);
      assert.match(remove.editPlan.changes.find((change) => change.path === "src/b.ts").content, /suffix\("!"\)/);

      const rename = await routeEdit([
        "signature",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, changes: [{ action: "rename", name: "name", newName: "personName" }] })
      ], { graphProviderClient: graph });
      assert.equal(rename.status, "ok");
      assert.match(rename.editPlan.changes.find((change) => change.path === "src/a.ts").content, /greet\(personName: string\)/);
      assert.match(rename.editPlan.changes.find((change) => change.path === "src/a.ts").content, /return personName/);

      const unsafe = await routeEdit([
        "signature",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, changes: [{ action: "add", name: "unsafe", type: "string" }] })
      ], { graphProviderClient: graph });
      assert.equal(unsafe.status, "error");
      assert.equal(unsafe.editResult.refusal.category, "unsupported_change");
    });
  });

  it("refuses signature removal when the removed parameter is still referenced by the function body", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export function greet(name: string) {\n  return name;\n}\n");
      const graph = fakeGraphClient(repo, [symbolNode("function:src/a.ts#greet", "Function", "src/a.ts", "greet")]);

      const remove = await routeEdit([
        "signature",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, changes: [{ action: "remove", name: "name" }] })
      ], { graphProviderClient: graph });

      assert.equal(remove.status, "error");
      assert.equal(remove.editResult.refusal.category, "unsafe_edit");
      assert.match(remove.editResult.refusal.message, /body references.*name/);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export function greet(name: string) {\n  return name;\n}\n");
    });
  });

  it("keeps signature edits scoped away from unrelated same-name imports", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export function greet(name: string) {\n  return name;\n}\n");
      writeFileSync(join(repo, "src/other.ts"), "export function greet(name: string) {\n  return name.toUpperCase();\n}\n");
      writeFileSync(join(repo, "src/b.ts"), "import { greet } from \"./a\";\nexport const a = greet(\"Ada\");\n");
      writeFileSync(join(repo, "src/c.ts"), "import { greet } from \"./other\";\nexport const c = greet(\"Grace\");\n");
      writeFileSync(join(repo, "src/d.ts"), "import { greet as greetFromA } from \"./a\";\nexport const d = greetFromA(\"Lin\");\n");
      const graph = fakeGraphClient(repo, [
        symbolNode("function:src/a.ts#greet", "Function", "src/a.ts", "greet"),
        symbolNode("function:src/other.ts#greet", "Function", "src/other.ts", "greet")
      ]);

      const add = await routeEdit([
        "signature",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "greet" }, changes: [{ action: "add", name: "punctuation", type: "string", defaultValue: "\"!\"", position: 1 }] })
      ], { graphProviderClient: graph });

      assert.equal(add.status, "ok");
      assert.deepEqual(add.editPlan.changes.map((change) => change.path), ["src/a.ts", "src/b.ts", "src/d.ts"]);
      assert.match(add.editPlan.changes.find((change) => change.path === "src/b.ts").content, /greet\("Ada", "!"\)/);
      assert.match(add.editPlan.changes.find((change) => change.path === "src/d.ts").content, /greetFromA\("Lin", "!"\)/);
      assert.equal(add.editPlan.changes.some((change) => change.path === "src/c.ts"), false);
      assert.equal(readFileSync(join(repo, "src/c.ts"), "utf8"), "import { greet } from \"./other\";\nexport const c = greet(\"Grace\");\n");
    });
  });

  it("runs symbol apply through validation and leaves worktree unchanged on validation refusal", async () => {
    await withSymbolRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "export const value = 1;\n");
      const graph = fakeGraphClient(repo, [symbolNode("const:src/a.ts#value", "symbol", "src/a.ts", "value")]);
      const runner = recordingRunner({ ok: false, status: "refused", diagnostics: [], refusal: { category: "conflict", message: "blocked" } });

      const routed = await routeEdit([
        "rename",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ target: { path: "src/a.ts", name: "value" }, newName: "nextValue" }),
        "--apply"
      ], { graphProviderClient: graph, validationRunner: runner });

      assert.equal(routed.status, "error");
      assert.equal(routed.editResult.refusal.category, "conflict");
      assert.equal(runner.requests.length, 1);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const value = 1;\n");
    });
  });
});

function projectRepoPaths(repoRoot, project) {
  return project.getSourceFiles()
    .map((sourceFile) => resolve(sourceFile.getFilePath()))
    .filter((filePath) => filePath.startsWith(resolve(repoRoot)))
    .map((filePath) => filePath.slice(resolve(repoRoot).length + 1).replaceAll("\\", "/"))
    .sort();
}

function snapshotProject(project) {
  return new Map(project.getSourceFiles().map((sourceFile) => [sourceFile.getFilePath(), sourceFile.getFullText()]));
}

function revertProject(project, snapshot) {
  for (const sourceFile of project.getSourceFiles()) {
    const text = snapshot.get(sourceFile.getFilePath());
    if (text !== undefined) sourceFile.replaceWithText(text);
  }
}

async function routeEdit(args, options = {}) {
  return routeCommandAdapter({
    bin: "opcore",
    argv: [...args, "--json"],
    groupName: "edit",
    adapter: createEditCommandAdapter(options)
  });
}

async function withSymbolRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), "lattice-edit-symbols-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext", target: "es2022", moduleResolution: "bundler", allowJs: true }, include: ["src/**/*"] }, null, 2));
    await run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function fakeGraphClient(repo, nodes = [], options = {}) {
  let status = availableStatus(repo, "freshness-1");
  const changedFiles = options.changedFiles ?? [];
  const deletedFiles = options.deletedFiles ?? [];
  const renamedFiles = options.renamedFiles ?? [];
  const metadata = () => ({
    schemaVersion: 1,
    provider: "opcore-graph",
    repo: { repoRoot: repo },
    generatedAt: status.freshness.generatedAt,
    freshness: status.freshness,
    nodeKinds: ["File", "Function", "symbol"],
    edgeKinds: ["CONTAINS", "IMPORTS_FROM", "CALLS"]
  });
  return {
    setStatus(next) {
      status = next;
    },
    status: async () => status,
    factQuery: async (request) => status.state === "available"
      ? { requestId: request.requestId, status, metadata: metadata(), nodes: nodesForSelector(nodes, request.selector), edges: [] }
      : { requestId: request.requestId, status },
    namedQuery: async (request) => status.state === "available"
      ? {
          requestId: request.requestId,
          status,
          metadata: metadata(),
          queryKind: request.queryKind,
          target: request.target,
          nodes: nodesForNamedQuery(nodes, request),
          edges: [],
          traversal: emptyTraversal(nodesForNamedQuery(nodes, request).length)
        }
      : { requestId: request.requestId, status },
    search: async (request) => status.state === "available"
      ? {
          requestId: request.requestId,
          status,
          metadata: metadata(),
          query: request.query,
          searchMode: { engine: "fts5", querySyntax: "fts5", limit: request.limit ?? 20, contextFiles: request.files ?? [] },
          summary: { query: request.query, total: nodes.length, returned: nodes.length, limit: request.limit ?? 20, indexedNodeKinds: ["Function", "symbol"], contextFiles: request.files ?? [] },
          results: nodes.filter((node) => node.name === request.query).map((node, index) => ({ nodeId: node.id, kind: node.kind, path: node.path, name: node.name, qualifiedName: node.id, filePath: node.path, signature: node.name ?? node.id, score: 1, rank: index + 1, matches: [request.query] })),
          hints: []
        }
      : { requestId: request.requestId, status },
    reviewContext: async (request) => status.state === "available"
      ? { requestId: request.requestId, status, metadata: metadata(), changedFiles, deletedFiles, renamedFiles, impactedFiles: [], impactedSymbols: [], tests: [], nodes: [], edges: [], traversal: emptyTraversal() }
      : { requestId: request.requestId, status },
    detectChanges: async (request) => status.state === "available"
      ? { requestId: request.requestId, status, metadata: metadata(), changedFiles, deletedFiles, renamedFiles }
      : { requestId: request.requestId, status }
  };
}

function throwingGraphClient(repo, nodes, method) {
  const graph = fakeGraphClient(repo, nodes);
  return {
    ...graph,
    [method]: async () => {
      throw new Error("provider boom");
    }
  };
}

function nodesForSelector(nodes, selector) {
  return nodes.filter((node) => {
    if (selector.ids?.length && !selector.ids.includes(node.id)) return false;
    if (selector.nodeKinds?.length && !selector.nodeKinds.includes(node.kind)) return false;
    if (selector.text && !(node.id.includes(selector.text) || node.name?.includes(selector.text))) return false;
    return true;
  });
}

function nodesForNamedQuery(nodes, request) {
  if (request.queryKind === "file_summary") return nodes.filter((node) => node.path === request.target || node.id === request.target);
  return [];
}

function symbolNode(id, kind, path, name) {
  return { id, kind, path, name };
}

function availableStatus(repo, freshnessId) {
  return {
    state: "available",
    mode: "required",
    provider: "opcore-graph",
    schemaVersion: 1,
    repo: { repoRoot: repo },
    freshness: {
      generatedAt: `2026-06-05T00:00:00.000Z-${freshnessId}`,
      ageMs: 0,
      stale: false
    },
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function emptyTraversal(total = 0) {
  return { maxDepth: 0, truncated: false, total, empty: total === 0 };
}

function recordingRunner(result) {
  const requests = [];
  return {
    requests,
    async runValidation(request) {
      requests.push(request);
      return result;
    }
  };
}

function passedValidation() {
  return {
    ok: true,
    status: "passed",
    diagnostics: [],
    graphStatus: {
      state: "available",
      mode: "required",
      provider: "opcore-graph",
      schemaVersion: 1,
      repo: { repoId: "validation" },
      freshness: { generatedAt: "2026-06-05T00:00:00.000Z", ageMs: 0, stale: false },
      nodes_by_kind: {},
      edges_by_kind: {}
    }
  };
}
