import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphProviderBuild,
  graphProviderDetectChanges,
  graphProviderImpact,
  graphProviderNamedQuery,
  graphProviderQuery,
  graphProviderReviewContext,
  graphProviderSearch,
  graphProviderStatus,
  graphProviderUpdate,
  graphProviderWatch,
  invokeGraphCoreSidecar
} from "../packages/graph/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");
const pythonFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/python");
const robustnessFixtureRoot = resolve(repoRoot, "packages/fixtures/graph-robustness/watch-roots");
const expected = JSON.parse(readFileSync(resolve(sourceFixtureRoot, "wave1.expected.json"), "utf8"));
const pythonExpected = JSON.parse(readFileSync(resolve(pythonFixtureRoot, "python.expected.json"), "utf8"));

describe("GraphProvider SQLite store conformance", () => {
  it("refreshes Wave 1 facts into SQLite and serves #19 direct-reader queries", () => {
    withFixtureCopy((fixtureRoot) => {
      const canonicalFixtureRoot = realpathSync(fixtureRoot);
      const refresh = graphProviderBuild({ repoRoot: fixtureRoot }).status;
      assert.equal(refresh.state, "available");
      assert.ok(refresh.dbPath);
      assert.equal(refresh.dbPath, join(canonicalFixtureRoot, ".lattice/graph/graph.db"));
      assert.ok(existsSync(refresh.dbPath));

      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      assert.equal(result.status.state, "available");
      assert.equal(result.status.dbPath, refresh.dbPath);
      assert.deepEqual(result.nodes.map((node) => node.id).sort(), expected.nodeIds);
      assert.deepEqual(edgeTriples(result.edges), expected.edgeTriples.sort(compareTuple));

      const db = new DatabaseSync(refresh.dbPath, { readOnly: true });
      try {
        assert.equal(db.prepare("pragma user_version").get().user_version, 1);
        assertRequiredTablesAndIndexes(db);
        assertNoOutOfScopeLegacyTables(db);
        assert.deepEqual(
          plainRows(db.prepare("select kind, count(*) as count from nodes group by kind order by kind").all()),
          [
            { kind: "Class", count: 5 },
            { kind: "File", count: 9 },
            { kind: "Function", count: 9 },
            { kind: "Test", count: 1 },
            { kind: "Type", count: 2 },
            { kind: "Variable", count: 5 }
          ]
        );
        assert.deepEqual(
          plainRows(db.prepare("select kind, count(*) as count from edges group by kind order by kind").all()),
          [
            { kind: "CALLS", count: 13 },
            { kind: "CONTAINS", count: 22 },
            { kind: "DEPENDS_ON", count: 11 },
            { kind: "IMPLEMENTS", count: 2 },
            { kind: "IMPORTS_FROM", count: 11 },
            { kind: "INHERITS", count: 2 },
            { kind: "TESTED_BY", count: 4 }
          ]
        );
        assert.ok(
          db
            .prepare("select kind, source_qualified, target_qualified from edges where file_path = ?")
            .all(join(canonicalFixtureRoot, "src/models.ts")).length > 0
        );
        assert.deepEqual(
          db
            .prepare(
              "select qualified_name, kind, file_path, line_start, line_end from nodes where name like ? order by kind, qualified_name limit ?"
            )
            .all("%Greeting%", 2)
            .map(({ qualified_name, kind }) => ({ qualified_name, kind })),
          [
            { qualified_name: "class:src/default-model.ts#DefaultGreetingModel", kind: "Class" },
            { qualified_name: "class:src/models.ts#FriendlyGreetingModel", kind: "Class" }
          ]
        );
        assert.deepEqual(
          plainRows(
            db
              .prepare(
                "select key, value from metadata where key in ('schema_version', 'last_updated', 'last_build_type') order by key"
              )
              .all()
          ),
          [
            { key: "last_build_type", value: "build" },
            { key: "last_updated", value: "2026-06-04T00:00:00.000Z" },
            { key: "schema_version", value: "6" }
          ]
        );
      } finally {
        db.close();
      }
    });
  });

  it("persists Python facts into SQLite and serves store-backed query/search", () => {
    withPythonFixtureCopy((fixtureRoot) => {
      const canonicalFixtureRoot = realpathSync(fixtureRoot);
      const refresh = graphProviderBuild({ repoRoot: fixtureRoot }).status;
      assert.equal(refresh.state, "available");
      assert.ok(refresh.dbPath);
      assert.equal(refresh.dbPath, join(canonicalFixtureRoot, ".lattice/graph/graph.db"));
      assert.ok(existsSync(refresh.dbPath));

      const status = graphProviderStatus({ repoRoot: fixtureRoot });
      assert.equal(status.state, "available");
      assert.equal(status.dbPath, refresh.dbPath);
      assert.deepEqual(status.nodes_by_kind, {
        Class: 3,
        File: 7,
        Function: 9,
        Module: 7,
        Variable: 2
      });
      assert.deepEqual(status.edges_by_kind, {
        CALLS: 9,
        CONTAINS: 21,
        DEPENDS_ON: 6,
        IMPORTS_FROM: 6,
        INHERITS: 1,
        TESTED_BY: 3
      });
      const rawStatus = rawGraphStatus(fixtureRoot);
      assert.equal(rawStatus.state, "available");
      assert.deepEqual(rawStatus.nodes_by_kind, status.nodes_by_kind);
      assert.deepEqual(rawStatus.edges_by_kind, status.edges_by_kind);

      const result = graphProviderQuery({ repoRoot: fixtureRoot });
      assert.equal(result.status.state, "available");
      assert.equal(result.status.dbPath, refresh.dbPath);
      assert.deepEqual(result.nodes.map((node) => node.id).sort(), pythonExpected.nodeIds);
      assert.deepEqual(edgeTriples(result.edges), pythonExpected.edgeTriples.sort(compareTuple));

      const db = new DatabaseSync(refresh.dbPath, { readOnly: true });
      try {
        assert.equal(db.prepare("pragma user_version").get().user_version, 1);
        assert.deepEqual(
          plainRows(db.prepare("select kind, count(*) as count from nodes group by kind order by kind").all()),
          [
            { kind: "Class", count: 3 },
            { kind: "File", count: 7 },
            { kind: "Function", count: 9 },
            { kind: "Module", count: 7 },
            { kind: "Variable", count: 2 }
          ]
        );
        assert.deepEqual(
          plainRows(db.prepare("select kind, count(*) as count from edges group by kind order by kind").all()),
          [
            { kind: "CALLS", count: 9 },
            { kind: "CONTAINS", count: 21 },
            { kind: "DEPENDS_ON", count: 6 },
            { kind: "IMPORTS_FROM", count: 6 },
            { kind: "INHERITS", count: 1 },
            { kind: "TESTED_BY", count: 3 }
          ]
        );
        assert.deepEqual(
          plainRows(db.prepare("select language, count(*) as count from file_hashes group by language").all()),
          [{ language: "python", count: 7 }]
        );
        assert.deepEqual(
          Object.fromEntries(
            db
              .prepare(
                "select name, is_exported from nodes where name in ('PublicModel', 'make_model', 'build_name', '_hidden') order by name"
              )
              .all()
              .map((row) => [row.name, row.is_exported])
          ),
          { PublicModel: 1, _hidden: 0, build_name: 1, make_model: 1 }
        );
        assert.equal(
          db.prepare("select is_test from nodes where id = ?").get("function:tests/test_models.py#test_make_model").is_test,
          1
        );
        for (const nodeId of [
          "class:src/pkg/models.py#PublicModel",
          "function:src/pkg/helpers.py#build_name",
          "function:src/pkg/stubs.pyi#stubbed"
        ]) {
          assert.equal(db.prepare("select count(*) as count from nodes_fts where node_id = ?").get(nodeId).count, 1, nodeId);
        }
        assert.ok(db.prepare("select count(*) as count from nodes_fts where path = ?").get("src/pkg/stubs.pyi").count > 0);
      } finally {
        db.close();
      }

      const symbols = graphProviderQuery(
        { repoRoot: fixtureRoot },
        { kind: "symbols", text: "PublicModel", limit: 100 }
      );
      assert.equal(symbols.status.state, "available");
      assert.ok(symbols.nodes.map((node) => node.id).includes("class:src/pkg/models.py#PublicModel"));

      const imports = graphProviderQuery(
        { repoRoot: fixtureRoot },
        { kind: "edges", edgeKinds: ["IMPORTS_FROM"], ids: ["file:tests/test_models.py"], limit: 100 }
      );
      assert.equal(imports.status.state, "available");
      assert.deepEqual(
        imports.edges.map((edge) => edge.to).sort(),
        ["file:src/pkg/__init__.py", "file:src/pkg/models.py"]
      );

      const testedBy = graphProviderQuery(
        { repoRoot: fixtureRoot },
        { kind: "neighbors", edgeKinds: ["TESTED_BY"], ids: ["class:src/pkg/models.py#PublicModel"], limit: 100 }
      );
      assert.equal(testedBy.status.state, "available");
      assert.ok(paths(testedBy.nodes).includes("tests/test_models.py"));

      const search = graphProviderSearch({ repoRoot: fixtureRoot }, { query: "PublicModel", limit: 5 });
      assert.equal(search.status.state, "available");
      assert.equal(search.results[0].rank, 1);
      assert.equal(search.results[0].nodeId, "class:src/pkg/models.py#PublicModel");

      const importers = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "importers_of", target: "src/pkg/models.py", maxDepth: 2, limit: 100 }
      );
      assert.equal(importers.status.state, "available");
      assert.deepEqual(paths(importers.nodes), ["src/pkg/__init__.py", "src/pkg/models.py", "tests/test_models.py"]);

      const tests = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "tests_for", target: "src/pkg/models.py", maxDepth: 1, limit: 100 }
      );
      assert.equal(tests.status.state, "available");
      assert.ok(paths(tests.nodes).includes("tests/test_models.py"));
      const rawTests = rawNamedQuery(fixtureRoot, {
        queryKind: "tests_for",
        target: "src/pkg/models.py",
        maxDepth: 1,
        limit: 100
      });
      assert.equal(rawTests.status.state, "available");
      assert.deepEqual(paths(rawTests.nodes), paths(tests.nodes));

      const children = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "children_of", target: "src/pkg/models.py", maxDepth: 2, limit: 100 }
      );
      assert.equal(children.status.state, "available");
      assert.ok(children.nodes.map((node) => node.id).includes("class:src/pkg/models.py#PublicModel"));
      assert.ok(children.nodes.map((node) => node.id).includes("function:src/pkg/models.py#make_model"));

      const summary = graphProviderNamedQuery(
        { repoRoot: fixtureRoot },
        { queryKind: "file_summary", target: "src/pkg/models.py", limit: 100 }
      );
      assert.equal(summary.status.state, "available");
      assert.ok(summary.edges.some((edge) => edge.kind === "CONTAINS" && edge.to === "class:src/pkg/models.py#PublicModel"));
      const rawSummary = rawNamedQuery(fixtureRoot, { queryKind: "file_summary", target: "src/pkg/models.py", limit: 100 });
      assert.equal(rawSummary.status.state, "available");
      assert.ok(rawSummary.edges.some((edge) => edge.kind === "CONTAINS" && edge.to === "class:src/pkg/models.py#PublicModel"));

      const impact = graphProviderImpact({ repoRoot: fixtureRoot }, { files: ["src/pkg/models.py"], maxDepth: 3, limit: 100 });
      assert.equal(impact.status.state, "available");
      assert.deepEqual(impact.changedFiles, ["src/pkg/models.py"]);
      assert.ok(impact.impactedFiles.includes("tests/test_models.py"));
      assert.ok(impact.tests.includes("tests/test_models.py"));
      const rawImpact = rawGraphImpact(fixtureRoot, { files: ["src/pkg/models.py"], maxDepth: 3, limit: 100 });
      assert.equal(rawImpact.status.state, "available");
      assert.ok(rawImpact.impactedFiles.includes("tests/test_models.py"));
      assert.ok(rawImpact.tests.includes("tests/test_models.py"));

      const changes = graphProviderDetectChanges({ repoRoot: fixtureRoot }, { files: ["src/pkg/models.py"] });
      assert.equal(changes.status.state, "available");
      assert.deepEqual(changes.changedFiles, ["src/pkg/models.py"]);

      const review = graphProviderReviewContext({ repoRoot: fixtureRoot }, { files: ["src/pkg/models.py"], maxDepth: 3 });
      assert.equal(review.status.state, "available");
      assert.deepEqual(review.changedFiles, ["src/pkg/models.py"]);
      assert.ok(review.impactedFiles.includes("tests/test_models.py"));
      assert.ok(review.tests.includes("tests/test_models.py"));
      const rawReview = rawGraphReviewContext(fixtureRoot, { files: ["src/pkg/models.py"], maxDepth: 3 });
      assert.equal(rawReview.status.state, "available");
      assert.ok(rawReview.impactedFiles.includes("tests/test_models.py"));
      assert.ok(rawReview.tests.includes("tests/test_models.py"));
    });
  });

  it("updates Python changed and deleted files incrementally", () => {
    withPythonFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");

      writeFileSync(
        join(fixtureRoot, "src/pkg/helpers.py"),
        `${readFileSync(join(fixtureRoot, "src/pkg/helpers.py"), "utf8")}\n\ndef helper_added():\n    return build_name()\n`
      );
      unlinkSync(join(fixtureRoot, "src/pkg/stubs.pyi"));

      const stale = graphProviderStatus({ repoRoot: fixtureRoot });
      assert.equal(stale.state, "stale");
      assert.match(stale.freshness.reason, /hash changed|removed/);

      const update = graphProviderUpdate({ repoRoot: fixtureRoot }, "HEAD");
      assert.equal(update.status.state, "available");
      assert.deepEqual(update.summary.changedFiles, ["src/pkg/helpers.py"]);
      assert.deepEqual(update.summary.deletedFiles, ["src/pkg/stubs.pyi"]);
      assert.equal(update.summary.fullRebuildRequired, false);
      assert.equal(update.summary.parsedFiles, 1);

      assertStoreMissingPath(update.status.dbPath, "src/pkg/stubs.pyi");
      const db = new DatabaseSync(update.status.dbPath, { readOnly: true });
      try {
        assert.equal(
          db.prepare("select count(*) as count from nodes_fts where node_id = ?").get("function:src/pkg/helpers.py#helper_added")
            .count,
          1
        );
        const cached = JSON.parse(db.prepare("select value from lattice_store where key = 'file_facts_json'").get().value);
        assert.equal(cached.some((facts) => facts.path === "src/pkg/stubs.pyi"), false);
        const metadata = JSON.parse(db.prepare("select value from lattice_store where key = 'search_index_last_update_json'").get().value);
        assert.equal(metadata.strategy, "incremental");
        assert.deepEqual(metadata.changedFiles, ["src/pkg/helpers.py"]);
        assert.deepEqual(metadata.deletedFiles, ["src/pkg/stubs.pyi"]);
        assert.ok(metadata.reindexedNodeIds.includes("function:src/pkg/helpers.py#helper_added"));
      } finally {
        db.close();
      }
    });
  });

  it("stores absolute SQLite file paths when repoRoot is relative", () => {
    withFixtureCopy((fixtureRoot, tempRoot) => {
      const cwd = process.cwd();
      process.chdir(tempRoot);
      try {
        const refresh = graphProviderBuild({ repoRoot: "wave1" }).status;
        assert.equal(refresh.state, "available");
        assert.equal(refresh.dbPath, join(realpathSync(fixtureRoot), ".lattice/graph/graph.db"));

        const db = new DatabaseSync(refresh.dbPath, { readOnly: true });
        try {
          const relativePaths = db
            .prepare("select file_path from nodes where file_path is not null")
            .all()
            .filter((row) => !isAbsolute(row.file_path));
          assert.deepEqual(relativePaths, []);
        } finally {
          db.close();
        }
      } finally {
        process.chdir(cwd);
      }
    });
  });

  it("updates changed and deleted files while retaining cached facts", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 1; }\n");
      unlinkSync(join(fixtureRoot, "src/legacy-widget.jsx"));

      const update = graphProviderUpdate({ repoRoot: fixtureRoot }, "HEAD");
      assert.equal(update.status.state, "available");
      assert.deepEqual(update.summary.changedFiles, ["src/math.js"]);
      assert.deepEqual(update.summary.deletedFiles, ["src/legacy-widget.jsx"]);
      assert.equal(update.summary.fullRebuildRequired, false);
      assert.equal(update.summary.parsedFiles, 1);
      assert.ok(update.summary.phaseTimings.map((timing) => timing.phase).includes("store"));

      const db = new DatabaseSync(update.status.dbPath, { readOnly: true });
      try {
        assert.equal(db.prepare("select count(*) as count from nodes where path = ?").get("src/legacy-widget.jsx").count, 0);
        const cached = JSON.parse(db.prepare("select value from lattice_store where key = 'file_facts_json'").get().value);
        assert.equal(cached.some((facts) => facts.path === "src/components/GreetingCard.tsx"), true);
        assert.equal(cached.some((facts) => facts.path === "src/legacy-widget.jsx"), false);
      } finally {
        db.close();
      }
    });
  });

  it("reports dirty files as stale and ignores configured files", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 2; }\n");
      const stale = graphProviderStatus({ repoRoot: fixtureRoot });
      assert.equal(stale.state, "stale");
      assert.match(stale.freshness.reason, /hash changed/);
    });

    withFixtureCopy((fixtureRoot) => {
      mkdirSync(join(fixtureRoot, "ignored"), { recursive: true });
      writeFileSync(join(fixtureRoot, ".code-review-graphignore"), "ignored/\n");
      writeFileSync(join(fixtureRoot, "ignored/generated.ts"), "export const ignored = true;\n");
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      const db = new DatabaseSync(build.status.dbPath, { readOnly: true });
      try {
        assert.equal(db.prepare("select count(*) as count from nodes where path = ?").get("ignored/generated.ts").count, 0);
      } finally {
        db.close();
      }
    });
  });

  it("keeps query paths read-only for missing and stale stores", () => {
    withFixtureCopy((fixtureRoot) => {
      const missing = graphProviderQuery({ repoRoot: fixtureRoot });
      assert.equal(missing.status.state, "stale");
      assert.equal(missing.nodes, undefined);
      assert.equal(existsSync(join(fixtureRoot, ".lattice/graph/graph.db")), false);

      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 4; }\n");
      const stale = graphProviderQuery({ repoRoot: fixtureRoot });
      assert.equal(stale.status.state, "stale");
      assert.equal(stale.nodes, undefined);
    });
  });

  it("applies ordered .gitignore negations during build discovery", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-ignore-negation-"));
    try {
      writeFileSync(join(temp, ".gitignore"), "*.ts\n!keep.ts\n");
      writeFileSync(join(temp, "keep.ts"), "export const keep = 1;\n");
      writeFileSync(join(temp, "drop.ts"), "export const drop = 1;\n");

      const build = graphProviderBuild({ repoRoot: temp });
      assert.equal(build.status.state, "available");
      assert.equal(build.summary.discoveredFiles, 1);

      const db = new DatabaseSync(build.status.dbPath, { readOnly: true });
      try {
        assert.equal(db.prepare("select count(*) as count from nodes where path = ?").get("keep.ts").count > 0, true);
        assert.equal(db.prepare("select count(*) as count from nodes where path = ?").get("drop.ts").count, 0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("records phase timings and checkpoints WAL when budget is exceeded", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.deepEqual(build.summary.phaseTimings.map((timing) => timing.phase), ["discovery", "extraction", "store"]);
      const update = graphProviderUpdate({ repoRoot: fixtureRoot }, undefined, { maxWalBytes: 1 });
      assert.equal(update.summary.walCheckpoint.budgetBytes, 1);
      assert.equal(update.summary.walCheckpoint.checkpointed, true);
      assert.ok(update.summary.walCheckpoint.bytesBefore > update.summary.walCheckpoint.budgetBytes);
      const status = graphProviderStatus({ repoRoot: fixtureRoot });
      assert.equal(status.state, "available");
      assert.deepEqual(status.walCheckpoint, update.summary.walCheckpoint);
    });
  });

  it("reconciles dirty startup, polling, deletes, renames, and ignored-after-indexed cleanup", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");

      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 11; }\n");
      const watch = graphProviderWatch({ repoRoot: fixtureRoot }, { once: true, pollIntervalMs: 25 });
      assert.equal(watch.status.state, "available");
      assert.deepEqual(watch.summary.changedFiles, ["src/math.js"]);

      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 12; }\n");
      const polled = graphProviderWatch({ repoRoot: fixtureRoot }, { once: true, pollIntervalMs: 25 });
      assert.deepEqual(polled.summary.changedFiles, ["src/math.js"]);

      rmSync(join(fixtureRoot, "src/legacy-widget.jsx"), { force: true });
      const deleted = graphProviderUpdate({ repoRoot: fixtureRoot });
      assert.deepEqual(deleted.summary.deletedFiles, ["src/legacy-widget.jsx"]);
      assertStoreMissingPath(deleted.status.dbPath, "src/legacy-widget.jsx");

      rmSync(join(fixtureRoot, "src/math.js"), { force: true });
      writeFileSync(join(fixtureRoot, "src/math-renamed.js"), "export function add(left, right) { return left + right + 13; }\n");
      const renamed = graphProviderUpdate({ repoRoot: fixtureRoot });
      assert.deepEqual(renamed.summary.changedFiles, ["src/math-renamed.js"]);
      assert.deepEqual(renamed.summary.deletedFiles, ["src/math.js"]);
      assertStoreMissingPath(renamed.status.dbPath, "src/math.js");
    });

    withFixtureCopy((fixtureRoot) => {
      writeFileSync(join(fixtureRoot, "src/generated.ts"), "export const generated = true;\n");
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      assertStoreHasPath(build.status.dbPath, "src/generated.ts");

      writeFileSync(join(fixtureRoot, ".code-review-graphignore"), "src/generated.ts\n");
      const update = graphProviderUpdate({ repoRoot: fixtureRoot });
      assert.deepEqual(update.summary.deletedFiles, ["src/generated.ts"]);
      assertStoreMissingPath(update.status.dbPath, "src/generated.ts");
    });
  });

  it("excludes generated, private, dependency, gitignore, and code-review-graphignore paths", () => {
    withRobustnessFixtureCopy((fixtureRoot) => {
      createRuntimeIgnoredFiles(fixtureRoot);
      const build = graphProviderBuild({ repoRoot: fixtureRoot });
      assert.equal(build.status.state, "available");
      assert.deepEqual(build.summary.changedFiles, ["ignored/keep.ts", "shared/util.ts", "src/app.ts"]);
      for (const excluded of [
        "ignored/drop.ts",
        "crg-ignored/drop.ts",
        "node_modules/pkg/index.ts",
        ".pnpm/pkg/index.ts",
        "vendor/pkg/generated.ts",
        ".ace/runtime/generated.ts",
        ".lattice/graph/generated.ts",
        ".rox-cache/generated.ts",
        ".robustness-engine-cache/generated.ts",
        "dist/generated.ts"
      ]) {
        assertStoreMissingPath(build.status.dbPath, excluded);
      }
    });
  });
});

