import type {
  GraphFactEdge,
  GraphFactNode,
  GraphSnapshotMetadata,
  JsonValue,
  CommandLatencyRecord,
  LatencyBudget,
  OpcoreMeasureComparison,
  OpcoreMeasureDelta,
  OpcoreMeasureLatencyFinding,
  OpcoreMeasureLatencyReport,
  OpcoreMeasureSignalCount,
  OpcoreMetricDegradation,
  OpcoreMetricEvidence,
  OpcoreMetricHistoryEntry,
  OpcoreMetricReport,
  OpcoreMetricSignal,
  OpcoreRepoStatePayload,
  ValidationDiagnostic,
  ValidationResult,
  ValidationSkippedCheck
} from "@the-open-engine/opcore-contracts";
import {
  commandLatencyTelemetryArtifactPolicy,
  validateCommandLatencyRecord,
  validateLatencyBudget,
  validateOpcoreMeasureDelta,
  validateOpcoreMetricHistoryEntry,
  validateOpcoreMetricReport
} from "@the-open-engine/opcore-contracts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OpcoreMetricGraphFacts {
  nodes?: readonly GraphFactNode[];
  edges?: readonly GraphFactEdge[];
  metadata?: GraphSnapshotMetadata;
}

export interface CreateOpcoreMetricReportInput {
  repoState: OpcoreRepoStatePayload;
  validationResult?: ValidationResult;
  graphFacts?: OpcoreMetricGraphFacts;
  generatedAt?: string;
}

export interface WriteOpcoreMetricArtifactsResult {
  reportPath: string;
  historyPath: string;
  historyEntry: OpcoreMetricHistoryEntry;
}

export interface WriteCommandLatencyTelemetryResult {
  telemetryPath: string;
  record: CommandLatencyRecord;
  retainedRecords: number;
  bytes: number;
}

const tsSyntaxCheckId = "typescript.syntax";
const tsTypesCheckId = "typescript.types";
const tsRelevantTestsCheckId = "typescript.relevant-tests";
const tsDeadCodeCheckId = "typescript.dead-code";
const rustSourceHygieneCheckId = "rust.source-hygiene";
const rustFmtCheckId = "rust.fmt";
const rustCargoCheckId = "rust.cargo-check";
const rustClippyCheckId = "rust.clippy";
const rustImportGraphCheckId = "rust.import-graph";
const rustFileLengthCheckId = "rust.file-length";

const graphStructureThresholds = {
  maxContainedSymbolsPerFile: 50,
  maxImportFanIn: 10
} as const;

const latencyBudgetArtifactPolicy = {
  maxBudgets: 200,
  maxBytes: 64 * 1024
} as const;

interface LatencyObservation {
  canonicalCommand: readonly string[];
  repoShapeBucket: string;
  processState: CommandLatencyRecord["timing"]["processState"];
  phase: string;
  recordedAt: string;
  durationMs: number;
  budgetMs?: number;
}

