import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandRouterManifest, routeCommand } from "../packages/opcore/dist/advanced/index.js";

const removedLegacyCommandField = `legacy${"Command"}`;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");
const latticeBin = fileURLToPath(new URL("../packages/opcore/dist/advanced/index.js", import.meta.url));

describe("canonical CLI surface", () => {
  it("declares the canonical validate routes", () => {
    assert.deepEqual(commandRouterManifest.commandGroups.find((group) => group.name === "validate").commands, [
      "request",
      "hypothetical",
      "pre-write",
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
  });

  it("runs canonical graph routes through the Opcore bin", async () => {
    await withFixtureCopy(async (fixtureRoot) => {
      await run(["graph", "build", "--repo", fixtureRoot, "--json"]);
      assert.equal((await run(["graph", "status", "--repo", fixtureRoot, "--json"])).providerStatus.state, "available");
      assert.equal((await run(["graph", "query", "--repo", fixtureRoot, "--json"])).providerStatus.state, "available");
      const search = await run(["graph", "search", "Greeting", "--repo", fixtureRoot, "--limit", "5", "--json"]);
      assert.equal(search.graphSearch.results[0].path, "src/components/GreetingCard.tsx");
      const serve = await run(["graph", "serve", "--repo", fixtureRoot, "--json"]);
      assert.equal(serve.graphServe.state, "ready");
    });
  });

  it("runs graph-backed inspect routes through the Opcore bin", async () => {
    await withFixtureCopy(async (fixtureRoot) => {
      await run(["graph", "build", "--repo", fixtureRoot, "--json"]);
      const symbols = await run(["inspect", "symbols", "Greeting", "--repo", fixtureRoot, "--limit", "5", "--json"]);
      const definition = await run(["inspect", "definition", "GreetingCard", "--repo", fixtureRoot, "--json"]);
      const references = await run([
        "inspect",
        "references",
        "function:src/components/GreetingCard.tsx#GreetingCard",
        "--repo",
        fixtureRoot,
        "--limit",
        "5",
        "--json"
      ]);
      const signature = await run([
        "inspect",
        "signature",
        "function:src/components/GreetingCard.tsx#GreetingCard",
        "--repo",
        fixtureRoot,
        "--json"
      ]);
      const implementations = await run([
        "inspect",
        "implementations",
        "class:src/models.ts#GreetingModel",
        "--repo",
        fixtureRoot,
        "--json"
      ]);
      const search = await run(["inspect", "search", "Greeting", "--repo", fixtureRoot, "--limit", "5", "--json"]);

      for (const result of [symbols, definition, references, signature, implementations, search]) {
        assert.equal(result.owner, "inspect");
        assert.equal(result.status, "ok");
        assert.equal(result.providerStatus.state, "available");
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

  it("returns graph failures for signature and implementations without graph evidence", async () => {
    await withFixtureCopy(async (fixtureRoot) => {
      const signature = await run([
        "inspect",
        "signature",
        "function:src/components/GreetingCard.tsx#GreetingCard",
        "--repo",
        fixtureRoot,
        "--json"
      ], 1);
      const implementations = await run([
        "inspect",
        "implementations",
        "class:src/models.ts#GreetingModel",
        "--repo",
        fixtureRoot,
        "--json"
      ], 1);

      assert.equal(signature.status, "error");
      assert.equal(signature.inspectResult.failure.category, "graph_unavailable");
      assert.equal(Object.hasOwn(signature.inspectResult, "signatures"), false);
      assert.equal(implementations.status, "error");
      assert.equal(implementations.inspectResult.failure.category, "graph_unavailable");
      assert.equal(Object.hasOwn(implementations.inspectResult, "implementations"), false);
    });
  });

  it("rejects removed graph inspect route as unsupported", async () => {
    assert.equal((await run(["graph", "inspect", "--json"], 64)).status, "unsupported");
  });

  it("rejects direct old entrypoint execution through the router", async () => {
    for (const bin of ["lattice", "crg", "cix", "rox"]) {
      const result = await run(["status", "--json"], 64, bin);
      assert.equal(result.status, "unsupported");
      assert.deepEqual(result.canonicalCommand, ["opcore", "unsupported"]);
      assert.equal(Object.hasOwn(result, "alias"), false);
      assert.equal(Object.hasOwn(result, removedLegacyCommandField), false);
    }
  });

  it("keeps opcore status on validationStatus without repoState", async () => {
    const latticeStatus = await routeCommand(["status", "--json"], "opcore");
    assert.deepEqual(latticeStatus.canonicalCommand, ["opcore", "status"]);
    assert.equal(Object.hasOwn(latticeStatus, "validationStatus"), true);
    assert.equal(Object.hasOwn(latticeStatus, "repoState"), false);
  });

  it("rejects lifecycle commands and omits them from help", async () => {
    for (const command of ["start", "stop"]) {
      const result = await run([command, "--json"], 64);
      assert.equal(result.owner, "runtime");
      assert.equal(result.status, "unsupported");
      assert.deepEqual(result.canonicalCommand, ["opcore", command]);
    }

    const help = spawnSync(process.execPath, [latticeBin, "--help"], {
      env: { ...process.env, npm_lifecycle_event: undefined },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.equal(help.status, 0);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /Groups: graph, inspect, edit, check, validate, status, doctor/);
    assert.doesNotMatch(help.stdout, /\bstart\b/);
    assert.doesNotMatch(help.stdout, /\bstop\b/);
  });

  it("routes canonical edit commands and keeps future edit routes typed", async () => {
    assert.equal((await run(["edit", "multi-edit", "--json"], 64)).status, "unsupported");
    const editRepo = mkdtempSync(join(tmpdir(), "opcore-lattice-bin-edit-"));
    try {
      mkdirSync(join(editRepo, "src"), { recursive: true });
      writeFileSync(join(editRepo, "src/a.ts"), "old\n");
      const exact = await run([
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
      ]);
      assert.equal(exact.status, "ok");
      assert.equal(exact.editPlan.changes[0].content, "new\n");
      const patch = await run([
        "edit",
        "patch",
        "--repo",
        editRepo,
        "--request-json",
        JSON.stringify({ patch: patchFor("src/a.ts", "old", "new") }),
        "--json"
      ]);
      assert.equal(patch.status, "ok");
      assert.equal(patch.editPlan.changes[0].content, "new\n");
      const tree = await run([
        "edit",
        "tree",
        "--repo",
        editRepo,
        "--request-json",
        JSON.stringify({ files: [{ path: "src/a.ts", content: "tree\n" }] }),
        "--json"
      ]);
      assert.equal(tree.status, "ok");
      assert.equal(tree.editPlan.changes[0].content, "tree\n");
      assert.equal(readFileSync(join(editRepo, "src/a.ts"), "utf8"), "old\n");
    } finally {
      rmSync(editRepo, { recursive: true, force: true });
    }
    assert.equal((await run(["check", "manifest", "--json"], 0)).status, "ok");
    assert.equal((await run(["validate", "manifest", "--json"], 0)).status, "ok");
  });
});

async function run(args, expectedStatus = 0, bin = "opcore") {
  const result = spawnSync(process.execPath, [latticeBin, ...args], {
    env: { ...process.env, npm_lifecycle_event: undefined },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (bin !== "opcore") {
    const routed = await routeCommand(args, bin);
    assert.equal(routed.exitCode, expectedStatus);
    return routed;
  }
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, parsed.exitCode);
  assert.equal(result.status, expectedStatus);
  return parsed;
}

async function withFixtureCopy(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "opcore-lattice-bin-"));
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
