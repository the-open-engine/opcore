import type {
  CommandRouterResult,
  OpcoreInitAction,
  OpcoreInitInteraction,
  OpcoreInitLanguageSetting,
  OpcoreInitPythonEnvironment,
  OpcoreInitPlanPayload,
  OpcoreInitScanSummary,
  OpcoreInitSettings,
  OpcoreInitTiming,
  OpcoreRepoStatePayload,
  ParsedCommandArgv,
  ValidationResult
} from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult } from "@the-open-engine/opcore-contracts";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createOpcoreScanAnalysis, type OpcoreScanAnalysis } from "./scan.js";
import { commonSkippedPathSegments, resolveRepo, type RepoResolution } from "./status.js";

declare const process: {
  cwd(): string;
};

const helpArgs = new Set(["--help", "-h", "help"]);
export const AGENT_FILE_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".codex/AGENTS.md",
  ".opencode/AGENTS.md"
] as const;

const beginMarker = "<!-- BEGIN OPCORE INIT -->";
const endMarker = "<!-- END OPCORE INIT -->";
const configPath = ".opcore/config";
const undoPath = ".opcore/init-undo.json";
const hookPath = ".opcore/hooks/pre-commit-opcore-check.sh";
const failClosedHookActivationCommand = "cp .opcore/hooks/pre-commit-opcore-check.sh .git/hooks/pre-commit";
const gitignorePath = ".gitignore";
const opcoreIgnoreLine = ".opcore/";
const defaultInitProgressIntervalMs = 5000;
const allowedUndoPaths = new Set<string>([configPath, undoPath, hookPath, gitignorePath, ...AGENT_FILE_CANDIDATES]);
const rustActiveValidationKinds = new Set([".rs", ".inc", "Cargo.toml"]);
const pythonProjectFileNames = new Set(["pyproject.toml", "Pipfile", "poetry.lock", "uv.lock"]);
const pythonVirtualEnvDirs = new Set([".venv", "venv", "env"]);
const pythonDiscoverySkipDirs = new Set([
  ...commonSkippedPathSegments,
  "__pycache__",
  ".eggs",
  "build",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "site-packages"
]);

interface ParsedInitArgs {
  repo: string;
  approved: boolean;
  dryRun: boolean;
  failClosedHook: boolean;
  undo: boolean;
}

export interface OpcoreInitRuntime {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  writeStderr?: (text: string) => void;
  scanAnalysis?: (resolution: RepoResolution) => Promise<OpcoreScanAnalysis>;
  initProgressIntervalMs?: number;
  readLine?: (prompt: string) => Promise<string>;
}

interface InitContext {
  scan: OpcoreInitScanSummary;
  settings: OpcoreInitSettings;
  interaction: OpcoreInitInteraction;
  timings: OpcoreInitTiming;
}

interface TimingState {
  startedAt: number;
  scanMs: number;
  planMs: number;
  promptMs: number;
  applyMs: number;
}

interface PlannedInit {
  payload: OpcoreInitPlanPayload;
  writes: readonly PlannedWrite[];
}

type PlannedWrite = PlannedFileWrite | PlannedManagedLineAppend;

interface PlannedFileWrite {
  kind: "write";
  path: string;
  content: string;
  executable?: boolean;
}

interface PlannedManagedLineAppend {
  kind: "append_managed_line";
  path: string;
  line: string;
}

interface UndoMetadata {
  schemaVersion: 1;
  kind: "opcore_init_undo";
  repoRoot: string;
  entries: readonly UndoEntry[];
}

type UndoEntry = FileUndoEntry | ManagedLineUndoEntry;

interface FileUndoEntry {
  kind?: "restore_file";
  path: string;
  existed: boolean;
  content?: string;
}

interface ManagedLineUndoEntry {
  kind: "append_managed_line";
  path: string;
  existed: boolean;
  line: string;
  appended?: string;
}

export async function routeOpcoreInit(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime = {}
): Promise<CommandRouterResult> {
  const rest = parsed.args.slice(1);
  if (rest.some((arg) => helpArgs.has(arg))) {
    return createInitRouterResult(argv, parsed.json, "ok", opcoreInitHelpMessage(), ["opcore", "init", "help"]);
  }

  const parsedInit = parseOpcoreInitArgs(rest);
  if (!parsedInit.ok) {
    return createInitRouterResult(argv, parsed.json, "error", parsedInit.message);
  }
  const resolution = resolveRepo(parsedInit.args.repo, "opcore init");
  if (!resolution.ok) {
    return createInitRouterResult(argv, parsed.json, "error", resolution.message);
  }

  try {
    const timing: TimingState = {
      startedAt: nowMs(),
      scanMs: 0,
      planMs: 0,
      promptMs: 0,
      applyMs: 0
    };
    const scanStartedAt = nowMs();
    const progress = startInitScanProgress(parsed.json, runtime);
    const scanAnalysis = runtime.scanAnalysis ?? createOpcoreScanAnalysis;
    let analysis: OpcoreScanAnalysis;
    try {
      analysis = await scanAnalysis(resolution.resolution);
      timing.scanMs = elapsedMs(scanStartedAt);
      progress?.complete(timing.scanMs);
    } catch (error) {
      timing.scanMs = elapsedMs(scanStartedAt);
      progress?.fail(timing.scanMs);
      throw error;
    }
    const context: InitContext = {
      scan: createInitScanSummary(analysis.repoState, analysis.validationResult),
      settings: createInitSettings(analysis.repoState, resolution.resolution.root),
      interaction: {
        tty: isInteractiveRuntime(runtime),
        promptState: "not_requested"
      },
      timings: finalizeTimings(timing)
    };

    if (parsedInit.args.undo) {
      return routeOpcoreInitUndo(
        argv,
        parsed.json,
        resolution.resolution.root,
        resolution.resolution.requestedPath,
        parsedInit.args,
        context,
        timing
      );
    }

    return await routeOpcoreInitPlanOrApply(
      argv,
      parsed.json,
      resolution.resolution.root,
      resolution.resolution.requestedPath,
      resolution.resolution.git,
      parsedInit.args,
      context,
      timing,
      runtime
    );
  } catch (error) {
    return createInitRouterResult(argv, parsed.json, "error", `opcore init failed: ${errorMessage(error)}`);
  }
}