export function createOpcoreMetricReport(input: CreateOpcoreMetricReportInput): OpcoreMetricReport {
  const validationResult = input.validationResult;
  const signals: OpcoreMetricSignal[] = [];
  const degradations: OpcoreMetricDegradation[] = [];
  const diagnostics = validationResult?.diagnostics ?? [];

  addDiagnosticSignal(signals, {
    id: "typescript.syntax_errors",
    title: "TS/JS syntax errors",
    category: "typescript",
    severity: "error",
    checkId: tsSyntaxCheckId,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic.category === "syntax" && isTsJsPath(diagnostic.path))
  });
  addDiagnosticSignal(signals, {
    id: "typescript.type_errors",
    title: "TS/JS type errors",
    category: "typescript",
    severity: "error",
    checkId: tsTypesCheckId,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic.category === "types" && isTsJsPath(diagnostic.path))
  });
  addDiagnosticSignal(signals, {
    id: "typescript.untested_surface",
    title: "TS/JS files without TESTED_BY graph evidence",
    category: "typescript",
    severity: "warning",
    checkId: tsRelevantTestsCheckId,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic.code === "TS_RELEVANT_TESTS_ABSENT" && hasPath(diagnostic))
  });
  addDiagnosticSignal(signals, {
    id: "typescript.dead_exports",
    title: "TS/JS exported symbols without incoming CALLS evidence",
    category: "typescript",
    severity: "warning",
    checkId: tsDeadCodeCheckId,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic.code === "TS_DEAD_CODE_UNUSED_EXPORT" && hasPath(diagnostic))
  });
  addDiagnosticSignal(signals, {
    id: "rust.source_hygiene",
    title: "Rust source hygiene suppressions",
    category: "rust",
    severity: "error",
    checkId: rustSourceHygieneCheckId,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic.code?.startsWith("RUST_SOURCE_") && hasPath(diagnostic))
  });
  addDiagnosticSignal(signals, {
    id: "rust.oversized_files",
    title: "Rust oversized files",
    category: "rust",
    severity: "warning",
    checkId: rustFileLengthCheckId,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic.code === "RUST_FILE_LINES" && hasPath(diagnostic))
  });
  addDiagnosticSignal(signals, {
    id: "rust.module_graph",
    title: "Rust module graph gaps",
    category: "rust",
    severity: "error",
    checkId: rustImportGraphCheckId,
    diagnostics: diagnostics.filter((diagnostic) => isRustModuleGraphDiagnostic(diagnostic) && hasPath(diagnostic))
  });
  addDiagnosticSignal(signals, {
    id: "rust.toolchain_drift",
    title: "Rust fmt/cargo/clippy drift",
    category: "rust",
    severity: "error",
    checkId: rustCargoCheckId,
    diagnostics: diagnostics.filter((diagnostic) => isRustToolchainDiagnostic(diagnostic) && hasPath(diagnostic))
  });

  addUnsupportedLanguageSignal(signals, input.repoState);
  addGraphStructureSignals(signals, degradations, input.repoState, input.graphFacts);
  addValidationDegradations(degradations, input.repoState, validationResult);

  const report: OpcoreMetricReport = {
    schemaVersion: 1,
    kind: "opcore_metric_report",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    repo: {
      root: input.repoState.repo.root,
      requestedPath: input.repoState.repo.requestedPath,
      git: input.repoState.repo.git
    },
    coverage: input.repoState.coverage,
    graph: {
      state: input.repoState.graph.state,
      mode: input.repoState.graph.mode,
      provider: input.repoState.graph.provider
    },
    validation: {
      ...(validationResult?.status ? { status: validationResult.status } : {}),
      diagnosticCount: validationResult?.diagnostics.length ?? 0,
      checkCount: validationResult?.manifest?.checks.length ?? input.repoState.validation.checkCount
    },
    signals: sortSignals(signals),
    degradations: sortDegradations(degradations),
    warnings: [...input.repoState.warnings],
    nextActions: metricNextActions(input.repoState, signals, degradations)
  };

  return validateOpcoreMetricReport(report);
}

export function writeOpcoreMetricArtifacts(repoRoot: string, report: OpcoreMetricReport): WriteOpcoreMetricArtifactsResult {
  const validatedReport = validateOpcoreMetricReport(report);
  const opcoreDir = join(repoRoot, ".opcore");
  const reportPath = join(opcoreDir, "report.json");
  const historyPath = join(opcoreDir, "history.jsonl");
  const recordedAt = new Date().toISOString();
  const historyEntry = validateOpcoreMetricHistoryEntry({
    schemaVersion: 1,
    kind: "opcore_metric_history_entry",
    recordedAt,
    report: validatedReport
  });

  mkdirSync(opcoreDir, { recursive: true });
  const tempReportPath = join(opcoreDir, `.report.json.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tempReportPath, `${JSON.stringify(validatedReport, null, 2)}\n`);
  renameSync(tempReportPath, reportPath);
  appendFileSync(historyPath, `${JSON.stringify(historyEntry)}\n`);

  return { reportPath, historyPath, historyEntry };
}

export function writeCommandLatencyTelemetry(
  repoRoot: string,
  record: CommandLatencyRecord
): WriteCommandLatencyTelemetryResult {
  const validatedRecord = validateCommandLatencyRecord(record);
  const opcoreDir = join(repoRoot, ".opcore");
  const telemetryPath = join(repoRoot, commandLatencyTelemetryArtifactPolicy.path);
  mkdirSync(opcoreDir, { recursive: true });
  const existingRecords = readCommandLatencyTelemetryRecords(telemetryPath);
  const records = boundCommandLatencyTelemetryRecords([...existingRecords, validatedRecord]);
  const text = recordsToJsonl(records);
  const tempTelemetryPath = join(opcoreDir, `.telemetry.jsonl.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tempTelemetryPath, text, "utf8");
  renameSync(tempTelemetryPath, telemetryPath);
  return {
    telemetryPath,
    record: validatedRecord,
    retainedRecords: records.length,
    bytes: utf8ByteLength(text)
  };
}

export function readCommandLatencyTelemetry(repoRoot: string): readonly CommandLatencyRecord[] {
  return readCommandLatencyTelemetryRecords(join(repoRoot, commandLatencyTelemetryArtifactPolicy.path));
}

