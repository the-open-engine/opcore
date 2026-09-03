import type { CommandOwner, CommandRouteStatus } from "../command/vocabulary.js";

interface OpcoreTrySignalSummary {
  id: string;
  title: string;
  count: number;
  delta: number;
}

export type { OpcoreTrySignalSummary };

interface OpcoreTryScenario {
  id: string;
  repoRoot: string;
  title: string;
  commands: readonly string[];
  coverage: {
    totalFiles: number;
    validationSupportedFiles: number;
    unsupportedFiles: number;
  };
  signals: readonly OpcoreTrySignalSummary[];
}

export type { OpcoreTryScenario };

interface OpcoreTryCommandSummary {
  scenarioId: string;
  command: readonly string[];
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  exitCode: number;
}

export type { OpcoreTryCommandSummary };

interface OpcoreTryPayload {
  schemaVersion: 1;
  sampleRoot: string;
  published: false;
  scenarios: readonly OpcoreTryScenario[];
  commands: readonly OpcoreTryCommandSummary[];
}

export type { OpcoreTryPayload };
