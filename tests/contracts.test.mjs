import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GRAPH_SCHEMA_VERSION,
  commandLatencyTelemetryArtifactPolicy,
  commandTimingDegradationReasons,
  commandTimingProcessStates,
  commandExitCodeForStatus,
  commandExitSemantics,
  commandGroupByName,
  commandOwners,
  commandRouteStatuses,
  commandRouterManifest,
  createCommandRouterResult,
  editRefusalCategories,
  aspDogfoodForbiddenProviderMarkers,
  aspDogfoodGuardrailIds,
  graphReleaseBenchmarkMetrics,
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets,
  graphCoreNativePackageNames,
  graphReleaseCoreCommandIds,
  graphReleaseRustCommandIds,
  graphReleaseDeferredChildren,
  graphReleaseDirectSqliteQueryIds,
  graphReleaseHandoffIssues,
  graphReleaseOptionalAnalysisSurfaces,
  latencyBudgetResultStatuses,
  opcoreMeasureLatencyFindingStatuses,
  opcoreMeasureLatencyStatuses,
  releaseReceiptCommandGroups,
  releaseCutoverCurrentToolGuardrailIds,
  releaseCutoverNegativeCheckIds,
  releaseCutoverPythonCommandIds,
  releaseCutoverRustCommandIds,
  releaseReceiptPackageNames,
  releaseReceiptReportIds,
  rustOldRoxComparisonSurfaceIds,
  graphDaemonOperations,
  graphExtractionDiagnosticCategories,
  graphFactQueryKinds,
  graphNamedQueryKinds,
  graphProviderModes,
  graphProviderStatusStates,
  graphSnapshotMetadataKeys,
  inspectFailureCategories,
  providerFailureCategories,
  graphReferenceEvidenceClassifications,
  parseCommandArgv,
  requiredGraphEdgeKinds,
  requiredGraphNodeKinds,
  routeCommandAdapter,
  validationCheckRunStatuses,
  validationFailureCategories,
  validationResultStatuses,
  validationSkippedCheckReasons,
  validateCommandAdapterRequest,
  validateCommandLatencyRecord,
  validateProviderStatus,
  validateCommandTiming,
  validateCommandRouterManifest,
  validateCommandRouterResult,
  validateGraphDaemonRequest,
  validateGraphDaemonResponse,
  validateGraphWatchLifecycle,
  validateGraphImpactResult,
  validateGraphNamedQueryResult,
  validateGraphFactQueryResult,
  validateGraphFactQueryRequest,
  validateGraphPipelineResult,
  validateGraphProviderArtifactMetadata,
  validateGraphProviderCapabilityHandshake,
  validateGraphReleaseReceipt,
  validateAspDogfoodReceipt,
  validateRustOldRoxComparisonReceipt,
  validateReleaseCutoverReceipt,
  validateReleaseReceipt,
  validateGraphSearchRequest,
  validateGraphSearchResult,
  validateGraphServeTransportStatus,
  validateGraphReferenceEvidenceManifest,
  validateInspectRouteResult,
  validateManagedToolDescriptor,
  validateLatencyBudget,
  validateLatencyBudgetResult,
  validateOpcoreInitPlanPayload,
  validateOpcoreMeasureDelta,
  validateOpcoreMetricHistoryEntry,
  validateOpcoreMetricReport,
  validateOpcoreTryPayload,
  validateRepoShapeFingerprint,
  validateEditCommandResult,
  validateEditPlanPayload,
  validateRepoIdentity,
  validateRepoRelativePath,
  validateValidationRequestPayload,
  validatePreWriteValidationReceipt,
  validateValidationResultPayload,
  validateValidationStatusPayload
} from "../packages/contracts/dist/index.js";

const removedLegacyMappingsField = `legacy${"Mappings"}`;

