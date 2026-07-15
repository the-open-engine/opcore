import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { PythonProjectWorkspace } from "@the-open-engine/opcore-validation-python";
import type { CloneNativeInvoker } from "@the-open-engine/opcore-validation-clone";

export const configPath = ".opcore/config";

export type OpcoreValidationAdapterName = "typescript" | "rust" | "python" | "docs" | "clone";

export interface OpcorePathPolicy {
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface OpcoreMetricThresholds {
  maxFunctionLines: number;
  maxComplexity: number;
  maxParams: number;
}

export interface OpcoreFileLengthThresholds {
  maxFileLines: number;
}

export interface OpcoreLayerRule {
  name: string;
  comment?: string;
  from: string;
  to: string;
  fromNot?: readonly string[];
}

export interface OpcoreTypeScriptPolicy {
  fileLength?: OpcoreFileLengthThresholds;
  functionMetrics?: OpcoreMetricThresholds;
  lint?: {
    repoPlugin?: string;
    cacheDependencyGlobs?: readonly string[];
  };
  importGraph?: {
    ignoreTypeOnlyImports?: boolean;
    layerRules?: readonly OpcoreLayerRule[];
  };
  deadCode?: {
    entrypoints?: readonly string[];
  };
}

export interface OpcoreRustCommandGate {
  id: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface OpcoreRustPolicy {
  fileLength?: OpcoreFileLengthThresholds;
  functionMetrics?: OpcoreMetricThresholds;
  commandGates?: readonly OpcoreRustCommandGate[];
}

export interface OpcoreDocsPolicy {
  enabled?: Record<string, boolean>;
  policy?: Record<string, unknown>;
  history?: {
    maxStaleDays?: number;
  };
  hubCoverage?: {
    minFanIn?: number;
    minFanOut?: number;
    requireExplicitMention?: boolean;
  };
  subtreeCoverage?: {
    minLoc?: number;
  };
}

export interface OpcoreClonePolicy {
  windowSize?: number;
  minLines?: number;
  minTokens?: number;
  threshold?: number;
  partitions?: readonly (readonly string[])[];
  exclude?: readonly string[];
  modes?: readonly string[];
}

export interface OpcoreRepoChecksConfig {
  packs: readonly string[];
  disabled: readonly string[];
  defaults: readonly string[];
  typescript?: OpcoreTypeScriptPolicy;
  rust?: OpcoreRustPolicy;
  docs?: OpcoreDocsPolicy;
  clone?: OpcoreClonePolicy;
}

export interface OpcoreRepoValidationConfig {
  adapters?: readonly OpcoreValidationAdapterName[];
  timeoutMs?: number;
  pathPolicy?: OpcorePathPolicy;
  checks: OpcoreRepoChecksConfig;
}

export interface OpcoreRepoConfig {
  validation: OpcoreRepoValidationConfig;
}

export interface OpcoreCheckPack {
  id: string;
  version?: string;
  checks: readonly ValidationCheckDefinition[];
}

export interface OpcoreRepoValidationPolicyOptions {
  pythonProjectContexts?: readonly PythonProjectContext[];
  pythonWorkspace?: PythonProjectWorkspace;
  clone?: false | {
    invoke?: CloneNativeInvoker["invoke"];
  };
}

export const validationAdapters: readonly OpcoreValidationAdapterName[] = ["typescript", "rust", "python", "docs", "clone"];
