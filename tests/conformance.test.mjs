import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conformanceFixtureMetadata, fixtureIds } from "../packages/fixtures/dist/index.js";
import { validateManagedToolDescriptor } from "../packages/contracts/dist/index.js";

const removedLegacyMappingsField = `legacy${"Mappings"}`;

const expectedIds = [
  "graph-valid-v1",
  "graph-stale-v1",
  "graph-schema-mismatch-v1",
  "graph-daemon-unavailable-v1",
  "graph-provider-optional-missing-v1",
  "graph-provider-required-missing-v1",
  "edit-safe-edit-v1",
  "edit-validation-refusal-v1",
  "descriptor-discovery-v1",
  "command-router-v1",
  "graph-core-artifact-handshake-v1",
  "source-extraction-wave1-v1",
  "command-adapter-v1",
  "graph-pipeline-v1",
  "graph-query-v1",
  "graph-search-v1",
  "graph-serve-transport-v1",
  "inspect-symbol-parity-v1",
  "validation-contract-v1",
  "installed-artifact-smoke-v1",
  "graph-reference-evidence-manifest-v1",
  "graph-reference-evidence-sqlite-fixtures-v1",
  "graph-reference-evidence-daemon-socket-fixtures-v1",
  "graph-reference-evidence-golden-corpus-v1",
  "graph-reference-evidence-baseline-receipts-v1",
  "graph-release-readiness-v1"
];

const providerFailureStates = new Set([
  "stale",
  "schema_mismatch",
  "daemon_unavailable",
  "skipped",
  "required_missing",
  "error"
]);

