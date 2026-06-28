import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeCommand } from "../packages/opcore/dist/advanced/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/inspect-symbol-parity");
const forbiddenReadOnlyFields = ["editPlan", "editResult", "validationResult", "receipt", "decision", "authority", "apply"];

it("resolves graph-backed TS and TSX implementation targets from file symbols", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    writeFileSync(join(fixtureRoot, "README.md"), "# Fixture\n");
    const expected = JSON.parse(readFileSync(join(fixtureRoot, "expected-implementations.json"), "utf8"));
    for (const target of expected.targets) await assertImplementationTarget(fixtureRoot, target);
  });
});

it("resolves node-id implementation targets through graph heritage facts", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const result = await inspectImplementations(fixtureRoot, ["class:src/models.ts#GreetingModel"]);
    assert.equal(result.status, "ok");
    assert.equal(result.inspectResult.target.nodeId, "class:src/models.ts#GreetingModel");
    assertImplementation(result, "src/models.ts", "FriendlyGreetingModel", "extends", "GreetingModel");
    assertImplementation(result, "src/aliases.ts", "AliasGreetingModel", "extends", "GreetingModel");
    assertImplementation(result, "src/components/GreetingCard.tsx", "GreetingCardModel", "extends", "GreetingModel");
    for (const entry of result.inspectResult.implementations) {
      assert.equal(entry.target.id, "class:src/models.ts#GreetingModel");
      assert.equal(entry.evidence.graphNodeIds.includes(entry.symbol.id), true);
      assert.equal(entry.evidence.graphNodeIds.includes(entry.target.id), true);
    }
  });
});

it("uses column to disambiguate same-line implementation targets", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);
    const result = await inspectImplementations(fixtureRoot, ["src/same-name.ts", "duplicate", "--line", "11", "--column", "30"]);
    assert.equal(result.status, "ok");
    assert.equal(result.inspectResult.target.nodeId, "function:src/same-name.ts#duplicate");
    assert.deepEqual(result.inspectResult.implementations, []);
  });
});

it("returns typed failures for graph, target, malformed, stale, and unsupported-language cases", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    writeFileSync(join(fixtureRoot, "README.md"), "# Fixture\n");
    await assertUnsupportedLanguageFailure(fixtureRoot);
    await assertUnavailableGraphFallback(fixtureRoot);
    await buildGraph(fixtureRoot);
    await assertAmbiguousFailure(fixtureRoot);
    await assertMissingSymbolFailure(fixtureRoot);
    await assertMalformedTargetFailure(fixtureRoot);
    await assertUnsupportedLanguageFailure(fixtureRoot);
    await assertStaleGraphFallback(fixtureRoot);
  });
});

it("degrades implementations through the language service in a generated TS repo without graph setup", async () => {
  await withGeneratedImplementationFixture(async (fixtureRoot) => {
    const result = await inspectImplementations(fixtureRoot, ["src/service.ts", "Service", "--line", "1"]);
    assertDegradedImplementationResult(result);
    assertImplementation(result, "src/worker.ts", "Worker", "implements", "Service");
  });
});

it("preserves graph-unavailable failure for Rust implementations without graph facts", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lattice-inspect-rust-impls-no-graph-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    writeFileSync(join(temp, "src/lib.rs"), "pub trait Service {}\n");

    const result = await inspectImplementations(temp, ["src/lib.rs", "Service", "--line", "1"]);

    assertInspectFailure(result, "graph_unavailable");
    assert.equal(result.providerStatus.state, "stale");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("keeps implementation inspection read-only", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    const before = fixtureChecksums(fixtureRoot);
    await buildGraph(fixtureRoot);
    const result = await inspectImplementations(fixtureRoot, ["src/models.ts", "Renderable", "--line", "9"]);
    assert.equal(result.status, "ok");
    for (const field of forbiddenReadOnlyFields) {
      assert.equal(Object.hasOwn(result, field), false, field);
      assert.equal(Object.hasOwn(result.inspectResult, field), false, `inspectResult.${field}`);
    }
    assert.deepEqual(fixtureChecksums(fixtureRoot), before);
  });
});

async function assertImplementationTarget(fixtureRoot, target) {
  const args = [target.path, target.symbolName];
  if (target.line !== undefined) args.push("--line", String(target.line));
  if (target.column !== undefined) args.push("--column", String(target.column));
  const result = await inspectImplementations(fixtureRoot, args);
  if (target.expectedFailure) {
    assertInspectFailure(result, target.expectedFailure);
    return;
  }
  assert.equal(result.owner, "inspect", target.id);
  assert.equal(result.status, "ok", target.id);
  assert.equal(result.providerStatus.state, "available", target.id);
  assert.equal(result.inspectResult.status, "ok", target.id);
  assert.equal(result.inspectResult.route, "implementations", target.id);
  assert.equal(result.inspectResult.target.path, target.path, target.id);
  assert.equal(result.inspectResult.target.symbolName, target.symbolName, target.id);
  for (const implementation of target.expectedImplementations) {
    assertImplementation(result, implementation.path, implementation.symbolName, implementation.kind, target.symbolName);
  }
  for (const entry of result.inspectResult.implementations) assertImplementationEntry(entry);
  for (const gap of target.retainedCompatibilityGaps ?? []) {
    assert.equal(
      result.inspectResult.implementations.some((entry) => entry.file === gap.path && entry.symbol.name === gap.symbolName),
      false,
      gap.symbolName
    );
  }
}

