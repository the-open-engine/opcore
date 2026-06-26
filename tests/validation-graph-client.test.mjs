import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createValidationGraphQuerySession,
  ValidationGraphProviderError,
  ValidationGraphRequirementError
} from "../packages/validation/dist/index.js";

describe("validation graph client", () => {
  it("exports graph client APIs and exposes helper facts through one cached session", async () => {
    assert.equal(typeof createValidationGraphQuerySession, "function");
    assert.equal(typeof ValidationGraphProviderError, "function");

    const calls = [];
    const client = fakeClient({
      factQuery: (query) => {
        calls.push(query);
        if (query.selector.kind === "edges") {
          return availableFactResult(query, [], graphEdges());
        }
        return availableFactResult(query, graphFileNodes(), []);
      }
    });
    const session = await createValidationGraphQuerySession({ request: request(), client });

    await session.preload([
      {
        operation: "facts",
        selector: {
          kind: "edges",
          edgeKinds: ["TESTED_BY", "CALLS", "IMPORTS_FROM"]
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "nodes",
          nodeKinds: ["File", "file"],
          ids: ["file:src/index.ts"]
        }
      }
    ]);

    assert.equal((await session.metadata())?.provider, "lattice-graph");
    assert.deepEqual(
      (await session.importsFrom()).map((edge) => edge.id),
      ["import-1"]
    );
    assert.deepEqual(
      (await session.calls()).map((edge) => edge.id),
      ["call-1"]
    );
    assert.deepEqual(
      (await session.testedBy()).map((edge) => edge.id),
      ["test-1"]
    );
    assert.equal(await session.fileChecksum("src/index.ts"), `sha256:${"a".repeat(64)}`);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].selector.ids, ["file:src/index.ts"]);
  });

  it("keeps empty available results distinct from provider failures", async () => {
    const emptySession = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => availableFactResult(query, [], [])
      })
    });
    assert.deepEqual(await emptySession.importsFrom(), []);

    const failedSession = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: () => ({
          status: failureStatus("optional", "error", "query_failed")
        })
      })
    });

    await assert.rejects(() => failedSession.facts({ kind: "nodes" }), ValidationGraphProviderError);
  });

  it("returns absent file checksum facts without provider failure", async () => {
    const session = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            [
              {
                id: "src/no-hash.ts",
                kind: "File",
                path: "src/no-hash.ts"
              }
            ],
            []
          )
      })
    });

    assert.equal(await session.fileChecksum("src/missing.ts"), undefined);
    assert.equal(await session.fileChecksum("src/no-hash.ts"), undefined);
  });

  it("queries file helpers with GraphProvider file node ids", async () => {
    const calls = [];
    const session = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => {
          calls.push(query);
          return availableFactResult(query, graphFileNodes(), []);
        }
      })
    });

    assert.equal(await session.fileChecksum("src/index.ts"), `sha256:${"a".repeat(64)}`);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].selector, {
      kind: "nodes",
      nodeKinds: ["File", "file"],
      ids: ["file:src/index.ts"]
    });
  });

  it("maps invalid provider query payloads to typed graph provider errors", async () => {
    const session = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => ({
          status: availableStatus(query.mode, query.repo),
          nodes: [],
          edges: []
        })
      })
    });

    await assert.rejects(
      () => session.facts({ kind: "nodes" }),
      (error) =>
        error instanceof ValidationGraphProviderError &&
        error.status.state === "error" &&
        error.status.failure.category === "query_failed"
    );
  });

  it("normalizes selector cache keys and keeps distinct selectors distinct", async () => {
    const calls = [];
    const session = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => {
          calls.push(query);
          return availableFactResult(query, [], []);
        }
      })
    });

    await session.facts({
      kind: "edges",
      edgeKinds: ["CALLS", "IMPORTS_FROM"],
      ids: ["b", "a"]
    });
    await session.facts({
      kind: "edges",
      ids: ["a", "b"],
      edgeKinds: ["IMPORTS_FROM", "CALLS"]
    });
    await session.facts({
      kind: "edges",
      edgeKinds: ["CALLS"],
      text: "different"
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].selector.edgeKinds, ["CALLS", "IMPORTS_FROM"]);
    assert.deepEqual(calls[0].selector.ids, ["a", "b"]);
  });

  it("treats empty selector arrays as absent filters for cache hits and batching", async () => {
    const factCalls = [];
    const node = {
      id: "file:src/index.ts",
      kind: "File",
      path: "src/index.ts"
    };
    const edge = {
      id: "call-1",
      kind: "CALLS",
      from: "file:src/index.ts",
      to: "fn:index"
    };
    const factSession = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => {
          factCalls.push(query);
          return availableFactResult(query, [node], [edge]);
        }
      })
    });

    const allNodes = await factSession.facts({ kind: "nodes" });
    const emptyArrayNodes = await factSession.facts({ kind: "nodes", nodeKinds: [], ids: [] });
    const allEdges = await factSession.facts({ kind: "edges" });
    const emptyArrayEdges = await factSession.facts({ kind: "edges", edgeKinds: [], ids: [] });

    assert.equal(factCalls.length, 2);
    assert.deepEqual(allNodes.nodes, [node]);
    assert.deepEqual(emptyArrayNodes.nodes, [node]);
    assert.deepEqual(allEdges.edges, [edge]);
    assert.deepEqual(emptyArrayEdges.edges, [edge]);

    const preloadCalls = [];
    const preloadSession = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => {
          preloadCalls.push(query);
          return availableFactResult(query, [], []);
        }
      })
    });

    await preloadSession.preload([
      {
        operation: "factQuery",
        selector: {
          kind: "edges",
          edgeKinds: [],
          ids: []
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "edges",
          edgeKinds: ["CALLS"],
          ids: ["file:src/index.ts"]
        }
      }
    ]);

    assert.equal(preloadCalls.length, 1);
    assert.deepEqual(preloadCalls[0].selector, { kind: "edges" });
  });

  it("preserves endpoint nodes when serving cached edge fact results", async () => {
    const calls = [];
    const endpoint = {
      id: "file:src/index.ts",
      kind: "File",
      path: "src/index.ts"
    };
    const edge = {
      id: "import-1",
      kind: "IMPORTS_FROM",
      from: "file:src/index.ts",
      to: "file:src/dep.ts"
    };
    const session = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => {
          calls.push(query);
          return availableFactResult(query, [endpoint], [edge]);
        }
      })
    });

    const first = await session.facts({ kind: "edges", edgeKinds: ["IMPORTS_FROM"] });
    const second = await session.facts({ kind: "edges", edgeKinds: ["IMPORTS_FROM"] });

    assert.equal(calls.length, 1);
    assert.deepEqual(first.nodes, [endpoint]);
    assert.deepEqual(second.nodes, [endpoint]);
    assert.deepEqual(second.edges, [edge]);
  });

  it("merges compatible nodes and edges requirements into safe batched selectors", async () => {
    const calls = [];
    const session = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => {
          calls.push(query);
          return availableFactResult(query, [], []);
        }
      })
    });

    await session.preload([
      {
        operation: "factQuery",
        selector: {
          kind: "edges",
          edgeKinds: ["IMPORTS_FROM"],
          ids: ["src/a.ts"]
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "edges",
          edgeKinds: ["CALLS"],
          ids: ["src/b.ts"]
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "nodes",
          nodeKinds: ["File"],
          ids: ["src/a.ts"]
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "nodes",
          nodeKinds: ["file"],
          ids: ["src/b.ts"]
        }
      }
    ]);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].selector, {
      kind: "edges",
      edgeKinds: ["CALLS", "IMPORTS_FROM"],
      ids: ["src/a.ts", "src/b.ts"]
    });
    assert.deepEqual(calls[1].selector, {
      kind: "nodes",
      nodeKinds: ["File", "file"],
      ids: ["src/a.ts", "src/b.ts"]
    });
  });

  it("rejects policy-hiding requirement limits unless informational", async () => {
    const calls = [];
    const session = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => {
          calls.push(query);
          return availableFactResult(query, [], []);
        }
      })
    });

    await assert.rejects(
      () =>
        session.preload([
          {
            operation: "factQuery",
            selector: {
              kind: "nodes",
              limit: 1
            }
          }
        ]),
      ValidationGraphRequirementError
    );
    await session.preload([
      {
        operation: "factQuery",
        informational: true,
        selector: {
          kind: "nodes",
          limit: 1
        }
      }
    ]);
    assert.equal(calls.length, 1);
  });

  it("batches large synthetic edge and file-node requirements", async () => {
    const calls = [];
    const session = await createValidationGraphQuerySession({
      request: request(),
      client: fakeClient({
        factQuery: (query) => {
          calls.push(query);
          return availableFactResult(query, [], []);
        }
      })
    });
    const files = Array.from({ length: 100 }, (_, index) => `src/file-${String(index).padStart(3, "0")}.ts`);

    await session.preload([
      {
        operation: "factQuery",
        selector: {
          kind: "edges",
          edgeKinds: ["IMPORTS_FROM", "CALLS", "TESTED_BY"]
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "nodes",
          nodeKinds: ["File", "file"],
          ids: files
        }
      }
    ]);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].selector.edgeKinds, ["CALLS", "IMPORTS_FROM", "TESTED_BY"]);
    assert.equal(calls[1].selector.ids.length, 100);
  });

  it("validates and caches named, impact, review-context, and detect-changes provider calls", async () => {
    const calls = {
      namedQuery: 0,
      impact: 0,
      reviewContext: 0,
      detectChanges: 0
    };
    const session = await createValidationGraphQuerySession({
      request: request({ graph: { mode: "required", provider: "lattice-graph" } }),
      client: fakeClient({
        status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
        namedQuery: (query) => {
          calls.namedQuery += 1;
          return availableNamedQueryResult(query);
        },
        impact: (query) => {
          calls.impact += 1;
          return availableImpactResult(query);
        },
        reviewContext: (query) => {
          calls.reviewContext += 1;
          return availableReviewContextResult(query);
        },
        detectChanges: (query) => {
          calls.detectChanges += 1;
          return availableDetectChangesResult(query);
        }
      })
    });

    await session.namedQuery({ queryKind: "imports_of", target: "src/index.ts" });
    await session.namedQuery({ target: "src/index.ts", queryKind: "imports_of" });
    await session.impact({ files: ["src/index.ts"], baseRef: "main" });
    await session.impact({ baseRef: "main", files: ["src/index.ts"] });
    await session.reviewContext({ files: ["src/index.ts"], baseRef: "main" });
    await session.reviewContext({ baseRef: "main", files: ["src/index.ts"] });
    await session.detectChanges({ files: ["src/index.ts"], baseRef: "main" });
    await session.detectChanges({ baseRef: "main", files: ["src/index.ts"] });

    assert.deepEqual(calls, {
      namedQuery: 1,
      impact: 1,
      reviewContext: 1,
      detectChanges: 1
    });
  });
});