describe("Opcore shared contracts", () => {
  it("exports graph schema constants and status vocabularies", () => {
    assert.equal(GRAPH_SCHEMA_VERSION, 1);
    assert.deepEqual(graphProviderModes, ["optional", "required"]);
    assert.deepEqual(graphProviderStatusStates, [
      "available",
      "warming",
      "skipped",
      "required_missing",
      "stale",
      "schema_mismatch",
      "daemon_unavailable",
      "error"
    ]);
    assert.deepEqual(requiredGraphNodeKinds, [
      "repo",
      "package",
      "file",
      "symbol",
      "test",
      "File",
      "Module",
      "Class",
      "Function",
      "Variable",
      "Type",
      "Test",
      "Struct",
      "Enum",
      "Trait",
      "Impl",
      "Method",
      "TypeAlias",
      "Const",
      "Static",
      "Macro"
    ]);
    assert.deepEqual(requiredGraphEdgeKinds, [
      "CONTAINS",
      "DECLARES",
      "IMPORTS_FROM",
      "CALLS",
      "TESTED_BY",
      "INHERITS",
      "IMPLEMENTS",
      "DEPENDS_ON"
    ]);
    assert.deepEqual(
      requiredGraphEdgeKinds.filter((kind) => ["CONTAINS", "IMPORTS_FROM", "CALLS", "IMPLEMENTS", "DEPENDS_ON", "INHERITS"].includes(kind)),
      ["CONTAINS", "IMPORTS_FROM", "CALLS", "INHERITS", "IMPLEMENTS", "DEPENDS_ON"]
    );
    assert.deepEqual(graphExtractionDiagnosticCategories, [
      "missing_tsconfig",
      "malformed_tsconfig",
      "unsupported_language",
      "parse_error",
      "missing_parser",
      "unresolved_import",
      "max_files_exceeded",
      "max_depth_exceeded",
      "path_traversal",
      "io_error"
    ]);
    assert.deepEqual(providerFailureCategories, [
      "provider_missing",
      "daemon_unavailable",
      "schema_mismatch",
      "stale_snapshot",
      "query_failed",
      "incompatible_provider",
      "provider_error",
      "permission_denied",
      "unsupported_mode",
      "unknown"
    ]);
    assert.deepEqual(validationResultStatuses, [
      "passed",
      "policy_failure",
      "infrastructure_failure",
      "provider_failure",
      "unsupported_request",
      "invalid_payload",
      "skipped",
      "refused"
    ]);
    assert.deepEqual(validationFailureCategories, [
      "policy_failure",
      "infrastructure_failure",
      "provider_failure",
      "unsupported_request",
      "invalid_payload",
      "skipped"
    ]);
    assert.deepEqual(validationCheckRunStatuses, [
      "passed",
      "policy_failure",
      "infrastructure_failure",
      "provider_failure",
      "unsupported_request",
      "skipped"
    ]);
    assert.deepEqual(validationSkippedCheckReasons, [
      "graph_unavailable",
      "unsupported_scope",
      "not_requested",
      "no_files",
      "provider_failure"
    ]);
    assert.deepEqual(inspectFailureCategories, [
      "graph_unavailable",
      "target_ambiguous",
      "target_not_found",
      "unsupported_language",
      "malformed_target",
      "language_service_error",
      "unsupported_route"
    ]);
    assert.deepEqual(graphSnapshotMetadataKeys, [
      "schemaVersion",
      "provider",
      "repo",
      "generatedAt",
      "freshness",
      "nodeKinds",
      "edgeKinds"
    ]);
    assert.equal(editRefusalCategories.includes("validation_failed"), true);
    assert.deepEqual(commandOwners, ["graph", "inspect", "edit", "validation", "runtime"]);
    assert.deepEqual(commandRouteStatuses, ["ok", "error", "not_implemented", "unsupported"]);
    assert.deepEqual(graphReleaseCoreCommandIds, [
      "opcore-graph-build",
      "opcore-graph-update",
      "opcore-graph-watch",
      "opcore-graph-status",
      "opcore-graph-query",
      "opcore-graph-impact",
      "opcore-graph-search",
      "opcore-graph-serve",
          ]);
    assert.deepEqual(graphReleaseRustCommandIds, [
      "opcore-graph-rust-build",
      "opcore-graph-rust-update",
      "opcore-graph-rust-watch",
      "opcore-graph-rust-status",
      "opcore-graph-rust-query",
      "opcore-graph-rust-impact",
      "opcore-graph-rust-search",
      "opcore-graph-rust-serve"
    ]);
    assert.deepEqual(releaseCutoverRustCommandIds, [
      "graph-rust-build",
      "graph-rust-status",
      "graph-rust-query",
      "graph-rust-impact",
      "graph-rust-review-context",
      "graph-rust-detect-changes",
      "graph-rust-search"
    ]);
    assert.deepEqual(releaseCutoverPythonCommandIds, [
      "opcore-python-scan",
      "opcore-python-status",
      "opcore-python-check-changed",
      "opcore-python-measure",
      "graph-python-build",
      "graph-python-status",
      "graph-python-query",
      "graph-python-search"
    ]);
    assert.deepEqual(releaseCutoverNegativeCheckIds, [
      "missing-required-graph-check",
      "missing-required-graph-validate",
      "python-types-degraded-no-tools",
      "python-source-hygiene-no-ruff",
      "python-relevant-tests-no-pytest",
      "python-toolchain-degraded-no-tools"
    ]);
    assert.deepEqual(releaseCutoverCurrentToolGuardrailIds, [
      "current-tools-validate-changed",
      "current-tools-validate-rust-graph"
    ]);
    assert.deepEqual(rustOldRoxComparisonSurfaceIds, [
      "rust.rustdoc",
      "rust.import-graph",
      "rust.dead-code",
      "rust.unused-deps",
      "rust.function-metrics",
      "current-tools:validate-rust-graph"
    ]);
    assert.deepEqual(graphReleaseBenchmarkMetrics, [
      "install_setup_ms",
      "cold_build_ms",
      "incremental_update_ms",
      "impact_cold_ms",
      "impact_hot_ms",
      "search_ms",
      "daemon_startup_ms",
      "daemon_query_ms",
      "db_size_bytes",
      "wal_size_bytes"
    ]);
    assert.deepEqual(graphReleaseHandoffIssues, ["#7", "#28", "#29"]);
    assert.deepEqual(graphDaemonOperations, ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"]);
    assert.deepEqual(graphFactQueryKinds, ["nodes", "edges", "neighbors", "symbols", "impact"]);
    assert.deepEqual(graphNamedQueryKinds, [
      "callers_of",
      "callees_of",
      "importers_of",
      "imports_of",
      "tests_for",
      "inheritors_of",
      "children_of",
      "file_summary"
    ]);
    assert.deepEqual(graphReferenceEvidenceClassifications, ["required", "supporting", "optional", "deferred"]);
    assert.deepEqual(graphReleaseDeferredChildren, ["#13", "#14", "#15", "#16"]);
    assert.deepEqual(graphReleaseOptionalAnalysisSurfaces, expectedOptionalAnalysisSurfaces());
  });

  it("accepts typed provider statuses", () => {
    const status = validateProviderStatus({
      state: "available",
      mode: "required",
      provider: "opcore-graph",
      schemaVersion: 1,
      repo: {
        repoId: "opcore"
      },
      freshness: {
        generatedAt: "2026-06-04T00:00:00.000Z",
        ageMs: 0,
        stale: false
      },
      nodes_by_kind: {},
      edges_by_kind: {},
      walCheckpoint: validWalCheckpoint(),
      handshake: validHandshake()
    });
    assert.equal(status.state, "available");
    assert.equal(status.handshake.artifact.artifactName, "opcore-graph-core");
    assert.equal(status.walCheckpoint.checkpointed, true);
    assert.throws(
      () =>
        validateProviderStatus({
          ...availableGraphStatus(),
          walCheckpoint: {
            ...validWalCheckpoint(),
            bytesBefore: -1
          }
        }),
      /bytesBefore must be non-negative/
    );
  });

  it("validates graph-core artifact metadata, handshakes, and daemon envelopes", () => {
    const artifact = validateGraphProviderArtifactMetadata(validArtifactMetadata());
    assert.equal(artifact.binaryPath, "dist/native/test/opcore-graph-core");
    const handshake = validateGraphProviderCapabilityHandshake(validHandshake());
    assert.deepEqual(handshake.supportedOperations, ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"]);

    const query = validateGraphFactQueryRequest(validGraphFactQueryRequest());
    assert.equal(query.selector.kind, "nodes");
    const search = validateGraphSearchRequest(validGraphSearchRequest());
    assert.equal(search.query, "Greeting");
    assert.deepEqual(search.files, ["src/components/GreetingCard.tsx"]);

    const request = validateGraphDaemonRequest({
      protocol: "opcore.graph.daemon",
      requestId: "status-1",
      schemaVersion: 1,
      operation: "status",
      repo: {
        repoId: "opcore"
      },
      idleTimeoutMs: 0
    });
    assert.equal(request.operation, "status");
    assert.equal(request.idleTimeoutMs, 0);
    assert.throws(
      () =>
        validateGraphDaemonRequest({
          ...request,
          idleTimeoutMs: -1
        }),
      /idleTimeoutMs must be a non-negative number/
    );

    const response = validateGraphDaemonResponse({
      protocol: "opcore.graph.daemon",
      requestId: "status-1",
      schemaVersion: 1,
      status: {
        state: "available",
        mode: "required",
        provider: "opcore-graph",
        schemaVersion: 1,
        repo: {
          repoId: "opcore"
        },
        freshness: {
          generatedAt: "2026-06-04T00:00:00.000Z",
          ageMs: 0,
          stale: false
        },
        nodes_by_kind: {},
        edges_by_kind: {},
        handshake
      }
    });
    assert.equal(response.status.state, "available");
    const pipeline = validateGraphPipelineResult({
      summary: {
        operation: "build",
        repo: {
          repoId: "opcore"
        },
        startedAt: "2026-06-04T00:00:00.000Z",
        completedAt: "2026-06-04T00:00:00.001Z",
        durationMs: 1,
        discoveredFiles: 1,
        parsedFiles: 1,
        changedFiles: ["src/index.ts"],
        deletedFiles: [],
        unchangedFiles: 0,
        fullRebuildRequired: false,
        diagnosticsCount: 0,
        phaseTimings: [
          {
            phase: "discovery",
            startedAt: "2026-06-04T00:00:00.000Z",
            completedAt: "2026-06-04T00:00:00.001Z",
            durationMs: 1,
            fileCount: 1
          }
        ]
      },
      status: response.status
    });
    assert.equal(pipeline.summary.operation, "build");
    const lifecycle = validateGraphWatchLifecycle({
      state: "available",
      pid: 1234,
      startedAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.001Z",
      pidPath: "/tmp/advanced/pid",
      statePath: "/tmp/advanced/state.json",
      logPath: "/tmp/advanced/daemon.log",
      pollIntervalMs: 50,
      idleTimeoutMs: 0,
      watchPaths: [],
      message: "graph watch daemon available"
    });
    assert.equal(lifecycle.idleTimeoutMs, 0);
    assert.throws(
      () =>
        validateGraphWatchLifecycle({
          ...lifecycle,
          idleTimeoutMs: Number.NaN
        }),
      /idleTimeoutMs must be a non-negative number/
    );
    const serveStatus = validateGraphServeTransportStatus(validGraphServeTransportStatus());
    assert.equal(serveStatus.state, "ready");
    assert.equal(serveStatus.artifact.artifactName, "opcore-graph-core");
    assert.throws(
      () =>
        validateGraphServeTransportStatus({
          ...validGraphServeTransportStatus(),
          state: "error",
          failure: undefined
        }),
      /error status must include failure/
    );
    assert.throws(
      () =>
        validateGraphDaemonRequest({
          protocol: "opcore.graph.daemon",
          requestId: "query-1",
          schemaVersion: 1,
          operation: "query",
          repo: {
            repoId: "opcore"
          }
        }),
      /must include query/
    );
  });

  it("accepts graph search requests/results and rejects failure rows", () => {
    const request = validateGraphSearchRequest(validGraphSearchRequest());
    assert.equal(request.limit, 5);
    assert.throws(() => validateGraphSearchRequest({ ...request, query: " " }), /query must not be empty/);
    assert.throws(() => validateGraphSearchRequest({ ...request, limit: 0 }), /limit must be a positive number/);
    assert.throws(() => validateGraphSearchRequest({ ...request, files: ["../models.ts"] }), /escape/);

    const available = validateGraphSearchResult(validGraphSearchResult());
    assert.equal(available.searchMode.engine, "fts5");
    assert.equal(available.summary.returned, 1);
    assert.equal(available.results[0].nodeId, "function:src/components/GreetingCard.tsx#GreetingCard");
    assert.deepEqual(available.hints, ["context_file_boost"]);

    const warming = validateGraphSearchResult({ requestId: "search-1", status: validWarmingStatus() });
    assert.equal(warming.status.state, "warming");
    assert.equal(warming.results, undefined);

    assert.throws(
      () =>
        validateGraphSearchResult({
          status: {
            state: "required_missing",
            mode: "required",
            provider: "opcore-graph",
            schemaVersion: 1,
            failure: {
              category: "provider_missing",
              message: "missing"
            }
          },
          results: [],
          summary: {
            query: "Greeting",
            total: 0,
            returned: 0,
            limit: 5,
            indexedNodeKinds: [],
            contextFiles: []
          }
        }),
      /search data/
    );
  });

  it("rejects invalid repo-relative edit and validation paths", () => {
    assert.throws(() => validateRepoRelativePath("/tmp/a.ts"), /absolute/);
    assert.throws(() => validateRepoRelativePath("\\tmp\\a.ts"), /absolute/);
    assert.throws(() => validateRepoRelativePath("\\\\server\\share\\a.ts"), /absolute/);
    assert.throws(() => validateRepoRelativePath("../a.ts"), /escape/);
    assert.throws(
      () =>
        validateValidationRequestPayload({
          repo: {
            repoId: "opcore"
          },
          scope: {
            kind: "files",
            files: ["/tmp/a.ts"]
          },
          graph: {
            mode: "required"
          },
          overlays: []
        }),
      /absolute/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload({
          repo: {
            repoId: "opcore"
          },
          scope: {
            kind: "files",
            files: ["src/index.ts"]
          },
          graph: {
            mode: "required"
          },
          overlays: [
            {
              path: "../a.ts",
              action: "write",
              content: ""
            }
          ]
        }),
      /escape/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload({
          repo: {
            repoId: "opcore"
          },
          scope: {
            kind: "files",
            files: ["\\tmp\\a.ts"]
          },
          graph: {
            mode: "required"
          },
          overlays: []
        }),
      /absolute/
    );
  });

  it("accepts validation scope modes and rejects malformed scope payloads", () => {
    const scopes = [
      { kind: "files", files: ["src/index.ts"] },
      { kind: "changed", baseRef: "origin/main" },
      { kind: "staged" },
      { kind: "tree", treeRef: "HEAD", changedFrom: "origin/main" },
      { kind: "all" },
      { kind: "repo" },
      { kind: "package", packageName: "@the-open-engine/opcore-contracts", packageRoot: "packages/contracts" }
    ];
    for (const scope of scopes) {
      assert.equal(validateValidationRequestPayload(validValidationRequest({ scope })).scope.kind, scope.kind);
    }
    assert.throws(() => validateValidationRequestPayload(validValidationRequest({ scope: { kind: "files", files: [] } })), /files/);
    assert.throws(() => validateValidationRequestPayload(validValidationRequest({ scope: { kind: "changed", baseRef: "" } })), /baseRef/);
    assert.throws(() => validateValidationRequestPayload(validValidationRequest({ scope: { kind: "tree", treeRef: "", changedFrom: "HEAD" } })), /treeRef/);
    assert.throws(() => validateValidationRequestPayload(validValidationRequest({ scope: { kind: "tree", treeRef: "HEAD", changedFrom: "" } })), /changedFrom/);
    assert.throws(
      () =>
        validateValidationRequestPayload(
          validValidationRequest({ scope: { kind: "package", packageName: "@the-open-engine/opcore", packageRoot: "../packages" } })
        ),
      /escape/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload(
          validValidationRequest({ repo: { repoId: "opcore", repoRoot: "/repo" }, scope: { kind: "repo" } })
        ),
      /ambiguous/
    );
    assert.throws(() => validateValidationRequestPayload(validValidationRequest({ repo: { commitSha: "abc" } })), /repoId/);
  });

  it("enforces validation overlay action content, checksum, and duplicate path rules", () => {
    assert.equal(
      validateValidationRequestPayload(
        validValidationRequest({
          overlays: [
            { path: "src/index.ts", action: "write", content: "export {};", checksumBefore: "sha256:before" },
            { path: "src/remove.ts", action: "delete", checksumBefore: "sha256:delete" }
          ]
        })
      ).overlays.length,
      2
    );
    assert.throws(
      () => validateValidationRequestPayload(validValidationRequest({ overlays: [{ path: "src/index.ts", action: "write" }] })),
      /content/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload(
          validValidationRequest({ overlays: [{ path: "src/index.ts", action: "delete", content: "" }] })
        ),
      /must not include content/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload(
          validValidationRequest({
            overlays: [
              { path: "src/index.ts", action: "write", content: "" },
              { path: "src\\index.ts", action: "delete" }
            ]
          })
        ),
      /duplicate/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload(
          validValidationRequest({ overlays: [{ path: "src/index.ts", action: "write", content: "", checksumBefore: "" }] })
        ),
      /checksumBefore/
    );
  });

  it("enforces validation graph mode and typed provider failure states", () => {
    assert.equal(
      validateValidationRequestPayload(
        validValidationRequest({
          graph: {
            mode: "optional",
            provider: "opcore-graph",
            status: providerFailureStatus("skipped", "optional", "provider_missing")
          }
        })
      ).graph.status.state,
      "skipped"
    );
    for (const [state, category] of [
      ["required_missing", "provider_missing"],
      ["stale", "stale_snapshot"],
      ["schema_mismatch", "schema_mismatch"],
      ["daemon_unavailable", "daemon_unavailable"],
      ["error", "incompatible_provider"],
      ["error", "provider_error"]
    ]) {
      assert.equal(
        validateValidationRequestPayload(
          validValidationRequest({
            graph: {
              mode: "required",
              provider: "opcore-graph",
              status: providerFailureStatus(state, "required", category)
            }
          })
        ).graph.status.failure.category,
        category
      );
    }
    for (const [state, category] of [
      ["required_missing", "stale_snapshot"],
      ["stale", "provider_missing"],
      ["schema_mismatch", "provider_error"],
      ["daemon_unavailable", "provider_error"],
      ["error", "schema_mismatch"]
    ]) {
      assert.throws(
        () =>
          validateValidationRequestPayload(
            validValidationRequest({
              graph: {
                mode: "required",
                provider: "opcore-graph",
                status: providerFailureStatus(state, "required", category)
              }
            })
          ),
        /failure category/
      );
    }
    assert.throws(
      () =>
        validateValidationRequestPayload(
          validValidationRequest({
            graph: {
              mode: "required",
              status: providerFailureStatus("skipped", "optional", "provider_missing")
            }
          })
        ),
      /mode must match/
    );
    assert.throws(
      () => validateValidationRequestPayload(validValidationRequest({ graph: { mode: "required", provider: "", maxAgeMs: -1 } })),
      /provider/
    );
  });

  it("validates validation result statuses, failures, and refusals", () => {
    assert.equal(validateValidationResultPayload(validValidationResult({ status: "passed" })).ok, true);
    assert.throws(
      () => validateValidationResultPayload({ ok: false, status: "passed", diagnostics: [] }),
      /passed.*ok|ok.*passed/
    );
    for (const status of [
      "policy_failure",
      "infrastructure_failure",
      "provider_failure",
      "unsupported_request",
      "invalid_payload",
      "skipped"
    ]) {
      const result = validateValidationResultPayload(
        validValidationResult({
          status,
          failure: {
            category: status,
            message: `${status} happened`
          }
        })
      );
      assert.equal(result.ok, false);
      assert.equal(result.failure.category, status);
      assert.throws(
        () =>
          validateValidationResultPayload(
            validValidationResult({
              status,
              failure: {
                category: status === "policy_failure" ? "provider_failure" : "policy_failure",
                message: "wrong category"
              }
            })
          ),
        /category.*status/
      );
    }
    assert.equal(
      validateValidationResultPayload(
        validValidationResult({
          status: "refused",
          refusal: {
            category: "validation_failed",
            message: "edit preflight refused"
          }
        })
      ).refusal.category,
      "validation_failed"
    );
    assert.throws(() => validateValidationResultPayload(validValidationResult({ status: "invalid_payload" })), /failure/);
    assert.throws(() => validateValidationResultPayload(validValidationResult({ status: "refused" })), /refusal/);
    assert.throws(
      () =>
        validateValidationResultPayload(
          validValidationResult({
            status: "refused",
            failure: {
              category: "policy_failure",
              message: "not allowed"
            },
            refusal: {
              category: "validation_failed",
              message: "edit preflight refused"
            }
          })
        ),
      /refused.*failure|failure.*refused/
    );
    assert.throws(
      () =>
        validateValidationResultPayload(
          validValidationResult({
            status: "passed",
            failure: {
              category: "skipped",
              message: "not allowed"
            }
          })
        ),
      /must not include/
    );
  });

  it("validates validation result manifest metadata", () => {
    const manifest = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      checks: ["types", "imports.no-cycles"],
      generatedAt: "2026-06-05T00:00:00.000Z",
      durationMs: 12,
      entries: [
        {
          checkId: "types",
          owner: "validation",
          adapter: "generic",
          defaultSeverity: "error",
          supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
          requiresGraph: false
        },
        {
          checkId: "imports.no-cycles",
          owner: "validation",
          adapter: "generic",
          defaultSeverity: "warning",
          supportedScopes: ["files", "repo"],
          requiresGraph: true
        }
      ],
      runs: [
        {
          checkId: "types",
          status: "passed",
          durationMs: 7,
          diagnosticCount: 1
        }
      ],
      skippedChecks: [
        {
          checkId: "imports.no-cycles",
          reason: "graph_unavailable",
          message: "Graph provider is not configured"
        }
      ]
    };
    const result = validateValidationResultPayload(
      validValidationResult({
        diagnostics: [
          {
            category: "types",
            severity: "warning",
            message: "warning only",
            path: "src/index.ts"
          }
        ],
        manifest
      })
    );
    assert.equal(result.manifest.durationMs, 12);
    assert.equal(result.manifest.entries[1].requiresGraph, true);
    assert.throws(
      () =>
        validateValidationResultPayload(
          validValidationResult({
            manifest: {
              ...manifest,
              durationMs: -1
            }
          })
        ),
      /durationMs/
    );
    assert.throws(
      () =>
        validateValidationResultPayload(
          validValidationResult({
            manifest: {
              ...manifest,
              checks: ["Types"]
            }
          })
        ),
      /check id/
    );
    assert.throws(
      () =>
        validateValidationResultPayload(
          validValidationResult({
            manifest: {
              ...manifest,
              runs: [{ ...manifest.runs[0], status: "failed" }]
            }
          })
        ),
      /run status/
    );
    assert.throws(
      () =>
        validateValidationResultPayload(
          validValidationResult({
            manifest: {
              ...manifest,
              skippedChecks: [{ ...manifest.skippedChecks[0], reason: "missing_graph" }]
            }
          })
        ),
      /skipped reason/
    );
    assert.throws(
      () =>
        validateValidationResultPayload(
          validValidationResult({
            manifest: {
              ...manifest,
              runs: [{ ...manifest.runs[0], status: "infrastructure_failure", failureMessage: "" }]
            }
          })
        ),
      /failureMessage/
    );
    assert.throws(
      () =>
        validateValidationResultPayload(
          validValidationResult({
            diagnostics: [
              {
                category: "types",
                severity: "error",
                message: "bad path",
                path: "../src/index.ts"
              }
            ],
            manifest
          })
        ),
      /escape/
    );
  });

  it("rejects ambiguous repo identity and untyped provider failures", () => {
    assert.throws(
      () =>
        validateRepoIdentity({
          repoId: "opcore",
          repoRoot: "/repo"
        }),
      /ambiguous/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload({
          repo: {
            repoId: "opcore",
            repoRoot: "/repo"
          },
          scope: {
            kind: "repo"
          },
          graph: {
            mode: "required"
          },
          overlays: []
        }),
      /ambiguous/
    );
    assert.throws(
      () =>
        validateProviderStatus({
          state: "daemon_unavailable",
          mode: "required",
          provider: "opcore-graph",
          schemaVersion: 1
        }),
      /failure\.category/
    );
    assert.throws(
      () =>
        validateProviderStatus({
          state: "schema_mismatch",
          mode: "required",
          provider: "opcore-graph",
          schemaVersion: 1,
          failure: {
            category: "schema_mismatch",
            message: "schema version mismatch"
          }
        }),
      /expectedSchemaVersion/
    );
    assert.throws(
      () =>
        validateProviderStatus({
          state: "stale",
          mode: "required",
          provider: "opcore-graph",
          schemaVersion: 1,
          failure: {
            category: "stale_snapshot",
            message: "snapshot is stale"
          }
        }),
      /repo/
    );
    const errorStatus = validateProviderStatus({
      state: "error",
      mode: "required",
      provider: "opcore-graph",
      schemaVersion: 1,
      failure: {
        category: "query_failed",
        message: "extraction failed"
      },
      diagnostics: [
        {
          category: "parse_error",
          severity: "error",
          message: "parse failed",
          path: "src/broken.ts",
          language: "typescript"
        }
      ]
    });
    assert.equal(errorStatus.diagnostics[0].category, "parse_error");
    assert.throws(
      () =>
        validateProviderStatus({
          ...errorStatus,
          diagnostics: [
            {
              category: "parser_failed",
              severity: "error",
              message: "parse failed"
            }
          ]
        }),
      /Unknown graph extraction diagnostic category/
    );
  });

  it("rejects graph query results that attach graph data to provider failures", () => {
    assert.throws(
      () =>
        validateGraphFactQueryResult({
          status: {
            state: "required_missing",
            mode: "required",
            provider: "opcore-graph",
            schemaVersion: 1,
            failure: {
              category: "provider_missing",
              message: "current graph provider missing"
            }
          },
          nodes: [],
          edges: []
        }),
      /graph data/
    );
    assert.throws(
      () =>
        validateGraphFactQueryResult({
          status: {
            state: "daemon_unavailable",
            mode: "required",
            provider: "opcore-graph",
            schemaVersion: 1,
            failure: {
              category: "daemon_unavailable",
              message: "daemon unavailable"
            }
          },
          metadata: {}
        }),
      /graph data/
    );
    assert.throws(
      () =>
        validateGraphImpactResult({
          status: {
            state: "stale",
            mode: "required",
            provider: "opcore-graph",
            schemaVersion: 1,
            repo: {
              repoId: "opcore"
            },
            freshness: {
              generatedAt: "2026-06-04T00:00:00.000Z",
              ageMs: 1,
              stale: true
            },
            failure: {
              category: "stale_snapshot",
              message: "snapshot stale"
            }
          },
          impactedFiles: []
        }),
      /graph data/
    );
    assert.equal(
      validateGraphNamedQueryResult({
        status: {
          state: "required_missing",
          mode: "required",
          provider: "opcore-graph",
          schemaVersion: 1,
          failure: {
            category: "provider_missing",
            message: "missing"
          }
        }
      }).status.state,
      "required_missing"
    );
  });

  it("accepts command-router manifests and results", () => {
    const manifest = validRouterManifest();
    assert.equal(validateCommandRouterManifest(manifest).packageName, "@the-open-engine/opcore");
    assert.equal(validateCommandRouterResult(validRouterResult()).canonicalCommand.join(" "), "opcore status");
    assert.equal(
      validateCommandRouterResult({
        ...validRouterResult(),
        bin: "opcore",
        argv: ["status", "--json"],
        canonicalCommand: ["opcore", "status"],
        repoState: validOpcoreRepoState()
      }).repoState.graph.state,
      "available"
    );
    assert.equal(
      validateCommandRouterResult({
        ...validRouterResult(),
        bin: "opcore",
        argv: ["init", "--json"],
        canonicalCommand: ["opcore", "init"],
        opcoreInit: validOpcoreInitPlan()
      }).opcoreInit.mode,
      "plan"
    );
    assert.equal(validateInspectRouteResult(validInspectRouteResult()).references[0].symbol.name, "GreetingModel");
    assert.equal(
      validateCommandRouterResult({
        ...validRouterResult(),
        owner: "inspect",
        canonicalCommand: ["opcore", "inspect", "references", "src/models.ts", "GreetingModel"],
        providerStatus: availableGraphStatus(),
        inspectResult: validInspectRouteResult()
      }).inspectResult.status,
      "ok"
    );
    assert.equal(
      validateInspectRouteResult({
        route: "references",
        status: "error",
        providerStatus: providerFailureStatus("required_missing", "required", "provider_missing"),
        failure: {
          category: "graph_unavailable",
          message: "graph missing"
        }
      }).failure.category,
      "graph_unavailable"
    );
    assert.equal(
      validateInspectRouteResult({
        ...validInspectRouteResult(),
        status: "degraded",
        providerStatus: providerFailureStatus("stale", "required", "stale_snapshot"),
        failure: {
          category: "graph_unavailable",
          message: "graph stale; language service fallback used"
        }
      }).references[0].symbol.name,
      "GreetingModel"
    );
    assert.throws(
      () =>
        validateInspectRouteResult({
          ...validInspectRouteResult(),
          status: "degraded",
          providerStatus: providerFailureStatus("stale", "required", "stale_snapshot")
        }),
      /requires failure/
    );
    assert.equal(
      validateInspectRouteResult({
        route: "references",
        status: "error",
        target: {
          kind: "file_symbol",
          path: "src/same-name.ts",
          symbolName: "sameName"
        },
        failure: {
          category: "target_ambiguous",
          message: "ambiguous",
          candidates: [
            {
              kind: "file_symbol",
              path: "src/same-name.ts",
              symbolName: "sameName",
              line: 1,
              column: 17
            }
          ]
        }
      }).failure.category,
      "target_ambiguous"
    );
    assert.equal(validateInspectRouteResult(validInspectSignatureResult()).signatures[0].signature, "render(): string");
    assert.equal(validateInspectRouteResult(validInspectImplementationResult()).implementations[0].symbol.name, "FriendlyGreetingModel");
    assert.throws(
      () =>
        validateInspectRouteResult({
          ...validInspectImplementationResult(),
          implementations: [
            {
              ...validInspectImplementationResult().implementations[0],
              kind: undefined,
              target: undefined,
              implements: validInspectImplementationResult().implementations[0].target
            }
          ]
        }),
      /must use target, not implements/
    );
    assert.equal(
      validateInspectRouteResult({
        route: "signature",
        status: "error",
        target: {
          kind: "node",
          nodeId: "class:src/models.ts#GreetingModel"
        },
        providerStatus: availableGraphStatus(),
        failure: {
          category: "language_service_error",
          message: "language service failed"
        }
      }).failure.category,
      "language_service_error"
    );
    assert.throws(
      () =>
        validateInspectRouteResult({
          ...validInspectSignatureResult(),
          providerStatus: providerFailureStatus("stale", "required", "stale_snapshot")
        }),
      /available providerStatus/
    );
    assert.throws(
      () =>
        validateInspectRouteResult({
          route: "implementations",
          status: "error",
          failure: {
            category: "graph_unavailable",
            message: "graph missing"
          },
          implementations: []
        }),
      /must not include implementations/
    );
    assert.throws(
      () =>
        validateInspectRouteResult({
          ...validInspectRouteResult(),
          references: [
            {
              ...validInspectRouteResult().references[0],
              symbol: {
                id: "class:src/models.ts#GreetingModel"
              }
            }
          ]
        }),
      /symbol name/
    );
    assert.equal(commandRouterManifest.packageName, "@the-open-engine/opcore");
    assert.deepEqual(commandExitSemantics, {
      ok: 0,
      error: 1,
      notImplemented: 2,
      unsupported: 64,
      jsonStable: true
    });
    assert.deepEqual(parseCommandArgv(["status", "--json"]), {
      args: ["status"],
      json: true
    });
    assert.equal(commandExitCodeForStatus("error"), 1);
    assert.equal(commandExitCodeForStatus("not_implemented"), 2);
    assert.deepEqual(
      commandRouterManifest.commandGroups.map((group) => group.name),
      ["graph", "inspect", "edit", "check", "validate", "status", "doctor"]
    );
    assert.equal(commandGroupByName("graph").owner, "graph");
    assert.deepEqual(commandGroupByName("inspect").commands, ["symbols", "definition", "references", "signature", "implementations", "search"]);
    assert.deepEqual(commandGroupByName("check").commands, ["files", "staged", "changed", "tree", "all", "manifest"]);
    assert.deepEqual(commandGroupByName("validate").commands, ["request", "hypothetical", "pre-write", "manifest"]);
    assert.deepEqual(commandGroupByName("edit").commands, [
      "exact",
      "multi",
      "search-replace",
      "check",
      "apply",
      "patch",
      "tree",
      "rename",
      "move",
      "signature"
    ]);
    assert.equal(commandGroupByName("start"), undefined);
    assert.equal(commandGroupByName("stop"), undefined);
    assert.deepEqual(commandRouterManifest.bins, ["opcore"]);
    assert.equal(Object.hasOwn(commandRouterManifest, "aliases"), false);
    assert.equal(Object.hasOwn(commandRouterManifest, removedLegacyMappingsField), false);
  });

  it("validates Opcore metric reports, history, deltas, and router payloads", () => {
    const report = validateOpcoreMetricReport(validOpcoreMetricReport());
    assert.equal(report.signals[0].count, 2);
    assert.deepEqual(opcoreMeasureLatencyStatuses, ["ok", "slower", "over_budget"]);
    assert.deepEqual(opcoreMeasureLatencyFindingStatuses, ["slower", "over_budget"]);
    assert.equal(
      validateOpcoreMetricHistoryEntry({
        schemaVersion: 1,
        kind: "opcore_metric_history_entry",
        recordedAt: "2026-06-25T00:00:01.000Z",
        report
      }).report.kind,
      "opcore_metric_report"
    );
    const delta = validateOpcoreMeasureDelta(validOpcoreMeasureDelta());
    assert.equal(delta.baseline.deltas[0].delta, -1);
    assert.equal(delta.latency.findings[0].status, "over_budget");
    assert.equal(
      validateCommandRouterResult({
        ...validRouterResult(),
        bin: "opcore",
        argv: ["measure", "--repo", "/repo", "--json"],
        canonicalCommand: ["opcore", "measure"],
        owner: "runtime",
        opcoreMeasure: delta
      }).opcoreMeasure.kind,
      "opcore_measure_delta"
    );
    const tryPayload = validateOpcoreTryPayload(validOpcoreTryPayload());
    assert.equal(tryPayload.published, false);
    assert.equal(
      validateCommandRouterResult({
        ...validRouterResult(),
        bin: "opcore",
        argv: ["try", "--json"],
        canonicalCommand: ["opcore", "try"],
        owner: "runtime",
        opcoreTry: tryPayload
      }).opcoreTry.scenarios[0].id,
      "typescript-app"
    );
    assert.throws(
      () =>
        validateOpcoreMetricReport({
          ...report,
          signals: [{ ...report.signals[0], count: 0 }]
        }),
      /positive integer/
    );
    assert.throws(
      () =>
        validateOpcoreMetricReport({
          ...report,
          signals: [{ ...report.signals[0], evidence: [] }]
        }),
      /evidence/
    );
    assert.throws(
      () =>
        validateOpcoreMetricReport({
          ...report,
          signals: [{ ...report.signals[0], evidence: [{ ...report.signals[0].evidence[0], path: "" }] }]
        }),
      /evidence path/
    );
    assert.throws(
      () =>
        validateOpcoreMetricReport({
          ...report,
          score: 100
        }),
      /opaque score/
    );
    assert.throws(
      () =>
        validateCommandRouterResult({
          ...validRouterResult(),
          owner: "validation",
          canonicalCommand: ["opcore", "check", "all"],
          opcoreMeasure: delta
        }),
      /runtime owner/
    );
    assert.throws(
      () =>
        validateCommandRouterResult({
          ...validRouterResult(),
          owner: "validation",
          canonicalCommand: ["opcore", "try"],
          opcoreTry: tryPayload
        }),
      /runtime owner/
    );
  });

  it("validates latency telemetry contracts and router timing", () => {
    assert.deepEqual(commandTimingProcessStates, ["cold", "warm"]);
    assert.deepEqual(commandTimingDegradationReasons, ["no_source", "no_paths"]);
    assert.deepEqual(latencyBudgetResultStatuses, ["pass", "over"]);
    assert.deepEqual(commandLatencyTelemetryArtifactPolicy, {
      path: ".opcore/telemetry.jsonl",
      maxRecords: 500,
      maxBytes: 1048576,
      rotation: "ring_buffer"
    });

    const timing = validateCommandTiming(validCommandTiming());
    assert.equal(timing.processState, "warm");
    assert.equal(validateRepoShapeFingerprint(validRepoShapeFingerprint()).graph.unsupportedFiles, 1);
    assert.equal(validateCommandLatencyRecord(validCommandLatencyRecord()).repo.totalFiles, 3);
    assert.equal(validateLatencyBudget(validLatencyBudget()).phaseBudgets[0].phase, "validation");
    assert.equal(validateLatencyBudgetResult(validLatencyBudgetResult()).status, "pass");
    assert.equal(validateLatencyBudgetResult(validLatencyBudgetResult({ status: "over" })).evidence.overByMs, 25);
    assert.equal(
      createCommandRouterResult({
        bin: "opcore",
        argv: ["check", "changed", "--json"],
        canonicalCommand: ["opcore", "check", "changed"],
        owner: "validation",
        status: "ok",
        json: true,
        message: "check complete",
        timing
      }).timing.durationMs,
      42
    );

    assert.throws(
      () =>
        validateCommandLatencyRecord({
          ...validCommandLatencyRecord(),
          repo: { ...validRepoShapeFingerprint(), path: "src/index.ts" }
        }),
      /source-safe/
    );
    assert.throws(
      () =>
        validateCommandLatencyRecord({
          ...validCommandLatencyRecord(),
          bin: "/tmp/project/node_modules/.bin/opcore"
        }),
      /source-safe command bin/
    );
    assert.throws(
      () =>
        validateCommandLatencyRecord({
          ...validCommandLatencyRecord(),
          canonicalCommand: ["opcore", "check", "files", "src/secret.ts"]
        }),
      /source-safe canonicalCommand/
    );
    assert.throws(
      () =>
        validateLatencyBudget({
          ...validLatencyBudget(),
          canonicalCommand: ["opcore", "check", "files", "src/secret.ts"]
        }),
      /source-safe canonicalCommand/
    );
    assert.throws(
      () =>
        validateLatencyBudget({
          ...validLatencyBudget(),
          canonicalCommand: ["opcore", "check", "files", "secret.ts"]
        }),
      /source-safe canonicalCommand/
    );
    assert.throws(
      () =>
        validateLatencyBudgetResult({
          ...validLatencyBudgetResult(),
          observed: {
            ...validLatencyBudgetResult().observed,
            canonicalCommand: ["opcore", "check", "files", "src/secret.ts"]
          }
        }),
      /source-safe canonicalCommand/
    );
    assert.throws(
      () =>
        validateCommandLatencyRecord({
          ...validCommandLatencyRecord(),
          timing: { ...validCommandTiming(), phases: [{ ...validCommandTiming().phases[0], content: "source" }] }
        }),
      /source-safe/
    );
    assert.throws(
      () => validateCommandTiming({ ...validCommandTiming(), score: 99 }),
      /opaque score/
    );
    assert.throws(
      () => validateRepoShapeFingerprint({ ...validRepoShapeFingerprint(), score: 99 }),
      /opaque score/
    );
    assert.throws(
      () => validateCommandLatencyRecord({ ...validCommandLatencyRecord(), score: 99 }),
      /opaque score/
    );
    assert.throws(
      () => validateLatencyBudget({ ...validLatencyBudget(), score: 99 }),
      /opaque score/
    );
    assert.throws(
      () =>
        validateLatencyBudgetResult({
          ...validLatencyBudgetResult(),
          evidence: {
            ...validLatencyBudgetResult().evidence,
            observedMs: 1000,
            budgetMs: 1000,
            overByMs: 0
          },
          observed: {
            ...validLatencyBudgetResult().observed,
            durationMs: 1000
          }
        }),
      /applied budget/
    );
    assert.throws(
      () =>
        validateLatencyBudgetResult({
          ...validLatencyBudgetResult(),
          observed: {
            ...validLatencyBudgetResult().observed,
            phase: "validation",
            durationMs: 76
          },
          evidence: {
            ...validLatencyBudgetResult().evidence,
            phase: "validation",
            observedMs: 76,
            budgetMs: 100,
            overByMs: 0
          }
        }),
      /applied budget/
    );
    assert.throws(
      () => validateCommandLatencyRecord({ ...validCommandLatencyRecord(), exitCode: 1 }),
      /ok status/
    );
    assert.throws(
      () =>
        validateCommandTiming({
          ...validCommandTiming(),
          phases: [{ ...validCommandTiming().phases[0], phase: "graph.build" }]
        }),
      /stable latency id/
    );
  });

  it("validates Opcore init plans and router payloads", () => {
    const plan = validateOpcoreInitPlanPayload(validOpcoreInitPlan());
    assert.equal(plan.actions[0].path, ".opcore/config");
    assert.equal(plan.agentFiles[0], "AGENTS.md");
    assert.equal(plan.scan.totalFiles, 2);
    assert.equal(plan.settings.languages[0].language, "TypeScript");
    assert.equal(plan.interaction.promptState, "not_requested");
    assert.equal(plan.timings.scanMs, 2);
    assert.equal(
      validateCommandRouterResult({
        ...validRouterResult(),
        bin: "opcore",
        argv: ["init", "--approve", "--json"],
        canonicalCommand: ["opcore", "init"],
        opcoreInit: {
          ...plan,
          mode: "apply",
          approved: true
        }
      }).opcoreInit.approved,
      true
    );
    assert.throws(
      () =>
        validateOpcoreInitPlanPayload({
          ...plan,
          approved: true,
          mode: "plan"
        }),
      /approved plan/
    );
    assert.throws(
      () =>
        validateOpcoreInitPlanPayload({
          ...plan,
          actions: [
            {
              ...plan.actions[0],
              path: "../AGENTS.md"
            }
          ]
        }),
      /path/
    );
    assert.throws(
      () =>
        validateOpcoreInitPlanPayload({
          ...plan,
          timings: {
            ...plan.timings,
            scanMs: -1
          }
        }),
      /scanMs/
    );
    assert.throws(
      () =>
        validateOpcoreInitPlanPayload({
          ...plan,
          settings: {
            languages: [
              {
                ...plan.settings.languages[0],
                state: "fictional"
              }
            ]
          }
        }),
      /language setting state/
    );
    assert.throws(
      () =>
        validateOpcoreInitPlanPayload({
          ...plan,
          interaction: {
            ...plan.interaction,
            promptState: "maybe"
          }
        }),
      /promptState/
    );
    assert.throws(
      () =>
        validateCommandRouterResult({
          ...validRouterResult(),
          owner: "validation",
          canonicalCommand: ["opcore", "init"],
          opcoreInit: plan
        }),
      /runtime owner/
    );
  });

  it("accepts aggregate managed-tool descriptors for canonical Opcore artifacts", () => {
    const descriptor = validManagedToolDescriptor();
    assert.equal(validateManagedToolDescriptor(descriptor).descriptorKind, "aggregate_opcore");
    assert.deepEqual(
      descriptor.commandGroups.map((group) => group.name),
      ["graph", "inspect", "edit", "check", "validate", "status", "doctor"]
    );
    assert.deepEqual(descriptor.capabilities.validation.graphModes, graphProviderModes);
    assert.deepEqual(descriptor.capabilities.validation.validateRoutes, ["request", "hypothetical", "pre-write", "manifest"]);
    assert.deepEqual(surfaceContracts(descriptor.optionalSurfaces), expectedOptionalAnalysisSurfaces());
  });

  it("rejects managed-tool descriptors with old aliases or unsafe package paths", () => {
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          entrypoints: [
            {
              ...validManagedToolDescriptor().entrypoints[0],
              bin: ["c", "r", "g"].join("")
            }
          ]
        }),
      /old public aliases/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: [
            {
              ...validManagedToolDescriptor().artifacts[0],
              path: "/tmp/lattice"
            }
          ]
        }),
      /absolute/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: [
            {
              ...validManagedToolDescriptor().artifacts[0],
              path: "../advanced"
            }
          ]
        }),
      /escape/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: [
            {
              ...validManagedToolDescriptor().artifacts[0],
              path: ".ace/runtime/bin/lattice"
            }
          ]
        }),
      /private runtime/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: [
            {
              ...validManagedToolDescriptor().artifacts[0],
              path: ".ace"
            }
          ]
        }),
      /private runtime/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: [
            {
              ...validManagedToolDescriptor().artifacts[0],
              path: "dist/.ace"
            }
          ]
        }),
      /private runtime/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          provenanceHooks: [
            {
              id: "private-runtime-wrapper",
              command: [".ace\\runtime\\bin\\lattice", "status"],
              expectedExitCode: 0
            }
          ]
        }),
      /current-tool runtime paths/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: [
            {
              ...validManagedToolDescriptor().artifacts[0],
              path: "~/lattice"
            }
          ]
        }),
      /private home/
    );
  });

  it("rejects managed-tool descriptors missing required release capabilities", () => {
    const firstNativeTarget = graphCoreNativeSupportedTargets[0];
    const firstNativeBinaryId = `graph-core-binary-${firstNativeTarget}`;
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          commandGroups: validManagedToolDescriptor().commandGroups.map((group) =>
            group.name === "graph" ? { ...group, canonicalCommand: ["graph", "opcore"] } : group
          )
        }),
      /canonicalCommand/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          commandGroups: validManagedToolDescriptor().commandGroups.map((group) =>
            group.name === "edit" ? { ...group, packageName: "@the-open-engine/opcore" } : group
          )
        }),
      /edit packageName/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          commandGroups: validManagedToolDescriptor().commandGroups.filter((group) => group.name !== "status")
        }),
      /command groups/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          healthProbes: validManagedToolDescriptor().healthProbes.filter((probe) => probe.id !== "doctor-json")
        }),
      /doctor/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: validManagedToolDescriptor().artifacts.filter((artifact) => artifact.id !== firstNativeBinaryId)
        }),
      /graph native binary/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: validManagedToolDescriptor().artifacts.filter((artifact) => artifact.id !== "descriptor")
        }),
      /packaged descriptor/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          artifacts: validManagedToolDescriptor().artifacts.map((artifact) =>
            artifact.id === firstNativeBinaryId ? { ...artifact, checksumRef: "missing-checksum" } : artifact
          )
        }),
      /graph native binary artifact/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          capabilities: {
            ...validManagedToolDescriptor().capabilities,
            graph: {
              ...validManagedToolDescriptor().capabilities.graph,
              nativeArtifacts: validManagedToolDescriptor().capabilities.graph.nativeArtifacts.map((artifact) =>
                artifact.targetPlatform === firstNativeTarget
                  ? { ...artifact, artifactIds: { ...artifact.artifactIds, binaryArtifactId: "local-graph-binary" } }
                  : artifact
              )
            }
          }
        }),
      /native binary artifact id/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          capabilities: {
            ...validManagedToolDescriptor().capabilities,
            validation: {
              ...validManagedToolDescriptor().capabilities.validation,
              graphModes: ["optional"]
            }
          }
        }),
      /graph modes/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          optionalSurfaces: validManagedToolDescriptor().optionalSurfaces.slice(1)
        }),
      /staged graph release surfaces/
    );
  });

  it("accepts command adapter requests and graph provider status on router results", async () => {
    const group = commandGroupByName("graph");
    const providerStatus = {
      state: "required_missing",
      mode: "required",
      provider: "opcore-graph",
      schemaVersion: 1,
      failure: {
        category: "provider_missing",
        message: "graph provider not implemented"
      }
    };
    const request = validateCommandAdapterRequest({
      schemaVersion: 1,
      bin: "opcore",
      argv: ["graph", "status", "--json"],
      args: ["status"],
      json: true,
      group,
      canonicalCommand: ["opcore", "graph", "status"]
    });
    assert.equal(request.group.name, "graph");
    const routed = await routeCommandAdapter({
      bin: "opcore",
      argv: ["status", "--json"],
      groupName: "graph",
      adapter: (adapterRequest) =>
        createCommandRouterResult({
          bin: adapterRequest.bin,
          argv: adapterRequest.argv,
          canonicalCommand: adapterRequest.canonicalCommand,
          owner: "graph",
          status: "not_implemented",
          json: adapterRequest.json,
          message: "graph route not implemented",
          providerStatus
        })
    });
    assert.equal(routed.providerStatus.provider, "opcore-graph");
    assert.equal(routed.exitCode, 2);
    const serveRouted = validateCommandRouterResult({
      ...validRouterResult(),
      canonicalCommand: ["opcore", "graph", "serve"],
      owner: "graph",
      graphServe: validGraphServeTransportStatus()
    });
    assert.equal(serveRouted.graphServe.state, "ready");
    const validationStatus = validateValidationStatusPayload(validValidationStatusPayload());
    assert.equal(validationStatus.adapterRegistry.checkIds[0], "typescript.syntax");
    assert.deepEqual(validationStatus.adapterRegistry.adapters[0].degradedChecks[0].currentUsage, retainedRustUsage());
    assert.throws(
      () =>
        validateValidationStatusPayload(
          validValidationStatusPayload({
            adapterRegistry: {
              ...validValidationStatusPayload().adapterRegistry,
              adapters: [
                {
                  ...validValidationStatusPayload().adapterRegistry.adapters[0],
                  degradedChecks: [
                    {
                      ...validValidationStatusPayload().adapterRegistry.adapters[0].degradedChecks[0],
                      currentUsage: { opcore: true, orchestra: true, covibes: false }
                    }
                  ]
                }
              ]
            }
          })
        ),
      /currentUsage\.gateway/
    );
    const validationRouted = validateCommandRouterResult({
      ...validRouterResult(),
      owner: "validation",
      canonicalCommand: ["opcore", "check", "manifest"],
      validationResult: validValidationResult(),
      validationStatus
    });
    assert.equal(validationRouted.validationResult.status, "passed");
    const receipt = validatePreWriteValidationReceipt(validPreWriteValidationReceipt());
    assert.equal(receipt.kind, "pre_write_validation");
    const preWriteRouted = validateCommandRouterResult({
      ...validRouterResult(),
      owner: "validation",
      canonicalCommand: ["opcore", "validate", "pre-write"],
      validationResult: validValidationResult(),
      receipt
    });
    assert.equal(preWriteRouted.receipt.ok, true);
    const editPlan = validEditPlan();
    assert.equal(validateEditPlanPayload(editPlan).planId, "edit-plan-1");
    assert.equal(validateEditCommandResult(validEditCommandResult()).planId, "edit-plan-1");
    assert.equal(validateEditCommandResult({
      ...validEditCommandResult(),
      validation: validValidationResult()
    }).validation.status, "passed");
    assert.throws(
      () =>
        validateEditCommandResult({
          ...validEditCommandResult(),
          validation: {
            ok: true,
            status: "policy_failure",
            diagnostics: []
          }
        }),
      /ok=true must use passed status/
    );
    const rollbackResult = validateEditCommandResult({
      ok: false,
      applied: false,
      refusal: {
        category: "conflict",
        message: "apply failed"
      },
      rollback: {
        completed: true,
        restoredPaths: ["src/index.ts"],
        failedPaths: [],
        cleanupFailedPaths: ["/tmp/.lattice-edit-temp"]
      }
    });
    assert.equal(rollbackResult.rollback.completed, true);
    const editRouted = validateCommandRouterResult({
      ...validRouterResult(),
      owner: "edit",
      canonicalCommand: ["opcore", "edit", "exact"],
      editPlan,
      editResult: validEditCommandResult()
    });
    assert.equal(editRouted.editPlan.changes[0].path, "src/index.ts");
    assert.throws(
      () =>
        validateCommandRouterResult({
          ...validRouterResult(),
          owner: "edit",
          canonicalCommand: ["opcore", "edit", "exact"],
          message: "{\"planId\":\"edit-plan-1\",\"changes\":[]}"
        }),
      /editPlan\/editResult/
    );
    assert.throws(
      () =>
        validateCommandAdapterRequest({
          ...request,
          canonicalCommand: ["opcore", "status"]
        }),
      /canonicalCommand must start/
    );
  });

  it("accepts graph reference evidence manifests and rejects invalid coverage", () => {
    const manifest = validGraphReferenceEvidenceManifest();
    assert.equal(validateGraphReferenceEvidenceManifest(manifest).issue, "#19");
    assert.deepEqual(surfaceContracts(manifest.optionalAnalysisSurfaces), expectedOptionalAnalysisSurfaces());
    assert.throws(
      () =>
        validateGraphReferenceEvidenceManifest({
          ...manifest,
          commandSurfaces: [
            {
              ...manifest.commandSurfaces[0],
              classification: "release_blocking"
            }
          ]
        }),
      /Unknown graph reference evidence surface classification/
    );
    assert.throws(
      () =>
        validateGraphReferenceEvidenceManifest({
          ...manifest,
          commandSurfaces: [
            {
              ...manifest.commandSurfaces[0],
              fixtures: []
            }
          ]
        }),
      /required surface must include fixture coverage/
    );
    assert.throws(
      () =>
        validateGraphReferenceEvidenceManifest({
          ...manifest,
          optionalAnalysisSurfaces: manifest.optionalAnalysisSurfaces.map((surface) =>
            surface.id === "flows" ? { ...surface, issue: "#13" } : surface
          )
        }),
      /optional analysis surfaces must match staged graph release surfaces/
    );
    assert.throws(
      () =>
        validateGraphReferenceEvidenceManifest({
          ...manifest,
          optionalAnalysisSurfaces: manifest.optionalAnalysisSurfaces.map((surface) =>
            surface.id === "flows" ? { ...surface, classification: "required" } : surface
          )
        }),
      /optional analysis surfaces must not mark staged graph release surfaces as required/
    );
    assert.throws(
      () =>
        validateGraphReferenceEvidenceManifest({
          ...manifest,
          provenance: {
            ...manifest.provenance,
            containsPythonCrgSource: true
          }
        }),
      /must not contain Python CRG source/
    );
  });

  it("accepts graph release receipts and rejects incomplete or tainted release evidence", () => {
    const receipt = validGraphReleaseReceipt();
    assert.equal(validateGraphReleaseReceipt(receipt).issue, "#17");
    assert.deepEqual(receipt.deferredChildren, graphReleaseDeferredChildren);
    assert.deepEqual(receipt.optionalSurfaces, expectedOptionalAnalysisSurfaces());
    assert.deepEqual(
      receipt.rustCommandCoverage.map((entry) => entry.id),
      graphReleaseRustCommandIds
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          issue: "#19"
        }),
      /Graph release receipt issue must be #17/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          rustCommandCoverage: receipt.rustCommandCoverage.filter((entry) => entry.id !== "opcore-graph-rust-impact")
        }),
      /Graph release Rust command coverage ids must exactly match/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          rustCommandCoverage: receipt.rustCommandCoverage.map((entry) =>
            entry.id === "opcore-graph-rust-query"
              ? { ...entry, command: ["graph", "search"], canonicalCommand: ["opcore", "graph", "search"] }
              : entry
          )
        }),
      /Graph release Rust command opcore-graph-rust-query route must match/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          benchmarks: receipt.benchmarks.slice(1)
        }),
      /Graph release benchmark metrics must exactly match/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          directSqliteQueries: receipt.directSqliteQueries.slice(1)
        }),
      /Graph release direct SQLite query ids must exactly match/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          serveTransport: receipt.serveTransport.filter((entry) => entry.id !== "serve-jsonl-query")
        }),
      /Graph release serve transport ids must exactly match/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          serveTransport: [
            receipt.serveTransport.find((entry) => entry.id === "serve-jsonl-ping"),
            ...receipt.serveTransport.filter((entry) => entry.id !== "serve-jsonl-shutdown")
          ]
        }),
      /Graph release serve transport ids must exactly match/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          serveTransport: receipt.serveTransport.map((entry) =>
            entry.id === "serve-jsonl-query" ? { ...entry, operation: "ping" } : entry
          )
        }),
      /Graph release serve transport serve-jsonl-query operation must be query/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          commandCoverage: receipt.commandCoverage.map((entry) =>
            entry.id === "opcore-graph-build"
              ? { ...entry, bin: "old-graph", command: ["graph", "build"], canonicalCommand: ["opcore", "graph", "build"] }
              : entry
          )
        }),
      /Unknown graph release command bin/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          benchmarks: receipt.benchmarks.map((entry) =>
            entry.metric === "db_size_bytes" ? { ...entry, unit: "ms" } : entry
          )
        }),
      /Graph release benchmark db_size_bytes must use bytes/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          optionalSurfaces: receipt.optionalSurfaces.map((surface) =>
            surface.id === "coverage" ? { ...surface, issue: "#14" } : surface
          )
        }),
      /Graph release optional surfaces must match staged graph release surfaces/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          optionalSurfaces: receipt.optionalSurfaces.map((surface) =>
            surface.id === "coverage" ? { ...surface, classification: "required" } : surface
          )
        }),
      /Graph release optional surfaces must not mark staged graph release surfaces as required/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          handoff: receipt.handoff.filter((entry) => entry.issue !== "#28")
        }),
      /Graph release handoff issues must exactly match/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          packageInspection: {
            ...receipt.packageInspection,
            fileCount: receipt.packageInspection.files.length + 1,
            files: [...receipt.packageInspection.files, "setup.py"]
          }
        }),
      /forbidden source provenance/
    );
    assert.throws(
      () =>
        validateGraphReleaseReceipt({
          ...receipt,
          packageInspection: {
            ...receipt.packageInspection,
            fileCount: receipt.packageInspection.files.length + 1
          }
        }),
      /fileCount must equal files length/
    );
  });

  it("accepts release receipts and rejects incomplete or tainted release proof", () => {
    const receipt = validReleaseReceipt();
    assert.equal(validateReleaseReceipt(receipt).issue, "#29");
    assert.deepEqual(receipt.packageNames, releaseReceiptPackageNames);
    assert.equal(receipt.packageNames.includes("@the-open-engine/opcore-validation-python"), true);
    assert.equal(receipt.packageNames.includes("@the-open-engine/opcore-fixtures"), true);
    assert.deepEqual(receipt.commandGroups, releaseReceiptCommandGroups);
    assert.deepEqual(receipt.reports.map((entry) => entry.id), releaseReceiptReportIds);
    assert.equal(receipt.packages.length, releaseReceiptPackageNames.length);
    assert.throws(
      () =>
        validateReleaseReceipt({
          ...receipt,
          packages: receipt.packages.filter((entry) => entry.packageName !== "@the-open-engine/opcore-edit")
        }),
      /Release receipt package evidence must exactly match/
    );
    assert.throws(
      () =>
        validateReleaseReceipt({
          ...receipt,
          descriptor: {
            ...receipt.descriptor,
            resolvedArtifacts: receipt.descriptor.resolvedArtifacts.map((entry) =>
              entry.id === "descriptor" ? { ...entry, path: "dist/descriptors/missing.json" } : entry
            )
          }
        }),
      /resolved artifact.*descriptor/
    );
    assert.throws(
      () =>
        validateReleaseReceipt({
          ...receipt,
          packages: receipt.packages.map((entry) =>
            entry.packageName === "@the-open-engine/opcore"
              ? {
                  ...entry,
                  bins: { ...entry.bins, crg: "dist/index.js" },
                  manifest: { ...entry.manifest, bins: { ...entry.manifest.bins, crg: "dist/index.js" } }
                }
              : entry
          )
        }),
      /old public bin/
    );
    assert.throws(
      () =>
        validateReleaseReceipt({
          ...receipt,
          nativeArtifacts: receipt.nativeArtifacts.map((entry) => ({ ...entry, binarySha256: "" }))
        }),
      /sha256|non-empty/
    );
    assert.throws(
      () =>
        validateReleaseReceipt({
          ...receipt,
          secretHistory: {
            ...receipt.secretHistory,
            findingCount: 1,
            findings: [
              {
                scope: "current-tree",
                kind: "openai_api_key",
                path: "src/secret.ts",
                line: 1,
                fingerprint: "sha256:secret",
                allowlisted: false
              }
            ]
          }
        }),
      /secret findings/
    );
  });

  it("accepts cutover receipts and rejects noncanonical or incomplete installed-artifact proof", () => {
    const receipt = validReleaseCutoverReceipt();
    assert.equal(validateReleaseCutoverReceipt(receipt).issue, "#30");
    assert.deepEqual(receipt.packageNames, releaseReceiptPackageNames);
    assert.deepEqual(
      receipt.commandReceipts.filter((entry) => entry.status === "not_implemented").map((entry) => entry.id),
      []
    );
    assert.deepEqual(
      receipt.rustCommandReceipts.map((entry) => entry.id),
      releaseCutoverRustCommandIds
    );
    assert.deepEqual(
      receipt.pythonCommandReceipts.map((entry) => entry.id),
      releaseCutoverPythonCommandIds
    );
    assert.deepEqual(
      receipt.negativeChecks.map((entry) => entry.id),
      releaseCutoverNegativeCheckIds
    );
    assert.deepEqual(
      receipt.currentToolGuardrails.map((entry) => entry.id),
      releaseCutoverCurrentToolGuardrailIds
    );
    assert.equal(receipt.oldToolReplacementClaimed, false);
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          issue: "#29"
        }),
      /issue must be #30/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          installedPackages: receipt.installedPackages.filter((entry) => entry.packageName !== "@the-open-engine/opcore-edit")
        }),
      /portable installed package evidence/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          installedPackages: receipt.installedPackages.map((entry) =>
            entry.packageName === "@the-open-engine/opcore-asp-provider"
              ? {
                  ...entry,
                  installedFiles: entry.installedFiles.filter(
                    (file) => file.path !== "node_modules/@the-open-engine/opcore-asp-provider/dist/manifests/asp-server.json"
                  )
                }
              : entry
          )
        }),
      /canonical asp-server\.json/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          commandReceipts: [
            {
              ...receipt.commandReceipts[0],
              command: ["node", "scripts/current-tool.js"],
              canonicalCommand: ["node", "scripts/current-tool.js"]
            },
            ...receipt.commandReceipts.slice(1)
          ]
        }),
      /canonical .* bin/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          commandReceipts: [
            {
              ...receipt.commandReceipts[0],
              status: "not_implemented",
              exitCode: 2
            },
            ...receipt.commandReceipts.slice(1)
          ]
        }),
      /must not be not_implemented/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          rustCommandReceipts: receipt.rustCommandReceipts.filter((entry) => entry.id !== "graph-rust-impact")
        }),
      /Rust command receipts/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          pythonCommandReceipts: receipt.pythonCommandReceipts.filter((entry) => entry.id !== "graph-python-query")
        }),
      /Python command receipts/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          rustCommandReceipts: receipt.rustCommandReceipts.map((entry) =>
            entry.id === "graph-rust-query"
              ? { ...entry, command: ["opcore", "graph", "status"], canonicalCommand: ["opcore", "graph", "status"] }
              : entry
          )
        }),
      /graph-rust-query.*expected/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          pythonCommandReceipts: receipt.pythonCommandReceipts.map((entry) =>
            entry.id === "graph-python-search"
              ? { ...entry, command: ["lattice", "graph", "search", "Greeting"], canonicalCommand: ["lattice", "graph", "search", "Greeting"] }
              : entry
          )
        }),
      /graph-python-search.*canonical opcore bin/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          pythonCommandReceipts: receipt.pythonCommandReceipts.map((entry) =>
            entry.id === "graph-python-query"
              ? { ...entry, evidence: entry.evidence.filter((evidence) => evidence !== "build_name") }
              : entry
          )
        }),
      /graph-python-query evidence/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          commandReceipts: receipt.commandReceipts.map((entry) =>
            entry.id === "validate-pre-write-fail"
              ? {
                  ...entry,
                  command: ["opcore", "status"],
                  canonicalCommand: ["opcore", "status"],
                  owner: "runtime",
                  status: "ok",
                  exitCode: 0
                }
              : entry
          )
        }),
      /validate-pre-write-fail.*expected/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          negativeChecks: receipt.negativeChecks.filter((entry) => entry.id !== "python-types-degraded-no-tools")
        }),
      /negative checks/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          negativeChecks: receipt.negativeChecks.map((entry) =>
            entry.id === "missing-required-graph-check"
              ? { ...entry, command: ["lattice", "check", "files", "src/index.ts", "--graph-mode", "required"] }
              : entry
          )
        }),
      /missing-required-graph-check command/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          currentToolGuardrails: receipt.currentToolGuardrails.filter((entry) => entry.id !== "current-tools-validate-changed")
        }),
      /current-tool guardrails/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          currentToolGuardrails: receipt.currentToolGuardrails.map((entry) =>
            entry.id === "current-tools-validate-changed"
              ? { ...entry, status: "retained-not-run", exitCode: null }
              : entry
          )
        }),
      /status must be passed/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          environmentIsolation: {
            ...receipt.environmentIsolation,
            oldBinsAbsent: { crg: true, cix: true, rox: true }
          }
        }),
      /old public bins/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          oldToolReplacementClaimed: true
        }),
      /old-tool replacement/
    );
    assert.throws(
      () =>
        validateReleaseCutoverReceipt({
          ...receipt,
          inputEvidence: receipt.inputEvidence.filter((entry) => entry.issue !== "#58")
        }),
      /input evidence issues/
    );
  });

  it("accepts old-Rox comparison receipts and rejects replacement overclaims", () => {
    const receipt = validRustOldRoxComparisonReceipt();
    assert.equal(validateRustOldRoxComparisonReceipt(receipt).oldToolReplacementClaimed, false);
    assert.deepEqual(
      receipt.surfaces.map((entry) => entry.id),
      rustOldRoxComparisonSurfaceIds
    );
    assert.equal(receipt.surfaces.every((entry) => ["retained", "deferred"].includes(entry.replacementStatus)), true);
    assert.throws(
      () =>
        validateRustOldRoxComparisonReceipt({
          ...receipt,
          surfaces: receipt.surfaces.filter((entry) => entry.id !== "rust.dead-code")
        }),
      /old-Rox comparison surfaces/
    );
    assert.throws(
      () =>
        validateRustOldRoxComparisonReceipt({
          ...receipt,
          oldToolReplacementClaimed: true
        }),
      /must not claim old-tool replacement/
    );
    assert.throws(
      () =>
        validateRustOldRoxComparisonReceipt({
          ...receipt,
          publicReleaseActions: ["publish"]
        }),
      /public release actions/
    );
    assert.throws(
      () =>
        validateRustOldRoxComparisonReceipt({
          ...receipt,
          surfaces: receipt.surfaces.map((entry) =>
            entry.id === "rust.function-metrics" ? { ...entry, replacementStatus: "replaced" } : entry
          )
        }),
      /replacementStatus/
    );
    assert.throws(
      () =>
        validateRustOldRoxComparisonReceipt({
          ...receipt,
          surfaces: receipt.surfaces.map((entry) =>
            entry.id === "rust.import-graph" ? { ...entry, graphEvidenceExists: true, graphEvidence: [] } : entry
          )
        }),
      /graph evidence/
    );
    const artifact = JSON.parse(
      readFileSync(new URL("../docs/validation/rust-old-rox-comparison-receipt-2026-06-27.json", import.meta.url), "utf8")
    );
    assert.equal(validateRustOldRoxComparisonReceipt(artifact).oldToolReplacementClaimed, false);
    assert.deepEqual(
      artifact.surfaces.map((entry) => entry.id),
      rustOldRoxComparisonSurfaceIds
    );
  });

  it("accepts ASP dogfood receipts and rejects authority, entrypoint, parity, and guardrail overclaims", () => {
    const receipt = validAspDogfoodReceipt();
    assert.equal(validateAspDogfoodReceipt(receipt).issue, "#120");
    assert.equal(receipt.bootstrapSource, "local-sibling");
    assert.deepEqual(receipt.provider.command, ["opcore-asp-provider", "--stdio"]);
    assert.equal(receipt.hostFixture.sourceRepoMutated, false);
    assert.deepEqual(receipt.hostFixture.changedPaths, ["src/dogfood.ts"]);
    assert.deepEqual(receipt.currentToolGuardrails.map((entry) => entry.id), aspDogfoodGuardrailIds);
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          currentToolGuardrails: receipt.currentToolGuardrails.filter((entry) => entry.id !== "current-tools-validate-rust-graph")
        }),
      /guardrail ids/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          provider: {
            ...receipt.provider,
            command: ["opcore", "asp", "serve"],
            entrypoint: { transport: "stdio", bin: "opcore", args: ["asp", "serve"] }
          }
        }),
      /provider command|entrypoint/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          provider: {
            ...receipt.provider,
            binPath: ".ace/runtime/bin/opcore-asp-provider"
          }
        }),
      /node_modules\/\.bin\/opcore-asp-provider|forbidden marker/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          hostEvaluation: {
            ...receipt.hostEvaluation,
            check: {
              ...receipt.hostEvaluation.check,
              receipt: { ...receipt.hostEvaluation.check.receipt, authorityEvidence: [] }
            }
          }
        }),
      /authorityEvidence/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          hostFixture: { ...receipt.hostFixture, changedPaths: [] }
        }),
      /changedPaths/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          hostFixture: { ...receipt.hostFixture, sourceRepoMutated: true }
        }),
      /source repo/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          providerProbe: {
            ...receipt.providerProbe,
            assessment: { ...receipt.providerProbe.assessment, decision: "allow" },
            hostOwnedFieldLeak: true
          }
        }),
      /host-owned field|host-owned decision|hostOwnedFieldLeak/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          unsupportedSurfaces: receipt.unsupportedSurfaces.map((entry) =>
            entry.surface === "inspect" ? { ...entry, cleanCoverage: true } : entry
          )
        }),
      /clean coverage/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          authority: {
            ...receipt.authority,
            localAuthorityOverride: { present: true, sharedAuthorityWeakened: true }
          }
        }),
      /weaken shared authority/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          publicReleaseActions: [{ action: "publish" }]
        }),
      /public publish/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          managerState: {
            ...receipt.managerState,
            serverAdd: { ...receipt.managerState.serverAdd, status: "failed", exitCode: 1 }
          }
        }),
      /manager server add status must be passed/
    );
    assert.throws(
      () =>
        validateAspDogfoodReceipt({
          ...receipt,
          hostEvaluation: {
            ...receipt.hostEvaluation,
            check: { ...receipt.hostEvaluation.check, status: "failed", exitCode: 1 }
          }
        }),
      /host check status must be passed/
    );
    assert.equal(
      validateAspDogfoodReceipt({
        ...receipt,
        hostEvaluation: {
          ...receipt.hostEvaluation,
          ciVerify: { ...receipt.hostEvaluation.ciVerify, status: "failed", exitCode: 1 }
        }
      }).issue,
      "#120"
    );
  });

  it("rejects invalid command-router ownership, status, and canonical commands", () => {
    assert.throws(
      () =>
        validateCommandRouterManifest({
          ...validRouterManifest(),
          commandGroups: [
            {
              name: "graph",
              owner: "engine",
              canonicalCommand: ["opcore", "graph"],
              commands: ["status"],
              summary: "invalid"
            }
          ]
        }),
      /Unknown command owner/
    );
    assert.throws(
      () =>
        validateCommandRouterResult({
          ...validRouterResult(),
          status: "missing"
        }),
      /Unknown command route status/
    );
    assert.throws(
      () =>
        validateCommandRouterResult({
          ...validRouterResult(),
          canonicalCommand: []
        }),
      /canonicalCommand must not be empty/
    );
  });

  it("does not publish old removed type names", () => {
    const declarations = readFileSync(new URL("../packages/contracts/dist/index.d.ts", import.meta.url), "utf8");
    assert.doesNotMatch(
      declarations,
      /\bLattice(GraphMode|GraphStatusState|GraphProviderStatus|ValidatorRequest|ValidatorResult|ManagedToolDescriptor)\b/
    );
  });
});

