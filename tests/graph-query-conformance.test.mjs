import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphProviderBuild,
  graphProviderDetectChanges,
  graphProviderImpact,
  graphProviderNamedQuery,
  graphProviderReviewContext
} from "../packages/graph/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");
const queryFixture = JSON.parse(readFileSync(resolve(repoRoot, "packages/fixtures/graph-query/query-fixtures.json"), "utf8"));

describe("GraphProvider query conformance", () => {
  it("returns impact files, symbols, tests, and traversal metadata", () => {
    withBuiltFixture((fixtureRoot) => {
      const result = graphProviderImpact(
        { repoRoot: fixtureRoot },
        { files: queryFixture.impact.changedFiles, maxDepth: 3, limit: 100 }
      );

      assert.equal(result.status.state, "available");
      assert.deepEqual(result.changedFiles, ["src/models.ts"]);
      for (const path of queryFixture.impact.impactedFilesIncludes) assert.ok(result.impactedFiles.includes(path), path);
      for (const path of queryFixture.impact.testsIncludes) assert.ok(result.tests.includes(path), path);
      assert.ok(result.impactedSymbols.includes("function:src/models.ts#formatGreeting"));
      assert.equal(result.traversal.truncated, false);
      assert.equal(result.traversal.empty, false);
    });
  });

  it("serves named queries with deterministic nodes and empty missing targets", () => {
    withBuiltFixture((fixtureRoot) => {
      const importers = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "importers_of", target: "src/models.ts", maxDepth: 2, limit: 100 }
      );
      assert.equal(importers.status.state, "available");
      assert.deepEqual(paths(importers.nodes), [
        "src/__tests__/greeting.test.ts",
        "src/barrel.ts",
        "src/components/GreetingCard.tsx",
        "src/legacy-widget.jsx",
        "src/models.ts"
      ]);

      const imports = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "imports_of", target: "src/components/GreetingCard.tsx", maxDepth: 1, limit: 100 }
      );
      assert.deepEqual(paths(imports.nodes), ["src/components/GreetingCard.tsx", "src/math.js", "src/models.ts"]);

      const tests = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "tests_for", target: "src/models.ts", maxDepth: 1, limit: 100 }
      );
      assert.ok(paths(tests.nodes).includes("src/__tests__/greeting.test.ts"));

      const children = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "children_of", target: "src/models.ts", maxDepth: 1, limit: 100 }
      );
      assert.ok(children.nodes.map((node) => node.id).includes("class:src/models.ts#GreetingModel"));

      const summary = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "file_summary", target: "src/models.ts", limit: 100 }
      );
      assert.ok(summary.edges.some((edge) => edge.kind === "CONTAINS"));

      const missing = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "callers_of", target: "src/missing.ts", maxDepth: 1, limit: 10 }
      );
      assert.equal(missing.status.state, "available");
      assert.equal(missing.traversal.empty, true);
      assert.deepEqual(missing.nodes, []);
      assert.deepEqual(missing.edges, []);
    });
  });

  it("enforces query limits without dangling traversal edges", () => {
    withBuiltFixture((fixtureRoot) => {
      const importers = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "importers_of", target: "src/models.ts", maxDepth: 2, limit: 1 }
      );
      assertLimitedGraph(importers, 1);

      const tests = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "tests_for", target: "src/models.ts", maxDepth: 1, limit: 1 }
      );
      assertLimitedGraph(tests, 1);

      const summary = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "file_summary", target: "src/models.ts", limit: 1 }
      );
      assertLimitedGraph(summary, 1);

      const impact = graphProviderImpact({ repoRoot: fixtureRoot }, { files: ["src/models.ts"], maxDepth: 3, limit: 1 });
      assertLimitedGraph(impact, 1);
      assert.deepEqual(impact.impactedFiles, ["src/models.ts"]);
      assert.deepEqual(impact.impactedSymbols, []);
      assert.deepEqual(impact.tests, []);
    });
  });

  it("returns detect-changes and review-context envelopes for explicit files", () => {
    withBuiltFixture((fixtureRoot) => {
      const changes = graphProviderDetectChanges({ repoRoot: fixtureRoot }, { files: ["src/models.ts"] });
      assert.equal(changes.status.state, "available");
      assert.deepEqual(changes.changedFiles, ["src/models.ts"]);
      assert.deepEqual(changes.deletedFiles, []);
      assert.deepEqual(changes.renamedFiles, []);

      const review = graphProviderReviewContext({ repoRoot: fixtureRoot }, { files: ["src/models.ts"], maxDepth: 3 });
      assert.equal(review.status.state, "available");
      assert.deepEqual(review.changedFiles, ["src/models.ts"]);
      assert.ok(review.impactedFiles.includes("src/components/GreetingCard.tsx"));
      assert.ok(review.tests.includes("src/__tests__/greeting.test.ts"));
    });
  });

  it("normalizes duplicate separators in query file consumers", () => {
    withBuiltFixture((fixtureRoot) => {
      const changes = graphProviderDetectChanges({ repoRoot: fixtureRoot }, { files: ["src//models.ts"] });
      assert.equal(changes.status.state, "available");
      assert.deepEqual(changes.changedFiles, ["src/models.ts"]);
      assert.deepEqual(changes.deletedFiles, []);

      const impact = graphProviderImpact({ repoRoot: fixtureRoot }, { files: ["src//models.ts"], maxDepth: 3 });
      assert.equal(impact.status.state, "available");
      assert.deepEqual(impact.changedFiles, ["src/models.ts"]);
      assert.ok(impact.impactedFiles.includes("src/components/GreetingCard.tsx"));

      const query = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "tests_for", target: "src//models.ts", maxDepth: 1, limit: 100 }
      );
      assert.equal(query.status.state, "available");
      assert.ok(paths(query.nodes).includes("src/__tests__/greeting.test.ts"));
    });
  });

  it("returns typed failures without empty graph payloads for missing, stale, warming, and schema-mismatched stores", () => {
    const missingRepo = join(tmpdir(), `lattice-query-missing-${process.pid}-${Date.now()}`);
    const missing = graphProviderNamedQuery({ repoRoot: missingRepo }, { queryKind: "tests_for", target: "src/models.ts" });
    assert.equal(missing.status.state, "required_missing");
    assert.equal(missing.nodes, undefined);

    withBuiltFixture((fixtureRoot) => {
      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 31; }\n");
      const stale = graphProviderImpact({ repoRoot: fixtureRoot }, { files: ["src/models.ts"] });
      assert.equal(stale.status.state, "stale");
      assert.equal(stale.impactedFiles, undefined);
      assert.equal(stale.tests, undefined);
    });

    withBuiltFixture((fixtureRoot) => {
      writeWarmingLifecycle(fixtureRoot);
      const warming = graphProviderNamedQuery({ repoRoot: fixtureRoot }, { queryKind: "tests_for", target: "src/models.ts" });
      assert.equal(warming.status.state, "warming");
      assert.equal(warming.nodes, undefined);
    });

    withBuiltFixture((fixtureRoot) => {
      corruptSnapshotSchema(fixtureRoot);
      const mismatch = graphProviderReviewContext({ repoRoot: fixtureRoot }, { files: ["src/models.ts"] });
      assert.equal(mismatch.status.state, "schema_mismatch");
      assert.equal(mismatch.impactedFiles, undefined);
      assert.equal(mismatch.tests, undefined);
    });
  });
});

