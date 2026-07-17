import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const expectedWorkspacePackages = new Map([
  ["packages/contracts", "@the-open-engine/opcore-contracts"],
  ["packages/opcore", "opcore"],
  ["packages/graph", "@the-open-engine/opcore-graph"],
  ["packages/edit", "@the-open-engine/opcore-edit"],
  ["packages/validation", "@the-open-engine/opcore-validation"],
  ["packages/validation-policy", "@the-open-engine/opcore-validation-policy"],
  ["packages/validation-clone", "@the-open-engine/opcore-validation-clone"],
  ["packages/validation-docs", "@the-open-engine/opcore-validation-docs"],
  ["packages/validation-python", "@the-open-engine/opcore-validation-python"],
  ["packages/validation-rust", "@the-open-engine/opcore-validation-rust"],
  ["packages/validation-typescript", "@the-open-engine/opcore-validation-typescript"],
  ["packages/asp-provider", "@the-open-engine/opcore-asp-provider"],
  ["packages/fixtures", "@the-open-engine/opcore-fixtures"]
]);

const bundledImplementationPackages = [
  "@the-open-engine/opcore-asp-provider",
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-policy",
  "@the-open-engine/opcore-validation-clone",
  "@the-open-engine/opcore-validation-docs",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript"
];

const bundledNativePackages = [
  "@the-open-engine/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64"
];

const bundledExternalRuntimePackages = [
  "@ts-morph/common",
  "@typescript-eslint/project-service",
  "@typescript-eslint/tsconfig-utils",
  "@typescript-eslint/types",
  "@typescript-eslint/typescript-estree",
  "@typescript-eslint/visitor-keys",
  "balanced-match",
  "brace-expansion",
  "code-block-writer",
  "debug",
  "eslint-visitor-keys",
  "fdir",
  "jsonc-parser",
  "minimatch",
  "ms",
  "path-browserify",
  "picomatch",
  "semver",
  "smol-toml",
  "tinyglobby",
  "ts-api-utils",
  "ts-morph",
  "typescript"
];

const forbiddenPackagePattern =
  /@the-open-engine\/lattice-(contracts|cli|graph|edit|validation|validation-policy|validation-clone|validation-docs|validation-python|validation-rust|validation-typescript|fixtures)|github\.com\/the-open-engine\/advanced/g;

describe("Opcore public package identity", () => {
  it("uses Opcore package names for workspace package manifests", () => {
    const root = readJson("package.json");
    assert.equal(root.name, "opcore");
    assert.equal(root.repository.url, "git+https://github.com/the-open-engine/opcore.git");
    assert.deepEqual(root.workspaces, [...expectedWorkspacePackages.keys()]);

    for (const [packageDir, expectedName] of expectedWorkspacePackages) {
      const manifest = readJson(join(packageDir, "package.json"));
      assert.equal(manifest.name, expectedName, packageDir);
      assert.equal(manifest.repository.url, "git+https://github.com/the-open-engine/opcore.git", packageDir);
    }
  });

  it("ships all public release bins and descriptors from the single Opcore package", () => {
    const manifest = readJson("packages/opcore/package.json");
    assert.deepEqual(manifest.bin, {
      opcore: "dist/index.js",
      "opcore-asp-provider": "dist/asp-provider-bin.js"
    });
    assert.equal(
      manifest.exports["./descriptors/opcore.managed-tool.json"],
      "./dist/descriptors/opcore.managed-tool.json"
    );
    assert.deepEqual(
      [...manifest.bundleDependencies].sort(),
      [...bundledImplementationPackages, ...bundledNativePackages, ...bundledExternalRuntimePackages].sort()
    );
    const oldCliPackage = ["packages", "cli"].join("/");
    assert.equal(existsSync(oldCliPackage), false, `${oldCliPackage} must not remain a package`);
  });

  it("marks packaged bin entrypoints executable after build", () => {
    const binTargets = [
      "packages/opcore/dist/index.js",
      "packages/opcore/dist/asp-provider-bin.js",
      "packages/asp-provider/dist/index.js"
    ];
    for (const binTarget of binTargets) {
      accessSync(binTarget, constants.X_OK);
    }
  });

  it("documents the ASP provider as a bundled bin from the Opcore package", () => {
    const opcoreManifest = readJson("packages/opcore/package.json");
    const providerManifest = readJson("packages/asp-provider/package.json");
    assert.deepEqual(opcoreManifest.bin, {
      opcore: "dist/index.js",
      "opcore-asp-provider": "dist/asp-provider-bin.js"
    });
    assert.deepEqual(providerManifest.bin, { "opcore-asp-provider": "dist/index.js" });

    for (const path of ["docs/quickstart.md", "packages/opcore/README.md"]) {
      const content = readFileSync(path, "utf8");
      assert.match(content, /opcore-asp-provider --stdio/, path);
      assert.match(content, /single `opcore` npm package|`opcore` package exposes both/i, path);
      assert.doesNotMatch(content, /separate `@the-open-engine\/opcore-asp-provider` package/, path);
      assert.doesNotMatch(content, /(?:provides|exposes) only (?:the )?`opcore` bin/, path);
    }
  });

  it("keeps old public package identities out of release-facing package files", () => {
    const checkedFiles = [
      "package.json",
      "package-lock.json",
      ...[...expectedWorkspacePackages.keys()].map((packageDir) => join(packageDir, "package.json"))
    ];
    for (const file of checkedFiles) {
      const matches = readFileSync(file, "utf8").match(forbiddenPackagePattern) ?? [];
      assert.deepEqual(matches, [], file);
    }
  });
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
