import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PythonCapabilityInvocation, PythonProjectToolProvenance } from "@the-open-engine/opcore-contracts";
import { runTool, type PythonToolRunResult } from "./process.js";
import { pytestHookSource } from "./pytest-hook-source.js";
import { pytestDiagnostic } from "./pytest-result.js";
import {
  analyzeExecutionEvents,
  collectErrorCount,
  countResults,
  executionFailureDiagnostics,
  readHookReport,
  uniqueCollectedNodeIds
} from "./pytest-protocol.js";
import type { CollectionRunResult, ExecutionRunResult, ProjectRunInput } from "./pytest-types.js";
import { pytestWorkspaceCaps, type MaterializedPytestWorkspace } from "./pytest-workspace.js";

export function writePytestRuntimeModule(runtimeRoot: string): string {
  const runtimeModule = join(runtimeRoot, "opcore_pytest_hook.py");
  writeFileSync(runtimeModule, pytestHookSource(), "utf8");
  return runtimeModule;
}

export async function runCollection(
  materialized: MaterializedPytestWorkspace,
  group: ProjectRunInput,
  pytest: PythonProjectToolProvenance
): Promise<CollectionRunResult> {
  const outputPath = join(materialized.runtimeRoot, "collection.jsonl");
  const selectionDigest = sha256(group.candidatePaths);
  const args = [
    ...pytest.argv.slice(1),
    "-p", "no:cacheprovider",
    "-p", "opcore_pytest_hook",
    "--collect-only",
    "-q",
    ...group.candidatePaths.map((path) => relativeProjectPath(path, group.context.projectRoot))
  ];
  const startedAt = Date.now();
  const result = runTool(pytest.executable, args, {
    cwd: materialized.projectCwd,
    env: pytestEnv(materialized.runtimeRoot, outputPath),
    timeoutMs: 30000,
    allowedExitCodes: [0, 1, 2, 3, 4, 5],
    maxOutputBytes: pytestWorkspaceCaps.maxProcessOutputBytes
  });
  const invocation = invocationSummary("collection", pytest, args, result, "direct_argv", selectionDigest, Date.now() - startedAt);
  const report = readHookReport(outputPath, { requireSessionFinish: result.termination === "exited" });
  return collectionOutcome(result, report, invocation, selectionDigest, group.candidatePaths.length);
}

export async function runExecution(
  materialized: MaterializedPytestWorkspace,
  group: ProjectRunInput,
  pytest: PythonProjectToolProvenance,
  nodeIds: readonly string[]
): Promise<ExecutionRunResult> {
  const outputPath = join(materialized.runtimeRoot, "execution.jsonl");
  const selectionDigest = sha256(nodeIds);
  const args = [...pytest.argv.slice(1), "-p", "no:cacheprovider", "-p", "opcore_pytest_hook", "-q"];
  const env = pytestEnv(materialized.runtimeRoot, outputPath);
  const selectionMode = maybeAttachSelectionManifest(args, env, materialized.runtimeRoot, nodeIds);
  if (selectionMode instanceof Error) {
    return {
      outcome: "tool_failure",
      message: selectionMode.message,
      diagnostics: [pytestDiagnostic("PYTHON_PYTEST_SELECTION_OVERFLOW", selectionMode.message, group.context.target)],
      counts: countResults(group.candidatePaths.length, nodeIds.length, 0, 0, 0, 0, 0, 0, 0),
      invocation: invocationSummary("execution", pytest, args, spawnErrorResult(pytest.executable, args, materialized.projectCwd, selectionMode.message), "manifest", selectionDigest, 0),
      selectionMode: "manifest",
      selectionDigest
    };
  }
  const startedAt = Date.now();
  const result = runTool(pytest.executable, args, {
    cwd: materialized.projectCwd,
    env,
    timeoutMs: 30000,
    allowedExitCodes: [0, 1, 2, 3, 4, 5],
    maxOutputBytes: pytestWorkspaceCaps.maxProcessOutputBytes
  });
  const invocation = invocationSummary("execution", pytest, args, result, selectionMode, selectionDigest, Date.now() - startedAt);
  const report = readHookReport(outputPath, { requireSessionFinish: result.termination === "exited" });
  return executionOutcome(result, report, invocation, selectionMode, selectionDigest, group.context.target, group.candidatePaths.length, nodeIds);
}

