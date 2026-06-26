export const releasePackageDirsByName = Object.freeze({
  "@the-open-engine/lattice-contracts": "packages/contracts",
  "@the-open-engine/opcore": "packages/opcore",
  "@the-open-engine/lattice-cli": "packages/cli",
  "@the-open-engine/lattice-graph": "packages/graph",
  "@the-open-engine/opcore-graph-core-darwin-arm64": "packages/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64": "packages/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64": "packages/opcore-graph-core-linux-x64",
  "@the-open-engine/lattice-edit": "packages/edit",
  "@the-open-engine/lattice-validation": "packages/validation",
  "@the-open-engine/lattice-validation-rust": "packages/validation-rust",
  "@the-open-engine/lattice-validation-typescript": "packages/validation-typescript",
  "@the-open-engine/opcore-asp-provider": "packages/asp-provider",
  "@the-open-engine/lattice-fixtures": "packages/fixtures"
});

export const rootWorkspacePackageDirs = Object.freeze([
  "packages/contracts",
  "packages/opcore",
  "packages/cli",
  "packages/graph",
  "packages/edit",
  "packages/validation",
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

export function releasePackageDirForName(packageName) {
  const packageDir = releasePackageDirsByName[packageName];
  if (!packageDir) throw new Error(`Unknown release package: ${packageName}`);
  return packageDir;
}

export function isNativeReleasePackageName(packageName) {
  return nativeReleasePackageNames.includes(packageName);
}
