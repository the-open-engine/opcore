import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createEphemeralGraphSnapshot, graphProviderBuild, graphProviderQuery } from "../packages/graph/dist/index.js";
import { createEphemeralGraphSnapshotWithOperations } from "../packages/graph/dist/ephemeral-snapshot.js";
import {
  createStateAwareValidationGraphSessionFactory,
  createValidationExactGraphSnapshotFactory,
  createValidationRunner
} from "../packages/validation/dist/index.js";

describe("ephemeral graph snapshots", () => {
  it("materializes supported sources, builds once, binds logical metadata, and disposes idempotently", async () => {
    let builds = 0;
    let materializedRepo;
    const logicalRepo = { repoId: "target", repoRoot: "/target/repo" };
    const available = graphStatus();
    const snapshot = await createEphemeralGraphSnapshotWithOperations({
      logicalRepo,
      sourceUniverse: {
        paths: ["README.md", "src/a.py", "src/b.ts", "src/common.cts", "src/module.mts"],
        complete: true
      },
      readFile: (path) => ({ status: "found", content: `content:${path}` })
    }, {
      build: (repo) => {
        builds += 1;
        materializedRepo = repo.repoRoot;
        assert.equal(readFileSync(join(materializedRepo, "src/a.py"), "utf8"), "content:src/a.py");
        assert.equal(readFileSync(join(materializedRepo, "src/common.cts"), "utf8"), "content:src/common.cts");
        assert.equal(readFileSync(join(materializedRepo, "src/module.mts"), "utf8"), "content:src/module.mts");
        assert.equal(existsSync(join(materializedRepo, "README.md")), false);
        return { status: available };
      },
      factQuery: (_repo, request) => ({
        requestId: request.requestId,
        status: available,
        metadata: {
          schemaVersion: 1,
          provider: "opcore-graph",
          repo: { repoRoot: materializedRepo },
          generatedAt: "2026-07-16T00:00:00.000Z",
          freshness: { generatedAt: "2026-07-16T00:00:00.000Z", ageMs: 0, stale: false },
          nodeKinds: [],
          edgeKinds: []
        },
        nodes: [],
        edges: []
      })
    });

    const result = snapshot.factQuery({
      requestId: "exact-query",
      repo: logicalRepo,
      schemaVersion: 1,
      mode: "optional",
      selector: { kind: "nodes" }
    });
    assert.equal(builds, 1);
    assert.deepEqual(snapshot.materializedPaths, ["src/a.py", "src/b.ts", "src/common.cts", "src/module.mts"]);
    assert.deepEqual(result.metadata.repo, logicalRepo);
    assert.equal(result.status.mode, "optional");
    snapshot.dispose();
    snapshot.dispose();
    assert.equal(existsSync(materializedRepo), false);
  });

  it("rejects incomplete universes and removes materialized state after build errors", async () => {
    await assert.rejects(createEphemeralGraphSnapshotWithOperations({
      logicalRepo: { repoId: "target" },
      sourceUniverse: { paths: ["src/a.py"], complete: false, message: "tree truncated" },
      readFile: () => ({ status: "found", content: "VALUE = 1\n" })
    }, operations()), /tree truncated/);

    let snapshotRepo;
    await assert.rejects(createEphemeralGraphSnapshotWithOperations({
      logicalRepo: { repoId: "target" },
      sourceUniverse: { paths: ["src/a.py"], complete: true },
      readFile: () => ({ status: "found", content: "VALUE = 1\n" })
    }, operations({
      build: (repo) => {
        snapshotRepo = repo.repoRoot;
        throw new Error("forced build failure");
      }
    })), /forced build failure/);
    assert.equal(existsSync(snapshotRepo), false);

    for (const testCase of [
      { paths: ["a.py", "b.py"], limits: { maxFiles: 1 }, message: /maxFiles/ },
      { paths: ["a/b/c.py"], limits: { maxDepth: 2 }, message: /maxDepth/ },
      { paths: ["a.py"], limits: { maxBytes: 1 }, message: /maxBytes/ }
    ]) {
      await assert.rejects(createEphemeralGraphSnapshotWithOperations({
        logicalRepo: { repoId: "target" },
        sourceUniverse: { paths: testCase.paths, complete: true },
        readFile: () => ({ status: "found", content: "VALUE = 1\n" }),
        limits: testCase.limits
      }, operations()), testCase.message);
    }
  });

  it("matches real on-disk Python import edges for add, remove, retarget, and rename-style states without touching the target", async () => {
    const target = mkdtempSync(join(tmpdir(), "opcore-graph-snapshot-target-"));
    try {
      writeTree(target, new Map([
        ["pkg/__init__.py", ""],
        ["pkg/app.py", "from pkg import old\n"],
        ["pkg/old.py", "VALUE = 'old'\n"],
        [".opcore/graph/sentinel", "persistent-graph\n"]
      ]));
      const targetBefore = targetEvidence(target);
      const states = [
        new Map([
          ["pkg/__init__.py", ""],
          ["pkg/app.py", "from pkg import new\n"],
          ["pkg/old.py", "VALUE = 'old'\n"],
          ["pkg/new.py", "VALUE = 'new'\n"]
        ]),
        new Map([
          ["pkg/__init__.py", ""],
          ["pkg/app.py", "VALUE = 1\n"]
        ]),
        new Map([
          ["pkg/__init__.py", ""],
          ["pkg/app.py", "from pkg import renamed\n"],
          ["pkg/renamed.py", "VALUE = 'renamed'\n"]
        ])
      ];

      for (const state of states) {
        assert.deepEqual(await ephemeralImportEdges(target, state), materializedImportEdges(state));
      }
      assert.deepEqual(targetEvidence(target), targetBefore);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("produces the same introduced graph diagnostic as the equivalent materialized repository and preserves the persistent target graph", async () => {
    const target = mkdtempSync(join(tmpdir(), "opcore-exact-validation-target-"));
    const materialized = mkdtempSync(join(tmpdir(), "opcore-exact-validation-after-"));
    try {
      const beforeFiles = new Map([
        ["pkg/__init__.py", ""],
        ["pkg/app.py", "from pkg import old\n"],
        ["pkg/old.py", "VALUE = 'old'\n"]
      ]);
      const afterFiles = new Map([
        ["pkg/__init__.py", ""],
        ["pkg/app.py", "from pkg import new\n"],
        ["pkg/old.py", "VALUE = 'old'\n"],
        ["pkg/new.py", "VALUE = 'new'\n"]
      ]);
      writeTree(target, beforeFiles);
      writeTree(materialized, afterFiles);
      assert.equal(graphProviderBuild({ repoRoot: target }).status.state, "available");
      assert.equal(graphProviderBuild({ repoRoot: materialized }).status.state, "available");
      const targetGraphBefore = directoryEvidence(join(target, ".opcore/graph"));
      const targetSourceBefore = readFileSync(join(target, "pkg/app.py"), "utf8");
      const client = realGraphClient();
      const check = newImportCheck();
      const exact = await createValidationRunner({
        workspace: validationWorkspace(beforeFiles),
        checks: [check],
        graphProviderClient: client,
        graphSessionFactory: createStateAwareValidationGraphSessionFactory({
          persistentClient: client,
          exactSnapshotFactory: createValidationExactGraphSnapshotFactory(createEphemeralGraphSnapshot)
        })
      }).runValidation(validationRequest(target, {
        reportMode: "introduced",
        overlays: [
          { path: "pkg/app.py", action: "write", content: afterFiles.get("pkg/app.py") },
          { path: "pkg/new.py", action: "write", content: afterFiles.get("pkg/new.py") }
        ]
      }));
      const onDisk = await createValidationRunner({
        workspace: validationWorkspace(afterFiles),
        checks: [check],
        graphProviderClient: client
      }).runValidation(validationRequest(materialized));

      assert.equal(exact.status, "policy_failure", JSON.stringify(exact, null, 2));
      assert.deepEqual(exact.diagnostics, onDisk.diagnostics);
      assert.equal(readFileSync(join(target, "pkg/app.py"), "utf8"), targetSourceBefore);
      assert.deepEqual(directoryEvidence(join(target, ".opcore/graph")), targetGraphBefore);
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(materialized, { recursive: true, force: true });
    }
  });
});

function newImportCheck() {
  return {
    id: "python.new-import",
    owner: "validation",
    adapter: "python",
    defaultSeverity: "error",
    supportedScopes: ["files"],
    requiresGraph: true,
    graphRequirements: () => [{ operation: "factQuery", selector: { kind: "edges", edgeKinds: ["IMPORTS_FROM"] } }],
    run: async (context) => ({
      diagnostics: (await context.graph.importsFrom())
        .filter((edge) => edge.from === "file:pkg/app.py" && edge.to === "file:pkg/new.py")
        .map(() => ({
          category: "graph",
          severity: "error",
          path: "pkg/app.py",
          code: "PY_NEW_IMPORT",
          message: "pkg/app.py newly imports pkg/new.py"
        }))
    })
  };
}

function validationRequest(repoRoot, overrides = {}) {
  return {
    requestId: "exact-validation",
    repo: { repoRoot },
    scope: { kind: "files", files: ["pkg/app.py"] },
    graph: { mode: "required", provider: "opcore-graph" },
    overlays: [],
    checks: ["python.new-import"],
    reportMode: "all",
    ...overrides
  };
}

function validationWorkspace(files) {
  return {
    readFile: (path) => files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" },
    listFiles: () => ({ files: [...files.keys()] })
  };
}

function realGraphClient() {
  return {
    status: (request) => ({ ...graphProviderBuildStatus(request.repo), mode: request.graph.mode }),
    factQuery: (request) => graphProviderQuery(request.repo, request.selector),
    namedQuery: () => { throw new Error("unused namedQuery"); },
    impact: () => { throw new Error("unused impact"); },
    reviewContext: () => { throw new Error("unused reviewContext"); },
    detectChanges: () => { throw new Error("unused detectChanges"); }
  };
}

function graphProviderBuildStatus(repo) {
  const query = graphProviderQuery(repo, { kind: "nodes", limit: 1 });
  return query.status;
}

async function ephemeralImportEdges(target, files) {
  const snapshot = await createEphemeralGraphSnapshot({
    logicalRepo: { repoRoot: target },
    sourceUniverse: { paths: [...files.keys()], complete: true },
    readFile: (path) => files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }
  });
  try {
    const result = snapshot.factQuery({
      requestId: "ephemeral-imports",
      repo: { repoRoot: target },
      schemaVersion: 1,
      mode: "required",
      selector: { kind: "edges", edgeKinds: ["IMPORTS_FROM"] }
    });
    assert.equal(result.status.state, "available");
    return importEdgePairs(result.edges);
  } finally {
    snapshot.dispose();
  }
}

function materializedImportEdges(files) {
  const root = mkdtempSync(join(tmpdir(), "opcore-graph-snapshot-parity-"));
  try {
    writeTree(root, files);
    assert.equal(graphProviderBuild({ repoRoot: root }).status.state, "available");
    const result = graphProviderQuery({ repoRoot: root }, { kind: "edges", edgeKinds: ["IMPORTS_FROM"] });
    assert.equal(result.status.state, "available");
    return importEdgePairs(result.edges);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function importEdgePairs(edges) {
  return edges
    .filter((edge) => edge.kind === "IMPORTS_FROM" && edge.from.startsWith("file:pkg/") && edge.to.startsWith("file:pkg/"))
    .map((edge) => `${edge.from}->${edge.to}`)
    .sort();
}

function writeTree(root, files) {
  for (const [path, content] of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

function targetEvidence(root) {
  return {
    app: readFileSync(join(root, "pkg/app.py"), "utf8"),
    old: readFileSync(join(root, "pkg/old.py"), "utf8"),
    graph: readFileSync(join(root, ".opcore/graph/sentinel"), "utf8")
  };
}

function directoryEvidence(root) {
  const evidence = {};
  for (const path of walk(root)) {
    const relativePath = path.slice(root.length + 1);
    evidence[relativePath] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return evidence;
}

function walk(root) {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...walk(path));
    else if (entry.isFile() && statSync(path).isFile()) paths.push(path);
  }
  return paths.sort();
}

function operations(overrides = {}) {
  return {
    build: () => ({ status: graphStatus() }),
    factQuery: () => { throw new Error("unused query"); },
    ...overrides
  };
}

function graphStatus() {
  return {
    state: "available",
    mode: "required",
    provider: "opcore-graph",
    schemaVersion: 1,
    freshness: { generatedAt: "2026-07-16T00:00:00.000Z", ageMs: 0, stale: false },
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}
