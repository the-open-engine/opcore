import type {
  CommandRouterResult,
  GraphProviderMode,
  OpcoreMetricReport,
  OpcoreRepoStatePayload,
  ValidationRequest,
  ValidationResult
} from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult } from "@the-open-engine/opcore-contracts";
import {
  createNodeValidationWorkspace,
  createValidationRunner,
  type ValidationCheckDefinition,
  type ValidationWorkspace
} from "@the-open-engine/opcore-validation";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { formatScanPlate } from "./plate.js";
import { createOpcoreMetricReport, writeOpcoreMetricArtifacts } from "./reporting.js";
import { activeValidationAdaptersForCoverage, failedValidationCheckIds } from "./scan-presentation.js";
import { commonSkippedPathSegments, createRepoState, parseOpcoreRepoArgs, type RepoResolution, resolveRepo } from "./status.js";
import {
  createOpcoreValidationGraphProviderClient,
  defaultValidationChecks,
  opcorePublicValidationRuntimePolicy
} from "./validation-composition.js";

const skippedPathSegments = new Set<string>(commonSkippedPathSegments);

export interface OpcoreScanAnalysis {
  repoState: OpcoreRepoStatePayload;
  validationResult: ValidationResult;
  metricReport: OpcoreMetricReport;
  message: string;
}

export async function routeOpcoreScan(
  argv: readonly string[],
  args: readonly string[],
  json: boolean,
  presentation: { stdoutIsTTY: boolean; color: boolean } = { stdoutIsTTY: false, color: false }
): Promise<CommandRouterResult> {
  const parsed = parseOpcoreRepoArgs(args, "opcore scan");
  if (!parsed.ok) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "scan"],
      owner: "runtime",
      status: "error",
      json,
      message: parsed.message
    });
  }
  const resolution = resolveRepo(parsed.repo, "opcore scan");
  if (!resolution.ok) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "scan"],
      owner: "runtime",
      status: "error",
      json,
      message: resolution.message
    });
  }
  const analysis = await createOpcoreScanAnalysis(resolution.resolution);
  writeOpcoreMetricArtifacts(analysis.repoState.repo.root, analysis.metricReport);
  const fancy = presentation.stdoutIsTTY && !json;
  const message = fancy
    ? formatScanPlate(analysis.repoState, analysis.validationResult, { color: presentation.color })
    : analysis.message;
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", "scan"],
    owner: "runtime",
    status: "ok",
    json,
    message,
    repoState: analysis.repoState,
    validationResult: analysis.validationResult
  });
}

export async function createOpcoreScanAnalysis(resolution: RepoResolution): Promise<OpcoreScanAnalysis> {
  const repoState = createRepoState(resolution);
  const graphMode: GraphProviderMode = repoState.graph.state === "available" ? "required" : "optional";
  const validationRequest: ValidationRequest = {
    repo: {
      repoRoot: repoState.repo.root
    },
    scope: {
      kind: "all"
    },
    graph: {
      mode: graphMode,
      provider: "opcore-graph"
    },
    overlays: []
  };
  const validationResult = await createValidationRunner({
    workspace: createScanWorkspace(resolution),
    checks: scanValidationChecks(repoState),
    graphProviderClient: createOpcoreValidationGraphProviderClient(),
    runtime: opcorePublicValidationRuntimePolicy
  }).runValidation(validationRequest);
  const metricReport = createOpcoreMetricReport({
    repoState,
    validationResult
  });
  return {
    message: formatScanMessage(repoState, validationResult),
    repoState,
    validationResult,
    metricReport
  };
}

function scanValidationChecks(repoState: OpcoreRepoStatePayload): readonly ValidationCheckDefinition[] {
  const activeAdapters = activeValidationAdaptersForCoverage(repoState.coverage);
  return defaultValidationChecks.filter((check) => activeAdapters.has(check.adapter));
}

function createScanWorkspace(resolution: RepoResolution): ValidationWorkspace {
  if (resolution.git) {
    return createNodeValidationWorkspace({
      repoRoot: resolution.root,
      skippedPathSegments: commonSkippedPathSegments
    });
  }
  return createReadOnlyWorkspace(resolution.root);
}

function createReadOnlyWorkspace(repoRoot: string): ValidationWorkspace {
  const root = resolve(repoRoot);
  return {
    readFile: async (path) => {
      try {
        return {
          status: "found",
          content: await readFile(resolveRepoPath(root, path), "utf8")
        };
      } catch (error) {
        if (isMissingFileError(error)) return { status: "missing" };
        throw error;
      }
    },
    listRepoFiles: async () => ({
      files: await listRepoFiles(root)
    }),
    listChangedFiles: async () => ({
      files: await listRepoFiles(root)
    }),
    listStagedFiles: async () => ({
      files: await listRepoFiles(root)
    })
  };
}

async function listRepoFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (skippedPathSegments.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (hasSkippedSegment(path)) continue;
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}

function formatScanMessage(repoState: OpcoreRepoStatePayload, validationResult: ValidationResult): string {
  const unsupported = repoState.coverage.unsupported.stacks.length === 0
    ? "none"
    : repoState.coverage.unsupported.stacks.map((stack) => `${stack.language} ${stack.count}`).join(", ");
  const languages = repoState.coverage.languages.length === 0
    ? "none"
    : repoState.coverage.languages.map((entry) => `${entry.language} ${entry.files}`).join(", ");
  const degradedValidationTools = repoState.validation.degradedToolchains.length === 0
    ? "none"
    : repoState.validation.degradedToolchains.map((tool) => `${tool.adapter}:${tool.tool}`).join(", ");
  const failedChecks = failedValidationCheckIds(validationResult);
  return [
    "Coverage:",
    `  files=${repoState.coverage.totalFiles}`,
    `  graph-supported=${repoState.coverage.graph.supportedFiles}`,
    `  validation-supported=${repoState.coverage.validation.supportedFiles}`,
    `  validation-retained=${repoState.coverage.validation.retainedFiles}`,
    `  unsupported=${unsupported}`,
    `  languages=${languages}`,
    `  degraded-validation-tools=${degradedValidationTools}`,
    "Findings:",
    `  diagnostics=${validationResult.diagnostics.length}`,
    `  validation=${validationResult.status}`,
    `  failed-checks=${failedChecks.length === 0 ? "none" : failedChecks.join(", ")}`,
    `  activation=${repoState.activation.level}; ${repoState.activation.summary}`,
    "Next:",
    ...repoState.nextActions.slice(0, 2).map((action) => `  ${action}`)
  ].join("\n");
}

function resolveRepoPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const normalized = relative(root, absolute);
  if (normalized === "" || normalized.startsWith("..") || normalized.split(sep).includes("..")) {
    throw new Error(`Repo-relative path escapes repository: ${path}`);
  }
  return absolute;
}

function hasSkippedSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => skippedPathSegments.has(segment));
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
  );
}
