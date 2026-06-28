import { it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeCommand } from "../packages/opcore/dist/advanced/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/inspect-symbol-parity");
const removedLegacyCommandField = `legacy${"Command"}`;

it("resolves read-only file symbol signatures across TS, TSX, JS, JSX, aliases, path aliases, and overloads", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    writeFileSync(join(fixtureRoot, "README.md"), "# Heading\n");
    const expected = JSON.parse(readFileSync(join(fixtureRoot, "expected-signatures.json"), "utf8"));
    for (const target of expected.targets) {
      if (target.expectedFailure) await assertSignatureFailureTarget(fixtureRoot, target);
      else await assertSignatureTarget(fixtureRoot, target);
    }
  });
});

it("preserves async, type parameter, optional, and default parameter metadata", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const expected = JSON.parse(readFileSync(join(fixtureRoot, "expected-signatures.json"), "utf8"));
    const target = expected.targets.find((entry) => entry.id === "async-generic-default");
    const result = await inspectSignature(fixtureRoot, target.path, target.symbolName, ["--line", String(target.line)]);
    assert.equal(result.status, "ok");
    const [signature] = result.inspectResult.signatures;
    assert.equal(signature.async, true);
    assert.equal(signature.returnType, target.expectedReturnType);
    assert.deepEqual(signature.typeParameters, target.expectedTypeParameters);
    assert.deepEqual(signature.parameters, target.expectedParameters);
  });
});

it("resolves graph node id signatures for class, function, interface, and type alias nodes", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    for (const nodeId of [
      "class:src/models.ts#GreetingModel",
      "function:src/components/GreetingCard.tsx#GreetingCard",
      "type:src/models.ts#Renderable",
      "type:src/models.ts#GreetingMessage"
    ]) {
      const result = await routeCommand(["inspect", "signature", nodeId, "--repo", fixtureRoot, "--json"], "opcore");
      assert.equal(result.owner, "inspect");
      assert.equal(result.status, "ok", nodeId);
      assert.equal(result.exitCode, 0);
      assert.equal(result.providerStatus.state, "available");
      assert.equal(result.inspectResult.target.nodeId, nodeId);
      assert.equal(result.inspectResult.signatures.length > 0, true);
      for (const signature of result.inspectResult.signatures) assertSignatureEntry(signature, result.inspectResult.signatures[0].symbol.id);
    }
  });
});

it("uses column to disambiguate same-name signature targets", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const result = await inspectSignature(fixtureRoot, "src/same-name.ts", "duplicate", ["--line", "11", "--column", "30"]);
    assert.equal(result.status, "ok");
    assert.equal(result.inspectResult.target.nodeId, "function:src/same-name.ts#duplicate");
    assert.deepEqual(result.inspectResult.signatures.map((entry) => entry.signature), ["duplicate(value: string): string"]);
    assert.deepEqual(result.inspectResult.signatures[0].evidence.graphNodeIds, ["function:src/same-name.ts#duplicate"]);
  });
});

it("uses graph node id to disambiguate same-name signature targets", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const nodeId = "function:src/same-name.ts#duplicate";
    const result = await routeCommand(["inspect", "signature", nodeId, "--repo", fixtureRoot, "--json"], "opcore");
    assert.equal(result.status, "ok");
    assert.equal(result.inspectResult.target.nodeId, nodeId);
    assert.deepEqual(result.inspectResult.signatures.map((entry) => entry.signature), ["duplicate(value: string): string"]);
    assert.deepEqual(result.inspectResult.signatures[0].evidence.graphNodeIds, [nodeId]);
  });
});

it("returns typed failures for unavailable graph, stale graph, ambiguity, missing symbols, unsupported languages, malformed targets, and unbacked declarations", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await assertUnsupportedLanguageFailure(fixtureRoot);
    await assertUnavailableGraphFallback(fixtureRoot);
    await buildGraph(fixtureRoot);
    await assertAmbiguousFailure(fixtureRoot);
    await assertMissingSymbolFailure(fixtureRoot);
    await assertMalformedTargetFailure(fixtureRoot);
    await assertUnbackedDeclarationFailure(fixtureRoot);
    await assertUnknownNodeFailure(fixtureRoot);
    await assertStaleGraphFallback(fixtureRoot);
  });
});

