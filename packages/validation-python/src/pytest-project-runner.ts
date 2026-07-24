import { existsSync } from "node:fs";
import type { PythonProjectToolProvenance, PythonValidationCapabilityRun } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import { removeMaterializedWorkspace } from "./materialized-workspace.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";
import { collectPytestProjectPaths, materializePytestWorkspace } from "./pytest-workspace.js";
import { runCollection, runExecution, writePytestRuntimeModule } from "./pytest-process.js";
import { cleanupFailureMessage, createCleanupState, finalizeCapabilityRun, pytestDiagnostic, recordCleanup } from "./pytest-result.js";
import type { ProjectRunInput, ProjectRunResult } from "./pytest-types.js";
import { PYTHON_PYTEST_CHECK_ID } from "./check-ids.js";

export async function executeProjectPytest(
  validation: ValidationCheckContext,
  nodeWorkspace: PythonProjectWorkspace | undefined,
  group: ProjectRunInput,
  pytest: PythonProjectToolProvenance
): Promise<ProjectRunResult> {
  const projectPaths = await collectPytestProjectPaths(validation, group.context, group.candidatePaths, nodeWorkspace);
  const capabilityBase = {
    capability: "pytest" as const,
    checkId: PYTHON_PYTEST_CHECK_ID,
    activation: "enabled" as const,
    projectKey: group.context.projectKey,
    projectRoot: group.context.projectRoot,
    configFile: pytest.configFile,
    targetCount: group.candidatePaths.length,
    candidatePaths: group.candidatePaths
  };
  const cleanup = createCleanupState();
  let afterStateFingerprint: string | undefined;
  let collectedNodeIds: readonly string[] | undefined;
  let collectionSelectionMode: "direct_argv" | "manifest" | "none" = "none";
  let collectionSelectionDigest: string | undefined;
  let collectionCounts;
  let collectionInvocation;
  try {
    const collectionWorkspace = await materializePytestWorkspace({ context: validation, project: group.context, paths: projectPaths, nodeWorkspace });
    afterStateFingerprint = collectionWorkspace.afterStateFingerprint;
    let collectionFailure: ProjectRunResult | undefined;
    try {
      writePytestRuntimeModule(collectionWorkspace.runtimeRoot);
      const collection = await runCollection(collectionWorkspace, group, pytest);
      collectionInvocation = collection.invocation;
      collectionCounts = collection.counts;
      collectionSelectionMode = collection.selectionMode;
      collectionSelectionDigest = collection.selectionDigest;
      collectedNodeIds = collection.nodeIds;
      if (collection.outcome !== "passed") {
        collectionFailure = {
          outcome: collection.outcome,
          diagnostics: [pytestDiagnostic("PYTHON_PYTEST_COLLECTION_FAILED", collection.message, group.context.target)],
          capabilityRun: { ...capabilityBase, afterStateFingerprint, outcome: collection.outcome, message: collection.message, selectionMode: collection.selectionMode, selectionDigest: collection.selectionDigest, counts: collection.counts, collection: collection.invocation }
        };
      }
    } finally {
      cleanupWorkspace(cleanup, collectionWorkspace);
    }
    if (collectionFailure !== undefined) return finalizeCapabilityRun(cleanup, collectionFailure);
    if (!cleanup.ok) return cleanupFailureResult(cleanup, capabilityBase, afterStateFingerprint, collectedNodeIds, collectionSelectionMode, collectionSelectionDigest, collectionCounts, collectionInvocation, group.context.target);
    const executionWorkspace = await materializePytestWorkspace({ context: validation, project: group.context, paths: projectPaths, nodeWorkspace });
    if (executionWorkspace.afterStateFingerprint !== afterStateFingerprint) {
      recordCleanup(cleanup, executionWorkspace.cleanup);
      return finalizeCapabilityRun(cleanup, {
        outcome: "tool_failure",
        diagnostics: [pytestDiagnostic("PYTHON_PYTEST_FINGERPRINT_MISMATCH", "Pytest execution after-state fingerprint did not match collection.", group.context.target)],
        capabilityRun: { ...capabilityBase, afterStateFingerprint, outcome: "tool_failure", message: "Pytest execution after-state fingerprint did not match collection.", collectedNodeIds, selectionMode: collectionSelectionMode, selectionDigest: collectionSelectionDigest, counts: collectionCounts, collection: collectionInvocation }
      });
    }
    let executionResult: ProjectRunResult | undefined;
    try {
      writePytestRuntimeModule(executionWorkspace.runtimeRoot);
      const execution = await runExecution(executionWorkspace, group, pytest, collectedNodeIds ?? []);
      executionResult = {
        outcome: execution.outcome,
        diagnostics: execution.diagnostics,
        capabilityRun: { ...capabilityBase, afterStateFingerprint, outcome: execution.outcome, message: execution.message, collectedNodeIds, selectionMode: execution.selectionMode, selectionDigest: execution.selectionDigest, counts: execution.counts, collection: collectionInvocation, execution: execution.invocation }
      };
    } finally {
      cleanupWorkspace(cleanup, executionWorkspace);
    }
    return finalizeCapabilityRun(cleanup, executionResult ?? {
      outcome: "tool_failure",
      diagnostics: [pytestDiagnostic("PYTHON_PYTEST_TOOL_FAILED", "Pytest execution produced no result.", group.context.target)],
      capabilityRun: { ...capabilityBase, afterStateFingerprint, outcome: "tool_failure", message: "Pytest execution produced no result.", collectedNodeIds, selectionMode: collectionSelectionMode, selectionDigest: collectionSelectionDigest, counts: collectionCounts, collection: collectionInvocation }
    });
  } catch (error) {
    return finalizeCapabilityRun(cleanup, {
      outcome: "tool_failure",
      diagnostics: [pytestDiagnostic("PYTHON_PYTEST_TOOL_FAILED", errorMessage(error), group.context.target)],
      capabilityRun: { ...capabilityBase, afterStateFingerprint, outcome: "tool_failure", message: errorMessage(error), collectedNodeIds, selectionMode: collectionSelectionMode, selectionDigest: collectionSelectionDigest, counts: collectionCounts, collection: collectionInvocation }
    });
  }
}