function request(overrides = {}) {
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
      mode: "optional",
      provider: "lattice-graph"
    },
    overlays: [],
    checks: ["types"],
    ...overrides
  };
}

function fakeClient(overrides = {}) {
  return {
    status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
    factQuery: (query) => availableFactResult(query, [], []),
    namedQuery: availableNamedQueryResult,
    impact: availableImpactResult,
    reviewContext: availableReviewContextResult,
    detectChanges: availableDetectChangesResult,
    ...overrides
  };
}

function availableStatus(mode = "optional", repo = { repoId: "lattice" }) {
  return {
    state: "available",
    mode,
    provider: "lattice-graph",
    schemaVersion: 1,
    repo,
    freshness: freshness()
  };
}

function failureStatus(mode, state, category) {
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
    status.freshness = freshness({ stale: true });
  }
  return status;
}

function metadata(query) {
  return {
    schemaVersion: 1,
    provider: "lattice-graph",
    repo: query.repo,
    generatedAt: "2026-06-05T00:00:00.000Z",
    freshness: freshness(),
    nodeKinds: ["File", "file", "Function"],
    edgeKinds: ["IMPORTS_FROM", "CALLS", "TESTED_BY"]
  };
}

function freshness(overrides = {}) {
  return {
    generatedAt: "2026-06-05T00:00:00.000Z",
    ageMs: 1,
    stale: false,
    ...overrides
  };
}

