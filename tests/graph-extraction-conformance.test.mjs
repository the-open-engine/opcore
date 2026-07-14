import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { graphProviderBuild, graphProviderQuery } from "../packages/graph/dist/index.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "../packages/fixtures/source-extraction/wave1");
const expected = JSON.parse(readFileSync(resolve(sourceFixtureRoot, "wave1.expected.json"), "utf8"));
const pythonFixtureRoot = resolve(repoRoot, "../packages/fixtures/source-extraction/python");
const pythonExpected = JSON.parse(readFileSync(resolve(pythonFixtureRoot, "python.expected.json"), "utf8"));
const rustOnlyFixtureRoot = resolve(repoRoot, "../packages/fixtures/source-extraction/rust-only");
const nodeNextFixtureRoot = resolve(repoRoot, "../packages/fixtures/source-extraction/node-next");
const nodeNextExpected = JSON.parse(
  readFileSync(resolve(nodeNextFixtureRoot, "node-next.expected.json"), "utf8")
);

describe("graph source extraction conformance", () => {
  it("extracts Wave 1 TS/JS/TSX/JSX facts through the GraphProvider wrapper", () => {
    withFixtureCopy((fixtureRoot) => {
      assert.equal(graphProviderBuild({ repoRoot: fixtureRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      assert.equal(result.status.state, "available");
      assert.deepEqual(sortedUnique(result.metadata.nodeKinds), expected.nodeKinds);
      assert.deepEqual(sortedUnique(result.metadata.edgeKinds), expected.edgeKinds);
      assert.deepEqual(result.nodes.map((node) => node.id).sort(), expected.nodeIds);
      assert.deepEqual(edgeTriples(result.edges), expected.edgeTriples.sort(compareTuple));
      assert.deepEqual(nodeAttributes(result.nodes), expected.nodeAttributes);
      assert.deepEqual(fileExports(result.nodes), expected.fileExports);
      assert.deepEqual(result.diagnostics ?? [], expected.diagnostics);
    });
  });

  it("accepts a repo root string overload", () => {
    withFixtureCopy((fixtureRoot) => {
      assert.equal(graphProviderBuild(fixtureRoot).status.state, "available");
      const result = graphProviderQuery(fixtureRoot);
      assert.equal(result.status.state, "available");
      assert.equal(result.metadata.repo.repoRoot, realpathSync(fixtureRoot));
      assert.deepEqual(result.nodes.map((node) => node.id).sort(), expected.nodeIds);
      assert.deepEqual(nodeAttributes(result.nodes), expected.nodeAttributes);
    });
  });

  it("extracts Python facts through the GraphProvider wrapper", () => {
    withFixtureCopy(pythonFixtureRoot, "python", (fixtureRoot) => {
      assert.equal(graphProviderBuild({ repoRoot: fixtureRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      assert.equal(result.status.state, "available");
      assert.deepEqual(sortedUnique(result.metadata.nodeKinds), pythonExpected.nodeKinds);
      assert.deepEqual(sortedUnique(result.metadata.edgeKinds), pythonExpected.edgeKinds);
      assert.deepEqual(result.nodes.map((node) => node.id).sort(), pythonExpected.nodeIds);
      assert.deepEqual(edgeTriples(result.edges), pythonExpected.edgeTriples.sort(compareTuple));
      assert.deepEqual(nodeAttributes(result.nodes), pythonExpected.nodeAttributes);
      assert.deepEqual(fileExports(result.nodes), pythonExpected.fileExports);
      assert.deepEqual(result.diagnostics ?? [], pythonExpected.diagnostics);
    });
  });

  it("resolves NodeNext source variants and literal module references", () => {
    withFixtureCopy(nodeNextFixtureRoot, "node-next", (fixtureRoot) => {
      assert.equal(graphProviderBuild({ repoRoot: fixtureRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      const fileNodeIds = result.nodes
        .filter((node) => node.kind === "File")
        .map((node) => node.id)
        .sort();
      const moduleEdges = edgeTriples(result.edges).filter(
        ([kind]) => kind === "IMPORTS_FROM" || kind === "DEPENDS_ON"
      );

      assert.equal(result.status.state, "available");
      assert.deepEqual(fileNodeIds, nodeNextExpected.fileNodeIds);
      assert.deepEqual(moduleEdges, nodeNextExpected.moduleEdgeTriples.sort(compareTuple));
      assert.deepEqual(result.diagnostics ?? [], nodeNextExpected.diagnostics);
      assert.equal(
        moduleEdges.some(([, from]) => from === "file:src/nonliteral.ts"),
        false,
        "a nonliteral dynamic import must not fabricate a module edge"
      );
    });
  });

  it("extracts Rust facts through the GraphProvider wrapper", () => {
    const rustOnlyExpected = JSON.parse(readFileSync(resolve(rustOnlyFixtureRoot, "rust-only.expected.json"), "utf8"));

    withFixtureCopy(rustOnlyFixtureRoot, "rust-only", (fixtureRoot) => {
      assert.equal(graphProviderBuild({ repoRoot: fixtureRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      const nodes = nodeMap(result.nodes);
      const triples = edgeTriples(result.edges);

      assert.equal(result.status.state, "available");
      assert.deepEqual(sortedUnique(result.metadata.nodeKinds), rustOnlyExpected.nodeKinds);
      assert.deepEqual(sortedUnique(result.metadata.edgeKinds), rustOnlyExpected.edgeKinds);
      assert.deepEqual(result.nodes.map((node) => node.id).sort(), rustOnlyExpected.nodeIds);
      assert.deepEqual(triples, rustOnlyExpected.edgeTriples.sort(compareTuple));
      assert.deepEqual(nodeAttributes(result.nodes), rustOnlyExpected.nodeAttributes);
      assert.deepEqual(fileExports(result.nodes), rustOnlyExpected.fileExports);
      assert.deepEqual(result.diagnostics ?? [], []);
      assert.equal(nodes.get("file:src/lib.rs")?.kind, "File");
      assert.equal(nodes.get("module:src/lib.rs#crate")?.kind, "Module");
      assert.equal(nodes.get("struct:src/lib.rs#Widget")?.kind, "Struct");
      assert.equal(nodes.get("enum:src/lib.rs#Mode")?.kind, "Enum");
      assert.equal(nodes.get("trait:src/lib.rs#Service")?.kind, "Trait");
      assert.equal(nodes.get("impl:src/lib.rs#impl Service for Widget")?.kind, "Impl");
      assert.equal(nodes.get("method:src/lib.rs#Widget::handle")?.kind, "Method");
      assert.equal(nodes.get("type:src/lib.rs#Alias")?.kind, "TypeAlias");
      assert.equal(nodes.get("const:src/lib.rs#LIMIT")?.kind, "Const");
      assert.equal(nodes.get("static:src/lib.rs#NAME")?.kind, "Static");
      assert.equal(nodes.get("macro:src/lib.rs#trace")?.kind, "Macro");
      assert.equal(nodes.get("function:src/helpers.rs#helpers::assist")?.kind, "Function");
      assert.equal(nodes.get("function:src/user.rs#user::run")?.kind, "Function");
      assert.equal(nodes.get("test:src/user.rs#user.tests::test_run")?.kind, "Test");

      const attributes = nodes.get("struct:src/lib.rs#Widget")?.attributes;
      assert.equal(attributes.language, "rust");
      assert.equal(attributes.exported, true);
      assert.equal(attributes.qualifiedName, "Widget");
      assert.match(attributes.signature, /pub struct Widget/);
      assert.equal(Number.isInteger(attributes.lineStart), true);
      assert.equal(Number.isInteger(attributes.lineEnd), true);

      assertIncludesTriple(triples, ["IMPORTS_FROM", "file:src/user.rs", "file:src/helpers.rs"]);
      assertIncludesTriple(triples, [
        "CALLS",
        "function:src/user.rs#user::run",
        "function:src/helpers.rs#helpers::assist"
      ]);
      assertIncludesTriple(triples, [
        "IMPLEMENTS",
        "impl:src/lib.rs#impl Service for Widget",
        "trait:src/lib.rs#Service"
      ]);
      assertIncludesTriple(triples, [
        "TESTED_BY",
        "function:src/user.rs#user::run",
        "test:src/user.rs#user.tests::test_run"
      ]);
    });
  });

  it("resolves Rust crate module imports to module files through the GraphProvider wrapper", () => {
    withFixtureCopy(rustOnlyFixtureRoot, "rust-module-import", (fixtureRoot) => {
      assert.equal(graphProviderBuild({ repoRoot: fixtureRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      const triples = edgeTriples(result.edges);

      assert.equal(result.status.state, "available");
      assert.deepEqual(result.diagnostics ?? [], []);
      assertIncludesTriple(triples, ["IMPORTS_FROM", "file:src/user.rs", "file:src/helpers.rs"]);
      assertIncludesTriple(triples, ["DEPENDS_ON", "file:src/user.rs", "file:src/helpers.rs"]);
      assertIncludesTriple(triples, ["IMPORTS_FROM", "file:src/user.rs", "file:src/lib.rs"]);
      assertIncludesTriple(triples, ["DEPENDS_ON", "file:src/user.rs", "file:src/lib.rs"]);
    });
  });
});

function withFixtureCopy(rootOrRun, nameOrRun, maybeRun) {
  const root = typeof rootOrRun === "string" ? rootOrRun : sourceFixtureRoot;
  const name = typeof nameOrRun === "string" ? nameOrRun : "wave1";
  const run = maybeRun ?? rootOrRun;
  const temp = mkdtempSync(join(tmpdir(), `lattice-${name}-`));
  const fixtureRoot = join(temp, name);
  try {
    cpSync(root, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function skipGeneratedStore(source) {
  const normalized = source.replaceAll("\\", "/");
  return !normalized.endsWith("/.lattice") && !normalized.includes("/.lattice/");
}

function edgeTriples(edges) {
  return edges.map((edge) => [edge.kind, edge.from, edge.to]).sort(compareTuple);
}

function assertIncludesTriple(triples, triple) {
  assert.equal(triples.some((candidate) => candidate.join("\0") === triple.join("\0")), true, triple.join(" "));
}

function nodeMap(nodes) {
  return new Map(nodes.map((node) => [node.id, node]));
}

function nodeAttributes(nodes) {
  return Object.fromEntries(
    nodes
      .filter((node) => node.kind !== "File")
      .map((node) => [node.id, node.attributes ?? {}])
      .sort(compareEntry)
  );
}

function fileExports(nodes) {
  return Object.fromEntries(
    nodes
      .filter((node) => node.kind === "File" && node.attributes?.exports !== undefined)
      .map((node) => [node.id, node.attributes.exports])
      .sort(compareEntry)
  );
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function compareTuple(left, right) {
  return left.join("\0").localeCompare(right.join("\0"));
}

function compareEntry(left, right) {
  return left[0].localeCompare(right[0]);
}
