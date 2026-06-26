import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const latticeBin = join(repoRoot, "packages/cli/dist/index.js");
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");

describe("graph query CLI routes", () => {
  it("returns canonical impact JSON", () => {
    withBuiltFixture((fixtureRoot) => {
      const canonical = run(latticeBin, [
        "graph",
        "impact",
        "--repo",
        fixtureRoot,
        "--files",
        "src/models.ts",
        "--max-depth",
        "3",
        "--json"
      ]);

      assert.equal(canonical.status, "ok");
      assert.deepEqual(canonical.graphImpact.changedFiles, ["src/models.ts"]);
      assert.ok(canonical.graphImpact.impactedFiles.includes("src/components/GreetingCard.tsx"));
      assert.ok(canonical.graphImpact.tests.includes("src/__tests__/greeting.test.ts"));
      assert.equal(canonical.graphImpact.traversal.truncated, false);
    });
  });

  it("routes named queries, review-context, and detect-changes through canonical lattice commands", () => {
    withBuiltFixture((fixtureRoot) => {
      const query = run(latticeBin, ["graph", "query", "tests_for", "src/models.ts", "--repo", fixtureRoot, "--json"]);
      assert.equal(query.graphQuery.queryKind, "tests_for");
      assert.ok(query.graphQuery.nodes.some((node) => node.path === "src/__tests__/greeting.test.ts"));

      const review = run(latticeBin, ["graph", "review-context", "--repo", fixtureRoot, "--files", "src/models.ts", "--json"]);
      assert.deepEqual(review.graphReviewContext.changedFiles, ["src/models.ts"]);
      assert.ok(review.graphReviewContext.impactedFiles.includes("src/components/GreetingCard.tsx"));

      const changes = run(latticeBin, ["graph", "detect-changes", "--repo", fixtureRoot, "--files", "src/models.ts", "--json"]);
      assert.deepEqual(changes.graphChanges.changedFiles, ["src/models.ts"]);
      assert.deepEqual(changes.graphChanges.renamedFiles, []);
    });
  });

  it("routes search through canonical lattice commands", () => {
    withBuiltFixture((fixtureRoot) => {
      const search = run(latticeBin, ["graph", "search", "Greeting", "--repo", fixtureRoot, "--files", "src/components/GreetingCard.tsx", "--limit", "5", "--json"]);
      assert.equal(search.status, "ok");
      assert.equal(search.graphSearch.searchMode.engine, "fts5");
      assert.equal(search.graphSearch.results[0].path, "src/components/GreetingCard.tsx");
    });
  });
});

describe("graph query CLI freshness failures", () => {
  it("returns stale failures for dirty renamed files instead of change payloads", () => {
    withBuiltFixture((fixtureRoot) => {
      renameSync(join(fixtureRoot, "src/math.js"), join(fixtureRoot, "src/math-renamed.js"));

      const changes = run(latticeBin, ["graph", "detect-changes", "--repo", fixtureRoot, "--json"], 1);
      assert.equal(changes.providerStatus.state, "stale");
      assert.equal(changes.providerStatus.failure.category, "stale_snapshot");
      assert.equal(changes.graphChanges.status.state, "stale");
      assert.equal(changes.graphChanges.changedFiles, undefined);
      assert.equal(changes.graphChanges.deletedFiles, undefined);
      assert.equal(changes.graphChanges.renamedFiles, undefined);

      const review = run(latticeBin, ["graph", "review-context", "--repo", fixtureRoot, "--max-depth", "3", "--json"], 1);
      assert.equal(review.providerStatus.state, "stale");
      assert.equal(review.providerStatus.failure.category, "stale_snapshot");
      assert.equal(review.graphReviewContext.status.state, "stale");
      assert.equal(review.graphReviewContext.changedFiles, undefined);
      assert.equal(review.graphReviewContext.deletedFiles, undefined);
      assert.equal(review.graphReviewContext.renamedFiles, undefined);
      assert.equal(review.graphReviewContext.impactedFiles, undefined);
      assert.equal(review.graphReviewContext.tests, undefined);
    });
  });
});