export function readOpcoreLatencyBudgets(repoRoot: string): readonly LatencyBudget[] {
  const budgetPath = latencyBudgetPath(repoRoot);
  if (budgetPath === undefined) return [];
  const stats = statSync(budgetPath);
  if (stats.size > latencyBudgetArtifactPolicy.maxBytes) {
    throw new Error(`Opcore latency budget file exceeds ${latencyBudgetArtifactPolicy.maxBytes} byte cap`);
  }
  const parsed = JSON.parse(readFileSync(budgetPath, "utf8")) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as { budgets?: unknown }).budgets
      : undefined;
  if (!Array.isArray(entries)) throw new Error("Opcore latency budget file must contain a budgets array");
  if (entries.length > latencyBudgetArtifactPolicy.maxBudgets) {
    throw new Error(`Opcore latency budget file exceeds ${latencyBudgetArtifactPolicy.maxBudgets} budget cap`);
  }
  return entries.map((budget) => validateLatencyBudget(budget as LatencyBudget));
}

function latencyBudgetPath(repoRoot: string): string | undefined {
  const localBudgetPath = join(repoRoot, "docs", "performance", "latency-budgets.json");
  if (existsSync(localBudgetPath)) return localBudgetPath;
  const packageBudgetPath = join(packageRoot(), "docs", "performance", "latency-budgets.json");
  if (existsSync(packageBudgetPath)) return packageBudgetPath;
  return undefined;
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function readCommandLatencyTelemetryRecords(telemetryPath: string): CommandLatencyRecord[] {
  if (!existsSync(telemetryPath)) return [];
  const stats = statSync(telemetryPath);
  if (stats.size > commandLatencyTelemetryArtifactPolicy.maxBytes) {
    throw new Error(`Opcore telemetry file exceeds ${commandLatencyTelemetryArtifactPolicy.maxBytes} byte artifact cap`);
  }
  return readFileSync(telemetryPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return validateCommandLatencyRecord(JSON.parse(line) as CommandLatencyRecord);
      } catch (error) {
        throw new Error(`Invalid Opcore telemetry entry at line ${index + 1}: ${errorMessage(error)}`);
      }
    });
}

function boundCommandLatencyTelemetryRecords(records: readonly CommandLatencyRecord[]): CommandLatencyRecord[] {
  const bounded = records.slice(-commandLatencyTelemetryArtifactPolicy.maxRecords);
  while (bounded.length > 0 && utf8ByteLength(recordsToJsonl(bounded)) > commandLatencyTelemetryArtifactPolicy.maxBytes) {
    if (bounded.length === 1) {
      throw new Error(
        `Opcore telemetry record exceeds ${commandLatencyTelemetryArtifactPolicy.maxBytes} byte artifact cap`
      );
    }
    bounded.shift();
  }
  return bounded;
}

