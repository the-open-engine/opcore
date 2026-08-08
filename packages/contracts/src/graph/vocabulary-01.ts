const GRAPH_SCHEMA_VERSION = 1 as const;

export { GRAPH_SCHEMA_VERSION };

const CLONE_PROTOCOL = "opcore.clone.v1" as const;

export { CLONE_PROTOCOL };

const graphProviderModes = ["optional", "required"] as const;

export { graphProviderModes };

type GraphProviderMode = (typeof graphProviderModes)[number];

export type { GraphProviderMode };

const graphProviderStatusStates = [
  "available",
  "warming",
  "skipped",
  "required_missing",
  "stale",
  "schema_mismatch",
  "daemon_unavailable",
  "error",
] as const;

export { graphProviderStatusStates };

type GraphProviderStatusState = (typeof graphProviderStatusStates)[number];

export type { GraphProviderStatusState };

const requiredGraphNodeKinds = [
  "repo",
  "package",
  "file",
  "symbol",
  "test",
  "File",
  "Module",
  "Class",
  "Function",
  "Variable",
  "Type",
  "Test",
  "Struct",
  "Enum",
  "Trait",
  "Impl",
  "Method",
  "TypeAlias",
  "Const",
  "Static",
  "Macro",
] as const;

export { requiredGraphNodeKinds };

type GraphNodeKind = (typeof requiredGraphNodeKinds)[number] | (string & {});

export type { GraphNodeKind };

const requiredGraphEdgeKinds = [
  "CONTAINS",
  "DECLARES",
  "IMPORTS_FROM",
  "CALLS",
  "TESTED_BY",
  "INHERITS",
  "IMPLEMENTS",
  "DEPENDS_ON",
] as const;

export { requiredGraphEdgeKinds };

type GraphEdgeKind = (typeof requiredGraphEdgeKinds)[number] | (string & {});

export type { GraphEdgeKind };

const graphSnapshotMetadataKeys = [
  "schemaVersion",
  "provider",
  "repo",
  "generatedAt",
  "freshness",
  "nodeKinds",
  "edgeKinds",
] as const;

export { graphSnapshotMetadataKeys };

type GraphSnapshotMetadataKey = (typeof graphSnapshotMetadataKeys)[number];

export type { GraphSnapshotMetadataKey };

const providerFailureCategories = [
  "provider_missing",
  "daemon_unavailable",
  "schema_mismatch",
  "stale_snapshot",
  "query_failed",
  "incompatible_provider",
  "provider_error",
  "permission_denied",
  "unsupported_mode",
  "unknown",
] as const;

export { providerFailureCategories };

type ProviderFailureCategory = (typeof providerFailureCategories)[number];

export type { ProviderFailureCategory };

const graphProviderFailureCategoriesByState = {
  skipped: ["provider_missing"],
  required_missing: ["provider_missing"],
  stale: ["stale_snapshot"],
  schema_mismatch: ["schema_mismatch"],
  daemon_unavailable: ["daemon_unavailable"],
  error: [
    "query_failed",
    "incompatible_provider",
    "provider_error",
    "permission_denied",
    "unsupported_mode",
    "unknown",
  ],
} as const satisfies Record<
  Exclude<GraphProviderStatusState, "available" | "warming">,
  readonly ProviderFailureCategory[]
>;

export { graphProviderFailureCategoriesByState };

type GraphProviderErrorFailureCategory = (typeof graphProviderFailureCategoriesByState.error)[number];

export type { GraphProviderErrorFailureCategory };