function routeOpcoreInitUndo(
  argv: readonly string[],
  json: boolean,
  repoRoot: string,
  requestedPath: string,
  options: ParsedInitArgs,
  context: InitContext,
  timing: TimingState
): CommandRouterResult {
  const planStartedAt = nowMs();
  const undo = planUndo(repoRoot, requestedPath, options, context);
  timing.planMs = elapsedMs(planStartedAt);
  const approved = options.approved && !options.dryRun;
  if (approved) {
    const applyStartedAt = nowMs();
    applyUndo(repoRoot, undo);
    timing.applyMs = elapsedMs(applyStartedAt);
  }
  const payload = withContext(approved ? appliedUndoPayload(undo, repoRoot) : undo, context, timing);
  return createInitRouterResult(argv, json, "ok", formatInitPlan(payload, approved), ["opcore", "init"], payload);
}

async function routeOpcoreInitPlanOrApply(
  argv: readonly string[],
  json: boolean,
  repoRoot: string,
  requestedPath: string,
  git: boolean,
  options: ParsedInitArgs,
  context: InitContext,
  timing: TimingState,
  runtime: OpcoreInitRuntime
): Promise<CommandRouterResult> {
  const planStartedAt = nowMs();
  const planned = planInit(repoRoot, requestedPath, git, options, context);
  timing.planMs = elapsedMs(planStartedAt);
  let payload = withContext(planned.payload, context, timing);
  let approved = options.approved && !options.dryRun;
  let prompted = false;

  if (shouldPromptForApproval(json, options, runtime)) {
    prompted = true;
    context.interaction = { tty: true, promptState: "requested" };
    payload = withContext(payload, context, timing);
    const promptStartedAt = nowMs();
    const answer = await runtime.readLine(`${formatInitPlan(payload, false)}\nApply setup? [y/N] `);
    timing.promptMs = elapsedMs(promptStartedAt);
    if (isExplicitYes(answer)) {
      approved = true;
      context.interaction = { tty: true, promptState: "approved" };
    } else {
      context.interaction = { tty: true, promptState: "declined" };
      payload = {
        ...payload,
        nextActions: ["No files written. Rerun opcore init when ready."]
      };
    }
  }

  if (approved) {
    const applyStartedAt = nowMs();
    applyInit(repoRoot, planned.writes);
    timing.applyMs = elapsedMs(applyStartedAt);
  }
  payload = approved ? appliedInitPayload(payload, repoRoot) : payload;
  payload = withContext(payload, context, timing);
  const message = prompted ? formatInteractiveOutcome(payload) : formatInitPlan(payload, approved);
  return createInitRouterResult(argv, json, "ok", message, ["opcore", "init"], payload);
}

function createInitRouterResult(
  argv: readonly string[],
  json: boolean,
  status: "ok" | "error",
  message: string,
  canonicalCommand: readonly string[] = ["opcore", "init"],
  opcoreInit?: OpcoreInitPlanPayload
): CommandRouterResult {
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand,
    owner: "runtime",
    status,
    json,
    message,
    opcoreInit
  });
}

function createInitScanSummary(repoState: OpcoreRepoStatePayload, validationResult: ValidationResult): OpcoreInitScanSummary {
  const failedChecks = validationResult.manifest?.runs
    ?.filter((run) => run.status !== "passed")
    .map((run) => run.checkId) ?? [];
  return {
    totalFiles: repoState.coverage.totalFiles,
    graphSupportedFiles: repoState.coverage.graph.supportedFiles,
    validationSupportedFiles: repoState.coverage.validation.supportedFiles,
    validationRetainedFiles: repoState.coverage.validation.retainedFiles,
    unsupportedFiles: repoState.coverage.unsupported.totalFiles,
    languages: repoState.coverage.languages,
    unsupportedStacks: repoState.coverage.unsupported.stacks,
    degradedRustTools: repoState.validation.degradedToolchains,
    diagnosticCount: validationResult.diagnostics.length,
    validationStatus: validationResult.status,
    failedChecks,
    graphState: repoState.graph.state,
    activationLevel: repoState.activation.level
  };
}

function createInitSettings(repoState: OpcoreRepoStatePayload, repoRoot: string): OpcoreInitSettings {
  const unsupportedLanguages = new Set(repoState.coverage.unsupported.stacks.map((stack) => stack.language));
  const degradedRustTools = repoState.validation.degradedToolchains.filter((tool) => tool.adapter === "rust").map((tool) => tool.tool);
  const degradedPythonTools = repoState.validation.degradedToolchains.filter((tool) => tool.adapter === "python").map((tool) => tool.tool);
  const rustHasActiveValidationInput = repoState.coverage.validation.extensions.some((entry) =>
    rustActiveValidationKinds.has(entry.extension)
  );
  const pythonProject = detectPythonProjectSignals(repoRoot);
  return {
    languages: repoState.coverage.languages.map((language): OpcoreInitLanguageSetting => {
      const rustRetainedOnly =
        language.language === "Rust" &&
        !rustHasActiveValidationInput &&
        repoState.coverage.validation.retainedFiles > 0;
      const rustDegraded = language.language === "Rust" && degradedRustTools.length > 0 && language.validationSupported && !rustRetainedOnly;
      const pythonDegraded = language.language === "Python" && degradedPythonTools.length > 0 && language.validationSupported;
      const unsupported = unsupportedLanguages.has(language.language) && !language.validationSupported;
      const validation = unsupported
        ? "unsupported"
        : rustRetainedOnly
          ? "retained"
          : rustDegraded || pythonDegraded
            ? "degraded"
            : language.validationSupported
              ? "supported"
              : "unsupported";
      const state = validation === "unsupported"
        ? "unsupported"
        : validation === "retained"
          ? "retained"
          : validation === "degraded"
            ? "degraded"
            : "supported";
      return {
        language: language.language,
        files: language.files,
        state,
        graph: language.graphSupported ? "supported" : "unsupported",
        validation,
        checks: checksForLanguage(language.language, validation),
        notes: notesForLanguage(
          language.language,
          validation,
          language.language === "Python" ? degradedPythonTools : degradedRustTools,
          language.language === "Python" ? pythonProject : undefined
        )
      };
    }),
    ...(hasPythonEnvironmentSignals(pythonProject) ? { python: pythonProject } : {})
  };
}

