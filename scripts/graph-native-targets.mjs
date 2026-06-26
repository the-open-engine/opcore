export const graphCoreSupportedTargets = ["darwin-arm64", "darwin-x64", "linux-x64"];

export const graphCoreNativePackagesByTarget = Object.freeze({
  "darwin-arm64": {
    packageName: "@the-open-engine/opcore-graph-core-darwin-arm64",
    packageDir: "packages/opcore-graph-core-darwin-arm64",
    os: "darwin",
    cpu: "arm64"
  },
  "darwin-x64": {
    packageName: "@the-open-engine/opcore-graph-core-darwin-x64",
    packageDir: "packages/opcore-graph-core-darwin-x64",
    os: "darwin",
    cpu: "x64"
  },
  "linux-x64": {
    packageName: "@the-open-engine/opcore-graph-core-linux-x64",
    packageDir: "packages/opcore-graph-core-linux-x64",
    os: "linux",
    cpu: "x64"
  }
});

export const graphCoreRustTargetsByNativeTarget = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl"
});

export const graphCoreNativePackageNames = graphCoreSupportedTargets.map((target) => graphCoreNativePackagesByTarget[target].packageName);

export function currentGraphCoreNativeTarget() {
  return `${process.platform}-${process.arch}`;
}

export function isSupportedGraphCoreNativeTarget(target) {
  return graphCoreSupportedTargets.includes(target);
}

export function graphCoreNativePackageForTarget(target) {
  const entry = graphCoreNativePackagesByTarget[target];
  if (!entry) {
    throw new Error(`Unsupported Opcore graph-core native target ${target}. Supported targets: ${graphCoreSupportedTargets.join(", ")}`);
  }
  return entry;
}

export function graphCoreRustTargetForNativeTarget(target) {
  const rustTarget = graphCoreRustTargetsByNativeTarget[target];
  if (!rustTarget) {
    throw new Error(`Unsupported Opcore graph-core native target ${target}. Supported targets: ${graphCoreSupportedTargets.join(", ")}`);
  }
  return rustTarget;
}

export function parseGraphCoreNativeTargetArg(argv = process.argv.slice(2)) {
  const targetFlagIndex = argv.indexOf("--target");
  const target = targetFlagIndex === -1 ? currentGraphCoreNativeTarget() : argv[targetFlagIndex + 1];
  if (!target) throw new Error("--target requires a value");
  if (!isSupportedGraphCoreNativeTarget(target)) {
    throw new Error(`Unsupported Opcore graph-core native target ${target}. Supported targets: ${graphCoreSupportedTargets.join(", ")}`);
  }
  return target;
}
