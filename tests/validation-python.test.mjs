import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createValidationCheckRegistry, createValidationRunner } from "../packages/validation/dist/index.js";
import {
  PYTHON_DEAD_CODE_CHECK_ID,
  PYTHON_IMPORT_GRAPH_CHECK_ID,
  PYTHON_RELEVANT_TESTS_CHECK_ID,
  PYTHON_SOURCE_HYGIENE_CHECK_ID,
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_TYPES_CHECK_ID,
  createPythonValidationAdapterStatus,
  createPythonValidationChecks,
  validationPythonAdapterName
} from "../packages/validation-python/dist/index.js";

describe("validation-python adapter", () => {
  it("exports stable Python check ids and definitions", () => {
    const checks = createPythonValidationChecks();
    const registry = createValidationCheckRegistry(checks);

    assert.equal(validationPythonAdapterName, "python");
    assert.deepEqual(
      checks.map((check) => check.id),
      [
        PYTHON_SYNTAX_CHECK_ID,
        PYTHON_SOURCE_HYGIENE_CHECK_ID,
        PYTHON_TYPES_CHECK_ID,
        PYTHON_IMPORT_GRAPH_CHECK_ID,
        PYTHON_DEAD_CODE_CHECK_ID,
        PYTHON_RELEVANT_TESTS_CHECK_ID
      ]
    );
    assert.equal(registry.byId.get(PYTHON_SYNTAX_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(PYTHON_SOURCE_HYGIENE_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(PYTHON_IMPORT_GRAPH_CHECK_ID)?.requiresGraph, true);
  });

  it("reports missing Python type tooling as degraded instead of a silent pass", async () => {
    const env = { PATH: "" };
    const status = createPythonValidationAdapterStatus({ env });
    assert.equal(status.status, "degraded");
    assert.equal(status.degradedChecks?.[0]?.checkId, PYTHON_TYPES_CHECK_ID);
    assert.equal(status.degradedChecks?.[0]?.requiredTool, "mypy or pyright");

    const result = await runner({
      files: {
        "pkg/app.py": "value: int = 'wrong'\n"
      },
      checks: createPythonValidationChecks({ env })
    }).runValidation(
      request({
        checks: [PYTHON_TYPES_CHECK_ID]
      })
    );

    assert.equal(result.status, "unsupported_request");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PYTHON_TYPES_UNSUPPORTED"]);
  });

  it("reports syntax diagnostics from overlay after-state content", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "value = 1\n"
      }
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID],
        overlays: [{ path: "pkg/app.py", action: "write", content: "if True\n    value = (1\n" }]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["PY_SYNTAX_MISSING_COLON", "PY_SYNTAX_UNCLOSED_DELIMITER"]
    );
    assert.equal(result.diagnostics[0].path, "pkg/app.py");
  });

  it("reports source-hygiene diagnostics from overlay after-state content", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "value = 1\n"
      }
    }).runValidation(
      request({
        checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID],
        overlays: [
          {
            path: "pkg/app.py",
            action: "write",
            content: ["# type: ignore", "# noqa", "# fmt: off", "value = 1", ""].join("\n")
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["PY_SOURCE_FORMATTER_DISABLED", "PY_SOURCE_NOQA_BROAD", "PY_SOURCE_TYPE_IGNORE"]
    );
  });

  it("reports missing Python IMPORTS_FROM graph edges for resolved repo imports", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "from .dep import value\nresult = value\n",
        "pkg/dep.py": "value = 1\n"
      },
      graphProviderClient: graphClient({
        factQuery: (query) => availableFactResult(query, [], [])
      })
    }).runValidation(
      request({
        checks: [PYTHON_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_IMPORT_GRAPH_MISSING_EDGE"]);
    assert.match(result.diagnostics[0].message, /pkg\/app\.py -> pkg\/dep\.py/);
  });

  it("reports exported callable Python symbols without incoming CALLS as unused exports", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "def public_api():\n    return 1\n"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "function:pkg/app.py#public_api",
                    kind: "Function",
                    path: "pkg/app.py",
                    name: "public_api",
                    attributes: { exported: true, exportPolicy: "leading-underscore" }
                  }
                ]
              : [],
            []
          )
      })
    }).runValidation(
      request({
        checks: [PYTHON_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_DEAD_CODE_UNUSED_EXPORT"]);
  });

  it("reports unsupported Python dead-code coverage when export metadata is absent", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "def public_api():\n    return 1\n"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "function:pkg/app.py#public_api",
                    kind: "Function",
                    path: "pkg/app.py",
                    name: "public_api",
                    attributes: {}
                  }
                ]
              : [],
            []
          )
      })
    }).runValidation(
      request({
        checks: [PYTHON_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_DEAD_CODE_UNSUPPORTED"]);
  });

  it("finds relevant Python tests from TESTED_BY graph endpoints", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "def public_api():\n    return 1\n"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            [],
            query.selector.kind === "edges" && query.selector.edgeKinds?.includes("TESTED_BY")
              ? [
                  {
                    kind: "TESTED_BY",
                    from: "function:pkg/app.py#public_api",
                    to: "test:tests/test_app.py#test_public_api"
                  }
                ]
              : []
          )
      })
    }).runValidation(
      request({
        checks: [PYTHON_RELEVANT_TESTS_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_RELEVANT_TESTS_FOUND"]);
  });
});