function collectionOutcome(
  result: PythonToolRunResult,
  report: ReturnType<typeof readHookReport>,
  invocation: PythonCapabilityInvocation,
  selectionDigest: string,
  candidateCount: number
): CollectionRunResult {
  const nodeIds = report.events.some((event) => event.type === "test_report") ? [] : uniqueCollectedNodeIds(report.events);
  const counts = countResults(candidateCount, nodeIds.length, 0, 0, 0, 0, 0, 0, collectErrorCount(report.events));
  if (result.termination === "exited" && report.exitStatus !== result.exitCode) return failedCollection("tool_failure", `Pytest collection hook exit status ${report.exitStatus} did not match process exit code ${result.exitCode}.`, counts, invocation, selectionDigest);
  if (report.events.some((event) => event.type === "test_report")) return failedCollection("tool_failure", "Pytest collection emitted test execution reports during --collect-only.", counts, invocation, selectionDigest);
  if (result.termination === "timeout") return failedCollection("timeout", result.failureMessage ?? "pytest collection timed out", counts, invocation, selectionDigest);
  if (result.termination !== "exited") return failedCollection("tool_failure", result.failureMessage ?? "pytest collection failed", counts, invocation, selectionDigest);
  if (result.exitCode === 4) return failedCollection("invalid_config", "Pytest collection reported invalid configuration.", counts, invocation, selectionDigest);
  if (result.exitCode !== 0 && result.exitCode !== 1) return failedCollection("tool_failure", `Pytest collection exited with code ${result.exitCode}.`, counts, invocation, selectionDigest);
  if (result.exitCode === 1 && collectErrorCount(report.events) === 0) return failedCollection("tool_failure", "Pytest collection exited with code 1 but emitted no collection-error events.", counts, invocation, selectionDigest, nodeIds);
  if (result.exitCode === 1) return failedCollection("findings", "Pytest collection reported collection errors.", counts, invocation, selectionDigest, nodeIds);
  if (collectErrorCount(report.events) > 0) return failedCollection("tool_failure", "Pytest collection emitted collection-error events despite a zero exit code.", counts, invocation, selectionDigest);
  if (nodeIds.length === 0) return failedCollection("findings", "Pytest collection produced zero node ids.", counts, invocation, selectionDigest);
  if (nodeIds.length > pytestWorkspaceCaps.maxCollectedNodeIds) return failedCollection("tool_failure", `Pytest collection exceeded ${pytestWorkspaceCaps.maxCollectedNodeIds} node ids.`, counts, invocation, selectionDigest);
  if (Buffer.byteLength(nodeIds.join("\n"), "utf8") > pytestWorkspaceCaps.maxNodeIdBytes) return failedCollection("tool_failure", `Pytest collection node ids exceeded ${pytestWorkspaceCaps.maxNodeIdBytes} bytes.`, counts, invocation, selectionDigest);
  return { outcome: "passed", message: "Pytest collection succeeded.", nodeIds, counts, invocation, selectionMode: "direct_argv", selectionDigest };
}

function executionOutcome(
  result: PythonToolRunResult,
  report: ReturnType<typeof readHookReport>,
  invocation: PythonCapabilityInvocation,
  selectionMode: "direct_argv" | "manifest",
  selectionDigest: string,
  path: string,
  candidateCount: number,
  nodeIds: readonly string[]
): ExecutionRunResult {
  if (result.termination === "exited" && report.exitStatus !== result.exitCode) return failedExecution("tool_failure", `Pytest execution hook exit status ${report.exitStatus} did not match process exit code ${result.exitCode}.`, [pytestDiagnostic("PYTHON_PYTEST_PROTOCOL_MISMATCH", `Pytest execution hook exit status ${report.exitStatus} did not match process exit code ${result.exitCode}.`, path)], countResults(candidateCount, nodeIds.length, 0, 0, 0, 0, 0, 0, 0), invocation, selectionMode, selectionDigest);
  const analysis = analyzeExecutionEvents(candidateCount, nodeIds, report.events, path);
  if (result.termination === "timeout") return failedExecution("timeout", result.failureMessage ?? "pytest execution timed out", [pytestDiagnostic("PYTHON_PYTEST_TIMEOUT", result.failureMessage ?? "pytest execution timed out", path)], analysis.counts, invocation, selectionMode, selectionDigest);
  if (result.termination !== "exited") return failedExecution("tool_failure", result.failureMessage ?? "pytest execution failed", [pytestDiagnostic("PYTHON_PYTEST_TOOL_FAILED", result.failureMessage ?? "pytest execution failed", path)], analysis.counts, invocation, selectionMode, selectionDigest);
  if (analysis.diagnostics.length > 0) return failedExecution("tool_failure", analysis.diagnostics[0]?.message ?? "Pytest execution hook protocol mismatch.", analysis.diagnostics, analysis.counts, invocation, selectionMode, selectionDigest);
  if (analysis.counts.executedCount === 0) return failedExecution("findings", "Pytest execution ran zero tests.", [pytestDiagnostic("PYTHON_PYTEST_NO_EXECUTION", "Pytest execution ran zero tests.", path)], analysis.counts, invocation, selectionMode, selectionDigest);
  if (analysis.counts.passedCount === 0) return failedExecution("findings", "Pytest execution produced no passing tests.", [pytestDiagnostic("PYTHON_PYTEST_NO_PASS", "Pytest execution produced no passing tests.", path)], analysis.counts, invocation, selectionMode, selectionDigest);
  const errors = executionFailureDiagnostics(report.events, path);
  if (result.exitCode !== 0 || errors.length > 0 || analysis.counts.failedCount > 0 || analysis.counts.xpassedCount > 0 || analysis.counts.errorCount > 0) {
    return failedExecution("findings", "Pytest execution reported failing outcomes.", errors.length > 0 ? errors : [pytestDiagnostic("PYTHON_PYTEST_FAILURES", "Pytest execution reported failing outcomes.", path)], analysis.counts, invocation, selectionMode, selectionDigest);
  }
  return { outcome: "passed", message: "Pytest execution reported passing tests.", diagnostics: [], counts: analysis.counts, invocation, selectionMode, selectionDigest };
}

