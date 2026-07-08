export const releasePackageDirsByName = Object.freeze({
  "@the-open-engine/opcore-contracts": "packages/contracts",
  "opcore": "packages/opcore",
  "@the-open-engine/opcore-graph": "packages/graph",
  "@the-open-engine/opcore-graph-core-darwin-arm64": "packages/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64": "packages/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64": "packages/opcore-graph-core-linux-x64",
  "@the-open-engine/opcore-edit": "packages/edit",
  "@the-open-engine/opcore-validation": "packages/validation",
  "@the-open-engine/opcore-validation-clone": "packages/validation-clone",
  "@the-open-engine/opcore-validation-docs": "packages/validation-docs",
  "@the-open-engine/opcore-validation-python": "packages/validation-python",
  "@the-open-engine/opcore-validation-rust": "packages/validation-rust",
  "@the-open-engine/opcore-validation-typescript": "packages/validation-typescript",
  "@the-open-engine/opcore-asp-provider": "packages/asp-provider",
  "@the-open-engine/opcore-fixtures": "packages/fixtures"
});

export const rootWorkspacePackageDirs = Object.freeze([
  "packages/contracts",
  "packages/opcore",
  "packages/graph",
  "packages/edit",
  "packages/validation",
  "packages/validation-clone",
  "packages/validation-docs",
  "packages/validation-python",
  "packages/validation-rust",
  "packages/validation-typescript",
  "packages/asp-provider",
  "packages/fixtures"
]);

export const nativeReleasePackageNames = Object.freeze([
  "@the-open-engine/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64"
]);

export const bundledImplementationPackageNames = Object.freeze([
  "@the-open-engine/opcore-asp-provider",
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-clone",
  "@the-open-engine/opcore-validation-docs",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript"
]);

export const bundledReleasePackageNames = Object.freeze([
  ...bundledImplementationPackageNames,
  ...nativeReleasePackageNames
]);

export const bundledExternalRuntimePackageNames = Object.freeze([
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
  "minimatch",
  "ms",
  "path-browserify",
  "picomatch",
  "semver",
  "tinyglobby",
  "ts-api-utils",
  "ts-morph",
  "typescript"
]);

export const bundledOpcorePackageNames = Object.freeze([
  ...bundledReleasePackageNames,
  ...bundledExternalRuntimePackageNames
]);

export const publicReleasePackageNames = Object.freeze(["opcore"]);

export function releasePackageDirForName(packageName) {
  const packageDir = releasePackageDirsByName[packageName];
  if (!packageDir) throw new Error(`Unknown release package: ${packageName}`);
  return packageDir;
}

export function isNativeReleasePackageName(packageName) {
  return nativeReleasePackageNames.includes(packageName);
}
