import type {
  OpcoreInitInteraction,
  OpcoreInitPlanPayload,
  OpcoreInitScanSummary,
  OpcoreInitSettings,
  OpcoreInitTiming,
  ParsedCommandArgv
} from "@the-open-engine/opcore-contracts";
import type { InstallWizardRenderer } from "./install-wizard.js";
import type { OpcoreScanAnalysis } from "./scan.js";
import type { RepoResolution } from "./status.js";

export type OpcoreSetupCommand = "init" | "install" | "uninstall";
export type InitScope = "repo" | "global";

export interface ParsedInitArgs {
  command: OpcoreSetupCommand;
  repo: string;
  repoExplicit: boolean;
  scope: InitScope;
  scopeExplicit: boolean;
  approved: boolean;
  dryRun: boolean;
  failClosedHook: boolean;
  agentSkill: boolean;
  writeGateHooks: boolean;
  activePreCommitHook: boolean;
  undo: boolean;
}

export interface OpcoreInitRuntime {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  stderrColor?: boolean;
  stderrTrueColor?: boolean;
  homeDir?: string;
  writeStderr?: (text: string) => void;
  scanAnalysis?: (resolution: RepoResolution) => Promise<OpcoreScanAnalysis>;
  initProgressIntervalMs?: number;
  readLine?: (prompt: string) => Promise<string>;
  readKey?: () => Promise<string>;
  initWizardMotion?: boolean;
}

export interface InitContext {
  scan: OpcoreInitScanSummary;
  settings: OpcoreInitSettings;
  interaction: OpcoreInitInteraction;
  timings: OpcoreInitTiming;
}

export interface TimingState {
  startedAt: number;
  scanMs: number;
  planMs: number;
  promptMs: number;
  applyMs: number;
}

export interface PlannedInit {
  payload: OpcoreInitPlanPayload;
  writes: readonly PlannedWrite[];
}

export type PlannedWrite = PlannedFileWrite | PlannedManagedLineAppend;

export interface PlannedFileWrite {
  kind: "write";
  path: string;
  targetScope: InitScope;
  content: string;
  executable?: boolean;
}

export interface PlannedManagedLineAppend {
  kind: "append_managed_line";
  path: string;
  targetScope: "repo";
  line: string;
}

export interface UndoMetadata {
  schemaVersion: 1;
  kind: "opcore_init_undo" | "opcore_global_init_undo";
  repoRoot?: string;
  homeRoot?: string;
  entries: readonly UndoEntry[];
}

export type UndoEntry = FileUndoEntry | ManagedLineUndoEntry;

export interface FileUndoEntry {
  kind?: "restore_file";
  path: string;
  existed: boolean;
  content?: string;
}

export interface ManagedLineUndoEntry {
  kind: "append_managed_line";
  path: string;
  existed: boolean;
  line: string;
  appended?: string;
}

export interface SetupSession {
  argv: readonly string[];
  json: boolean;
  parsed: ParsedCommandArgv;
  repoRoot: string;
  requestedPath: string;
  git: boolean;
  homeRoot: string;
  options: ParsedInitArgs;
  context: InitContext;
  timing: TimingState;
  runtime: OpcoreInitRuntime;
  command: OpcoreSetupCommand;
}

export interface WizardSession extends SetupSession {
  wizard: InstallWizardRenderer;
}