function validRouterManifest() {
  return {
    schemaVersion: 1,
    packageName: "@the-open-engine/opcore",
    bins: ["opcore"],
    exitSemantics: {
      ok: 0,
      error: 1,
      notImplemented: 2,
      unsupported: 64,
      jsonStable: true
    },
    ownershipBoundaries: [
      {
        owner: "graph",
        summary: "graph owns facts"
      }
    ],
    commandGroups: [
      {
        name: "graph",
        owner: "graph",
        canonicalCommand: ["opcore", "graph"],
        commands: ["status"],
        summary: "graph routes"
      }
    ]
  };
}

function validOpcoreRepoState() {
  return {
    schemaVersion: 1,
    repo: {
      root: "/repo",
      requestedPath: "/repo",
      git: {
        available: true,
        branch: "main",
        changed: 1,
        staged: 0,
        unstaged: 0,
        untracked: 1,
        conflicted: 0,
        clean: false
      }
    },
    coverage: {
      totalFiles: 2,
      languages: [
        {
          language: "TypeScript",
          files: 1,
          graphSupported: true,
          validationSupported: true
        }
      ],
      graph: {
        supportedFiles: 1,
        extensions: [{ extension: ".ts", count: 1 }]
      },
      validation: {
        supportedFiles: 1,
        retainedFiles: 0,
        extensions: [{ extension: ".ts", count: 1 }]
      },
      unsupported: {
        totalFiles: 1,
        stacks: [{ extension: ".py", language: "Python", count: 1, examples: ["scripts/a.py"] }]
      }
    },
    graph: {
      state: "available",
      mode: "required",
      provider: "opcore-graph",
      action: "Graph is ready.",
      status: availableGraphStatus()
    },
    validation: {
      ready: true,
      checkCount: 15,
      adapters: [
        {
          adapter: "rust",
          status: "available",
          checkCount: 10,
          degradedChecks: [],
          missingTools: []
        }
      ],
      degradedToolchains: []
    },
    activation: {
      ready: false,
      level: "degraded",
      summary: "Graph available with unsupported stacks.",
      asp: {
        state: "not_enrolled",
        paths: []
      }
    },
    warnings: ["Unsupported stacks: Python"],
    blockers: [],
    nextActions: ["opcore check changed --repo /repo --json"]
  };
}

