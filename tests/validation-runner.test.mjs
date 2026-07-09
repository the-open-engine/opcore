import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createValidationRunner } from "../packages/validation/dist/index.js";

describe("validation runner", () => {
  it("returns invalid_payload for malformed requests without throwing validator errors", async () => {
    const result = await runner([check("types")]).runValidation({
      repo: {
        repoId: "opcore"
      },
      scope: {
        kind: "files",
        files: []
      },
      graph: {
        mode: "optional"
      },
      overlays: []
    });

    assert.equal(result.status, "invalid_payload");
    assert.equal(result.failure.category, "invalid_payload");
    assert.match(result.failure.cause, /files/);
  });

  it("fails closed for required graph provider failures", async () => {
    for (const status of [
      graphFailure("required_missing", "provider_missing"),
      graphFailure("stale", "stale_snapshot"),
      graphFailure("schema_mismatch", "schema_mismatch"),
      graphFailure("daemon_unavailable", "daemon_unavailable"),
      graphFailure("error", "incompatible_provider"),
      graphFailure("error", "provider_error")
    ]) {
      const result = await runner([check("types")], {
        graphProviderClient: graphClient({
          status: () => status
        })
      }).runValidation(
        request({
          graph: {
            mode: "required",
            provider: "opcore-graph"
          }
        })
      );

      assert.equal(result.status, "provider_failure", status.state);
      assert.equal(result.graphStatus.state, status.state);
      assert.equal(result.failure.category, "provider_failure");
    }
  });

  it("skips graph-required checks in optional graph mode while running enabled checks", async () => {
    const result = await runner([
      check("imports.no-cycles", { requiresGraph: true }),
      check("types", {
        diagnostics: [
          {
            category: "types",
            severity: "warning",
            message: "warning only",
            path: "src/index.ts"
          }
        ]
      })
    ]).runValidation(request({ checks: undefined }));

    assert.equal(result.status, "passed");
    assert.deepEqual(
      result.manifest.runs.map((run) => run.checkId),
      ["types"]
    );
    assert.deepEqual(result.manifest.skippedChecks, [
      {
        checkId: "imports.no-cycles",
        reason: "graph_unavailable",
        message: "Graph provider is not configured"
      }
    ]);
  });

  it("uses aggregate skipped only when no enabled check ran", async () => {
    const result = await runner([check("imports.no-cycles", { requiresGraph: true })]).runValidation(request({ checks: undefined }));

    assert.equal(result.status, "skipped");
    assert.equal(result.failure.category, "skipped");
    assert.deepEqual(
      result.manifest.skippedChecks.map((skip) => skip.checkId),
      ["imports.no-cycles"]
    );
  });

  it("returns skipped when an explicit empty check request enables no checks", async () => {
    const result = await runner([check("types")]).runValidation(request({ checks: [] }));

    assert.equal(result.status, "skipped");
    assert.equal(result.ok, false);
    assert.equal(result.failure.category, "skipped");
    assert.deepEqual(result.manifest.checks, []);
    assert.deepEqual(result.manifest.runs, []);
  });

  it("returns unsupported_request for unknown checks and unsupported scopes", async () => {
    assert.equal((await runner([check("types")]).runValidation(request({ checks: ["missing"] }))).status, "unsupported_request");
    assert.equal(
      (
        await runner([
          check("types", {
            supportedScopes: ["files"]
          })
        ]).runValidation(
          request({
            checks: undefined,
            scope: {
              kind: "repo"
            }
          })
        )
      ).status,
      "unsupported_request"
    );
  });

  it("maps workspace and check throws to infrastructure_failure with cause metadata", async () => {
    const workspaceResult = await createValidationRunner({
      workspace: {
        listRepoFiles: () => {
          throw new Error("workspace unavailable");
        }
      },
      checks: [check("types")]
    }).runValidation(
      request({
        scope: {
          kind: "repo"
        },
        checks: undefined
      })
    );
    const checkResult = await runner([
      check("types", {
        run: () => {
          throw new Error("check crashed");
        }
      })
    ]).runValidation(request());

    assert.equal(workspaceResult.status, "infrastructure_failure");
    assert.match(workspaceResult.failure.cause, /workspace unavailable/);
    assert.equal(checkResult.status, "infrastructure_failure");
    assert.match(checkResult.failure.cause, /check crashed/);
  });

  it("derives policy_failure from error diagnostics and passes warning-only diagnostics", async () => {
    const policy = await runner([
      check("types", {
        diagnostics: [
          {
            category: "types",
            severity: "error",
            message: "type mismatch",
            path: "src/index.ts"
          }
        ]
      })
    ]).runValidation(request());
    const warning = await runner([
      check("types", {
        diagnostics: [
          {
            category: "types",
            severity: "warning",
            message: "warning only",
            path: "src/index.ts"
          }
        ]
      })
    ]).runValidation(request());

    assert.equal(policy.status, "policy_failure");
    assert.equal(policy.failure.category, "policy_failure");
    assert.equal(warning.status, "passed");
    assert.equal(warning.ok, true);
  });

  it("stops running checks after the first policy failure when fail-fast is enabled", async () => {
    const observed = [];
    const result = await createValidationRunner({
      workspace: testWorkspace(),
      failFast: true,
      checks: [
        check("types", {
          run: () => {
            observed.push("types");
            return {
              diagnostics: [
                {
                  category: "types",
                  severity: "error",
                  message: "type mismatch",
                  path: "src/index.ts"
                }
              ]
            };
          }
        }),
        check("lint", {
          run: () => {
            observed.push("lint");
            return { diagnostics: [] };
          }
        })
      ]
    }).runValidation(request({ checks: ["types", "lint"] }));

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(observed, ["types"]);
    assert.deepEqual(
      result.manifest.runs.map((run) => run.checkId),
      ["types"]
    );
  });

  it("streams each completed check result in order", async () => {
    const events = [];
    const result = await createValidationRunner({
      workspace: testWorkspace(),
      onCheckComplete: (event) => events.push(event),
      checks: [
        check("types", {
          diagnostics: [
            {
              category: "types",
              severity: "warning",
              message: "warning only",
              path: "src/index.ts"
            }
          ]
        }),
        check("lint")
      ]
    }).runValidation(request({ checks: ["types", "lint"] }));

    assert.equal(result.status, "passed");
    assert.deepEqual(
      events.map((event) => [event.kind, event.checkId, event.status, event.diagnostics.length]),
      [
        ["validation.check", "types", "passed", 1],
        ["validation.check", "lint", "passed", 0]
      ]
    );
  });

  it("reports only diagnostics introduced by overlays in introduced report mode", async () => {
    const result = await runner([
      check("types", {
        run: async (context) => {
          const after = await context.fileView.readAfter("src/index.ts");
          const diagnostics = [
            {
              category: "types",
              severity: "error",
              message: "existing mismatch",
              path: "src/index.ts",
              code: "TS_EXISTING"
            }
          ];
          if (after.status === "found" && after.content.includes("introduced")) {
            diagnostics.push({
              category: "types",
              severity: "error",
              message: "introduced mismatch",
              path: "src/index.ts",
              code: "TS_INTRODUCED"
            });
          }
          return { diagnostics };
        }
      })
    ]).runValidation(
      request({
        reportMode: "introduced",
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: "export const value = 'introduced';"
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["TS_INTRODUCED"]
    );
    assert.equal(result.manifest.runs[0].diagnosticCount, 1);
  });

  it("fail-fast in introduced report mode stops only after an introduced policy failure", async () => {
    const observed = [];
    const events = [];
    const result = await createValidationRunner({
      workspace: testWorkspace(),
      failFast: true,
      onCheckComplete: (event) => events.push(event),
      checks: [
        introducedAwareCheck("existing", observed),
        introducedAwareCheck("introduced", observed),
        introducedAwareCheck("after-failure", observed)
      ]
    }).runValidation(
      request({
        checks: ["existing", "introduced", "after-failure"],
        reportMode: "introduced",
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: "export const value = 'introduced';"
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(observed, ["existing:before", "existing:after", "introduced:before", "introduced:after"]);
    assert.deepEqual(
      result.manifest.runs.map((run) => [run.checkId, run.status, run.diagnosticCount]),
      [
        ["existing", "passed", 0],
        ["introduced", "policy_failure", 1]
      ]
    );
    assert.deepEqual(
      events.map((event) => [event.checkId, event.status, event.diagnostics.map((diagnostic) => diagnostic.code)]),
      [
        ["existing", "passed", []],
        ["introduced", "policy_failure", ["INTRODUCED"]]
      ]
    );
  });

  it("strips overlay metadata from the introduced report-mode before pass", async () => {
    const observed = [];
    const result = await runner([
      check("types", {
        run: async (context) => {
          const after = await context.fileView.readAfter("src/index.ts");
          const hasOverlay = context.fileView.hasOverlay("src/index.ts");
          observed.push({ hasOverlay, overlayCount: context.request.overlays.length });
          return {
            diagnostics:
              after.status === "found" && hasOverlay
                ? [
                    {
                      category: "types",
                      severity: "error",
                      message: "introduced overlay-aware mismatch",
                      path: "src/index.ts",
                      code: "TS_OVERLAY"
                    }
                  ]
                : []
          };
        }
      })
    ]).runValidation(
      request({
        reportMode: "introduced",
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: "export const value = 'introduced';"
          }
        ]
      })
    );

    assert.deepEqual(observed, [
      { hasOverlay: false, overlayCount: 0 },
      { hasOverlay: true, overlayCount: 1 }
    ]);
    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["TS_OVERLAY"]
    );
  });

  it("passes when introduced report mode has only pre-existing diagnostics", async () => {
    const result = await runner([
      check("types", {
        diagnostics: [
          {
            category: "types",
            severity: "error",
            message: "existing mismatch",
            path: "src/index.ts",
            code: "TS_EXISTING"
          }
        ]
      })
    ]).runValidation(request({ reportMode: "introduced" }));

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.manifest.runs[0].status, "passed");
    assert.equal(result.manifest.runs[0].diagnosticCount, 0);
  });

  it("orders manifest metadata deterministically with injected timestamps and durations", async () => {
    const clock = sequenceClock([0, 10, 17, 20, 31, 40], "2026-06-05T00:00:00.000Z");
    const result = await createValidationRunner({
      workspace: testWorkspace(),
      clock,
      checks: [check("types"), check("lint")]
    }).runValidation(request({ checks: ["lint", "types"] }));

    assert.equal(result.manifest.generatedAt, "2026-06-05T00:00:00.000Z");
    assert.equal(result.manifest.durationMs, 40);
    assert.deepEqual(result.manifest.checks, ["lint", "types"]);
    assert.deepEqual(
      result.manifest.entries.map((entry) => entry.checkId),
      ["lint", "types"]
    );
    assert.deepEqual(
      result.manifest.runs.map((run) => [run.checkId, run.status, run.durationMs]),
      [
        ["lint", "passed", 7],
        ["types", "passed", 11]
      ]
    );
  });

  it("passes overlay-aware file view to validation checks", async () => {
    let observed;
    const result = await runner([
      check("types", {
        run: async (context) => {
          observed = await context.fileView.readAfter("src/index.ts");
          return { diagnostics: [] };
        }
      })
    ]).runValidation(
      request({
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: "export const value = 'overlay';"
          }
        ]
      })
    );

    assert.equal(result.status, "passed");
    assert.equal(observed.status, "found");
    assert.equal(observed.source, "overlay");
    assert.equal(observed.content, "export const value = 'overlay';");
  });

  it("does not list workspace files when a files-scoped check reads one explicit file", async () => {
    let listFileCalls = 0;
    let observed;
    const workspace = {
      ...testWorkspace(),
      listFiles: () => {
        listFileCalls += 1;
        return {
          files: ["src/index.ts", "src/other.ts"]
        };
      }
    };
    const result = await createValidationRunner({
      workspace,
      checks: [
        check("types", {
          run: async (context) => {
            observed = await context.fileView.readAfter("src/index.ts");
            return { diagnostics: [] };
          }
        })
      ]
    }).runValidation(request());

    assert.equal(result.status, "passed");
    assert.equal(observed.status, "found");
    assert.equal(observed.content, "export const value = 'disk';");
    assert.equal(listFileCalls, 0);
  });

  it("passes a graph query session to graph-aware checks", async () => {
    let observedEdges;
    const result = await runner(
      [
        check("imports.no-cycles", {
          requiresGraph: true,
          graphRequirements: () => [
            {
              operation: "factQuery",
              selector: {
                kind: "edges",
                edgeKinds: ["IMPORTS_FROM"]
              }
            }
          ],
          run: async (context) => {
            observedEdges = await context.graph.importsFrom();
            assert.equal(context.graphStatus.state, "available");
            return { diagnostics: [] };
          }
        })
      ],
      {
        graphProviderClient: graphClient({
          factQuery: (query) =>
            availableFactResult(query, [], [
              {
                id: "import-1",
                kind: "IMPORTS_FROM",
                from: "src/index.ts",
                to: "src/dep.ts"
              }
            ])
        })
      }
    ).runValidation(request({ checks: ["imports.no-cycles"] }));

    assert.equal(result.status, "passed");
    assert.deepEqual(
      observedEdges.map((edge) => edge.id),
      ["import-1"]
    );
  });

  it("skips graph-required checks for optional unavailable provider statuses", async () => {
    for (const status of [
      graphFailure("skipped", "provider_missing", "optional"),
      graphFailure("stale", "stale_snapshot", "optional"),
      graphFailure("schema_mismatch", "schema_mismatch", "optional"),
      graphFailure("daemon_unavailable", "daemon_unavailable", "optional"),
      graphFailure("error", "incompatible_provider", "optional"),
      graphFailure("error", "provider_error", "optional")
    ]) {
      const result = await runner([check("imports.no-cycles", { requiresGraph: true })], {
        graphProviderClient: graphClient({
          status: () => status
        })
      }).runValidation(
        request({
          checks: ["imports.no-cycles"],
          graph: {
            mode: "optional",
            provider: "opcore-graph"
          }
        })
      );

      assert.equal(result.status, "skipped", status.state);
      assert.deepEqual(result.manifest.skippedChecks, [
        {
          checkId: "imports.no-cycles",
          reason: "graph_unavailable",
          message: `${status.state} failure`
        }
      ]);
    }
  });

  it("maps required graph query failures to provider_failure before checks run", async () => {
    let runCount = 0;
    const result = await runner(
      [
        check("imports.no-cycles", {
          requiresGraph: true,
          graphRequirements: () => [
            {
              operation: "factQuery",
              selector: {
                kind: "nodes"
              }
            }
          ],
          run: () => {
            runCount += 1;
          }
        })
      ],
      {
        graphProviderClient: graphClient({
          status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
          factQuery: () => ({
            status: graphFailure("error", "query_failed", "required")
          })
        })
      }
    ).runValidation(
      request({
        checks: ["imports.no-cycles"],
        graph: {
          mode: "required",
          provider: "opcore-graph"
        }
      })
    );

    assert.equal(result.status, "provider_failure");
    assert.equal(result.failure.category, "provider_failure");
    assert.equal(result.failure.cause, "error failure");
    assert.equal(runCount, 0);
  });

  it("maps graph query failures during check execution outside infrastructure_failure", async () => {
    const result = await runner(
      [
        check("imports.no-cycles", {
          requiresGraph: true,
          run: async (context) => {
            await context.graph.facts({ kind: "nodes" });
          }
        })
      ],
      {
        graphProviderClient: graphClient({
          status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
          factQuery: () => ({
            status: graphFailure("error", "query_failed", "required")
          })
        })
      }
    ).runValidation(
      request({
        checks: ["imports.no-cycles"],
        graph: {
          mode: "required",
          provider: "opcore-graph"
        }
      })
    );

    assert.equal(result.status, "provider_failure");
    assert.equal(result.failure.category, "provider_failure");
    assert.deepEqual(result.manifest.runs, [
      {
        checkId: "imports.no-cycles",
        status: "provider_failure",
        durationMs: result.manifest.runs[0].durationMs,
        diagnosticCount: 0,
        failureMessage: "error failure"
      }
    ]);
  });

  it("treats explicit available graph status without a client as unavailable for graph-required checks", async () => {
    let optionalRunCount = 0;
    const optional = await runner([
      check("imports.no-cycles", {
        requiresGraph: true,
        run: () => {
          optionalRunCount += 1;
        }
      })
    ]).runValidation(
      request({
        checks: ["imports.no-cycles"],
        graph: {
          mode: "optional",
          provider: "opcore-graph",
          status: availableStatus("optional")
        }
      })
    );
    const required = await runner([
      check("imports.no-cycles", {
        requiresGraph: true
      })
    ]).runValidation(
      request({
        checks: ["imports.no-cycles"],
        graph: {
          mode: "required",
          provider: "opcore-graph",
          status: availableStatus("required")
        }
      })
    );

    assert.equal(optional.status, "skipped");
    assert.equal(optionalRunCount, 0);
    assert.equal(required.status, "provider_failure");
    assert.equal(required.graphStatus.state, "required_missing");
  });

  it("preserves explicit unavailable graph status without a client", async () => {
    const optionalStatus = graphFailure("stale", "stale_snapshot", "optional");
    const optional = await runner([check("imports.no-cycles", { requiresGraph: true })]).runValidation(
      request({
        checks: ["imports.no-cycles"],
        graph: {
          mode: "optional",
          provider: "opcore-graph",
          status: optionalStatus
        }
      })
    );
    const requiredStatus = graphFailure("schema_mismatch", "schema_mismatch", "required");
    const required = await runner([check("imports.no-cycles", { requiresGraph: true })]).runValidation(
      request({
        checks: ["imports.no-cycles"],
        graph: {
          mode: "required",
          provider: "opcore-graph",
          status: requiredStatus
        }
      })
    );

    assert.equal(optional.status, "skipped");
    assert.equal(optional.graphStatus.state, "stale");
    assert.deepEqual(optional.manifest.skippedChecks, [
      {
        checkId: "imports.no-cycles",
        reason: "graph_unavailable",
        message: "stale failure"
      }
    ]);
    assert.equal(required.status, "provider_failure");
    assert.equal(required.graphStatus.state, "schema_mismatch");
    assert.equal(required.failure.cause, "schema_mismatch");
  });
});

