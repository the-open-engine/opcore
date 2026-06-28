import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const expectedWorkspacePackages = new Map([
  ["packages/contracts", "@the-open-engine/opcore-contracts"],
  ["packages/opcore", "@the-open-engine/opcore"],
  ["packages/graph", "@the-open-engine/opcore-graph"],
  ["packages/edit", "@the-open-engine/opcore-edit"],
  ["packages/validation", "@the-open-engine/opcore-validation"],
  ["packages/validation-python", "@the-open-engine/opcore-validation-python"],
  ["packages/validation-rust", "@the-open-engine/opcore-validation-rust"],
  ["packages/validation-typescript", "@the-open-engine/opcore-validation-typescript"],
  ["packages/asp-provider", "@the-open-engine/opcore-asp-provider"],
  ["packages/fixtures", "@the-open-engine/opcore-fixtures"]
]);

const forbiddenPackagePattern =
  /@the-open-engine\/lattice-(contracts|cli|graph|edit|validation|validation-python|validation-rust|validation-typescript|fixtures)|github\.com\/the-open-engine\/advanced/g;

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

  it("ships the Opcore bin and descriptor from the Opcore package", () => {
    const manifest = readJson("packages/opcore/package.json");
    assert.deepEqual(manifest.bin, {
      opcore: "dist/index.js"
    });
    assert.equal(
      manifest.exports["./descriptors/opcore.managed-tool.json"],
      "./dist/descriptors/opcore.managed-tool.json"
    );
    const oldCliPackage = ["packages", "cli"].join("/");
    assert.equal(existsSync(oldCliPackage), false, `${oldCliPackage} must not remain a package`);
  });

  it("marks packaged bin entrypoints executable after build", () => {
    const binTargets = [
      "packages/opcore/dist/index.js",
      "packages/asp-provider/dist/index.js"
    ];
    for (const binTarget of binTargets) {
      accessSync(binTarget, constants.X_OK);
    }
  });

  it("documents the ASP provider as a separate package from the Opcore CLI", () => {
    const opcoreManifest = readJson("packages/opcore/package.json");
    const providerManifest = readJson("packages/asp-provider/package.json");
    assert.deepEqual(opcoreManifest.bin, { opcore: "dist/index.js" });
    assert.deepEqual(providerManifest.bin, { "opcore-asp-provider": "dist/index.js" });

    for (const path of ["README.md", "docs/quickstart.md", "packages/opcore/README.md"]) {
      const content = readFileSync(path, "utf8");
      assert.match(content, /opcore-asp-provider --stdio/, path);
      assert.match(content, /@the-open-engine\/opcore-asp-provider/, path);
      assert.match(content, /@the-open-engine\/opcore/, path);
      assert.match(content, /(?:provides|exposes) only (?:the )?`opcore` bin/, path);
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