function withBuiltFixture(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-query-conformance-"));
  const fixtureRoot = join(temp, "wave1");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    const build = graphProviderBuild({ repoRoot: fixtureRoot });
    assert.equal(build.status.state, "available");
    runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function skipGeneratedStore(source) {
  const normalized = source.replaceAll("\\", "/");
  return !normalized.endsWith("/.lattice") && !normalized.includes("/.lattice/");
}

function paths(nodes) {
  return [...new Set(nodes.map((node) => node.path).filter(Boolean))].sort();
}

function assertLimitedGraph(result, limit) {
  assert.equal(result.status.state, "available");
  assert.ok(result.nodes.length <= limit, `nodes ${result.nodes.length} exceeds limit ${limit}`);
  assert.ok(result.traversal.truncated);
  const nodeIds = new Set(result.nodes.map((node) => node.id));
  for (const edge of result.edges) {
    assert.ok(nodeIds.has(edge.from), `dangling edge from ${edge.from}`);
    assert.ok(nodeIds.has(edge.to), `dangling edge to ${edge.to}`);
  }
}

function writeWarmingLifecycle(fixtureRoot) {
  const daemonDir = join(fixtureRoot, ".lattice/graph/daemon");
  const pidPath = join(daemonDir, "pid");
  const statePath = join(daemonDir, "state.json");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(pidPath, `${process.pid}\n`);
  writeFileSync(
    statePath,
    `${JSON.stringify({
      state: "warming",
      pid: process.pid,
      startedAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
      pidPath,
      statePath,
      logPath: join(daemonDir, "daemon.log"),
      pollIntervalMs: 50,
      idleTimeoutMs: 1800000,
      watchPaths: [],
      message: "graph watch daemon warming"
    })}\n`
  );
}

function corruptSnapshotSchema(fixtureRoot) {
  const db = new DatabaseSync(join(fixtureRoot, ".lattice/graph/graph.db"));
  try {
    const metadata = JSON.parse(db.prepare("select value from metadata where key = 'lattice_snapshot_metadata'").get().value);
    metadata.schemaVersion = 2;
    const value = JSON.stringify(metadata);
    db.prepare("update metadata set value = ? where key = 'lattice_snapshot_metadata'").run(value);
    db.prepare("update lattice_store set value = ? where key = 'metadata_json'").run(value);
  } finally {
    db.close();
  }
}