function assertRequiredTablesAndIndexes(db) {
  const tables = new Set(
    db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name)
  );
  for (const table of ["lattice_store", "lattice_migrations", "metadata", "file_hashes", "nodes", "edges"]) {
    assert.equal(tables.has(table), true, table);
  }
  const indexes = new Set(
    db.prepare("select name from sqlite_master where type = 'index'").all().map((row) => row.name)
  );
  for (const index of [
    "idx_nodes_file",
    "idx_nodes_kind",
    "idx_nodes_qualified",
    "idx_edges_source",
    "idx_edges_target",
    "idx_edges_kind",
    "idx_edges_file",
    "idx_nodes_exported_name"
  ]) {
    assert.equal(indexes.has(index), true, index);
  }
}

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function assertNoOutOfScopeLegacyTables(db) {
  const tables = new Set(
    db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name)
  );
  for (const table of ["flows", "flow_memberships", "communities", "coverage_edges"]) {
    assert.equal(tables.has(table), false, table);
  }
}

function assertStoreMissingPath(dbPath, path) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("select count(*) as count from nodes where path = ?").get(path).count, 0, path);
    assert.equal(db.prepare("select count(*) as count from file_hashes where relative_path = ?").get(path).count, 0, path);
    assert.equal(db.prepare("select count(*) as count from nodes_fts where path = ?").get(path).count, 0, path);
  } finally {
    db.close();
  }
}