function runner(checks, options = {}) {
  return createValidationRunner({
    workspace: testWorkspace(),
    checks,
    ...options
  });
}

function request(overrides = {}) {
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
      mode: "optional",
      provider: "opcore-graph"
    },
    overlays: [],
    checks: ["types"],
    ...overrides
  };
}

function testWorkspace() {
  const files = new Map([
    ["src/index.ts", "export const value = 'disk';"],
    ["src/changed.ts", "export const changed = true;"],
    ["src/staged.ts", "export const staged = true;"]
  ]);
  return {
    readFile: (path) => (files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }),
    listChangedFiles: () => ({
      files: ["src/changed.ts"]
    }),
    listStagedFiles: () => ({
      files: ["src/staged.ts"]
    }),
    listRepoFiles: () => ({
      files: ["src/index.ts"]
    })
  };
}

function check(id, overrides = {}) {
  return {
    id,
    owner: "validation",
    adapter: "generic",
    defaultSeverity: "error",
    supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
    requiresGraph: false,
    run: () => ({
      diagnostics: overrides.diagnostics ?? []
    }),
    ...overrides
  };
}

function introducedAwareCheck(id, observed) {
  return check(id, {
    run: async (context) => {
      const hasOverlay = context.fileView.hasOverlay("src/index.ts");
      observed.push(`${id}:${hasOverlay ? "after" : "before"}`);
      const after = await context.fileView.readAfter("src/index.ts");
      const diagnostics = [
        {
          category: "types",
          severity: "error",
          message: `${id} existing mismatch`,
          path: "src/index.ts",
          code: "EXISTING"
        }
      ];
      if (id === "introduced" && after.status === "found" && after.content.includes("introduced")) {
        diagnostics.push({
          category: "types",
          severity: "error",
          message: "introduced mismatch",
          path: "src/index.ts",
          code: "INTRODUCED"
        });
      }
      return { diagnostics };
    }
  });
}

