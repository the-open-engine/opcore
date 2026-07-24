export const fixtureOrigin = "covibes-authored-synthetic" as const;

export const fixtureIds = [
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
  "source-extraction-python-v1",
  "validation-python-v1",
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
] as const;

export type FixtureId = (typeof fixtureIds)[number];

export interface SyntheticFixtureMetadata {
  id: FixtureId;
  packageTrack:
    | "contracts"
    | "cli"
    | "graph"
    | "edit"
    | "validation"
    | "validation-python"
    | "validation-typescript"
    | "fixtures";
  origin: typeof fixtureOrigin;
  containsSourceCode: boolean;
  issue: "#3" | "#8" | "#10" | "#11" | "#12" | "#17" | "#19" | "#20" | "#21" | "#22" | "#25" | "#28" | "#37" | "#47" | "#100";
  schemaVersion: 1;
  dataFile?: string;
  status:
    | "valid"
    | "stale"
    | "schema_mismatch"
    | "daemon_unavailable"
    | "skipped"
    | "required_missing"
    | "safe_edit"
    | "validation_refusal"
    | "descriptor_discovery"
    | "command_router"
    | "command_adapter"
    | "graph_pipeline"
    | "graph_query"
    | "graph_search"
    | "graph_serve_transport"
    | "inspect_symbol_parity"
    | "validation_python"
    | "validation_contract"
    | "graph_core_artifact_handshake"
    | "source_extraction_wave1"
    | "source_extraction_python"
    | "installed_artifact_smoke"
    | "graph_reference_evidence_manifest"
    | "graph_reference_evidence_sqlite_fixture"
    | "graph_reference_evidence_daemon_socket_fixture"
    | "graph_reference_evidence_golden_corpus"
    | "graph_reference_evidence_baseline_receipts"
    | "graph_release_readiness";
  graph?: {
    nodes: readonly {
      id: string;
      kind: string;
      path?: string;
      name?: string;
    }[];
    edges: readonly {
      kind: string;
      from: string;
      to: string;
    }[];
  };
  providerStatus?: {
    state: string;
    mode: "optional" | "required";
    failure?: {
      category: string;
      message: string;
    };
  };
  editPlan?: {
    changes: readonly {
      kind: string;
      path: string;
      toPath?: string;
    }[];
    atomic: "all_or_nothing";
  };
  validation?: {
    status: string;
    refusalCategory?: string;
    diagnostics: readonly {
      category: string;
      severity: string;
    }[];
  };
  descriptor?: {
    dataFile?: string;
    descriptorKind?: "aggregate_opcore";
    packageName?: "opcore";
    entrypoints: readonly string[];
    commandGroups: readonly string[];
    healthProbes: readonly string[];
    capabilities: readonly string[];
    artifacts: readonly string[];
    checksums: readonly string[];
    provenanceHooks: readonly string[];
    artifactPackages?: readonly string[];
    graphCapabilities?: readonly string[];
    editCapabilities?: readonly string[];
    validationGraphModes?: readonly ("optional" | "required")[];
    optionalSurfaces?: readonly string[];
  };
  router?: {
    entrypoints: readonly string[];
    commandGroups: readonly string[];
    exitSemantics: {
      ok: 0;
      error: 1;
      notImplemented: 2;
      unsupported: 64;
      jsonStable: boolean;
    };
  };
  adapter?: {
    canonicalBin: "opcore";
    packageAdapters: readonly string[];
    sharedResultFields: readonly string[];
    provider: "opcore-graph";
  };
  graphCore?: {
    artifactName: "opcore-graph-core";
    packageName: "@the-open-engine/opcore-graph" | "@the-open-engine/opcore-graph-core-<target>";
    supportedTargets?: readonly string[];
    nativePath: string;
    metadataPath: string;
    checksumPath: string;
    provider: "opcore-graph";
    operations: readonly string[];
  };
  sourceExtraction?: {
    fixtureRoot: string;
    expectedFile: string;
    languages: readonly string[];
    nodeKinds: readonly string[];
    edgeKinds: readonly string[];
    diagnostics: readonly string[];
    importResolution?: {
      owner: "graph-core";
      expectedEdgeField: "pythonImportEdges";
      cases: readonly string[];
    };
  };
  graphPipeline?: {
    operations: readonly string[];
    statuses: readonly string[];
    phaseTimings: readonly string[];
    artifacts: readonly string[];
    dataFile: string;
  };
  graphQuery?: {
    commands: readonly string[];
    namedQueryKinds: readonly string[];
    failureStates: readonly string[];
    edgeCases: readonly string[];
    dataFile: string;
  };
  graphSearch?: {
    commands: readonly string[];
    indexedNodeKinds: readonly string[];
    failureStates: readonly string[];
    contextFiles: readonly string[];
    dataFile: string;
  };
  graphServe?: {
    commands: readonly string[];
    protocols: readonly string[];
    operations: readonly string[];
    failureStates: readonly string[];
    dataFile: string;
  };
  inspectSymbolParity?: {
    fixtureRoot: string;
    routes: readonly ("references" | "signature" | "implementations")[];
    languages: readonly ("ts" | "tsx" | "js" | "jsx")[];
    targetModes: readonly ("node" | "file_symbol" | "line-column")[];
    edgeCases: readonly string[];
    expectedReferenceFile: string;
    expectedSignatureFile: string;
    expectedImplementationFile: string;
  };
  validationContract?: {
    scopes: readonly string[];
    overlayActions: readonly string[];
    resultStatuses: readonly string[];
    graphFailureStates: readonly string[];
    providerFailureCategories: readonly string[];
    dataFile: string;
  };
  validationPython?: {
    fixtureRoot: string;
    scenarios: readonly ("clean" | "failing" | "degraded-tools" | "mypy-authority" | "pyright-authority")[];
    checks: readonly string[];
    degradedTools: readonly string[];
  };
  graphRelease?: {
    receipt: string;
    commands: readonly string[];
    benchmarkMetrics: readonly string[];
    directSqliteQueries: readonly string[];
    deferredChildren: readonly string[];
    optionalSurfaces: readonly {
      issue: string;
      id: string;
      classification: "supporting" | "optional" | "deferred";
      status: "deferred";
    }[];
    handoffIssues: readonly string[];
  };
}

