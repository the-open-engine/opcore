import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const importPattern = /\bimport(?:\s+type)?(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g;
const implementationPackages = new Set([
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript"
]);
const packageNamesByDir = new Map([
  ["contracts", "@the-open-engine/opcore-contracts"],
  ["opcore", "@the-open-engine/opcore"],
  ["graph", "@the-open-engine/opcore-graph"],
  ["edit", "@the-open-engine/opcore-edit"],
  ["validation", "@the-open-engine/opcore-validation"],
  ["validation-python", "@the-open-engine/opcore-validation-python"],
  ["validation-rust", "@the-open-engine/opcore-validation-rust"],
  ["validation-typescript", "@the-open-engine/opcore-validation-typescript"],
  ["asp-provider", "@the-open-engine/opcore-asp-provider"],
  ["fixtures", "@the-open-engine/opcore-fixtures"]
]);
const packageDirsByName = new Map([...packageNamesByDir].map(([dir, name]) => [name, dir]));

describe("package import boundaries", () => {
  it("keeps contracts independent of lattice packages", () => {
    for (const file of sourceFiles("packages/contracts/src")) {
      for (const source of imports(file)) {
        assert.equal(source.startsWith("@the-open-engine/opcore-"), false, `${file} imports ${source}`);
      }
    }
  });

  it("keeps fixtures independent of implementation packages", () => {
    for (const file of sourceFiles("packages/fixtures/src")) {
      for (const source of imports(file)) {
        assert.equal(implementationPackages.has(source), false, `${file} imports ${source}`);
      }
    }
  });

  it("keeps router and package adapter imports on public package boundaries", () => {
    for (const file of sourceFiles("packages")) {
      const packageDir = packageDirFor(file);
      for (const source of imports(file)) {
        if (source.startsWith(".")) {
          assert.equal(resolvesInsidePackage(file, source, packageDir), true, `${file} imports cross-package relative ${source}`);
          continue;
        }
        if (source.startsWith("node:")) continue;
        if (packageDir === "opcore") {
          assert.equal(
            [
              "@the-open-engine/opcore-contracts",
              "@the-open-engine/opcore-graph",
              "@the-open-engine/opcore-edit",
              "@the-open-engine/opcore-validation",
              "@the-open-engine/opcore-validation-python",
              "@the-open-engine/opcore-validation-rust",
              "@the-open-engine/opcore-validation-typescript",
              "ts-morph"
            ].includes(source),
            true,
            `${file} imports ${source}`
          );
        }
        if (packageDir === "asp-provider") {
          assert.equal(
            [
              "@the-open-engine/opcore-contracts",
              "@the-open-engine/opcore-graph",
              "@the-open-engine/opcore-validation",
              "@the-open-engine/opcore-validation-python",
              "@the-open-engine/opcore-validation-rust",
              "@the-open-engine/opcore-validation-typescript"
            ].includes(source),
            true,
            `${file} imports ${source}`
          );
        }
        if (["graph", "validation"].includes(packageDir)) {
          assert.equal(source, "@the-open-engine/opcore-contracts", `${file} imports ${source}`);
        }
        if (packageDir === "edit") {
          assert.equal(["@the-open-engine/opcore-contracts", "ts-morph"].includes(source), true, `${file} imports ${source}`);
        }
        if (packageDir === "validation-typescript") {
          assert.equal(
            ["@the-open-engine/opcore-contracts", "@the-open-engine/opcore-validation", "typescript"].includes(source),
            true,
            `${file} imports ${source}`
          );
        }
        if (packageDir === "validation-python") {
          assert.equal(
            ["@the-open-engine/opcore-contracts", "@the-open-engine/opcore-validation"].includes(source),
            true,
            `${file} imports ${source}`
          );
        }
        if (packageDir === "validation-rust") {
          assert.equal(
            ["@the-open-engine/opcore-contracts", "@the-open-engine/opcore-validation"].includes(source),
            true,
            `${file} imports ${source}`
          );
        }
      }
    }
  });

  it("keeps adapter packages free of aggregate CLI dependencies", () => {
    for (const packageDir of ["graph", "edit", "validation", "validation-python", "validation-rust", "asp-provider"]) {
      const manifest = JSON.parse(readFileSync(`packages/${packageDir}/package.json`, "utf8"));
      assert.equal(manifest.dependencies?.["@the-open-engine/opcore"], undefined, packageDir);
      const tsconfig = JSON.parse(readFileSync(`packages/${packageDir}/tsconfig.json`, "utf8"));
      assert.equal(
        (tsconfig.references ?? []).some((reference) => reference.path === "../cli"),
        false,
        packageDir
      );
    }
  });

  it("keeps internal package dependencies acyclic", () => {
    const graph = new Map();
    for (const [dir, name] of packageNamesByDir) {
      const manifest = JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8"));
      graph.set(
        name,
        Object.keys(manifest.dependencies ?? {}).filter((dependency) => packageDirsByName.has(dependency))
      );
    }
    for (const packageName of graph.keys()) {
      assertNoCycle(packageName, graph, [], new Set());
    }
  });

  it("keeps edit and validation integration on graph-provider contracts", () => {
    const forbidden = [
      /graph-core/i,
      /lattice-graph-core/i,
      /resolveGraphCoreArtifact/i,
      /native artifact loader/i,
      /raw sqlite/i,
      /graph sqlite/i,
      /graph-reference-evidence execution/i,
      /\bcrg\s+(status|serve|query|refresh|build|inspect|impact|search)\b/i
    ];
    for (const packageDir of ["edit", "validation"]) {
      for (const file of sourceFiles(`packages/${packageDir}/src`)) {
        const content = readFileSync(file, "utf8");
        for (const pattern of forbidden) {
          assert.equal(pattern.test(content), false, `${file} matches ${pattern}`);
        }
      }
    }
  });
});

function sourceFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    } else if (entry.isSymbolicLink() && statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    }
  }
  return files;
}

function imports(file) {
  const content = readFileSync(file, "utf8");
  return [...content.matchAll(importPattern)].map((match) => match[1]);
}

function packageDirFor(file) {
  return file.split(/[\\/]/)[1];
}

function resolvesInsidePackage(file, source, packageDir) {
  const fromDir = file.split(/[\\/]/).slice(0, -1).join("/");
  const resolved = join(fromDir, source).replaceAll("\\", "/");
  return resolved.startsWith(`packages/${packageDir}/src/`) || resolved.startsWith(`packages/${packageDir}/dist/`);
}

function assertNoCycle(packageName, graph, stack, visited) {
  if (stack.includes(packageName)) {
    throw new Error(`Internal package dependency cycle: ${[...stack, packageName].join(" -> ")}`);
  }
  if (visited.has(packageName)) return;
  visited.add(packageName);
  for (const dependency of graph.get(packageName) ?? []) {
    assertNoCycle(dependency, graph, [...stack, packageName], visited);
  }
}