function validCommandTiming(overrides = {}) {
  return {
    durationMs: 42,
    phases: [
      {
        phase: "validation",
        durationMs: 35,
        fileCount: 2
      }
    ],
    processState: "warm",
    degradations: ["no_paths"],
    ...overrides
  };
}

function validRepoShapeFingerprint(overrides = {}) {
  return {
    totalFiles: 3,
    languages: [
      {
        language: "TypeScript",
        files: 2
      },
      {
        language: "Python",
        files: 1
      }
    ],
    graph: {
      supportedFiles: 2,
      unsupportedFiles: 1
    },
    git: {
      available: true,
      clean: false
    },
    ...overrides
  };
}

function validCommandLatencyRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    recordedAt: "2026-06-26T17:00:00.000Z",
    bin: "opcore",
    canonicalCommand: ["opcore", "check", "changed"],
    owner: "validation",
    status: "ok",
    exitCode: 0,
    repo: validRepoShapeFingerprint(),
    timing: validCommandTiming(),
    opcoreVersion: "0.1.0-alpha.0",
    ...overrides
  };
}

function validLatencyBudget(overrides = {}) {
  return {
    schemaVersion: 1,
    canonicalCommand: ["opcore", "check", "changed"],
    scope: "changed",
    repoShapeBucket: "small_ts",
    budgetMs: 100,
    phaseBudgets: [
      {
        phase: "validation",
        budgetMs: 75
      }
    ],
    ...overrides
  };
}

