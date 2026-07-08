import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeOpcoreCommand } from "../packages/opcore/dist/index.js";
import { commandRouterManifest, routeCommand, runCli } from "../packages/opcore/dist/advanced/index.js";

const removedLegacyCommandField = `legacy${"Command"}`;
const removedLegacyMappingsField = `legacy${"Mappings"}`;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");
const requiredDefaultCheckIds = [
  "typescript.syntax",
  "typescript.types",
  "typescript.import-graph",
  "typescript.dead-code",
  "typescript.function-metrics",
  "typescript.relevant-tests",
  "typescript.file-length",
  "rust.source-hygiene",
  "rust.fmt",
  "rust.cargo-check",
  "rust.clippy",
  "rust.rustdoc",
  "rust.import-graph",
  "rust.dead-code",
  "rust.graph-signals",
  "rust.unused-deps",
  "rust.file-length",
  "rust.function-metrics",
  "python.syntax",
  "python.source-hygiene",
  "python.types",
  "python.import-graph",
  "python.dead-code",
  "python.relevant-tests"
];

describe("Opcore command router", () => {
  it("declares the canonical Opcore command bin with command groups", () => {
    assert.deepEqual(commandRouterManifest.bins, ["opcore"]);
    assert.equal(Object.hasOwn(commandRouterManifest, "aliases"), false);
    assert.equal(Object.hasOwn(commandRouterManifest, removedLegacyMappingsField), false);
    assert.deepEqual(
      commandRouterManifest.commandGroups.map((group) => group.name),
      ["graph", "inspect", "edit", "check", "validate", "status", "doctor"]
    );
    assert.deepEqual(commandRouterManifest.commandGroups.find((group) => group.name === "graph").commands, [
      "build",
      "update",
      "watch",
      "status",
      "query",
      "serve",
      "impact",
      "review-context",
      "detect-changes",
      "search"
    ]);
    assert.deepEqual(commandRouterManifest.commandGroups.find((group) => group.name === "check").commands, [
      "files",
      "staged",
      "changed",
      "tree",
      "all",
      "manifest"
    ]);
    assert.deepEqual(commandRouterManifest.commandGroups.find((group) => group.name === "inspect").commands, [
      "symbols",
      "definition",
      "references",
      "signature",
      "implementations",
      "search"
    ]);
    assert.deepEqual(commandRouterManifest.commandGroups.find((group) => group.name === "validate").commands, [
      "request",
      "hypothetical",
      "pre-write",
      "manifest"
    ]);
    assert.deepEqual(commandRouterManifest.commandGroups.find((group) => group.name === "edit").commands, [
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
  });

  it("rejects non-Opcore entrypoints without alias metadata", async () => {
    for (const bin of ["lattice", "crg", "cix", "rox"]) {
      const routed = await routeCommand(["status", "--json"], bin);
      assert.equal(routed.status, "unsupported");
      assert.equal(routed.exitCode, 64);
      assert.deepEqual(routed.canonicalCommand, ["opcore", "unsupported"]);
      assert.equal(routed.owner, "runtime");
      assert.equal(Object.hasOwn(routed, "alias"), false);
      assert.equal(Object.hasOwn(routed, removedLegacyCommandField), false);
      assertCommandTiming(routed);
    }
  });

  it("routes canonical graph status, query, and search through the graph adapter", async () => {
    await withFixtureCopy(async (fixtureRoot) => {
      await routeCommand(["graph", "build", "--repo", fixtureRoot, "--json"], "opcore");
      const status = await routeCommand(["graph", "status", "--repo", fixtureRoot, "--json"], "opcore");
      const query = await routeCommand(["graph", "query", "--repo", fixtureRoot, "--json"], "opcore");
      const search = await routeCommand(["graph", "search", "Greeting", "--repo", fixtureRoot, "--limit", "5", "--json"], "opcore");

      for (const result of [status, query, search]) {
        assert.equal(result.status, "ok");
        assert.equal(result.exitCode, 0);
        assert.equal(result.providerStatus.provider, "opcore-graph");
        assert.equal(result.providerStatus.state, "available");
        assert.equal(Object.hasOwn(result, "alias"), false);
        assert.equal(Object.hasOwn(result, removedLegacyCommandField), false);
        assertCommandTiming(result);
      }
      assert.deepEqual(status.canonicalCommand.slice(0, 3), ["opcore", "graph", "status"]);
      assert.deepEqual(query.canonicalCommand.slice(0, 3), ["opcore", "graph", "query"]);
      assert.deepEqual(search.canonicalCommand.slice(0, 3), ["opcore", "graph", "search"]);
      assert.equal(search.graphSearch.results[0].path, "src/components/GreetingCard.tsx");
    });
  });

  it("routes graph build, update, watch, and serve through canonical Opcore commands", async () => {
    for (const command of ["build", "update", "watch"]) {
      await withFixtureCopy(async (fixtureRoot) => {
        const extra = command === "watch" ? ["--once"] : [];
        const routed = await routeCommand(["graph", command, "--repo", fixtureRoot, ...extra, "--json"], "opcore");
        assert.equal(routed.status, "ok");
        assert.equal(routed.exitCode, 0);
        assert.equal(routed.providerStatus.state, "available");
        assert.equal(routed.graphPipeline.status.state, "available");
        assertCommandTiming(routed);
        if (command === "build") {
          const phases = routed.timing.phases.map((phase) => phase.phase);
          assert.equal(phases.includes("discovery"), true);
          assert.equal(phases.includes("extraction"), true);
          assert.equal(phases.includes("store"), true);
        }
      });
    }

    const serve = await routeCommand(["graph", "serve", "--json"], "opcore");
    assert.equal(serve.status, "ok");
    assert.equal(serve.graphServe.state, "ready");
    assertCommandTiming(serve);
  });

  it("returns graph adapter failures without throwing", async () => {
    const missingRepo = join(tmpdir(), `lattice-missing-query-${process.pid}-${Date.now()}`);
    const routed = await routeCommand(["graph", "query", "--repo", missingRepo, "--json"], "opcore");
    assert.equal(routed.status, "error");
    assert.equal(routed.exitCode, 1);
    assert.equal(routed.providerStatus.provider, "opcore-graph");
    assert.equal(routed.providerStatus.state, "required_missing");
    assert.match(routed.message, /not a directory/);
    assertCommandTiming(routed);

    for (const args of [
      ["graph", "impact", "--files", "--json"],
      ["graph", "search", "--json"],
      ["graph", "watch", "--poll-interval-ms", "0", "--json"],
      ["graph", "watch", "--idle-timeout-ms", "foo", "--json"],
      ["graph", "watch", "--unknown-graph-flag", "--json"],
      ["inspect", "symbols", "Greeting", "--unknown-inspect-flag", "--json"]
    ]) {
      const malformed = await routeCommand(args, "opcore");
      assert.equal(malformed.status, "error", args.join(" "));
      assert.equal(malformed.exitCode, 1, args.join(" "));
      assertCommandTiming(malformed);
    }
  });

  it("keeps unsupported and implemented edit routes typed", async () => {
    assert.deepEqual(pick(await routeCommand(["graph", "refresh", "--json"], "opcore")), {
      canonicalCommand: ["opcore", "graph", "refresh"],
      status: "unsupported",
      exitCode: 64
    });
    assert.deepEqual(pick(await routeCommand(["graph", "inspect", "--json"], "opcore")), {
      canonicalCommand: ["opcore", "graph", "inspect"],
      status: "unsupported",
      exitCode: 64
    });
    assert.deepEqual(pick(await routeCommand(["edit", "multi-edit", "--json"], "opcore")), {
      canonicalCommand: ["opcore", "edit", "multi-edit"],
      status: "unsupported",
      exitCode: 64
    });
    const editRepo = mkdtempSync(join(tmpdir(), "lattice-router-edit-"));
    try {
      mkdirSync(join(editRepo, "src"), { recursive: true });
      writeFileSync(join(editRepo, "src/a.ts"), "old\n");
      const exact = await routeCommand([
        "edit",
        "exact",
        "--repo",
        editRepo,
        "--path",
        "src/a.ts",
        "--expected",
        "old",
        "--replacement",
        "new",
        "--json"
      ], "opcore");
      assert.equal(exact.status, "ok");
      assert.equal(exact.editPlan.changes[0].content, "new\n");
      assertCommandTiming(exact);
      const patch = await routeCommand([
        "edit",
        "patch",
        "--repo",
        editRepo,
        "--request-json",
        JSON.stringify({ patch: patchFor("src/a.ts", "old", "new") }),
        "--json"
      ], "opcore");
      assert.equal(patch.status, "ok");
      assert.equal(patch.editPlan.changes[0].content, "new\n");
      assertCommandTiming(patch);
      const tree = await routeCommand([
        "edit",
        "tree",
        "--repo",
        editRepo,
        "--request-json",
        JSON.stringify({ files: [{ path: "src/a.ts", content: "tree\n" }] }),
        "--json"
      ], "opcore");
      assert.equal(tree.status, "ok");
      assert.equal(tree.editPlan.changes[0].content, "tree\n");
      assertCommandTiming(tree);
      writeFileSync(join(editRepo, "src/symbol.ts"), "export function oldName() {\n  return 1;\n}\nexport const useName = oldName();\n");
      const graphBuild = await routeCommand(["graph", "build", "--repo", editRepo, "--json"], "opcore");
      assert.equal(graphBuild.status, "ok");
      assertCommandTiming(graphBuild);
      const rename = await routeCommand([
        "edit",
        "rename",
        "--repo",
        editRepo,
        "--request-json",
        JSON.stringify({ target: { path: "src/symbol.ts", name: "oldName" }, newName: "newName" }),
        "--json"
      ], "opcore");
      assert.equal(rename.status, "ok");
      assert.match(rename.editPlan.changes[0].content, /newName/);
      assert.equal(typeof exact.message, "string");
      assertCommandTiming(rename);
    } finally {
      rmSync(editRepo, { recursive: true, force: true });
    }
    const validate = await routeCommand(["validate", "manifest", "--json"], "opcore");
    assert.equal(validate.owner, "validation");
    assert.equal(validate.status, "ok");
    assert.equal(validate.exitCode, 0);
    assertDefaultCheckIds(validate.validationResult.manifest.entries.map((entry) => entry.checkId));
    assertCommandTiming(validate);
  });

  it("routes graph-backed inspect commands through top-level inspect ownership", async () => {
    await withFixtureCopy(async (fixtureRoot) => {
      await routeCommand(["graph", "build", "--repo", fixtureRoot, "--json"], "opcore");
      const symbols = await routeCommand(["inspect", "symbols", "Greeting", "--repo", fixtureRoot, "--limit", "5", "--json"], "opcore");
      const definition = await routeCommand(["inspect", "definition", "GreetingCard", "--repo", fixtureRoot, "--json"], "opcore");
      const references = await routeCommand([
        "inspect",
        "references",
        "function:src/components/GreetingCard.tsx#GreetingCard",
        "--repo",
        fixtureRoot,
        "--limit",
        "5",
        "--json"
      ], "opcore");
      const signature = await routeCommand([
        "inspect",
        "signature",
        "function:src/components/GreetingCard.tsx#GreetingCard",
        "--repo",
        fixtureRoot,
        "--json"
      ], "opcore");
      const implementations = await routeCommand([
        "inspect",
        "implementations",
        "class:src/models.ts#GreetingModel",
        "--repo",
        fixtureRoot,
        "--json"
      ], "opcore");
      const search = await routeCommand(["inspect", "search", "Greeting", "--repo", fixtureRoot, "--limit", "5", "--json"], "opcore");

      for (const result of [symbols, definition, references, signature, implementations, search]) {
        assert.equal(result.owner, "inspect");
        assert.equal(result.status, "ok");
        assert.equal(result.exitCode, 0);
        assert.equal(result.providerStatus.state, "available");
        assertCommandTiming(result);
      }
      assert.equal(signature.inspectResult.status, "ok");
      assert.equal(signature.inspectResult.signatures.length > 0, true);
      assert.equal(signature.inspectResult.signatures[0].evidence.resolver, "language_service");
      assert.equal(Object.hasOwn(signature.inspectResult, "implementations"), false);
      assert.equal(implementations.inspectResult.status, "ok");
      assert.equal(implementations.inspectResult.implementations.length > 0, true);
      assert.equal(Object.hasOwn(implementations.inspectResult, "signatures"), false);
      assert.equal(symbols.graphQuery.nodes.some((node) => node.id === "function:src/components/GreetingCard.tsx#GreetingCard"), true);
      assert.equal(definition.graphQuery.nodes[0].id, "function:src/components/GreetingCard.tsx#GreetingCard");
      assert.equal(references.graphQuery.nodes.some((node) => node.id === "function:src/components/GreetingCard.tsx#GreetingCard"), true);
      assert.equal(references.inspectResult.status, "ok");
      assert.equal(references.inspectResult.references.length > 0, true);
      for (const reference of references.inspectResult.references) {
        assert.deepEqual(reference.evidence.graphNodeIds, ["function:src/components/GreetingCard.tsx#GreetingCard"]);
      }
      assert.equal(references.inspectResult.target.nodeId, "function:src/components/GreetingCard.tsx#GreetingCard");
      assert.equal(signature.inspectResult.route, "signature");
      assert.equal(implementations.inspectResult.route, "implementations");
      assert.equal(search.graphSearch.results[0].path, "src/components/GreetingCard.tsx");
    });
  });

  it("keeps signature and implementations fail-closed when graph evidence is unavailable", async () => {
    await withFixtureCopy(async (fixtureRoot) => {
      const signature = await routeCommand([
        "inspect",
        "signature",
        "function:src/components/GreetingCard.tsx#GreetingCard",
        "--repo",
        fixtureRoot,
        "--json"
      ], "opcore");
      const implementations = await routeCommand([
        "inspect",
        "implementations",
        "class:src/models.ts#GreetingModel",
        "--repo",
        fixtureRoot,
        "--json"
      ], "opcore");

      assert.equal(signature.owner, "inspect");
      assert.equal(signature.status, "error");
      assert.equal(signature.exitCode, 1);
      assert.notEqual(signature.providerStatus.state, "available");
      assert.equal(signature.inspectResult.failure.category, "graph_unavailable");
      assert.equal(Object.hasOwn(signature.inspectResult, "signatures"), false);
      assertCommandTiming(signature);
      assert.equal(implementations.owner, "inspect");
      assert.equal(implementations.status, "error");
      assert.equal(implementations.exitCode, 1);
      assert.notEqual(implementations.providerStatus.state, "available");
      assert.equal(implementations.inspectResult.failure.category, "graph_unavailable");
      assert.equal(Object.hasOwn(implementations.inspectResult, "implementations"), false);
      assertCommandTiming(implementations);
    });
  });

  it("returns exit 0 for status and help surfaces", async () => {
    const statusJson = await routeCommand(["status", "--json"], "opcore");
    const doctorJson = await routeCommand(["doctor", "--json"], "opcore");
    const helpJson = await routeCommand(["--help", "--json"], "opcore");
    assert.equal(statusJson.exitCode, 0);
    assert.equal(doctorJson.exitCode, 0);
    assert.equal(helpJson.exitCode, 0);
    assert.equal(doctorJson.runtimeInfo.packageName, "opcore");
    assert.equal(doctorJson.opcoreDoctor.schemaVersion, 1);
    assert.equal(doctorJson.opcoreDoctor.config.state, "missing");
    assert.equal(doctorJson.opcoreDoctor.checks.count > 0, true);
    assert.match(doctorJson.opcoreDoctor.generatedState.guidance, /\.opcore/);
    assertCommandTiming(statusJson);
    assertCommandTiming(doctorJson);
    assertCommandTiming(helpJson);
    const help = (await routeCommand(["--help"], "opcore")).message;
    assert.doesNotMatch(help, /Aliases:/);
    assert.match(help, /Local code intelligence and edit safety/);
    assert.match(help, /Examples:/);
    assert.match(help, /opcore validate pre-write/);
    assert.match(help, /Groups: graph, inspect, edit, check, validate, status, doctor/);
    assert.doesNotMatch(help, /\bstart\b/);
    assert.doesNotMatch(help, /\bstop\b/);
    const publicHelp = (await routeOpcoreCommand(["--help"])).message;
    assert.match(publicHelp, /opcore graph <build\|update\|watch\|status\|query\|serve\|impact\|review-context\|detect-changes\|search> --repo \. \[--json]/);
    const graphHelp = (await routeCommand(["graph", "--help"], "opcore")).message;
    assert.match(graphHelp, /Commands: build, update, watch, status, query, serve, impact, review-context, detect-changes, search/);
    assert.match(graphHelp, /opcore graph <build\|update\|watch\|status\|query\|serve\|impact\|review-context\|detect-changes\|search> --repo \. \[--json]/);
    const graphUpdateHelp = await routeCommand(["graph", "update", "--help", "--json"], "opcore");
    assert.equal(graphUpdateHelp.status, "ok");
    assert.deepEqual(graphUpdateHelp.canonicalCommand, ["opcore", "graph", "update", "help"]);
    assert.match(graphUpdateHelp.message, /Usage: opcore graph update/);
    assert.match(graphUpdateHelp.message, /Flags:/);
    assert.match(graphUpdateHelp.message, /Defaults:/);
    assert.match(graphUpdateHelp.message, /Examples:/);
    assert.match(graphUpdateHelp.message, /Exit codes:/);
    assert.match(graphUpdateHelp.message, /summary-oriented/);
    assert.doesNotMatch(graphUpdateHelp.message, /Commands: build, update/);
    const status = await routeCommand(["status", "--json"], "opcore");
    assertDefaultCheckIds(status.validationStatus.adapterRegistry.checkIds);
    assert.match((await routeCommand(["status"], "opcore")).message, /Run `opcore graph build`|Graph is available/);
    assert.match((await routeCommand(["graph", "status"], "opcore")).message, /Run `opcore graph build`|graph-core sidecar available/);
  });

  it("rejects lifecycle start and stop as unsupported public groups", async () => {
    for (const command of ["start", "stop"]) {
      const routed = await routeCommand([command, "--json"], "opcore");
      assert.equal(routed.owner, "runtime");
      assert.equal(routed.status, "unsupported");
      assert.equal(routed.exitCode, 64);
      assert.deepEqual(routed.canonicalCommand, ["opcore", command]);
      assertCommandTiming(routed);
    }
  });

  it("rejects stray operands on top-level runtime commands", async () => {
    const routed = await routeCommand(["status", "extra", "--json"], "opcore");
    assert.equal(routed.status, "unsupported");
    assert.equal(routed.exitCode, 64);
    assert.deepEqual(routed.canonicalCommand, ["opcore", "status", "extra"]);
    assertCommandTiming(routed);
  });

  it("emits stable JSON results from runCli", async () => {
    let output = "";
    const code = await runCli({
      bin: "opcore",
      argv: ["status", "--json"],
      stdout: (text) => {
        output += text;
      }
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(output);
    assert.equal(parsed.schemaVersion, 1);
    assert.deepEqual(parsed.canonicalCommand, ["opcore", "status"]);
    assert.equal(Object.hasOwn(parsed, "alias"), false);
    assert.equal(Object.hasOwn(parsed, removedLegacyCommandField), false);
    assertCommandTiming(parsed);
  });
});

function pick(result) {
  return {
    canonicalCommand: result.canonicalCommand,
    status: result.status,
    exitCode: result.exitCode
  };
}

function assertCommandTiming(result) {
  assert.equal(typeof result.timing?.durationMs, "number");
  assert.equal(result.timing.durationMs >= 0, true);
  assert.equal(Array.isArray(result.timing.phases), true);
  assert.equal(["cold", "warm"].includes(result.timing.processState), true);
}

function assertDefaultCheckIds(checkIds) {
  assert.equal(new Set(checkIds).size, checkIds.length);
  assert.equal(checkIds.length >= requiredDefaultCheckIds.length, true);
  for (const checkId of requiredDefaultCheckIds) {
    assert.equal(checkIds.includes(checkId), true, `missing validation check ${checkId}`);
  }
}

function patchFor(path, before, after) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}

async function withFixtureCopy(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-router-"));
  const fixtureRoot = join(temp, "wave1");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    await runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function skipGeneratedStore(source) {
  return !source.includes(`${join(".opcore", "graph")}`);
}

function corruptSnapshotSchema(fixtureRoot) {
  const db = new DatabaseSync(join(fixtureRoot, ".opcore/graph/graph.db"));
  try {
    const metadata = JSON.parse(db.prepare("select value from metadata where key = 'lattice_snapshot_metadata'").get().value);
    metadata.schemaVersion = 2;
    const value = JSON.stringify(metadata);
    db.prepare("update metadata set value = ? where key = 'lattice_snapshot_metadata'").run(value);
    db.prepare("update lattice_store set value = ? where key = 'metadata_json'").run(value);
  } finally {
    db.close();
  }
}