function checksForLanguage(language: string, validation: OpcoreInitLanguageSetting["validation"]): string[] {
  if (validation === "unsupported" || validation === "retained") return [];
  if (language === "TypeScript" || language === "JavaScript") {
    return [
      "typescript.syntax",
      "typescript.types",
      "typescript.import-graph",
      "typescript.dead-code",
      "typescript.function-metrics",
      "typescript.relevant-tests",
      "typescript.file-length"
    ];
  }
  if (language === "Rust") {
    return [
      "rust.source-hygiene",
      "rust.fmt",
      "rust.cargo-check",
      "rust.clippy",
      "rust.rustdoc",
      "rust.import-graph",
      "rust.dead-code",
      "rust.unused-deps",
      "rust.file-length",
      "rust.function-metrics"
    ];
  }
  if (language === "Python") {
    return [
      "python.syntax",
      "python.source-hygiene",
      "python.types",
      "python.import-graph",
      "python.dead-code",
      "python.relevant-tests"
    ];
  }
  return [];
}

function notesForLanguage(
  language: string,
  validation: OpcoreInitLanguageSetting["validation"],
  degradedTools: readonly string[],
  pythonProject?: OpcoreInitPythonEnvironment
): string[] {
  if (validation === "unsupported") return ["Unsupported stack counted without fabricated checks."];
  if (validation === "retained") return ["Retained for compatibility; no active checks configured."];
  const notes: string[] = [];
  if (validation === "degraded") notes.push(`${language} validation tools degraded: ${degradedTools.join(", ")}.`);
  if (language === "Python" && pythonProject !== undefined) {
    notes.push(...pythonProject.notes);
  }
  return notes;
}

function detectPythonProjectSignals(repoRoot: string): OpcoreInitPythonEnvironment {
  const files: string[] = [];
  const virtualEnvironmentPaths: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop();
    if (relativeDir === undefined) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(relativeDir.length > 0 ? resolveRepoPath(repoRoot, relativeDir) : repoRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = relativeDir.length > 0 ? `${relativeDir}/${entry.name}` : entry.name;
      const entryStat = lstatIfExists(resolveRepoPath(repoRoot, relativePath));
      if (!entryStat || entryStat.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (pythonVirtualEnvDirs.has(entry.name)) {
          virtualEnvironmentPaths.push(relativePath);
          continue;
        }
        if (pythonDiscoverySkipDirs.has(entry.name) || entry.name.endsWith(".egg-info") || entry.name.endsWith(".dist-info")) {
          continue;
        }
        stack.push(relativePath);
        continue;
      }
      if (entry.isFile() && isPythonProjectFile(entry.name)) files.push(relativePath);
    }
  }
  const uniqueFiles = uniqueStrings(files).sort();
  const dependencyManagers = pythonDependencyManagers(uniqueFiles);
  const virtualEnvironments = uniqueStrings(virtualEnvironmentPaths)
    .sort()
    .map((path) => ({ kind: "venv" as const, path }));
  return {
    dependencyManagers,
    virtualEnvironments,
    notes: pythonEnvironmentNotes(uniqueFiles, dependencyManagers, virtualEnvironments)
  };
}

function isPythonProjectFile(name: string): boolean {
  return pythonProjectFileNames.has(name) || /^requirements.*\.txt$/u.test(name);
}

