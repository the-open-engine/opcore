import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandLatencyTelemetryArtifactPolicy,
  validateCommandLatencyRecord
} from "../packages/contracts/dist/index.js";
import {
  createCommandLatencyRecord,
  createOpcoreMeasureDelta,
  createOpcoreMetricReport,
  formatOpcoreMeasureHuman,
  readOpcoreMetricHistory,
  writeCommandLatencyTelemetry,
  writeOpcoreMetricArtifacts
} from "../packages/opcore/dist/index.js";

describe("Opcore metrics", () => {
  it("maps validation diagnostics, graph structure facts, unsupported stacks, and degradations", () => {
    const report = createOpcoreMetricReport({
      repoState: repoState(),
      validationResult: validationResult(),
      graphFacts: graphFacts(),
      generatedAt: "2026-06-25T00:00:00.000Z"
    });

    const signals = new Map(report.signals.map((signal) => [signal.id, signal]));
    assert.equal(signals.get("typescript.syntax_errors").count, 1);
    assert.equal(signals.get("typescript.type_errors").count, 1);
    assert.equal(signals.get("typescript.untested_surface").count, 1);
    assert.equal(signals.get("typescript.dead_exports").evidence[0].path, "src/dead.ts");
    assert.equal(signals.get("typescript.structure.god_files").count, 1);
    assert.equal(signals.get("typescript.structure.high_fan_in").count, 1);
    assert.equal(signals.get("rust.source_hygiene").count, 1);
    assert.equal(signals.get("rust.oversized_files").count, 1);
    assert.equal(signals.get("rust.module_resolution").count, 1);
    assert.equal(signals.get("rust.toolchain_drift").count, 1);
    assert.equal(signals.get("python.syntax_errors").count, 1);
    assert.equal(signals.get("python.syntax_errors").evidence[0].line, 3);
    assert.equal(signals.get("python.syntax_errors").evidence[0].column, 8);
    assert.equal(signals.get("python.type_errors").count, 1);
    assert.equal(signals.get("python.untested_modules").count, 1);
    assert.equal(signals.get("python.dead_exports").evidence[0].path, "pkg/api.py");
    assert.equal(signals.get("python.source_hygiene").count, 1);
    assert.equal(signals.get("python.import_graph").count, 1);
    assert.equal(signals.get("coverage.unsupported_stacks").count, 2);
    assert.equal(report.signals.every((signal) => signal.count > 0 && signal.evidence.every((entry) => entry.path)), true);
    assert.equal(report.degradations.some((entry) => entry.id === "typescript.dead_exports.unavailable"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "python.dead_exports.unavailable"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "python.types.unavailable"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "rust.tool.cargo.unavailable"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "python.tool.mypy.unavailable" && entry.requiredTool === "mypy"), true);
    assert.deepEqual(report.validation.policy.disabledChecks, ["typescript.types"]);
    assert.equal(JSON.stringify(report).includes("blendedScore"), false);
    assert.equal(Object.hasOwn(report, "score"), false);
  });

  it("separates graph-backed Rust signals from validation toolchain drift", () => {
    const report = createOpcoreMetricReport({
      repoState: repoState({ degradedToolchains: [] }),
      validationResult: {
        ok: false,
        status: "policy_failure",
        diagnostics: [
          {
            category: "graph",
            severity: "warning",
            path: "crates/app/src/orphan.rs",
            code: "RUST_GRAPH_MODULE_ORPHAN",
            message: "Rust module source has no incoming IMPORTS_FROM graph evidence."
          },
          {
            category: "graph",
            severity: "error",
            path: "crates/app/src/cycle.rs",
            code: "RUST_GRAPH_MODULE_CYCLE",
            message: "Rust module cycle detected from graph facts."
          },
          {
            category: "test",
            severity: "info",
            path: "crates/app/src/lib.rs",
            code: "RUST_GRAPH_UNTESTED_SURFACE",
            message: "Public Rust surface has no TESTED_BY graph evidence: dead_pub"
          },
          {
            category: "graph",
            severity: "warning",
            path: "crates/app/src/lib.rs",
            code: "RUST_GRAPH_DEAD_PUB_EXPORT",
            message: "Public Rust export has no incoming CALLS graph evidence: dead_pub"
          },
          {
            category: "graph",
            severity: "warning",
            path: "crates/app/src/dead-orphan.rs",
            code: "RUST_DEAD_ORPHAN_SOURCE",
            message: "Rust source file is unreachable from Cargo targets and may contain dead code."
          },
          {
            category: "lint",
            severity: "error",
            path: "crates/app/src/lib.rs",
            code: "RUST_FMT_DRIFT",
            message: "Rust formatting drift."
          },
          {
            category: "types",
            severity: "error",
            path: "crates/app/src/lib.rs",
            code: "E0308",
            message: "mismatched types"
          }
        ],
        manifest: {
          schemaVersion: 1,
          checks: ["rust.graph-signals", "rust.import-graph", "rust.dead-code", "rust.fmt", "rust.cargo-check"],
          generatedAt: "2026-06-25T00:00:00.000Z"
        }
      },
      graphFacts: rustGraphFacts(),
      generatedAt: "2026-06-25T00:00:00.000Z"
    });

    const signals = new Map(report.signals.map((signal) => [signal.id, signal]));
    assert.equal(signals.get("rust.untested_surface").category, "graph");
    assert.equal(signals.get("rust.untested_surface").count, 1);
    assert.equal(signals.get("rust.untested_surface").evidence[0].checkId, "rust.graph-signals");
    assert.equal(signals.get("rust.untested_surface").evidence[0].path, "crates/app/src/lib.rs");
    assert.equal(signals.get("rust.dead_pub_exports").category, "graph");
    assert.equal(signals.get("rust.dead_pub_exports").evidence[0].checkId, "rust.graph-signals");
    assert.equal(signals.get("rust.dead_pub_exports").evidence[0].path, "crates/app/src/lib.rs");
    assert.equal(signals.get("rust.module_orphans").evidence[0].checkId, "rust.graph-signals");
    assert.equal(signals.get("rust.module_cycles").evidence[0].checkId, "rust.graph-signals");
    assert.equal(signals.get("rust.dead_orphan_sources").evidence[0].checkId, "rust.dead-code");
    assert.deepEqual(
      signals.get("rust.toolchain_drift").evidence.map((entry) => entry.code).sort(),
      ["E0308", "RUST_FMT_DRIFT"]
    );
    assert.equal(signals.has("rust.module_graph"), false);
  });

  it("derives Rust graph-backed surface signals from supplied graph facts when graph-signals did not run", () => {
    const report = createOpcoreMetricReport({
      repoState: repoState({ degradedToolchains: [] }),
      validationResult: {
        ok: true,
        status: "passed",
        diagnostics: [],
        manifest: {
          schemaVersion: 1,
          checks: ["rust.fmt", "rust.cargo-check"],
          generatedAt: "2026-06-25T00:00:00.000Z"
        }
      },
      graphFacts: rustGraphFacts(),
      generatedAt: "2026-06-25T00:00:00.000Z"
    });

    const signals = new Map(report.signals.map((signal) => [signal.id, signal]));
    assert.equal(signals.get("rust.untested_surface").evidence[0].source, "graph_fact");
    assert.equal(signals.get("rust.untested_surface").evidence[0].checkId, "rust.graph-signals");
    assert.equal(signals.get("rust.dead_pub_exports").evidence[0].source, "graph_fact");
    assert.equal(signals.get("rust.dead_pub_exports").evidence[0].code, "RUST_GRAPH_DEAD_PUB_EXPORT");
    assert.equal(report.degradations.some((entry) => entry.id === "rust.graph_signals.not_run"), true);
  });

  it("degrades missing graph facts and skipped graph checks without zero findings", () => {
    const report = createOpcoreMetricReport({
      repoState: repoState({ degradedToolchains: [] }),
      validationResult: {
        ok: false,
        status: "skipped",
        diagnostics: [],
        manifest: {
          schemaVersion: 1,
          checks: ["typescript.relevant-tests"],
          generatedAt: "2026-06-25T00:00:00.000Z",
          skippedChecks: [
            {
              checkId: "typescript.relevant-tests",
              reason: "graph_unavailable",
              message: "Graph unavailable"
            },
            {
              checkId: "rust.import-graph",
              reason: "graph_unavailable",
              message: "Rust graph unavailable"
            },
            {
              checkId: "rust.dead-code",
              reason: "graph_unavailable",
              message: "Rust dead-code graph evidence unavailable"
            }
          ]
        }
      },
      generatedAt: "2026-06-25T00:00:00.000Z"
    });

    assert.equal(report.signals.some((signal) => signal.count === 0), false);
    assert.equal(report.degradations.some((entry) => entry.id === "graph.facts.unavailable"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "rust.graph_facts.unavailable"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "validation.typescript_relevant_tests.skipped"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "validation.rust_import_graph.skipped"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "validation.rust_dead_code.skipped"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "typescript.dead_exports.not_run"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "rust.graph_signals.not_run"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "rust.module_graph.not_run"), true);
    assert.equal(report.degradations.some((entry) => entry.id === "rust.dead_code.not_run"), true);
  });

  it("maps raw rustc cargo-check diagnostics into Rust toolchain drift", () => {
    const report = createOpcoreMetricReport({
      repoState: repoState({ degradedToolchains: [] }),
      validationResult: {
        ok: false,
        status: "policy_failure",
        diagnostics: [
          {
            category: "types",
            severity: "error",
            path: "crates/app/src/lib.rs",
            code: "E0308",
            message: "mismatched types"
          }
        ],
        manifest: {
          schemaVersion: 1,
          checks: ["rust.cargo-check"],
          generatedAt: "2026-06-25T00:00:00.000Z"
        }
      },
      graphFacts: graphFacts(),
      generatedAt: "2026-06-25T00:00:00.000Z"
    });

    const signal = report.signals.find((entry) => entry.id === "rust.toolchain_drift");
    assert.equal(signal?.count, 1);
    assert.equal(signal?.evidence[0].path, "crates/app/src/lib.rs");
    assert.equal(signal?.evidence[0].code, "E0308");
  });

  it("writes latest report and appends one history entry per call", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-metrics-history-"));
    try {
      const report = createOpcoreMetricReport({
        repoState: repoState(),
        validationResult: validationResult(),
        graphFacts: graphFacts(),
        generatedAt: "2026-06-25T00:00:00.000Z"
      });

      writeOpcoreMetricArtifacts(temp, report);
      writeOpcoreMetricArtifacts(temp, report);

      assert.equal(existsSync(join(temp, ".opcore/report.json")), true);
      assert.equal(JSON.parse(readFileSync(join(temp, ".opcore/report.json"), "utf8")).kind, "opcore_metric_report");
      assert.equal(readFileSync(join(temp, ".opcore/history.jsonl"), "utf8").trim().split(/\r?\n/).length, 2);
      assert.equal(readOpcoreMetricHistory(temp).length, 2);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("writes bounded command latency telemetry records", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-telemetry-"));
    try {
      for (let index = 0; index < 505; index += 1) {
        writeCommandLatencyTelemetry(temp, latencyRecord(index));
      }

      const telemetryPath = join(temp, commandLatencyTelemetryArtifactPolicy.path);
      const lines = readFileSync(telemetryPath, "utf8").trim().split(/\r?\n/);

      assert.equal(lines.length, commandLatencyTelemetryArtifactPolicy.maxRecords);
      assert.equal(statSync(telemetryPath).size <= commandLatencyTelemetryArtifactPolicy.maxBytes, true);
      assert.deepEqual(
        lines.map((line) => validateCommandLatencyRecord(JSON.parse(line)).recordedAt).slice(0, 2),
        ["2026-06-25T00:00:05.000Z", "2026-06-25T00:00:06.000Z"]
      );
      assert.equal(validateCommandLatencyRecord(JSON.parse(lines.at(-1))).recordedAt, "2026-06-25T00:08:24.000Z");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses command latency telemetry without router timing", () => {
    assert.throws(
      () => createCommandLatencyRecord({
        bin: "opcore",
        argv: ["--json"],
        canonicalCommand: ["opcore", "scan"],
        owner: "runtime",
        status: "ok",
        exitCode: 0,
        json: true,
        repoState: repoState()
      }, repoState()),
      /requires measured command timing/
    );
  });

  it("computes concrete baseline and previous deltas and formats human sections in order", () => {
    const baseline = reportWithSignals("2026-06-24T00:00:00.000Z", [
      ["typescript.type_errors", "TS/JS type errors", 3],
      ["rust.source_hygiene", "Rust source hygiene suppressions", 1]
    ]);
    const previous = reportWithSignals("2026-06-25T00:00:00.000Z", [["typescript.type_errors", "TS/JS type errors", 2]]);
    const current = reportWithSignals("2026-06-25T01:00:00.000Z", [["typescript.type_errors", "TS/JS type errors", 1]]);
    const delta = createOpcoreMeasureDelta({
      current,
      history: [
        historyEntry("2026-06-24T00:00:01.000Z", baseline),
        historyEntry("2026-06-25T00:00:01.000Z", previous)
      ],
      latencyRecords: [latencyRecord(5), latencyRecord(6), latencyRecord(20)],
      latencyBudgets: [
        {
          schemaVersion: 1,
          canonicalCommand: ["opcore", "scan"],
          scope: "warm",
          repoShapeBucket: "small",
          budgetMs: 10,
          phaseBudgets: [{ phase: "validation", budgetMs: 8 }]
        }
      ],
      generatedAt: "2026-06-25T01:00:01.000Z"
    });

    assert.deepEqual(
      delta.baseline.deltas.map((entry) => [entry.id, entry.currentCount, entry.comparisonCount, entry.delta]),
      [
        ["rust.source_hygiene", 0, 1, -1],
        ["typescript.type_errors", 1, 3, -2]
      ]
    );
    assert.deepEqual(delta.previous.deltas.map((entry) => [entry.id, entry.delta]), [["typescript.type_errors", -1]]);
    assert.equal(delta.latency.recordCount, 3);
    assert.equal(delta.latency.findings[0].status, "over_budget");
    assert.equal(delta.latency.findings[0].dominantPhase.phase, "validation");
    assert.equal(delta.latency.findings[0].currentDurationMs, 20);
    assert.equal(delta.latency.findings[0].budgetMs, 8);
    assert.equal(delta.latency.findings[0].overBudgetMs, 12);
    assert.equal(delta.latency.findings[0].previousDeltaMs, 14);
    const human = formatOpcoreMeasureHuman(delta);
    assert.equal(human.indexOf("Coverage:"), 0);
    assert.equal(human.indexOf("Signals:") > human.indexOf("Coverage:"), true);
    assert.equal(human.indexOf("Latency:") > human.indexOf("Signals:"), true);
    assert.equal(human.indexOf("Warnings/degradations:") > human.indexOf("Latency:"), true);
    assert.equal(human.indexOf("Next:") > human.indexOf("Warnings/degradations:"), true);
    assert.doesNotMatch(human, /0-100|score/i);
    assert.match(human, /baseline=-2/);
    assert.match(human, /previous=-1/);
    assert.match(human, /opcore scan/);
    assert.match(human, /warm\/small\/validation\/over_budget/);
    assert.match(human, /over=12ms/);
  });
});

function validationResult() {
  return {
    ok: false,
    status: "policy_failure",
    diagnostics: [
      { category: "syntax", severity: "error", path: "src/bad.ts", code: "TS1005", message: "Expected ';'." },
      { category: "types", severity: "error", path: "src/bad.ts", code: "TS2322", message: "Type mismatch." },
      {
        category: "test",
        severity: "info",
        path: "src/untested.ts",
        code: "TS_RELEVANT_TESTS_ABSENT",
        message: "No TESTED_BY graph evidence found."
      },
      {
        category: "graph",
        severity: "warning",
        path: "src/dead.ts",
        code: "TS_DEAD_CODE_UNUSED_EXPORT",
        message: "Exported symbol has no incoming CALLS graph evidence."
      },
      {
        category: "graph",
        severity: "info",
        code: "TS_DEAD_CODE_UNSUPPORTED",
        message: "Graph facts do not include CALLS edge coverage."
      },
      {
        category: "policy",
        severity: "error",
        path: "crates/app/src/lib.rs",
        code: "RUST_SOURCE_ALLOW_DEAD_CODE",
        message: "allow(dead_code) suppressions are not allowed."
      },
      {
        category: "policy",
        severity: "error",
        path: "crates/app/src/large.rs",
        code: "RUST_FILE_LINES",
        message: "Rust file has 501 lines; max is 500."
      },
      {
        category: "graph",
        severity: "error",
        path: "crates/app/src/lib.rs",
        code: "RUST_IMPORT_UNRESOLVED_MODULE",
        message: "Rust module declaration has no file."
      },
      {
        category: "lint",
        severity: "error",
        path: "crates/app/src/lib.rs",
        code: "RUST_FMT_DRIFT",
        message: "Rust formatting drift."
      },
      {
        category: "syntax",
        severity: "error",
        path: "pkg/bad.py",
        code: "PY_SYNTAX_ERROR",
        message: "expected ':'",
        line: 3,
        column: 8
      },
      { category: "types", severity: "error", path: "pkg/typed.py", code: "PY_TYPE_MISMATCH", message: "Type mismatch." },
      {
        category: "test",
        severity: "info",
        path: "pkg/untested.py",
        code: "PY_RELEVANT_TESTS_ABSENT",
        message: "No TESTED_BY graph evidence found."
      },
      {
        category: "graph",
        severity: "warning",
        path: "pkg/api.py",
        code: "PY_DEAD_CODE_UNUSED_EXPORT",
        message: "Exported Python symbol has no incoming CALLS graph evidence."
      },
      {
        category: "graph",
        severity: "info",
        code: "PY_DEAD_CODE_UNSUPPORTED",
        message: "Graph facts do not include Python export metadata required for dead-code validation."
      },
      {
        category: "policy",
        severity: "error",
        path: "pkg/hygiene.py",
        code: "PY_SOURCE_TYPE_IGNORE",
        message: "Python type-ignore suppressions are not allowed."
      },
      {
        category: "graph",
        severity: "warning",
        path: "pkg/importer.py",
        code: "PY_IMPORT_GRAPH_MISSING_EDGE",
        message: "Missing IMPORTS_FROM graph edge."
      },
      {
        category: "types",
        severity: "info",
        code: "PYTHON_TYPES_UNSUPPORTED_TARGET",
        message: "Python type validation requires explicit or configured checker authority."
      }
    ],
    manifest: {
      schemaVersion: 1,
      checks: [
        "typescript.syntax",
        "typescript.types",
        "typescript.relevant-tests",
        "typescript.dead-code",
        "typescript.file-length",
        "rust.source-hygiene",
        "rust.file-length",
        "rust.import-graph",
        "rust.fmt",
        "python.syntax",
        "python.source-hygiene",
        "python.types",
        "python.import-graph",
        "python.dead-code",
        "python.relevant-tests"
      ],
      generatedAt: "2026-06-25T00:00:00.000Z"
    }
  };
}

function repoState(overrides = {}) {
  const degradedToolchains = overrides.degradedToolchains ?? [
    { adapter: "rust", tool: "cargo", failureMessage: "cargo unavailable" },
    { adapter: "python", tool: "mypy", failureMessage: "mypy unavailable" }
  ];
  return {
    schemaVersion: 1,
    repo: {
      root: "/repo",
      requestedPath: "/repo",
      git: { available: false }
    },
    coverage: {
      totalFiles: 10,
      languages: [
        { language: "Go", files: 2, graphSupported: false, validationSupported: false },
        { language: "TypeScript", files: 4, graphSupported: true, validationSupported: true },
        { language: "Rust", files: 2, graphSupported: true, validationSupported: true },
        { language: "Python", files: 2, graphSupported: true, validationSupported: true }
      ],
      graph: {
        supportedFiles: 8,
        extensions: [
          { extension: ".rs", count: 2 },
          { extension: ".py", count: 2 },
          { extension: ".ts", count: 4 }
        ]
      },
      validation: {
        supportedFiles: 8,
        retainedFiles: 0,
        extensions: [
          { extension: ".py", count: 2 },
          { extension: ".ts", count: 4 },
          { extension: ".rs", count: 2 }
        ]
      },
      unsupported: {
        totalFiles: 2,
        stacks: [{ extension: ".go", language: "Go", count: 2, examples: ["cmd/a.go", "cmd/b.go"] }]
      }
    },
    graph: {
      state: "available",
      mode: "optional",
      provider: "opcore-graph",
      action: "Graph is ready.",
      status: {
        state: "available",
        mode: "optional",
        provider: "opcore-graph",
        schemaVersion: 1,
        repo: { repoRoot: "/repo" },
        freshness: {
          generatedAt: "2026-06-25T00:00:00.000Z",
          ageMs: 0,
          stale: false
        },
        nodes_by_kind: {},
        edges_by_kind: {}
      }
    },
    validation: {
      ready: degradedToolchains.length === 0,
      checkCount: 15,
      policy: {
        path: ".opcore/config",
        state: "loaded",
        adapters: ["typescript", "rust", "python"],
        packs: ["./checks/policy.cjs"],
        disabledChecks: ["typescript.types"],
        defaultChecks: ["docs.existence"],
        configuredChecks: ["typescript.syntax", "rust.source-hygiene", "python.syntax"]
      },
      adapters: [
        {
          adapter: "rust",
          status: degradedToolchains.length === 0 ? "available" : "unavailable",
          checkCount: 10,
          degradedChecks: [],
          missingTools: degradedToolchains.map((tool) => tool.tool)
        }
      ],
      degradedToolchains
    },
    activation: {
      ready: false,
      level: "degraded",
      summary: "Repo is degraded.",
      asp: {
        state: "not_enrolled",
        paths: []
      }
    },
    warnings: ["Unsupported stacks: Go"],
    blockers: [],
    nextActions: ["opcore check changed --repo /repo --json"]
  };
}

function graphFacts() {
  const nodes = [
    { id: "file:src/god.ts", kind: "file", path: "src/god.ts" },
    { id: "file:src/shared.ts", kind: "file", path: "src/shared.ts" },
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `file:src/consumer-${index}.ts`,
      kind: "file",
      path: `src/consumer-${index}.ts`
    }))
  ];
  const contains = Array.from({ length: 51 }, (_, index) => ({
    kind: "CONTAINS",
    from: "file:src/god.ts",
    to: `function:src/god.ts#symbol${index}`
  }));
  const imports = Array.from({ length: 11 }, (_, index) => ({
    kind: "IMPORTS_FROM",
    from: `file:src/consumer-${index}.ts`,
    to: "file:src/shared.ts"
  }));
  return {
    nodes,
    edges: [...contains, ...imports],
    metadata: {
      schemaVersion: 1,
      provider: "opcore-graph",
      repo: { repoRoot: "/repo" },
      generatedAt: "2026-06-25T00:00:00.000Z",
      freshness: {
        generatedAt: "2026-06-25T00:00:00.000Z",
        ageMs: 0,
        stale: false
      },
      nodeKinds: ["file"],
      edgeKinds: ["CONTAINS", "IMPORTS_FROM"]
    }
  };
}

