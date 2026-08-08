const graphReleaseDirectSqliteQueryIds = [
  "status-counts",
  "status-edge-counts",
  "impact-edges-from-file",
  "search-by-name",
  "freshness-metadata",
] as const;

export { graphReleaseDirectSqliteQueryIds };

type GraphReleaseDirectSqliteQueryId = (typeof graphReleaseDirectSqliteQueryIds)[number];

export type { GraphReleaseDirectSqliteQueryId };

const graphReleaseServeTransportIds = [
  "serve-jsonl-ping",
  "serve-jsonl-status",
  "serve-jsonl-query",
  "serve-jsonl-search",
  "serve-jsonl-shutdown",
] as const;

export { graphReleaseServeTransportIds };

type GraphReleaseServeTransportId = (typeof graphReleaseServeTransportIds)[number];

export type { GraphReleaseServeTransportId };

const graphReleaseReportReceiptIds = ["conformance", "pack", "license", "provenance"] as const;

export { graphReleaseReportReceiptIds };

type GraphReleaseReportReceiptId = (typeof graphReleaseReportReceiptIds)[number];

export type { GraphReleaseReportReceiptId };

const graphCoreNativeSupportedTargets = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;

export { graphCoreNativeSupportedTargets };

type GraphCoreNativeSupportedTarget = (typeof graphCoreNativeSupportedTargets)[number];

export type { GraphCoreNativeSupportedTarget };

const graphCoreNativePackageNames = [
  "@the-open-engine/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64",
] as const;

export { graphCoreNativePackageNames };

type GraphCoreNativePackageName = (typeof graphCoreNativePackageNames)[number];

export type { GraphCoreNativePackageName };

const graphCoreNativePackageNamesByTarget = {
  "darwin-arm64": "@the-open-engine/opcore-graph-core-darwin-arm64",
  "darwin-x64": "@the-open-engine/opcore-graph-core-darwin-x64",
  "linux-x64": "@the-open-engine/opcore-graph-core-linux-x64",
} as const satisfies Record<GraphCoreNativeSupportedTarget, GraphCoreNativePackageName>;

export { graphCoreNativePackageNamesByTarget };

function graphCoreNativePackageNameForTarget(target: GraphCoreNativeSupportedTarget): GraphCoreNativePackageName {
  return graphCoreNativePackageNamesByTarget[target];
}

export { graphCoreNativePackageNameForTarget };
