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
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { opcoreAgentGateHookScriptContent } from "./agent-gate.js";
import {
  createInstallWizardRenderer,
  type InstallWizardChoices,
  type InstallWizardFileRow,
  type InstallWizardGroup,
  type InstallWizardGroupKey,
  type InstallWizardPlanView,
  type InstallWizardRenderer
} from "./install-wizard.js";
import { createOpcoreScanAnalysis, type OpcoreScanAnalysis } from "./scan.js";
import { failedValidationCheckIds } from "./scan-presentation.js";
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
const agentGateHookPath = ".opcore/hooks/opcore-agent-gate.mjs";
const repoAgentSkillPath = ".agents/skills/opcore/SKILL.md";
const claudeAgentSkillPath = ".claude/skills/opcore/SKILL.md";
const agentSkillPaths = [repoAgentSkillPath, claudeAgentSkillPath] as const;
const claudeSettingsPath = ".claude/settings.json";
const codexHooksPath = ".codex/hooks.json";
const activePreCommitHookPath = ".git/hooks/pre-commit";
const failClosedHookActivationCommand = "cp .opcore/hooks/pre-commit-opcore-check.sh .git/hooks/pre-commit";
const gitignorePath = ".gitignore";
const opcoreIgnoreLine = ".opcore/";
const defaultInitProgressIntervalMs = 5000;
type OpcoreSetupCommand = "init" | "install" | "uninstall";
const allowedUndoPaths = new Set<string>([
  configPath,
  undoPath,
  hookPath,
  agentGateHookPath,
  repoAgentSkillPath,
  claudeAgentSkillPath,
  claudeSettingsPath,
  codexHooksPath,
  activePreCommitHookPath,
  gitignorePath,
  ...AGENT_FILE_CANDIDATES
]);
const globalUndoPath = ".opcore/init-undo.json";
const allowedGlobalUndoPaths = new Set<string>([
  globalUndoPath,
  agentGateHookPath,
  repoAgentSkillPath,
  claudeAgentSkillPath,
  claudeSettingsPath,
  codexHooksPath
]);
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
  command: OpcoreSetupCommand;
  repo: string;
  repoExplicit: boolean;
  scope: "repo" | "global";
  scopeExplicit: boolean;
  approved: boolean;
  dryRun: boolean;
  failClosedHook: boolean;
  agentSkill: boolean;
  writeGateHooks: boolean;
  activePreCommitHook: boolean;
  undo: boolean;
}

export interface OpcoreInitRuntime {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  stderrColor?: boolean;
  stderrTrueColor?: boolean;
  homeDir?: string;
  writeStderr?: (text: string) => void;
  scanAnalysis?: (resolution: RepoResolution) => Promise<OpcoreScanAnalysis>;
  initProgressIntervalMs?: number;
  readLine?: (prompt: string) => Promise<string>;
  readKey?: () => Promise<string>;
  initWizardMotion?: boolean;
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
  targetScope: "repo" | "global";
  content: string;
  executable?: boolean;
}

interface PlannedManagedLineAppend {
  kind: "append_managed_line";
  path: string;
  targetScope: "repo";
  line: string;
}

interface UndoMetadata {
  schemaVersion: 1;
  kind: "opcore_init_undo" | "opcore_global_init_undo";
  repoRoot?: string;
  homeRoot?: string;
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
  return routeOpcoreSetup(argv, parsed, runtime, "init");
}

export async function routeOpcoreInstall(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime = {}
): Promise<CommandRouterResult> {
  return routeOpcoreSetup(argv, parsed, runtime, "install");
}

export async function routeOpcoreUninstall(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime = {}
): Promise<CommandRouterResult> {
  return routeOpcoreSetup(argv, parsed, runtime, "uninstall");
}

async function routeOpcoreSetup(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  runtime: OpcoreInitRuntime,
  command: OpcoreSetupCommand
): Promise<CommandRouterResult> {
  const rest = parsed.args.slice(1);
  if (rest.some((arg) => helpArgs.has(arg))) {
    return createInitRouterResult(argv, parsed.json, "ok", opcoreSetupHelpMessage(command), ["opcore", command, "help"]);
  }

  const parsedInit = parseOpcoreInitArgs(rest, command);
  if (!parsedInit.ok) {
    return createInitRouterResult(argv, parsed.json, "error", parsedInit.message);
  }
  const resolution = resolveRepo(parsedInit.args.repo, `opcore ${command}`);
  if (!resolution.ok) {
    return createInitRouterResult(argv, parsed.json, "error", resolution.message);
  }

  const wizard = createInstallWizard(parsed.json, parsedInit.args, runtime, command);
  try {
    const timing: TimingState = {
      startedAt: nowMs(),
      scanMs: 0,
      planMs: 0,
      promptMs: 0,
      applyMs: 0
    };
    const scanStartedAt = nowMs();
    const progress = wizard
      ? startWizardScanProgress(wizard, runtime, repoDisplayLabel(resolution.resolution.root, initHomeRoot(runtime)))
      : startInitScanProgress(parsed.json, runtime, command);
    const scanAnalysis = runtime.scanAnalysis ?? createOpcoreScanAnalysis;
    let analysis: OpcoreScanAnalysis;
    try {
      analysis = await scanAnalysis(resolution.resolution);
      timing.scanMs = elapsedMs(scanStartedAt);
      progress?.complete(timing.scanMs, analysis.repoState.coverage.totalFiles);
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
        initHomeRoot(runtime),
        parsedInit.args,
        context,
        timing,
        command
      );
    }

    if (wizard) {
      return await runInstallWizardFlow(
        argv,
        resolution.resolution.root,
        resolution.resolution.requestedPath,
        resolution.resolution.git,
        initHomeRoot(runtime),
        parsedInit.args,
        context,
        timing,
        wizard,
        command
      );
    }

    return await routeOpcoreInitPlanOrApply(
      argv,
      parsed.json,
      resolution.resolution.root,
      resolution.resolution.requestedPath,
      resolution.resolution.git,
      initHomeRoot(runtime),
      parsedInit.args,
      context,
      timing,
      runtime,
      command
    );
  } catch (error) {
    return createInitRouterResult(argv, parsed.json, "error", `opcore ${command} failed: ${errorMessage(error)}`);
  } finally {
    wizard?.showCursor();
  }
}

function createInstallWizard(
  json: boolean,
  options: ParsedInitArgs,
  runtime: OpcoreInitRuntime,
  command: OpcoreSetupCommand
): InstallWizardRenderer | undefined {
  if (command !== "install" || json || options.approved || options.dryRun || options.undo) return undefined;
  if (!isInteractiveRuntime(runtime) || runtime.stderrIsTTY !== true) return undefined;
  if (typeof runtime.readKey !== "function" || typeof runtime.writeStderr !== "function") return undefined;
  const writeStderr = runtime.writeStderr;
  const readKey = runtime.readKey;
  return createInstallWizardRenderer(
    {
      write: (text) => writeProgress(writeStderr, text),
      readKey,
      color: runtime.stderrColor === true,
      motion: runtime.initWizardMotion !== false
    },
    runtime.stderrTrueColor === true
  );
}