function rustGraphFacts() {
  return {
    nodes: [
      { id: "file:crates/app/src/lib.rs", kind: "file", path: "crates/app/src/lib.rs" },
      { id: "file:crates/app/src/covered.rs", kind: "file", path: "crates/app/src/covered.rs" },
      {
        id: "function:crates/app/src/lib.rs#dead_pub",
        kind: "Function",
        path: "crates/app/src/lib.rs",
        name: "dead_pub",
        attributes: { exported: true }
      },
      {
        id: "function:crates/app/src/covered.rs#used_pub",
        kind: "Function",
        path: "crates/app/src/covered.rs",
        name: "used_pub",
        attributes: { exported: true }
      },
      {
        id: "function:crates/app/src/lib.rs#private_helper",
        kind: "Function",
        path: "crates/app/src/lib.rs",
        name: "private_helper",
        attributes: { exported: false }
      }
    ],
    edges: [
      {
        kind: "CALLS",
        from: "function:crates/app/src/lib.rs#private_helper",
        to: "function:crates/app/src/covered.rs#used_pub"
      },
      {
        kind: "TESTED_BY",
        from: "file:crates/app/src/covered.rs",
        to: "file:crates/app/tests/covered_test.rs"
      }
    ],
    metadata: {
      schemaVersion: 1,
      provider: "opcore-graph",
      repo: { repoRoot: "/repo" },
      generatedAt: "2026-06-25T00:00:00.000Z",
      freshness: {
        generatedAt: "2026-06-25T00:00:00.000Z",
        ageMs: 0,
        stale: false
      },
      nodeKinds: ["file", "Function"],
      edgeKinds: ["CALLS", "CONTAINS", "IMPORTS_FROM", "TESTED_BY"]
    }
  };
}