function validLatencyBudgetResult(overrides = {}) {
  const status = overrides.status ?? "pass";
  const observedMs = status === "over" ? 125 : 42;
  return {
    schemaVersion: 1,
    status,
    budget: validLatencyBudget(),
    observed: {
      canonicalCommand: ["opcore", "check", "changed"],
      phase: "total",
      durationMs: observedMs
    },
    evidence: {
      canonicalCommand: ["opcore", "check", "changed"],
      phase: "total",
      repoShapeBucket: "small_ts",
      observedMs,
      budgetMs: 100,
      overByMs: Math.max(0, observedMs - 100)
    },
    ...overrides
  };
}

function validOpcoreInitPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: "plan",
    approved: false,
    repo: {
      root: "/repo",
      requestedPath: "/repo"
    },
    options: {
      failClosedHook: false,
      dryRun: false
    },
    agentFiles: ["AGENTS.md"],
    actions: [
      {
        kind: "write",
        path: ".opcore/config",
        summary: "Write additive Opcore init config.",
        requiresApproval: false,
        outsideOpcore: false
      },
      {
        kind: "upsert_block",
        path: "AGENTS.md",
        summary: "Add or update delimited Opcore agent guidance.",
        requiresApproval: true,
        outsideOpcore: true
      }
    ],
    warnings: ["Unsupported stacks must be treated honestly."],
    nextActions: ["Run opcore init --approve to apply this plan."],
    undoAvailable: false,
    scan: {
      totalFiles: 2,
      graphSupportedFiles: 1,
      validationSupportedFiles: 1,
      validationRetainedFiles: 0,
      unsupportedFiles: 1,
      languages: validOpcoreRepoState().coverage.languages,
      unsupportedStacks: validOpcoreRepoState().coverage.unsupported.stacks,
      degradedRustTools: [],
      diagnosticCount: 0,
      validationStatus: "passed",
      failedChecks: [],
      graphState: "available",
      activationLevel: "degraded"
    },
    settings: {
      languages: [
        {
          language: "TypeScript",
          files: 1,
          state: "supported",
          graph: "supported",
          validation: "supported",
          checks: ["typescript.syntax", "typescript.types"],
          notes: []
        },
        {
          language: "Python",
          files: 1,
          state: "unsupported",
          graph: "unsupported",
          validation: "unsupported",
          checks: [],
          notes: ["Unsupported stack counted without fabricated checks."]
        }
      ]
    },
    interaction: {
      tty: false,
      promptState: "not_requested"
    },
    timings: {
      scanMs: 2,
      planMs: 1,
      promptMs: 0,
      applyMs: 0,
      totalMs: 3,
      firstOutputMs: 2
    },
    ...overrides
  };
}

function validOpcoreMetricReport(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "opcore_metric_report",
    generatedAt: "2026-06-25T00:00:00.000Z",
    repo: {
      root: "/repo",
      requestedPath: "/repo",
      git: validOpcoreRepoState().repo.git
    },
    coverage: validOpcoreRepoState().coverage,
    graph: {
      state: "available",
      mode: "required",
      provider: "opcore-graph"
    },
    validation: {
      status: "policy_failure",
      diagnosticCount: 2,
      checkCount: 15
    },
    signals: [
      {
        id: "typescript.type_errors",
        title: "TS/JS type errors",
        category: "typescript",
        severity: "error",
        count: 2,
        evidence: [
          {
            source: "validation_diagnostic",
            path: "src/index.ts",
            message: "Type mismatch",
            checkId: "typescript.types",
            code: "TS2322"
          }
        ]
      }
    ],
    degradations: [
      {
        id: "rust.tool.cargo.unavailable",
        title: "Rust tool unavailable: cargo",
        source: "opcore_status",
        severity: "warning",
        message: "cargo unavailable",
        requiredTool: "cargo"
      }
    ],
    warnings: ["Unsupported stacks: Python"],
    nextActions: ["Inspect TS/JS type errors: src/index.ts"],
    ...overrides
  };
}

function validOpcoreMeasureDelta(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "opcore_measure_delta",
    generatedAt: "2026-06-25T00:00:02.000Z",
    current: {
      generatedAt: "2026-06-25T00:00:00.000Z",
      coverage: validOpcoreRepoState().coverage,
      signals: [
        {
          id: "typescript.type_errors",
          title: "TS/JS type errors",
          count: 2
        }
      ]
    },
    latency: {
      kind: "opcore_latency_report",
      recordCount: 3,
      budgetCount: 1,
      findings: [
        {
          canonicalCommand: ["opcore", "check", "changed"],
          repoShapeBucket: "small",
          processState: "warm",
          status: "over_budget",
          currentDurationMs: 900,
          dominantPhase: {
            phase: "validation",
            durationMs: 700
          },
          baselineDurationMs: 500,
          previousDurationMs: 600,
          baselineDeltaMs: 400,
          previousDeltaMs: 300,
          budgetMs: 800,
          overBudgetMs: 100
        }
      ]
    },
    baseline: {
      recordedAt: "2026-06-24T00:00:00.000Z",
      generatedAt: "2026-06-24T00:00:00.000Z",
      coverage: validOpcoreRepoState().coverage,
      signals: [
        {
          id: "typescript.type_errors",
          title: "TS/JS type errors",
          count: 3
        }
      ],
      deltas: [
        {
          id: "typescript.type_errors",
          title: "TS/JS type errors",
          currentCount: 2,
          comparisonCount: 3,
          delta: -1
        }
      ]
    },
    warnings: ["Unsupported stacks: Python"],
    degradations: [],
    nextActions: ["Inspect TS/JS type errors: src/index.ts"],
    ...overrides
  };
}

function validOpcoreTryPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    sampleRoot: "/tmp/opcore-try-fixture",
    published: false,
    scenarios: [
      {
        id: "typescript-app",
        repoRoot: "/tmp/opcore-try-fixture/typescript-app",
        title: "TypeScript app with a seeded type finding",
        commands: ["opcore --repo /tmp/opcore-try-fixture/typescript-app"],
        coverage: {
          totalFiles: 2,
          validationSupportedFiles: 1,
          unsupportedFiles: 0
        },
        signals: [
          {
            id: "typescript.type_errors",
            title: "TS/JS type errors",
            count: 1,
            delta: 0
          }
        ]
      }
    ],
    commands: [
      {
        scenarioId: "typescript-app",
        command: ["opcore", "try"],
        canonicalCommand: ["opcore", "try"],
        owner: "runtime",
        status: "ok",
        exitCode: 0
      }
    ],
    ...overrides
  };
}

