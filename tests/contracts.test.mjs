import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GRAPH_SCHEMA_VERSION,
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
  graphReleaseDeferredChildren,
  graphReleaseDirectSqliteQueryIds,
  graphReleaseHandoffIssues,
  graphReleaseOptionalAnalysisSurfaces,
  releaseReceiptCommandGroups,
  releaseReceiptPackageNames,
  releaseReceiptReportIds,
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
  validateProviderStatus,
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
  validateReleaseCutoverReceipt,
  validateReleaseReceipt,
  validateGraphSearchRequest,
  validateGraphSearchResult,
  validateGraphServeTransportStatus,
  validateGraphReferenceEvidenceManifest,
  validateInspectRouteResult,
  validateManagedToolDescriptor,
  validateOpcoreInitPlanPayload,
  validateOpcoreMeasureDelta,
  validateOpcoreMetricHistoryEntry,
  validateOpcoreMetricReport,
  validateOpcoreTryPayload,
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

describe("lattice shared contracts", () => {
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
      "Class",
      "Function",
      "Variable",
      "Type",
      "Test"
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
    assert.deepEqual(graphExtractionDiagnosticCategories, [
      "missing_tsconfig",
      "malformed_tsconfig",
      "unsupported_language",
      "parse_error",
      "missing_parser",
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
      "lattice-graph-build",
      "lattice-graph-update",
      "lattice-graph-watch",
      "lattice-graph-status",
      "lattice-graph-query",
      "lattice-graph-impact",
      "lattice-graph-search",
      "lattice-graph-serve",
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
      provider: "lattice-graph",
      schemaVersion: 1,
      repo: {
        repoId: "lattice"
      },
      freshness: {
        generatedAt: "2026-06-04T00:00:00.000Z",
        ageMs: 0,
        stale: false
      },
      walCheckpoint: validWalCheckpoint(),
      handshake: validHandshake()
    });
    assert.equal(status.state, "available");
    assert.equal(status.handshake.artifact.artifactName, "lattice-graph-core");
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
    assert.equal(artifact.binaryPath, "dist/native/test/lattice-graph-core");
    const handshake = validateGraphProviderCapabilityHandshake(validHandshake());
    assert.deepEqual(handshake.supportedOperations, ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"]);

    const query = validateGraphFactQueryRequest(validGraphFactQueryRequest());
    assert.equal(query.selector.kind, "nodes");
    const search = validateGraphSearchRequest(validGraphSearchRequest());
    assert.equal(search.query, "Greeting");
    assert.deepEqual(search.files, ["src/components/GreetingCard.tsx"]);

    const request = validateGraphDaemonRequest({
      protocol: "lattice.graph.daemon",
      requestId: "status-1",
      schemaVersion: 1,
      operation: "status",
      repo: {
        repoId: "lattice"
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
      protocol: "lattice.graph.daemon",
      requestId: "status-1",
      schemaVersion: 1,
      status: {
        state: "available",
        mode: "required",
        provider: "lattice-graph",
        schemaVersion: 1,
        repo: {
          repoId: "lattice"
        },
        freshness: {
          generatedAt: "2026-06-04T00:00:00.000Z",
          ageMs: 0,
          stale: false
        },
        handshake
      }
    });
    assert.equal(response.status.state, "available");
    const pipeline = validateGraphPipelineResult({
      summary: {
        operation: "build",
        repo: {
          repoId: "lattice"
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
      pidPath: "/tmp/lattice/pid",
      statePath: "/tmp/lattice/state.json",
      logPath: "/tmp/lattice/daemon.log",
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
    assert.equal(serveStatus.artifact.artifactName, "lattice-graph-core");
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
          protocol: "lattice.graph.daemon",
          requestId: "query-1",
          schemaVersion: 1,
          operation: "query",
          repo: {
            repoId: "lattice"
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
            provider: "lattice-graph",
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
            repoId: "lattice"
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
            repoId: "lattice"
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
            repoId: "lattice"
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
      { kind: "package", packageName: "@the-open-engine/lattice-contracts", packageRoot: "packages/contracts" }
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
          validValidationRequest({ scope: { kind: "package", packageName: "@the-open-engine/lattice", packageRoot: "../packages" } })
        ),
      /escape/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload(
          validValidationRequest({ repo: { repoId: "lattice", repoRoot: "/repo" }, scope: { kind: "repo" } })
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
            provider: "lattice-graph",
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
              provider: "lattice-graph",
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
                provider: "lattice-graph",
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
          repoId: "lattice",
          repoRoot: "/repo"
        }),
      /ambiguous/
    );
    assert.throws(
      () =>
        validateValidationRequestPayload({
          repo: {
            repoId: "lattice",
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
          provider: "lattice-graph",
          schemaVersion: 1
        }),
      /failure\.category/
    );
    assert.throws(
      () =>
        validateProviderStatus({
          state: "schema_mismatch",
          mode: "required",
          provider: "lattice-graph",
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
          provider: "lattice-graph",
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
      provider: "lattice-graph",
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
            provider: "lattice-graph",
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
            provider: "lattice-graph",
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
            provider: "lattice-graph",
            schemaVersion: 1,
            repo: {
              repoId: "lattice"
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
          provider: "lattice-graph",
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
    assert.equal(validateCommandRouterManifest(manifest).packageName, "@the-open-engine/lattice-cli");
    assert.equal(validateCommandRouterResult(validRouterResult()).canonicalCommand.join(" "), "lattice status");
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
        canonicalCommand: ["lattice", "inspect", "references", "src/models.ts", "GreetingModel"],
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
    assert.equal(commandRouterManifest.packageName, "@the-open-engine/lattice-cli");
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
    assert.deepEqual(commandRouterManifest.bins, ["lattice"]);
    assert.equal(Object.hasOwn(commandRouterManifest, "aliases"), false);
    assert.equal(Object.hasOwn(commandRouterManifest, removedLegacyMappingsField), false);
  });

  it("validates Opcore metric reports, history, deltas, and router payloads", () => {
    const report = validateOpcoreMetricReport(validOpcoreMetricReport());
    assert.equal(report.signals[0].count, 2);
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
          canonicalCommand: ["lattice", "check", "all"],
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

  it("validates Opcore init plans and router payloads", () => {
    const plan = validateOpcoreInitPlanPayload(validOpcoreInitPlan());
    assert.equal(plan.actions[0].path, ".opcore/config");
    assert.equal(plan.agentFiles[0], "AGENTS.md");
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
        validateCommandRouterResult({
          ...validRouterResult(),
          owner: "validation",
          canonicalCommand: ["opcore", "init"],
          opcoreInit: plan
        }),
      /runtime owner/
    );
  });

  it("accepts aggregate managed-tool descriptors for canonical lattice artifacts", () => {
    const descriptor = validManagedToolDescriptor();
    assert.equal(validateManagedToolDescriptor(descriptor).descriptorKind, "aggregate_lattice");
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
              path: "../lattice"
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
            group.name === "graph" ? { ...group, canonicalCommand: ["graph", "lattice"] } : group
          )
        }),
      /canonicalCommand/
    );
    assert.throws(
      () =>
        validateManagedToolDescriptor({
          ...validManagedToolDescriptor(),
          commandGroups: validManagedToolDescriptor().commandGroups.map((group) =>
            group.name === "edit" ? { ...group, packageName: "@the-open-engine/lattice-cli" } : group
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
      provider: "lattice-graph",
      schemaVersion: 1,
      failure: {
        category: "provider_missing",
        message: "graph provider not implemented"
      }
    };
    const request = validateCommandAdapterRequest({
      schemaVersion: 1,
      bin: "lattice",
      argv: ["graph", "status", "--json"],
      args: ["status"],
      json: true,
      group,
      canonicalCommand: ["lattice", "graph", "status"]
    });
    assert.equal(request.group.name, "graph");
    const routed = await routeCommandAdapter({
      bin: "lattice",
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
    assert.equal(routed.providerStatus.provider, "lattice-graph");
    assert.equal(routed.exitCode, 2);
    const serveRouted = validateCommandRouterResult({
      ...validRouterResult(),
      canonicalCommand: ["lattice", "graph", "serve"],
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
                      currentUsage: { lattice: true, orchestra: true, covibes: false }
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
      canonicalCommand: ["lattice", "check", "manifest"],
      validationResult: validValidationResult(),
      validationStatus
    });
    assert.equal(validationRouted.validationResult.status, "passed");
    const receipt = validatePreWriteValidationReceipt(validPreWriteValidationReceipt());
    assert.equal(receipt.kind, "pre_write_validation");
    const preWriteRouted = validateCommandRouterResult({
      ...validRouterResult(),
      owner: "validation",
      canonicalCommand: ["lattice", "validate", "pre-write"],
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
      canonicalCommand: ["lattice", "edit", "exact"],
      editPlan,
      editResult: validEditCommandResult()
    });
    assert.equal(editRouted.editPlan.changes[0].path, "src/index.ts");
    assert.throws(
      () =>
        validateCommandRouterResult({
          ...validRouterResult(),
          owner: "edit",
          canonicalCommand: ["lattice", "edit", "exact"],
          message: "{\"planId\":\"edit-plan-1\",\"changes\":[]}"
        }),
      /editPlan\/editResult/
    );
    assert.throws(
      () =>
        validateCommandAdapterRequest({
          ...request,
          canonicalCommand: ["lattice", "status"]
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
            entry.id === "lattice-graph-build"
              ? { ...entry, bin: "old-graph", command: ["graph", "build"], canonicalCommand: ["lattice", "graph", "build"] }
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
    assert.deepEqual(receipt.commandGroups, releaseReceiptCommandGroups);
    assert.deepEqual(receipt.reports.map((entry) => entry.id), releaseReceiptReportIds);
    assert.equal(receipt.packages.length, releaseReceiptPackageNames.length);
    assert.throws(
      () =>
        validateReleaseReceipt({
          ...receipt,
          packages: receipt.packages.filter((entry) => entry.packageName !== "@the-open-engine/lattice-edit")
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
            entry.packageName === "@the-open-engine/lattice-cli"
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
          installedPackages: receipt.installedPackages.filter((entry) => entry.packageName !== "@the-open-engine/lattice-edit")
        }),
      /portable installed package evidence/
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
          commandReceipts: receipt.commandReceipts.map((entry) =>
            entry.id === "validate-pre-write-fail"
              ? {
                  ...entry,
                  command: ["lattice", "status"],
                  canonicalCommand: ["lattice", "status"],
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
          inputEvidence: receipt.inputEvidence.filter((entry) => entry.issue !== "#58")
        }),
      /input evidence issues/
    );
  });

  it("accepts ASP dogfood receipts and rejects authority, entrypoint, parity, and guardrail overclaims", () => {
    const receipt = validAspDogfoodReceipt();
    assert.equal(validateAspDogfoodReceipt(receipt).issue, "#120");
    assert.equal(receipt.bootstrapSource, "local-sibling");
    assert.deepEqual(receipt.provider.command, ["opcore-asp-provider", "--stdio"]);
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
            command: ["lattice", "asp", "serve"],
            entrypoint: { transport: "stdio", bin: "lattice", args: ["asp", "serve"] }
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
              canonicalCommand: ["lattice", "graph"],
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
    packageName: "@the-open-engine/lattice-cli",
    bins: ["lattice", "opcore"],
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
        canonicalCommand: ["lattice", "graph"],
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
      provider: "lattice-graph",
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
    nextActions: ["lattice check changed --repo /repo --json"]
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
      provider: "lattice-graph"
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
    descriptorKind: "aggregate_lattice",
    aggregateIdentity: {
      name: "lattice",
      releaseLine: "lattice",
      packageName: "@the-open-engine/lattice-cli"
    },
    packageIdentity: {
      packageName: "@the-open-engine/lattice-cli",
      artifactName: "@the-open-engine/lattice-cli",
      version: "0.1.0-alpha.0"
    },
    entrypoints: [
      {
        bin: "lattice",
        packageName: "@the-open-engine/lattice-cli",
        path: "dist/index.js",
        command: ["lattice"]
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
      canonicalCommand: ["lattice", name],
      commands,
      packageName:
        name === "graph"
          ? "@the-open-engine/lattice-graph"
          : name === "edit"
            ? "@the-open-engine/lattice-edit"
            : name === "check" || name === "validate"
              ? "@the-open-engine/lattice-validation"
              : "@the-open-engine/lattice-cli"
    })),
    healthProbes: [
      {
        id: "status-json",
        command: ["lattice", "status", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "doctor-json",
        command: ["lattice", "doctor", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "graph-status-json",
        command: ["lattice", "graph", "status", "--json"],
        expectedExitCode: 0,
        output: "json"
      },
      {
        id: "check-manifest-json",
        command: ["lattice", "check", "manifest", "--json"],
        expectedExitCode: 0,
        output: "json"
      }
    ],
    capabilities: {
      graph: {
        provider: "lattice-graph",
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
        packageName: "@the-open-engine/lattice-cli",
        path: "dist/index.js",
        type: "entrypoint",
        required: true
      },
      {
        id: "descriptor",
        packageName: "@the-open-engine/lattice-cli",
        path: "dist/descriptors/lattice.managed-tool.json",
        type: "descriptor",
        required: true
      },
      {
        id: "contracts-schema",
        packageName: "@the-open-engine/lattice-contracts",
        path: "schemas/lattice-contracts.schema.json",
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
    binaryPath: "lattice-graph-core",
    metadataPath: "metadata.json",
    checksumPath: "lattice-graph-core.sha256",
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
    artifactName: "lattice-graph-core",
    artifactVersion: "0.1.0-alpha.0",
    targetPlatform: "test",
    binaryPath: "dist/native/test/lattice-graph-core",
    checksumPath: "dist/native/test/lattice-graph-core.sha256",
    checksumSha256: "a".repeat(64),
    buildProfile: "release"
  };
}

function validHandshake() {
  return {
    provider: "lattice-graph",
    graphSchemaVersion: 1,
    artifactName: "lattice-graph-core",
    artifactVersion: "0.1.0-alpha.0",
    targetPlatform: "test",
    supportedOperations: ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"],
    nodeKinds: ["repo", "package", "file", "symbol", "test", "File", "Class", "Function", "Type", "Test", "Variable"],
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
      repoId: "lattice"
    },
    scope: {
      kind: "files",
      files: ["src/index.ts"]
    },
    graph: {
      mode: "required",
      provider: "lattice-graph"
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
    lattice: false,
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
    canonicalCommand: ["lattice", "validate", "pre-write", "--request-file", "request.json", "--timeout-ms", "30000"],
    generatedAt: "2026-06-05T00:00:00.000Z",
    durationMs: 12,
    timeoutMs: 30000,
    ok: true,
    requestId: "validation-1",
    repo: {
      repoId: "lattice"
    },
    scope: {
      kind: "files",
      files: ["src/index.ts"]
    },
    checks: ["typescript.syntax"],
    graph: {
      mode: "required",
      provider: "lattice-graph",
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
    provider: "lattice-graph",
    schemaVersion: 1,
    repo: {
      repoId: "lattice"
    },
    freshness: {
      generatedAt: "2026-06-05T00:00:00.000Z",
      ageMs: 0,
      stale: false
    }
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
    provider: "lattice-graph",
    schemaVersion: 1,
    failure: {
      category,
      message: `${state} failure`
    }
  };
  if (state === "stale") {
    status.repo = {
      repoId: "lattice"
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
      repoId: "lattice"
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
      repoId: "lattice"
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
      provider: "lattice-graph",
      schemaVersion: 1,
      repo: {
        repoId: "lattice"
      },
      freshness: {
        generatedAt: "2026-06-04T00:00:00.000Z",
        ageMs: 0,
        stale: false
      }
    },
    metadata: {
      schemaVersion: 1,
      provider: "lattice-graph",
      repo: {
        repoId: "lattice"
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
    protocol: "lattice.graph.daemon",
    transport: "stdio",
    state: "ready",
    repo: {
      repoId: "lattice"
    },
    provider: "lattice-graph",
    pid: 1234,
    artifact: validArtifactMetadata(),
    message: "graph serve stdio transport ready"
  };
}

function validWarmingStatus() {
  return {
    state: "warming",
    mode: "required",
    provider: "lattice-graph",
    schemaVersion: 1,
    repo: {
      repoId: "lattice"
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
      repoId: "lattice"
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
    bin: "lattice",
    argv: ["graph", "status", "--json"],
    canonicalCommand: ["lattice", "status"],
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
        canonicalCommand: ["lattice", "graph", "status"],
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
        nodeKinds: ["File"],
        edgeKinds: ["CALLS"],
        directReaderQueries: ["status-counts"],
        fixtures: ["sqlite-fixtures"]
      }
    ],
    daemonFixtures: [
      {
        id: "daemon-hot-query",
        classification: "required",
        fixture: "packages/fixtures/graph-reference-evidence/daemon-socket-fixtures.json",
        protocol: "lattice.graph.daemon",
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
      implementationPackageNames: ["@the-open-engine/lattice-graph"],
      allowedMentionPaths: ["docs/graph-reference-evidence/", "packages/fixtures/graph-reference-evidence/"]
    }
  };
}

function validGraphReleaseReceipt() {
  const commandCoverage = graphReleaseCoreCommandIds.map((id) => {
    const command = id.replace("lattice-graph-", "");
    return {
      id,
      bin: "lattice",
      command: ["graph", command],
      canonicalCommand: ["lattice", "graph", command],
      status: "passed",
      exitCode: 0,
      fixture: "packages/fixtures/source-extraction/wave1",
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
        packageName: "@the-open-engine/lattice-graph",
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
        protocol: "lattice.graph.daemon",
        operation: "ping",
        status: "passed",
        exitCode: 0
      },
      {
        id: "serve-jsonl-status",
        protocol: "lattice.graph.daemon",
        operation: "status",
        status: "passed",
        exitCode: 0
      },
      {
        id: "serve-jsonl-query",
        protocol: "lattice.graph.daemon",
        operation: "query",
        status: "passed",
        exitCode: 0
      },
      {
        id: "serve-jsonl-search",
        protocol: "lattice.graph.daemon",
        operation: "search",
        status: "passed",
        exitCode: 0
      },
      {
        id: "serve-jsonl-shutdown",
        protocol: "lattice.graph.daemon",
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
      packageName: "@the-open-engine/lattice-graph",
      tarballName: "covibes-lattice-graph-0.1.0-alpha.0.tgz",
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
        binaryPath: "lattice-graph-core",
        checksumPath: "lattice-graph-core.sha256",
        checksumSha256: "e".repeat(64)
      },
      binaryPath: "lattice-graph-core",
      checksumPath: "lattice-graph-core.sha256",
      metadataPath: "metadata.json",
      binarySha256: "e".repeat(64),
      checksumFileSha256: "f".repeat(64),
      metadataSha256: "a".repeat(64),
      packageFiles: ["package.json", "README.md", "lattice-graph-core", "lattice-graph-core.sha256", "metadata.json"]
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
    ["@the-open-engine/lattice-contracts", "packages/contracts"],
    ["@the-open-engine/opcore", "packages/opcore"],
    ["@the-open-engine/lattice-cli", "packages/cli"],
    ["@the-open-engine/lattice-graph", "packages/graph"],
    ...graphCoreNativeSupportedTargets.map((target) => [
      graphCoreNativePackageNameForTarget(target),
      `packages/${graphCoreNativePackageNameForTarget(target).replace("@the-open-engine/", "")}`
    ]),
    ["@the-open-engine/lattice-edit", "packages/edit"],
    ["@the-open-engine/lattice-validation", "packages/validation"],
    ["@the-open-engine/lattice-validation-rust", "packages/validation-rust"],
    ["@the-open-engine/lattice-validation-typescript", "packages/validation-typescript"],
    ["@the-open-engine/opcore-asp-provider", "packages/asp-provider"],
    ["@the-open-engine/lattice-fixtures", "packages/fixtures"]
  ]);
  const packages = releaseReceiptPackageNames.map((packageName) => {
    const packageRoot = packageRoots.get(packageName);
    const isCli = packageName === "@the-open-engine/lattice-cli";
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
        ...descriptor.artifacts.filter((artifact) => artifact.packageName === packageName).map((artifact) => artifact.path)
      ])
    ];
    const bins = isCli
      ? { lattice: "dist/index.js" }
      : packageName === "@the-open-engine/opcore"
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
        files: nativeTarget ? ["lattice-graph-core", "lattice-graph-core.sha256", "metadata.json", "README.md"] : ["dist", "README.md"],
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
      path: "packages/cli/dist/descriptors/lattice.managed-tool.json",
      packageName: "@the-open-engine/lattice-cli",
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
    }
  }));
  const commandReceipts = [
    ["opcore-scan", ["opcore", "scan"], "runtime"],
    ["opcore-status", ["opcore", "status"], "runtime"],
    ["opcore-check-changed", ["opcore", "check", "changed", "--base", "HEAD", "--checks", "typescript.syntax"], "validation"],
    ["opcore-measure", ["opcore", "measure"], "runtime"],
    ["opcore-try", ["opcore", "try"], "runtime"],
    ["status", ["lattice", "status"], "runtime"],
    ["doctor", ["lattice", "doctor"], "runtime"],
    ["graph-build", ["lattice", "graph", "build"], "graph"],
    ["graph-status", ["lattice", "graph", "status"], "graph"],
    ["graph-query", ["lattice", "graph", "query"], "graph"],
    ["graph-impact", ["lattice", "graph", "impact", "--files", "src/components/GreetingCard.tsx"], "graph"],
    ["graph-review-context", ["lattice", "graph", "review-context", "--files", "src/components/GreetingCard.tsx"], "graph"],
    ["graph-detect-changes", ["lattice", "graph", "detect-changes", "--files", "src/components/GreetingCard.tsx"], "graph"],
    ["graph-search", ["lattice", "graph", "search", "Greeting", "--limit", "5"], "graph"],
    ["graph-serve", ["lattice", "graph", "serve"], "graph"],
    ["inspect-symbols", ["lattice", "inspect", "symbols", "Greeting", "--limit", "5"], "inspect"],
    ["inspect-definition", ["lattice", "inspect", "definition", "GreetingCard"], "inspect"],
    ["inspect-references", ["lattice", "inspect", "references", "function:src/components/GreetingCard.tsx#GreetingCard", "--limit", "5"], "inspect"],
    ["inspect-signature", ["lattice", "inspect", "signature", "function:src/components/GreetingCard.tsx#GreetingCard"], "inspect"],
    ["inspect-implementations", ["lattice", "inspect", "implementations", "class:src/models.ts#GreetingModel"], "inspect"],
    ["inspect-search", ["lattice", "inspect", "search", "Greeting", "--limit", "5"], "inspect"],
    [
      "edit-preview",
      [
        "lattice",
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
        "lattice",
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
        "lattice",
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
    ["check-files", ["lattice", "check", "files", "src/cutover.ts", "--checks", "typescript.syntax,typescript.types"], "validation"],
    ["validate-request", ["lattice", "validate", "request", "--request-file", "/tmp/lattice-cutover/project/validate-request.json"], "validation"],
    [
      "validate-pre-write-pass",
      ["lattice", "validate", "pre-write", "--request-file", "/tmp/lattice-cutover/project/pre-write-pass.json", "--timeout-ms", "30000"],
      "validation"
    ],
    [
      "validate-pre-write-fail",
      ["lattice", "validate", "pre-write", "--request-file", "/tmp/lattice-cutover/project/pre-write-fail.json", "--timeout-ms", "30000"],
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
      latticeBinOnly: true,
      oldBinsAbsent: {
        crg: true,
        cix: true,
        rox: true
      }
    },
    commandReceipts,
    negativeChecks: [
      {
        id: "missing-required-graph-check",
        command: ["lattice", "check", "files", "src/index.ts", "--graph-mode", "required"],
        status: "passed",
        exitCode: 0,
        assertion: "required graph failure stayed typed"
      }
    ],
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

function validAspDogfoodReceipt() {
  const cutover = validReleaseCutoverReceipt();
  const aspRepo = covibesPath("agent-server-protocol");
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
          identity: "lattice",
          authority: { granted: false, requirement: "opcore/core-required-check", policyDigest: "sha256:test" }
        }
      ],
      providerProvenance: [{ provider: "opcore", capability: "check", identity: "opcore" }],
      assurance: { mode: "gated", transactionGuarantee: "none" }
    },
    authorityEvidence: [
      {
        identity: "lattice",
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
    provenance: { publisher: "the-open-engine", source: "https://github.com/the-open-engine/lattice", license: "MIT" },
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
      repo: "/repo/lattice",
      mode: "advisory",
      repoAdd: command("asp-repo-add", ["asp", "repo", "add", "/repo/lattice", "--json"]),
      repoEnable: command("asp-repo-enable", ["asp", "repo", "enable", "opcore", "--repo", "/repo/lattice", "--mode", "advisory", "--json"]),
      repoStatus: command("asp-repo-status", ["asp", "repo", "status", "/repo/lattice", "--json"])
    },
    hostEvaluation: {
      check: {
        ...command("asp-check-changed", ["asp", "check", "--repo", "/repo/lattice", "--changed", "--call-site", "interactive", "--json"]),
        hostDecision,
        receipt: hostDecision.receipt,
        assurance: { mode: "gated", transactionGuarantee: "none" }
      },
      ciVerify: command("asp-ci-verify", ["asp", "ci", "verify", "--repo", "/repo/lattice", "--changed-from", "HEAD", "--json"])
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