function graphClient(overrides = {}) {
  return {
    status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
    factQuery: (query) => availableFactResult(query, [], []),
    namedQuery: () => {
      throw new Error("unused namedQuery");
    },
    impact: () => {
      throw new Error("unused impact");
    },
    reviewContext: () => {
      throw new Error("unused reviewContext");
    },
    detectChanges: () => {
      throw new Error("unused detectChanges");
    },
    ...overrides
  };
}

function availableStatus(mode = "optional", repo = { repoId: "opcore" }) {
  return {
    state: "available",
    mode,
    provider: "opcore-graph",
    schemaVersion: 1,
    repo,
    freshness: {
      generatedAt: "2026-06-05T00:00:00.000Z",
      ageMs: 10,
      stale: false
    },
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function availableFactResult(query, nodes, edges) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: {
      schemaVersion: 1,
      provider: "opcore-graph",
      repo: query.repo,
      generatedAt: "2026-06-05T00:00:00.000Z",
      freshness: {
        generatedAt: "2026-06-05T00:00:00.000Z",
        ageMs: 10,
        stale: false
      },
      nodeKinds: ["File"],
      edgeKinds: ["IMPORTS_FROM"]
    },
    nodes,
    edges
  };
}

function graphFailure(state, category, mode = "required") {
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
      generatedAt: "2026-06-05T00:00:00.000Z",
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

function sequenceClock(values, iso) {
  const queue = [...values];
  return {
    nowMs: () => {
      const value = queue.shift();
      if (value === undefined) throw new Error("clock exhausted");
      return value;
    },
    isoNow: () => iso
  };
}