function runner(options = {}) {
  return createValidationRunner({
    workspace: workspace(options),
    checks: options.checks ?? createPythonValidationChecks(),
    graphProviderClient: options.graphProviderClient
  });
}

function request(overrides = {}) {
  return {
    requestId: "validation-python-1",
    repo: {
      repoId: "opcore-python-test"
    },
    scope: {
      kind: "files",
      files: ["pkg/app.py"]
    },
    graph: {
      mode: "optional",
      provider: "opcore-graph"
    },
    overlays: [],
    checks: [PYTHON_SYNTAX_CHECK_ID],
    ...overrides
  };
}

function workspace(options = {}) {
  const files = new Map(Object.entries(options.files ?? { "pkg/app.py": "value = 1\n" }));
  return {
    readFile: (path) => (files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }),
    listChangedFiles: () => ({ files: [...files.keys()] }),
    listStagedFiles: () => ({ files: [...files.keys()] }),
    listRepoFiles: () => ({ files: [...files.keys()] }),
    listPackageFiles: (_packageName, packageRoot) => ({
      files: [...files.keys()].filter((path) => path.startsWith(`${packageRoot}/`))
    })
  };
}

function graphClient(overrides = {}) {
  return {
    status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
    factQuery: (query) => availableFactResult(query, [], []),
    namedQuery: () => {
      throw new Error("unexpected namedQuery");
    },
    impact: () => {
      throw new Error("unexpected impact");
    },
    reviewContext: () => {
      throw new Error("unexpected reviewContext");
    },
    detectChanges: () => {
      throw new Error("unexpected detectChanges");
    },
    ...overrides
  };
}

function availableStatus(mode = "optional", repo = { repoId: "opcore-python-test" }) {
  return {
    state: "available",
    mode,
    provider: "opcore-graph",
    schemaVersion: 1,
    repo,
    freshness: freshness(),
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function availableFactResult(query, nodes, edges, metadataOverrides = {}) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: {
      schemaVersion: 1,
      provider: "opcore-graph",
      repo: query.repo,
      generatedAt: "2026-06-05T00:00:00.000Z",
      freshness: freshness(),
      nodeKinds: ["File", "Module", "Class", "Function", "Variable"],
      edgeKinds: ["IMPORTS_FROM", "CALLS", "TESTED_BY"],
      ...metadataOverrides
    },
    nodes,
    edges
  };
}

function freshness(overrides = {}) {
  return {
    generatedAt: "2026-06-05T00:00:00.000Z",
    ageMs: 0,
    stale: false,
    ...overrides
  };
}
