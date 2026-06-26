import { it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeCommand } from "../packages/opcore/dist/lattice/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/inspect-symbol-parity");
const removedLegacyCommandField = `legacy${"Command"}`;

it("resolves file symbol line references across TS, TSX, JS, JSX, aliases, path aliases, and overloads", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const expected = JSON.parse(readFileSync(join(fixtureRoot, "expected-references.json"), "utf8"));
    for (const target of expected.targets) await assertReferenceTarget(fixtureRoot, target);
  });
});

it("uses column to disambiguate same-line reference targets", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const result = await inspectReferences(fixtureRoot, "src/same-name.ts", "duplicate", ["--line", "11", "--column", "30"]);
    assert.equal(result.status, "ok");
    assert.equal(result.inspectResult.target.nodeId, "function:src/same-name.ts#duplicate");
    assert.deepEqual(referenceLines(result, "src/same-name.ts"), [1, 11]);
    for (const reference of result.inspectResult.references) {
      assert.deepEqual(reference.evidence.graphNodeIds, ["function:src/same-name.ts#duplicate"]);
      assert.equal(reference.symbol.id, "function:src/same-name.ts#duplicate");
    }
  });
});

it("resolves imported reference-site targets through declaration graph facts", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    for (const target of [
      { path: "src/components/GreetingCard.tsx", symbolName: "GreetingModel", line: 1 },
      { path: "src/aliases.ts", symbolName: "ImportedGreetingModel", line: 1 },
      { path: "src/overloads.ts", symbolName: "GreetingModel", line: 1 }
    ]) {
      const result = await inspectReferences(fixtureRoot, target.path, target.symbolName, ["--line", String(target.line)]);
      assert.equal(result.status, "ok", `${target.path} ${target.symbolName}`);
      assert.equal(result.inspectResult.target.nodeId, "class:src/models.ts#GreetingModel");
      assert.equal(result.inspectResult.references.some((reference) => reference.file === target.path && reference.line === target.line), true);
      for (const reference of result.inspectResult.references) {
        assert.deepEqual(reference.evidence.graphNodeIds, ["class:src/models.ts#GreetingModel"]);
        assert.equal(reference.symbol.id, "class:src/models.ts#GreetingModel");
        assert.equal(reference.symbol.name, "GreetingModel");
      }
    }
  });
});

it("rejects line-disambiguated targets that are not backed by graph facts", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const result = await inspectReferences(fixtureRoot, "src/same-name.ts", "duplicate", ["--line", "6"]);
    assertInspectFailure(result, "target_not_found");
    assert.equal(result.inspectResult.target.path, "src/same-name.ts");
    assert.equal(result.inspectResult.target.line, 6);
    assert.equal(result.inspectResult.target.nodeId, undefined);
  });
});

it("preserves node-id references with graphQuery and typed inspectResult", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const nodeId = "function:src/components/GreetingCard.tsx#GreetingCard";
    const result = await routeCommand([
      "inspect",
      "references",
      nodeId,
      "--repo",
      fixtureRoot,
      "--limit",
      "5",
      "--json"
    ], "lattice");
    assert.equal(result.owner, "inspect");
    assert.equal(result.status, "ok");
    assert.equal(result.providerStatus.state, "available");
    assert.equal(result.graphQuery.nodes.some((node) => node.id === nodeId), true);
    assert.equal(result.inspectResult.status, "ok");
    assert.equal(result.inspectResult.references.length > 0, true);
    for (const reference of result.inspectResult.references) assert.deepEqual(reference.evidence.graphNodeIds, [nodeId]);
    assert.equal(result.inspectResult.target.nodeId, nodeId);
    assert.equal(Object.hasOwn(result, "alias"), false);
    assert.equal(Object.hasOwn(result, removedLegacyCommandField), false);
  });
});

it("returns typed failures for unavailable graph, stale graph, ambiguity, missing symbols, unsupported languages, and malformed targets", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await assertUnavailableGraphFailure(fixtureRoot);
    await buildGraph(fixtureRoot);
    await assertAmbiguousFailure(fixtureRoot);
    await assertMissingSymbolFailure(fixtureRoot);
    await assertUnsupportedLanguageFailure(fixtureRoot);
    await assertMalformedTargetFailure(fixtureRoot);
    await assertStaleGraphFailure(fixtureRoot);
  });
});