function recordsToJsonl(records: readonly CommandLatencyRecord[]): string {
  return records.length === 0
    ? ""
    : `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function readOpcoreMetricHistory(repoRoot: string): readonly OpcoreMetricHistoryEntry[] {
  const historyPath = join(repoRoot, ".opcore", "history.jsonl");
  const text = readFileSync(historyPath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return validateOpcoreMetricHistoryEntry(JSON.parse(line) as OpcoreMetricHistoryEntry);
      } catch (error) {
        throw new Error(`Invalid Opcore metric history entry at line ${index + 1}: ${errorMessage(error)}`);
      }
    });
}

export function readOpcoreMetricReport(repoRoot: string): OpcoreMetricReport {
  const reportPath = join(repoRoot, ".opcore", "report.json");
  try {
    return validateOpcoreMetricReport(JSON.parse(readFileSync(reportPath, "utf8")) as OpcoreMetricReport);
  } catch (error) {
    throw new Error(`Invalid Opcore metric report: ${errorMessage(error)}`);
  }
}

export function createOpcoreMeasureDelta(args: {
  current: OpcoreMetricReport;
  history: readonly OpcoreMetricHistoryEntry[];
  latencyRecords?: readonly CommandLatencyRecord[];
  latencyBudgets?: readonly LatencyBudget[];
  generatedAt?: string;
}): OpcoreMeasureDelta {
  const current = validateOpcoreMetricReport(args.current);
  const history = args.history.map((entry) => validateOpcoreMetricHistoryEntry(entry));
  const latency = createOpcoreMeasureLatencyReport(args.latencyRecords ?? [], args.latencyBudgets ?? []);
  const baselineEntry = history[0];
  const previousEntry = previousHistoryEntry(current, history);
  const nextActions = latency.findings.length > 0
    ? [`Inspect slow command latency: ${formatCommand(latency.findings[0].canonicalCommand)}`, ...current.nextActions].slice(0, 3)
    : current.nextActions;
  const delta: OpcoreMeasureDelta = {
    schemaVersion: 1,
    kind: "opcore_measure_delta",
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    current: {
      generatedAt: current.generatedAt,
      coverage: current.coverage,
      signals: signalCounts(current)
    },
    ...(latency.recordCount > 0 ? { latency } : {}),
    ...(baselineEntry ? { baseline: comparisonFor(current, baselineEntry) } : {}),
    ...(previousEntry ? { previous: comparisonFor(current, previousEntry) } : {}),
    warnings: [...current.warnings],
    degradations: [...current.degradations],
    nextActions
  };
  return validateOpcoreMeasureDelta(delta);
}

export function formatOpcoreReportHuman(report: OpcoreMetricReport): string {
  const validated = validateOpcoreMetricReport(report);
  return [
    "Coverage:",
    `  files=${validated.coverage.totalFiles} graph=${validated.coverage.graph.supportedFiles} validation=${validated.coverage.validation.supportedFiles} unsupported=${validated.coverage.unsupported.totalFiles}`,
    "Signals:",
    ...signalLines(validated.signals),
    "Warnings/degradations:",
    ...warningAndDegradationLines(validated.warnings, validated.degradations),
    "Next:",
    ...validated.nextActions.map((action) => `  ${action}`)
  ].join("\n");
}

export function formatOpcoreMeasureHuman(delta: OpcoreMeasureDelta): string {
  const validated = validateOpcoreMeasureDelta(delta);
  return [
    "Coverage:",
    `  files=${validated.current.coverage.totalFiles} graph=${validated.current.coverage.graph.supportedFiles} validation=${validated.current.coverage.validation.supportedFiles} unsupported=${validated.current.coverage.unsupported.totalFiles}`,
    "Signals:",
    ...measureSignalLines(validated),
    "Latency:",
    ...latencyLines(validated.latency),
    "Warnings/degradations:",
    ...warningAndDegradationLines(validated.warnings, validated.degradations),
    "Next:",
    ...validated.nextActions.map((action) => `  ${action}`)
  ].join("\n");
}

function createOpcoreMeasureLatencyReport(
  records: readonly CommandLatencyRecord[],
  budgets: readonly LatencyBudget[]
): OpcoreMeasureLatencyReport {
  const validatedRecords = records.map((record) => validateCommandLatencyRecord(record));
  const validatedBudgets = budgets.map((budget) => validateLatencyBudget(budget));
  const groups = new Map<string, LatencyObservation[]>();
  for (const record of validatedRecords) {
    for (const observation of latencyObservations(record, validatedBudgets)) {
      const key = latencyGroupKey(observation);
      const group = groups.get(key) ?? [];
      group.push(observation);
      groups.set(key, group);
    }
  }
  const findings = [...groups.values()]
    .map((group) => latencyFinding(group))
    .filter((action): action is OpcoreMeasureLatencyFinding => action.status !== "ok")
    .sort(compareLatencyActions)
    .slice(0, 20);
  return {
    kind: "opcore_latency_report",
    recordCount: validatedRecords.length,
    budgetCount: validatedBudgets.length,
    findings
  };
}

function latencyObservations(record: CommandLatencyRecord, budgets: readonly LatencyBudget[]): readonly LatencyObservation[] {
  const repoShapeBucket = classifyRepoShapeBucket(record);
  const matchingBudgets = budgets.filter((budget) =>
    budget.scope === record.timing.processState &&
    budget.repoShapeBucket === repoShapeBucket &&
    commandMatchesBudget(record.canonicalCommand, budget.canonicalCommand)
  );
  if (matchingBudgets.length === 0) {
    return [
      {
        canonicalCommand: record.canonicalCommand,
        repoShapeBucket,
        processState: record.timing.processState,
        phase: "total",
        recordedAt: record.recordedAt,
        durationMs: record.timing.durationMs
      }
    ];
  }

  return matchingBudgets.flatMap((budget) => {
    const observations: LatencyObservation[] = [
      {
        canonicalCommand: budget.canonicalCommand,
        repoShapeBucket,
        processState: record.timing.processState,
        phase: "total",
        recordedAt: record.recordedAt,
        durationMs: record.timing.durationMs,
        budgetMs: budget.budgetMs
      }
    ];
    for (const phaseBudget of budget.phaseBudgets ?? []) {
      const phase = record.timing.phases.find((entry) => entry.phase === phaseBudget.phase);
      if (phase === undefined) continue;
      observations.push({
        canonicalCommand: budget.canonicalCommand,
        repoShapeBucket,
        processState: record.timing.processState,
        phase: phase.phase,
        recordedAt: record.recordedAt,
        durationMs: phase.durationMs,
        budgetMs: phaseBudget.budgetMs
      });
    }
    return observations;
  });
}

function latencyFinding(group: readonly LatencyObservation[]): OpcoreMeasureLatencyFinding | (Omit<OpcoreMeasureLatencyFinding, "status"> & { status: "ok" }) {
  const sorted = [...group].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  const current = sorted.at(-1);
  if (!current) throw new Error("Latency action requires at least one telemetry record");
  const previous = sorted.at(-2);
  const baseline = sorted[0] === current ? undefined : sorted[0];
  const overBudgetMs = current.budgetMs !== undefined ? Math.max(0, current.durationMs - current.budgetMs) : undefined;
  const previousDeltaMs = previous ? current.durationMs - previous.durationMs : undefined;
  const baselineDeltaMs = baseline ? current.durationMs - baseline.durationMs : undefined;
  const status = overBudgetMs !== undefined && overBudgetMs > 0
    ? "over_budget"
    : (previousDeltaMs !== undefined && previousDeltaMs > 0) || (baselineDeltaMs !== undefined && baselineDeltaMs > 0)
      ? "slower"
      : "ok";
  return {
    canonicalCommand: current.canonicalCommand,
    repoShapeBucket: current.repoShapeBucket,
    processState: current.processState,
    status,
    currentDurationMs: current.durationMs,
    dominantPhase: { phase: current.phase, durationMs: current.durationMs },
    ...(baseline ? { baselineDurationMs: baseline.durationMs, baselineDeltaMs } : {}),
    ...(previous ? { previousDurationMs: previous.durationMs, previousDeltaMs } : {}),
    ...(current.budgetMs !== undefined ? { budgetMs: current.budgetMs } : {}),
    ...(overBudgetMs !== undefined && overBudgetMs > 0 ? { overBudgetMs } : {})
  };
}

function compareLatencyActions(left: OpcoreMeasureLatencyFinding, right: OpcoreMeasureLatencyFinding): number {
  const leftOver = left.overBudgetMs ?? 0;
  const rightOver = right.overBudgetMs ?? 0;
  if (leftOver !== rightOver) return rightOver - leftOver;
  const leftPrevious = left.previousDeltaMs ?? 0;
  const rightPrevious = right.previousDeltaMs ?? 0;
  if (leftPrevious !== rightPrevious) return rightPrevious - leftPrevious;
  const leftBaseline = left.baselineDeltaMs ?? 0;
  const rightBaseline = right.baselineDeltaMs ?? 0;
  if (leftBaseline !== rightBaseline) return rightBaseline - leftBaseline;
  const leftCommand = formatCommand(left.canonicalCommand);
  const rightCommand = formatCommand(right.canonicalCommand);
  if (leftCommand !== rightCommand) return leftCommand.localeCompare(rightCommand);
  return right.currentDurationMs - left.currentDurationMs;
}

function commandMatchesBudget(observedCommand: readonly string[], budgetCommand: readonly string[]): boolean {
  if (observedCommand.length < budgetCommand.length) return false;
  return budgetCommand.every((token, index) => observedCommand[index] === token);
}

function latencyGroupKey(observation: LatencyObservation): string {
  return JSON.stringify([
    observation.canonicalCommand,
    observation.processState,
    observation.repoShapeBucket,
    observation.phase
  ]);
}

function classifyRepoShapeBucket(record: CommandLatencyRecord): string {
  if (record.repo.totalFiles <= 100) return "small";
  if (record.repo.totalFiles <= 5000) return "medium";
  return "large";
}

function latencyLines(latency: OpcoreMeasureLatencyReport | undefined): readonly string[] {
  if (!latency || latency.findings.length === 0) return ["  none"];
  return latency.findings.map((action) => {
    const phaseName = action.dominantPhase?.phase ?? "total";
    const budget = action.budgetMs !== undefined ? ` budget=${action.budgetMs}ms` : "";
    const over = action.overBudgetMs !== undefined && action.overBudgetMs > 0 ? ` over=${action.overBudgetMs}ms` : "";
    const previous = action.previousDeltaMs !== undefined ? ` previous=${formatSigned(action.previousDeltaMs)}ms` : "";
    const baseline = action.baselineDeltaMs !== undefined ? ` baseline=${formatSigned(action.baselineDeltaMs)}ms` : "";
    return `  ${formatCommand(action.canonicalCommand)} [${action.processState}/${action.repoShapeBucket}/${phaseName}/${action.status}]: ${action.currentDurationMs}ms${budget}${over}${previous}${baseline}`;
  });
}

function addDiagnosticSignal(
  signals: OpcoreMetricSignal[],
  args: {
    id: string;
    title: string;
    category: OpcoreMetricSignal["category"];
    severity: OpcoreMetricSignal["severity"];
    checkId: string;
    diagnostics: readonly ValidationDiagnostic[];
  }
): void {
  const evidence = args.diagnostics.flatMap((diagnostic) => diagnosticEvidence(diagnostic, args.checkId));
  if (evidence.length === 0) return;
  signals.push({
    id: args.id,
    title: args.title,
    category: args.category,
    severity: args.severity,
    count: evidence.length,
    evidence
  });
}

function addUnsupportedLanguageSignal(signals: OpcoreMetricSignal[], repoState: OpcoreRepoStatePayload): void {
  if (repoState.coverage.unsupported.totalFiles <= 0) return;
  const evidence = repoState.coverage.unsupported.stacks.flatMap((stack) =>
    stack.examples.map((path): OpcoreMetricEvidence => ({
      source: "repo_census",
      path,
      message: `${stack.language} file is outside day-one Opcore analysis support.`
    }))
  );
  if (evidence.length === 0) return;
  signals.push({
    id: "coverage.unsupported_stacks",
    title: "Unsupported language census",
    category: "coverage",
    severity: "info",
    count: repoState.coverage.unsupported.totalFiles,
    evidence
  });
}

function addGraphStructureSignals(
  signals: OpcoreMetricSignal[],
  degradations: OpcoreMetricDegradation[],
  repoState: OpcoreRepoStatePayload,
  graphFacts: OpcoreMetricGraphFacts | undefined
): void {
  if (repoState.coverage.graph.supportedFiles === 0) return;
  if (graphFacts === undefined) {
    degradations.push({
      id: "graph.facts.unavailable",
      title: "Graph structure metrics unavailable",
      source: "graph_facts",
      severity: "warning",
      message: "Graph facts were not supplied; TS/JS structure and fan-in metrics were not computed."
    });
    return;
  }

  const edges = graphFacts.edges ?? [];
  const nodesById = new Map((graphFacts.nodes ?? []).map((node) => [node.id, node]));
  const containedByFile = new Map<string, number>();
  const importersByTarget = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind === "CONTAINS") {
      const path = endpointPath(edge.from, nodesById);
      if (path !== undefined && isTsJsPath(path)) increment(containedByFile, path);
    }
    if (edge.kind === "IMPORTS_FROM") {
      const target = endpointPath(edge.to, nodesById);
      const source = endpointPath(edge.from, nodesById) ?? edge.from;
      if (target !== undefined && isTsJsPath(target)) {
        const importers = importersByTarget.get(target) ?? new Set<string>();
        importers.add(source);
        importersByTarget.set(target, importers);
      }
    }
  }

  const godFileEvidence = [...containedByFile.entries()]
    .filter(([, count]) => count > graphStructureThresholds.maxContainedSymbolsPerFile)
    .map(([path, count]): OpcoreMetricEvidence => ({
      source: "graph_fact",
      path,
      message: `${count} CONTAINS graph facts exceed ${graphStructureThresholds.maxContainedSymbolsPerFile}.`
    }));
  if (godFileEvidence.length > 0) {
    signals.push({
      id: "typescript.structure.god_files",
      title: "TS/JS high-structure files",
      category: "graph",
      severity: "warning",
      count: godFileEvidence.length,
      evidence: godFileEvidence
    });
  }

  const fanInEvidence = [...importersByTarget.entries()]
    .filter(([, importers]) => importers.size > graphStructureThresholds.maxImportFanIn)
    .map(([path, importers]): OpcoreMetricEvidence => ({
      source: "graph_fact",
      path,
      message: `${importers.size} IMPORTS_FROM graph sources exceed ${graphStructureThresholds.maxImportFanIn}.`
    }));
  if (fanInEvidence.length > 0) {
    signals.push({
      id: "typescript.structure.high_fan_in",
      title: "TS/JS high fan-in files",
      category: "graph",
      severity: "warning",
      count: fanInEvidence.length,
      evidence: fanInEvidence
    });
  }

  if ((graphFacts.metadata !== undefined && !graphFacts.metadata.edgeKinds.includes("IMPORTS_FROM")) || edges.length === 0) {
    degradations.push({
      id: "graph.structure.partial",
      title: "Graph structure facts incomplete",
      source: "graph_facts",
      severity: "warning",
      message: "Graph facts did not include enough IMPORTS_FROM/CONTAINS evidence for full structure metrics."
    });
  }
}

function addValidationDegradations(
  degradations: OpcoreMetricDegradation[],
  repoState: OpcoreRepoStatePayload,
  validationResult: ValidationResult | undefined
): void {
  for (const diagnostic of validationResult?.diagnostics ?? []) {
    if (diagnostic.code === "TS_DEAD_CODE_UNSUPPORTED") {
      degradations.push({
        id: "typescript.dead_exports.unavailable",
        title: "TS/JS dead-export metric unavailable",
        source: "validation_diagnostic",
        severity: "warning",
        message: diagnostic.message,
        checkId: tsDeadCodeCheckId
      });
    }
  }

  const checks = new Set(validationResult?.manifest?.checks ?? []);
  const skippedChecks = validationResult?.manifest?.skippedChecks ?? [];
  if (repoState.coverage.graph.supportedFiles > 0 && !checks.has(tsDeadCodeCheckId)) {
    degradations.push({
      id: "typescript.dead_exports.not_run",
      title: "TS/JS dead-export metric not run",
      source: "validation_manifest",
      severity: "warning",
      message: "Validation manifest did not include typescript.dead-code; dead-export findings are unavailable.",
      checkId: tsDeadCodeCheckId
    });
  }

  for (const skipped of skippedChecks) {
    if (skipped.reason === "graph_unavailable" || graphBackedCheckId(skipped.checkId)) {
      degradations.push(skippedCheckDegradation(skipped));
    }
  }

  for (const tool of repoState.validation.degradedToolchains) {
    degradations.push({
      id: `${safeId(tool.adapter)}.tool.${safeId(tool.tool)}.unavailable`,
      title: `Validation tool unavailable: ${tool.adapter}:${tool.tool}`,
      source: "opcore_status",
      severity: "warning",
      message: tool.failureMessage ?? `${tool.tool} is unavailable; related validation metrics are degraded.`,
      requiredTool: tool.tool
    });
  }
}

function skippedCheckDegradation(skipped: ValidationSkippedCheck): OpcoreMetricDegradation {
  return {
    id: `validation.${safeId(skipped.checkId)}.skipped`,
    title: `Validation check skipped: ${skipped.checkId}`,
    source: "validation_manifest",
    severity: "warning",
    message: skipped.message,
    checkId: skipped.checkId
  };
}

function diagnosticEvidence(diagnostic: ValidationDiagnostic, checkId: string): readonly OpcoreMetricEvidence[] {
  if (diagnostic.path === undefined || diagnostic.path.length === 0) return [];
  return [
    {
      source: "validation_diagnostic",
      path: diagnostic.path,
      message: diagnostic.message,
      checkId,
      ...(diagnostic.code ? { code: diagnostic.code } : {})
    }
  ];
}

function isRustModuleGraphDiagnostic(diagnostic: ValidationDiagnostic): boolean {
  return diagnostic.code === "RUST_DEAD_ORPHAN_SOURCE" || diagnostic.code?.startsWith("RUST_IMPORT_") === true;
}

function isRustToolchainDiagnostic(diagnostic: ValidationDiagnostic): boolean {
  const code = diagnostic.code ?? "";
  if (code === "RUST_FMT_DRIFT" || code === "RUST_CARGO_COMMAND" || code === "RUST_CARGO_METADATA") return true;
  if (code === "RUST_UNUSED_DEPS" || code === "RUST_UNUSED_DEPENDENCY") return true;
  if (code === "dead_code" || code.startsWith("clippy::")) return true;
  if ((diagnostic.category === "types" || diagnostic.category === "lint") && isRustSourcePath(diagnostic.path)) return true;
  return false;
}

function graphBackedCheckId(checkId: string): boolean {
  return checkId === tsRelevantTestsCheckId || checkId === tsDeadCodeCheckId || checkId === "typescript.import-graph";
}

function previousHistoryEntry(
  current: OpcoreMetricReport,
  history: readonly OpcoreMetricHistoryEntry[]
): OpcoreMetricHistoryEntry | undefined {
  if (history.length === 0) return undefined;
  const last = history.at(-1);
  if (last?.report.generatedAt === current.generatedAt) return history.at(-2);
  return last;
}

function comparisonFor(current: OpcoreMetricReport, comparison: OpcoreMetricHistoryEntry): OpcoreMeasureComparison {
  return {
    recordedAt: comparison.recordedAt,
    generatedAt: comparison.report.generatedAt,
    coverage: comparison.report.coverage,
    signals: signalCounts(comparison.report),
    deltas: signalDeltas(current, comparison.report)
  };
}

function signalCounts(report: OpcoreMetricReport): readonly OpcoreMeasureSignalCount[] {
  return report.signals
    .map((signal) => ({
      id: signal.id,
      title: signal.title,
      count: signal.count
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function signalDeltas(current: OpcoreMetricReport, comparison: OpcoreMetricReport) {
  const currentById = new Map(current.signals.map((signal) => [signal.id, signal]));
  const comparisonById = new Map(comparison.signals.map((signal) => [signal.id, signal]));
  const ids = [...new Set([...currentById.keys(), ...comparisonById.keys()])].sort();
  return ids.map((id) => {
    const currentSignal = currentById.get(id);
    const comparisonSignal = comparisonById.get(id);
    const currentCount = currentSignal?.count ?? 0;
    const comparisonCount = comparisonSignal?.count ?? 0;
    return {
      id,
      title: currentSignal?.title ?? comparisonSignal?.title ?? id,
      currentCount,
      comparisonCount,
      delta: currentCount - comparisonCount
    };
  });
}

function metricNextActions(
  repoState: OpcoreRepoStatePayload,
  signals: readonly OpcoreMetricSignal[],
  degradations: readonly OpcoreMetricDegradation[]
): readonly string[] {
  if (signals.length > 0) {
    return [`Inspect ${signals[0].title}: ${signals[0].evidence[0].path}`, ...repoState.nextActions].slice(0, 3);
  }
  if (degradations.length > 0) {
    return [`Resolve degraded metric coverage: ${degradations[0].title}`, ...repoState.nextActions].slice(0, 3);
  }
  return repoState.nextActions;
}

function signalLines(signals: readonly OpcoreMetricSignal[]): readonly string[] {
  if (signals.length === 0) return ["  none"];
  return signals.map((signal) => `  ${signal.id}: ${signal.count} (${signal.evidence[0].path})`);
}

function measureSignalLines(delta: OpcoreMeasureDelta): readonly string[] {
  const currentSignals = new Map(delta.current.signals.map((signal) => [signal.id, signal]));
  const baselineDeltas = new Map(delta.baseline?.deltas.map((entry) => [entry.id, entry.delta]) ?? []);
  const previousDeltas = new Map(delta.previous?.deltas.map((entry) => [entry.id, entry.delta]) ?? []);
  const deltaEntries = [...(delta.baseline?.deltas ?? []), ...(delta.previous?.deltas ?? [])];
  const ids = [...new Set([...currentSignals.keys(), ...deltaEntries.map((entry) => entry.id)])].sort();
  if (ids.length === 0) return ["  none"];
  return ids.map((id) => {
    const current = currentSignals.get(id);
    const fallback = deltaEntries.find((entry) => entry.id === id);
    const count = current?.count ?? fallback?.currentCount ?? 0;
    const baseline = baselineDeltas.has(id) ? ` baseline=${formatSigned(baselineDeltas.get(id) ?? 0)}` : "";
    const previous = previousDeltas.has(id) ? ` previous=${formatSigned(previousDeltas.get(id) ?? 0)}` : "";
    return `  ${id}: ${count}${baseline}${previous}`;
  });
}

function warningAndDegradationLines(
  warnings: readonly string[],
  degradations: readonly OpcoreMetricDegradation[]
): readonly string[] {
  const lines = [
    ...warnings.map((warning) => `  warning: ${warning}`),
    ...degradations.map((degradation) => `  degraded: ${degradation.title}: ${degradation.message}`)
  ];
  return lines.length === 0 ? ["  none"] : lines;
}

function endpointPath(endpoint: string, nodesById: ReadonlyMap<string, GraphFactNode>): string | undefined {
  const node = nodesById.get(endpoint);
  if (node !== undefined) return nodePath(node);
  const match = /^[^:]+:([^#]+)(?:#.*)?$/.exec(endpoint);
  return match?.[1];
}

function nodePath(node: GraphFactNode): string | undefined {
  return node.path ?? stringAttribute(node.attributes, ["path", "file", "filePath", "sourcePath"]);
}

function stringAttribute(attributes: Record<string, JsonValue> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attributes?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function hasPath(diagnostic: ValidationDiagnostic): boolean {
  return diagnostic.path !== undefined && diagnostic.path.length > 0;
}

function isTsJsPath(path: string | undefined): boolean {
  return path !== undefined && /\.(?:[cm]?[tj]sx?|jsx)$/.test(path);
}

function isRustSourcePath(path: string | undefined): boolean {
  return path !== undefined && /\.(?:rs|inc)$/.test(path);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortSignals(signals: readonly OpcoreMetricSignal[]): readonly OpcoreMetricSignal[] {
  return [...signals].sort((left, right) => left.id.localeCompare(right.id));
}

function sortDegradations(degradations: readonly OpcoreMetricDegradation[]): readonly OpcoreMetricDegradation[] {
  const seen = new Set<string>();
  const unique = [];
  for (const degradation of [...degradations].sort((left, right) => left.id.localeCompare(right.id))) {
    const key = `${degradation.id}\0${degradation.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(degradation);
  }
  return unique;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function formatCommand(command: readonly string[]): string {
  return command.length > 0 ? command.join(" ") : "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
