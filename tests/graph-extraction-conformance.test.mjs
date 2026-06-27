import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { graphProviderBuild, graphProviderQuery } from "../packages/graph/dist/index.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "../packages/fixtures/source-extraction/wave1");
const expected = JSON.parse(readFileSync(resolve(sourceFixtureRoot, "wave1.expected.json"), "utf8"));
const pythonFixtureRoot = resolve(repoRoot, "../packages/fixtures/source-extraction/python");
const pythonExpected = JSON.parse(readFileSync(resolve(pythonFixtureRoot, "python.expected.json"), "utf8"));

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

  it("extracts Rust facts through the GraphProvider wrapper", () => {
    withTempRepo("rust-extraction", (fixtureRoot) => {
      writeRustFixture(fixtureRoot);

      assert.equal(graphProviderBuild({ repoRoot: fixtureRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      const nodes = nodeMap(result.nodes);
      const triples = edgeTriples(result.edges);

      assert.equal(result.status.state, "available");
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
    withTempRepo("rust-module-import", (fixtureRoot) => {
      writeFixtureFile(fixtureRoot, "tsconfig.json", "{}\n");
      writeFixtureFile(fixtureRoot, "src/lib.rs", "pub mod helpers;\npub mod user;\n");
      writeFixtureFile(fixtureRoot, "src/helpers.rs", "pub fn assist() -> usize { 1 }\n");
      writeFixtureFile(fixtureRoot, "src/user.rs", "use crate::helpers;\npub fn run() { helpers::assist(); }\n");

      assert.equal(graphProviderBuild({ repoRoot: fixtureRoot }).status.state, "available");
      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      const triples = edgeTriples(result.edges);

      assert.equal(result.status.state, "available");
      assert.deepEqual(result.diagnostics ?? [], []);
      assertIncludesTriple(triples, ["IMPORTS_FROM", "file:src/user.rs", "file:src/helpers.rs"]);
      assertIncludesTriple(triples, ["DEPENDS_ON", "file:src/user.rs", "file:src/helpers.rs"]);
      assertExcludesTriple(triples, ["IMPORTS_FROM", "file:src/user.rs", "file:src/lib.rs"]);
      assertExcludesTriple(triples, ["DEPENDS_ON", "file:src/user.rs", "file:src/lib.rs"]);
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

function withTempRepo(name, run) {
  const temp = mkdtempSync(join(tmpdir(), `lattice-${name}-`));
  try {
    run(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function writeRustFixture(root) {
  writeFixtureFile(root, "tsconfig.json", "{}\n");
  writeFixtureFile(
    root,
    "src/lib.rs",
    `
pub mod helpers;
mod user;

pub trait Service {
    fn handle(&self);
}

pub struct Widget;

pub enum Mode {
    Fast,
}

impl Service for Widget {
    fn handle(&self) {
        helpers::assist();
    }
}

pub type Alias = Widget;
pub const LIMIT: usize = 1;
pub static NAME: &str = "widget";

macro_rules! trace {
    () => {};
}
`
  );
  writeFixtureFile(root, "src/helpers.rs", "pub fn assist() -> usize { 1 }\n");
  writeFixtureFile(
    root,
    "src/user.rs",
    `
use crate::helpers;
use crate::{Service, Widget};

pub fn run() {
    helpers::assist();
    let widget = Widget;
    widget.handle();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run() {
        run();
    }
}
`
  );
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