function failedCollection(
  outcome: CollectionRunResult["outcome"],
  message: string,
  counts: CollectionRunResult["counts"],
  invocation: CollectionRunResult["invocation"],
  selectionDigest: string,
  nodeIds: readonly string[] = []
): CollectionRunResult {
  return { outcome, message, nodeIds, counts, invocation, selectionMode: "direct_argv", selectionDigest };
}

function failedExecution(
  outcome: ExecutionRunResult["outcome"],
  message: string,
  diagnostics: ExecutionRunResult["diagnostics"],
  counts: ExecutionRunResult["counts"],
  invocation: ExecutionRunResult["invocation"],
  selectionMode: ExecutionRunResult["selectionMode"],
  selectionDigest: string
): ExecutionRunResult {
  return { outcome, message, diagnostics, counts, invocation, selectionMode, selectionDigest };
}

function maybeAttachSelectionManifest(
  args: string[],
  env: Record<string, string>,
  runtimeRoot: string,
  nodeIds: readonly string[]
): "direct_argv" | "manifest" | Error {
  if (Buffer.byteLength(nodeIds.join("\0"), "utf8") <= pytestWorkspaceCaps.maxArgvBytes) {
    args.push(...nodeIds);
    return "direct_argv";
  }
  const manifest = `${nodeIds.join("\n")}\n`;
  if (Buffer.byteLength(manifest, "utf8") > pytestWorkspaceCaps.maxManifestBytes) {
    return new Error(`Pytest selection manifest exceeded ${pytestWorkspaceCaps.maxManifestBytes} bytes.`);
  }
  const manifestPath = join(runtimeRoot, "selection.txt");
  writeFileSync(manifestPath, manifest, "utf8");
  env.OPCORE_PYTEST_SELECTION_MANIFEST = manifestPath;
  return "manifest";
}

function pytestEnv(runtimeRoot: string, outputPath: string): Record<string, string> {
  return { ...process.env, PYTHONPATH: runtimeRoot, PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", OPCORE_PYTEST_HOOK_OUTPUT: outputPath };
}

function invocationSummary(
  stage: "collection" | "execution",
  pytest: PythonProjectToolProvenance,
  args: readonly string[],
  result: PythonToolRunResult,
  selectionMode: "direct_argv" | "manifest",
  selectionDigest: string,
  durationMs: number
): PythonCapabilityInvocation {
  return {
    stage,
    command: pytest.tool,
    argsDigest: sha256([pytest.executable, ...args]),
    argCount: args.length,
    selectionMode,
    selectionDigest,
    durationMs,
    termination: result.termination,
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    ...(result.signal === null ? {} : { signal: result.signal }),
    outputBytes: Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8"),
    stdoutDigest: sha256(result.stdout),
    stderrDigest: sha256(result.stderr)
  };
}

function relativeProjectPath(path: string, projectRoot: string): string {
  return projectRoot === "." ? path : path.slice(`${projectRoot}/`.length);
}

function sha256(value: unknown): string {
  const input = typeof value === "string" ? value : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function spawnErrorResult(command: string, args: readonly string[], cwd: string, failureMessage: string): PythonToolRunResult {
  return {
    ok: false,
    termination: "spawn_error",
    command,
    args: [...args],
    cwd,
    allowedExitCodes: [0],
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    failureMessage
  };
}