function startWizardScanProgress(
  wizard: InstallWizardRenderer,
  runtime: OpcoreInitRuntime,
  repoLabel: string
): { complete(scanMs: number, totalFiles?: number): void; fail(scanMs: number): void } {
  wizard.hideCursor();
  wizard.header(repoLabel);
  const startedAt = nowMs();
  let finished = false;
  let frame = 0;
  wizard.scanFrame(frame, 0);
  const intervalMs = runtime.initWizardMotion === false ? 0 : 120;
  const timer = intervalMs > 0
    ? (setInterval(() => {
      if (finished) return;
      frame += 1;
      wizard.scanFrame(frame, elapsedMs(startedAt));
    }, intervalMs) as ReturnType<typeof setInterval> & { unref?: () => void })
    : undefined;
  timer?.unref?.();
  return {
    complete: (scanMs: number, totalFiles?: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      wizard.scanDone(scanMs, totalFiles);
    },
    fail: (scanMs: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      wizard.scanFailed(scanMs);
    }
  };
}

function repoDisplayLabel(root: string, homeRoot: string): string {
  if (root === homeRoot) return "~";
  return root.startsWith(`${homeRoot}${sep}`) ? `~${root.slice(homeRoot.length)}` : root;
}

function routeOpcoreInitUndo(
  argv: readonly string[],
  json: boolean,
  repoRoot: string,
  requestedPath: string,
  homeRoot: string,
  options: ParsedInitArgs,
  context: InitContext,
  timing: TimingState,
  command: OpcoreSetupCommand
): CommandRouterResult {
  const planStartedAt = nowMs();
  const undo = planUndo(repoRoot, requestedPath, homeRoot, options, context);
  timing.planMs = elapsedMs(planStartedAt);
  const approved = options.approved && !options.dryRun;
  if (approved) {
    const applyStartedAt = nowMs();
    applyUndo(scopeRoot(repoRoot, homeRoot, options.scope), options.scope, undo);
    timing.applyMs = elapsedMs(applyStartedAt);
  }
  const payload = withContext(
    approved ? appliedUndoPayload(undo, scopeRoot(repoRoot, homeRoot, options.scope), options.scope, command) : undo,
    context,
    timing
  );
  return createInitRouterResult(argv, json, "ok", formatSetupPlan(payload, approved, command), ["opcore", command], payload);
}

async function routeOpcoreInitPlanOrApply(
  argv: readonly string[],
  json: boolean,
  repoRoot: string,
  requestedPath: string,
  git: boolean,
  homeRoot: string,
  options: ParsedInitArgs,
  context: InitContext,
  timing: TimingState,
  runtime: OpcoreInitRuntime,
  command: OpcoreSetupCommand
): Promise<CommandRouterResult> {
  if (shouldPromptForScope(json, options, git, runtime)) {
    const promptStartedAt = nowMs();
    const scopeAnswer = await runtime.readLine("Install the Opcore write gate for THIS repo, or GLOBALLY for all repos? [repo/global] ");
    timing.promptMs += elapsedMs(promptStartedAt);
    options = {
      ...options,
      scope: parseScopeAnswer(scopeAnswer),
      scopeExplicit: true
    };
  }
  const planStartedAt = nowMs();
  const planned = planInit(repoRoot, requestedPath, git, homeRoot, options, context);
  timing.planMs = elapsedMs(planStartedAt);
  let payload = withContext(planned.payload, context, timing);
  let approved = options.approved && !options.dryRun;
  let prompted = false;

  if (shouldPromptForApproval(json, options, runtime)) {
    prompted = true;
    context.interaction = { tty: true, promptState: "requested" };
    payload = withContext(payload, context, timing);
    const promptStartedAt = nowMs();
    const answer = await runtime.readLine(`${formatSetupPlan(payload, false, command)}\nApply setup? ${approvalPromptSuffix(command)} `);
    timing.promptMs += elapsedMs(promptStartedAt);
    if (isApprovedAnswer(answer, command)) {
      approved = true;
      context.interaction = { tty: true, promptState: "approved" };
    } else {
      context.interaction = { tty: true, promptState: "declined" };
      payload = {
        ...payload,
        nextActions: [`No files written. Rerun opcore ${command === "uninstall" ? "uninstall" : command} when ready.`]
      };
    }
  }

  if (approved) {
    const applyStartedAt = nowMs();
    applyInit(scopeRoot(repoRoot, homeRoot, options.scope), options.scope, planned.writes);
    timing.applyMs = elapsedMs(applyStartedAt);
  }
  payload = approved ? appliedInitPayload(payload, scopeRoot(repoRoot, homeRoot, options.scope), options.scope, command) : payload;
  payload = withContext(payload, context, timing);
  const message = prompted ? formatInteractiveOutcome(payload, command) : formatSetupPlan(payload, approved, command);
  return createInitRouterResult(argv, json, "ok", message, ["opcore", command], payload);
}

async function runInstallWizardFlow(
  argv: readonly string[],
  repoRoot: string,
  requestedPath: string,
  git: boolean,
  homeRoot: string,
  options: ParsedInitArgs,
  context: InitContext,
  timing: TimingState,
  wizard: InstallWizardRenderer,
  command: OpcoreSetupCommand
): Promise<CommandRouterResult> {
  await wizard.coverage(context.scan);

  if (git && !options.scopeExplicit && !options.repoExplicit) {
    const promptStartedAt = nowMs();
    const scope = await wizard.selectScope(repoDisplayLabel(repoRoot, homeRoot));
    timing.promptMs += elapsedMs(promptStartedAt);
    if (scope === null) {
      return declinedInstallWizardResult(argv, repoRoot, requestedPath, git, homeRoot, options, context, timing, wizard, command);
    }
    options = { ...options, scope, scopeExplicit: true };
  }

  const planFor = createInstallPlanCache(repoRoot, requestedPath, git, homeRoot, options, context);
  const probe = planFor({ agentSkill: true, writeGateHooks: true, activePreCommitHook: true });
  const model = {
    groups: createInstallWizardGroups(options.scope, git, repoRoot, probe.payload.actions),
    initial: {
      agentSkill: options.agentSkill,
      writeGateHooks: options.writeGateHooks,
      activePreCommitHook: options.activePreCommitHook
    },
    planView: (choices: InstallWizardChoices) => installWizardPlanView(planFor(choices).payload.actions)
  };
  context.interaction = { tty: true, promptState: "requested" };
  const promptStartedAt = nowMs();
  const outcome = await wizard.planApproval(model);
  timing.promptMs += elapsedMs(promptStartedAt);
  options = { ...options, ...outcome.choices };
  if (!outcome.confirmed) {
    return declinedInstallWizardResult(argv, repoRoot, requestedPath, git, homeRoot, options, context, timing, wizard, command);
  }

  context.interaction = { tty: true, promptState: "approved" };
  const planStartedAt = nowMs();
  const planned = planInit(repoRoot, requestedPath, git, homeRoot, options, context);
  timing.planMs += elapsedMs(planStartedAt);
  const root = scopeRoot(repoRoot, homeRoot, options.scope);
  const applyStartedAt = nowMs();
  applyInit(root, options.scope, planned.writes);
  timing.applyMs = elapsedMs(applyStartedAt);
  await wizard.applyCascade(planned.payload.actions.map((action) => action.path), timing.applyMs);
  const undoCommand = options.scope === "global" ? "opcore uninstall --global --yes" : "opcore uninstall";
  wizard.doneCard(planned.payload.actions.length, options.scope, undoCommand);
  const payload = withContext(appliedInitPayload(planned.payload, root, options.scope, command), context, timing);
  return createInitRouterResult(argv, false, "ok", `opcore ${command} applied`, ["opcore", command], payload);
}