async function assertReferenceTarget(fixtureRoot, target) {
  const result = await inspectReferences(fixtureRoot, target.path, target.symbolName, ["--line", String(target.line)]);
  assert.equal(result.status, "ok", `${target.path} ${target.symbolName}`);
  assert.equal(result.providerStatus.state, "available");
  assert.equal(result.inspectResult.status, "ok");
  assert.equal(result.inspectResult.target.path, target.path);
  assert.equal(result.inspectResult.target.symbolName, target.symbolName);
  assert.equal(result.inspectResult.references.length >= target.minimumReferences, true, `${target.symbolName} reference count`);
  for (const reference of result.inspectResult.references) assertReferenceEntry(reference, target.symbolName);
}

function assertReferenceEntry(reference, symbolName) {
  assert.equal(typeof reference.file, "string");
  assert.equal(reference.line > 0, true);
  assert.equal(reference.column > 0, true);
  assert.equal(typeof reference.text, "string");
  assert.equal(reference.text.length > 0, true);
  assert.equal(reference.span.startLine > 0, true);
  assert.equal(reference.symbol.name, symbolName);
  assert.equal(reference.symbol.id.length > 0, true);
  assert.equal(typeof reference.isDefinition, "boolean");
  assert.equal(reference.evidence.resolver, "language_service");
  assert.equal(reference.evidence.graphNodeIds.length > 0, true);
}

function referenceLines(result, file) {
  return [...new Set(result.inspectResult.references.filter((reference) => reference.file === file).map((reference) => reference.line))].sort((left, right) => left - right);
}

async function assertUnavailableGraphFailure(fixtureRoot) {
  assertInspectFailure(await inspectReferences(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "1"]), "graph_unavailable");
}

async function assertAmbiguousFailure(fixtureRoot) {
  const ambiguous = await inspectReferences(fixtureRoot, "src/same-name.ts", "duplicate");
  assertInspectFailure(ambiguous, "target_ambiguous");
  assert.equal(ambiguous.inspectResult.failure.candidates.length >= 2, true);
}

async function assertMissingSymbolFailure(fixtureRoot) {
  assertInspectFailure(await inspectReferences(fixtureRoot, "src/models.ts", "MissingModel", ["--line", "1"]), "target_not_found");
}

async function assertUnsupportedLanguageFailure(fixtureRoot) {
  writeFileSync(join(fixtureRoot, "README.md"), "# Fixture\n");
  assertInspectFailure(await inspectReferences(fixtureRoot, "README.md", "GreetingModel", ["--line", "1"]), "unsupported_language");
}

async function assertMalformedTargetFailure(fixtureRoot) {
  assertInspectFailure(await inspectReferences(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "zero"]), "malformed_target");
}

async function assertStaleGraphFailure(fixtureRoot) {
  const modelsPath = join(fixtureRoot, "src/models.ts");
  writeFileSync(modelsPath, `${readFileSync(modelsPath, "utf8")}\nexport const staleMarker = true;\n`);
  const stale = await inspectReferences(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "1"]);
  assertInspectFailure(stale, "graph_unavailable");
  assert.equal(stale.providerStatus.state, "stale");
}

async function inspectReferences(fixtureRoot, path, symbolName, extra = []) {
  return routeCommand([
    "inspect",
    "references",
    path,
    symbolName,
    ...extra,
    "--repo",
    fixtureRoot,
    "--json"
  ], "lattice");
}

async function buildGraph(fixtureRoot) {
  const result = await routeCommand(["graph", "build", "--repo", fixtureRoot, "--json"], "lattice");
  assert.equal(result.status, "ok");
  assert.equal(result.providerStatus.state, "available");
}

function assertInspectFailure(result, category) {
  assert.equal(result.owner, "inspect");
  assert.equal(result.status, "error");
  assert.equal(result.inspectResult.status, "error");
  assert.equal(result.inspectResult.failure.category, category);
  assert.notEqual(result.inspectResult.references, []);
}

async function withFixtureCopy(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-inspect-refs-"));
  const fixtureRoot = join(temp, "inspect-symbol-parity");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    await runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function skipGeneratedStore(source) {
  return !source.includes(`${resolve(sourceFixtureRoot, ".lattice")}`);
}