function pythonDependencyManagers(files: readonly string[]): OpcoreInitPythonEnvironment["dependencyManagers"] {
  const managers: OpcoreInitPythonEnvironment["dependencyManagers"][number][] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const name = file.split("/").at(-1) ?? file;
    const kind = pythonDependencyManagerKind(name);
    if (kind === undefined) continue;
    const key = `${kind}\0${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    managers.push({ kind, path: file });
  }
  return managers.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

function pythonDependencyManagerKind(
  name: string
): OpcoreInitPythonEnvironment["dependencyManagers"][number]["kind"] | undefined {
  if (name === "pyproject.toml") return "pyproject";
  if (/^requirements.*\.txt$/u.test(name)) return "requirements";
  if (name === "Pipfile") return "pipfile";
  if (name === "poetry.lock") return "poetry";
  if (name === "uv.lock") return "uv";
  return undefined;
}

function pythonEnvironmentNotes(
  files: readonly string[],
  dependencyManagers: OpcoreInitPythonEnvironment["dependencyManagers"],
  virtualEnvironments: OpcoreInitPythonEnvironment["virtualEnvironments"]
): string[] {
  const notes: string[] = [];
  if (files.length > 0) {
    notes.push(`Detected Python project files: ${formatExamples(files)}.`);
  }
  if (dependencyManagers.length > 0) {
    notes.push(`Detected Python dependency managers: ${formatManagerKinds(dependencyManagers)}.`);
  }
  if (virtualEnvironments.length > 0) {
    notes.push(`Detected Python virtualenv directories: ${formatExamples(virtualEnvironments.map((entry) => entry.path))}.`);
  }
  if (files.length > 0 || dependencyManagers.length > 0 || virtualEnvironments.length > 0) {
    notes.push("Python graph and validation coverage is reported with missing tools as degraded coverage.");
  }
  return notes;
}

function formatManagerKinds(dependencyManagers: OpcoreInitPythonEnvironment["dependencyManagers"]): string {
  const labels = new Map<OpcoreInitPythonEnvironment["dependencyManagers"][number]["kind"], string>([
    ["pyproject", "pyproject"],
    ["requirements", "pip requirements"],
    ["pipfile", "Pipenv"],
    ["poetry", "Poetry"],
    ["uv", "uv"]
  ]);
  return [...new Set(dependencyManagers.map((entry) => labels.get(entry.kind) ?? entry.kind))].sort().join(", ");
}

function hasPythonEnvironmentSignals(environment: OpcoreInitPythonEnvironment): boolean {
  return environment.dependencyManagers.length > 0 || environment.virtualEnvironments.length > 0 || environment.notes.length > 0;
}

function formatExamples(values: readonly string[]): string {
  const visible = values.slice(0, 5).join(", ");
  return values.length > 5 ? `${visible}, +${values.length - 5} more` : visible;
}

function withContext(payload: OpcoreInitPlanPayload, context: InitContext, timing: TimingState): OpcoreInitPlanPayload {
  return {
    ...payload,
    scan: context.scan,
    settings: context.settings,
    interaction: context.interaction,
    timings: finalizeTimings(timing)
  };
}

function shouldPromptForApproval(json: boolean, options: ParsedInitArgs, runtime: OpcoreInitRuntime): runtime is OpcoreInitRuntime & {
  readLine: (prompt: string) => Promise<string>;
} {
  return (
    !json &&
    !options.approved &&
    !options.dryRun &&
    !options.undo &&
    isInteractiveRuntime(runtime) &&
    typeof runtime.readLine === "function"
  );
}

function isInteractiveRuntime(runtime: OpcoreInitRuntime): boolean {
  return runtime.stdinIsTTY === true && runtime.stdoutIsTTY === true;
}

function isExplicitYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function startInitScanProgress(json: boolean, runtime: OpcoreInitRuntime): { complete(scanMs: number): void; fail(scanMs: number): void } | undefined {
  if (json || runtime.stderrIsTTY !== true || typeof runtime.writeStderr !== "function") return undefined;
  const startedAt = nowMs();
  const intervalMs = normalizeProgressIntervalMs(runtime.initProgressIntervalMs);
  let finished = false;
  const write = (text: string) => writeProgress(runtime.writeStderr, text);
  const writeProgressLine = (text: string) => write(`\r\x1b[2K${text}`);
  write("Opcore init: scanning repository before setup...");
  const timer = setInterval(() => {
    if (finished) return;
    const elapsedSeconds = Math.max(1, Math.floor(elapsedMs(startedAt) / 1000));
    writeProgressLine(`Opcore init: still scanning repository before setup (${elapsedSeconds}s elapsed)...`);
  }, intervalMs) as ReturnType<typeof setInterval> & { unref?: () => void };
  timer.unref?.();
  return {
    complete: (scanMs: number) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      writeProgressLine(`Opcore init: scan complete in ${scanMs}ms.\n`);
    },
    fail: (scanMs: number) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      writeProgressLine(`Opcore init: scan failed after ${scanMs}ms.\n`);
    }
  };
}

function normalizeProgressIntervalMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : defaultInitProgressIntervalMs;
}

function writeProgress(writeStderr: ((text: string) => void) | undefined, text: string): void {
  try {
    writeStderr?.(text);
  } catch {
    // Progress output must never change init scan/apply semantics.
  }
}

function nowMs(): number {
  return Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function finalizeTimings(timing: TimingState): OpcoreInitTiming {
  return {
    scanMs: timing.scanMs,
    planMs: timing.planMs,
    promptMs: timing.promptMs,
    applyMs: timing.applyMs,
    totalMs: elapsedMs(timing.startedAt),
    firstOutputMs: timing.scanMs
  };
}

function parseOpcoreInitArgs(args: readonly string[]): { ok: true; args: ParsedInitArgs } | { ok: false; message: string } {
  const parsed: ParsedInitArgs = {
    repo: process.cwd(),
    approved: false,
    dryRun: false,
    failClosedHook: false,
    undo: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, message: "opcore init: --repo requires a path" };
      parsed.repo = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) return { ok: false, message: "opcore init: --repo requires a path" };
      parsed.repo = value;
      continue;
    }
    if (arg === "--approve" || arg === "--yes") {
      parsed.approved = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--fail-closed-hook") {
      parsed.failClosedHook = true;
      continue;
    }
    if (arg === "--undo") {
      parsed.undo = true;
      continue;
    }
    return { ok: false, message: `opcore init: unsupported argument ${arg}` };
  }
  return { ok: true, args: parsed };
}

function planInit(
  repoRoot: string,
  requestedPath: string,
  git: boolean,
  options: ParsedInitArgs,
  context: InitContext
): PlannedInit {
  const agentFiles = detectAgentFiles(repoRoot);
  const config = createConfig(repoRoot, options.failClosedHook, context.scan, context.settings);
  const writes: PlannedWrite[] = [
    {
      kind: "write",
      path: configPath,
      content: `${JSON.stringify(config, null, 2)}\n`
    },
    ...agentFiles.map((path) => ({
      kind: "write" as const,
      path,
      content: upsertOpcoreBlock(readOptionalRepoFile(repoRoot, path))
    }))
  ];
  if (git) {
    const gitignore = readOptionalRepoFile(repoRoot, gitignorePath);
    if (!gitignoreIgnoresOpcore(gitignore ?? "")) {
      writes.push({
        kind: "append_managed_line",
        path: gitignorePath,
        line: opcoreIgnoreLine
      });
    }
  }
  if (options.failClosedHook) {
    writes.push({
      kind: "write",
      path: hookPath,
      content: failClosedHookContent(),
      executable: true
    });
  }
  const actions = createInitActions(agentFiles, options.failClosedHook, writes.some((write) => write.path === gitignorePath));
  return {
    writes,
    payload: {
      schemaVersion: 1,
      mode: "plan",
      approved: false,
      repo: {
        root: repoRoot,
        requestedPath
      },
      options: {
        failClosedHook: options.failClosedHook,
        dryRun: options.dryRun
      },
      agentFiles,
      actions,
      warnings: initWarnings(context.scan, git, options.failClosedHook),
      nextActions: initNextActions(options),
      undoAvailable: repoPathExists(repoRoot, undoPath),
      scan: context.scan,
      settings: context.settings,
      interaction: context.interaction,
      timings: context.timings
    }
  };
}

function appliedInitPayload(payload: OpcoreInitPlanPayload, repoRoot: string): OpcoreInitPlanPayload {
  return {
    ...payload,
    mode: "apply",
    approved: true,
    nextActions: appliedInitNextActions(payload),
    undoAvailable: repoPathExists(repoRoot, undoPath)
  };
}

function initNextActions(options: ParsedInitArgs): string[] {
  const actions = options.dryRun
    ? ["Run opcore init --approve to apply this plan."]
    : ["Review this plan, then run opcore init --approve to write repo setup."];
  if (options.failClosedHook) actions.push(failClosedHookManualInstallAction());
  return actions;
}

function appliedInitNextActions(payload: OpcoreInitPlanPayload): string[] {
  const actions = ["Run opcore init --undo --approve to restore or remove recorded setup files."];
  if (payload.options.failClosedHook) actions.push(failClosedHookManualInstallAction());
  return actions;
}

function failClosedHookManualInstallAction(): string {
  return `Manual install required before the fail-closed hook is active: ${failClosedHookActivationCommand}`;
}

function planUndo(repoRoot: string, requestedPath: string, options: ParsedInitArgs, context: InitContext): OpcoreInitPlanPayload {
  const metadata = readUndoMetadata(repoRoot);
  return {
    schemaVersion: 1,
    mode: "undo",
    approved: options.approved && !options.dryRun,
    repo: {
      root: repoRoot,
      requestedPath
    },
    options: {
      failClosedHook: options.failClosedHook,
      dryRun: options.dryRun
    },
    agentFiles: metadata.entries
      .map((entry) => entry.path)
      .filter((path) => AGENT_FILE_CANDIDATES.includes(path as (typeof AGENT_FILE_CANDIDATES)[number])),
    actions: metadata.entries.map((entry) => ({
      kind: entry.kind === "append_managed_line" ? "remove" : entry.existed ? "restore" : "remove",
      path: entry.path,
      summary: entry.kind === "append_managed_line"
        ? `Remove managed ${entry.line} gitignore entry from ${entry.path}.`
        : entry.existed
          ? `Restore ${entry.path} from Opcore init backup.`
          : `Remove ${entry.path} created by Opcore init.`,
      requiresApproval: !entry.path.startsWith(".opcore/"),
      outsideOpcore: !entry.path.startsWith(".opcore/")
    })),
    warnings: [],
    nextActions: options.approved && !options.dryRun
      ? ["Opcore init metadata was restored or removed; rerun opcore init to recreate setup."]
      : ["Run opcore init --undo --approve to restore or remove recorded setup files."],
    undoAvailable: true,
    scan: context.scan,
    settings: context.settings,
    interaction: context.interaction,
    timings: context.timings
  };
}

function appliedUndoPayload(payload: OpcoreInitPlanPayload, repoRoot: string): OpcoreInitPlanPayload {
  return {
    ...payload,
    approved: true,
    nextActions: ["Opcore init metadata was restored or removed; rerun opcore init to recreate setup."],
    undoAvailable: repoPathExists(repoRoot, undoPath)
  };
}

function applyInit(repoRoot: string, writes: readonly PlannedWrite[]): void {
  const previousMetadata = readUndoMetadataIfExists(repoRoot);
  const touchedPaths = uniqueStrings([
    ...(previousMetadata?.entries.map((entry) => entry.path) ?? []),
    ...writes.map((write) => write.path),
    undoPath
  ]);
  for (const path of touchedPaths) assertRepoMutationPath(repoRoot, path, "Opcore init target");
  const metadata: UndoMetadata = {
    schemaVersion: 1,
    kind: "opcore_init_undo",
    repoRoot,
    entries: touchedPaths.map((path) => {
      const previousEntry = previousMetadata?.entries.find((entry) => entry.path === path);
      if (previousEntry) return previousEntry;
      return priorEntry(repoRoot, path, writes.find((write) => write.path === path));
    })
  };
  for (const write of writes) writeRepoFile(repoRoot, write);
  writeRepoFile(repoRoot, {
    kind: "write",
    path: undoPath,
    content: `${JSON.stringify(metadata, null, 2)}\n`
  });
}

function applyUndo(repoRoot: string, payload: OpcoreInitPlanPayload): void {
  const metadata = readUndoMetadata(repoRoot);
  for (const entry of metadata.entries) assertRepoMutationPath(repoRoot, entry.path, "Opcore init undo target");
  for (const entry of metadata.entries.filter((entry) => entry.path !== undoPath)) restoreUndoEntry(repoRoot, entry);
  const undoEntry = metadata.entries.find((entry) => entry.path === undoPath);
  if (undoEntry) restoreUndoEntry(repoRoot, undoEntry);
  else rmSync(resolveRepoPath(repoRoot, undoPath), { force: true });
  removeEmptyOpcoreHookDir(repoRoot);
  void payload;
}

function createInitActions(agentFiles: readonly string[], failClosedHook: boolean, gitignoreWritePlanned: boolean): OpcoreInitAction[] {
  const actions: OpcoreInitAction[] = [
    {
      kind: "write",
      path: configPath,
      summary: "Write additive Opcore init config.",
      requiresApproval: false,
      outsideOpcore: false
    },
    ...agentFiles.map((path) => ({
      kind: "upsert_block" as const,
      path,
      summary: "Add or update delimited Opcore agent guidance.",
      requiresApproval: true,
      outsideOpcore: true
    }))
  ];
  if (gitignoreWritePlanned) {
    actions.push({
      kind: "write",
      path: gitignorePath,
      summary: "Append managed .opcore/ gitignore entry.",
      requiresApproval: true,
      outsideOpcore: true
    });
  }
  if (failClosedHook) {
    actions.push({
      kind: "create_hook",
      path: hookPath,
      summary: `Manual install required: create fail-closed pre-commit hook script; activate with \`${failClosedHookActivationCommand}\`.`,
      requiresApproval: false,
      outsideOpcore: false
    });
  }
  return actions;
}

