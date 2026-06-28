import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("lattice scaffold", () => {
  it("keeps opcore, graph, edit, and validation as separate package tracks", () => {
    const root = readJson("package.json");
    assert.deepEqual(root.workspaces, [
      "packages/contracts",
      "packages/opcore",
      "packages/graph",
      "packages/edit",
      "packages/validation",
      "packages/validation-clone",
      "packages/validation-python",
      "packages/validation-rust",
      "packages/validation-typescript",
      "packages/asp-provider",
      "packages/fixtures"
    ]);
    assert.equal(root.optionalDependencies["@the-open-engine/opcore-graph-core-darwin-arm64"], "file:packages/opcore-graph-core-darwin-arm64");
    assert.equal(root.optionalDependencies["@the-open-engine/opcore-graph-core-darwin-x64"], "file:packages/opcore-graph-core-darwin-x64");
    assert.equal(root.optionalDependencies["@the-open-engine/opcore-graph-core-linux-x64"], "file:packages/opcore-graph-core-linux-x64");

    const packages = [
      "contracts",
      "opcore",
      "graph",
      "edit",
      "validation",
      "validation-clone",
      "validation-python",
      "validation-rust",
      "validation-typescript",
      "fixtures"
    ].map((name) => readJson(`packages/${name}/package.json`).name);

    assert.deepEqual(packages, [
      "@the-open-engine/opcore-contracts",
      "@the-open-engine/opcore",
      "@the-open-engine/opcore-graph",
      "@the-open-engine/opcore-edit",
      "@the-open-engine/opcore-validation",
      "@the-open-engine/opcore-validation-clone",
      "@the-open-engine/opcore-validation-python",
      "@the-open-engine/opcore-validation-rust",
      "@the-open-engine/opcore-validation-typescript",
      "@the-open-engine/opcore-fixtures"
    ]);
  });

  it("does not publish as code-review-graph or gungnir", () => {
    for (const name of [
      "contracts",
      "opcore",
      "graph",
      "edit",
      "validation",
      "validation-clone",
      "validation-python",
      "validation-rust",
      "validation-typescript",
      "fixtures"
    ]) {
      const manifest = readJson(`packages/${name}/package.json`);
      assert.equal(manifest.name.includes("code-review-graph"), false);
      assert.equal(manifest.name.includes("gungnir"), false);
    }
  });

  it("keeps agent tooling pointed at current external tools", () => {
    assert.equal(readFileSync("AGENTS.md", "utf8"), readFileSync("CLAUDE.md", "utf8"));
    assert.equal(existsSync("ace.json"), true);
    assert.equal(existsSync("rox.json"), true);
    assert.equal(existsSync(".zeroshot/settings.json"), true);
    assert.equal(existsSync("scripts/setup-current-tools.sh"), true);
    assert.equal(existsSync("scripts/ci/run-local-ci-equivalent.sh"), true);

    const setupTools = readFileSync("scripts/setup-current-tools.sh", "utf8");
    assert.match(setupTools, /external ACE-managed tools/);
    assert.match(setupTools, /implementation_package_dir/);
    assert.match(setupTools, /use current external tools, not \$\{implementation_path\}/);
    assert.match(setupTools, /aceTools/);
    assert.match(setupTools, /binRoot/);
    assert.match(setupTools, /latticeCurrentTools/);

    const ace = readJson("ace.json");
    assert.match(ace.mcpServers["code-review-graph"].args.join("\n"), /\.ace\/runtime\/bin\/crg/);
  });

  it("pins runtime CLI decision anchors", () => {
    assert.equal(existsSync("docs/architecture/runtime-cli-ard.md"), true);

    const ard = readFileSync("docs/architecture/runtime-cli-ard.md", "utf8");
    for (const token of [
      "Status: Accepted",
      "Decision: hybrid",
      "TS-only",
      "Rust-first",
      "Rust graph core",
      "TypeScript contracts",
      "opcore graph",
      "opcore inspect",
      "opcore edit",
      "opcore check",
      "opcore validate",
      "opcore status",
      "opcore doctor",
      "opcore status",
      "packages/edit",
      "packages/validation",
      "do not collapse graph, edit, and policy ownership into one muddled abstraction",
      "#21"
    ]) {
      assert.match(ard, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    for (const path of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
      const content = readFileSync(path, "utf8");
      assert.match(content, /@docs\/architecture\/runtime-cli-ard\.md/);
      assert.match(content, /hybrid/);
    }
  });
});
