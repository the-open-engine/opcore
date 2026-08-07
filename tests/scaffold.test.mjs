import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("Opcore scaffold", () => {
  it("keeps opcore, graph, edit, and validation as separate package tracks", () => {
    const root = readJson("package.json");
    assert.deepEqual(root.workspaces, [
      "packages/contracts",
      "packages/opcore",
      "packages/graph",
      "packages/edit",
      "packages/validation",
      "packages/validation-policy",
      "packages/validation-clone",
      "packages/validation-docs",
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
      "validation-policy",
      "validation-clone",
      "validation-docs",
      "validation-python",
      "validation-rust",
      "validation-typescript",
      "fixtures"
    ].map((name) => readJson(`packages/${name}/package.json`).name);

    assert.deepEqual(packages, [
      "@the-open-engine/opcore-contracts",
      "opcore",
      "@the-open-engine/opcore-graph",
      "@the-open-engine/opcore-edit",
      "@the-open-engine/opcore-validation",
      "@the-open-engine/opcore-validation-policy",
      "@the-open-engine/opcore-validation-clone",
      "@the-open-engine/opcore-validation-docs",
      "@the-open-engine/opcore-validation-python",
      "@the-open-engine/opcore-validation-rust",
      "@the-open-engine/opcore-validation-typescript",
      "@the-open-engine/opcore-fixtures"
    ]);
  });

  it("uses Opcore for repository validation", () => {
    assert.equal(readFileSync("AGENTS.md", "utf8"), readFileSync("CLAUDE.md", "utf8"));
    assert.equal(existsSync(".opcore/config"), true);
    assert.equal(existsSync(".zeroshot/settings.json"), true);
    assert.equal(existsSync("scripts/run-opcore-self-check.mjs"), true);
    assert.equal(existsSync("scripts/ci/run-local-ci-equivalent.sh"), true);

    const root = readJson("package.json");
    assert.equal(root.scripts.setup, "npm ci");
    assert.match(root.scripts["opcore:self-check"], /scripts\/run-opcore-self-check\.mjs/);
    assert.deepEqual(readJson(".zeroshot/settings.json").worktree.setup, ["npm ci"]);
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