it("degrades signatures through the language service in a generated TS repo without graph setup", async () => {
  await withGeneratedSignatureFixture(async (fixtureRoot) => {
    const result = await inspectSignature(fixtureRoot, "src/service.ts", "Service", ["--line", "1"]);
    assertDegradedSignatureResult(result);
    assert.deepEqual(result.inspectResult.signatures.map((entry) => entry.signature), [
      "export interface Service",
      "run(value: string): string"
    ]);
  });
});

it("keeps signature inspection read-only and separate from edit/ASP payloads", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const modelsPath = join(fixtureRoot, "src/models.ts");
    const before = readFileSync(modelsPath, "utf8");
    const result = await inspectSignature(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "1"]);
    const after = readFileSync(modelsPath, "utf8");
    assert.equal(result.owner, "inspect");
    assert.equal(result.status, "ok");
    assert.equal(before, after);
    for (const forbidden of ["editPlan", "editResult", "receipt", "gateAuthority", "decision", "apply"]) {
      assert.equal(result[forbidden], undefined, forbidden);
      assert.equal(result.inspectResult[forbidden], undefined, forbidden);
      assert.equal(JSON.stringify(result).includes(`"${forbidden}"`), false, forbidden);
    }
    assert.equal(Object.hasOwn(result, "alias"), false);
    assert.equal(Object.hasOwn(result, removedLegacyCommandField), false);
  });
});

async function assertSignatureTarget(fixtureRoot, target) {
  const extra = ["--line", String(target.line)];
  if (target.column !== undefined) extra.push("--column", String(target.column));
  const result = await inspectSignature(fixtureRoot, target.path, target.symbolName, extra);
  assert.equal(result.status, "ok", target.id);
  assert.equal(result.providerStatus.state, "available");
  assert.equal(result.inspectResult.status, "ok");
  assert.equal(result.inspectResult.target.path, target.path);
  assert.equal(result.inspectResult.target.symbolName, target.symbolName);
  assert.equal(result.inspectResult.target.nodeId, target.nodeId);
  assert.deepEqual(result.inspectResult.signatures.map((entry) => entry.signature), target.expectedSignatures, target.id);
  assert.deepEqual(result.inspectResult.signatures.map((entry) => entry.kind), target.expectedKinds, target.id);
  if (target.expectedOverloadIndexes) {
    assert.deepEqual(result.inspectResult.signatures.map((entry) => entry.overloadIndex), target.expectedOverloadIndexes);
  }
  for (const signature of result.inspectResult.signatures) assertSignatureEntry(signature, target.nodeId);
}

async function assertSignatureFailureTarget(fixtureRoot, target) {
  const result = await inspectSignature(fixtureRoot, target.path, target.symbolName, target.line ? ["--line", String(target.line)] : []);
  assertInspectFailure(result, target.expectedFailure);
}

function assertSignatureEntry(signature, graphNodeId) {
  assert.equal(typeof signature.file, "string");
  assert.equal(signature.line > 0, true);
  assert.equal(signature.column > 0, true);
  assert.equal(typeof signature.text, "string");
  assert.equal(signature.text.length > 0, true);
  assert.equal(typeof signature.signature, "string");
  assert.equal(signature.signature.length > 0, true);
  assert.equal(typeof signature.kind, "string");
  assert.equal(Array.isArray(signature.parameters), true);
  assert.equal(Array.isArray(signature.typeParameters), true);
  assert.equal(typeof signature.exported, "boolean");
  assert.equal(typeof signature.async, "boolean");
  assert.equal(signature.span.startLine > 0, true);
  assert.equal(signature.symbol.id.length > 0, true);
  assert.equal(signature.evidence.resolver, "language_service");
  assert.equal(signature.evidence.graphNodeIds.includes(graphNodeId), true);
}