function validManagedToolDescriptor(overrides = {}) {
  const nativeArtifacts = descriptorNativeArtifacts();
  return {
    schemaVersion: 1,
    descriptorKind: "aggregate_opcore",
    aggregateIdentity: {
      name: "opcore",
      releaseLine: "opcore",
      packageName: "@the-open-engine/opcore"
    },
    packageIdentity: {
      packageName: "@the-open-engine/opcore",
      artifactName: "@the-open-engine/opcore",
      version: "0.1.0-alpha.0"
    },
    entrypoints: [
      {
        bin: "opcore",
        packageName: "@the-open-engine/opcore",
        path: "dist/index.js",
        command: ["opcore"]
      }
    ],
    commandGroups: [
      ["graph", ["build", "update", "watch", "status", "query", "serve", "impact", "review-context", "detect-changes", "search"]],
      ["inspect", ["symbols", "definition", "references", "signature", "implementations", "search"]],
      ["edit", ["exact", "multi", "search-replace", "check", "apply", "patch", "tree", "rename", "move", "signature"]],
      ["check", ["files", "staged", "changed", "tree", "all", "manifest"]],
      ["validate", ["request", "hypothetical", "pre-write", "manifest"]],
      ["status", ["status"]],
      ["doctor", ["doctor"]]
    ].map(([name, commands]) => ({
      name,
      canonicalCommand: ["opcore", name],
      commands,
      packageName:
        name === "graph"
          ? "@the-open-engine/opcore-graph"
          : name === "edit"
            ? "@the-open-engine/opcore-edit"
            : name === "check" || name === "validate"
              ? "@the-open-engine/opcore-validation"
              : "@the-open-engine/opcore"
    })),
    healthProbes: [
      {
        id: "status-json",
        command: ["opcore", "status", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "doctor-json",
        command: ["opcore", "doctor", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "graph-status-json",
        command: ["opcore", "graph", "status", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "check-manifest-json",
        command: ["opcore", "check", "manifest", "--json"],
        expectedExitCode: 0,
        output: "json"
      }
    ],
    capabilities: {
      graph: {
        provider: "opcore-graph",
        schemaVersion: 1,
        commands: ["build", "update", "watch", "status", "query", "impact", "review-context", "detect-changes", "search", "serve"],
        queryKinds: ["nodes", "edges", "neighbors", "symbols", "impact", "review_context", "detect_changes", "search"],
        daemonOperations: ["ping", "status", "query", "search", "shutdown"],
        nativeArtifacts
      },
      edit: {
        commands: ["exact", "multi", "search-replace", "patch", "tree", "rename", "move", "signature", "check", "apply"],
        safeEditModes: ["exact", "multi", "search-replace", "patch", "tree"],
        symbolEditModes: ["rename", "move", "signature"],
        validationRequiredForApply: true,
        dryRun: true
      },
      validation: {
        checkRoutes: ["files", "staged", "changed", "tree", "all", "manifest"],
        validateRoutes: ["request", "hypothetical", "pre-write", "manifest"],
        scopeModes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
        graphModes: ["optional", "required"],
        hypothetical: true,
        statusSurfaces: ["status", "doctor"],
        checkIds: [
          "typescript.syntax",
          "typescript.types",
          "typescript.import-graph",
          "typescript.dead-code",
          "typescript.relevant-tests"
        ]
      }
    },
    artifacts: [
      {
        id: "cli-entrypoint",
        packageName: "@the-open-engine/opcore",
        path: "dist/index.js",
        type: "entrypoint",
        required: true
      },
      {
        id: "descriptor",
        packageName: "@the-open-engine/opcore",
        path: "dist/descriptors/opcore.managed-tool.json",
        type: "descriptor",
        required: true
      },
      {
        id: "contracts-schema",
        packageName: "@the-open-engine/opcore-contracts",
        path: "schemas/opcore-contracts.schema.json",
        type: "schema",
        required: true
      },
      ...descriptorNativeArtifactReferences(nativeArtifacts)
    ],
    checksums: descriptorNativeChecksumReferences(nativeArtifacts),
    provenanceHooks: [
      {
        id: "pack-check",
        command: ["npm", "run", "pack:check"],
        expectedExitCode: 0
      },
      {
        id: "provenance-check",
        command: ["npm", "run", "provenance:check"],
        expectedExitCode: 0
      }
    ],
    optionalSurfaces: expectedOptionalAnalysisSurfaces(),
    ...overrides
  };
}

function descriptorNativeArtifacts() {
  return graphCoreNativeSupportedTargets.map((targetPlatform) => ({
    targetPlatform,
    packageName: graphCoreNativePackageNameForTarget(targetPlatform),
    binaryPath: "opcore-graph-core",
    metadataPath: "metadata.json",
    checksumPath: "opcore-graph-core.sha256",
    artifactIds: {
      binaryArtifactId: `graph-core-binary-${targetPlatform}`,
      metadataArtifactId: `graph-core-metadata-${targetPlatform}`,
      checksumArtifactId: `graph-core-checksum-${targetPlatform}`,
      checksumId: `graph-core-binary-sha256-${targetPlatform}`
    }
  }));
}

function descriptorNativeArtifactReferences(nativeArtifacts = descriptorNativeArtifacts()) {
  return nativeArtifacts.flatMap((artifact) => [
    {
      id: artifact.artifactIds.binaryArtifactId,
      packageName: artifact.packageName,
      path: artifact.binaryPath,
      type: "native_binary",
      required: true,
      checksumRef: artifact.artifactIds.checksumId
    },
    {
      id: artifact.artifactIds.metadataArtifactId,
      packageName: artifact.packageName,
      path: artifact.metadataPath,
      type: "manifest",
      required: true
    },
    {
      id: artifact.artifactIds.checksumArtifactId,
      packageName: artifact.packageName,
      path: artifact.checksumPath,
      type: "checksum",
      required: true
    }
  ]);
}

function descriptorNativeChecksumReferences(nativeArtifacts = descriptorNativeArtifacts()) {
  return nativeArtifacts.map((artifact) => ({
    id: artifact.artifactIds.checksumId,
    packageName: artifact.packageName,
    path: artifact.checksumPath,
    algorithm: "sha256",
    artifactRef: artifact.artifactIds.binaryArtifactId,
    required: true
  }));
}

function expectedOptionalAnalysisSurfaces() {
  return [
    {
      issue: "#13",
      id: "coverage",
      classification: "deferred",
      status: "deferred"
    },
    {
      issue: "#14",
      id: "flows",
      classification: "optional",
      status: "deferred"
    },
    {
      issue: "#15",
      id: "communities",
      classification: "optional",
      status: "deferred"
    },
    {
      issue: "#16",
      id: "read_only_suggestions",
      classification: "supporting",
      status: "deferred"
    }
  ];
}

function surfaceContracts(surfaces) {
  return surfaces.map(({ issue, id, classification, status }) => ({ issue, id, classification, status }));
}

function validArtifactMetadata() {
  return {
    artifactName: "opcore-graph-core",
    artifactVersion: "0.1.0-alpha.0",
    targetPlatform: "test",
    binaryPath: "dist/native/test/opcore-graph-core",
    checksumPath: "dist/native/test/opcore-graph-core.sha256",
    checksumSha256: "a".repeat(64),
    buildProfile: "release"
  };
}

function validHandshake() {
  return {
    provider: "opcore-graph",
    graphSchemaVersion: 1,
    artifactName: "opcore-graph-core",
    artifactVersion: "0.1.0-alpha.0",
    targetPlatform: "test",
    supportedOperations: ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"],
    nodeKinds: [
      "repo",
      "package",
      "file",
      "symbol",
      "test",
      "File",
      "Module",
      "Class",
      "Function",
      "Variable",
      "Type",
      "Test",
      "Struct",
      "Enum",
      "Trait",
      "Impl",
      "Method",
      "TypeAlias",
      "Const",
      "Static",
      "Macro"
    ],
    edgeKinds: [
      "CONTAINS",
      "DECLARES",
      "IMPORTS_FROM",
      "CALLS",
      "TESTED_BY",
      "INHERITS",
      "IMPLEMENTS",
      "DEPENDS_ON"
    ],
    queryKinds: [
      "nodes",
      "edges",
      "neighbors",
      "symbols",
      "impact",
      "callers_of",
      "callees_of",
      "importers_of",
      "imports_of",
      "tests_for",
      "inheritors_of",
      "children_of",
      "file_summary",
      "review_context",
      "detect_changes",
      "search"
    ],
    artifact: validArtifactMetadata()
  };
}

function validValidationRequest(overrides = {}) {
  return {
    requestId: "validation-1",
    repo: {
      repoId: "opcore"
    },
    scope: {
      kind: "files",
      files: ["src/index.ts"]
    },
    graph: {
      mode: "required",
      provider: "opcore-graph"
    },
    overlays: [],
    checks: ["types"],
    ...overrides
  };
}

function validValidationResult(overrides = {}) {
  const status = overrides.status ?? "passed";
  return {
    ok: status === "passed",
    status,
    diagnostics: [],
    ...overrides
  };
}

function validValidationStatusPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    ready: true,
    generatedAt: "2026-06-05T00:00:00.000Z",
    adapterRegistry: {
      checkRoutes: ["files", "staged", "changed", "tree", "all", "manifest"],
      validateRoutes: ["request", "hypothetical", "pre-write", "manifest"],
      checkIds: ["typescript.syntax"],
      entries: [
        {
          checkId: "typescript.syntax",
          owner: "validation",
          adapter: "typescript",
          defaultSeverity: "error",
          supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
          requiresGraph: false
        }
      ],
      adapters: [
        {
          adapter: "rust",
          status: "degraded",
          checkIds: ["rust.source-hygiene", "rust.unused-deps"],
          tempWorkspaceRequired: true,
          toolchain: [
            {
              tool: "cargo",
              available: true,
              command: "cargo --version",
              version: "cargo 1.0.0"
            },
            {
              tool: "cargo-udeps",
              available: false,
              command: "cargo-udeps --version",
              failureMessage: "cargo-udeps is unavailable"
            }
          ],
          degradedChecks: [
            {
              checkId: "rust.unused-deps",
              status: "unsupported_request",
              reason: "required_tool_unavailable",
              message: "cargo-udeps is unavailable",
              requiredTool: "cargo-udeps",
              retainedCompatibility: true,
              followUpIssue: "#21",
              currentUsage: retainedRustUsage()
            }
          ]
        }
      ]
    },
    graph: {
      mode: "required",
      status: availableGraphStatus()
    },
    daemon: {
      state: "not_configured"
    },
    ...overrides
  };
}

function retainedRustUsage() {
  return {
    opcore: false,
    orchestra: true,
    covibes: false,
    gateway: true
  };
}

function validPreWriteValidationReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pre_write_validation",
    route: "validate.pre-write",
    canonicalCommand: ["opcore", "validate", "pre-write", "--request-file", "request.json", "--timeout-ms", "30000"],
    generatedAt: "2026-06-05T00:00:00.000Z",
    durationMs: 12,
    timeoutMs: 30000,
    ok: true,
    requestId: "validation-1",
    repo: {
      repoId: "opcore"
    },
    scope: {
      kind: "files",
      files: ["src/index.ts"]
    },
    checks: ["typescript.syntax"],
    graph: {
      mode: "required",
      provider: "opcore-graph",
      status: availableGraphStatus()
    },
    overlays: {
      count: 1,
      writeCount: 1,
      deleteCount: 0,
      paths: ["src/index.ts"]
    },
    validationStatus: "passed",
    diagnosticCount: 0,
    ...overrides
  };
}

