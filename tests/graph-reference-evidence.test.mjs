import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { validateGraphReferenceEvidenceManifest } from "../packages/contracts/dist/index.js";

const fixtureRoot = new URL("../packages/fixtures/graph-reference-evidence/", import.meta.url);
const manifest = readFixture("manifest.json");
const sqliteFixtures = readFixture("sqlite-fixtures.json");
const daemonFixtures = readFixture("daemon-socket-fixtures.json");
const goldenCorpus = readFixture("golden-corpus.json");
const baselineReceipts = readFixture("baseline-receipts.json");

describe("graph reference evidence fixtures", () => {
  it("validates the reference evidence manifest through shared contracts", () => {
    assert.equal(validateGraphReferenceEvidenceManifest(manifest).issue, "#19");
    assert.deepEqual(manifest.fixtureRefs, [
      "packages/fixtures/graph-reference-evidence/sqlite-fixtures.json",
      "packages/fixtures/graph-reference-evidence/daemon-socket-fixtures.json",
      "packages/fixtures/graph-reference-evidence/golden-corpus.json",
      "packages/fixtures/graph-reference-evidence/baseline-receipts.json"
    ]);
  });

  it("records neutral command evidence for canonical graph routes", () => {
    assertCommand("graph-reference-build", ["build"], ["lattice", "graph", "build"]);
    assertCommand("graph-reference-update", ["update"], ["lattice", "graph", "update"]);
    assertCommand("graph-reference-watch", ["watch"], ["lattice", "graph", "watch"]);
    assertCommand("graph-reference-status", ["status"], ["lattice", "graph", "status"]);
    assertCommand("graph-reference-query", ["query"], ["lattice", "graph", "query"]);
    assertCommand("graph-reference-impact", ["impact"], ["lattice", "graph", "impact"]);
    assertCommand("graph-reference-search", ["search"], ["lattice", "graph", "search"]);
    assertCommand("graph-reference-serve", ["serve"], ["lattice", "graph", "serve"]);
  });

  it("keeps SQLite and daemon evidence concrete", () => {
    assert.deepEqual(sqliteFixtures.nodeKinds, ["File", "Function", "Test"]);
    assert.deepEqual(sqliteFixtures.edgeKinds, ["CALLS", "CONTAINS", "IMPORTS_FROM", "TESTED_BY"]);
    assert.deepEqual(sqliteFixtures.tables.map((entry) => entry.name), ["metadata", "nodes", "edges", "nodes_fts"]);
    assert.deepEqual(
      sqliteFixtures.indexes,
      [
        "idx_nodes_file",
        "idx_nodes_kind",
        "idx_nodes_qualified",
        "idx_edges_source",
        "idx_edges_target",
        "idx_edges_kind",
        "idx_edges_file",
        "idx_nodes_exported_name"
      ]
    );
    assert.equal(sqliteFixtures.tables.find((entry) => entry.name === "nodes").columns.includes("community_id"), false);
    assert.equal(sqliteFixtures.tables.some((entry) => ["flows", "flow_memberships", "communities", "embeddings"].includes(entry.name)), false);
    assert.deepEqual(sqliteFixtures.optionalAnalysisTables, [
      {
        issue: "#14",
        id: "flows",
        classification: "optional",
        tables: ["flows", "flow_memberships"],
        indexes: ["idx_flows_criticality", "idx_flows_entry", "idx_flow_memberships_node"]
      },
      {
        issue: "#15",
        id: "communities",
        classification: "optional",
        tables: ["communities"],
        indexes: ["idx_nodes_community", "idx_communities_parent", "idx_communities_cohesion"]
      },
      {
        issue: "#16",
        id: "embeddings",
        classification: "supporting",
        tables: ["embeddings"],
        indexes: []
      }
    ]);
    const requiredStatusFields = manifest.jsonOutputSurfaces.find((entry) => entry.id === "status-json").requiredFields;
    assert.equal(requiredStatusFields.includes("embeddings_count"), false);
    const manifestSqlite = manifest.sqliteFixtures.find((entry) => entry.id === "sqlite-required-views");
    assert.deepEqual(manifestSqlite.tables, ["metadata", "nodes", "edges", "nodes_fts"]);
    assert.equal(manifestSqlite.indexes.includes("idx_nodes_community"), false);
    assert.deepEqual(
      manifest.optionalAnalysisSurfaces.map(({ issue, id, classification, status }) => ({ issue, id, classification, status })),
      [
        { issue: "#13", id: "coverage", classification: "deferred", status: "deferred" },
        { issue: "#14", id: "flows", classification: "optional", status: "deferred" },
        { issue: "#15", id: "communities", classification: "optional", status: "deferred" },
        { issue: "#16", id: "read_only_suggestions", classification: "supporting", status: "deferred" }
      ]
    );
    assert.equal(manifest.optionalAnalysisSurfaces.some((entry) => entry.classification === "required"), false);
    assertDirectQuery("status-counts", "select kind, count(*) as count from nodes group by kind order by kind");
    assertDirectQuery("impact-edges-from-file", "select kind, source_qualified, target_qualified from edges where file_path = ?");
    for (const id of ["serve-jsonl-ping", "serve-jsonl-status", "serve-jsonl-query", "serve-jsonl-search", "serve-jsonl-shutdown"]) {
      assert.ok(daemonFixtures.envelopes.find((entry) => entry.id === id), `missing daemon envelope ${id}`);
    }
  });

  it("keeps the golden corpus synthetic and internally consistent", () => {
    assert.equal(goldenCorpus.origin, "covibes-authored-synthetic");
    assert.equal(goldenCorpus.containsSourceCode, false);
    const nodes = goldenCorpus.expectedFacts.parser.nodes;
    const edges = goldenCorpus.expectedFacts.store.edges;
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of edges) {
      assert.equal(nodeIds.has(edge.source), true, `missing edge source ${edge.source}`);
      assert.equal(nodeIds.has(edge.target), true, `missing edge target ${edge.target}`);
    }
    assert.deepEqual(countBy(nodes, "kind"), goldenCorpus.expectedFacts.status.nodesByKind);
    assert.deepEqual(countBy(edges, "kind"), goldenCorpus.expectedFacts.status.edgesByKind);
  });

  it("records baseline receipts as non-implementation reference evidence", () => {
    assert.equal(baselineReceipts.label, "reference_evidence_non_implementation_input");
    assert.equal(baselineReceipts.sourceTool, "current external graph dev wrapper");
    assert.deepEqual(baselineReceipts.receipts.map((receipt) => receipt.metric), [
      "install_setup_ms",
      "cold_build_ms",
      "incremental_update_ms",
      "impact_cold_ms",
      "impact_hot_ms",
      "search_ms",
      "db_size_bytes",
      "wal_size_bytes",
      "daemon_startup_ms",
      "daemon_query_ms"
    ]);
    for (const receipt of baselineReceipts.receipts) {
      assert.equal(receipt.nonImplementationInput, true);
      assert.equal(receipt.value > 0, true, `nonzero baseline ${receipt.metric}`);
    }
  });

  it("records #4 CRG parity rows as non-implementation compatibility evidence", () => {
    const coveredRows = new Set(manifest.goldenCorpus.covers);
    for (const row of [
      "code-review-graph-cli-surface",
      "crg-watch-roots-ignore-reconcile",
      "crg-wal-health-checkpoint-pressure",
      "crg-hot-query-socket",
      "crg-mcp-tool-surface",
      "crg-impact-query-review-search",
      "lattice-native-graph-provider-surfaces",
      "lattice-current-tools-graph-status",
      "lattice-crg-reference-baseline-release-fixtures",
      "covibes-crg-watch-ci-unit-gate",
      "covibes-push-ready-crg-freshness-impact-gate",
      "covibes-agent-guidance-crg-watch-and-reads",
      "mcp-server-name-code-review-graph-compatibility"
    ]) {
      assert.equal(coveredRows.has(row), true, `missing #4 parity row ${row}`);
    }
    assert.equal(baselineReceipts.label, "reference_evidence_non_implementation_input");
    assert.equal(manifest.provenance.referenceReceiptsAreImplementationInput, false);
  });

  it("enforces provenance guardrails for reference data", () => {
    assert.equal(manifest.provenance.containsPythonCrgSource, false);
    assert.equal(manifest.provenance.containsPackageMetadata, false);
    assert.equal(manifest.provenance.containsGitHistory, false);
    assert.equal(manifest.provenance.referenceReceiptsAreImplementationInput, false);
    assert.deepEqual(manifest.provenance.allowedMentionPaths, [
      "docs/graph-reference-evidence/",
      "packages/fixtures/graph-reference-evidence/"
    ]);
    for (const file of ["manifest.json", "sqlite-fixtures.json", "daemon-socket-fixtures.json", "golden-corpus.json"]) {
      assert.doesNotMatch(readFileSync(new URL(file, fixtureRoot), "utf8"), /tirth8205|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|git clone/i);
    }
  });
});

function readFixture(file) {
  const url = new URL(file, fixtureRoot);
  assert.equal(existsSync(url), true, `missing ${file}`);
  return JSON.parse(readFileSync(url, "utf8"));
}

function assertCommand(id, referenceCommand, canonicalCommand) {
  const command = manifest.commandSurfaces.find((entry) => entry.id === id);
  assert.ok(command, `missing command evidence ${id}`);
  assert.equal(command.classification, "required");
  assert.deepEqual(command.referenceCommand, referenceCommand);
  assert.deepEqual(command.canonicalCommand, canonicalCommand);
}

function assertDirectQuery(id, sql) {
  const query = sqliteFixtures.directReaderQueries.find((entry) => entry.id === id);
  assert.ok(query, `missing direct query ${id}`);
  assert.equal(query.sql, sql);
}

function countBy(entries, key) {
  return entries.reduce((counts, entry) => {
    counts[entry[key]] = (counts[entry[key]] ?? 0) + 1;
    return counts;
  }, {});
}