async function assertUnavailableGraphFallback(fixtureRoot) {
  const result = await inspectSignature(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "1"]);
  assertDegradedSignatureResult(result);
  assert.equal(result.inspectResult.target.nodeId, "class:src/models.ts#GreetingModel");
}

async function assertAmbiguousFailure(fixtureRoot) {
  const ambiguous = await inspectSignature(fixtureRoot, "src/same-name.ts", "duplicate");
  assertInspectFailure(ambiguous, "target_ambiguous");
  assert.equal(ambiguous.inspectResult.failure.candidates.length >= 2, true);
}

async function assertMissingSymbolFailure(fixtureRoot) {
  assertInspectFailure(await inspectSignature(fixtureRoot, "src/models.ts", "MissingModel", ["--line", "1"]), "target_not_found");
}

async function assertUnsupportedLanguageFailure(fixtureRoot) {
  writeFileSync(join(fixtureRoot, "README.md"), "# Fixture\n");
  assertInspectFailure(await inspectSignature(fixtureRoot, "README.md", "GreetingModel", ["--line", "1"]), "unsupported_language");
}

async function assertMalformedTargetFailure(fixtureRoot) {
  assertInspectFailure(await inspectSignature(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "zero"]), "malformed_target");
}

async function assertUnbackedDeclarationFailure(fixtureRoot) {
  assertInspectFailure(await inspectSignature(fixtureRoot, "src/same-name.ts", "duplicate", ["--line", "6"]), "target_not_found");
}

async function assertUnknownNodeFailure(fixtureRoot) {
  const result = await routeCommand(["inspect", "signature", "function:src/models.ts#Missing", "--repo", fixtureRoot, "--json"], "opcore");
  assertInspectFailure(result, "target_not_found");
}

async function assertStaleGraphFallback(fixtureRoot) {
  const modelsPath = join(fixtureRoot, "src/models.ts");
  writeFileSync(modelsPath, `${readFileSync(modelsPath, "utf8")}\nexport const staleSignatureMarker = true;\n`);
  const stale = await inspectSignature(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "1"]);
  assertDegradedSignatureResult(stale);
  assert.equal(stale.providerStatus.state, "stale");
}

function assertDegradedSignatureResult(result) {
  assert.equal(result.owner, "inspect");
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.notEqual(result.providerStatus.state, "available");
  assert.equal(result.inspectResult.status, "degraded");
  assert.equal(result.inspectResult.failure.category, "graph_unavailable");
  assert.equal(result.inspectResult.signatures.length > 0, true);
  for (const signature of result.inspectResult.signatures) assertSignatureEntry(signature, result.inspectResult.target.nodeId);
}

async function inspectSignature(fixtureRoot, path, symbolName, extra = []) {
  return routeCommand([
    "inspect",
    "signature",
    path,
    symbolName,
    ...extra,
    "--repo",
    fixtureRoot,
    "--json"
  ], "opcore");
}

async function buildGraph(fixtureRoot) {
  const result = await routeCommand(["graph", "build", "--repo", fixtureRoot, "--json"], "opcore");
  assert.equal(result.status, "ok");
  assert.equal(result.providerStatus.state, "available");
}

function assertInspectFailure(result, category) {
  assert.equal(result.owner, "inspect");
  assert.equal(result.status, "error");
  assert.equal(result.inspectResult.status, "error");
  assert.equal(result.inspectResult.failure.category, category);
  assert.equal(Object.hasOwn(result.inspectResult, "signatures"), false);
}

async function withFixtureCopy(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-inspect-sig-"));
  const fixtureRoot = join(temp, "inspect-symbol-parity");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    await runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function withGeneratedSignatureFixture(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-inspect-sig-generic-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    writeFileSync(
      join(temp, "src/service.ts"),
      [
        "export interface Service {",
        "  run(value: string): string;",
        "}",
        "",
        "export class Worker implements Service {",
        "  run(value: string): string {",
        "    return value;",
        "  }",
        "}",
        ""
      ].join("\n")
    );
    await runFixture(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function skipGeneratedStore(source) {
  return !source.includes(`${resolve(sourceFixtureRoot, ".lattice")}`);
}
