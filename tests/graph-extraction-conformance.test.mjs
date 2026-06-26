import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { graphProviderBuild, graphProviderQuery } from "../packages/graph/dist/index.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "../packages/fixtures/source-extraction/wave1");
const rustFixtureRoot = resolve(repoRoot, "../packages/fixtures/source-extraction/rust-basic");
const expected = JSON.parse(readFileSync(resolve(sourceFixtureRoot, "wave1.expected.json"), "utf8"));

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

  it("extracts Rust facts through the GraphProvider wrapper", () => {
    withFixtureCopyFrom(rustFixtureRoot, "rust-basic", (fixtureRoot) => {
      assert.equal(graphProviderBuild({ repoRoot: fixtureRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      const nodes = nodeMap(result.nodes);
      const triples = edgeTriples(result.edges);

      assert.equal(result.status.state, "available");
      assert.deepEqual(result.diagnostics ?? [], []);
      assert.equal(nodes.get("file:src/lib.rs")?.kind, "File");
      assert.equal(nodes.get("module:src/lib.rs#crate")?.kind, "Module");
      assert.equal(nodes.get("struct:src/lib.rs#crate::Widget")?.kind, "Struct");
      assert.equal(nodes.get("enum:src/lib.rs#crate::WidgetState")?.kind, "Enum");
      assert.equal(nodes.get("trait:src/lib.rs#crate::Greeter")?.kind, "Trait");
      assert.equal(nodes.get("impl:src/lib.rs#crate::Widget")?.kind, "Impl");
      assert.equal(nodes.get("impl:src/lib.rs#crate::Greeter_for_Widget")?.kind, "Impl");
      assert.equal(nodes.get("method:src/lib.rs#crate::Widget::new")?.kind, "Method");
      assert.equal(nodes.get("type:src/lib.rs#crate::WidgetId")?.kind, "TypeAlias");
      assert.equal(nodes.get("const:src/lib.rs#crate::DEFAULT_ID")?.kind, "Const");
      assert.equal(nodes.get("static:src/lib.rs#crate::DEFAULT_NAME")?.kind, "Static");
      assert.equal(nodes.get("macro:src/lib.rs#crate::make_label")?.kind, "Macro");
      assert.equal(nodes.get("function:src/lib.rs#crate::build_widget")?.kind, "Function");
      assert.equal(nodes.get("test:src/lib.rs#crate::tests::builds_widget")?.kind, "Test");
      assert.equal(nodes.get("function:src/helpers.rs#crate::helpers::helper_value")?.kind, "Function");
      assert.equal(nodes.get("package:serde")?.kind, "package");

      const attrs = nodes.get("struct:src/lib.rs#crate::Widget")?.attributes;
      assert.equal(attrs.language, "rust");
      assert.equal(attrs.exported, true);
      assert.equal(attrs.qualifiedName, "crate::Widget");
      assert.match(attrs.signature, /pub struct Widget/);
      assert.equal(Number.isInteger(attrs.lineStart) && attrs.lineStart > 0, true);
      assert.equal(Number.isInteger(attrs.lineEnd) && attrs.lineEnd >= attrs.lineStart, true);

      assertIncludesTriple(triples, ["CONTAINS", "file:src/lib.rs", "module:src/lib.rs#crate"]);
      assertIncludesTriple(triples, ["IMPORTS_FROM", "file:src/lib.rs", "file:src/helpers.rs"]);
      assertIncludesTriple(triples, ["DEPENDS_ON", "file:src/lib.rs", "package:serde"]);
      assertIncludesTriple(triples, [
        "CALLS",
        "function:src/lib.rs#crate::build_widget",
        "method:src/lib.rs#crate::Widget::new"
      ]);
      assertIncludesTriple(triples, [
        "CALLS",
        "method:src/lib.rs#crate::Widget::greet",
        "function:src/helpers.rs#crate::helpers::helper_value"
      ]);
      assertIncludesTriple(triples, [
        "IMPLEMENTS",
        "impl:src/lib.rs#crate::Greeter_for_Widget",
        "trait:src/lib.rs#crate::Greeter"
      ]);
    });
  });

  it("resolves Rust grouped self imports to module files through the GraphProvider wrapper", () => {
    withTempRepo("rust-module-import", (repoRoot) => {
      writeFixtureFile(
        repoRoot,
        "src/lib.rs",
        `
          pub mod helpers;
          pub mod user;
        `
      );
      writeFixtureFile(repoRoot, "src/helpers.rs", "pub fn helper_value() -> u64 { 1 }\n");
      writeFixtureFile(
        repoRoot,
        "src/user.rs",
        `
          use crate::helpers::{self};
          pub fn run() -> u64 { helpers::helper_value() }
        `
      );

      assert.equal(graphProviderBuild({ repoRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot });
      const triples = edgeTriples(result.edges);

      assert.equal(result.status.state, "available");
      assert.deepEqual(result.diagnostics ?? [], []);
      assertIncludesTriple(triples, ["IMPORTS_FROM", "file:src/user.rs", "file:src/helpers.rs"]);
      assertIncludesTriple(triples, ["DEPENDS_ON", "file:src/user.rs", "file:src/helpers.rs"]);
      assertExcludesTriple(triples, ["IMPORTS_FROM", "file:src/user.rs", "file:src/lib.rs"]);
      assertExcludesTriple(triples, ["DEPENDS_ON", "file:src/user.rs", "file:src/lib.rs"]);
    });
  });

  it("resolves Rust aliased function imports to call edges through the GraphProvider wrapper", () => {
    withTempRepo("rust-aliased-import", (repoRoot) => {
      writeFixtureFile(
        repoRoot,
        "src/lib.rs",
        `
          pub mod helpers;
          pub mod user;
        `
      );
      writeFixtureFile(repoRoot, "src/helpers.rs", "pub fn helper_value() -> u64 { 1 }\n");
      writeFixtureFile(
        repoRoot,
        "src/user.rs",
        `
          use crate::helpers::helper_value as hv;
          pub fn run() -> u64 { hv() }
        `
      );

      assert.equal(graphProviderBuild({ repoRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot });
      const triples = edgeTriples(result.edges);

      assert.equal(result.status.state, "available");
      assert.deepEqual(result.diagnostics ?? [], []);
      assertIncludesTriple(triples, ["IMPORTS_FROM", "file:src/user.rs", "file:src/helpers.rs"]);
      assertIncludesTriple(triples, ["DEPENDS_ON", "file:src/user.rs", "file:src/helpers.rs"]);
      assertIncludesTriple(triples, [
        "CALLS",
        "function:src/user.rs#crate::user::run",
        "function:src/helpers.rs#crate::helpers::helper_value"
      ]);
    });
  });
});

function withFixtureCopy(run) {
  withFixtureCopyFrom(sourceFixtureRoot, "wave1", run);
}

function withFixtureCopyFrom(sourceRoot, name, run) {
  const temp = mkdtempSync(join(tmpdir(), `lattice-${name}-`));
  const fixtureRoot = join(temp, name);
  try {
    cpSync(sourceRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function withTempRepo(name, run) {
  const temp = mkdtempSync(join(tmpdir(), `lattice-${name}-`));
  try {
    run(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function writeFixtureFile(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
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

function assertExcludesTriple(triples, triple) {
  assert.equal(triples.some((candidate) => candidate.join("\0") === triple.join("\0")), false, triple.join(" "));
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
