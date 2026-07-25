import type {
  GraphFactEdge,
  PythonProjectContext,
  PythonProjectToolProvenance,
  PythonPytestValidationCapabilityRun,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_PYTEST_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { createRelevantTestsGraphRequirements } from "./graph-requirements.js";
import { executeProjectPytest } from "./pytest-project-runner.js";
import { candidateFailure, disabledPytestRun, failureRun, notApplicableRun, unsupportedPytestTool, unsupportedRun } from "./pytest-result.js";
import type { ProjectRunInput } from "./pytest-types.js";
import { pytestWorkspaceCaps } from "./pytest-workspace.js";
import { type PythonProjectWorkspace } from "./project-workspace.js";
import { pythonInputSet, type PythonProjectContextResolver, type PythonSourceRootResolver } from "./source-files.js";
import type { PythonValidationToolchainOptions } from "./toolchain.js";

interface CreatePytestCheckOptions extends Omit<PythonValidationToolchainOptions, "contexts"> {}

export { disabledPytestRun };

export function createPytestCheck(
  options: CreatePytestCheckOptions = {},
  resolveContexts?: PythonProjectContextResolver,
  resolveRoots?: PythonSourceRootResolver
): ValidationCheckDefinition {
  const resolveRootPaths = resolveRoots ?? (async (context) => pythonInputSet(context));
  return {
    id: PYTHON_PYTEST_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    defaultScopes: [],
    requiresGraph: true,
    graphRequirements: createRelevantTestsGraphRequirements(resolveRootPaths),
    inactiveResult: (_context, state) =>
      state === "disabled"
        ? disabledPytestRun()
        : {
            status: "skipped",
            diagnostics: [],
            pythonCapabilityRuns: [{
              capability: "pytest",
              checkId: PYTHON_PYTEST_CHECK_ID,
              activation: "not_applicable",
              outcome: "not_applicable",
              message: "python.pytest was not requested; pytest execution is opt-in.",
              selectionMode: "none"
            }]
          },
    run: async (context) => runPytestCheck(context, options.nodeWorkspace, resolveContexts)
  };
}

async function runPytestCheck(
  context: ValidationCheckContext,
  nodeWorkspace: PythonProjectWorkspace | undefined,
  resolveContexts: PythonProjectContextResolver | undefined
) {
  const targets = pythonInputSet(context);
  if (targets.length === 0) return notApplicableRun("No Python source targets selected.");
  if (resolveContexts === undefined) {
    return failureRun("PYTHON_PYTEST_CONTEXT_MISSING", "Canonical Python project context resolver is required.", "tool_failure");
  }
  const rootContexts = await resolveContexts(context, targets);
  const unresolved = rootContexts.find(isUnresolvedPytestContext);
  if (unresolved !== undefined) {
    return unsupportedRun(unresolved, `Python pytest execution requires a resolved project context for ${unresolved.target}.`);
  }
  const selectedCandidates = selectCandidatePaths(targets, await context.graph.testedBy());
  if (selectedCandidates.length === 0) {
    return candidateFailure(rootContexts, [], "No TESTED_BY graph candidate tests matched the selected Python targets.");
  }
  if (selectedCandidates.length > pytestWorkspaceCaps.maxCandidateFiles) {
    return failureRun("PYTHON_PYTEST_CANDIDATE_OVERFLOW", `Pytest candidate selection exceeded ${pytestWorkspaceCaps.maxCandidateFiles} files.`, "tool_failure", rootContexts, selectedCandidates);
  }
  const candidateContexts = await resolveContexts(context, selectedCandidates);
  const groups = groupProjects(candidateContexts, selectedCandidates);
  const diagnostics: ValidationDiagnostic[] = [];
  const capabilityRuns: PythonPytestValidationCapabilityRun[] = [];
  let overallPassed = true;
  for (const group of groups) {
    if (group.candidatePaths.some((path) => !candidateContexts.some((entry) => entry.target === path))) {
      return failureRun("PYTHON_PYTEST_CANDIDATE_MISSING", "Pytest candidate context resolution omitted at least one candidate test.", "tool_failure", rootContexts, group.candidatePaths);
    }
    const pytest = selectPytestTool(group.context);
    if (pytest === undefined) {
      const result = unsupportedPytestTool(group.context, group.candidatePaths);
      diagnostics.push(...(result.diagnostics ?? []));
      for (const capabilityRun of result.pythonCapabilityRuns ?? []) {
        if (capabilityRun.capability === "pytest") capabilityRuns.push(capabilityRun);
      }
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

function selectCandidatePaths(rootPaths: readonly string[], testedBy: readonly GraphFactEdge[]): readonly string[] {
  const selected = new Set<string>();
  for (const edge of testedBy) {
    const fromPath = endpointFilePath(edge.from);
    const toPath = endpointFilePath(edge.to);
    if (fromPath !== undefined && rootPaths.includes(fromPath) && toPath?.endsWith(".py")) selected.add(toPath);
    if (toPath !== undefined && rootPaths.includes(toPath) && fromPath?.endsWith(".py")) selected.add(fromPath);
  }
  return [...selected].sort();
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