function detectAgentFiles(repoRoot: string): string[] {
  const existing = AGENT_FILE_CANDIDATES.filter((path) => repoPathExists(repoRoot, path));
  for (const path of existing) assertExistingRepoPath(repoRoot, path, "Existing agent guidance file", "file");
  return existing.length > 0 ? [...existing] : ["AGENTS.md"];
}

function upsertOpcoreBlock(existing: string | undefined): string {
  const block = guidanceBlock();
  if (existing === undefined || existing.length === 0) return `${block}\n`;
  const begin = existing.indexOf(beginMarker);
  const end = existing.indexOf(endMarker);
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
    throw new Error("existing Opcore init guidance markers are unbalanced");
  }
  if (begin !== -1) {
    const replacementEnd = end + endMarker.length;
    return `${trimRightPreserve(existing.slice(0, begin))}\n\n${block}\n${trimLeftPreserve(existing.slice(replacementEnd))}`.replace(/\n{3,}/g, "\n\n");
  }
  return `${trimRightPreserve(existing)}\n\n${block}\n`;
}

function guidanceBlock(): string {
  return [
    beginMarker,
    "## Opcore",
    "",
    "- Run `opcore check --changed` before finalizing edits.",
    "- Preserve existing repo lint/test/CI/pre-commit guardrails.",
    "- Treat unsupported stacks and degraded tools honestly.",
    "- For Python repos, treat missing mypy/pyright/ruff/pytest as degraded coverage, not a pass.",
    "- Do not rely on ACE, Rox, CRG, CIX, or ASP host authority for direct Opcore.",
    endMarker
  ].join("\n");
}