function availableGraphStatus() {
  return {
    state: "available",
    mode: "required",
    provider: "opcore-graph",
    schemaVersion: 1,
    repo: {
      repoId: "opcore"
    },
    freshness: {
      generatedAt: "2026-06-05T00:00:00.000Z",
      ageMs: 0,
      stale: false
    },
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function validWalCheckpoint() {
  return {
    walPath: ".lattice/graph/graph.db-wal",
    bytesBefore: 8192,
    bytesAfter: 0,
    budgetBytes: 1,
    checkpointed: true
  };
}

function providerFailureStatus(state, mode, category) {
  const status = {
    state,
    mode,
    provider: "opcore-graph",
    schemaVersion: 1,
    failure: {
      category,
      message: `${state} failure`
    }
  };
  if (state === "stale") {
    status.repo = {
      repoId: "opcore"
    };
    status.freshness = {
      generatedAt: "2026-06-04T00:00:00.000Z",
      ageMs: 10,
      stale: true
    };
  }
  if (state === "schema_mismatch") {
    status.expectedSchemaVersion = 1;
    status.actualSchemaVersion = 2;
  }
  return status;
}

function validGraphFactQueryRequest() {
  return {
    requestId: "query-1",
    repo: {
      repoId: "opcore"
    },
    schemaVersion: 1,
    mode: "required",
    selector: {
      kind: "nodes",
      nodeKinds: ["repo"],
      limit: 1
    }
  };
}

function validGraphSearchRequest() {
  return {
    requestId: "search-1",
    repo: {
      repoId: "opcore"
    },
    schemaVersion: 1,
    mode: "required",
    query: "Greeting",
    limit: 5,
    files: ["src/components/GreetingCard.tsx"]
  };
}

function validGraphSearchResult() {
  return {
    requestId: "search-1",
    status: {
      state: "available",
      mode: "required",
      provider: "opcore-graph",
      schemaVersion: 1,
      repo: {
        repoId: "opcore"
      },
      freshness: {
        generatedAt: "2026-06-04T00:00:00.000Z",
        ageMs: 0,
        stale: false
      },
      nodes_by_kind: {},
      edges_by_kind: {}
    },
    metadata: {
      schemaVersion: 1,
      provider: "opcore-graph",
      repo: {
        repoId: "opcore"
      },
      generatedAt: "2026-06-04T00:00:00.000Z",
      freshness: {
        generatedAt: "2026-06-04T00:00:00.000Z",
        ageMs: 0,
        stale: false
      },
      nodeKinds: ["File", "Function"],
      edgeKinds: ["CONTAINS"]
    },
    query: "Greeting",
    searchMode: {
      engine: "fts5",
      querySyntax: "fts5",
      limit: 5,
      contextFiles: ["src/components/GreetingCard.tsx"]
    },
    summary: {
      query: "Greeting",
      total: 1,
      returned: 1,
      limit: 5,
      indexedNodeKinds: ["Function"],
      contextFiles: ["src/components/GreetingCard.tsx"]
    },
    results: [
      {
        nodeId: "function:src/components/GreetingCard.tsx#GreetingCard",
        kind: "Function",
        path: "src/components/GreetingCard.tsx",
        name: "GreetingCard",
        qualifiedName: "function:src/components/GreetingCard.tsx#GreetingCard",
        filePath: "src/components/GreetingCard.tsx",
        signature: "function Greeting Card in src/components/GreetingCard.tsx",
        score: 10,
        rank: 1,
        matches: ["name", "signature"]
      }
    ],
    hints: ["context_file_boost"],
    diagnostics: []
  };
}

function validGraphServeTransportStatus() {
  return {
    schemaVersion: 1,
    protocol: "opcore.graph.daemon",
    transport: "stdio",
    state: "ready",
    repo: {
      repoId: "opcore"
    },
    provider: "opcore-graph",
    pid: 1234,
    artifact: validArtifactMetadata(),
    message: "graph serve stdio transport ready"
  };
}

function validWarmingStatus() {
  return {
    state: "warming",
    mode: "required",
    provider: "opcore-graph",
    schemaVersion: 1,
    repo: {
      repoId: "opcore"
    },
    freshness: {
      generatedAt: "2026-06-04T00:00:00.000Z",
      ageMs: 0,
      stale: true,
      reason: "graph watch daemon warming"
    }
  };
}

function validEditPlan() {
  return {
    planId: "edit-plan-1",
    repo: {
      repoId: "opcore"
    },
    changes: [
      {
        kind: "replace",
        path: "src/index.ts",
        content: "export const value = 2;\n",
        checksumBefore: "sha256:before",
        checksumAfter: "sha256:after"
      }
    ],
    atomic: {
      strategy: "all_or_nothing",
      planHash: "sha256:plan"
    },
    validation: {
      required: true,
      request: validValidationRequest()
    }
  };
}

function validEditCommandResult() {
  return {
    ok: true,
    applied: false,
    planId: "edit-plan-1",
    planHash: "sha256:plan",
    matchCount: 1,
    afterState: {
      "src/index.ts": "export const value = 2;\n"
    },
    validationRequest: validValidationRequest(),
    validation: validValidationResult()
  };
}

function validInspectRouteResult() {
  return {
    route: "references",
    status: "ok",
    target: {
      kind: "file_symbol",
      path: "src/models.ts",
      symbolName: "GreetingModel",
      line: 8,
      column: 14,
      nodeId: "class:src/models.ts#GreetingModel"
    },
    providerStatus: availableGraphStatus(),
    references: [
      {
        file: "src/models.ts",
        line: 8,
        column: 14,
        text: "GreetingModel",
        span: {
          startLine: 8,
          startColumn: 14,
          endLine: 8,
          endColumn: 27,
          startOffset: 120,
          endOffset: 133
        },
        symbol: {
          id: "class:src/models.ts#GreetingModel",
          name: "GreetingModel",
          kind: "Class"
        },
        isDefinition: true,
        isDeclaration: true,
        evidence: {
          graphNodeIds: ["class:src/models.ts#GreetingModel"],
          resolver: "language_service"
        }
      }
    ]
  };
}

function validInspectSignatureResult() {
  return {
    route: "signature",
    status: "ok",
    target: {
      kind: "file_symbol",
      path: "src/models.ts",
      symbolName: "Renderable",
      line: 8,
      column: 18
    },
    providerStatus: availableGraphStatus(),
    signatures: [
      {
        file: "src/models.ts",
        line: 9,
        column: 3,
        text: "render(): string",
        signature: "render(): string",
        kind: "method",
        parameters: [],
        typeParameters: [],
        exported: true,
        async: false,
        returnType: "string",
        span: {
          startLine: 9,
          startColumn: 3,
          endLine: 9,
          endColumn: 19
        },
        symbol: {
          id: "method:src/models.ts#Renderable.render",
          name: "render",
          kind: "Function"
        },
        evidence: {
          graphNodeIds: ["type:src/models.ts#Renderable"],
          resolver: "language_service"
        }
      }
    ]
  };
}

function validInspectImplementationResult() {
  return {
    route: "implementations",
    status: "ok",
    target: {
      kind: "file_symbol",
      path: "src/models.ts",
      symbolName: "GreetingModel",
      line: 1,
      column: 14
    },
    providerStatus: availableGraphStatus(),
    implementations: [
      {
        file: "src/models.ts",
        line: 12,
        column: 14,
        text: "FriendlyGreetingModel extends GreetingModel",
        span: {
          startLine: 12,
          startColumn: 14,
          endLine: 12,
          endColumn: 35
        },
        kind: "extends",
        symbol: {
          id: "class:src/models.ts#FriendlyGreetingModel",
          name: "FriendlyGreetingModel",
          kind: "Class"
        },
        target: {
          id: "class:src/models.ts#GreetingModel",
          name: "GreetingModel",
          kind: "Class"
        },
        evidence: {
          graphNodeIds: ["class:src/models.ts#FriendlyGreetingModel", "class:src/models.ts#GreetingModel"],
          resolver: "language_service"
        }
      }
    ]
  };
}

function validRouterResult() {
  return {
    schemaVersion: 1,
    bin: "opcore",
    argv: ["graph", "status", "--json"],
    canonicalCommand: ["opcore", "status"],
    owner: "runtime",
    status: "ok",
    exitCode: 0,
    message: "router ready",
    json: true
  };
}

function validGraphReferenceEvidenceManifest() {
  return {
    schemaVersion: 1,
    issue: "#19",
    origin: "covibes-authored-synthetic",
    fixtureRefs: [
      "packages/fixtures/graph-reference-evidence/sqlite-fixtures.json",
      "packages/fixtures/graph-reference-evidence/daemon-socket-fixtures.json",
      "packages/fixtures/graph-reference-evidence/golden-corpus.json",
      "packages/fixtures/graph-reference-evidence/baseline-receipts.json"
    ],
    commandSurfaces: [
      {
        id: "graph-reference-status",
        classification: "required",
        referenceTool: "current external graph dev wrapper",
        referenceCommand: ["status"],
        canonicalCommand: ["opcore", "graph", "status"],
        flags: ["--repo", "--json"],
        positionals: [],
        fixtures: ["status-json"],
        exitSemantics: {
          success: 0,
          failure: "nonzero"
        }
      }
    ],
    jsonOutputSurfaces: [
      {
        id: "status-json",
        command: "status",
        classification: "required",
        requiredFields: ["status", "summary"],
        fixtures: ["status-json"],
        exitSemantics: {
          success: 0,
          failure: "nonzero"
        }
      }
    ],
    sqliteFixtures: [
      {
        id: "sqlite-required-views",
        classification: "required",
        fixture: "packages/fixtures/graph-reference-evidence/sqlite-fixtures.json",
        tables: ["metadata", "nodes", "edges"],
        indexes: ["idx_nodes_file"],
        metadataKeys: ["schema_version"],
        nodeKinds: ["File", "Function", "Test", "Module", "Struct", "Enum", "Trait", "Impl", "Method", "TypeAlias", "Const", "Static", "Macro"],
        edgeKinds: ["CALLS", "CONTAINS", "IMPORTS_FROM", "TESTED_BY", "IMPLEMENTS", "DEPENDS_ON", "INHERITS"],
        directReaderQueries: ["status-counts"],
        fixtures: ["sqlite-fixtures"]
      }
    ],
    daemonFixtures: [
      {
        id: "daemon-hot-query",
        classification: "required",
        fixture: "packages/fixtures/graph-reference-evidence/daemon-socket-fixtures.json",
        protocol: "opcore.graph.daemon",
        envelopes: ["ping-request", "success-response"],
        fixtures: ["daemon-fixtures"]
      }
    ],
    baselineReceipts: [
      {
        id: "install-setup",
        metric: "install_setup_ms",
        classification: "required",
        receipt: "packages/fixtures/graph-reference-evidence/baseline-receipts.json",
        label: "reference_evidence_non_implementation_input",
        sourceAvailability: "unavailable",
        nonImplementationInput: true,
        fixtures: ["baseline-receipts"]
      }
    ],
    optionalAnalysisSurfaces: [
      {
        issue: "#13",
        id: "coverage",
        classification: "deferred",
        status: "deferred",
        fixtures: ["coverage-deferred-marker"]
      },
      {
        issue: "#14",
        id: "flows",
        classification: "optional",
        status: "deferred",
        fixtures: ["sqlite-fixtures"]
      },
      {
        issue: "#15",
        id: "communities",
        classification: "optional",
        status: "deferred",
        fixtures: ["sqlite-fixtures"]
      },
      {
        issue: "#16",
        id: "read_only_suggestions",
        classification: "supporting",
        status: "deferred",
        fixtures: ["read-only-refactor-baseline"]
      }
    ],
    goldenCorpus: {
      id: "graph-reference-evidence-golden-corpus-v1",
      classification: "required",
      fixture: "packages/fixtures/graph-reference-evidence/golden-corpus.json",
      covers: ["parser", "store", "query", "search", "freshness", "status"],
      fixtures: ["golden-corpus"]
    },
    provenance: {
      containsPythonCrgSource: false,
      containsPackageMetadata: false,
      containsGitHistory: false,
      referenceReceiptsAreImplementationInput: false,
      implementationPackageNames: ["@the-open-engine/opcore-graph"],
      allowedMentionPaths: ["docs/graph-reference-evidence/", "packages/fixtures/graph-reference-evidence/"]
    }
  };
}

function validGraphReleaseReceipt() {
  const commandCoverage = graphReleaseCoreCommandIds.map((id) => {
    const command = id.replace("opcore-graph-", "");
    return {
      id,
      bin: "opcore",
      command: ["graph", command],
      canonicalCommand: ["opcore", "graph", command],
      status: "passed",
      exitCode: 0,
      fixture: "packages/fixtures/source-extraction/wave1",
      durationMs: 1
    };
  });
  const rustCommandCoverage = graphReleaseRustCommandIds.map((id) => {
    const command = id.replace("opcore-graph-rust-", "");
    return {
      id,
      bin: "opcore",
      command: ["graph", command],
      canonicalCommand: ["opcore", "graph", command],
      status: "passed",
      exitCode: 0,
      fixture: "packages/fixtures/source-extraction/rust-only",
      durationMs: 1
    };
  });
  return {
    schemaVersion: 1,
    issue: "#17",
    origin: "covibes-authored-synthetic",
    generatedAt: "2026-06-04T00:00:00.000Z",
    commitSha: "a".repeat(40),
    graphPackageVersions: [
      {
        packageName: "@the-open-engine/opcore-graph",
        version: "0.1.0-alpha.0"
      },
      ...graphCoreNativeSupportedTargets.map((target) => ({
        packageName: graphCoreNativePackageNameForTarget(target),
        version: "0.1.0-alpha.0"
      }))
    ],
    graphProviderSchemaVersion: 1,
    requiredChildren: ["#35", "#8", "#9", "#10", "#11", "#12", "#19", "#47"],
    deferredChildren: graphReleaseDeferredChildren,
    commandCoverage,
    rustCommandCoverage,
    directSqliteQueries: graphReleaseDirectSqliteQueryIds.map((id) => ({
      id,
      query: "select 1",
      status: "passed",
      rowCount: 1,
      fixture: "packages/fixtures/source-extraction/wave1/.lattice/graph/graph.db"
    })),
    serveTransport: [
      {
        id: "serve-jsonl-ping",
        protocol: "opcore.graph.daemon",
        operation: "ping",
        status: "passed",
        exitCode: 0
      },
      {
        id: "serve-jsonl-status",
        protocol: "opcore.graph.daemon",
        operation: "status",
        status: "passed",
        exitCode: 0
      },
      {
        id: "serve-jsonl-query",
        protocol: "opcore.graph.daemon",
        operation: "query",
        status: "passed",
        exitCode: 0
      },
      {
        id: "serve-jsonl-search",
        protocol: "opcore.graph.daemon",
        operation: "search",
        status: "passed",
        exitCode: 0
      },
      {
        id: "serve-jsonl-shutdown",
        protocol: "opcore.graph.daemon",
        operation: "shutdown",
        status: "passed",
        exitCode: 0
      }
    ],
    benchmarks: graphReleaseBenchmarkMetrics.map((metric) => ({
      metric,
      value: 1,
      unit: metric.endsWith("_bytes") ? "bytes" : "ms",
      baselineIssue: "#19",
      baselineReceipt: "packages/fixtures/graph-reference-evidence/baseline-receipts.json",
      comparison: "recorded"
    })),
    packageInspection: {
      packageName: "@the-open-engine/opcore-graph",
      tarballName: "covibes-opcore-graph-0.1.0-alpha.0.tgz",
      fileCount: 1,
      files: ["dist/index.js"],
      forbiddenMarkersAbsent: true,
      generatedBuildMetadataAbsent: true,
      privatePathsAbsent: true,
      pythonCrgSourceAbsent: true,
      pythonGraphPackageMetadataAbsent: true,
      pythonCrgGitHistoryAbsent: true,
      forbiddenImplementationPackageNamesAbsent: true,
      inspections: ["npm-pack-dry-run"]
    },
    supportedNativeTargets: graphCoreNativeSupportedTargets,
    nativeArtifacts: graphCoreNativeSupportedTargets.map((targetPlatform) => ({
      packageName: graphCoreNativePackageNameForTarget(targetPlatform),
      targetPlatform,
      metadata: {
        ...validArtifactMetadata(),
        targetPlatform,
        binaryPath: "opcore-graph-core",
        checksumPath: "opcore-graph-core.sha256",
        checksumSha256: "e".repeat(64)
      },
      binaryPath: "opcore-graph-core",
      checksumPath: "opcore-graph-core.sha256",
      metadataPath: "metadata.json",
      binarySha256: "e".repeat(64),
      checksumFileSha256: "f".repeat(64),
      metadataSha256: "a".repeat(64),
      packageFiles: ["package.json", "README.md", "opcore-graph-core", "opcore-graph-core.sha256", "metadata.json"]
    })),
    reportReceipts: [
      {
        id: "conformance",
        command: ["npm", "run", "conformance:check"],
        status: "passed",
        exitCode: 0,
        path: "docs/release/graph-release-receipt.json"
      },
      {
        id: "pack",
        command: ["npm", "run", "pack:check"],
        status: "passed",
        exitCode: 0,
        path: "docs/release/graph-release-receipt.json"
      },
      {
        id: "license",
        command: ["npm", "run", "license:report"],
        status: "passed",
        exitCode: 0,
        path: "docs/release/license-report.md"
      },
      {
        id: "provenance",
        command: ["npm", "run", "provenance:check"],
        status: "passed",
        exitCode: 0,
        path: "docs/release/provenance-receipts.md"
      }
    ],
    graphArtifact: validArtifactMetadata(),
    optionalSurfaces: [
      {
        issue: "#13",
        id: "coverage",
        classification: "deferred",
        status: "deferred"
      },
      {
        issue: "#14",
        id: "flows",
        classification: "optional",
        status: "deferred"
      },
      {
        issue: "#15",
        id: "communities",
        classification: "optional",
        status: "deferred"
      },
      {
        issue: "#16",
        id: "read_only_suggestions",
        classification: "supporting",
        status: "deferred"
      }
    ],
    handoff: graphReleaseHandoffIssues.map((issue) => ({
      issue,
      receiptPath: "docs/release/graph-release-receipt.payload.json",
      checksumSha256: "b".repeat(64),
      rollbackNote: "Keep ACE wrappers on current external tools if receipt regresses."
    }))
  };
}

function validReleaseReceipt() {
  const descriptor = validManagedToolDescriptor();
  const packageRoots = new Map([
    ["@the-open-engine/opcore-contracts", "packages/contracts"],
    ["@the-open-engine/opcore", "packages/opcore"],
    ["@the-open-engine/opcore-graph", "packages/graph"],
    ...graphCoreNativeSupportedTargets.map((target) => [
      graphCoreNativePackageNameForTarget(target),
      `packages/${graphCoreNativePackageNameForTarget(target).replace("@the-open-engine/", "")}`
    ]),
    ["@the-open-engine/opcore-edit", "packages/edit"],
    ["@the-open-engine/opcore-validation", "packages/validation"],
    ["@the-open-engine/opcore-validation-python", "packages/validation-python"],
    ["@the-open-engine/opcore-validation-rust", "packages/validation-rust"],
    ["@the-open-engine/opcore-validation-typescript", "packages/validation-typescript"],
    ["@the-open-engine/opcore-asp-provider", "packages/asp-provider"],
    ["@the-open-engine/opcore-fixtures", "packages/fixtures"]
  ]);
  const packages = releaseReceiptPackageNames.map((packageName) => {
    const packageRoot = packageRoots.get(packageName);
    const isOpcore = packageName === "@the-open-engine/opcore";
    const nativeTarget = graphCoreNativeSupportedTargets.find((target) => graphCoreNativePackageNameForTarget(target) === packageName);
    const nativeDescriptor = nativeTarget
      ? descriptor.capabilities.graph.nativeArtifacts.find((artifact) => artifact.targetPlatform === nativeTarget)
      : undefined;
    const nativeBinaryArtifact = nativeDescriptor
      ? descriptor.artifacts.find((artifact) => artifact.id === nativeDescriptor.artifactIds.binaryArtifactId)
      : undefined;
    const nativeMetadataArtifact = nativeDescriptor
      ? descriptor.artifacts.find((artifact) => artifact.id === nativeDescriptor.artifactIds.metadataArtifactId)
      : undefined;
    const nativeChecksumArtifact = nativeDescriptor
      ? descriptor.artifacts.find((artifact) => artifact.id === nativeDescriptor.artifactIds.checksumArtifactId)
      : undefined;
    const nativeChecksum = nativeDescriptor
      ? descriptor.checksums.find((checksum) => checksum.id === nativeDescriptor.artifactIds.checksumId)
      : undefined;
    const graphMetadata = nativeTarget
      ? {
          ...validArtifactMetadata(),
          targetPlatform: nativeTarget,
          binaryPath: nativeBinaryArtifact.path,
          checksumPath: nativeChecksumArtifact.path,
          checksumSha256: "e".repeat(64)
        }
      : undefined;
    const files = [
      ...new Set([
        "package.json",
        "README.md",
        ...(nativeTarget ? [] : ["dist/index.js"]),
        ...(packageName === "@the-open-engine/opcore-asp-provider"
          ? ["dist/manifests/asp-server.json", "dist/manifests/opcore-asp-provider.provisional.json"]
          : []),
        ...descriptor.artifacts.filter((artifact) => artifact.packageName === packageName).map((artifact) => artifact.path)
      ])
    ];
    const bins = isOpcore
      ? { opcore: "dist/index.js" }
      : packageName === "@the-open-engine/opcore-asp-provider"
        ? { "opcore-asp-provider": "dist/index.js" }
          : {};
    return {
      packageName,
      packageRoot,
      version: "0.1.0-alpha.0",
      manifest: {
        name: packageName,
        version: "0.1.0-alpha.0",
        license: "MIT",
        ...(nativeTarget ? {} : { main: "dist/index.js", types: "dist/index.d.ts" }),
        files: nativeTarget ? ["opcore-graph-core", "opcore-graph-core.sha256", "metadata.json", "README.md"] : ["dist", "README.md"],
        bins,
        dependencies: {},
        bundledDependencies: []
      },
      tarball: {
        filename: packageName.replace("@the-open-engine/", "the-open-engine-").replace("/", "-") + "-0.1.0-alpha.0.tgz",
        path: `.lattice/release/packages/${packageName.replace("@the-open-engine/", "the-open-engine-")}-0.1.0-alpha.0.tgz`,
        sha256: "c".repeat(64),
        integrity: "sha512-test",
        shasum: "d".repeat(40)
      },
      files,
      fileCount: files.length,
      expectedFiles: files,
      expectedFileCount: files.length,
      bins,
      descriptorReferences: descriptor.artifacts.filter((artifact) => artifact.packageName === packageName),
      nativeArtifacts: nativeTarget
        ? [
            {
              packageName,
              targetPlatform: nativeTarget,
              metadata: graphMetadata,
              binaryPath: nativeBinaryArtifact.path,
              checksumPath: nativeChecksumArtifact.path,
              metadataPath: nativeMetadataArtifact.path,
              binarySha256: "e".repeat(64),
              checksumFileSha256: "f".repeat(64),
              metadataSha256: "a".repeat(64),
              descriptorArtifactId: nativeBinaryArtifact.id,
              descriptorChecksumId: nativeChecksum.id
            }
          ]
        : []
    };
  });
  return {
    schemaVersion: 1,
    issue: "#29",
    origin: "covibes-authored-release-proof",
    generatedAt: "2026-06-05T00:00:00.000Z",
    commitSha: "a".repeat(40),
    privateRepo: true,
    packageNames: releaseReceiptPackageNames,
    commandGroups: releaseReceiptCommandGroups,
    packages,
    descriptor: {
      path: "packages/opcore/dist/descriptors/opcore.managed-tool.json",
      packageName: "@the-open-engine/opcore",
      checksumSha256: "b".repeat(64),
      descriptor,
      commandGroups: descriptor.commandGroups.map((group) => ({
        name: group.name,
        canonicalCommand: group.canonicalCommand,
        packageName: group.packageName
      })),
      resolvedArtifacts: descriptor.artifacts.map((artifact) => ({
        id: artifact.id,
        packageName: artifact.packageName,
        path: artifact.path,
        type: artifact.type,
        required: artifact.required,
        packageFile: true,
        ...(artifact.checksumRef ? { checksumRef: artifact.checksumRef } : {})
      })),
      resolvedChecksums: descriptor.checksums.map((checksum) => ({
        id: checksum.id,
        packageName: checksum.packageName,
        path: checksum.path,
        algorithm: "sha256",
        artifactRef: checksum.artifactRef,
        required: checksum.required,
        packageFile: true,
        value: checksum.value ?? "e".repeat(64)
      }))
    },
    nativeArtifacts: packages.flatMap((entry) => entry.nativeArtifacts),
    license: {
      reportPath: "docs/release/license-report.md",
      reportSha256: "1".repeat(64),
      productionDependencyCount: 1,
      bundledDependencyCount: 0,
      workspacePackageCount: releaseReceiptPackageNames.length,
      unresolvedLicenseCount: 0,
      packages: [
        {
          name: "typescript",
          version: "5.9.3",
          license: "Apache-2.0",
          source: "node_modules/typescript",
          bundled: false
        }
      ]
    },
    provenance: {
      reportPath: "docs/release/provenance-receipts.md",
      reportSha256: "2".repeat(64),
      scannedFileCount: 1,
      historyCommitCount: 1,
      findingCount: 0,
      findings: []
    },
    secretHistory: {
      allowlistPath: "docs/release/secret-scan-allowlist.json",
      allowlistSha256: "3".repeat(64),
      currentTreeScannedFileCount: 1,
      gitHistoryScannedCommitCount: 1,
      findingCount: 0,
      findings: []
    },
    reports: releaseReceiptReportIds.map((id) => ({
      id,
      command: id === "secret-history" ? ["node", "scripts/generate-release-receipt.mjs", "--scan-secrets-only"] : ["npm", "run", `${id}:check`],
      status: "passed",
      exitCode: 0,
      path: id === "license" ? "docs/release/license-report.md" : "docs/release/release-receipt.json",
      checksumSha256: "4".repeat(64),
      summary: `${id} passed`
    })),
    graphReleaseReceipt: {
      path: "docs/release/graph-release-receipt.json",
      issue: "#17",
      checksumSha256: "5".repeat(64)
    }
  };
}

function validReleaseCutoverReceipt() {
  const releaseReceipt = validReleaseReceipt();
  const descriptor = releaseReceipt.descriptor;
  const installedNativePackageName = graphCoreNativePackageNameForTarget("darwin-arm64");
  const installedPackages = releaseReceipt.packages
    .filter((entry) => !graphCoreNativePackageNames.includes(entry.packageName) || entry.packageName === installedNativePackageName)
    .map((entry) => ({
    packageName: entry.packageName,
    version: entry.version,
    tarball: {
      filename: entry.tarball.filename,
      sha256: entry.tarball.sha256
    },
    installedManifest: {
      path: `node_modules/${entry.packageName}/package.json`,
      sha256: "6".repeat(64),
      bins: entry.bins
    },
    installedFiles: entry.files.map((path) => ({
      path: `node_modules/${entry.packageName}/${path}`,
      sha256: "9".repeat(64)
    }))
  }));
  const commandReceipts = [
    ["opcore-scan", ["opcore", "scan"], "runtime"],
    ["opcore-status", ["opcore", "status"], "runtime"],
    ["opcore-check-changed", ["opcore", "check", "changed", "--base", "HEAD", "--checks", "typescript.syntax"], "validation"],
    ["opcore-measure", ["opcore", "measure"], "runtime"],
    ["opcore-try", ["opcore", "try"], "runtime"],
    ["status", ["opcore", "status"], "runtime"],
    ["doctor", ["opcore", "doctor"], "runtime"],
    ["graph-build", ["opcore", "graph", "build"], "graph"],
    ["graph-status", ["opcore", "graph", "status"], "graph"],
    ["graph-query", ["opcore", "graph", "query"], "graph"],
    ["graph-impact", ["opcore", "graph", "impact", "--files", "src/components/GreetingCard.tsx"], "graph"],
    ["graph-review-context", ["opcore", "graph", "review-context", "--files", "src/components/GreetingCard.tsx"], "graph"],
    ["graph-detect-changes", ["opcore", "graph", "detect-changes", "--files", "src/components/GreetingCard.tsx"], "graph"],
    ["graph-search", ["opcore", "graph", "search", "Greeting", "--limit", "5"], "graph"],
    ["graph-serve", ["opcore", "graph", "serve"], "graph"],
    ["inspect-symbols", ["opcore", "inspect", "symbols", "Greeting", "--limit", "5"], "inspect"],
    ["inspect-definition", ["opcore", "inspect", "definition", "GreetingCard"], "inspect"],
    ["inspect-references", ["opcore", "inspect", "references", "function:src/components/GreetingCard.tsx#GreetingCard", "--limit", "5"], "inspect"],
    ["inspect-signature", ["opcore", "inspect", "signature", "function:src/components/GreetingCard.tsx#GreetingCard"], "inspect"],
    ["inspect-implementations", ["opcore", "inspect", "implementations", "class:src/models.ts#GreetingModel"], "inspect"],
    ["inspect-search", ["opcore", "inspect", "search", "Greeting", "--limit", "5"], "inspect"],
    [
      "edit-preview",
      [
        "opcore",
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 1;",
        "--replacement",
        "export const cutoverValue: number = 2;"
      ],
      "edit"
    ],
    [
      "edit-apply",
      [
        "opcore",
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 1;",
        "--replacement",
        "export const cutoverValue: number = 2;",
        "--apply"
      ],
      "edit"
    ],
    [
      "edit-refused",
      [
        "opcore",
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 2;",
        "--replacement",
        "export const cutoverValue: number = missingCutoverSymbol;",
        "--apply"
      ],
      "edit",
      "error",
      1
    ],
    ["check-files", ["opcore", "check", "files", "src/cutover.ts", "--checks", "typescript.syntax,typescript.types"], "validation"],
    ["validate-request", ["opcore", "validate", "request", "--request-file", "/tmp/opcore-cutover/project/validate-request.json"], "validation"],
    [
      "validate-pre-write-pass",
      ["opcore", "validate", "pre-write", "--request-file", "/tmp/opcore-cutover/project/pre-write-pass.json", "--timeout-ms", "30000"],
      "validation"
    ],
    [
      "validate-pre-write-fail",
      ["opcore", "validate", "pre-write", "--request-file", "/tmp/opcore-cutover/project/pre-write-fail.json", "--timeout-ms", "30000"],
      "validation",
      "error",
      1
    ]
  ].map(([id, command, owner, status = "ok", exitCode = 0]) => {
    const bin = command[0];
    return {
      id,
      command,
      canonicalCommand: command,
      owner,
      status,
      exitCode,
      binPath: `node_modules/.bin/${bin}`,
      stdoutSha256: "7".repeat(64),
      stderrSha256: "8".repeat(64),
      assertion: `${id} passed`
    };
  });
  const rustCommandReceipts = [
    ["graph-rust-build", ["opcore", "graph", "build"], "graph"],
    ["graph-rust-status", ["opcore", "graph", "status"], "graph"],
    ["graph-rust-query", ["opcore", "graph", "query"], "graph"],
    ["graph-rust-impact", ["opcore", "graph", "impact", "--files", "src/helpers.rs"], "graph"],
    ["graph-rust-review-context", ["opcore", "graph", "review-context", "--files", "src/helpers.rs"], "graph"],
    ["graph-rust-detect-changes", ["opcore", "graph", "detect-changes", "--files", "src/helpers.rs"], "graph"],
    ["graph-rust-search", ["opcore", "graph", "search", "Widget", "--limit", "5"], "graph"]
  ].map(([id, command, owner]) => ({
    id,
    command,
    canonicalCommand: command,
    owner,
    status: "ok",
    exitCode: 0,
    binPath: "node_modules/.bin/opcore",
    stdoutSha256: "7".repeat(64),
    stderrSha256: "8".repeat(64),
    assertion: `${id} passed on Rust fixture`
  }));
  const pythonCommandReceipts = [
    ["opcore-python-scan", ["opcore", "scan"], "runtime"],
    ["opcore-python-status", ["opcore", "status"], "runtime"],
    ["opcore-python-check-changed", ["opcore", "check", "changed", "--base", "HEAD", "--checks", "python.syntax,python.source-hygiene"], "validation"],
    ["opcore-python-measure", ["opcore", "measure"], "runtime"],
    ["graph-python-build", ["opcore", "graph", "build"], "graph"],
    ["graph-python-status", ["opcore", "graph", "status"], "graph"],
    ["graph-python-query", ["opcore", "graph", "query"], "graph"],
    ["graph-python-search", ["opcore", "graph", "search", "Greeter", "--limit", "5"], "graph"]
  ].map(([id, command, owner]) => ({
    id,
    command,
    canonicalCommand: command,
    evidence: pythonCutoverEvidence(id),
    owner,
    status: "ok",
    exitCode: 0,
    binPath: `node_modules/.bin/${command[0]}`,
    stdoutSha256: "7".repeat(64),
    stderrSha256: "8".repeat(64),
    assertion: `${id} passed on Python fixture`
  }));
  return {
    schemaVersion: 1,
    issue: "#30",
    origin: "covibes-authored-cutover-proof",
    generatedAt: "2026-06-05T00:00:00.000Z",
    commitSha: "a".repeat(40),
    privateRepo: true,
    packageNames: releaseReceiptPackageNames,
    installedPackages,
    descriptor: {
      path: descriptor.path,
      packageName: descriptor.packageName,
      checksumSha256: descriptor.checksumSha256,
      descriptor: descriptor.descriptor,
      resolvedArtifacts: descriptor.resolvedArtifacts,
      resolvedChecksums: descriptor.resolvedChecksums
    },
    environmentIsolation: {
      currentToolEnvCleared: true,
      clearedEnvVarCount: 5,
      pathSanitized: true,
      aceRuntimeBinExcluded: true,
      siblingCovibesExcluded: true,
      opcoreBinOnly: true,
      oldBinsAbsent: {
        lattice: true,
        crg: true,
        cix: true,
        rox: true
      }
    },
    commandReceipts,
    rustCommandReceipts,
    pythonCommandReceipts,
    negativeChecks: [
      {
        id: "missing-required-graph-check",
        command: ["opcore", "check", "files", "src/index.ts", "--repo", "<missing-graph-repo>", "--graph-mode", "required", "--checks", "typescript.import-graph"],
        status: "passed",
        exitCode: 0,
        assertion: "required graph failure stayed typed"
      },
      {
        id: "missing-required-graph-validate",
        command: ["opcore", "validate", "request", "--request-file", "<required-graph-request>"],
        status: "passed",
        exitCode: 0,
        assertion: "required graph validate failure stayed typed"
      },
      {
        id: "python-types-degraded-no-tools",
        command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.types"],
        status: "passed",
        exitCode: 0,
        assertion: "missing Python type tools stayed degraded"
      },
      {
        id: "python-source-hygiene-no-ruff",
        command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.source-hygiene"],
        status: "passed",
        exitCode: 0,
        assertion: "source hygiene stayed honest without ruff"
      },
      {
        id: "python-relevant-tests-no-pytest",
        command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.relevant-tests"],
        status: "passed",
        exitCode: 0,
        assertion: "relevant tests stayed graph-backed without pytest"
      },
      {
        id: "python-toolchain-degraded-no-tools",
        command: ["opcore", "status"],
        status: "passed",
        exitCode: 0,
        assertion: "missing Python toolchain stayed degraded"
      }
    ],
    currentToolGuardrails: [
      {
        id: "current-tools-validate-changed",
        command: ["npm", "run", "current-tools:validate-changed"],
        status: "passed",
        exitCode: 0,
        stdoutSha256: "7".repeat(64),
        stderrSha256: "8".repeat(64),
        retained: true,
        assertion: "retained changed-file guardrail",
        oldToolReplacementClaimed: false
      },
      {
        id: "current-tools-validate-rust-graph",
        command: ["npm", "run", "current-tools:validate-rust-graph"],
        status: "passed",
        exitCode: 0,
        stdoutSha256: "7".repeat(64),
        stderrSha256: "8".repeat(64),
        retained: true,
        assertion: "retained Rust graph guardrail",
        oldToolReplacementClaimed: false
      }
    ],
    oldToolReplacementClaimed: false,
    forbiddenMarkerScan: {
      scannedTextCount: 12,
      findingCount: 0,
      markersBlocked: ["private-runtime", "current-tool-env", "private-home", "old-tool-bins"]
    },
    inputEvidence: [
      {
        issue: "#17",
        path: "docs/release/graph-release-receipt.json",
        checksumSha256: "9".repeat(64)
      },
      {
        issue: "#29",
        path: "docs/release/release-receipt.json",
        checksumSha256: "a".repeat(64)
      },
      {
        issue: "#58",
        path: "docs/integration/pre-write-validation.md",
        checksumSha256: "b".repeat(64)
      }
    ]
  };
}

function pythonCutoverEvidence(id) {
  return {
    "opcore-python-scan": ["python-coverage", "python-validation", "python-types-degraded"],
    "opcore-python-status": ["python-coverage", "python-validation"],
    "opcore-python-check-changed": ["python-syntax", "python-source-hygiene"],
    "opcore-python-measure": ["python-measure-delta"],
    "graph-python-build": ["python-graph-provider"],
    "graph-python-status": ["python-graph-provider"],
    "graph-python-query": ["src/acme/app.py", "Greeter", "build_name"],
    "graph-python-search": ["src/acme/app.py", "Greeter"]
  }[id];
}

function validRustOldRoxComparisonReceipt() {
  const surface = (id, graphEvidenceExists, graphEvidence, stillUniquelyProvidedByCurrentTools, replacementStatus = "retained") => ({
    id,
    graphEvidenceExists,
    graphEvidence,
    stillUniquelyProvidedByCurrentTools,
    replacementStatus
  });
  return {
    schemaVersion: 1,
    issue: "#29",
    origin: "covibes-authored-old-rox-comparison",
    generatedAt: "2026-06-27T00:00:00.000Z",
    privateRepo: true,
    oldToolReplacementClaimed: false,
    publicReleaseActions: [],
    surfaces: [
      surface(
        "rust.rustdoc",
        false,
        ["No graph fact replaces rustdoc diagnostics."],
        ["rustdoc diagnostics and broken intra-doc link policy remain current-tool evidence."]
      ),
      surface(
        "rust.import-graph",
        true,
        ["Rust graph emits IMPORTS_FROM and DEPENDS_ON edges for module files."],
        ["Rox/current tooling still uniquely provides rustdoc and cargo-depgraph-enriched import checks."],
        "deferred"
      ),
      surface(
        "rust.dead-code",
        true,
        ["Rust graph emits exported symbol metadata and graph-backed dead public export signals."],
        ["Cargo dead_code diagnostics and retained Rox gate behavior still uniquely cover compiler reachability."]
      ),
      surface(
        "rust.unused-deps",
        false,
        ["No graph fact replaces cargo-udeps unused dependency analysis."],
        ["cargo-udeps/Rox unused dependency detection remains current-tool evidence."]
      ),
      surface(
        "rust.function-metrics",
        true,
        ["Rust graph emits symbol spans and signatures for functions and methods."],
        ["rust-code-analysis complexity and parameter thresholds remain current-tool evidence."]
      ),
      surface(
        "current-tools:validate-rust-graph",
        false,
        ["Graph receipts do not replace the aggregate current-tools Rust graph gate."],
        ["npm run current-tools:validate-rust-graph remains the retained aggregate guardrail."]
      )
    ],
    guardrails: [
      {
        id: "current-tools:validate-rust-graph",
        command: ["npm", "run", "current-tools:validate-rust-graph"],
        replacementStatus: "retained",
        oldToolReplacementClaimed: false
      }
    ]
  };
}

function validAspDogfoodReceipt() {
  const cutover = validReleaseCutoverReceipt();
  const aspRepo = covibesPath("agent-server-protocol");
  const hostFixtureRepo = "/tmp/opcore-asp-dogfood/asp-host-fixture";
  const command = (id, commandParts, output = {}) => ({
    id,
    command: commandParts,
    status: "passed",
    exitCode: 0,
    stdoutSha256: "c".repeat(64),
    stderrSha256: "d".repeat(64),
    output,
    assertion: `${id} passed`
  });
  const hostDecision = {
    decision: "allow",
    receipt: {
      receiptId: "core-evaluate-allow-test",
      authorityEvidence: [
        {
          identity: "opcore",
          authority: { granted: false, requirement: "opcore/core-required-check", policyDigest: "sha256:test" }
        }
      ],
      providerProvenance: [{ provider: "opcore", capability: "check", identity: "opcore" }],
      assurance: { mode: "gated", transactionGuarantee: "none" }
    },
    authorityEvidence: [
      {
        identity: "opcore",
        authority: { granted: false, requirement: "opcore/core-required-check", policyDigest: "sha256:test" }
      }
    ],
    providerProvenance: [{ provider: "opcore", capability: "check", identity: "opcore" }],
    assurance: { mode: "gated", transactionGuarantee: "none" }
  };
  const manifest = {
    manifestVersion: "asp-server/0.1",
    server: { id: "opcore", name: "Opcore", version: "0.1.0-alpha.0" },
    protocolVersions: ["asp/0.1"],
    capabilities: ["check"],
    capabilityProfiles: ["core-check-provider", "opcore-core-check"],
    entrypoint: { transport: "stdio", bin: "/tmp/opcore-asp-dogfood/project/node_modules/.bin/opcore-asp-provider", args: ["--stdio"] },
    artifact: { fingerprint: `sha256:${"e".repeat(64)}`, checksums: [{ path: "dist/index.js", sha256: "e".repeat(64) }] },
    provenance: { publisher: "the-open-engine", source: "https://github.com/the-open-engine/opcore", license: "MIT" },
    accessExpectations: {
      filesystem: { read: ["workspace:snapshot"], write: [] },
      network: { outbound: false, allowlist: [] },
      secrets: { names: [] },
      environment: { inherit: false, variables: ["ASP_SESSION_ID", "PATH"] },
      dataClasses: ["source-code", "diff-metadata"]
    }
  };
  return {
    schemaVersion: 1,
    issue: "#120",
    origin: "covibes-authored-asp-dogfood-proof",
    generatedAt: "2026-06-24T00:00:00.000Z",
    commitSha: "a".repeat(40),
    privateRepo: true,
    bootstrapSource: "local-sibling",
    packageNames: releaseReceiptPackageNames,
    installedPackages: cutover.installedPackages,
    manager: {
      bootstrapSource: "local-sibling",
      aspRepoPath: aspRepo,
      aspBinPath: `${aspRepo}/packages/asp/bin/asp`,
      cliPath: `${aspRepo}/packages/asp/dist/cli.js`,
      commitSha: "b".repeat(40)
    },
    aspHome: {
      path: "/tmp/opcore-asp-dogfood/asp-home",
      temp: true,
      isolated: true,
      sharedStateMutated: false,
      pathSanitized: true,
      aceRuntimeBinExcluded: true
    },
    hostFixture: {
      repo: hostFixtureRepo,
      temp: true,
      sourceRepoMutated: false,
      baselineCommitted: true,
      changedPaths: ["src/dogfood.ts"]
    },
    provider: {
      providerId: "opcore",
      packageName: "@the-open-engine/opcore-asp-provider",
      binPath: "node_modules/.bin/opcore-asp-provider",
      indexPath: "node_modules/@the-open-engine/opcore-asp-provider/dist/index.js",
      indexSha256: "e".repeat(64),
      command: ["opcore-asp-provider", "--stdio"],
      entrypoint: { transport: "stdio", bin: "/tmp/opcore-asp-dogfood/project/node_modules/.bin/opcore-asp-provider", args: ["--stdio"] },
      manifest: {
        manifestPath: "/tmp/opcore-asp-dogfood/asp-server.opcore.json",
        manifestSha256: "f".repeat(64),
        manifest
      }
    },
    managerState: {
      status: command("asp-status", ["asp", "status", "--json"]),
      serverAdd: command("asp-server-add", ["asp", "server", "add", "--manifest", "/tmp/asp-server.opcore.json", "--json"]),
      serverStatus: command("asp-server-status", ["asp", "server", "status", "opcore", "--json"], { server: { id: "opcore" } })
    },
    repoEnrollment: {
      repo: hostFixtureRepo,
      mode: "advisory",
      repoAdd: command("asp-repo-add", ["asp", "repo", "add", hostFixtureRepo, "--json"]),
      repoEnable: command("asp-repo-enable", ["asp", "repo", "enable", "opcore", "--repo", hostFixtureRepo, "--mode", "advisory", "--json"]),
      repoStatus: command("asp-repo-status", ["asp", "repo", "status", hostFixtureRepo, "--json"])
    },
    hostEvaluation: {
      check: {
        ...command("asp-check-changed", ["asp", "check", "--repo", hostFixtureRepo, "--changed", "--call-site", "interactive", "--json"]),
        hostDecision,
        receipt: hostDecision.receipt,
        assurance: { mode: "gated", transactionGuarantee: "none" }
      },
      ciVerify: command("asp-ci-verify", ["asp", "ci", "verify", "--repo", hostFixtureRepo, "--changed-from", "main", "--json"])
    },
    providerProbe: {
      ...command("provider-probe", ["opcore-asp-provider", "--stdio"]),
      assessment: {
        status: "complete",
        diagnostics: [],
        coverage: { degraded: [], unsupported: [], exhaustive: false },
        validAsOf: { baseline: { rev: "tree:test" }, changesetDigest: "sha256:test", blobs: [] },
        provider: { id: "opcore", capabilityFamily: "check" }
      },
      validAsOf: { baseline: { rev: "tree:test" }, changesetDigest: "sha256:test", blobs: [] },
      coverage: { degraded: [], unsupported: [], exhaustive: false },
      diagnosticsCount: 0,
      hostOwnedFieldLeak: false
    },
    currentToolGuardrails: [
      { ...command("current-tools-validate-changed", ["npm", "run", "current-tools:validate-changed"]), retained: true },
      { ...command("current-tools-validate-rust-graph", ["npm", "run", "current-tools:validate-rust-graph"]), retained: true },
      {
        id: "current-tools-validate-all",
        command: ["npm", "run", "current-tools:validate-all"],
        status: "retained-not-run",
        exitCode: null,
        stdoutSha256: "0".repeat(64),
        stderrSha256: "0".repeat(64),
        retained: true,
        assertion: "retained by default"
      }
    ],
    unsupportedSurfaces: [
      { surface: "inspect", status: "parity-blocker", cleanCoverage: false, blocker: "inspect not mapped into ASP #120" },
      { surface: "edit", status: "retained-old-tool-gate", cleanCoverage: false, blocker: "edit not mapped into ASP #120" }
    ],
    parityBlockers: [{ source: "docs/planning/old-tool-compatibility-matrix.md:1", detail: "old-tool guardrails retained" }],
    authority: {
      hostOwnsDecisions: true,
      providerOutputIsHostDecision: false,
      localAuthorityOverride: { present: false, sharedAuthorityWeakened: false }
    },
    publicReleaseActions: [],
    oldToolReplacementClaimed: false,
    forbiddenMarkerScan: {
      scannedTextCount: 2,
      findingCount: 0,
      markersBlocked: aspDogfoodForbiddenProviderMarkers
    }
  };
}

function covibesPath(repo) {
  return `${["", "Users", "tom", "code", "covibes"].join("/")}/${repo}`;
}