function assertImplementation(result, file, symbolName, kind, targetName) {
  const entry = result.inspectResult.implementations.find(
    (implementation) => implementation.file === file && implementation.symbol.name === symbolName && implementation.kind === kind
  );
  assert.ok(entry, `${file} ${symbolName} ${kind}`);
  assert.equal(entry.target.name, targetName);
  assert.equal(entry.evidence.resolver, "language_service");
  assert.equal(entry.evidence.graphNodeIds.includes(entry.symbol.id), true);
  assert.equal(entry.evidence.graphNodeIds.includes(entry.target.id), true);
  return entry;
}

function assertImplementationEntry(entry) {
  assert.equal(typeof entry.file, "string");
  assert.equal(entry.line > 0, true);
  assert.equal(entry.column > 0, true);
  assert.equal(typeof entry.text, "string");
  assert.equal(entry.text.length > 0, true);
  assert.equal(["implements", "inherited_implements", "extends", "interface_extends"].includes(entry.kind), true);
  assert.equal(entry.span.startLine > 0, true);
  assert.equal(entry.symbol.id.length > 0, true);
  assert.equal(entry.target.id.length > 0, true);
  assert.equal(entry.evidence.graphNodeIds.length >= 2, true);
}

async function assertUnavailableGraphFallback(fixtureRoot) {
  const result = await inspectImplementations(fixtureRoot, ["src/models.ts", "Renderable", "--line", "9"]);
  assertDegradedImplementationResult(result);
  assertImplementation(result, "src/models.ts", "GreetingModel", "implements", "Renderable");
}

async function assertAmbiguousFailure(fixtureRoot) {
  const ambiguous = await inspectImplementations(fixtureRoot, ["src/same-name.ts", "duplicate"]);
  assertInspectFailure(ambiguous, "target_ambiguous");
  assert.equal(ambiguous.inspectResult.failure.candidates.length >= 2, true);
}

async function assertMissingSymbolFailure(fixtureRoot) {
  assertInspectFailure(await inspectImplementations(fixtureRoot, ["src/models.ts", "MissingModel", "--line", "1"]), "target_not_found");
}

async function assertMalformedTargetFailure(fixtureRoot) {
  assertInspectFailure(await inspectImplementations(fixtureRoot, ["src/models.ts", "GreetingModel", "--line", "zero"]), "malformed_target");
}

async function assertUnsupportedLanguageFailure(fixtureRoot) {
  assertInspectFailure(await inspectImplementations(fixtureRoot, ["README.md", "Heading", "--line", "1"]), "unsupported_language");
  assertInspectFailure(await inspectImplementations(fixtureRoot, ["src/js-module.js", "JsGreeter", "--line", "1"]), "unsupported_language");
  assertInspectFailure(await inspectImplementations(fixtureRoot, ["src/jsx-widget.jsx", "JsxWidget", "--line", "1"]), "unsupported_language");
}

async function assertStaleGraphFallback(fixtureRoot) {
  const modelsPath = join(fixtureRoot, "src/models.ts");
  writeFileSync(modelsPath, `${readFileSync(modelsPath, "utf8")}\nexport const staleMarker = true;\n`);
  const stale = await inspectImplementations(fixtureRoot, ["src/models.ts", "Renderable", "--line", "9"]);
  assertDegradedImplementationResult(stale);
  assert.equal(stale.providerStatus.state, "stale");
}

function assertDegradedImplementationResult(result) {
  assert.equal(result.owner, "inspect");
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.notEqual(result.providerStatus.state, "available");
  assert.equal(result.inspectResult.status, "degraded");
  assert.equal(result.inspectResult.failure.category, "graph_unavailable");
  assert.equal(result.inspectResult.implementations.length > 0, true);
  for (const implementation of result.inspectResult.implementations) assertImplementationEntry(implementation);
}

async function inspectImplementations(fixtureRoot, args) {
  return routeCommand(["inspect", "implementations", ...args, "--repo", fixtureRoot, "--json"], "opcore");
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
  assert.equal(Object.hasOwn(result.inspectResult, "implementations"), false);
}

async function withFixtureCopy(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-inspect-impls-"));
  const fixtureRoot = join(temp, "inspect-symbol-parity");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    await runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function withGeneratedImplementationFixture(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-inspect-impls-generic-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    writeFileSync(
      join(temp, "src/service.ts"),
      [
        "export interface Service {",
        "  run(value: string): string;",
        "}",
        ""
      ].join("\n")
    );
    writeFileSync(
      join(temp, "src/worker.ts"),
      [
        "import type { Service } from \"./service\";",
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

function fixtureChecksums(fixtureRoot) {
  const checksums = {};
  for (const file of listFiles(join(fixtureRoot, "src"))) {
    checksums[file.slice(fixtureRoot.length + 1)] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return checksums;
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile() && statSync(path).isFile()) files.push(path);
  }
  return files.sort();
}

function skipGeneratedStore(source) {
  return !source.includes(`${resolve(sourceFixtureRoot, ".lattice")}`);
}