function cleanupFailureResult(
  cleanup: Parameters<typeof finalizeCapabilityRun>[0],
  capabilityBase: {
    capability: "pytest";
    checkId: string;
    activation: "enabled";
    projectKey: string;
    projectRoot: string;
    configFile?: string;
    targetCount: number;
    candidatePaths: readonly string[];
  },
  afterStateFingerprint: string | undefined,
  collectedNodeIds: readonly string[] | undefined,
  selectionMode: "direct_argv" | "manifest" | "none",
  selectionDigest: string | undefined,
  counts: PythonValidationCapabilityRun["counts"],
  collection: PythonValidationCapabilityRun["collection"],
  path: string
): ProjectRunResult {
  const message = cleanupFailureMessage(cleanup);
  return finalizeCapabilityRun(cleanup, {
    outcome: "tool_failure",
    diagnostics: [pytestDiagnostic("PYTHON_PYTEST_CLEANUP_FAILED", message, path)],
    capabilityRun: { ...capabilityBase, afterStateFingerprint, outcome: "tool_failure", message, collectedNodeIds, selectionMode, selectionDigest, counts, collection }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupWorkspace(
  cleanup: Parameters<typeof finalizeCapabilityRun>[0],
  workspace: { root: string; cleanup(): void }
): void {
  recordCleanup(cleanup, workspace.cleanup);
  if (!existsSync(workspace.root)) return;
  recordCleanup(cleanup, () => removeMaterializedWorkspace(workspace.root, "Pytest temporary workspace"));
}
