import type { PythonCapabilityCounts, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { readFileSync } from "node:fs";
import { pytestWorkspaceCaps } from "./pytest-workspace.js";
import { pytestDiagnostic } from "./pytest-result.js";
import type { ExecutionEventAnalysis, HookEvent, HookReport } from "./pytest-types.js";

export function readHookReport(path: string, options: { requireSessionFinish?: boolean } = {}): HookReport {
  const requireSessionFinish = options.requireSessionFinish ?? true;
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > pytestWorkspaceCaps.maxHookReportBytes) {
      throw new Error(`Pytest hook report exceeded ${pytestWorkspaceCaps.maxHookReportBytes} bytes.`);
    }
    const events: HookEvent[] = [];
    let exitStatus: number | undefined;
    for (const [index, line] of text.split(/\r?\n/u).filter(Boolean).entries()) {
      const payload = JSON.parse(line) as unknown;
      if (!isRecord(payload)) throw new Error(`Pytest hook event ${index + 1} is not an object.`);
      if (payload.type === "session_finish") {
        if (exitStatus !== undefined) throw new Error("Duplicate pytest session_finish event.");
        if (!Number.isInteger(payload.exitstatus)) throw new Error("Pytest session_finish event requires integer exitstatus.");
        exitStatus = payload.exitstatus as number;
        continue;
      }
      events.push(validateHookEvent(payload, index + 1));
    }
    if (exitStatus === undefined) {
      if (!requireSessionFinish) return { events, exitStatus: -1 };
      throw new Error("Pytest hook report omitted session_finish.");
    }
    return { events, exitStatus };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      if (!requireSessionFinish) return { events: [], exitStatus: -1 };
      throw new Error("Pytest hook report was not created.");
    }
    throw error;
  }
}

export function uniqueCollectedNodeIds(events: readonly HookEvent[]): readonly string[] {
  const nodeIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "collected" || event.nodeid === undefined) continue;
    if (nodeIds.has(event.nodeid)) throw new Error(`Duplicate pytest collection node id: ${event.nodeid}`);
    nodeIds.add(event.nodeid);
  }
  return [...nodeIds];
}

export function collectErrorCount(events: readonly HookEvent[]): number {
  return events.filter((event) => event.type === "collect_error").length;
}

export function analyzeExecutionEvents(
  candidateCount: number,
  expectedNodeIds: readonly string[],
  events: readonly HookEvent[],
  path: string
): ExecutionEventAnalysis {
  const expected = new Set(expectedNodeIds);
  const collected = new Set<string>();
  const terminal = new Map<string, NodeOutcomeState>();
  const diagnostics: ValidationDiagnostic[] = [];
  for (const event of events) processExecutionEvent(event, expected, collected, terminal, diagnostics, path);
  if (collected.size !== expected.size || expectedNodeIds.some((nodeId) => !collected.has(nodeId))) {
    diagnostics.push(pytestDiagnostic("PYTHON_PYTEST_PROTOCOL_MISMATCH", "Pytest execution collected node ids did not match the collection selection.", path));
  }
  const counts = summarizeExecutionCounts(candidateCount, expectedNodeIds.length, terminal, events);
  if (counts.executedCount !== expectedNodeIds.length && collectErrorCount(events) === 0) {
    diagnostics.push(pytestDiagnostic("PYTHON_PYTEST_PROTOCOL_MISMATCH", "Pytest execution terminal node ids did not match the collected selection.", path));
  }
  return { counts, diagnostics };
}

export function executionFailureDiagnostics(events: readonly HookEvent[], path: string) {
  return events
    .filter((event) => event.type === "collect_error" && event.message !== undefined)
    .map((event) => pytestDiagnostic("PYTHON_PYTEST_COLLECTION_ERROR", event.message!, path));
}

export function countResults(
  candidateCount: number,
  collectedCount: number,
  executedCount: number,
  passedCount: number,
  failedCount: number,
  skippedCount: number,
  xfailedCount: number,
  xpassedCount: number,
  errorCount: number
): PythonCapabilityCounts {
  return { candidateCount, collectedCount, executedCount, passedCount, failedCount, skippedCount, xfailedCount, xpassedCount, errorCount };
}

interface NodeOutcomeState {
  callSeen: boolean;
  passed: boolean;
  failed: boolean;
  skipped: boolean;
  xfailed: boolean;
  xpassed: boolean;
  error: boolean;
  setupSkipped: boolean;
}

function processExecutionEvent(
  event: HookEvent,
  expected: ReadonlySet<string>,
  collected: Set<string>,
  terminal: Map<string, NodeOutcomeState>,
  diagnostics: ReturnType<typeof executionFailureDiagnostics>,
  path: string
): void {
  if (event.type === "collected") return processCollectedEvent(event, expected, collected, diagnostics, path);
  if (event.type !== "test_report" || event.nodeid === undefined || event.when === undefined || event.outcome === undefined) return;
  if (!expected.has(event.nodeid)) {
    diagnostics.push(pytestDiagnostic("PYTHON_PYTEST_PROTOCOL_MISMATCH", `Pytest execution reported unexpected node id: ${event.nodeid}`, path));
    return;
  }
  const current = terminal.get(event.nodeid) ?? emptyNodeOutcomeState();
  if (event.when === "call") {
    processCallOutcome(
      event as HookEvent & { nodeid: string; when: "call"; outcome: "passed" | "failed" | "skipped" },
      current,
      diagnostics,
      path,
      terminal
    );
    return;
  }
  if (event.outcome === "failed") current.error = true;
  if (event.when === "setup" && event.outcome === "skipped") current.setupSkipped = true;
  terminal.set(event.nodeid, current);
}