describe("conformance fixture metadata", () => {
  it("declares exact concrete synthetic fixture ids", () => {
    assert.deepEqual(fixtureIds, expectedIds);
    assert.deepEqual(
      conformanceFixtureMetadata.map((fixture) => fixture.id),
      expectedIds
    );
    for (const fixture of conformanceFixtureMetadata) {
      assert.equal(fixture.origin, "covibes-authored-synthetic");
      assert.equal(fixture.containsSourceCode, fixture.id === "source-extraction-wave1-v1" || fixture.id === "inspect-symbol-parity-v1");
      assert.equal(
        fixture.issue,
        fixture.id === "command-router-v1"
          ? "#20"
          : fixture.id === "graph-core-artifact-handshake-v1"
            ? "#21"
          : fixture.id === "source-extraction-wave1-v1"
              ? "#8"
              : fixture.id === "command-adapter-v1"
                ? "#37"
                : fixture.id === "graph-pipeline-v1"
                  ? "#10"
                : fixture.id === "graph-query-v1"
                  ? "#11"
                : fixture.id === "graph-search-v1"
                  ? "#12"
                : fixture.id === "graph-serve-transport-v1"
                    ? "#47"
                : fixture.id === "inspect-symbol-parity-v1"
                    ? "#100"
                : fixture.id === "validation-contract-v1"
                    ? "#25"
                : fixture.id === "graph-release-readiness-v1"
                    ? "#17"
                : fixture.id === "descriptor-discovery-v1" || fixture.id === "installed-artifact-smoke-v1"
                    ? "#28"
                : fixture.id.startsWith("graph-reference-evidence-")
                  ? "#19"
                  : "#3"
      );
      assert.equal(fixture.schemaVersion, 1);
      assert.notEqual(fixture.status, "placeholder");
    }
  });

  it("models provider failure states without empty graph data", () => {
    const optionalMissing = fixtureById("graph-provider-optional-missing-v1");
    const requiredMissing = fixtureById("graph-provider-required-missing-v1");
    assert.equal(optionalMissing.providerStatus.state, "skipped");
    assert.equal(optionalMissing.providerStatus.mode, "optional");
    assert.equal(requiredMissing.providerStatus.state, "required_missing");
    assert.equal(requiredMissing.providerStatus.mode, "required");

    for (const fixture of conformanceFixtureMetadata) {
      if (!providerFailureStates.has(fixture.providerStatus?.state)) continue;
      assert.equal(fixture.providerStatus.failure?.category.length > 0, true);
      assert.equal(fixture.graph, undefined);
    }
  });

  it("keeps graph facts only on the valid graph fixture", () => {
    const validGraph = fixtureById("graph-valid-v1");
    assert.ok(validGraph.graph.nodes.length > 0);
    assert.ok(validGraph.graph.edges.length > 0);
    for (const fixture of conformanceFixtureMetadata.filter((entry) => entry.id !== "graph-valid-v1")) {
      assert.equal(fixture.graph, undefined);
    }
  });

  it("uses typed edit and validation refusal categories", () => {
    const safeEdit = fixtureById("edit-safe-edit-v1");
    assert.equal(safeEdit.editPlan.atomic, "all_or_nothing");
    assert.deepEqual(
      safeEdit.editPlan.changes.map((change) => change.kind),
      ["replace", "rename"]
    );

    const validationRefusal = fixtureById("edit-validation-refusal-v1");
    assert.equal(validationRefusal.validation.status, "refused");
    assert.equal(validationRefusal.validation.refusalCategory, "validation_failed");
    assert.deepEqual(validationRefusal.validation.diagnostics, [
      {
        category: "edit_safety",
        severity: "error"
      }
    ]);
  });

  it("describes descriptor discovery and installed artifact smoke metadata", () => {
    for (const id of ["descriptor-discovery-v1", "installed-artifact-smoke-v1"]) {
      const descriptor = fixtureById(id).descriptor;
      assert.equal(descriptor.dataFile, "packages/fixtures/descriptors/lattice.managed-tool.json");
      assert.equal(descriptor.descriptorKind, "aggregate_lattice");
      assert.equal(descriptor.packageName, "@the-open-engine/lattice-cli");
      assert.ok(descriptor.entrypoints.length > 0);
      assert.deepEqual(descriptor.commandGroups, [
        "lattice graph",
        "lattice inspect",
        "lattice edit",
        "lattice check",
        "lattice validate",
        "lattice status",
        "lattice doctor"
      ]);
      assert.ok(descriptor.healthProbes.includes("lattice status --json"));
      assert.ok(descriptor.healthProbes.includes("lattice doctor --json"));
      assert.ok(descriptor.capabilities.length > 0);
      assert.ok(descriptor.artifacts.length > 0);
      assert.ok(descriptor.checksums.length > 0);
      assert.ok(descriptor.provenanceHooks.length > 0);
      assert.deepEqual(descriptor.validationGraphModes, ["optional", "required"]);
      assert.deepEqual(descriptor.optionalSurfaces, [
        "#13:coverage:deferred",
        "#14:flows:deferred",
        "#15:communities:deferred",
        "#16:read_only_suggestions:deferred"
      ]);
    }
  });

  it("ships a strict aggregate descriptor fixture for #28", () => {
    const descriptorPath = "packages/fixtures/descriptors/lattice.managed-tool.json";
    const descriptor = validateManagedToolDescriptor(JSON.parse(readFileSync(descriptorPath, "utf8")));
    assert.equal(descriptor.descriptorKind, "aggregate_lattice");
    assert.deepEqual(
      descriptor.commandGroups.map((group) => group.name),
      ["graph", "inspect", "edit", "check", "validate", "status", "doctor"]
    );
    assert.deepEqual(descriptor.capabilities.graph.commands, [
      "build",
      "update",
      "watch",
      "status",
      "query",
      "impact",
      "review-context",
      "detect-changes",
      "search",
      "serve"
    ]);
    assert.deepEqual(descriptor.capabilities.validation.graphModes, ["optional", "required"]);
    assert.deepEqual(descriptor.capabilities.validation.validateRoutes, ["request", "hypothetical", "pre-write", "manifest"]);
    assert.deepEqual(
      descriptor.optionalSurfaces.map((surface) => surface.issue),
      ["#13", "#14", "#15", "#16"]
    );
    const text = JSON.stringify(descriptor);
    assert.doesNotMatch(text, /(^|[\\/"'\s])\.ace(?:[\\/"'\s]|$)|LATTICE_CURRENT_TOOLS_DIR|\/Users\/tom|(^|[\\/\s])(?:crg|cix|rox)(?:$|[\\/\s])/i);
  });

  it("describes canonical router metadata for descriptor planning", () => {
    const router = fixtureById("command-router-v1").router;
    assert.deepEqual(router.entrypoints, ["lattice"]);
    assert.deepEqual(router.commandGroups, [
      "lattice graph",
      "lattice inspect",
      "lattice edit",
      "lattice check",
      "lattice validate",
      "lattice status",
      "lattice doctor"
    ]);
    assert.deepEqual(router.exitSemantics, {
      ok: 0,
      error: 1,
      notImplemented: 2,
      unsupported: 64,
      jsonStable: true
    });
    assert.equal(Object.hasOwn(router, removedLegacyMappingsField), false);
  });

  it("describes validation contract fixture coverage for #25", () => {
    const validation = fixtureById("validation-contract-v1");
    assert.equal(validation.dataFile, "packages/fixtures/validation-contract/validation-fixtures.json");
    assert.deepEqual(validation.validationContract.scopes, ["files", "changed", "staged", "tree", "all", "repo", "package"]);
    assert.deepEqual(validation.validationContract.overlayActions, ["write", "delete"]);
    assert.deepEqual(validation.validationContract.resultStatuses, [
      "passed",
      "policy_failure",
      "infrastructure_failure",
      "provider_failure",
      "unsupported_request",
      "invalid_payload",
      "skipped",
      "refused"
    ]);
    assert.ok(validation.validationContract.providerFailureCategories.includes("incompatible_provider"));
    assert.ok(validation.validationContract.providerFailureCategories.includes("provider_error"));
    const data = JSON.parse(readFileSync("packages/fixtures/validation-contract/validation-fixtures.json", "utf8"));
    assert.equal(data.issue, "#25");
    assert.equal(data.graphModes.requiredFailures.length, 6);
    assert.equal(data.editHypotheticalOverlays.request.overlays[0].action, "delete");
    assert.equal(data.editHypotheticalOverlays.request.overlays[1].action, "write");
  });

  it("describes package-owned command adapter metadata for #37", () => {
    const adapter = fixtureById("command-adapter-v1").adapter;
    assert.equal(adapter.canonicalBin, "lattice");
    assert.equal(Object.hasOwn(adapter, "aliasBins"), false);
    assert.deepEqual(adapter.packageAdapters, [
      "graphCommandAdapter",
      "editCommandAdapter",
      "checkCommandAdapter",
      "validateCommandAdapter"
    ]);
    assert.ok(adapter.sharedResultFields.includes("providerStatus"));
    assert.ok(adapter.sharedResultFields.includes("graphPipeline"));
    assert.equal(adapter.provider, "lattice-graph");
  });

  it("describes graph-core artifact handshake metadata for #21", () => {
    const graphCore = fixtureById("graph-core-artifact-handshake-v1").graphCore;
    assert.equal(graphCore.artifactName, "lattice-graph-core");
    assert.equal(graphCore.packageName, "@the-open-engine/opcore-graph-core-<target>");
    assert.deepEqual(graphCore.supportedTargets, ["darwin-arm64", "darwin-x64", "linux-x64"]);
    assert.equal(graphCore.provider, "lattice-graph");
    assert.deepEqual(graphCore.operations, ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"]);
    assert.equal(graphCore.nativePath, "lattice-graph-core");
    assert.ok(graphCore.metadataPath.endsWith("metadata.json"));
    assert.ok(graphCore.checksumPath.endsWith(".sha256"));
  });

  it("describes #10 graph pipeline fixtures", () => {
    const pipeline = fixtureById("graph-pipeline-v1").graphPipeline;
    assert.deepEqual(pipeline.operations, ["build", "update", "watch", "status", "ping", "health"]);
    assert.ok(pipeline.statuses.includes("warming"));
    assert.deepEqual(pipeline.phaseTimings, ["discovery", "extraction", "store", "watch"]);
    assert.ok(pipeline.artifacts.includes(".lattice/graph/daemon/state.json"));
  });

  it("describes #11 graph query fixtures", () => {
    const graphQuery = fixtureById("graph-query-v1").graphQuery;
    const queryFixture = JSON.parse(readFileSync(graphQuery.dataFile, "utf8"));
    assert.deepEqual(graphQuery.commands, ["impact", "query", "review-context", "detect-changes"]);
    assert.deepEqual(graphQuery.namedQueryKinds, [
      "callers_of",
      "callees_of",
      "importers_of",
      "imports_of",
      "tests_for",
      "children_of",
      "file_summary"
    ]);
    assert.ok(graphQuery.failureStates.includes("stale"));
    assert.equal(graphQuery.dataFile, "packages/fixtures/graph-query/query-fixtures.json");
    assert.deepEqual(Object.keys(queryFixture.edgeCaseExpectations), graphQuery.edgeCases);
    assert.equal(queryFixture.edgeCaseExpectations.import_cycles.truncated, false);
    assert.deepEqual(queryFixture.edgeCaseExpectations.deleted_files.deletedFiles, ["src/deleted.ts"]);
    assert.equal(queryFixture.edgeCaseExpectations.renamed_paths.fromPath, "src/old.ts");
    assert.equal(queryFixture.edgeCaseExpectations.missing_nodes.expectedMissingNodePayload, false);
    assert.equal(queryFixture.edgeCaseExpectations.unsupported_named_query.failureCategory, "unsupported_mode");
  });

  it("describes #12 graph search fixtures", () => {
    const graphSearch = fixtureById("graph-search-v1").graphSearch;
    const searchFixture = JSON.parse(readFileSync(graphSearch.dataFile, "utf8"));
    assert.deepEqual(graphSearch.commands, ["search"]);
    assert.deepEqual(graphSearch.indexedNodeKinds, ["File", "Class", "Function", "Type", "Test", "Variable"]);
    assert.ok(graphSearch.failureStates.includes("schema_mismatch"));
    assert.deepEqual(graphSearch.contextFiles, ["src/components/GreetingCard.tsx"]);
    assert.equal(graphSearch.dataFile, "packages/fixtures/graph-search/search-fixtures.json");
    assert.deepEqual(searchFixture.queries.greeting.expectedTopNodeIds, [
      "function:src/components/GreetingCard.tsx#GreetingCard",
      "class:src/models.ts#GreetingModel",
      "class:src/models.ts#FriendlyGreetingModel"
    ]);
  });

  it("describes #47 graph serve transport fixtures", () => {
    const graphServe = fixtureById("graph-serve-transport-v1").graphServe;
    const serveFixture = JSON.parse(readFileSync(graphServe.dataFile, "utf8"));
    assert.deepEqual(graphServe.commands, ["serve"]);
    assert.deepEqual(graphServe.protocols, ["lattice.graph.daemon", "jsonrpc-2.0"]);
    assert.deepEqual(graphServe.operations, ["ping", "status", "query", "search", "shutdown"]);
    assert.ok(graphServe.failureStates.includes("schema_mismatch"));
    assert.equal(graphServe.dataFile, "packages/fixtures/graph-reference-evidence/daemon-socket-fixtures.json");
    assert.ok(serveFixture.envelopes.some((entry) => entry.id === "serve-jsonl-ping"));
    assert.ok(serveFixture.envelopes.some((entry) => entry.id === "mcp-initialize"));
  });

  it("describes #100 inspect symbol parity fixture foundation", () => {
    const inspect = fixtureById("inspect-symbol-parity-v1").inspectSymbolParity;
    assert.equal(inspect.fixtureRoot, "packages/fixtures/inspect-symbol-parity");
    assert.deepEqual(inspect.routes, ["references", "signature", "implementations"]);
    assert.deepEqual(inspect.languages, ["ts", "tsx", "js", "jsx"]);
    assert.ok(inspect.edgeCases.includes("unsupported-degraded"));
    assert.equal(inspect.expectedSignatureFile, "packages/fixtures/inspect-symbol-parity/expected-signatures.json");
    assert.equal(inspect.expectedImplementationFile, "packages/fixtures/inspect-symbol-parity/expected-implementations.json");
  });

  it("describes Wave 1 source extraction fixture metadata for #8", () => {
    const sourceExtraction = fixtureById("source-extraction-wave1-v1").sourceExtraction;
    assert.equal(sourceExtraction.fixtureRoot, "packages/fixtures/source-extraction/wave1");
    assert.deepEqual(sourceExtraction.languages, ["ts", "tsx", "js", "jsx"]);
    assert.deepEqual(sourceExtraction.nodeKinds, ["File", "Class", "Function", "Type", "Test", "Variable"]);
    assert.ok(sourceExtraction.edgeKinds.includes("TESTED_BY"));
    assert.deepEqual(sourceExtraction.diagnostics, []);
  });

  it("includes concrete source-free #19 reference evidence data files", () => {
    for (const id of expectedIds.filter((entry) => entry.startsWith("graph-reference-evidence-"))) {
      const fixture = fixtureById(id);
      assert.equal(fixture.issue, "#19");
      assert.equal(fixture.packageTrack, "fixtures");
      assert.equal(fixture.containsSourceCode, false);
      assert.equal(fixture.origin, "covibes-authored-synthetic");
      assert.ok(fixture.dataFile?.startsWith("packages/fixtures/graph-reference-evidence/"), `bad dataFile ${fixture.dataFile}`);
      const url = new URL(`../${fixture.dataFile}`, import.meta.url);
      const content = readFileSync(url, "utf8");
      assert.ok(JSON.parse(content));
      assert.doesNotMatch(content, /tirth8205|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|git clone/i);
    }
  });

  it("describes #17 graph release readiness metadata", () => {
    const graphRelease = fixtureById("graph-release-readiness-v1").graphRelease;
    const receipt = JSON.parse(readFileSync(graphRelease.receipt, "utf8"));
    assert.deepEqual(graphRelease.commands, ["build", "update", "watch", "status", "query", "impact", "search", "serve"]);
    assert.equal(Object.hasOwn(graphRelease, "aliases"), false);
    assert.deepEqual(graphRelease.directSqliteQueries, [
      "status-counts",
      "status-edge-counts",
      "impact-edges-from-file",
      "search-by-name",
      "freshness-metadata"
    ]);
    assert.deepEqual(graphRelease.deferredChildren, ["#13", "#14", "#15", "#16"]);
    assert.deepEqual(graphRelease.optionalSurfaces, [
      { issue: "#13", id: "coverage", classification: "deferred", status: "deferred" },
      { issue: "#14", id: "flows", classification: "optional", status: "deferred" },
      { issue: "#15", id: "communities", classification: "optional", status: "deferred" },
      { issue: "#16", id: "read_only_suggestions", classification: "supporting", status: "deferred" }
    ]);
    assert.deepEqual(graphRelease.handoffIssues, ["#7", "#28", "#29"]);
    assert.equal(receipt.issue, "#17");
    assert.equal(receipt.packageInspection.forbiddenMarkersAbsent, true);
    assert.deepEqual(
      receipt.benchmarks.map((entry) => entry.metric),
      graphRelease.benchmarkMetrics
    );
  });
});

function fixtureById(id) {
  const fixture = conformanceFixtureMetadata.find((entry) => entry.id === id);
  assert.ok(fixture, `Missing fixture ${id}`);
  return fixture;
}
