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
});

function withFixtureCopy(run) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-wave1-"));
  const fixtureRoot = join(temp, "wave1");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
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
