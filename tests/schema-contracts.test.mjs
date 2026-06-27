import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contractSchema = JSON.parse(
  readFileSync(new URL("../packages/contracts/schemas/lattice-contracts.schema.json", import.meta.url), "utf8")
);
const removedLegacyCommandField = `legacy${"Command"}`;
const removedLegacyMappingsField = `legacy${"Mappings"}`;
const graphCoreNativeSupportedTargets = ["darwin-arm64", "darwin-x64", "linux-x64"];
const graphCoreNativePackageNamesByTarget = {
  "darwin-arm64": "@the-open-engine/opcore-graph-core-darwin-arm64",
  "darwin-x64": "@the-open-engine/opcore-graph-core-darwin-x64",
  "linux-x64": "@the-open-engine/opcore-graph-core-linux-x64"
};
const graphCoreNativePackageNames = graphCoreNativeSupportedTargets.map((target) => graphCoreNativePackageNamesByTarget[target]);

function graphCoreNativePackageNameForTarget(target) {
  return graphCoreNativePackageNamesByTarget[target];
}

function isValidDefinition(definitionName, value) {
  return isValid({ $ref: `#/$defs/${definitionName}` }, value);
}

function isValid(schemaNode, value) {
  if (schemaNode === true) return true;
  if (schemaNode === false) return false;
  const node = resolveRef(schemaNode);

  if (node.allOf && !node.allOf.every((child) => isValid(child, value))) return false;
  if (node.anyOf && !node.anyOf.some((child) => isValid(child, value))) return false;
  if (node.oneOf && node.oneOf.filter((child) => isValid(child, value)).length !== 1) return false;
  if (node.not && isValid(node.not, value)) return false;
  if (node.if) {
    const conditionMatches = isValid(node.if, value);
    if (conditionMatches && node.then && !isValid(node.then, value)) return false;
    if (!conditionMatches && node.else && !isValid(node.else, value)) return false;
  }

  if (node.const !== undefined && !Object.is(value, node.const)) return false;
  if (node.enum && !node.enum.some((entry) => Object.is(entry, value))) return false;
  if (node.type && !matchesType(node.type, value)) return false;
  if (node.minLength !== undefined && typeof value === "string" && value.length < node.minLength) return false;
  if (node.minItems !== undefined && Array.isArray(value) && value.length < node.minItems) return false;
  if (node.maxItems !== undefined && Array.isArray(value) && value.length > node.maxItems) return false;
  if (node.minimum !== undefined && typeof value === "number" && value < node.minimum) return false;
  if (node.pattern && typeof value === "string" && !new RegExp(node.pattern).test(value)) return false;
  if (node["x-fileCountEqualsLengthOf"] && isPlainObject(value)) {
    const files = value[node["x-fileCountEqualsLengthOf"]];
    if (!Array.isArray(files) || value.fileCount !== files.length) return false;
  }
  if (node.contains && Array.isArray(value)) {
    const matches = value.filter((item) => isValid(node.contains, item)).length;
    const minimum = node.minContains ?? 1;
    const maximum = node.maxContains ?? Number.POSITIVE_INFINITY;
    if (matches < minimum || matches > maximum) return false;
  }

  if (node.required) {
    if (!isPlainObject(value)) return false;
    for (const key of node.required) {
      if (!Object.hasOwn(value, key)) return false;
    }
  }

  if (node.properties && isPlainObject(value)) {
    for (const [key, child] of Object.entries(node.properties)) {
      if (Object.hasOwn(value, key) && !isValid(child, value[key])) return false;
    }
  }

  if (node.additionalProperties === false && isPlainObject(value)) {
    const knownKeys = new Set(Object.keys(node.properties ?? {}));
    for (const key of Object.keys(value)) {
      if (!knownKeys.has(key)) return false;
    }
  }

  if (node.prefixItems && Array.isArray(value)) {
    for (const [index, child] of node.prefixItems.entries()) {
      if (index < value.length && !isValid(child, value[index])) return false;
    }
  }

  if (Object.hasOwn(node, "items") && Array.isArray(value)) {
    const startIndex = node.prefixItems?.length ?? 0;
    if (node.items === false && value.length > startIndex) return false;
    if (node.items !== false) {
      for (const item of value.slice(startIndex)) {
        if (!isValid(node.items, item)) return false;
      }
    }
  }

  return true;
}