function createConfig(
  repoRoot: string,
  failClosedHook: boolean,
  scan: OpcoreInitScanSummary,
  settings: OpcoreInitSettings
): Record<string, unknown> {
  const existing = readJsonObject(repoRoot, configPath);
  const existingHooks = isPlainObject(existing.hooks) ? existing.hooks : {};
  const existingGuidance = isPlainObject(existing.guidance) ? existing.guidance : {};
  const existingOnboarding = isPlainObject(existing.onboarding) ? existing.onboarding : {};
  const onboardingScan = isPlainObject(existingOnboarding.scan) ? existingOnboarding.scan : scan;
  const onboardingLanguages = Array.isArray(existingOnboarding.languages) ? existingOnboarding.languages : settings.languages;
  return {
    ...existing,
    schemaVersion: 1,
    kind: "opcore_init_config",
    onboarding: {
      ...existingOnboarding,
      scan: onboardingScan,
      languages: onboardingLanguages,
      timingPayload: true
    },
    guidance: {
      ...existingGuidance,
      checkCommand: "opcore check --changed",
      preserveExistingGuardrails: true,
      treatUnsupportedCoverageHonestly: true,
      directProductAuthority: "opcore"
    },
    hooks: {
      ...existingHooks,
      failClosedPreCommit: existingHooks.failClosedPreCommit === true || failClosedHook
    }
  };
}

function initWarnings(scan: OpcoreInitScanSummary, git: boolean, failClosedHook: boolean): string[] {
  const warnings: string[] = [];
  if (scan.unsupportedStacks.length > 0) {
    warnings.push(`Unsupported stacks: ${scan.unsupportedStacks.map((stack) => `${stack.language} (${stack.count})`).join(", ")}`);
  }
  if (scan.degradedRustTools.length > 0) {
    warnings.push(`Degraded validation tools: ${scan.degradedRustTools.map((tool) => tool.tool).join(", ")}`);
  }
  if (!git) {
    warnings.push("No Git repository detected; .opcore/ ignore entry not written.");
  }
  warnings.push("Do not weaken existing lint, test, CI, pre-commit, or agent guardrails.");
  warnings.push(
    failClosedHook
      ? `Fail-closed hook script is opt-in. Manual install required: ${failClosedHookActivationCommand}`
      : "Fail-closed hooks are opt-in and are not created unless --fail-closed-hook is approved."
  );
  return warnings;
}

function failClosedHookContent(): string {
  return [
    "#!/usr/bin/env sh",
    "# Manual install required.",
    "# This script is not active until installed.",
    `# Activation command: ${failClosedHookActivationCommand}`,
    "set -eu",
    "opcore check --changed",
    ""
  ].join("\n");
}

function priorEntry(repoRoot: string, path: string, write: PlannedWrite | undefined): UndoEntry {
  if (write?.kind === "append_managed_line") {
    const existing = readOptionalRepoFile(repoRoot, path);
    return {
      kind: "append_managed_line",
      path,
      existed: existing !== undefined,
      line: write.line,
      appended: appendManagedGitignoreLine(existing)
    };
  }
  if (!repoPathExists(repoRoot, path)) return { kind: "restore_file", path, existed: false };
  return {
    kind: "restore_file",
    path,
    existed: true,
    content: readFileSync(assertExistingRepoPath(repoRoot, path, "Existing Opcore init target", "file"), "utf8")
  };
}

function writeRepoFile(repoRoot: string, write: PlannedWrite): void {
  const absolute = assertRepoMutationPath(repoRoot, write.path, "Opcore init write target");
  mkdirSync(dirname(absolute), { recursive: true });
  if (write.kind === "append_managed_line") {
    const existing = readOptionalRepoFile(repoRoot, write.path);
    appendFileSync(absolute, appendManagedGitignoreLine(existing));
    return;
  }
  writeFileSync(absolute, write.content, "utf8");
  if (write.executable) {
    assertRepoMutationPath(repoRoot, write.path, "Opcore init chmod target");
    chmodSync(absolute, 0o755);
  }
}

function restoreUndoEntry(repoRoot: string, entry: UndoEntry): void {
  const absolute = assertRepoMutationPath(repoRoot, entry.path, "Opcore init undo target");
  if (entry.kind === "append_managed_line") {
    if (!repoPathExists(repoRoot, entry.path)) return;
    const removal = removeManagedGitignoreLine(readFileSync(absolute, "utf8"), entry);
    if (!removal.removed) return;
    if (!entry.existed && removal.content.length === 0) {
      rmSync(absolute, { force: true });
      return;
    }
    writeFileSync(absolute, removal.content, "utf8");
    return;
  }
  if (!entry.existed) {
    rmSync(absolute, { force: true });
    return;
  }
  if (entry.content === undefined) {
    throw new Error(`Undo entry for ${entry.path} is missing content`);
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, entry.content, "utf8");
}

