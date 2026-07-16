import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePythonImports } from "../packages/graph/dist/index.js";
import { analyzePythonImportsWithGraph } from "../packages/graph/dist/python-import-analysis.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(repoRoot, "packages/fixtures/source-extraction/python");
const expected = JSON.parse(readFileSync(join(fixtureRoot, "python.expected.json"), "utf8"));

describe("graph Python import analysis adapter", () => {
  it("returns canonical directed graph-core edges for supplied Python files", async () => {
    const edges = await analyzePythonImports([
      { path: "src/app.py", content: "from pkg import (\n    dep as renamed,\n)\n" },
      { path: "src/pkg/__init__.py", content: "" },
      { path: "src/pkg/dep.py", content: "VALUE = 1\n" }
    ]);

    assert.deepEqual(edges, [{ fromPath: "src/app.py", toPath: "src/pkg/dep.py" }]);
  });

  it("matches the shared Python fixture edge matrix without mutating source files", async () => {
    const beforeFiles = fixtureFiles();
    const edges = await analyzePythonImports(
      [...beforeFiles].map(([path, content]) => ({ path, content }))
    );

    assert.deepEqual(edges, expected.pythonImportEdges);
    assert.deepEqual(fixtureFiles(), beforeFiles);
  });

  it("rejects unsafe or malformed supplied-file paths before native analysis", async () => {
    await assert.rejects(
      analyzePythonImports([{ path: "../outside.py", content: "VALUE = 1\n" }]),
      /repo-relative|traversal|invalid/i
    );
    await assert.rejects(
      analyzePythonImports([{ path: "src/app.ts", content: "export const value = 1;\n" }]),
      /only \.py\/\.pyi/i
    );
  });

  it("fails loudly and removes its temporary state when graph analysis fails", async () => {
    let analysisRoot;
    await assert.rejects(
      analyzePythonImportsWithGraph(
        [{ path: "src/app.py", content: "VALUE = 1\n" }],
        {
          build(repo) {
            analysisRoot = dirname(repo.repoRoot);
            assert.equal(existsSync(analysisRoot), true);
            throw new Error("native build unavailable");
          },
          query() {
            throw new Error("query must not run");
          }
        }
      ),
      /native build unavailable/
    );
    assert.equal(typeof analysisRoot, "string");
    assert.equal(existsSync(analysisRoot), false);
  });

  it("rejects unavailable and malformed graph query results instead of returning empty edges", async () => {
    const available = { state: "available", mode: "required", provider: "opcore-graph", schemaVersion: 1 };
    const build = () => ({ status: available });
    await assert.rejects(
      analyzePythonImportsWithGraph([{ path: "src/app.py", content: "VALUE = 1\n" }], {
        build,
        query: () => ({
          status: {
            state: "required_missing",
            mode: "required",
            provider: "opcore-graph",
            schemaVersion: 1,
            message: "native query unavailable"
          }
        })
      }),
      /query failed.*native query unavailable/i
    );
    await assert.rejects(
      analyzePythonImportsWithGraph([{ path: "src/app.py", content: "VALUE = 1\n" }], {
        build,
        query: () => ({ status: available })
      }),
      /query failed.*available/i
    );
  });
});

function fixtureFiles() {
  return new Map(
    walkFiles(fixtureRoot)
      .filter((path) => path.endsWith(".py") || path.endsWith(".pyi"))
      .map((path) => [relative(fixtureRoot, path).replaceAll("\\", "/"), readFileSync(path, "utf8")])
  );
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name !== ".opcore") files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

