import type { Project } from "ts-morph";

export type TypeScriptProjectScope = "import_closure" | "whole_repo";

export interface TypeScriptProjectProfile {
  sourceExtensions: readonly string[];
  extensionlessImportCandidates: readonly string[];
  excludedDirectories: ReadonlySet<string>;
  allowDirectoryRoots: boolean;
  configMode: "root" | "project_references";
  discoverAllConfigs: boolean;
  tolerateMalformedImportConfig: boolean;
  defaultIncludeDependents: boolean;
}

export interface TypeScriptProjectOptions {
  project?: Project;
  projectScope?: TypeScriptProjectScope;
  projectTsconfigPath?: string;
  includeDependents?: boolean;
  snapshotProject?: (project: Project) => unknown;
  revertProject?: (project: Project, snapshot: unknown) => void;
}

export interface TypeScriptProjectContext {
  project: Project;
  tsconfigPath?: string;
  snapshotProject?: (project: Project) => unknown;
  revertProject?: (project: Project, snapshot: unknown) => void;
}

export const defaultTypeScriptProjectExcludedDirectories = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".gemini",
  ".git",
  ".lattice",
  ".opencode",
  ".opcore",
  ".pnpm",
  "build",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);