describe("graph query CLI limits", () => {
  it("applies graph query limits without dangling CLI edges", () => {
    withBuiltFixture((fixtureRoot) => {
      const importers = run(latticeBin, [
        "graph",
        "query",
        "importers_of",
        "src/models.ts",
        "--repo",
        fixtureRoot,
        "--limit",
        "1",
        "--json"
      ]);
      assertLimitedGraph(importers.graphQuery, 1);

      const tests = run(latticeBin, [
        "graph",
        "query",
        "tests_for",
        "src/models.ts",
        "--repo",
        fixtureRoot,
        "--limit",
        "1",
        "--json"
      ]);
      assertLimitedGraph(tests.graphQuery, 1);

      const impact = run(latticeBin, [
        "graph",
        "impact",
        "--repo",
        fixtureRoot,
        "--files",
        "src/models.ts",
        "--limit",
        "1",
        "--json"
      ]);
      assertLimitedGraph(impact.graphImpact, 1);
      assert.deepEqual(impact.graphImpact.impactedFiles, ["src/models.ts"]);
      assert.deepEqual(impact.graphImpact.impactedSymbols, []);
      assert.deepEqual(impact.graphImpact.tests, []);
    });
  });
});

describe("graph query CLI typed failures", () => {
  it("returns typed failures without graph data for unavailable, stale, daemon, and unsupported states", () => {
    const missingRepo = join(tmpdir(), `lattice-missing-impact-${process.pid}-${Date.now()}`);
    const missing = run(latticeBin, ["graph", "impact", "--repo", missingRepo, "--files", "src/models.ts", "--json"], 1);
    assert.equal(missing.providerStatus.state, "required_missing");
    assert.equal(missing.graphImpact.status.state, "required_missing");
    assert.equal(missing.graphImpact.impactedFiles, undefined);

    withBuiltFixture((fixtureRoot) => {
      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 9; }\n");
      const stale = run(latticeBin, ["graph", "impact", "--repo", fixtureRoot, "--files", "src/models.ts", "--json"], 1);
      assert.equal(stale.providerStatus.state, "stale");
      assert.equal(stale.graphImpact.status.state, "stale");
      assert.equal(stale.graphImpact.impactedFiles, undefined);
    });

    withBuiltFixture((fixtureRoot) => {
      const daemonDir = join(fixtureRoot, ".lattice/graph/daemon");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(join(daemonDir, "pid"), "999999\n");
      writeFileSync(
        join(daemonDir, "state.json"),
        `${JSON.stringify({
          state: "available",
          pid: 999999,
          startedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
          pidPath: join(daemonDir, "pid"),
          statePath: join(daemonDir, "state.json"),
          logPath: join(daemonDir, "daemon.log"),
          pollIntervalMs: 50,
          idleTimeoutMs: 1800000,
          watchPaths: []
        })}\n`
      );
      const daemon = run(latticeBin, ["graph", "detect-changes", "--repo", fixtureRoot, "--files", "src/models.ts", "--json"], 1);
      assert.equal(daemon.providerStatus.state, "daemon_unavailable");
      assert.equal(daemon.graphChanges.status.state, "daemon_unavailable");
      assert.equal(daemon.graphChanges.changedFiles, undefined);
    });

    withBuiltFixture((fixtureRoot) => {
      const unsupported = run(latticeBin, ["graph", "query", "unknown_query", "src/models.ts", "--repo", fixtureRoot, "--json"], 1);
      assert.equal(unsupported.providerStatus.state, "error");
      assert.match(unsupported.message, /unsupported graph named query/);
      assert.equal(unsupported.graphQuery, undefined);
    });
  });
});

function withBuiltFixture(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-query-cli-"));
  const fixtureRoot = join(temp, "wave1");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(latticeBin, ["graph", "build", "--repo", fixtureRoot, "--json"]);
    runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function run(script, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, parsed.exitCode);
  assert.equal(result.status, expectedStatus);
  return parsed;
}

function skipGeneratedStore(source) {
  const normalized = source.replaceAll("\\", "/");
  return !normalized.endsWith("/.lattice") && !normalized.includes("/.lattice/");
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