function reportWithSignals(generatedAt, signalRows) {
  return {
    ...createOpcoreMetricReport({
      repoState: repoState({ degradedToolchains: [] }),
      validationResult: { ok: true, status: "passed", diagnostics: [] },
      graphFacts: graphFacts(),
      generatedAt
    }),
    signals: signalRows.map(([id, title, count]) => ({
      id,
      title,
      category: id.startsWith("rust.") ? "rust" : "typescript",
      severity: "warning",
      count,
      evidence: [
        {
          source: "validation_diagnostic",
          path: id.startsWith("rust.") ? "crates/app/src/lib.rs" : "src/index.ts",
          message: title
        }
      ]
    }))
  };
}

function historyEntry(recordedAt, report) {
  return {
    schemaVersion: 1,
    kind: "opcore_metric_history_entry",
    recordedAt,
    report
  };
}

function latencyRecord(index) {
  return validateCommandLatencyRecord({
    schemaVersion: 1,
    recordedAt: `2026-06-25T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    bin: "opcore",
    canonicalCommand: ["opcore", "scan"],
    owner: "runtime",
    status: "ok",
    exitCode: 0,
    repo: {
      totalFiles: 8,
      languages: [
        { language: "TypeScript", files: 4 },
        { language: "Rust", files: 2 },
        { language: "Python", files: 2 }
      ],
      graph: {
        supportedFiles: 4,
        unsupportedFiles: 4
      },
      git: {
        available: false
      }
    },
    timing: {
      durationMs: index,
      phases: [
        { phase: "validation", durationMs: index },
        { phase: "validation_typescript_syntax", durationMs: 1 }
      ],
      processState: index === 0 ? "cold" : "warm"
    },
    opcoreVersion: "0.2.1"
  });
}
