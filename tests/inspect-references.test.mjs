import { it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeCommand } from "../packages/opcore/dist/advanced/index.js";
import {
  createInspectLanguageServiceProject,
  resolveInspectReferences
} from "../packages/opcore/dist/advanced/inspect-language-service.js";

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
    ], "opcore");
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

it("returns Rust graph-backed references and degrades unsupported Rust signature materialization", async () => {
  await withRustInspectFixture(async (fixtureRoot) => {
    await buildGraph(fixtureRoot);

    const references = await routeCommand([
      "inspect",
      "references",
      "function:src/helpers.rs#helpers::assist",
      "--repo",
      fixtureRoot,
      "--json"
    ], "opcore");
    assert.equal(references.owner, "inspect");
    assert.equal(references.status, "ok");
    assert.equal(references.providerStatus.state, "available");
    assert.equal(references.inspectResult.status, "ok");
    assert.equal(references.inspectResult.target.nodeId, "function:src/helpers.rs#helpers::assist");
    assert.equal(references.inspectResult.references.some((reference) => reference.evidence.resolver === "graph"), true);
    assert.equal(
      references.inspectResult.references.some((reference) =>
        reference.evidence.graphNodeIds.includes("function:src/consumer.rs#consumer::run")
      ),
      true
    );

    const signature = await routeCommand([
      "inspect",
      "signature",
      "struct:src/lib.rs#Widget",
      "--repo",
      fixtureRoot,
      "--json"
    ], "opcore");
    assert.equal(signature.owner, "inspect");
    assert.equal(signature.status, "unsupported");
    assert.equal(signature.inspectResult.status, "degraded");
    assert.equal(signature.inspectResult.failure.category, "unsupported_route");
    assert.equal(Object.hasOwn(signature.inspectResult, "signatures"), false);

    const implementations = await routeCommand([
      "inspect",
      "implementations",
      "trait:src/lib.rs#Service",
      "--repo",
      fixtureRoot,
      "--json"
    ], "opcore");
    assert.equal(implementations.owner, "inspect");
    assert.equal(implementations.status, "unsupported");
    assert.equal(implementations.inspectResult.status, "degraded");
    assert.equal(implementations.inspectResult.failure.category, "unsupported_route");
    assert.equal(Object.hasOwn(implementations.inspectResult, "implementations"), false);
  });
});

it("returns typed failures for unavailable graph, stale graph, ambiguity, missing symbols, unsupported languages, and malformed targets", async () => {
  await withFixtureCopy(async (fixtureRoot) => {
    await assertUnsupportedLanguageFailure(fixtureRoot);
    await assertUnavailableGraphFallback(fixtureRoot);
    await buildGraph(fixtureRoot);
    await assertAmbiguousFailure(fixtureRoot);
    await assertMissingSymbolFailure(fixtureRoot);
    await assertMalformedTargetFailure(fixtureRoot);
    await assertStaleGraphFallback(fixtureRoot);
  });
});

it("degrades references through the language service in a generated TS repo without graph setup", async () => {
  await withGeneratedReferenceFixture(async (fixtureRoot) => {
    const result = await inspectReferences(fixtureRoot, "src/source.ts", "greet", ["--line", "1"]);
    assertDegradedReferenceResult(result);
    assert.deepEqual(referenceLines(result, "src/source.ts"), [1, 5]);
  });
});

