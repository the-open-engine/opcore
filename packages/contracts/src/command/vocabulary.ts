const commandOwners = ["graph", "inspect", "edit", "validation", "runtime"] as const;

export { commandOwners };

type CommandOwner = (typeof commandOwners)[number];

export type { CommandOwner };

const commandRouteStatuses = ["ok", "error", "not_implemented", "unsupported"] as const;

export { commandRouteStatuses };

type CommandRouteStatus = (typeof commandRouteStatuses)[number];

export type { CommandRouteStatus };

const commandTimingProcessStates = ["cold", "warm"] as const;

export { commandTimingProcessStates };

type CommandTimingProcessState = (typeof commandTimingProcessStates)[number];

export type { CommandTimingProcessState };

const commandTimingDegradationReasons = ["no_source", "no_paths"] as const;

export { commandTimingDegradationReasons };

type CommandTimingDegradationReason = (typeof commandTimingDegradationReasons)[number];

export type { CommandTimingDegradationReason };

const latencyBudgetResultStatuses = ["pass", "over"] as const;

export { latencyBudgetResultStatuses };

type LatencyBudgetResultStatus = (typeof latencyBudgetResultStatuses)[number];

export type { LatencyBudgetResultStatus };

const commandLatencyTelemetryBins = ["opcore", "opcore-asp-provider"] as const;

export { commandLatencyTelemetryBins };

type CommandLatencyTelemetryBin = (typeof commandLatencyTelemetryBins)[number];

export type { CommandLatencyTelemetryBin };

const commandLatencyTelemetryArtifactPolicy = {
  path: ".opcore/telemetry.jsonl",
  maxRecords: 500,
  maxBytes: 1024 * 1024,
  rotation: "ring_buffer",
} as const;

export { commandLatencyTelemetryArtifactPolicy };
