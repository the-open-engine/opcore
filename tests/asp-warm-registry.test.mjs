import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWarmProjectRegistry } from "../packages/opcore/dist/advanced/asp-warm/warm-project-registry.js";

describe("ASP warm project registry", () => {
  it("reuses a scoped ts-morph project and reverts in-memory edits without touching disk", () => {
    const repo = createFixtureRepo();
    try {
      const registry = createWarmProjectRegistry({ repoRoot: repo });
      const first = registry.checkout({ preferredPath: "src/api.ts", scope: "whole_repo" });
      const second = registry.checkout({ preferredPath: "src/api.ts", scope: "whole_repo" });

      assert.equal(first.processState, "cold");
      assert.equal(second.processState, "warm");
      assert.equal(first.project, second.project);

      const canonicalRepo = registry.state().repoRoot;
      const sourceFile = second.project.getSourceFileOrThrow(join(canonicalRepo, "src/api.ts"));
      const original = sourceFile.getFullText();
      const snapshot = registry.snapshotProject(second.project);
      sourceFile.replaceWithText("export function broken( {\n");
      assert.notEqual(sourceFile.getFullText(), original);

      registry.revertProject(second.project, snapshot);
      assert.equal(sourceFile.getFullText(), original);
      assert.equal(readFileSync(join(repo, "src/api.ts"), "utf8"), original);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("poisons a failed in-memory edit and rebuilds the next project checkout", () => {
    const repo = createFixtureRepo();
    try {
      const registry = createWarmProjectRegistry({ repoRoot: repo });
      const first = registry.checkout({ preferredPath: "src/api.ts", scope: "whole_repo" });

      assert.throws(
        () =>
          registry.withProject({ preferredPath: "src/api.ts", scope: "whole_repo" }, ({ project }) => {
            project.getSourceFileOrThrow(join(registry.state().repoRoot, "src/api.ts")).replaceWithText("export const corrupted = ;\n");
            throw new Error("synthetic mid-edit fault");
          }),
        /synthetic mid-edit fault/
      );

      assert.equal(registry.state().poisoned, true);
      const rebuilt = registry.checkout({ preferredPath: "src/api.ts", scope: "whole_repo" });
      assert.equal(rebuilt.processState, "cold");
      assert.notEqual(rebuilt.project, first.project);
      assert.equal(rebuilt.project.getSourceFileOrThrow(join(registry.state().repoRoot, "src/api.ts")).getFullText(), readFileSync(join(repo, "src/api.ts"), "utf8"));
      assert.equal(registry.state().poisoned, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function createFixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "opcore-asp-warm-registry-"));
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/api.ts"), "export function greet(name: string) {\n  return `hello ${name}`;\n}\n");
  writeFileSync(join(repo, "src/use.ts"), "import { greet } from \"./api\";\nexport const message = greet(\"Ada\");\n");
  return repo;
}