function availableFactResult(query, nodes, edges) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: metadata(query),
    nodes,
    edges
  };
}

function availableNamedQueryResult(query) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: metadata(query),
    queryKind: query.queryKind,
    target: query.target,
    nodes: [],
    edges: [],
    traversal: traversal()
  };
}

function availableImpactResult(query) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: metadata(query),
    changedFiles: query.files,
    impactedFiles: query.files,
    impactedSymbols: [],
    tests: [],
    nodes: [],
    edges: [],
    traversal: traversal()
  };
}

function availableReviewContextResult(query) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: metadata(query),
    changedFiles: query.files ?? [],
    deletedFiles: [],
    renamedFiles: [],
    impactedFiles: query.files ?? [],
    impactedSymbols: [],
    tests: [],
    nodes: [],
    edges: [],
    traversal: traversal()
  };
}

function availableDetectChangesResult(query) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: metadata(query),
    changedFiles: query.files ?? [],
    deletedFiles: [],
    renamedFiles: []
  };
}

function traversal() {
  return {
    maxDepth: 1,
    truncated: false,
    total: 0,
    empty: true
  };
}

function graphFileNodes() {
  return [
    {
      id: "file:src/index.ts",
      kind: "File",
      path: "src/index.ts",
      attributes: {
        sha256: "a".repeat(64)
      }
    }
  ];
}

function graphEdges() {
  return [
    {
      id: "import-1",
      kind: "IMPORTS_FROM",
      from: "src/index.ts",
      to: "src/dep.ts"
    },
    {
      id: "call-1",
      kind: "CALLS",
      from: "fn:index",
      to: "fn:dep"
    },
    {
      id: "test-1",
      kind: "TESTED_BY",
      from: "src/index.ts",
      to: "src/index.test.ts"
    }
  ];
}