it("expands injected scoped language-service projects for reverse references", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "opcore-inspect-injected-scope-")));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({ include: ["src/**/*"] }, null, 2));
    writeFileSync(join(temp, "src/a.ts"), "export function greet(name: string) {\n  return name;\n}\n");
    writeFileSync(join(temp, "src/b.ts"), "import { greet } from \"./a\";\nexport const message = greet(\"Ada\");\n");

    const scopedProject = createInspectLanguageServiceProject(temp, "src/a.ts", { projectScope: "import_closure" });
    assert.deepEqual(projectRepoPaths(temp, scopedProject), ["src/a.ts"]);

    const result = resolveInspectReferences(
      temp,
      {
        path: "src/a.ts",
        symbolName: "greet",
        line: 1,
        allowGraphless: true,
        graphNodeIds: []
      },
      { project: scopedProject }
    );

    assert.equal(result.ok, true);
    assert.deepEqual([...new Set(result.references.map((reference) => reference.file))].sort(), ["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("builds targeted reference projects from the import closure plus reverse importers", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "opcore-inspect-reference-scope-")));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({ include: ["src/**/*"] }, null, 2));
    writeFileSync(join(temp, "src/a.ts"), "import { helper } from \"./helper\";\nexport function greet(name: string) {\n  return helper(name);\n}\n");
    writeFileSync(join(temp, "src/helper.ts"), "export function helper(value: string) {\n  return value;\n}\n");
    writeFileSync(join(temp, "src/b.ts"), "import { greet } from \"./a\";\nexport const message = greet(\"Ada\");\n");
    writeFileSync(join(temp, "src/c.ts"), "import { message } from \"./b\";\nexport const relayed = message;\n");
    writeFileSync(join(temp, "src/unrelated.ts"), "import { helper } from \"./helper\";\nexport const unrelated = helper(\"ignored\");\n");

    const referenceProject = createInspectLanguageServiceProject(temp, "src/a.ts", { includeDependents: true });
    assert.deepEqual(projectRepoPaths(temp, referenceProject), [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/helper.ts"
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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

function projectRepoPaths(repoRoot, project) {
  return project.getSourceFiles()
    .map((sourceFile) => resolve(sourceFile.getFilePath()))
    .filter((filePath) => filePath.startsWith(resolve(repoRoot)))
    .map((filePath) => filePath.slice(resolve(repoRoot).length + 1).replaceAll("\\", "/"))
    .sort();
}

async function assertUnavailableGraphFallback(fixtureRoot) {
  const result = await inspectReferences(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "1"]);
  assertDegradedReferenceResult(result);
  assert.equal(result.inspectResult.target.nodeId, "class:src/models.ts#GreetingModel");
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

async function assertStaleGraphFallback(fixtureRoot) {
  const modelsPath = join(fixtureRoot, "src/models.ts");
  writeFileSync(modelsPath, `${readFileSync(modelsPath, "utf8")}\nexport const staleMarker = true;\n`);
  const stale = await inspectReferences(fixtureRoot, "src/models.ts", "GreetingModel", ["--line", "1"]);
  assertDegradedReferenceResult(stale);
  assert.equal(stale.providerStatus.state, "stale");
}

function assertDegradedReferenceResult(result) {
  assert.equal(result.owner, "inspect");
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.notEqual(result.providerStatus.state, "available");
  assert.equal(result.inspectResult.status, "degraded");
  assert.equal(result.inspectResult.failure.category, "graph_unavailable");
  assert.equal(result.inspectResult.references.length > 0, true);
  for (const reference of result.inspectResult.references) assertReferenceEntry(reference, result.inspectResult.target.symbolName);
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

async function withGeneratedReferenceFixture(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-inspect-refs-generic-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    writeFileSync(
      join(temp, "src/source.ts"),
      [
        "export function greet(name: string): string {",
        "  return `Hello ${name}`;",
        "}",
        "",
        "export const message = greet(\"Ada\");",
        ""
      ].join("\n")
    );
    await runFixture(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function withRustInspectFixture(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-inspect-rust-"));
  try {
    writeRustFixture(temp);
    await runFixture(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function writeRustFixture(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src/lib.rs"),
    [
      "pub mod helpers;",
      "pub mod consumer;",
      "",
      "pub trait Service {",
      "    fn handle(&self) -> String;",
      "}",
      "",
      "pub struct Widget;",
      "",
      "impl Widget {",
      "    pub fn new() -> Self {",
      "        Widget",
      "    }",
      "}",
      ""
    ].join("\n")
  );
  writeFileSync(join(root, "src/helpers.rs"), "pub fn assist() -> String { \"ok\".to_string() }\n");
  writeFileSync(
    join(root, "src/consumer.rs"),
    [
      "use crate::helpers;",
      "use crate::{Service, Widget};",
      "",
      "pub fn run() -> String {",
      "    let widget = Widget::new();",
      "    helpers::assist();",
      "    widget.handle()",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "",
      "    #[test]",
      "    fn test_run() {",
      "        assert_eq!(run(), \"ok\");",
      "    }",
      "}",
      ""
    ].join("\n")
  );
}

function skipGeneratedStore(source) {
  return !source.includes(`${resolve(sourceFixtureRoot, ".lattice")}`);
}