const baseFixture = {
  origin: fixtureOrigin,
  containsSourceCode: false,
  issue: "#3",
  schemaVersion: 1
} as const;

export const conformanceFixtureMetadata = [
  {
    ...baseFixture,
    id: "graph-valid-v1",
    packageTrack: "graph",
    status: "valid",
    providerStatus: {
      state: "available",
      mode: "required"
    },
    graph: {
      nodes: [
        {
          id: "repo:lattice",
          kind: "repo",
          name: "opcore"
        },
        {
          id: "file:packages/contracts/src/index.ts",
          kind: "file",
          path: "packages/contracts/src/index.ts"
        },
        {
          id: "symbol:GraphProviderStatus",
          kind: "symbol",
          path: "packages/contracts/src/index.ts",
          name: "GraphProviderStatus"
        }
      ],
      edges: [
        {
          kind: "CONTAINS",
          from: "repo:lattice",
          to: "file:packages/contracts/src/index.ts"
        },
        {
          kind: "DECLARES",
          from: "file:packages/contracts/src/index.ts",
          to: "symbol:GraphProviderStatus"
        },
        {
          kind: "TESTED_BY",
          from: "symbol:GraphProviderStatus",
          to: "file:tests/contracts.test.mjs"
        }
      ]
    }
  },
  {
    ...baseFixture,
    id: "graph-stale-v1",
    packageTrack: "graph",
    status: "stale",
    providerStatus: {
      state: "stale",
      mode: "required",
      failure: {
        category: "stale_snapshot",
        message: "Graph snapshot exceeds maxAgeMs"
      }
    }
  },
  {
    ...baseFixture,
    id: "graph-schema-mismatch-v1",
    packageTrack: "graph",
    status: "schema_mismatch",
    providerStatus: {
      state: "schema_mismatch",
      mode: "required",
      failure: {
        category: "schema_mismatch",
        message: "Graph snapshot schemaVersion differs from contracts schema"
      }
    }
  },
  {
    ...baseFixture,
    id: "graph-daemon-unavailable-v1",
    packageTrack: "graph",
    status: "daemon_unavailable",
    providerStatus: {
      state: "daemon_unavailable",
      mode: "required",
      failure: {
        category: "daemon_unavailable",
        message: "Graph daemon socket is unavailable"
      }
    }
  },
  {
    ...baseFixture,
    id: "graph-provider-optional-missing-v1",
    packageTrack: "validation",
    status: "skipped",
    providerStatus: {
      state: "skipped",
      mode: "optional",
      failure: {
        category: "provider_missing",
        message: "Optional graph provider is not installed"
      }
    }
  },
  {
    ...baseFixture,
    id: "graph-provider-required-missing-v1",
    packageTrack: "validation",
    status: "required_missing",
    providerStatus: {
      state: "required_missing",
      mode: "required",
      failure: {
        category: "provider_missing",
        message: "Required graph provider is not installed"
      }
    }
  },
  {
    ...baseFixture,
    id: "edit-safe-edit-v1",
    packageTrack: "edit",
    status: "safe_edit",
    editPlan: {
      atomic: "all_or_nothing",
      changes: [
        {
          kind: "replace",
          path: "packages/contracts/src/index.ts"
        },
        {
          kind: "rename",
          path: "packages/fixtures/src/old.ts",
          toPath: "packages/fixtures/src/index.ts"
        }
      ]
    }
  },
  {
    ...baseFixture,
    id: "edit-validation-refusal-v1",
    packageTrack: "edit",
    status: "validation_refusal",
    validation: {
      status: "refused",
      refusalCategory: "validation_failed",
      diagnostics: [
        {
          category: "edit_safety",
          severity: "error"
        }
      ]
    }
  },
  {
    ...baseFixture,
    issue: "#28",
    dataFile: "packages/fixtures/descriptors/opcore.managed-tool.json",
    id: "descriptor-discovery-v1",
    packageTrack: "contracts",
    status: "descriptor_discovery",
    descriptor: {
      dataFile: "packages/fixtures/descriptors/opcore.managed-tool.json",
      descriptorKind: "aggregate_opcore",
      packageName: "opcore",
      entrypoints: ["opcore"],
      commandGroups: [
        "opcore graph",
        "opcore inspect",
        "opcore edit",
        "opcore check",
        "opcore validate",
        "opcore status",
        "opcore doctor"
      ],
      healthProbes: [
        "opcore status --json",
        "opcore doctor --json",
        "opcore graph status --json",
        "opcore check manifest --json",
        "opcore validate manifest --json"
      ],
      capabilities: [
        "graph.build",
        "graph.update",
        "graph.watch",
        "graph.status",
        "graph.query",
        "graph.impact",
        "graph.review-context",
        "graph.detect-changes",
        "graph.search",
        "graph.serve",
        "edit.exact",
        "edit.multi",
        "edit.search-replace",
        "edit.patch",
        "edit.tree",
        "edit.rename",
        "edit.move",
        "edit.signature",
        "edit.validation-required-apply",
        "validation.check",
        "validation.hypothetical",
        "validation.pre-write",
        "validation.typescript"
      ],
      artifacts: [
        "dist/index.js",
        "dist/descriptors/opcore.managed-tool.json",
        "schemas/opcore-contracts.schema.json",
        "@the-open-engine/opcore-graph-core-darwin-arm64/opcore-graph-core",
        "@the-open-engine/opcore-graph-core-darwin-x64/opcore-graph-core",
        "@the-open-engine/opcore-graph-core-linux-x64/opcore-graph-core"
      ],
      checksums: [
        "@the-open-engine/opcore-graph-core-darwin-arm64/opcore-graph-core.sha256",
        "@the-open-engine/opcore-graph-core-darwin-x64/opcore-graph-core.sha256",
        "@the-open-engine/opcore-graph-core-linux-x64/opcore-graph-core.sha256"
      ],
      provenanceHooks: ["npm run pack:check", "npm run provenance:check"],
      artifactPackages: [
        "opcore",
        "@the-open-engine/opcore-contracts",
        "@the-open-engine/opcore-graph",
        "@the-open-engine/opcore-graph-core-darwin-arm64",
        "@the-open-engine/opcore-graph-core-darwin-x64",
        "@the-open-engine/opcore-graph-core-linux-x64"
      ],
      graphCapabilities: [
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
      ],
      editCapabilities: ["exact", "multi", "search-replace", "patch", "tree", "rename", "move", "signature", "check", "apply"],
      validationGraphModes: ["optional", "required"],
      optionalSurfaces: ["#13:coverage:deferred", "#14:flows:deferred", "#15:communities:deferred", "#16:read_only_suggestions:deferred"]
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#20",
    schemaVersion: 1,
    id: "command-router-v1",
    packageTrack: "cli",
    status: "command_router",
    router: {
      entrypoints: ["opcore"],
      commandGroups: [
        "opcore graph",
        "opcore inspect",
        "opcore edit",
        "opcore check",
        "opcore validate",
        "opcore status",
        "opcore doctor"
      ],
      exitSemantics: {
        ok: 0,
        error: 1,
        notImplemented: 2,
        unsupported: 64,
        jsonStable: true
      }
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#21",
    schemaVersion: 1,
    id: "graph-core-artifact-handshake-v1",
    packageTrack: "graph",
    status: "graph_core_artifact_handshake",
    graphCore: {
      artifactName: "opcore-graph-core",
      packageName: "@the-open-engine/opcore-graph-core-<target>",
      supportedTargets: ["darwin-arm64", "darwin-x64", "linux-x64"],
      nativePath: "opcore-graph-core",
      metadataPath: "metadata.json",
      checksumPath: "opcore-graph-core.sha256",
      provider: "opcore-graph",
      operations: ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"]
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: true,
    issue: "#8",
    schemaVersion: 1,
    id: "source-extraction-wave1-v1",
    packageTrack: "fixtures",
    status: "source_extraction_wave1",
    dataFile: "packages/fixtures/source-extraction/wave1/wave1.expected.json",
    sourceExtraction: {
      fixtureRoot: "packages/fixtures/source-extraction/wave1",
      expectedFile: "packages/fixtures/source-extraction/wave1/wave1.expected.json",
      languages: ["ts", "tsx", "js", "jsx"],
      nodeKinds: ["File", "Class", "Function", "Type", "Test", "Variable"],
      edgeKinds: ["CONTAINS", "IMPORTS_FROM", "DEPENDS_ON", "CALLS", "TESTED_BY", "INHERITS", "IMPLEMENTS"],
      diagnostics: []
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: true,
    issue: "#22",
    schemaVersion: 1,
    id: "source-extraction-python-v1",
    packageTrack: "fixtures",
    status: "source_extraction_python",
    dataFile: "packages/fixtures/source-extraction/python/python.expected.json",
    sourceExtraction: {
      fixtureRoot: "packages/fixtures/source-extraction/python",
      expectedFile: "packages/fixtures/source-extraction/python/python.expected.json",
      languages: ["py", "pyi"],
      nodeKinds: ["File", "Module", "Class", "Function", "Variable"],
      edgeKinds: ["CONTAINS", "IMPORTS_FROM", "DEPENDS_ON", "CALLS", "TESTED_BY", "INHERITS"],
      diagnostics: ["parse_error", "unresolved_import"],
      importResolution: {
        owner: "graph-core",
        expectedEdgeField: "pythonImportEdges",
        cases: [
          "multiline-parenthesized",
          "alias",
          "conditional",
          "submodule",
          "star",
          "relative",
          "package-initializer",
          "stub",
          "namespace",
          "src-layout"
        ]
      }
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: true,
    issue: "#22",
    schemaVersion: 1,
    id: "validation-python-v1",
    packageTrack: "validation-python",
    status: "validation_python",
    validationPython: {
      fixtureRoot: "packages/fixtures/validation-python",
      scenarios: ["clean", "failing", "degraded-tools", "mypy-authority", "pyright-authority"],
      checks: [
        "python.syntax",
        "python.source-hygiene",
        "python.ruff-lint",
        "python.ruff-format",
        "python.types",
        "python.import-graph",
        "python.dead-code",
        "python.relevant-tests"
      ],
      degradedTools: ["mypy", "pyright", "ruff", "pytest"]
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#37",
    schemaVersion: 1,
    id: "command-adapter-v1",
    packageTrack: "cli",
    status: "command_adapter",
    adapter: {
      canonicalBin: "opcore",
      packageAdapters: ["graphCommandAdapter", "editCommandAdapter", "checkCommandAdapter", "validateCommandAdapter"],
      sharedResultFields: [
        "canonicalCommand",
        "status",
        "exitCode",
        "message",
        "json",
        "providerStatus",
        "graphPipeline",
        "graphQuery",
        "graphSearch",
        "graphImpact",
        "graphReviewContext",
        "graphChanges",
        "graphServe"
      ],
      provider: "opcore-graph"
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#10",
    schemaVersion: 1,
    id: "graph-pipeline-v1",
    packageTrack: "fixtures",
    status: "graph_pipeline",
    dataFile: "packages/fixtures/graph-pipeline/pipeline-fixtures.json",
    graphPipeline: {
      operations: ["build", "update", "watch", "status", "ping", "health"],
      statuses: ["available", "stale", "warming", "schema_mismatch", "daemon_unavailable", "error"],
      phaseTimings: ["discovery", "extraction", "store", "watch"],
      artifacts: [
        ".opcore/graph/graph.db",
        ".opcore/graph/daemon/pid",
        ".opcore/graph/daemon/state.json",
        ".opcore/graph/daemon/daemon.log"
      ],
      dataFile: "packages/fixtures/graph-pipeline/pipeline-fixtures.json"
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#11",
    schemaVersion: 1,
    id: "graph-query-v1",
    packageTrack: "fixtures",
    status: "graph_query",
    dataFile: "packages/fixtures/graph-query/query-fixtures.json",
    graphQuery: {
      commands: ["impact", "query", "review-context", "detect-changes"],
      namedQueryKinds: [
        "callers_of",
        "callees_of",
        "importers_of",
        "imports_of",
        "tests_for",
        "inheritors_of",
        "children_of",
        "file_summary"
      ],
      failureStates: ["required_missing", "stale", "schema_mismatch", "daemon_unavailable", "error"],
      edgeCases: ["import_cycles", "deleted_files", "renamed_paths", "missing_nodes", "unsupported_named_query"],
      dataFile: "packages/fixtures/graph-query/query-fixtures.json"
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#12",
    schemaVersion: 1,
    id: "graph-search-v1",
    packageTrack: "fixtures",
    status: "graph_search",
    dataFile: "packages/fixtures/graph-search/search-fixtures.json",
    graphSearch: {
      commands: ["search"],
      indexedNodeKinds: ["File", "Class", "Function", "Type", "Test", "Variable"],
      failureStates: ["stale", "schema_mismatch", "daemon_unavailable", "error"],
      contextFiles: ["src/components/GreetingCard.tsx"],
      dataFile: "packages/fixtures/graph-search/search-fixtures.json"
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#47",
    schemaVersion: 1,
    id: "graph-serve-transport-v1",
    packageTrack: "fixtures",
    status: "graph_serve_transport",
    dataFile: "packages/fixtures/graph-reference-evidence/daemon-socket-fixtures.json",
    graphServe: {
      commands: ["serve"],
      protocols: ["opcore.graph.daemon", "jsonrpc-2.0"],
      operations: ["ping", "status", "query", "search", "shutdown"],
      failureStates: ["required_missing", "stale", "schema_mismatch", "daemon_unavailable", "error"],
      dataFile: "packages/fixtures/graph-reference-evidence/daemon-socket-fixtures.json"
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: true,
    issue: "#100",
    schemaVersion: 1,
    id: "inspect-symbol-parity-v1",
    packageTrack: "fixtures",
    status: "inspect_symbol_parity",
    dataFile: "packages/fixtures/inspect-symbol-parity/expected-references.json",
    inspectSymbolParity: {
      fixtureRoot: "packages/fixtures/inspect-symbol-parity",
      routes: ["references", "signature", "implementations"],
      languages: ["ts", "tsx", "js", "jsx"],
      targetModes: ["node", "file_symbol", "line-column"],
      edgeCases: [
        "imported-symbol",
        "renamed-import",
        "path-alias",
        "overload",
        "class-inheritance",
        "interface-inheritance",
        "same-name",
        "unsupported-degraded"
      ],
      expectedReferenceFile: "packages/fixtures/inspect-symbol-parity/expected-references.json",
      expectedSignatureFile: "packages/fixtures/inspect-symbol-parity/expected-signatures.json",
      expectedImplementationFile: "packages/fixtures/inspect-symbol-parity/expected-implementations.json"
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#25",
    schemaVersion: 1,
    id: "validation-contract-v1",
    packageTrack: "fixtures",
    status: "validation_contract",
    dataFile: "packages/fixtures/validation-contract/validation-fixtures.json",
    validationContract: {
      scopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
      overlayActions: ["write", "delete"],
      resultStatuses: [
        "passed",
        "policy_failure",
        "infrastructure_failure",
        "provider_failure",
        "unsupported_request",
        "invalid_payload",
        "skipped",
        "refused"
      ],
      graphFailureStates: ["required_missing", "stale", "schema_mismatch", "daemon_unavailable", "error"],
      providerFailureCategories: [
        "provider_missing",
        "stale_snapshot",
        "schema_mismatch",
        "daemon_unavailable",
        "incompatible_provider",
        "provider_error"
      ],
      dataFile: "packages/fixtures/validation-contract/validation-fixtures.json"
    }
  },
  {
    ...baseFixture,
    issue: "#28",
    dataFile: "packages/fixtures/descriptors/opcore.managed-tool.json",
    id: "installed-artifact-smoke-v1",
    packageTrack: "fixtures",
    status: "installed_artifact_smoke",
    descriptor: {
      dataFile: "packages/fixtures/descriptors/opcore.managed-tool.json",
      descriptorKind: "aggregate_opcore",
      packageName: "opcore",
      entrypoints: ["opcore"],
      commandGroups: [
        "opcore graph",
        "opcore inspect",
        "opcore edit",
        "opcore check",
        "opcore validate",
        "opcore status",
        "opcore doctor"
      ],
      healthProbes: ["opcore status --json", "opcore doctor --json", "opcore check manifest --json"],
      capabilities: ["artifact.discovery", "descriptor.discovery", "validation.graph-modes"],
      artifacts: [
        "dist/index.js",
        "dist/descriptors/opcore.managed-tool.json",
        "@the-open-engine/opcore-graph-core-darwin-arm64/opcore-graph-core",
        "@the-open-engine/opcore-graph-core-darwin-x64/opcore-graph-core",
        "@the-open-engine/opcore-graph-core-linux-x64/opcore-graph-core"
      ],
      checksums: [
        "@the-open-engine/opcore-graph-core-darwin-arm64/opcore-graph-core.sha256",
        "@the-open-engine/opcore-graph-core-darwin-x64/opcore-graph-core.sha256",
        "@the-open-engine/opcore-graph-core-linux-x64/opcore-graph-core.sha256"
      ],
      provenanceHooks: ["npm pack --dry-run", "npm run provenance:check"],
      artifactPackages: [
        "opcore",
        "@the-open-engine/opcore-graph",
        "@the-open-engine/opcore-graph-core-darwin-arm64",
        "@the-open-engine/opcore-graph-core-darwin-x64",
        "@the-open-engine/opcore-graph-core-linux-x64"
      ],
      validationGraphModes: ["optional", "required"],
      optionalSurfaces: ["#13:coverage:deferred", "#14:flows:deferred", "#15:communities:deferred", "#16:read_only_suggestions:deferred"]
    }
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#19",
    schemaVersion: 1,
    id: "graph-reference-evidence-manifest-v1",
    packageTrack: "fixtures",
    status: "graph_reference_evidence_manifest",
    dataFile: "packages/fixtures/graph-reference-evidence/manifest.json"
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#19",
    schemaVersion: 1,
    id: "graph-reference-evidence-sqlite-fixtures-v1",
    packageTrack: "fixtures",
    status: "graph_reference_evidence_sqlite_fixture",
    dataFile: "packages/fixtures/graph-reference-evidence/sqlite-fixtures.json"
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#19",
    schemaVersion: 1,
    id: "graph-reference-evidence-daemon-socket-fixtures-v1",
    packageTrack: "fixtures",
    status: "graph_reference_evidence_daemon_socket_fixture",
    dataFile: "packages/fixtures/graph-reference-evidence/daemon-socket-fixtures.json"
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#19",
    schemaVersion: 1,
    id: "graph-reference-evidence-golden-corpus-v1",
    packageTrack: "fixtures",
    status: "graph_reference_evidence_golden_corpus",
    dataFile: "packages/fixtures/graph-reference-evidence/golden-corpus.json"
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#19",
    schemaVersion: 1,
    id: "graph-reference-evidence-baseline-receipts-v1",
    packageTrack: "fixtures",
    status: "graph_reference_evidence_baseline_receipts",
    dataFile: "packages/fixtures/graph-reference-evidence/baseline-receipts.json"
  },
  {
    origin: fixtureOrigin,
    containsSourceCode: false,
    issue: "#17",
    schemaVersion: 1,
    id: "graph-release-readiness-v1",
    packageTrack: "fixtures",
    status: "graph_release_readiness",
    dataFile: "packages/fixtures/graph-release/release-readiness-fixture.json",
    graphRelease: {
      receipt: "packages/fixtures/graph-release/release-readiness-fixture.json",
      commands: ["build", "update", "watch", "status", "query", "impact", "search", "serve"],
      benchmarkMetrics: ["install_setup_ms", "cold_build_ms", "incremental_update_ms", "impact_cold_ms", "impact_hot_ms", "search_ms", "daemon_startup_ms", "daemon_query_ms", "db_size_bytes", "wal_size_bytes"],
      directSqliteQueries: [
        "status-counts",
        "status-edge-counts",
        "impact-edges-from-file",
        "search-by-name",
        "freshness-metadata"
      ],
      deferredChildren: ["#13", "#14", "#15", "#16"],
      optionalSurfaces: [
        { issue: "#13", id: "coverage", classification: "deferred", status: "deferred" },
        { issue: "#14", id: "flows", classification: "optional", status: "deferred" },
        { issue: "#15", id: "communities", classification: "optional", status: "deferred" },
        { issue: "#16", id: "read_only_suggestions", classification: "supporting", status: "deferred" }
      ],
      handoffIssues: ["#7", "#28", "#29"]
    }
  }
] as const satisfies readonly SyntheticFixtureMetadata[];

export const goldenRepoFixtureName = "graph-valid-v1";
