const graphReleaseSurfaceClassifications = ["required", "supporting", "optional", "deferred"] as const;

export { graphReleaseSurfaceClassifications };

type GraphReleaseSurfaceClassification = (typeof graphReleaseSurfaceClassifications)[number];

export type { GraphReleaseSurfaceClassification };

const graphReleaseCoreCommandIds = [
  "opcore-graph-build",
  "opcore-graph-update",
  "opcore-graph-watch",
  "opcore-graph-status",
  "opcore-graph-query",
  "opcore-graph-impact",
  "opcore-graph-search",
  "opcore-graph-serve",
] as const;

export { graphReleaseCoreCommandIds };

type GraphReleaseCoreCommandId = (typeof graphReleaseCoreCommandIds)[number];

export type { GraphReleaseCoreCommandId };

const graphReleaseRustCommandIds = [
  "opcore-graph-rust-build",
  "opcore-graph-rust-update",
  "opcore-graph-rust-watch",
  "opcore-graph-rust-status",
  "opcore-graph-rust-query",
  "opcore-graph-rust-impact",
  "opcore-graph-rust-search",
  "opcore-graph-rust-serve",
] as const;

export { graphReleaseRustCommandIds };

type GraphReleaseRustCommandId = (typeof graphReleaseRustCommandIds)[number];

export type { GraphReleaseRustCommandId };

const graphReleaseBenchmarkMetrics = [
  "install_setup_ms",
  "cold_build_ms",
  "incremental_update_ms",
  "impact_cold_ms",
  "impact_hot_ms",
  "search_ms",
  "daemon_startup_ms",
  "daemon_query_ms",
  "db_size_bytes",
  "wal_size_bytes",
] as const;

export { graphReleaseBenchmarkMetrics };

type GraphReleaseBenchmarkMetric = (typeof graphReleaseBenchmarkMetrics)[number];

export type { GraphReleaseBenchmarkMetric };

const graphReleaseRequiredChildren = ["#35", "#8", "#9", "#10", "#11", "#12", "#19", "#47"] as const;

export { graphReleaseRequiredChildren };

type GraphReleaseRequiredChild = (typeof graphReleaseRequiredChildren)[number];

export type { GraphReleaseRequiredChild };

const graphReleaseDeferredChildren = ["#13", "#14", "#15", "#16"] as const;

export { graphReleaseDeferredChildren };

type GraphReleaseDeferredChild = (typeof graphReleaseDeferredChildren)[number];

export type { GraphReleaseDeferredChild };

const graphReleaseOptionalAnalysisSurfaces = [
  {
    issue: "#13",
    id: "coverage",
    classification: "deferred",
    status: "deferred",
  },
  {
    issue: "#14",
    id: "flows",
    classification: "optional",
    status: "deferred",
  },
  {
    issue: "#15",
    id: "communities",
    classification: "optional",
    status: "deferred",
  },
  {
    issue: "#16",
    id: "read_only_suggestions",
    classification: "supporting",
    status: "deferred",
  },
] as const;

export { graphReleaseOptionalAnalysisSurfaces };

type GraphReleaseOptionalAnalysisSurface = (typeof graphReleaseOptionalAnalysisSurfaces)[number];

export type { GraphReleaseOptionalAnalysisSurface };

const graphReleaseHandoffIssues = ["#7", "#28", "#29"] as const;

export { graphReleaseHandoffIssues };

type GraphReleaseHandoffIssue = (typeof graphReleaseHandoffIssues)[number];

export type { GraphReleaseHandoffIssue };