function readUndoMetadata(repoRoot: string): UndoMetadata {
  const raw = readFileSync(assertExistingRepoPath(repoRoot, undoPath, "Opcore init undo metadata", "file"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1 || parsed.kind !== "opcore_init_undo" || !Array.isArray(parsed.entries)) {
    throw new Error(".opcore/init-undo.json is not valid Opcore init undo metadata");
  }
  if (typeof parsed.repoRoot !== "string" || resolve(parsed.repoRoot) !== resolve(repoRoot)) {
    throw new Error(".opcore/init-undo.json repoRoot does not match this repository");
  }
  const seenPaths = new Set<string>();
  const entries: UndoEntry[] = [];
  for (const entry of parsed.entries) {
    if (!isPlainObject(entry) || typeof entry.path !== "string" || typeof entry.existed !== "boolean") {
      throw new Error(".opcore/init-undo.json contains an invalid entry");
    }
    if (!allowedUndoPaths.has(entry.path)) {
      throw new Error(`.opcore/init-undo.json contains unsupported path: ${entry.path}`);
    }
    if (seenPaths.has(entry.path)) {
      throw new Error(`.opcore/init-undo.json contains duplicate path: ${entry.path}`);
    }
    seenPaths.add(entry.path);
    const kind = typeof entry.kind === "string" ? entry.kind : "restore_file";
    if (kind === "append_managed_line") {
      if (entry.path !== gitignorePath) {
        throw new Error(`.opcore/init-undo.json append-managed-line entry targets unsupported path: ${entry.path}`);
      }
      if (typeof entry.line !== "string" || entry.line !== opcoreIgnoreLine) {
        throw new Error(`.opcore/init-undo.json append-managed-line entry for ${entry.path} has invalid line`);
      }
      if (
        "appended" in entry &&
        entry.appended !== undefined &&
        entry.appended !== `${opcoreIgnoreLine}\n` &&
        entry.appended !== `\n${opcoreIgnoreLine}\n`
      ) {
        throw new Error(`.opcore/init-undo.json append-managed-line entry for ${entry.path} has invalid appended text`);
      }
      resolveRepoPath(repoRoot, entry.path);
      entries.push({
        kind: "append_managed_line",
        path: entry.path,
        existed: entry.existed,
        line: entry.line,
        ...(typeof entry.appended === "string" ? { appended: entry.appended } : {})
      });
      continue;
    }
    if (entry.path === gitignorePath) {
      throw new Error(".opcore/init-undo.json .gitignore entry must use managed-line undo metadata");
    }
    if (kind !== "restore_file") {
      throw new Error(`.opcore/init-undo.json contains unsupported entry kind: ${kind}`);
    }
    if (entry.existed && typeof entry.content !== "string") {
      throw new Error(`.opcore/init-undo.json restore entry for ${entry.path} is missing string content`);
    }
    if (!entry.existed && "content" in entry && entry.content !== undefined && typeof entry.content !== "string") {
      throw new Error(`.opcore/init-undo.json remove entry for ${entry.path} has invalid content`);
    }
    resolveRepoPath(repoRoot, entry.path);
    entries.push({
      kind: "restore_file",
      path: entry.path,
      existed: entry.existed,
      ...(typeof entry.content === "string" ? { content: entry.content } : {})
    });
  }
  return {
    schemaVersion: 1,
    kind: "opcore_init_undo",
    repoRoot: parsed.repoRoot,
    entries
  };
}

function readUndoMetadataIfExists(repoRoot: string): UndoMetadata | undefined {
  if (!repoPathExists(repoRoot, undoPath)) return undefined;
  return readUndoMetadata(repoRoot);
}

function readJsonObject(repoRoot: string, path: string): Record<string, unknown> {
  const content = readOptionalRepoFile(repoRoot, path);
  if (content === undefined) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!isPlainObject(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function readOptionalRepoFile(repoRoot: string, path: string): string | undefined {
  if (!repoPathExists(repoRoot, path)) return undefined;
  return readFileSync(assertExistingRepoPath(repoRoot, path, "Existing repo file", "file"), "utf8");
}

function gitignoreIgnoresOpcore(content: string): boolean {
  let ignored = false;
  for (const rawLine of content.split(/\r\n|\n|\r/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1).trim() : line;
    if (isOpcoreGitignorePattern(pattern)) {
      ignored = !negated;
    }
  }
  return ignored;
}

function isOpcoreGitignorePattern(pattern: string): boolean {
  return pattern === ".opcore" ||
    pattern === ".opcore/" ||
    pattern === "/.opcore" ||
    pattern === "/.opcore/" ||
    pattern === ".opcore/**" ||
    pattern === "/.opcore/**";
}

function appendManagedGitignoreLine(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) return `${opcoreIgnoreLine}\n`;
  return `${existing.endsWith("\n") || existing.endsWith("\r") ? "" : "\n"}${opcoreIgnoreLine}\n`;
}

function removeManagedGitignoreLine(current: string, entry: ManagedLineUndoEntry): { content: string; removed: boolean } {
  if (entry.appended !== undefined && current.endsWith(entry.appended)) {
    return { content: current.slice(0, -entry.appended.length), removed: true };
  }
  const chunks = current.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? [];
  const meaningfulChunks = chunks.filter((chunk) => chunk.length > 0);
  for (let index = 0; index < meaningfulChunks.length; index += 1) {
    const chunk = meaningfulChunks[index];
    const chunkLine = chunk.replace(/(?:\r\n|\n|\r)$/u, "");
    if (chunkLine === entry.line) {
      meaningfulChunks.splice(index, 1);
      return { content: meaningfulChunks.join(""), removed: true };
    }
  }
  return { content: current, removed: false };
}

function resolveRepoPath(repoRoot: string, path: string): string {
  if (path.length === 0 || path.includes("\0")) throw new Error(`Invalid repo path: ${path}`);
  const absolute = resolve(repoRoot, path);
  const normalized = relative(repoRoot, absolute);
  if (normalized === "" || normalized.startsWith("..") || normalized.split(sep).includes("..")) {
    throw new Error(`Repo-relative path escapes repository: ${path}`);
  }
  return absolute;
}

function assertRepoMutationPath(repoRoot: string, path: string, label: string): string {
  const absolute = resolveRepoPath(repoRoot, path);
  assertExistingAncestorInsideRepo(repoRoot, absolute, path, label);
  if (lstatIfExists(absolute)) assertExistingRepoPath(repoRoot, path, label, "file");
  return absolute;
}

function assertExistingRepoPath(repoRoot: string, path: string, label: string, expected: "file" | "directory"): string {
  const absolute = resolveRepoPath(repoRoot, path);
  assertExistingAncestorInsideRepo(repoRoot, absolute, path, label);
  return assertExistingAbsolutePath(repoRoot, absolute, path, label, expected);
}

function assertExistingAbsolutePath(
  repoRoot: string,
  absolute: string,
  displayPath: string,
  label: string,
  expected: "file" | "directory"
): string {
  const lstat = lstatIfExists(absolute);
  if (!lstat) throw new Error(`${label} does not exist: ${displayPath}`);
  if (lstat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${displayPath}`);
  let realPath: string;
  try {
    realPath = realpathSync(absolute);
  } catch (error) {
    throw new Error(`${label} symlink cannot be resolved for ${displayPath}: ${errorMessage(error)}`);
  }
  if (!isInsideRepo(repoRoot, realPath)) {
    throw new Error(`${label} resolves outside repository through a symlink: ${displayPath}`);
  }
  const stat = statSync(absolute);
  if (expected === "file" && !stat.isFile()) throw new Error(`${label} is not a file: ${displayPath}`);
  if (expected === "directory" && !stat.isDirectory()) throw new Error(`${label} is not a directory: ${displayPath}`);
  return absolute;
}

function assertExistingAncestorInsideRepo(repoRoot: string, absolutePath: string, path: string, label: string): void {
  const relativeParent = relative(resolve(repoRoot), dirname(absolutePath));
  if (relativeParent === "") return;
  if (relativeParent.startsWith("..") || isAbsolute(relativeParent)) {
    throw new Error(`${label} parent cannot be resolved inside repository: ${path}`);
  }

  let current = resolve(repoRoot);
  for (const segment of relativeParent.split(sep)) {
    if (!segment) continue;
    current = resolve(current, segment);
    if (!lstatIfExists(current)) return;
    assertExistingAbsolutePath(repoRoot, current, repoRelativePath(repoRoot, current), `${label} parent`, "directory");
  }
}

function repoPathExists(repoRoot: string, path: string): boolean {
  return lstatIfExists(resolveRepoPath(repoRoot, path)) !== undefined;
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function isInsideRepo(repoRoot: string, path: string): boolean {
  const normalized = relative(resolve(repoRoot), resolve(path));
  return normalized === "" || (!normalized.startsWith("..") && !isAbsolute(normalized));
}

function repoRelativePath(repoRoot: string, absolutePath: string): string {
  const normalized = relative(resolve(repoRoot), resolve(absolutePath));
  return normalized === "" ? "." : normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimRightPreserve(text: string): string {
  return text.replace(/\s+$/u, "");
}

function trimLeftPreserve(text: string): string {
  return text.replace(/^\s+/u, "");
}

function removeEmptyOpcoreHookDir(repoRoot: string): void {
  const hooksDir = resolveRepoPath(repoRoot, ".opcore/hooks");
  if (!lstatIfExists(hooksDir)) return;
  assertExistingRepoPath(repoRoot, ".opcore/hooks", "Opcore hooks directory", "directory");
  if (readdirSync(hooksDir).length === 0) {
    rmSync(hooksDir, { recursive: true, force: true });
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function formatInitPlan(payload: OpcoreInitPlanPayload, applied: boolean): string {
  const heading = payload.mode === "undo" ? "Undo:" : "Setup:";
  const actionLines = payload.actions.map((action) => `- ${action.kind} ${action.path}: ${action.summary}`);
  const approvalLine = payload.interaction.promptState === "requested"
    ? "Approval: awaiting TTY response."
    : payload.interaction.promptState === "declined"
      ? "Approval: declined; no files written."
      : applied
    ? "Approval: applied."
    : payload.mode === "undo"
      ? "Approval: required; rerun with --undo --approve to restore/remove recorded files."
      : "Approval: required; rerun with --approve to write this setup.";
  const languages = payload.scan.languages.length === 0
    ? "none"
    : payload.scan.languages.map((entry) => `${entry.language} ${entry.files}`).join(", ");
  const unsupported = payload.scan.unsupportedStacks.length === 0
    ? "none"
    : payload.scan.unsupportedStacks.map((stack) => `${stack.language} ${stack.count}`).join(", ");
  const degradedValidationTools = payload.scan.degradedRustTools.length === 0
    ? "none"
    : payload.scan.degradedRustTools.map((tool) => `${tool.adapter}:${tool.tool}`).join(", ");
  const pythonDependencyManagers = payload.settings.python?.dependencyManagers.length
    ? payload.settings.python.dependencyManagers.map((manager) => `${manager.kind}:${manager.path}`).join(", ")
    : "none";
  const pythonVirtualEnvironments = payload.settings.python?.virtualEnvironments.length
    ? payload.settings.python.virtualEnvironments.map((environment) => environment.path).join(", ")
    : "none";
  return [
    "Coverage:",
    `  files=${payload.scan.totalFiles}`,
    `  graph-supported=${payload.scan.graphSupportedFiles}`,
    `  validation-supported=${payload.scan.validationSupportedFiles}`,
    `  validation-retained=${payload.scan.validationRetainedFiles}`,
    `  unsupported=${unsupported}`,
    `  languages=${languages}`,
    `  degraded-validation-tools=${degradedValidationTools}`,
    `  python-dependency-managers=${pythonDependencyManagers}`,
    `  python-virtualenvs=${pythonVirtualEnvironments}`,
    "Findings:",
    `  diagnostics=${payload.scan.diagnosticCount}`,
    `  validation=${payload.scan.validationStatus}`,
    `  failed-checks=${payload.scan.failedChecks.length === 0 ? "none" : payload.scan.failedChecks.join(", ")}`,
    `  graph=${payload.scan.graphState}`,
    `  activation=${payload.scan.activationLevel}`,
    heading,
    `Repo: ${payload.repo.root}`,
    `Mode: ${payload.mode}`,
    `Approved: ${payload.approved ? "yes" : "no"}`,
    "Actions:",
    ...actionLines,
    approvalLine,
    "Timing:",
    `  first-output-ms=${payload.timings.firstOutputMs} scan-ms=${payload.timings.scanMs} total-ms=${payload.timings.totalMs}`
  ].join("\n");
}

function formatInteractiveOutcome(payload: OpcoreInitPlanPayload): string {
  return payload.approved
    ? "opcore init applied\nApproval: applied."
    : "opcore init declined\nApproval: declined; no files written.";
}

function opcoreInitHelpMessage(): string {
  return [
    "opcore init [--repo <path>] [--approve] [--json]",
    "opcore init --undo --approve [--repo <path>] [--json]"
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