function declinedInstallWizardResult(
  argv: readonly string[],
  repoRoot: string,
  requestedPath: string,
  git: boolean,
  homeRoot: string,
  options: ParsedInitArgs,
  context: InitContext,
  timing: TimingState,
  wizard: InstallWizardRenderer,
  command: OpcoreSetupCommand
): CommandRouterResult {
  wizard.cancelled();
  context.interaction = { tty: true, promptState: "declined" };
  const planStartedAt = nowMs();
  const planned = planInit(repoRoot, requestedPath, git, homeRoot, options, context);
  timing.planMs += elapsedMs(planStartedAt);
  const payload: OpcoreInitPlanPayload = {
    ...withContext(planned.payload, context, timing),
    nextActions: [`No files written. Rerun opcore ${command} when ready.`]
  };
  return createInitRouterResult(argv, false, "ok", `opcore ${command} declined`, ["opcore", command], payload);
}

function createInstallPlanCache(
  repoRoot: string,
  requestedPath: string,
  git: boolean,
  homeRoot: string,
  options: ParsedInitArgs,
  context: InitContext
): (choices: InstallWizardChoices) => PlannedInit {
  const cache = new Map<string, PlannedInit>();
  return (choices) => {
    const key = `${choices.agentSkill}|${choices.writeGateHooks}|${choices.activePreCommitHook}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const planned = planInit(repoRoot, requestedPath, git, homeRoot, { ...options, ...choices }, context);
    cache.set(key, planned);
    return planned;
  };
}

function createInstallWizardGroups(
  scope: ParsedInitArgs["scope"],
  git: boolean,
  repoRoot: string,
  probeActions: readonly OpcoreInitAction[]
): InstallWizardGroup[] {
  const groups: InstallWizardGroup[] = [
    { key: "skill", label: "agent skill", available: true },
    { key: "hooks", label: "write-gate hooks", available: true }
  ];
  if (scope === "global") return groups;
  const preCommitPlanned = probeActions.some((action) => action.path === activePreCommitHookPath);
  if (preCommitPlanned) {
    groups.push({ key: "precommit", label: "pre-commit hook", available: true });
  } else {
    groups.push({
      key: "precommit",
      label: "pre-commit hook",
      available: false,
      unavailableNote: !git
        ? "no git repo"
        : isLinkedGitWorktree(repoRoot)
          ? "linked worktree — skipped"
          : "existing hook kept"
    });
  }
  return groups;
}

function installWizardPlanView(actions: readonly OpcoreInitAction[]): InstallWizardPlanView {
  const baseRows: InstallWizardFileRow[] = [];
  const groupRows: Record<InstallWizardGroupKey, InstallWizardFileRow[]> = { skill: [], hooks: [], precommit: [] };
  for (const action of actions) {
    const row: InstallWizardFileRow = {
      path: action.path,
      mark: action.kind === "upsert_block" || action.kind === "wire_harness"
        ? "~"
        : action.path === gitignorePath
          ? "»"
          : "+",
      outsideOpcore: action.outsideOpcore
    };
    const group = installWizardGroupForPath(action.path);
    if (group) groupRows[group].push(row);
    else baseRows.push(row);
  }
  return {
    baseRows,
    groupRows,
    totalWrites: actions.length,
    outsideWrites: actions.filter((action) => action.outsideOpcore).length
  };
}

function installWizardGroupForPath(path: string): InstallWizardGroupKey | undefined {
  if (path.endsWith("skills/opcore/SKILL.md")) return "skill";
  if (path.endsWith(agentGateHookPath) || path.endsWith(claudeSettingsPath) || path.endsWith(codexHooksPath)) return "hooks";
  if (path.endsWith(activePreCommitHookPath)) return "precommit";
  return undefined;
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
  const failedChecks = failedValidationCheckIds(validationResult);
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

function shouldPromptForScope(
  json: boolean,
  options: ParsedInitArgs,
  git: boolean,
  runtime: OpcoreInitRuntime
): runtime is OpcoreInitRuntime & { readLine: (prompt: string) => Promise<string> } {
  return (
    git &&
    !json &&
    !options.approved &&
    !options.dryRun &&
    !options.undo &&
    !options.scopeExplicit &&
    !options.repoExplicit &&
    isInteractiveRuntime(runtime) &&
    typeof runtime.readLine === "function"
  );
}

function parseScopeAnswer(answer: string | undefined): ParsedInitArgs["scope"] {
  const normalized = (answer ?? "").trim().toLowerCase();
  return normalized === "g" || normalized === "global" ? "global" : "repo";
}

function initHomeRoot(runtime: OpcoreInitRuntime): string {
  return realpathSync(resolve(runtime.homeDir ?? homedir()));
}

function scopeRoot(repoRoot: string, homeRoot: string, scope: ParsedInitArgs["scope"]): string {
  return scope === "global" ? homeRoot : repoRoot;
}

function isInteractiveRuntime(runtime: OpcoreInitRuntime): boolean {
  return runtime.stdinIsTTY === true && runtime.stdoutIsTTY === true;
}

function isExplicitYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function isApprovedAnswer(answer: string | undefined, command: OpcoreSetupCommand): boolean {
  const normalized = (answer ?? "").trim().toLowerCase();
  if (command === "install") return normalized === "" || normalized === "y" || normalized === "yes";
  return isExplicitYes(answer ?? "");
}

function approvalPromptSuffix(command: OpcoreSetupCommand): string {
  return command === "install" ? "[Y/n]" : "[y/N]";
}

function startInitScanProgress(
  json: boolean,
  runtime: OpcoreInitRuntime,
  command: OpcoreSetupCommand
): { complete(scanMs: number, totalFiles?: number): void; fail(scanMs: number): void } | undefined {
  if (json || runtime.stderrIsTTY !== true || typeof runtime.writeStderr !== "function") return undefined;
  const startedAt = nowMs();
  const intervalMs = normalizeProgressIntervalMs(runtime.initProgressIntervalMs);
  let finished = false;
  const write = (text: string) => writeProgress(runtime.writeStderr, text);
  const writeProgressLine = (text: string) => write(`\r\x1b[2K${text}`);
  write(`Opcore ${command}: scanning repository before setup...`);
  const timer = setInterval(() => {
    if (finished) return;
    const elapsedSeconds = Math.max(1, Math.floor(elapsedMs(startedAt) / 1000));
    writeProgressLine(`Opcore ${command}: still scanning repository before setup (${elapsedSeconds}s elapsed)...`);
  }, intervalMs) as ReturnType<typeof setInterval> & { unref?: () => void };
  timer.unref?.();
  return {
    complete: (scanMs: number) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      writeProgressLine(`Opcore ${command}: scan complete in ${scanMs}ms.\n`);
    },
    fail: (scanMs: number) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      writeProgressLine(`Opcore ${command}: scan failed after ${scanMs}ms.\n`);
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

function parseOpcoreInitArgs(
  args: readonly string[],
  command: OpcoreSetupCommand
): { ok: true; args: ParsedInitArgs } | { ok: false; message: string } {
  const parsed: ParsedInitArgs = {
    command,
    repo: process.cwd(),
    repoExplicit: false,
    scope: "repo",
    scopeExplicit: false,
    approved: false,
    dryRun: false,
    failClosedHook: false,
    agentSkill: command === "install",
    writeGateHooks: true,
    activePreCommitHook: command === "install",
    undo: command === "uninstall"
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, message: `opcore ${command}: --repo requires a path` };
      parsed.repo = value;
      parsed.repoExplicit = true;
      parsed.scope = "repo";
      parsed.scopeExplicit = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) return { ok: false, message: `opcore ${command}: --repo requires a path` };
      parsed.repo = value;
      parsed.repoExplicit = true;
      parsed.scope = "repo";
      parsed.scopeExplicit = true;
      continue;
    }
    if (arg === "--global") {
      parsed.scope = "global";
      parsed.scopeExplicit = true;
      continue;
    }
    if (arg === "--local") {
      parsed.scope = "repo";
      parsed.scopeExplicit = true;
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
    if (arg === "--no-pre-commit" && command === "install") {
      parsed.activePreCommitHook = false;
      continue;
    }
    if (arg === "--no-skill" && command === "install") {
      parsed.agentSkill = false;
      continue;
    }
    if (arg === "--undo" && command !== "install") {
      parsed.undo = true;
      continue;
    }
    return { ok: false, message: `opcore ${command}: unsupported argument ${arg}` };
  }
  return { ok: true, args: parsed };
}

function planInit(
  repoRoot: string,
  requestedPath: string,
  git: boolean,
  homeRoot: string,
  options: ParsedInitArgs,
  context: InitContext
): PlannedInit {
  if (options.scope === "global") return planGlobalInit(repoRoot, requestedPath, homeRoot, options, context);
  const agentFiles = detectAgentFiles(repoRoot);
  const linkedGitWorktree = git && isLinkedGitWorktree(repoRoot);
  const activePreCommitWritePlanned = options.activePreCommitHook &&
    git &&
    !linkedGitWorktree &&
    !repoPathExists(repoRoot, activePreCommitHookPath);
  const config = createConfig(
    repoRoot,
    options.failClosedHook,
    activePreCommitWritePlanned,
    options.writeGateHooks,
    context.scan,
    context.settings
  );
  const writes: PlannedWrite[] = [
    {
      kind: "write",
      path: configPath,
      targetScope: "repo",
      content: `${JSON.stringify(config, null, 2)}\n`
    },
    ...agentFiles.map((path) => ({
      kind: "write" as const,
      path,
      targetScope: "repo" as const,
      content: upsertOpcoreBlock(readOptionalRepoFile(repoRoot, path))
    }))
  ];
  if (options.writeGateHooks) {
    writes.push(
      {
        kind: "write",
        path: agentGateHookPath,
        targetScope: "repo",
        content: opcoreAgentGateHookScriptContent(),
        executable: true
      },
      {
        kind: "write",
        path: claudeSettingsPath,
        targetScope: "repo",
        content: `${JSON.stringify(mergeClaudeSettings(readJsonObjectIfExists(repoRoot, claudeSettingsPath), "repo"), null, 2)}\n`
      },
      {
        kind: "write",
        path: codexHooksPath,
        targetScope: "repo",
        content: `${JSON.stringify(mergeCodexHooks(readJsonObjectIfExists(repoRoot, codexHooksPath), "repo"), null, 2)}\n`
      }
    );
  }
  if (options.agentSkill) {
    writes.push(...agentSkillPaths.map((path) => ({
      kind: "write" as const,
      path,
      targetScope: "repo" as const,
      content: opcoreAgentSkillContent()
    })));
  }
  if (git) {
    const gitignore = readOptionalRepoFile(repoRoot, gitignorePath);
    if (!gitignoreIgnoresOpcore(gitignore ?? "")) {
      writes.push({
        kind: "append_managed_line",
        path: gitignorePath,
        targetScope: "repo",
        line: opcoreIgnoreLine
      });
    }
    if (activePreCommitWritePlanned) {
      writes.push({
        kind: "write",
        path: activePreCommitHookPath,
        targetScope: "repo",
        content: activePreCommitHookContent(),
        executable: true
      });
    }
  }
  if (options.failClosedHook) {
    writes.push({
      kind: "write",
      path: hookPath,
      targetScope: "repo",
      content: failClosedHookContent(),
      executable: true
    });
  }
  const actions = createInitActions(
    options.scope,
    agentFiles,
    options,
    writes.some((write) => write.path === gitignorePath),
    activePreCommitWritePlanned
  );
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
        scope: options.scope,
        failClosedHook: options.failClosedHook,
        dryRun: options.dryRun
      },
      agentFiles,
      actions,
      warnings: initWarnings(
        context.scan,
        git,
        options.failClosedHook,
        options.scope,
        activePreCommitWritePlanned,
        options.activePreCommitHook && git,
        linkedGitWorktree
      ),
      nextActions: initNextActions(options),
      undoAvailable: repoPathExists(repoRoot, undoPath),
      scan: context.scan,
      settings: context.settings,
      interaction: context.interaction,
      timings: context.timings
    }
  };
}

function planGlobalInit(
  repoRoot: string,
  requestedPath: string,
  homeRoot: string,
  options: ParsedInitArgs,
  context: InitContext
): PlannedInit {
  const writes: PlannedWrite[] = [
    ...(options.writeGateHooks
      ? [{
        kind: "write" as const,
        path: agentGateHookPath,
        targetScope: "global" as const,
        content: opcoreAgentGateHookScriptContent(),
        executable: true
      }]
      : []),
    ...(options.agentSkill ? agentSkillPaths.map((path) => ({
      kind: "write" as const,
      path,
      targetScope: "global" as const,
      content: opcoreAgentSkillContent()
    })) : []),
    ...(options.writeGateHooks
      ? [
        {
          kind: "write" as const,
          path: claudeSettingsPath,
          targetScope: "global" as const,
          content: `${JSON.stringify(mergeClaudeSettings(readJsonObjectIfExists(homeRoot, claudeSettingsPath), "global"), null, 2)}\n`
        },
        {
          kind: "write" as const,
          path: codexHooksPath,
          targetScope: "global" as const,
          content: `${JSON.stringify(mergeCodexHooks(readJsonObjectIfExists(homeRoot, codexHooksPath), "global"), null, 2)}\n`
        }
      ]
      : [])
  ];
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
        scope: options.scope,
        failClosedHook: options.failClosedHook,
        dryRun: options.dryRun
      },
      agentFiles: [],
      actions: createInitActions(options.scope, [], options, false, false),
      warnings: initWarnings(context.scan, true, false, options.scope, false, false, false),
      nextActions: initNextActions(options),
      undoAvailable: repoPathExists(homeRoot, globalUndoPath),
      scan: context.scan,
      settings: context.settings,
      interaction: context.interaction,
      timings: context.timings
    }
  };
}

function appliedInitPayload(
  payload: OpcoreInitPlanPayload,
  root: string,
  scope: ParsedInitArgs["scope"],
  command: OpcoreSetupCommand
): OpcoreInitPlanPayload {
  return {
    ...payload,
    mode: "apply",
    approved: true,
    nextActions: appliedInitNextActions(payload, command),
    undoAvailable: repoPathExists(root, undoPathForScope(scope))
  };
}

function initNextActions(options: ParsedInitArgs): string[] {
  const approveFlag = options.command === "install" ? "--yes" : "--approve";
  const scopedCommand = options.scope === "global"
    ? `opcore ${options.command} --global ${approveFlag}`
    : `opcore ${options.command} ${approveFlag}`;
  const actions = options.dryRun
    ? [`Run ${scopedCommand} to apply this plan.`]
    : [`Review this plan, then run ${scopedCommand} to write setup.`];
  if (options.scope === "repo") {
    actions.push("Claude Code and Codex write-gate hooks are installed by Opcore setup; review Codex project hook trust with /hooks if Codex asks.");
  } else {
    actions.push("Global Claude Code and Codex write-gate hooks are installed by Opcore setup; review Codex hook trust with /hooks if Codex asks.");
  }
  if (options.failClosedHook) actions.push(failClosedHookManualInstallAction());
  return actions;
}

function appliedInitNextActions(payload: OpcoreInitPlanPayload, command: OpcoreSetupCommand): string[] {
  const undoCommand = command === "install"
    ? payload.options.scope === "global" ? "opcore uninstall --global --yes" : "opcore uninstall --yes"
    : payload.options.scope === "global" ? "opcore init --global --undo --approve" : "opcore init --undo --approve";
  const actions = [`Run ${undoCommand} to restore or remove recorded setup files.`];
  if (payload.options.scope === "repo") {
    actions.push("Claude Code write calls are blocked on non-ok receipts. Codex uses a PreToolUse guardrail and may require hook trust review.");
  } else {
    actions.push("Global Claude Code write calls are blocked on non-ok receipts. Codex uses a PreToolUse guardrail and may require hook trust review.");
  }
  if (payload.options.failClosedHook) actions.push(failClosedHookManualInstallAction());
  return actions;
}

function failClosedHookManualInstallAction(): string {
  return `Manual install required before the fail-closed hook is active: ${failClosedHookActivationCommand}`;
}

function planUndo(
  repoRoot: string,
  requestedPath: string,
  homeRoot: string,
  options: ParsedInitArgs,
  context: InitContext
): OpcoreInitPlanPayload {
  const root = scopeRoot(repoRoot, homeRoot, options.scope);
  const metadata = readUndoMetadata(root, options.scope);
  return {
    schemaVersion: 1,
    mode: "undo",
    approved: options.approved && !options.dryRun,
    repo: {
      root: repoRoot,
      requestedPath
    },
    options: {
      scope: options.scope,
      failClosedHook: options.failClosedHook,
      dryRun: options.dryRun
    },
    agentFiles: metadata.entries
      .map((entry) => entry.path)
      .filter((path) => AGENT_FILE_CANDIDATES.includes(path as (typeof AGENT_FILE_CANDIDATES)[number])),
    actions: metadata.entries.map((entry) => ({
      kind: entry.kind === "append_managed_line" ? "remove" : entry.existed ? "restore" : "remove",
      path: actionPath(options.scope, entry.path),
      targetScope: options.scope,
      summary: entry.kind === "append_managed_line"
        ? `Remove managed ${entry.line} gitignore entry from ${entry.path}.`
        : entry.existed
          ? `Restore ${actionPath(options.scope, entry.path)} from Opcore init backup.`
          : `Remove ${actionPath(options.scope, entry.path)} created by Opcore init.`,
      requiresApproval: !entry.path.startsWith(".opcore/"),
      outsideOpcore: !entry.path.startsWith(".opcore/")
    })),
    warnings: [],
    nextActions: options.approved && !options.dryRun
      ? [undoAppliedNextAction(options.command)]
      : [undoPreviewNextAction(options)],
    undoAvailable: true,
    scan: context.scan,
    settings: context.settings,
    interaction: context.interaction,
    timings: context.timings
  };
}

function appliedUndoPayload(
  payload: OpcoreInitPlanPayload,
  root: string,
  scope: ParsedInitArgs["scope"],
  command: OpcoreSetupCommand
): OpcoreInitPlanPayload {
  return {
    ...payload,
    approved: true,
    nextActions: [undoAppliedNextAction(command)],
    undoAvailable: repoPathExists(root, undoPathForScope(scope))
  };
}

function undoAppliedNextAction(command: OpcoreSetupCommand): string {
  if (command === "uninstall") return "Opcore setup metadata was restored or removed; rerun opcore install to recreate setup.";
  return "Opcore init metadata was restored or removed; rerun opcore init to recreate setup.";
}

function undoPreviewNextAction(options: ParsedInitArgs): string {
  if (options.command === "uninstall") {
    return `Run ${options.scope === "global" ? "opcore uninstall --global --yes" : "opcore uninstall --yes"} to restore or remove recorded setup files.`;
  }
  return `Run ${options.scope === "global" ? "opcore init --global --undo --approve" : "opcore init --undo --approve"} to restore or remove recorded setup files.`;
}

function applyInit(root: string, scope: ParsedInitArgs["scope"], writes: readonly PlannedWrite[]): void {
  const scopedWrites = writes.filter((write) => write.targetScope === scope);
  const previousMetadata = readUndoMetadataIfExists(root, scope);
  const touchedPaths = uniqueStrings([
    ...(previousMetadata?.entries.map((entry) => entry.path) ?? []),
    ...scopedWrites.map((write) => write.path),
    undoPathForScope(scope)
  ]);
  for (const path of touchedPaths) assertMutationPath(root, path, `Opcore ${scope} init target`);
  const metadata: UndoMetadata = {
    schemaVersion: 1,
    kind: scope === "global" ? "opcore_global_init_undo" : "opcore_init_undo",
    ...(scope === "global" ? { homeRoot: root } : { repoRoot: root }),
    entries: touchedPaths.map((path) => {
      const previousEntry = previousMetadata?.entries.find((entry) => entry.path === path);
      if (previousEntry) return previousEntry;
      return priorEntry(root, path, scopedWrites.find((write) => write.path === path));
    })
  };
  for (const write of scopedWrites) writeScopedFile(root, write);
  writeScopedFile(root, {
    kind: "write",
    path: undoPathForScope(scope),
    targetScope: scope,
    content: `${JSON.stringify(metadata, null, 2)}\n`
  });
}

function applyUndo(root: string, scope: ParsedInitArgs["scope"], payload: OpcoreInitPlanPayload): void {
  const metadata = readUndoMetadata(root, scope);
  const scopedUndoPath = undoPathForScope(scope);
  for (const entry of metadata.entries) assertMutationPath(root, entry.path, "Opcore init undo target");
  for (const entry of metadata.entries.filter((entry) => entry.path !== scopedUndoPath)) restoreUndoEntry(root, entry);
  const undoEntry = metadata.entries.find((entry) => entry.path === scopedUndoPath);
  if (undoEntry) restoreUndoEntry(root, undoEntry);
  else rmSync(resolveScopedPath(root, scopedUndoPath), { force: true });
  removeEmptyOpcoreHookDir(root);
  void payload;
}

function createInitActions(
  scope: ParsedInitArgs["scope"],
  agentFiles: readonly string[],
  options: ParsedInitArgs,
  gitignoreWritePlanned: boolean,
  activePreCommitWritePlanned: boolean
): OpcoreInitAction[] {
  const skillActions: OpcoreInitAction[] = options.agentSkill
    ? agentSkillPaths.map((path) => ({
      kind: "write" as const,
      path: actionPath(scope, path),
      targetScope: scope,
      summary: "Install the Opcore agent skill.",
      requiresApproval: true,
      outsideOpcore: true
    }))
    : [];
  if (scope === "global") {
    return [
      ...(options.writeGateHooks
        ? [{
          kind: "create_hook" as const,
          path: actionPath(scope, agentGateHookPath),
          targetScope: scope,
          summary: "Install the global Opcore write-gate adapter script.",
          requiresApproval: false,
          outsideOpcore: false
        }]
        : []),
      ...skillActions,
      ...(options.writeGateHooks
        ? [
          {
            kind: "wire_harness" as const,
            path: actionPath(scope, claudeSettingsPath),
            targetScope: scope,
            summary: "Merge the Opcore Claude Code PreToolUse write gate.",
            requiresApproval: true,
            outsideOpcore: true
          },
          {
            kind: "wire_harness" as const,
            path: actionPath(scope, codexHooksPath),
            targetScope: scope,
            summary: "Merge the Opcore Codex PreToolUse write gate guardrail.",
            requiresApproval: true,
            outsideOpcore: true
          }
        ]
        : [])
    ];
  }
  const actions: OpcoreInitAction[] = [
    {
      kind: "write",
      path: configPath,
      targetScope: scope,
      summary: "Write additive Opcore init config.",
      requiresApproval: false,
      outsideOpcore: false
    },
    ...agentFiles.map((path) => ({
      kind: "upsert_block" as const,
      path,
      targetScope: scope,
      summary: "Add or update delimited Opcore agent guidance.",
      requiresApproval: true,
      outsideOpcore: true
    })),
    ...skillActions,
    ...(options.writeGateHooks
      ? [
        {
          kind: "create_hook" as const,
          path: agentGateHookPath,
          targetScope: scope,
          summary: "Install the repo-local Opcore write-gate adapter script.",
          requiresApproval: false,
          outsideOpcore: false
        },
        {
          kind: "wire_harness" as const,
          path: claudeSettingsPath,
          targetScope: scope,
          summary: "Merge the Opcore Claude Code PreToolUse write gate.",
          requiresApproval: true,
          outsideOpcore: true
        },
        {
          kind: "wire_harness" as const,
          path: codexHooksPath,
          targetScope: scope,
          summary: "Merge the Opcore Codex PreToolUse write gate guardrail.",
          requiresApproval: true,
          outsideOpcore: true
        }
      ]
      : [])
  ];
  if (gitignoreWritePlanned) {
    actions.push({
      kind: "write",
      path: gitignorePath,
      targetScope: scope,
      summary: "Append managed .opcore/ gitignore entry.",
      requiresApproval: true,
      outsideOpcore: true
    });
  }
  if (activePreCommitWritePlanned) {
    actions.push({
      kind: "create_hook",
      path: activePreCommitHookPath,
      targetScope: scope,
      summary: "Install active Git pre-commit hook that runs `opcore check --changed`.",
      requiresApproval: true,
      outsideOpcore: true
    });
  }
  if (options.failClosedHook) {
    actions.push({
      kind: "create_hook",
      path: hookPath,
      targetScope: scope,
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
  activePreCommitHook: boolean,
  writeGateHooks: boolean,
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
      failClosedPreCommit: existingHooks.failClosedPreCommit === true || failClosedHook || activePreCommitHook,
      activePreCommit: existingHooks.activePreCommit === true || activePreCommitHook,
      writeGate: existingHooks.writeGate === true || writeGateHooks,
      harnesses: writeGateHooks
        ? ["claude-code", "codex"]
        : Array.isArray(existingHooks.harnesses) ? existingHooks.harnesses : []
    }
  };
}

function initWarnings(
  scan: OpcoreInitScanSummary,
  git: boolean,
  failClosedHook: boolean,
  scope: ParsedInitArgs["scope"],
  activePreCommitHook: boolean,
  activePreCommitRequested: boolean,
  linkedGitWorktree: boolean
): string[] {
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
    scope === "global"
      ? "Global write-gate hooks apply across repos; undo removes only Opcore-recorded global hook entries."
      : "Repo write-gate hooks are additive; Codex project hooks may require trust review before they run."
  );
  warnings.push(
    failClosedHook
      ? `Fail-closed hook script is opt-in. Manual install required: ${failClosedHookActivationCommand}`
      : activePreCommitHook && git
        ? "Git pre-commit hook will run opcore check --changed when no existing .git/hooks/pre-commit is present."
        : linkedGitWorktree
          ? "Linked Git worktree detected; Opcore will not install .git/hooks/pre-commit from this checkout."
        : activePreCommitRequested
          ? "Existing .git/hooks/pre-commit detected; Opcore will not overwrite it."
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

function activePreCommitHookContent(): string {
  return [
    "#!/usr/bin/env sh",
    "# Installed by opcore install. Remove with opcore uninstall.",
    "set -eu",
    "opcore check --changed",
    ""
  ].join("\n");
}

function opcoreAgentSkillContent(): string {
  return [
    "---",
    "name: opcore",
    "description: Use when working in a repository that has installed Opcore robustness checks.",
    "---",
    "",
    "# Opcore",
    "",
    "Use Opcore as the repository-local robustness gate for coding-agent edits.",
    "",
    "- Run `opcore status` to inspect activation and coverage before broad work.",
    "- Run `opcore check --changed` before finalizing source edits.",
    "- Treat unsupported stacks and degraded tools honestly; do not report them as clean coverage.",
    "- Preserve existing lint, test, CI, pre-commit, and agent guardrails.",
    "- The installed write gate is a hook guardrail for supported edit tools, not host authority.",
    ""
  ].join("\n");
}

function mergeClaudeSettings(existing: Record<string, unknown>, scope: ParsedInitArgs["scope"]): Record<string, unknown> {
  return mergePreToolUseHook(existing, {
    matcher: "Edit|MultiEdit|Write",
    command: agentGateCommand("claude", scope),
    statusMessage: "Running Opcore write gate"
  });
}

function mergeCodexHooks(existing: Record<string, unknown>, scope: ParsedInitArgs["scope"]): Record<string, unknown> {
  return mergePreToolUseHook(existing, {
    matcher: "apply_patch|Edit|Write",
    command: agentGateCommand("codex", scope),
    statusMessage: "Running Opcore write gate"
  });
}

function mergePreToolUseHook(
  existing: Record<string, unknown>,
  hook: { matcher: string; command: string; statusMessage: string }
): Record<string, unknown> {
  const hooks = isPlainObject(existing.hooks) ? existing.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const groupIndex = preToolUse.findIndex((entry) => isPlainObject(entry) && entry.matcher === hook.matcher);
  const hookEntry = {
    type: "command",
    command: hook.command,
    timeout: 30,
    statusMessage: hook.statusMessage
  };
  if (groupIndex >= 0) {
    const group = preToolUse[groupIndex];
    if (isPlainObject(group)) {
      const groupHooks = Array.isArray(group.hooks) ? [...group.hooks] : [];
      const alreadyPresent = groupHooks.some(
        (entry) => isPlainObject(entry) && typeof entry.command === "string" && entry.command.includes("opcore-agent-gate.mjs")
      );
      preToolUse[groupIndex] = {
        ...group,
        hooks: alreadyPresent ? groupHooks : [...groupHooks, hookEntry]
      };
    }
  } else {
    preToolUse.push({
      matcher: hook.matcher,
      hooks: [hookEntry]
    });
  }
  return {
    ...existing,
    hooks: {
      ...hooks,
      PreToolUse: preToolUse
    }
  };
}

function agentGateCommand(harness: "claude" | "codex", scope: ParsedInitArgs["scope"]): string {
  const hook = scope === "global"
    ? "$HOME/.opcore/hooks/opcore-agent-gate.mjs"
    : '"$(git rev-parse --show-toplevel)/.opcore/hooks/opcore-agent-gate.mjs"';
  const repo = scope === "global" ? "" : ' --repo "$(git rev-parse --show-toplevel)"';
  return `node ${hook} --harness ${harness}${repo}`;
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

function writeScopedFile(root: string, write: PlannedWrite): void {
  writeRepoFile(root, write);
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

function readUndoMetadata(root: string, scope: ParsedInitArgs["scope"]): UndoMetadata {
  const scopedUndoPath = undoPathForScope(scope);
  const raw = readFileSync(assertExistingRepoPath(root, scopedUndoPath, "Opcore init undo metadata", "file"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const expectedKind = scope === "global" ? "opcore_global_init_undo" : "opcore_init_undo";
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1 || parsed.kind !== expectedKind || !Array.isArray(parsed.entries)) {
    throw new Error(".opcore/init-undo.json is not valid Opcore init undo metadata");
  }
  const recordedRoot = scope === "global" ? parsed.homeRoot : parsed.repoRoot;
  if (typeof recordedRoot !== "string" || resolve(recordedRoot) !== resolve(root)) {
    throw new Error(".opcore/init-undo.json repoRoot does not match this repository");
  }
  const allowedPaths = scope === "global" ? allowedGlobalUndoPaths : allowedUndoPaths;
  const seenPaths = new Set<string>();
  const entries: UndoEntry[] = [];
  for (const entry of parsed.entries) {
    if (!isPlainObject(entry) || typeof entry.path !== "string" || typeof entry.existed !== "boolean") {
      throw new Error(".opcore/init-undo.json contains an invalid entry");
    }
    if (!allowedPaths.has(entry.path)) {
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
      resolveRepoPath(root, entry.path);
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
    resolveRepoPath(root, entry.path);
    entries.push({
      kind: "restore_file",
      path: entry.path,
      existed: entry.existed,
      ...(typeof entry.content === "string" ? { content: entry.content } : {})
    });
  }
  return {
    schemaVersion: 1,
    kind: expectedKind,
    ...(scope === "global" ? { homeRoot: recordedRoot } : { repoRoot: recordedRoot }),
    entries
  };
}

function readUndoMetadataIfExists(root: string, scope: ParsedInitArgs["scope"]): UndoMetadata | undefined {
  if (!repoPathExists(root, undoPathForScope(scope))) return undefined;
  return readUndoMetadata(root, scope);
}

function readJsonObject(repoRoot: string, path: string): Record<string, unknown> {
  const content = readOptionalRepoFile(repoRoot, path);
  if (content === undefined) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!isPlainObject(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function readJsonObjectIfExists(repoRoot: string, path: string): Record<string, unknown> {
  if (!repoPathExists(repoRoot, path)) return {};
  return readJsonObject(repoRoot, path);
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

function resolveScopedPath(root: string, path: string): string {
  return resolveRepoPath(root, path);
}

function assertMutationPath(root: string, path: string, label: string): string {
  return assertRepoMutationPath(root, path, label);
}

function undoPathForScope(_scope: ParsedInitArgs["scope"]): string {
  return undoPath;
}

function actionPath(scope: ParsedInitArgs["scope"], path: string): string {
  return scope === "global" ? `~/${path}` : path;
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

function isLinkedGitWorktree(repoRoot: string): boolean {
  const gitPath = lstatIfExists(resolveRepoPath(repoRoot, ".git"));
  return gitPath?.isFile() === true;
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

function formatSetupPlan(payload: OpcoreInitPlanPayload, applied: boolean, command: OpcoreSetupCommand): string {
  if (command === "install") return formatInstallPlan(payload, applied);
  if (command === "uninstall") return formatUninstallPlan(payload, applied);
  return formatInitPlan(payload, applied);
}

function formatInstallPlan(payload: OpcoreInitPlanPayload, applied: boolean): string {
  const skillEnabled = payload.actions.some((action) => action.path.endsWith("/skills/opcore/SKILL.md"));
  const hooksEnabled = payload.actions.some((action) => action.path.endsWith(claudeSettingsPath));
  const activePreCommitEnabled = payload.actions.some((action) => action.path === activePreCommitHookPath);
  const scanSummary = `Analyzed ${payload.scan.totalFiles} files; validation=${payload.scan.validationStatus}; diagnostics=${payload.scan.diagnosticCount}.`;
  return [
    "Opcore install:",
    `  ${scanSummary}`,
    "Setup choices:",
    `${skillEnabled ? "[x]" : "[ ]"} Install Opcore agent skill`,
    `${hooksEnabled ? "[x]" : "[ ]"} Install Claude Code and Codex write-gate hooks`,
    `${activePreCommitEnabled ? "[x]" : "[ ]"} Install Git pre-commit hook`,
    "",
    formatInitPlan(payload, applied, "--yes")
  ].join("\n");
}

function formatUninstallPlan(payload: OpcoreInitPlanPayload, applied: boolean): string {
  return [
    "Opcore uninstall:",
    "  Restore or remove only files recorded in .opcore/init-undo.json.",
    "",
    formatInitPlan(payload, applied, "--yes")
  ].join("\n");
}

function formatInitPlan(payload: OpcoreInitPlanPayload, applied: boolean, approvalFlag?: string): string {
  const heading = payload.mode === "undo" ? "Undo:" : "Setup:";
  const requiredApprovalFlag = approvalFlag ?? (payload.mode === "undo" ? "--undo --approve" : "--approve");
  const actionLines = payload.actions.map((action) => `- ${action.kind} ${action.path}: ${action.summary}`);
  const approvalLine = payload.interaction.promptState === "requested"
    ? "Approval: awaiting TTY response."
    : payload.interaction.promptState === "declined"
      ? "Approval: declined; no files written."
    : applied
    ? "Approval: applied."
    : payload.mode === "undo"
      ? `Approval: required; rerun with ${requiredApprovalFlag} to restore/remove recorded files.`
      : `Approval: required; rerun with ${requiredApprovalFlag} to write this setup.`;
  const languages = payload.scan.languages.length === 0
    ? "none"
    : payload.scan.languages.map((entry) => `${entry.language} ${entry.files}`).join(", ");
  const unsupported = payload.scan.unsupportedStacks.length === 0
    ? "none"
    : payload.scan.unsupportedStacks.map((stack) => `${stack.language} ${stack.count}`).join(", ");
  const degradedValidationTools = payload.scan.degradedRustTools.length === 0
    ? "none"
    : payload.scan.degradedRustTools.map((tool) => `${tool.adapter}:${tool.tool}`).join(", ");
  const warningLines = payload.warnings.length === 0
    ? ["  none"]
    : payload.warnings.map((warning) => `  ${warning}`);
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
    "Warnings:",
    ...warningLines,
    heading,
    `Repo: ${payload.repo.root}`,
    `Scope: ${payload.options.scope}`,
    `Mode: ${payload.mode}`,
    `Approved: ${payload.approved ? "yes" : "no"}`,
    "Actions:",
    ...actionLines,
    approvalLine,
    "Timing:",
    `  first-output-ms=${payload.timings.firstOutputMs} scan-ms=${payload.timings.scanMs} total-ms=${payload.timings.totalMs}`
  ].join("\n");
}

function formatInteractiveOutcome(payload: OpcoreInitPlanPayload, command: OpcoreSetupCommand): string {
  return payload.approved
    ? `opcore ${command} applied\nApproval: applied.`
    : `opcore ${command} declined\nApproval: declined; no files written.`;
}

function opcoreSetupHelpMessage(command: OpcoreSetupCommand): string {
  if (command === "install") return opcoreInstallHelpMessage();
  if (command === "uninstall") return opcoreUninstallHelpMessage();
  return opcoreInitHelpMessage();
}

function opcoreInitHelpMessage(): string {
  return [
    "Usage:",
    "  opcore init [--repo <path>] [--local|--global] [--approve] [--json]",
    "  opcore init --undo --approve [--repo <path>] [--local|--global] [--json]",
    "Flags:",
    "  --repo <path>          Repository root to set up.",
    "  --local                Force repo-scoped setup.",
    "  --global               Install the write gate in user-level agent settings.",
    "  --approve              Apply the proposed additive setup.",
    "  --undo                 Revert files recorded in .opcore/init-undo.json.",
    "  --fail-closed-hook     Add the optional fail-closed pre-commit hook.",
    "  --json                 Emit structured JSON.",
    "Defaults:",
    "  Without --approve, init is plan-only outside an interactive approval prompt.",
    "  Inside a Git repo on a TTY, init asks whether to install for this repo or globally.",
    "Examples:",
    "  opcore init --repo . --json",
    "  opcore init --repo . --approve",
    "  opcore init --global --approve",
    "Exit codes: 0 planned or applied, 1 setup error, 64 unsupported."
  ].join("\n");
}

function opcoreInstallHelpMessage(): string {
  return [
    "Usage:",
    "  opcore install [--repo <path>] [--local|--global] [--yes] [--json]",
    "Flags:",
    "  --repo <path>          Repository root to set up.",
    "  --local                Force repo-scoped setup.",
    "  --global               Install user-level agent skills and write-gate hooks.",
    "  --yes                 Apply the proposed setup without prompting.",
    "  --no-skill             Do not install the Opcore agent skill.",
    "  --no-pre-commit        Do not install the repo Git pre-commit hook.",
    "  --json                 Emit structured JSON.",
    "Defaults:",
    "  install scans first, then applies on --yes or an interactive default-yes approval prompt.",
    "Examples:",
    "  opcore install",
    "  opcore install --repo . --yes",
    "Exit codes: 0 planned or applied, 1 setup error, 64 unsupported."
  ].join("\n");
}

function opcoreUninstallHelpMessage(): string {
  return [
    "Usage:",
    "  opcore uninstall [--repo <path>] [--local|--global] [--yes] [--json]",
    "Flags:",
    "  --repo <path>          Repository root to restore/remove recorded setup from.",
    "  --local                Force repo-scoped uninstall.",
    "  --global               Restore/remove user-level recorded setup.",
    "  --yes                 Apply the uninstall without prompting.",
    "  --json                 Emit structured JSON.",
    "Defaults:",
    "  uninstall restores or removes only files recorded in .opcore/init-undo.json.",
    "Examples:",
    "  opcore uninstall --repo . --yes",
    "  opcore uninstall --global --yes",
    "Exit codes: 0 planned or applied, 1 setup error, 64 unsupported."
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