function resolveRef(schemaNode) {
  if (!schemaNode.$ref) return schemaNode;
  const path = schemaNode.$ref.split("/").slice(1);
  let current = contractSchema;
  for (const rawPart of path) {
    current = current[rawPart.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

function matchesType(type, value) {
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationRequestWith(overrides = {}) {
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
    overlays: [
      {
        path: "src/index.ts",
        action: "write",
        content: ""
      }
    ],
    ...overrides
  };
}

function validationResultWith(overrides = {}) {
  const status = overrides.status ?? "passed";
  return {
    ok: status === "passed",
    status,
    diagnostics: [],
    ...overrides
  };
}

function preWriteValidationReceiptWith(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pre_write_validation",
    route: "validate.pre-write",
    canonicalCommand: ["lattice", "validate", "pre-write", "--request-file", "request.json", "--timeout-ms", "30000"],
    generatedAt: "2026-06-05T00:00:00.000Z",
    durationMs: 4,
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
      status: availableStatus
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

function editPlanWith(change) {
  return {
    planId: "plan-1",
    repo: {
      repoId: "lattice"
    },
    changes: [change],
    atomic: {
      strategy: "all_or_nothing"
    },
    validation: {
      required: true,
      request: validationRequestWith()
    }
  };
}

function validEditCommandResult() {
  return {
    ok: true,
    applied: false,
    planId: "plan-1",
    planHash: "sha256:plan",
    matchCount: 1,
    afterState: {
      "src/index.ts": "next"
    },
    validationRequest: validationRequestWith(),
    validation: validationResultWith()
  };
}

const failureStatus = {
  state: "required_missing",
  mode: "required",
  provider: "lattice-graph",
  schemaVersion: 1,
  failure: {
    category: "provider_missing",
    message: "current graph provider missing"
  }
};

const availableStatus = {
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
  nodes_by_kind: {},
  edges_by_kind: {},
  handshake: validHandshake()
};

const warmingStatus = {
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

const graphMetadata = {
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
  nodeKinds: ["File", "Module", "Struct", "Function", "Test"],
  edgeKinds: ["CONTAINS", "IMPORTS_FROM", "CALLS", "IMPLEMENTS", "DEPENDS_ON", "INHERITS"]
};

describe("lattice JSON schema wire constraints", () => {
  it("enforces provider state and mode invariants", () => {
    const failureStatus = {
      provider: "lattice-graph",
      schemaVersion: 1,
      failure: {
        category: "provider_missing",
        message: "current graph provider missing"
      }
    };

    assert.equal(isValidDefinition("GraphProviderStatus", { ...failureStatus, state: "skipped", mode: "optional" }), true);
    assert.equal(isValidDefinition("GraphProviderStatus", { ...failureStatus, state: "skipped", mode: "required" }), false);
    assert.equal(isValidDefinition("GraphProviderStatus", { ...failureStatus, state: "required_missing", mode: "required" }), true);
    assert.equal(isValidDefinition("GraphProviderStatus", { ...failureStatus, state: "required_missing", mode: "optional" }), false);
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...failureStatus,
        state: "required_missing",
        mode: "required",
        failure: {
          category: "stale_snapshot",
          message: "wrong failure"
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...failureStatus,
        state: "stale",
        mode: "required",
        repo: {
          repoId: "lattice"
        },
        freshness: {
          generatedAt: "2026-06-04T00:00:00.000Z",
          ageMs: 10,
          stale: true
        },
        failure: {
          category: "provider_missing",
          message: "wrong failure"
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...failureStatus,
        state: "schema_mismatch",
        mode: "required",
        expectedSchemaVersion: 1,
        actualSchemaVersion: 2,
        failure: {
          category: "provider_error",
          message: "wrong failure"
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...failureStatus,
        state: "daemon_unavailable",
        mode: "required",
        failure: {
          category: "provider_error",
          message: "wrong failure"
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...failureStatus,
        state: "error",
        mode: "required",
        failure: {
          category: "schema_mismatch",
          message: "wrong failure"
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...failureStatus,
        state: "error",
        mode: "required",
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
      }),
      true
    );
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...availableStatus,
        walCheckpoint: {
          walPath: ".lattice/graph/graph.db-wal",
          bytesBefore: 8192,
          bytesAfter: 0,
          budgetBytes: 1,
          checkpointed: true
        }
      }),
      true
    );
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...availableStatus,
        walCheckpoint: {
          walPath: ".lattice/graph/graph.db-wal",
          bytesBefore: -1,
          bytesAfter: 0,
          budgetBytes: 1,
          checkpointed: true
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphProviderStatus", {
        ...failureStatus,
        state: "error",
        mode: "required",
        diagnostics: [
          {
            category: "parser_failed",
            severity: "error",
            message: "parse failed"
          }
        ]
      }),
      false
    );
  });

  it("rejects absolute and parent-directory validation paths", () => {
    assert.equal(isValidDefinition("ValidationRequest", validationRequestWith()), true);
    assert.equal(
      isValidDefinition("ValidationRequest", validationRequestWith({ scope: { kind: "files", files: ["/tmp/a.ts"] } })),
      false
    );
    assert.equal(
      isValidDefinition("ValidationRequest", validationRequestWith({ scope: { kind: "files", files: ["../a.ts"] } })),
      false
    );
    assert.equal(
      isValidDefinition("ValidationRequest", validationRequestWith({ scope: { kind: "files", files: ["\\tmp\\a.ts"] } })),
      false
    );
    assert.equal(
      isValidDefinition(
        "ValidationRequest",
        validationRequestWith({ scope: { kind: "files", files: ["\\\\server\\share\\a.ts"] } })
      ),
      false
    );
    assert.equal(
      isValidDefinition("ValidationRequest", validationRequestWith({ overlays: [{ path: "/tmp/a.ts", action: "write", content: "" }] })),
      false
    );
    assert.equal(
      isValidDefinition("ValidationRequest", validationRequestWith({ overlays: [{ path: "../a.ts", action: "delete" }] })),
      false
    );
    assert.equal(
      isValidDefinition(
        "ValidationRequest",
        validationRequestWith({ overlays: [{ path: "\\tmp\\a.ts", action: "write", content: "" }] })
      ),
      false
    );
  });

  it("accepts all ValidationScope variants and rejects malformed package/changed scopes", () => {
    for (const scope of [
      { kind: "files", files: ["src/index.ts"] },
      { kind: "changed", baseRef: "origin/main" },
      { kind: "staged" },
      { kind: "all" },
      { kind: "repo" },
      { kind: "package", packageName: "@the-open-engine/opcore-contracts", packageRoot: "packages/contracts" }
    ]) {
      assert.equal(isValidDefinition("ValidationRequest", validationRequestWith({ scope })), true);
    }
    assert.equal(isValidDefinition("ValidationRequest", validationRequestWith({ scope: { kind: "files", files: [] } })), false);
    assert.equal(isValidDefinition("ValidationRequest", validationRequestWith({ scope: { kind: "changed", baseRef: "" } })), false);
    assert.equal(
      isValidDefinition(
        "ValidationRequest",
        validationRequestWith({ scope: { kind: "package", packageName: "@the-open-engine/opcore", packageRoot: "../packages" } })
      ),
      false
    );
    assert.equal(
      isValidDefinition("ValidationRequest", validationRequestWith({ scope: { kind: "package", packageName: "@the-open-engine/opcore" } })),
      false
    );
  });

  it("enforces ValidationRequest overlay write/delete shape and graph status mode", () => {
    assert.equal(
      isValidDefinition(
        "ValidationRequest",
        validationRequestWith({
          overlays: [
            { path: "src/index.ts", action: "write", content: "export {};", checksumBefore: "sha256:before" },
            { path: "src/remove.ts", action: "delete", checksumBefore: "sha256:delete" }
          ]
        })
      ),
      true
    );
    assert.equal(
      isValidDefinition("ValidationRequest", validationRequestWith({ overlays: [{ path: "src/index.ts", action: "write" }] })),
      false
    );
    assert.equal(
      isValidDefinition(
        "ValidationRequest",
        validationRequestWith({ overlays: [{ path: "src/index.ts", action: "delete", content: "" }] })
      ),
      false
    );
    assert.equal(
      isValidDefinition(
        "ValidationRequest",
        validationRequestWith({ overlays: [{ path: "src/index.ts", action: "write", content: "", checksumBefore: "" }] })
      ),
      false
    );
    assert.equal(isValidDefinition("ValidationRequest", validationRequestWith({ checks: ["  "] })), false);
    assert.equal(
      isValidDefinition(
        "ValidationRequest",
        validationRequestWith({
          graph: {
            mode: "optional",
            status: failureStatus
          }
        })
      ),
      false
    );
    assert.equal(
      isValidDefinition(
        "ValidationRequest",
        validationRequestWith({
          graph: {
            mode: "optional",
            status: {
              ...failureStatus,
              state: "skipped",
              mode: "optional"
            }
          }
        })
      ),
      true
    );
  });

  it("accepts all ValidationResult statuses and requires typed failure/refusal fields", () => {
    assert.equal(isValidDefinition("ValidationResult", validationResultWith({ status: "passed" })), true);
    assert.equal(isValidDefinition("ValidationResult", { ok: false, status: "passed", diagnostics: [] }), false);
    for (const status of [
      "policy_failure",
      "infrastructure_failure",
      "provider_failure",
      "unsupported_request",
      "invalid_payload",
      "skipped"
    ]) {
      assert.equal(
        isValidDefinition(
          "ValidationResult",
          validationResultWith({
            status,
            failure: {
              category: status,
              message: `${status} happened`
            }
          })
        ),
        true
      );
      assert.equal(
        isValidDefinition(
          "ValidationResult",
          validationResultWith({
            status,
            failure: {
              category: status === "policy_failure" ? "provider_failure" : "policy_failure",
              message: "wrong category"
            }
          })
        ),
        false
      );
      assert.equal(isValidDefinition("ValidationResult", validationResultWith({ status })), false);
    }
    assert.equal(
      isValidDefinition(
        "ValidationResult",
        validationResultWith({
          status: "refused",
          refusal: {
            category: "validation_failed",
            message: "preflight refused"
          }
        })
      ),
      true
    );
    assert.equal(isValidDefinition("ValidationResult", validationResultWith({ status: "refused" })), false);
    assert.equal(
      isValidDefinition(
        "ValidationResult",
        validationResultWith({
          status: "refused",
          failure: {
            category: "policy_failure",
            message: "not allowed"
          },
          refusal: {
            category: "validation_failed",
            message: "preflight refused"
          }
        })
      ),
      false
    );
    assert.equal(
      isValidDefinition(
        "ValidationResult",
        validationResultWith({
          status: "passed",
          failure: {
            category: "skipped",
            message: "not allowed"
          }
        })
      ),
      false
    );
  });

  it("validates ValidationResult check manifest metadata", () => {
    const manifest = {
      schemaVersion: 1,
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
        }
      ],
      runs: [
        {
          checkId: "types",
          status: "passed",
          durationMs: 7,
          diagnosticCount: 0
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

    assert.equal(isValidDefinition("ValidationResult", validationResultWith({ manifest })), true);
    assert.equal(isValidDefinition("ValidationResult", validationResultWith({ manifest: { ...manifest, durationMs: -1 } })), false);
    assert.equal(isValidDefinition("ValidationResult", validationResultWith({ manifest: { ...manifest, checks: ["Types"] } })), false);
    assert.equal(
      isValidDefinition("ValidationResult", validationResultWith({ manifest: { ...manifest, runs: [{ ...manifest.runs[0], status: "failed" }] } })),
      false
    );
    assert.equal(
      isValidDefinition(
        "ValidationResult",
        validationResultWith({
          manifest: {
            ...manifest,
            skippedChecks: [{ ...manifest.skippedChecks[0], reason: "missing_graph" }]
          }
        })
      ),
      false
    );
    assert.equal(
      isValidDefinition(
        "ValidationResult",
        validationResultWith({
          manifest: {
            ...manifest,
            runs: [{ ...manifest.runs[0], status: "infrastructure_failure", failureMessage: "" }]
          }
        })
      ),
      false
    );
  });

  it("rejects absolute and parent-directory edit-change paths", () => {
    assert.equal(isValidDefinition("EditPlan", editPlanWith({ kind: "replace", path: "src/index.ts", content: "" })), true);
    assert.equal(isValidDefinition("EditPlan", editPlanWith({ kind: "replace", path: "/tmp/a.ts", content: "" })), false);
    assert.equal(isValidDefinition("EditPlan", editPlanWith({ kind: "replace", path: "\\tmp\\a.ts", content: "" })), false);
    assert.equal(isValidDefinition("EditPlan", editPlanWith({ kind: "delete", path: "../a.ts" })), false);
    assert.equal(
      isValidDefinition("EditPlan", editPlanWith({ kind: "rename", path: "src/index.ts", toPath: "../next.ts" })),
      false
    );
    assert.equal(
      isValidDefinition("EditPlan", editPlanWith({ kind: "rename", path: "src/index.ts", toPath: "\\\\server\\share\\next.ts" })),
      false
    );
  });

  it("rejects graph data on provider-failure query results", () => {
    assert.equal(isValidDefinition("GraphFactQueryResult", { status: failureStatus }), true);
    assert.equal(isValidDefinition("GraphFactQueryResult", { status: failureStatus, nodes: [], edges: [] }), false);
    assert.equal(isValidDefinition("GraphFactQueryResult", { status: failureStatus, metadata: graphMetadata }), false);
    assert.equal(isValidDefinition("GraphImpactResult", { status: failureStatus }), true);
    assert.equal(isValidDefinition("GraphImpactResult", { status: failureStatus, impactedFiles: [] }), false);
    assert.equal(isValidDefinition("GraphNamedQueryResult", { status: failureStatus, nodes: [] }), false);
    assert.equal(
      isValidDefinition("GraphFactQueryResult", {
        status: availableStatus,
        metadata: graphMetadata,
        nodes: [],
        edges: []
      }),
      true
    );
  });

  it("accepts Rust graph fact kinds while keeping graph kind strings open", () => {
    assert.equal(isValidDefinition("GraphFactNode", { id: "struct:src/lib.rs#Widget", kind: "Struct", path: "src/lib.rs", name: "Widget" }), true);
    assert.equal(isValidDefinition("GraphFactEdge", { kind: "IMPLEMENTS", from: "impl:src/lib.rs#Widget.Display", to: "trait:src/lib.rs#Display" }), true);
    assert.equal(isValidDefinition("GraphFactNode", { id: "custom:src/lib.rs#Thing", kind: "CustomRustKind" }), true);
    assert.equal(isValidDefinition("GraphFactEdge", { kind: "CUSTOM_RUST_EDGE", from: "a", to: "b" }), true);
    assert.equal(isValidDefinition("GraphSnapshotMetadata", graphMetadata), true);
    assert.equal(
      isValidDefinition("GraphFactQueryRequest", {
        ...validGraphFactQueryRequest(),
        selector: {
          kind: "nodes",
          nodeKinds: ["Module", "Struct", "CustomRustKind"],
          edgeKinds: ["IMPLEMENTS", "CUSTOM_RUST_EDGE"]
        }
      }),
      true
    );
  });

  it("accepts graph search envelopes and rejects provider-failure rows", () => {
    const request = {
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
    assert.equal(isValidDefinition("GraphSearchRequest", request), true);
    assert.equal(isValidDefinition("GraphSearchRequest", { ...request, query: "" }), false);
    assert.equal(isValidDefinition("GraphSearchRequest", { ...request, limit: 0 }), false);
    assert.equal(isValidDefinition("GraphSearchRequest", { ...request, files: ["/tmp/models.ts"] }), false);

    const result = {
      requestId: "search-1",
      status: availableStatus,
      metadata: graphMetadata,
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
    assert.equal(isValidDefinition("GraphSearchResult", result), true);
    assert.equal(isValidDefinition("GraphSearchResult", { status: failureStatus }), true);
    assert.equal(isValidDefinition("GraphSearchResult", { status: warmingStatus }), true);
    assert.equal(isValidDefinition("GraphSearchResult", { status: failureStatus, results: [] }), false);
    assert.equal(isValidDefinition("GraphSearchResult", { status: warmingStatus, results: [] }), false);
    assert.equal(isValidDefinition("GraphSearchResult", { status: failureStatus, summary: result.summary }), false);
  });

  it("accepts graph-core daemon envelopes and handshake metadata", () => {
    assert.equal(isValidDefinition("GraphProviderArtifactMetadata", validArtifactMetadata()), true);
    assert.equal(isValidDefinition("GraphProviderCapabilityHandshake", validHandshake()), true);
    assert.equal(
      isValidDefinition("GraphDaemonRequest", {
        protocol: "lattice.graph.daemon",
        requestId: "status-1",
        schemaVersion: 1,
        operation: "status",
        repo: {
          repoId: "lattice"
        },
        idleTimeoutMs: 0
      }),
      true
    );
    assert.equal(
      isValidDefinition("GraphDaemonRequest", {
        protocol: "lattice.graph.daemon",
        requestId: "watch-1",
        schemaVersion: 1,
        operation: "watch",
        repo: {
          repoId: "lattice"
        },
        idleTimeoutMs: -1
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphDaemonRequest", {
        protocol: "lattice.graph.daemon",
        requestId: "query-1",
        schemaVersion: 1,
        operation: "query",
        repo: {
          repoId: "lattice"
        },
        query: validGraphFactQueryRequest()
      }),
      true
    );
    assert.equal(
      isValidDefinition("GraphDaemonRequest", {
        protocol: "lattice.graph.daemon",
        requestId: "search-1",
        schemaVersion: 1,
        operation: "query",
        repo: {
          repoId: "lattice"
        },
        search: {
          requestId: "search-1",
          repo: {
            repoId: "lattice"
          },
          schemaVersion: 1,
          mode: "required",
          query: "Greeting"
        }
      }),
      true
    );
    assert.equal(
      isValidDefinition("GraphDaemonResponse", {
        protocol: "lattice.graph.daemon",
        requestId: "status-1",
        schemaVersion: 1,
        status: availableStatus
      }),
      true
    );
    assert.equal(
      isValidDefinition("GraphWatchLifecycle", {
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
      }),
      true
    );
    assert.equal(
      isValidDefinition("GraphWatchLifecycle", {
        state: "available",
        startedAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.001Z",
        pidPath: "/tmp/lattice/pid",
        statePath: "/tmp/lattice/state.json",
        logPath: "/tmp/lattice/daemon.log",
        pollIntervalMs: 50,
        idleTimeoutMs: -1
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphDaemonResponse", {
        protocol: "legacy",
        requestId: "status-1",
        schemaVersion: 1,
        status: availableStatus
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphProviderCapabilityHandshake", {
        ...validHandshake(),
        supportedOperations: ["edit"]
      }),
      false
    );
    assert.equal(isValidDefinition("GraphServeTransportStatus", validGraphServeTransportStatus()), true);
    assert.equal(
      isValidDefinition("GraphServeTransportStatus", {
        ...validGraphServeTransportStatus(),
        state: "error",
        failure: undefined
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphServeTransportStatus", {
        ...validGraphServeTransportStatus(),
        transport: "tcp"
      }),
      false
    );
  });

  it("accepts command-router manifest and result schemas", () => {
    assert.equal(isValidDefinition("CommandRouterManifest", validRouterManifest()), true);
    assert.equal(isValidDefinition("ManagedToolDescriptor", validManagedToolDescriptor()), true);
    assert.equal(isValidDefinition("CommandRouterResult", validRouterResult()), true);
    assert.equal(isValidDefinition("CommandRouterResult", { ...validRouterResult(), timing: validCommandTiming() }), true);
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        bin: "opcore",
        argv: ["status", "--json"],
        canonicalCommand: ["opcore", "status"],
        repoState: validOpcoreRepoState()
      }),
      true
    );
    assert.equal(isValidDefinition("OpcoreInitPlanPayload", validOpcoreInitPlan()), true);
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        bin: "opcore",
        argv: ["init", "--json"],
        canonicalCommand: ["opcore", "init"],
        opcoreInit: validOpcoreInitPlan()
      }),
      true
    );
    assert.equal(isValidDefinition("InspectRouteResult", validInspectRouteResult()), true);
    assert.equal(
      isValidDefinition("InspectRouteResult", {
        route: "references",
        status: "error",
        providerStatus: failureStatus,
        failure: {
          category: "graph_unavailable",
          message: "graph missing"
        }
      }),
      true
    );
    assert.equal(isValidDefinition("InspectRouteResult", validInspectSignatureResult()), true);
    assert.equal(isValidDefinition("InspectRouteResult", validInspectImplementationResult()), true);
    assert.equal(
      isValidDefinition("InspectRouteResult", {
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
      false
    );
    assert.equal(
      isValidDefinition("InspectRouteResult", {
        route: "signature",
        status: "error",
        target: {
          kind: "node",
          nodeId: "class:src/models.ts#GreetingModel"
        },
        providerStatus: availableStatus,
        failure: {
          category: "language_service_error",
          message: "language service failed"
        }
      }),
      true
    );
    assert.equal(
      isValidDefinition("InspectRouteResult", {
        ...validInspectSignatureResult(),
        providerStatus: failureStatus
      }),
      false
    );
    assert.equal(
      isValidDefinition("InspectRouteResult", {
        route: "implementations",
        status: "error",
        failure: {
          category: "graph_unavailable",
          message: "graph missing"
        },
        implementations: []
      }),
      false
    );
    assert.equal(
      isValidDefinition("InspectRouteResult", {
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
      }),
      true
    );
    assert.equal(
      isValidDefinition("InspectRouteResult", {
        ...validInspectRouteResult(),
        references: [
          {
            ...validInspectRouteResult().references[0],
            span: {
              startLine: 1,
              startColumn: 1,
              endLine: 1
            }
          }
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        owner: "inspect",
        canonicalCommand: ["lattice", "inspect", "references", "src/models.ts", "GreetingModel"],
        providerStatus: availableStatus,
        inspectResult: validInspectRouteResult()
      }),
      true
    );
    assert.equal(isValidDefinition("ValidationStatusPayload", validValidationStatusPayload()), true);
    assert.equal(isValidDefinition("PreWriteValidationReceipt", preWriteValidationReceiptWith()), true);
    assert.equal(
      isValidDefinition("PreWriteValidationReceipt", {
        ...preWriteValidationReceiptWith(),
        ok: false,
        validationStatus: "policy_failure",
        failureSummary: {
          category: "policy_failure",
          message: "Validation checks reported error diagnostics"
        }
      }),
      true
    );
    assert.equal(
      isValidDefinition("PreWriteValidationReceipt", {
        ...preWriteValidationReceiptWith(),
        ok: true,
        failureSummary: {
          category: "policy_failure",
          message: "unexpected"
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("PreWriteValidationReceipt", {
        ...preWriteValidationReceiptWith(),
        ok: false,
        validationStatus: "policy_failure"
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        providerStatus: failureStatus
      }),
      true
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        validationResult: validationResultWith(),
        validationStatus: validValidationStatusPayload(),
        receipt: preWriteValidationReceiptWith()
      }),
      true
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        owner: "edit",
        canonicalCommand: ["lattice", "edit", "exact"],
        editPlan: editPlanWith({ kind: "replace", path: "src/index.ts", content: "next" }),
        editResult: validEditCommandResult()
      }),
      true
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        owner: "edit",
        canonicalCommand: ["lattice", "edit", "exact"],
        editPayload: {}
      }),
      false
    );
    assert.equal(
      isValidDefinition("EditCommandResult", {
        ...validEditCommandResult(),
        matchCount: -1
      }),
      false
    );
    assert.equal(
      isValidDefinition("EditCommandResult", {
        ...validEditCommandResult(),
        validation: {
          ok: true,
          status: "policy_failure",
          diagnostics: []
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("EditCommandResult", {
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
      }),
      true
    );
    assert.equal(
      isValidDefinition("EditCommandResult", {
        ok: false,
        applied: false,
        refusal: {
          category: "conflict",
          message: "apply failed"
        },
        rollback: {
          completed: true,
          restoredPaths: ["../escape.ts"],
          failedPaths: [],
          cleanupFailedPaths: []
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        canonicalCommand: ["lattice", "graph", "serve"],
        owner: "graph",
        graphServe: validGraphServeTransportStatus()
      }),
      true
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        owner: "engine"
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        status: "missing"
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        canonicalCommand: []
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        exitCode: 2
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        status: "not_implemented",
        exitCode: 2.5
      }),
      false
    );
    assert.equal(isValidDefinition("CommandRouterManifest", { ...validRouterManifest(), aliases: [] }), false);
    assert.equal(isValidDefinition("CommandRouterManifest", { ...validRouterManifest(), [removedLegacyMappingsField]: [] }), false);
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        [removedLegacyCommandField]: []
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        providerStatus: {
          ...failureStatus,
          provider: ""
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        bin: "opcore",
        canonicalCommand: ["opcore", "status"],
        repoState: {
          ...validOpcoreRepoState(),
          nextActions: []
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("OpcoreInitPlanPayload", {
        ...validOpcoreInitPlan(),
        actions: [{ ...validOpcoreInitPlan().actions[0], path: "../AGENTS.md" }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("OpcoreInitPlanPayload", {
        ...validOpcoreInitPlan(),
        timings: undefined
      }),
      false
    );
    assert.equal(
      isValidDefinition("OpcoreInitPlanPayload", {
        ...validOpcoreInitPlan(),
        settings: undefined
      }),
      false
    );
    assert.equal(
      isValidDefinition("OpcoreInitPlanPayload", {
        ...validOpcoreInitPlan(),
        interaction: {
          ...validOpcoreInitPlan().interaction,
          promptState: "maybe"
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("OpcoreInitPlanPayload", {
        ...validOpcoreInitPlan(),
        scan: {
          ...validOpcoreInitPlan().scan,
          diagnosticCount: -1
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        owner: "validation",
        canonicalCommand: ["opcore", "init"],
        opcoreInit: validOpcoreInitPlan()
      }),
      false
    );
    assert.equal(
      isValidDefinition("ValidationStatusPayload", {
        ...validValidationStatusPayload(),
        graph: {
          mode: "optional",
          status: failureStatus
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("ValidationStatusPayload", {
        ...validValidationStatusPayload(),
        adapterRegistry: {
          ...validValidationStatusPayload().adapterRegistry,
          adapters: [
            {
              ...validValidationStatusPayload().adapterRegistry.adapters[0],
              degradedChecks: [
                {
                  ...validValidationStatusPayload().adapterRegistry.adapters[0].degradedChecks[0],
                  currentUsage: {
                    lattice: true,
                    orchestra: true,
                    covibes: false
                  }
                }
              ]
            }
          ]
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("ValidationStatusPayload", {
        ...validValidationStatusPayload(),
        adapterRegistry: {
          ...validValidationStatusPayload().adapterRegistry,
          adapters: [
            {
              ...validValidationStatusPayload().adapterRegistry.adapters[0],
              degradedChecks: [
                {
                  ...validValidationStatusPayload().adapterRegistry.adapters[0].degradedChecks[0],
                  currentUsage: {
                    ...retainedRustUsage(),
                    gateway: "yes"
                  }
                }
              ]
            }
          ]
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterManifest", {
        ...validRouterManifest(),
        bins: []
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterManifest", {
        ...validRouterManifest(),
        commandGroups: [
          {
            ...validRouterManifest().commandGroups[0],
            canonicalCommand: []
          }
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterManifest", {
        ...validRouterManifest(),
        commandGroups: [
          {
            ...validRouterManifest().commandGroups[0],
            commands: []
          }
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandRouterManifest", {
        ...validRouterManifest(),
        bins: ["lattice", "inspect"]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        entrypoints: [{ ...validManagedToolDescriptor().entrypoints[0], bin: ["r", "o", "x"].join("") }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        artifacts: [{ ...validManagedToolDescriptor().artifacts[0], path: "/tmp/lattice" }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        artifacts: [{ ...validManagedToolDescriptor().artifacts[0], path: "../dist/index.js" }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        artifacts: [{ ...validManagedToolDescriptor().artifacts[0], path: "~/dist/index.js" }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        artifacts: [{ ...validManagedToolDescriptor().artifacts[0], path: ".ace\\runtime\\bin\\lattice" }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        artifacts: [{ ...validManagedToolDescriptor().artifacts[0], path: ".ace" }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        artifacts: [{ ...validManagedToolDescriptor().artifacts[0], path: "dist/.ace" }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        provenanceHooks: [
          {
            id: "private-runtime-wrapper",
            command: [".ace\\runtime\\bin\\lattice", "status"],
            expectedExitCode: 0
          }
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        commandGroups: validManagedToolDescriptor().commandGroups.map((group) =>
          group.name === "graph" ? { ...group, canonicalCommand: ["graph", "lattice"] } : group
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        commandGroups: validManagedToolDescriptor().commandGroups.filter((group) => group.name !== "doctor")
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        healthProbes: validManagedToolDescriptor().healthProbes.filter((probe) => probe.id !== "status-json")
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        capabilities: {
          ...validManagedToolDescriptor().capabilities,
          validation: {
            ...validManagedToolDescriptor().capabilities.validation,
            graphModes: ["optional"]
          }
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        capabilities: {
          ...validManagedToolDescriptor().capabilities,
          validation: {
            ...validManagedToolDescriptor().capabilities.validation,
            checkRoutes: ["files", "files", "files", "files", "files"]
          }
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        capabilities: {
          ...validManagedToolDescriptor().capabilities,
          validation: {
            ...validManagedToolDescriptor().capabilities.validation,
            validateRoutes: ["request", "request", "request", "request"]
          }
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        capabilities: {
          ...validManagedToolDescriptor().capabilities,
          validation: {
            ...validManagedToolDescriptor().capabilities.validation,
            scopeModes: ["files", "files", "files", "files", "files", "files"]
          }
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        artifacts: validManagedToolDescriptor().artifacts.filter((artifact) => artifact.id !== "descriptor")
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        capabilities: {
          ...validManagedToolDescriptor().capabilities,
          graph: {
            ...validManagedToolDescriptor().capabilities.graph,
            commands: [...validManagedToolDescriptor().capabilities.graph.commands, "coverage"]
          }
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("ManagedToolDescriptor", {
        ...validManagedToolDescriptor(),
        capabilities: {
          ...validManagedToolDescriptor().capabilities,
          edit: {
            ...validManagedToolDescriptor().capabilities.edit,
            commands: [...validManagedToolDescriptor().capabilities.edit.commands, "format"]
          }
        }
      }),
      false
    );
  });

  it("accepts Opcore metric report, history, delta, and router schemas", () => {
    assert.equal(isValidDefinition("OpcoreMetricReport", validOpcoreMetricReport()), true);
    assert.equal(
      isValidDefinition("OpcoreMetricHistoryEntry", {
        schemaVersion: 1,
        kind: "opcore_metric_history_entry",
        recordedAt: "2026-06-25T00:00:01.000Z",
        report: validOpcoreMetricReport()
      }),
      true
    );
    assert.equal(isValidDefinition("OpcoreMeasureDelta", validOpcoreMeasureDelta()), true);
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        bin: "opcore",
        argv: ["measure", "--repo", "/repo", "--json"],
        canonicalCommand: ["opcore", "measure"],
        owner: "runtime",
        opcoreMeasure: validOpcoreMeasureDelta()
      }),
      true
    );
    assert.equal(isValidDefinition("OpcoreTryPayload", validOpcoreTryPayload()), true);
    assert.equal(
      isValidDefinition("CommandRouterResult", {
        ...validRouterResult(),
        bin: "opcore",
        argv: ["try", "--json"],
        canonicalCommand: ["opcore", "try"],
        owner: "runtime",
        opcoreTry: validOpcoreTryPayload()
      }),
      true
    );
    assert.equal(isValidDefinition("OpcoreMetricReport", { ...validOpcoreMetricReport(), score: 100 }), false);
    assert.equal(
      isValidDefinition("OpcoreMetricReport", {
        ...validOpcoreMetricReport(),
        signals: [{ ...validOpcoreMetricReport().signals[0], count: 0 }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("OpcoreMetricReport", {
        ...validOpcoreMetricReport(),
        signals: [{ ...validOpcoreMetricReport().signals[0], evidence: [] }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("OpcoreMetricReport", {
        ...validOpcoreMetricReport(),
        signals: [
          {
            ...validOpcoreMetricReport().signals[0],
            evidence: [{ ...validOpcoreMetricReport().signals[0].evidence[0], path: "" }]
          }
        ]
      }),
      false
    );
    assert.equal(isValidDefinition("OpcoreMeasureDelta", { ...validOpcoreMeasureDelta(), blendedScore: 99 }), false);
  });

  it("accepts latency telemetry and budget schemas", () => {
    assert.equal(isValidDefinition("CommandTiming", validCommandTiming()), true);
    assert.equal(isValidDefinition("RepoShapeFingerprint", validRepoShapeFingerprint()), true);
    assert.equal(isValidDefinition("CommandLatencyRecord", validCommandLatencyRecord()), true);
    assert.equal(isValidDefinition("LatencyBudget", validLatencyBudget()), true);
    assert.equal(isValidDefinition("LatencyBudgetResult", validLatencyBudgetResult()), true);
    assert.equal(isValidDefinition("LatencyBudgetResult", validLatencyBudgetResult({ status: "over" })), true);
    assert.equal(
      isValidDefinition("LatencyTelemetryArtifactPolicy", {
        path: ".opcore/telemetry.jsonl",
        maxRecords: 500,
        maxBytes: 1048576,
        rotation: "ring_buffer"
      }),
      true
    );
    assert.equal(
      isValidDefinition("CommandLatencyRecord", {
        ...validCommandLatencyRecord(),
        repo: { ...validRepoShapeFingerprint(), path: "src/index.ts" }
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandLatencyRecord", {
        ...validCommandLatencyRecord(),
        bin: "/tmp/project/node_modules/.bin/opcore"
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandLatencyRecord", {
        ...validCommandLatencyRecord(),
        canonicalCommand: ["opcore", "check", "files", "src/secret.ts"]
      }),
      false
    );
    assert.equal(
      isValidDefinition("LatencyBudget", {
        ...validLatencyBudget(),
        canonicalCommand: ["opcore", "check", "files", "src/secret.ts"]
      }),
      false
    );
    assert.equal(
      isValidDefinition("LatencyBudget", {
        ...validLatencyBudget(),
        canonicalCommand: ["opcore", "check", "files", "Secret.TS"]
      }),
      false
    );
    assert.equal(
      isValidDefinition("LatencyBudgetResult", {
        ...validLatencyBudgetResult(),
        observed: {
          ...validLatencyBudgetResult().observed,
          canonicalCommand: ["opcore", "check", "files", "src/secret.ts"]
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandLatencyRecord", {
        ...validCommandLatencyRecord(),
        timing: { ...validCommandTiming(), phases: [{ ...validCommandTiming().phases[0], content: "source" }] }
      }),
      false
    );
    assert.equal(isValidDefinition("LatencyBudget", { ...validLatencyBudget(), secret: "token" }), false);
    assert.equal(isValidDefinition("LatencyBudget", { ...validLatencyBudget(), score: 99 }), false);
    assert.equal(
      isValidDefinition("LatencyTelemetryArtifactPolicy", {
        path: ".opcore/telemetry.jsonl",
        maxRecords: 501,
        maxBytes: 1048576,
        rotation: "ring_buffer"
      }),
      false
    );
  });

  it("accepts command adapter request schemas", () => {
    assert.equal(isValidDefinition("CommandAdapterRequest", validCommandAdapterRequest()), true);
    assert.equal(
      isValidDefinition("CommandAdapterRequest", {
        ...validCommandAdapterRequest(),
        [removedLegacyCommandField]: []
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandAdapterRequest", {
        ...validCommandAdapterRequest(),
        canonicalCommand: []
      }),
      false
    );
    assert.equal(
      isValidDefinition("CommandAdapterRequest", {
        ...validCommandAdapterRequest(),
        group: {
          ...validCommandAdapterRequest().group,
          owner: "engine"
        }
      }),
      false
    );
  });

  it("accepts and rejects graph reference evidence manifest schemas", () => {
    const manifest = validGraphReferenceEvidenceManifest();
    assert.equal(isValidDefinition("GraphReferenceEvidenceManifest", manifest), true);
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        issue: "#18"
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        commandSurfaces: []
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        commandSurfaces: [
          {
            ...manifest.commandSurfaces[0],
            classification: "release_blocking"
          }
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        commandSurfaces: [
          {
            ...manifest.commandSurfaces[0],
            fixtures: []
          }
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        optionalAnalysisSurfaces: [
          {
            ...manifest.optionalAnalysisSurfaces[0],
            fixtures: []
          }
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        optionalAnalysisSurfaces: manifest.optionalAnalysisSurfaces.map((surface) =>
          surface.id === "flows" ? { ...surface, issue: "#13" } : surface
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        optionalAnalysisSurfaces: manifest.optionalAnalysisSurfaces.map((surface) =>
          surface.id === "flows" ? { ...surface, classification: "required" } : surface
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        optionalAnalysisSurfaces: manifest.optionalAnalysisSurfaces.map(({ issue, ...surface }) => surface)
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        optionalAnalysisSurfaces: manifest.optionalAnalysisSurfaces.map((surface) => ({ ...surface, fixtures: [] }))
      }),
      true
    );
    assert.equal(
      isValidDefinition("GraphReferenceEvidenceManifest", {
        ...manifest,
        provenance: {
          ...manifest.provenance,
          containsGitHistory: true
        }
      }),
      false
    );
  });

  it("accepts and rejects graph release receipt schemas", () => {
    const receipt = validGraphReleaseReceipt();
    assert.equal(isValidDefinition("GraphReleaseReceipt", receipt), true);
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        graphPackageVersions: [
          {
            packageName: "@the-open-engine/opcore-contracts",
            version: "0.1.0-alpha.0"
          }
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        issue: "#19"
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        benchmarks: receipt.benchmarks.slice(1)
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        benchmarks: [receipt.benchmarks[0], ...receipt.benchmarks.slice(0, -1)]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        commandCoverage: receipt.commandCoverage.map((entry) =>
          entry.id === "lattice-graph-build"
            ? { ...entry, command: ["build"], canonicalCommand: ["lattice", "build"] }
            : entry
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        benchmarks: receipt.benchmarks.map((entry) =>
          entry.metric === "db_size_bytes" ? { ...entry, unit: "ms" } : entry
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        directSqliteQueries: receipt.directSqliteQueries.slice(1)
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        requiredChildren: ["#35", "#8", "#9", "#10", "#11", "#12", "#19", "#99"]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        deferredChildren: ["#99"]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        deferredChildren: ["#13", "#14", "#15"]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        optionalSurfaces: receipt.optionalSurfaces.map((surface) =>
          surface.id === "coverage" ? { ...surface, issue: "#14" } : surface
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        optionalSurfaces: receipt.optionalSurfaces.map((surface) =>
          surface.id === "coverage" ? { ...surface, classification: "required" } : surface
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        optionalSurfaces: receipt.optionalSurfaces.map(({ issue, ...surface }) => surface)
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        serveTransport: receipt.serveTransport.filter((entry) => entry.id !== "serve-jsonl-query")
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        serveTransport: [
          receipt.serveTransport[0],
          ...receipt.serveTransport.filter((entry) => entry.id !== "serve-jsonl-shutdown")
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        serveTransport: receipt.serveTransport.map((entry) =>
          entry.id === "serve-jsonl-query" ? { ...entry, operation: "ping" } : entry
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        handoff: receipt.handoff.filter((entry) => entry.issue !== "#29")
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        handoff: [receipt.handoff[0], ...receipt.handoff.slice(0, -1)]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        reportReceipts: receipt.reportReceipts.filter((entry) => entry.id !== "provenance")
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        reportReceipts: [receipt.reportReceipts[0], ...receipt.reportReceipts.slice(0, -1)]
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        packageInspection: {
          ...receipt.packageInspection,
          files: [...receipt.packageInspection.files, "SETUP.PY"]
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("GraphReleaseReceipt", {
        ...receipt,
        packageInspection: {
          ...receipt.packageInspection,
          fileCount: receipt.packageInspection.files.length + 1
        }
      }),
      false
    );
  });

  it("accepts and rejects release receipt schemas", () => {
    const receipt = validReleaseReceipt();
    assert.equal(isValidDefinition("ReleaseReceipt", receipt), true);
    assert.equal(
      isValidDefinition("ReleaseReceipt", {
        ...receipt,
        packages: receipt.packages.filter((entry) => entry.packageName !== "@the-open-engine/opcore-edit")
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseReceipt", {
        ...receipt,
        commandGroups: receipt.commandGroups.filter((entry) => entry !== "doctor")
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseReceipt", {
        ...receipt,
        packages: receipt.packages.map((entry) =>
          entry.packageName === "@the-open-engine/opcore"
            ? { ...entry, bins: { ...entry.bins, rox: "dist/index.js" } }
            : entry
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseReceipt", {
        ...receipt,
        nativeArtifacts: receipt.nativeArtifacts.map((entry) => ({ ...entry, binarySha256: "not-sha" }))
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseReceipt", {
        ...receipt,
        secretHistory: {
          ...receipt.secretHistory,
          findingCount: 1,
          findings: [
            {
              scope: "current-tree",
              kind: "openai_api_key",
              path: "src/secret.ts",
              fingerprint: "sha256:secret",
              allowlisted: false
            }
          ]
        }
      }),
      false
    );
  });

  it("accepts and rejects cutover receipt schemas", () => {
    const receipt = validReleaseCutoverReceipt();
    assert.equal(isValidDefinition("ReleaseCutoverReceipt", receipt), true);
    assert.equal(isValidDefinition("ReleaseCutoverReceipt", { ...receipt, issue: "#29" }), false);
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
        ...receipt,
        installedPackages: receipt.installedPackages.slice(1)
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
        ...receipt,
        packageNames: [
          "@the-open-engine/opcore-contracts",
          "@the-open-engine/opcore-contracts",
          ...receipt.packageNames.slice(2)
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
        ...receipt,
        installedPackages: [
          receipt.installedPackages[0],
          { ...receipt.installedPackages[0] },
          ...receipt.installedPackages.slice(2)
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
        ...receipt,
        commandReceipts: [
          { ...receipt.commandReceipts[0], status: "not_implemented", exitCode: 2 },
          ...receipt.commandReceipts.slice(1)
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
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
      false
    );
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
        ...receipt,
        commandReceipts: [
          receipt.commandReceipts[0],
          { ...receipt.commandReceipts[0] },
          ...receipt.commandReceipts.slice(2)
        ]
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
        ...receipt,
        installedPackages: receipt.installedPackages.map((entry) =>
          entry.packageName === "@the-open-engine/opcore"
            ? { ...entry, installedManifest: { ...entry.installedManifest, bins: { lattice: "dist/index.js", crg: "dist/index.js" } } }
            : entry
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
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
      false
    );
    assert.equal(
      isValidDefinition("ReleaseCutoverReceipt", {
        ...receipt,
        environmentIsolation: { ...receipt.environmentIsolation, latticeBinOnly: false }
      }),
      false
    );
  });

  it("accepts and rejects ASP dogfood receipt schemas", () => {
    const receipt = validAspDogfoodReceipt();
    assert.equal(isValidDefinition("AspDogfoodReceipt", receipt), true);
    assert.equal(isValidDefinition("AspDogfoodReceipt", { ...receipt, issue: "#30" }), false);
    assert.equal(isValidDefinition("AspDogfoodReceipt", { ...receipt, bootstrapSource: "registry" }), false);
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        hostFixture: { ...receipt.hostFixture, changedPaths: [] }
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        hostFixture: { ...receipt.hostFixture, sourceRepoMutated: true }
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        provider: { ...receipt.provider, command: ["lattice", "asp", "serve"] }
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        hostEvaluation: {
          ...receipt.hostEvaluation,
          check: {
            ...receipt.hostEvaluation.check,
            receipt: {
              receiptId: receipt.hostEvaluation.check.receipt.receiptId,
              providerProvenance: receipt.hostEvaluation.check.receipt.providerProvenance
            }
          }
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        currentToolGuardrails: receipt.currentToolGuardrails.filter((entry) => entry.id !== "current-tools-validate-changed")
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        unsupportedSurfaces: receipt.unsupportedSurfaces.map((entry) =>
          entry.surface === "edit" ? { ...entry, cleanCoverage: true } : entry
        )
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        authority: { ...receipt.authority, providerOutputIsHostDecision: true }
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        publicReleaseActions: [{ action: "publish" }]
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        managerState: {
          ...receipt.managerState,
          serverAdd: { ...receipt.managerState.serverAdd, status: "failed", exitCode: 1 }
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        hostEvaluation: {
          ...receipt.hostEvaluation,
          check: { ...receipt.hostEvaluation.check, status: "failed", exitCode: 1 }
        }
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        providerProbe: { ...receipt.providerProbe, status: "failed", exitCode: 1 }
      }),
      false
    );
    assert.equal(
      isValidDefinition("AspDogfoodReceipt", {
        ...receipt,
        hostEvaluation: {
          ...receipt.hostEvaluation,
          ciVerify: { ...receipt.hostEvaluation.ciVerify, status: "failed", exitCode: 1 }
        }
      }),
      true
    );
  });
});

function validRouterManifest() {
  return {
    schemaVersion: 1,
    packageName: "@the-open-engine/opcore",
    bins: ["lattice"],
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
      status: availableStatus
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
      packageName: "@the-open-engine/opcore"
    },
    packageIdentity: {
      packageName: "@the-open-engine/opcore",
      artifactName: "@the-open-engine/opcore",
      version: "0.1.0-alpha.0"
    },
    entrypoints: [
      {
        bin: "lattice",
        packageName: "@the-open-engine/opcore",
        path: "dist/lattice/index.js",
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
        packageName: "@the-open-engine/opcore",
        path: "dist/lattice/index.js",
        type: "entrypoint",
        required: true
      },
      {
        id: "descriptor",
        packageName: "@the-open-engine/opcore",
        path: "dist/descriptors/lattice.managed-tool.json",
        type: "descriptor",
        required: true
      },
      {
        id: "contracts-schema",
        packageName: "@the-open-engine/opcore-contracts",
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
    optionalSurfaces: [
      { issue: "#13", id: "coverage", classification: "deferred", status: "deferred" },
      { issue: "#14", id: "flows", classification: "optional", status: "deferred" },
      { issue: "#15", id: "communities", classification: "optional", status: "deferred" },
      { issue: "#16", id: "read_only_suggestions", classification: "supporting", status: "deferred" }
    ],
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
      "children_of",
      "file_summary",
      "review_context",
      "detect_changes",
      "search"
    ],
    artifact: validArtifactMetadata()
  };
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
    providerStatus: availableStatus,
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
    providerStatus: availableStatus,
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
    providerStatus: availableStatus,
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
    argv: ["status", "--json"],
    canonicalCommand: ["lattice", "status"],
    owner: "runtime",
    status: "ok",
    exitCode: 0,
    message: "router ready",
    json: true
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
      status: availableStatus
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

function validCommandAdapterRequest() {
  return {
    schemaVersion: 1,
    bin: "lattice",
    argv: ["status", "--json"],
    args: ["status"],
    json: true,
    group: {
      name: "graph",
      owner: "graph",
      canonicalCommand: ["lattice", "graph"],
      commands: ["status"],
      summary: "graph routes"
    },
    canonicalCommand: ["lattice", "graph", "status"]
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
        fixtures: ["sqlite-fixtures"]
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
  const commandIds = [
    "lattice-graph-build",
    "lattice-graph-update",
    "lattice-graph-watch",
    "lattice-graph-status",
    "lattice-graph-query",
    "lattice-graph-impact",
    "lattice-graph-search",
    "lattice-graph-serve"
  ];
  const metrics = [
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
  ];
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
    deferredChildren: ["#13", "#14", "#15", "#16"],
    commandCoverage: commandIds.map((id) => {
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
    }),
    directSqliteQueries: [
      "status-counts",
      "status-edge-counts",
      "impact-edges-from-file",
      "search-by-name",
      "freshness-metadata"
    ].map((id) => ({
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
    benchmarks: metrics.map((metric) => ({
      metric,
      value: 1,
      unit: metric.endsWith("_bytes") ? "bytes" : "ms",
      baselineIssue: "#19",
      baselineReceipt: "packages/fixtures/graph-reference-evidence/baseline-receipts.json",
      comparison: "recorded"
    })),
    packageInspection: {
      packageName: "@the-open-engine/opcore-graph",
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
    handoff: ["#7", "#28", "#29"].map((issue) => ({
      issue,
      receiptPath: "docs/release/graph-release-receipt.payload.json",
      checksumSha256: "b".repeat(64),
      rollbackNote: "Keep ACE wrappers on current external tools if receipt regresses."
    }))
  };
}

function validReleaseReceipt() {
  const packageNames = [
    "@the-open-engine/opcore-contracts",
    "@the-open-engine/opcore",
    "@the-open-engine/opcore-graph",
    ...graphCoreNativePackageNames,
    "@the-open-engine/opcore-edit",
    "@the-open-engine/opcore-validation",
    "@the-open-engine/opcore-validation-python",
    "@the-open-engine/opcore-validation-rust",
    "@the-open-engine/opcore-validation-typescript",
    "@the-open-engine/opcore-asp-provider"
  ];
  const commandGroups = ["graph", "inspect", "edit", "check", "validate", "status", "doctor"];
  const reportIds = ["package-inspection", "license", "provenance", "release-hygiene", "graph-release", "secret-history"];
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
    ["@the-open-engine/opcore-asp-provider", "packages/asp-provider"]
  ]);
  const packages = packageNames.map((packageName) => {
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
      ? { opcore: "dist/index.js", lattice: "dist/lattice/index.js" }
      : packageName === "@the-open-engine/opcore-asp-provider"
        ? { "opcore-asp-provider": "dist/index.js" }
          : {};
    return {
      packageName,
      packageRoot: packageRoots.get(packageName),
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
        path: ".lattice/release/packages/package.tgz",
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
    packageNames,
    commandGroups,
    packages,
    descriptor: {
      path: "packages/opcore/dist/descriptors/lattice.managed-tool.json",
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
      workspacePackageCount: packageNames.length,
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
    reports: reportIds.map((id) => ({
      id,
      command: ["npm", "run", id],
      status: "passed",
      exitCode: 0,
      path: "docs/release/release-receipt.json",
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
    packageNames: releaseReceipt.packageNames,
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
  const markers = ["lattice asp serve", "lattice asp", "dist/bin/lattice", ".ace/runtime"];
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
      authorityEvidence: [{ identity: "lattice" }],
      providerProvenance: [{ provider: "opcore", capability: "check" }],
      assurance: { mode: "gated", transactionGuarantee: "none" }
    },
    authorityEvidence: [{ identity: "lattice" }],
    providerProvenance: [{ provider: "opcore", capability: "check" }],
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
    packageNames: cutover.packageNames,
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
      serverStatus: command("asp-server-status", ["asp", "server", "status", "opcore", "--json"])
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
      markersBlocked: markers
    }
  };
}

function covibesPath(repo) {
  return `${["", "Users", "tom", "code", "covibes"].join("/")}/${repo}`;
}
