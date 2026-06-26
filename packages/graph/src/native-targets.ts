export const graphCoreSupportedTargets = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
export type GraphCoreSupportedTarget = (typeof graphCoreSupportedTargets)[number];

export const graphCoreNativePackageNamesByTarget = {
  "darwin-arm64": "@the-open-engine/opcore-graph-core-darwin-arm64",
  "darwin-x64": "@the-open-engine/opcore-graph-core-darwin-x64",
  "linux-x64": "@the-open-engine/opcore-graph-core-linux-x64"
} as const satisfies Record<GraphCoreSupportedTarget, string>;

export type GraphCoreNativePackageName = (typeof graphCoreNativePackageNamesByTarget)[GraphCoreSupportedTarget];

export function isSupportedGraphCoreTarget(target: string): target is GraphCoreSupportedTarget {
  return (graphCoreSupportedTargets as readonly string[]).includes(target);
}

export function graphCoreNativePackageNameForTarget(target: GraphCoreSupportedTarget): GraphCoreNativePackageName {
  return graphCoreNativePackageNamesByTarget[target];
}