function assertStoreHasPath(dbPath, path) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.ok(db.prepare("select count(*) as count from nodes where path = ?").get(path).count > 0, path);
    assert.ok(db.prepare("select count(*) as count from file_hashes where relative_path = ?").get(path).count > 0, path);
    assert.ok(db.prepare("select count(*) as count from nodes_fts where path = ?").get(path).count > 0, path);
  } finally {
    db.close();
  }
}

function withFixtureCopy(run) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-store-"));
  const fixtureRoot = join(temp, "wave1");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(fixtureRoot, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function withPythonFixtureCopy(run) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-store-python-"));
  const fixtureRoot = join(temp, "python");
  try {
    cpSync(pythonFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(fixtureRoot, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function withRobustnessFixtureCopy(run) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-store-robustness-"));
  const fixtureRoot = join(temp, "watch-roots");
  try {
    cpSync(robustnessFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    run(fixtureRoot, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function createRuntimeIgnoredFiles(fixtureRoot) {
  writeFileSync(join(fixtureRoot, ".gitignore"), "ignored/drop.ts\n");
  for (const [directory, file] of [
    ["ignored", "drop.ts"],
    ["node_modules/pkg", "index.ts"],
    [".pnpm/pkg", "index.ts"],
    ["vendor/pkg", "generated.ts"],
    [".ace/runtime", "generated.ts"],
    [".lattice/graph", "generated.ts"],
    [".rox-cache", "generated.ts"],
    [".robustness-engine-cache", "generated.ts"],
    ["dist", "generated.ts"]
  ]) {
    mkdirSync(join(fixtureRoot, directory), { recursive: true });
    writeFileSync(join(fixtureRoot, directory, file), "export const ignored = true;\n");
  }
}

function skipGeneratedStore(source) {
  const normalized = source.replaceAll("\\", "/");
  return !normalized.endsWith("/.lattice") && !normalized.includes("/.lattice/");
}

function edgeTriples(edges) {
  return edges.map((edge) => [edge.kind, edge.from, edge.to]).sort(compareTuple);
}

function paths(nodes) {
  return [...new Set(nodes.map((node) => node.path).filter(Boolean))].sort();
}

function rawGraphStatus(repoRoot) {
  return invokeGraphCoreSidecar(baseRawGraphRequest(repoRoot, "raw-status", "status")).status;
}

function rawNamedQuery(repoRoot, options) {
  return invokeGraphCoreSidecar({
    ...baseRawGraphRequest(repoRoot, "raw-named-query", "query"),
    namedQuery: {
      requestId: "raw-named-query",
      repo: { repoRoot },
      schemaVersion: 1,
      mode: "required",
      queryKind: options.queryKind,
      target: options.target,
      maxDepth: options.maxDepth,
      limit: options.limit
    }
  }).namedQuery;
}

function rawGraphImpact(repoRoot, options) {
  return invokeGraphCoreSidecar({
    ...baseRawGraphRequest(repoRoot, "raw-impact", "query"),
    impact: {
      requestId: "raw-impact",
      repo: { repoRoot },
      schemaVersion: 1,
      mode: "required",
      files: options.files,
      maxDepth: options.maxDepth,
      limit: options.limit
    }
  }).impact;
}

function rawGraphReviewContext(repoRoot, options) {
  return invokeGraphCoreSidecar({
    ...baseRawGraphRequest(repoRoot, "raw-review-context", "query"),
    reviewContext: {
      requestId: "raw-review-context",
      repo: { repoRoot },
      schemaVersion: 1,
      mode: "required",
      files: options.files,
      maxDepth: options.maxDepth,
      limit: options.limit
    }
  }).reviewContext;
}

function baseRawGraphRequest(repoRoot, requestId, operation) {
  return {
    protocol: "lattice.graph.daemon",
    requestId,
    schemaVersion: 1,
    operation,
    repo: { repoRoot }
  };
}

function compareTuple(left, right) {
  return left.join("\0").localeCompare(right.join("\0"));
}