function processCollectedEvent(
  event: HookEvent,
  expected: ReadonlySet<string>,
  collected: Set<string>,
  diagnostics: ReturnType<typeof executionFailureDiagnostics>,
  path: string
): void {
  if (event.nodeid === undefined || !expected.has(event.nodeid)) {
    diagnostics.push(pytestDiagnostic("PYTHON_PYTEST_PROTOCOL_MISMATCH", `Pytest execution collected unexpected node id: ${event.nodeid ?? "<missing>"}`, path));
    return;
  }
  if (collected.has(event.nodeid)) {
    diagnostics.push(pytestDiagnostic("PYTHON_PYTEST_PROTOCOL_MISMATCH", `Pytest execution collected duplicate node id: ${event.nodeid}`, path));
    return;
  }
  collected.add(event.nodeid);
}

function processCallOutcome(
  event: HookEvent & { nodeid: string; when: "call"; outcome: "passed" | "failed" | "skipped" },
  current: NodeOutcomeState,
  diagnostics: ReturnType<typeof executionFailureDiagnostics>,
  path: string,
  terminal: Map<string, NodeOutcomeState>
): void {
  if (current.callSeen) {
    diagnostics.push(pytestDiagnostic("PYTHON_PYTEST_PROTOCOL_MISMATCH", `Pytest execution reported duplicate call outcome for ${event.nodeid}.`, path));
    return;
  }
  current.callSeen = true;
  if (event.outcome === "passed" && event.wasxfail === undefined) current.passed = true;
  else if (event.outcome === "failed" && event.wasxfail !== undefined) current.xpassed = true;
  else if (event.outcome === "failed") current.failed = true;
  else if (event.outcome === "skipped" && event.wasxfail !== undefined) current.xfailed = true;
  else if (event.outcome === "skipped") current.skipped = true;
  terminal.set(event.nodeid, current);
}

function summarizeExecutionCounts(
  candidateCount: number,
  collectedCount: number,
  terminal: ReadonlyMap<string, NodeOutcomeState>,
  events: readonly HookEvent[]
): PythonCapabilityCounts {
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let xfailedCount = 0;
  let xpassedCount = 0;
  let errorCount = collectErrorCount(events);
  for (const counts of terminal.values()) {
    if (counts.passed) passedCount += 1;
    if (counts.failed) failedCount += 1;
    if (counts.skipped || counts.setupSkipped) skippedCount += 1;
    if (counts.xfailed) xfailedCount += 1;
    if (counts.xpassed) xpassedCount += 1;
    if (counts.error) errorCount += 1;
  }
  return countResults(candidateCount, collectedCount, terminal.size, passedCount, failedCount, skippedCount, xfailedCount, xpassedCount, errorCount);
}

function emptyNodeOutcomeState(): NodeOutcomeState {
  return { callSeen: false, passed: false, failed: false, skipped: false, xfailed: false, xpassed: false, error: false, setupSkipped: false };
}

function validateHookEvent(payload: Record<string, unknown>, lineNumber: number): HookEvent {
  if (payload.type === "collected") {
    if (typeof payload.nodeid !== "string" || payload.nodeid.length === 0) throw new Error(`Pytest collected event ${lineNumber} requires non-empty nodeid.`);
    return { type: "collected", nodeid: payload.nodeid };
  }
  if (payload.type === "collect_error") {
    if (typeof payload.message !== "string" || payload.message.length === 0) throw new Error(`Pytest collect_error event ${lineNumber} requires message.`);
    if (payload.nodeid !== undefined && typeof payload.nodeid !== "string") throw new Error(`Pytest collect_error event ${lineNumber} has invalid nodeid.`);
    return { type: "collect_error", message: payload.message, ...(typeof payload.nodeid === "string" ? { nodeid: payload.nodeid } : {}) };
  }
  if (payload.type === "test_report") {
    if (typeof payload.nodeid !== "string" || payload.nodeid.length === 0) throw new Error(`Pytest test_report event ${lineNumber} requires non-empty nodeid.`);
    if (payload.when !== "setup" && payload.when !== "call" && payload.when !== "teardown") throw new Error(`Pytest test_report event ${lineNumber} has invalid when value.`);
    if (payload.outcome !== "passed" && payload.outcome !== "failed" && payload.outcome !== "skipped") throw new Error(`Pytest test_report event ${lineNumber} has invalid outcome.`);
    if (payload.wasxfail !== undefined && typeof payload.wasxfail !== "string") throw new Error(`Pytest test_report event ${lineNumber} has invalid wasxfail value.`);
    return { type: "test_report", nodeid: payload.nodeid, when: payload.when, outcome: payload.outcome, ...(typeof payload.wasxfail === "string" ? { wasxfail: payload.wasxfail } : {}) };
  }
  throw new Error(`Unknown pytest hook event type at line ${lineNumber}: ${String(payload.type)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
