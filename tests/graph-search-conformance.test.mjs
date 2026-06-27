import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { graphProviderBuild, graphProviderSearch, graphProviderUpdate } from "../packages/graph/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");
const mixedRustTsFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/mixed-rust-ts");
const searchFixture = JSON.parse(readFileSync(resolve(repoRoot, "packages/fixtures/graph-search/search-fixtures.json"), "utf8"));

describe("GraphProvider search conformance", () => {
  it("keeps fresh and rebuilt search schemas identical and indexes GraphProvider v1 node kinds", () => {
    withFixtureCopy((fixtureRoot) => {
      const fresh = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(fresh.status.state, "available");
      const freshSchema = readSearchSchema(fresh.status.dbPath);
      const freshKinds = indexedKindCounts(fresh.status.dbPath);

      rmSync(join(fixtureRoot, ".lattice"), { recursive: true, force: true });
      const rebuilt = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(rebuilt.status.state, "available");
      assert.equal(readSearchSchema(rebuilt.status.dbPath), freshSchema);
      assert.deepEqual(indexedKindCounts(rebuilt.status.dbPath), freshKinds);
      for (const kind of searchFixture.indexedNodeKinds) assert.ok(freshKinds[kind] > 0, kind);
    });
  });

  it("full rebuild repairs stores missing the search schema", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      const db = new DatabaseSync(build.status.dbPath);
      try {
        db.exec("drop table nodes_fts");
      } finally {
        db.close();
      }

      const rebuilt = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(rebuilt.status.state, "available");
      assert.equal(readSearchSchema(rebuilt.status.dbPath).includes("nodes_fts"), true);

      const search = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "Greeting", limit: 5 });
      assert.equal(search.status.state, "available");
      assert.ok(search.results.length > 0);
    });
  });

  it("updates search rows for changed and deleted files and records incremental metadata", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      const stableBefore = readFtsRowId(build.status.dbPath, "class:src/models.ts#GreetingModel");

      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 7; }\n");
      unlinkSync(join(fixtureRoot, "src/legacy-widget.jsx"));
      const update = graphProviderUpdate({ repoRoot: fixtureRoot }, "HEAD");
      assert.equal(update.status.state, "available");
      assert.deepEqual(update.summary.changedFiles, ["src/math.js"]);
      assert.deepEqual(update.summary.deletedFiles, ["src/legacy-widget.jsx"]);

      const db = new DatabaseSync(update.status.dbPath, { readOnly: true });
      try {
        assert.equal(db.prepare("select count(*) as count from nodes_fts where path = ?").get("src/legacy-widget.jsx").count, 0);
        assert.ok(db.prepare("select count(*) as count from nodes_fts where path = ?").get("src/math.js").count > 0);
        const metadata = JSON.parse(db.prepare("select value from lattice_store where key = 'search_index_last_update_json'").get().value);
        assert.equal(metadata.strategy, "incremental");
        assert.deepEqual(metadata.changedFiles, ["src/math.js"]);
        assert.deepEqual(metadata.deletedFiles, ["src/legacy-widget.jsx"]);
        assert.ok(metadata.reindexedNodeIds.includes("function:src/math.js#add"));
        assert.ok(metadata.reindexedNodeIds.includes("function:src/components/GreetingCard.tsx#GreetingCard"));
        assert.equal(metadata.reindexedNodeIds.includes("class:src/models.ts#GreetingModel"), false);
        assert.equal(db.prepare("select rowid from nodes_fts where node_id = ?").get("class:src/models.ts#GreetingModel").rowid, stableBefore);
      } finally {
        db.close();
      }
    });
  });

  it("finds exact camel-case symbol names through normalized FTS terms", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");

      const greetingModel = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "GreetingModel", limit: 5 });
      assert.equal(greetingModel.status.state, "available");
      assert.equal(greetingModel.results[0].nodeId, "class:src/models.ts#GreetingModel");

      const friendly = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "FriendlyGreetingModel", limit: 5 });
      assert.equal(friendly.status.state, "available");
      assert.equal(friendly.results[0].nodeId, "class:src/models.ts#FriendlyGreetingModel");

      const legacy = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "legacyWidget", limit: 5 });
      assert.equal(legacy.status.state, "available");
      assert.equal(legacy.results[0].nodeId, "class:src/legacy-widget.jsx#LegacyWidget");
    });
  });

  it("returns deterministic FTS ranking with context-file boosts", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");

      const result = graphProviderSearch(
        { repoRoot: fixtureRoot },
        { query: searchFixture.queries.greeting.query, files: searchFixture.contextFiles, limit: 5 }
      );
      assert.equal(result.status.state, "available");
      assert.equal(result.searchMode.engine, "fts5");
      assert.equal(result.summary.query, "Greeting");
      assert.equal(result.summary.returned, result.results.length);
      assert.equal(result.results[0].path, "src/components/GreetingCard.tsx");
      assert.deepEqual(result.results.map((entry) => entry.nodeId).slice(0, 3), searchFixture.queries.greeting.expectedTopNodeIds);
      assert.ok(result.hints.includes("context_file_boost"));
      for (const entry of result.results) {
        assert.equal(typeof entry.signature, "string");
        assert.equal(entry.signature.includes("export function"), false);
        assert.equal(entry.signature.includes(fixtureRoot), false);
      }
    });
  });

  it("indexes and ranks Rust symbol signatures deterministically", () => {
    withRustFixture((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");

      const result = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "pub struct Widget", limit: 5 });
      assert.equal(result.status.state, "available");
      assert.equal(result.searchMode.engine, "fts5");
      assert.equal(result.results[0].nodeId, "struct:src/lib.rs#Widget");
      assert.equal(result.results[0].kind, "Struct");
      assert.match(result.results[0].signature, /\bpub struct Widget\b/);
      assert.ok(result.results[0].matches.includes("signature"));
      assert.deepEqual(
        result.results.map((entry) => entry.nodeId).slice(0, 3),
        ["struct:src/lib.rs#Widget"]
      );

      const tsResult = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "renderWidgetLabel", limit: 5 });
      assert.equal(tsResult.status.state, "available");
      assert.equal(tsResult.results[0].nodeId, "function:src/widget-view.ts#renderWidgetLabel");
    });
  });

  it("returns typed failures without search rows for missing schema and stale stores", () => {
    const missingRepo = mkdtempSync(join(tmpdir(), "lattice-search-missing-"));
    try {
      writeFileSync(join(missingRepo, "a.ts"), "export const a = 1;\n");
      const missing = graphProviderSearch({ repoRoot: missingRepo }, { query: "a", limit: 5 });
      assert.equal(missing.status.state, "stale");
      assert.equal(missing.results, undefined);
      assert.equal(missing.summary, undefined);
    } finally {
      rmSync(missingRepo, { recursive: true, force: true });
    }

    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      const db = new DatabaseSync(build.status.dbPath);
      try {
        db.exec("drop table nodes_fts");
      } finally {
        db.close();
      }
      const missingSchema = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "Greeting", limit: 5 });
      assert.equal(missingSchema.status.state, "schema_mismatch");
      assert.equal(missingSchema.results, undefined);
      assert.equal(missingSchema.summary, undefined);
    });

    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 8; }\n");
      const stale = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "Greeting", limit: 5 });
      assert.equal(stale.status.state, "stale");
      assert.equal(stale.results, undefined);
    });
  });

  it("returns warming search status without search rows during daemon warmup", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
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

      const warming = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "Greeting", limit: 5 });
      assert.equal(warming.status.state, "warming");
      assert.equal(warming.results, undefined);
      assert.equal(warming.summary, undefined);
    });
  });
});

function readSearchSchema(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("select sql from sqlite_master where name = 'nodes_fts'").get().sql;
  } finally {
    db.close();
  }
}

function indexedKindCounts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("select kind, count(*) as count from nodes_fts group by kind order by kind").all().map((row) => [row.kind, row.count]));
  } finally {
    db.close();
  }
}

function readFtsRowId(dbPath, nodeId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("select rowid from nodes_fts where node_id = ?").get(nodeId).rowid;
  } finally {
    db.close();
  }
}

function withFixtureCopy(run) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-search-"));
  const fixtureRoot = join(temp, "wave1");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function withRustFixture(run) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-search-rust-"));
  const fixtureRoot = join(temp, "mixed-rust-ts");
  try {
    cpSync(mixedRustTsFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function skipGeneratedStore(source) {
  const normalized = source.replaceAll("\\", "/");
  return !normalized.endsWith("/.lattice") && !normalized.includes("/.lattice/");
}
