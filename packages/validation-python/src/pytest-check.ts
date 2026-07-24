import type {
  GraphFactEdge,
  PythonProjectContext,
  PythonProjectToolProvenance,
  PythonValidationCapabilityRun,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_PYTEST_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { createRelevantTestsGraphRequirements } from "./graph-requirements.js";
import { isRelevantPythonConfig } from "./project-config-files.js";
import { executeProjectPytest } from "./pytest-project-runner.js";
import { candidateFailure, disabledPytestRun, failureRun, notApplicableRun, unsupportedPytestTool, unsupportedRun } from "./pytest-result.js";
import type { ProjectRunInput } from "./pytest-types.js";
import { pytestWorkspaceCaps } from "./pytest-workspace.js";
import { type PythonProjectWorkspace } from "./project-workspace.js";
import {
  isPythonSourcePath,
  pythonProjectInputSet,
  type PythonProjectContextResolver,
  type PythonSourceRootResolver
} from "./source-files.js";
import type { PythonValidationToolchainOptions } from "./toolchain.js";

interface CreatePytestCheckOptions extends Omit<PythonValidationToolchainOptions, "contexts"> {}

interface CandidateSelectionState {
  exactTargets: ReadonlySet<string>;
  projectWideRoots: readonly PythonProjectContext[];
}

export { disabledPytestRun };

export function createPytestCheck(
  options: CreatePytestCheckOptions = {},
  resolveContexts?: PythonProjectContextResolver,
  resolveRoots?: PythonSourceRootResolver
): ValidationCheckDefinition {
  const resolveRootPaths = resolveRoots ?? (async (context) => pythonProjectInputSet(context));
  return {
    id: PYTHON_PYTEST_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    defaultScopes: [],
    inactiveResult: async (context, state) =>
      !hasRelevantPytestInput(context)
        ? undefined
        : state === "disabled"
          ? disabledPytestRun()
          : notApplicableRun("Python pytest execution is opt-in."),
    inactiveStateWhenUnselected: "not_applicable",
    requiresGraph: true,
    graphRequirements: createRelevantTestsGraphRequirements(resolveRootPaths),
    run: async (context) => runPytestCheck(context, options.nodeWorkspace, resolveContexts)
  };
}

async function runPytestCheck(
  context: ValidationCheckContext,
  nodeWorkspace: PythonProjectWorkspace | undefined,
  resolveContexts: PythonProjectContextResolver | undefined
) {
  const targets = pythonProjectInputSet(context);
  if (targets.length === 0) return notApplicableRun("No Python source or config targets selected.");
  if (resolveContexts === undefined) {
    return failureRun("PYTHON_PYTEST_CONTEXT_MISSING", "Canonical Python project context resolver is required.", "tool_failure");
  }
  const rootContexts = await resolveContexts(context, targets);
  const unresolved = rootContexts.find(isUnresolvedPytestContext);
  if (unresolved !== undefined) {
    return unsupportedRun(unresolved, `Python pytest execution requires a resolved project context for ${unresolved.target}.`);
  }
  const selectedCandidates = selectCandidatePaths(rootContexts, await context.graph.testedBy());
  if (selectedCandidates.length === 0) {
    return candidateFailure(rootContexts, [], "No TESTED_BY graph candidate tests matched the selected Python targets.");
  }
  if (selectedCandidates.length > pytestWorkspaceCaps.maxCandidateFiles) {
    return failureRun("PYTHON_PYTEST_CANDIDATE_OVERFLOW", `Pytest candidate selection exceeded ${pytestWorkspaceCaps.maxCandidateFiles} files.`, "tool_failure", rootContexts, selectedCandidates);
  }
  const candidateContexts = await resolveContexts(context, selectedCandidates);
  const groups = groupProjects(candidateContexts, selectedCandidates);
  const diagnostics: ValidationDiagnostic[] = [];
  const capabilityRuns: PythonValidationCapabilityRun[] = [];
  let overallPassed = true;
  for (const group of groups) {
    if (group.candidatePaths.some((path) => !candidateContexts.some((entry) => entry.target === path))) {
      return failureRun("PYTHON_PYTEST_CANDIDATE_MISSING", "Pytest candidate context resolution omitted at least one candidate test.", "tool_failure", rootContexts, group.candidatePaths);
    }
    const pytest = selectPytestTool(group.context);
    if (pytest === undefined) {
      const result = unsupportedPytestTool(group.context, group.candidatePaths);
      diagnostics.push(...(result.diagnostics ?? []));
      capabilityRuns.push(...(result.pythonCapabilityRuns ?? []));
      overallPassed = false;
      continue;
    }
    const run = await executeProjectPytest(context, nodeWorkspace, group, pytest);
    diagnostics.push(...run.diagnostics);
    capabilityRuns.push(run.capabilityRun);
    if (run.outcome !== "passed") overallPassed = false;
  }
  const outcome: "passed" | "findings" = overallPassed && capabilityRuns.some((run) => run.counts?.passedCount && run.cleanup?.ok)
    ? "passed"
    : "findings";
  return {
    diagnostics,
    outcome,
    pythonProjectContexts: rootContexts,
    pythonCapabilityRuns: capabilityRuns
  };
}

function selectCandidatePaths(rootContexts: readonly PythonProjectContext[], testedBy: readonly GraphFactEdge[]): readonly string[] {
  const state: CandidateSelectionState = {
    exactTargets: new Set(
      rootContexts
        .map((context) => context.target)
        .filter((target) => isPythonSourcePath(target) && !isRelevantPythonConfig(target))
    ),
    projectWideRoots: []
  };
  state.projectWideRoots = rootContexts.filter((context) => !state.exactTargets.has(context.target));
  const selected = new Set<string>();
  for (const edge of testedBy) {
    const fromPath = endpointFilePath(edge.from);
    const toPath = endpointFilePath(edge.to);
    const forward = selectedCandidatePath(edge.from, fromPath, edge.to, toPath, state);
    if (forward !== undefined) selected.add(forward);
    const reverse = selectedCandidatePath(edge.to, toPath, edge.from, fromPath, state);
    if (reverse !== undefined) selected.add(reverse);
  }
  return [...selected].sort();
}

function selectedCandidatePath(
  sourceEndpoint: string,
  sourcePath: string | undefined,
  candidateEndpoint: string,
  candidatePath: string | undefined,
  state: CandidateSelectionState
): string | undefined {
  if (sourcePath === undefined || candidatePath === undefined || !looksLikeTestCandidate(candidateEndpoint, candidatePath)) return undefined;
  if (state.exactTargets.has(sourcePath)) return candidatePath;
  return state.projectWideRoots.some((context) => withinProject(sourcePath, context.projectRoot) && withinProject(candidatePath, context.projectRoot))
    ? candidatePath
    : undefined;
}

function groupProjects(contexts: readonly PythonProjectContext[], candidatePaths: readonly string[]): readonly ProjectRunInput[] {
  const groups = new Map<string, { context: PythonProjectContext; candidatePaths: string[] }>();
  for (const context of contexts) {
    const group = groups.get(context.projectKey) ?? { context, candidatePaths: [] };
    if (candidatePaths.includes(context.target)) group.candidatePaths.push(context.target);
    groups.set(context.projectKey, group);
  }
  return [...groups.values()]
    .map((entry) => ({ context: entry.context, candidatePaths: [...new Set(entry.candidatePaths)].sort() }))
    .filter((entry) => entry.candidatePaths.length > 0)
    .sort((left, right) => left.context.projectRoot.localeCompare(right.context.projectRoot));
}

function selectPytestTool(context: PythonProjectContext): PythonProjectToolProvenance | undefined {
  return context.tools.find((tool) => tool.tool === "pytest" && tool.available);
}

function isUnresolvedPytestContext(context: PythonProjectContext): boolean {
  if (context.interpreter === undefined || context.outcome === "ambiguous" || context.outcome === "unsupported") return true;
  return context.reasons.some((reason) =>
    reason.code === "invalid_config" ||
    reason.code === "path_refused" ||
    reason.code === "symlink_refused" ||
    reason.code === "ambiguous_path" ||
    reason.tool === "python"
  );
}

function endpointFilePath(endpoint: string): string | undefined {
  const match = /^[^:]+:([^#]+)(?:#.*)?$/u.exec(endpoint);
  return match?.[1];
}

function hasRelevantPytestInput(context: ValidationCheckContext): boolean {
  return pythonProjectInputSet(context).length > 0;
}

function looksLikeTestCandidate(endpoint: string, path: string): boolean {
  if (!path.endsWith(".py")) return false;
  if (/^[^:]*test[^:]*:/iu.test(endpoint)) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /(^|\/)tests?\//u.test(path) || name.startsWith("test_") || name.endsWith("_test.py");
}

function withinProject(path: string, projectRoot: string): boolean {
  return projectRoot === "." || path === projectRoot || path.startsWith(`${projectRoot}/`);
}
