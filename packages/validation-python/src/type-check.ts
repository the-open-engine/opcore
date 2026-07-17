import type {
  PythonProjectContext,
  PythonProjectToolProvenance,
  PythonValidationAuthority,
  PythonValidationAuthoritySource,
  PythonValidationCapabilityRun,
  PythonValidationCapabilityRunStatus,
  PythonValidationCapabilityToolProvenance,
  ValidationCheckOutcome,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition,
  ValidationCheckResult
} from "@the-open-engine/opcore-validation";
import { PYTHON_TYPES_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { runMypyCapability } from "./mypy-runner.js";
import { resolveMypyConfigSemantics, type MypyConfigSemantics } from "./mypy-config.js";
import { resolvePyrightConfigSemantics, type PyrightConfigSemantics } from "./pyright-config.js";
import { runPyrightCapability } from "./pyright-runner.js";
import {
  pythonInputSet,
  skippedPythonInputResult,
  type PythonMaterializedSourceSet,
  type PythonProjectContextResolver,
  type PythonSourceSetResolver
} from "./source-files.js";
import { selectPythonTypeAuthority, type PythonTypeAuthoritySelection } from "./type-authority.js";
import {
  createPythonTypeCapabilityRun,
  portablePythonValidationTool,
  preparePythonTypeCapability,
  type PythonTypeCapabilityPreparation
} from "./type-capability-run.js";
import type { PythonValidationToolchainOptions } from "./toolchain.js";

export interface PythonTypeCheckOptions extends Omit<PythonValidationToolchainOptions, "contexts"> {
  timeoutMs?: number;
  checker?: PythonValidationAuthority;
}

interface PythonProjectGroup {
  context: PythonProjectContext;
  targets: readonly string[];
}

interface ProjectAttempt {
  run?: PythonValidationCapabilityRun;
  diagnostics: readonly ValidationDiagnostic[];
  outcome: ValidationCheckOutcome;
  failureMessage?: string;
}

export function createTypeCheck(
  options: PythonTypeCheckOptions = {},
  resolveContexts?: PythonProjectContextResolver,
  resolveSources?: PythonSourceSetResolver
): ValidationCheckDefinition {
  return {
    id: PYTHON_TYPES_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    run: async (validation) => {
      const skipped = skippedPythonInputResult(validation);
      if (skipped !== undefined) return skipped;
      if (resolveContexts === undefined) return missingContextResult(pythonInputSet(validation));
      if (resolveSources === undefined) throw new Error("A shared Python source-set resolver is required for Python type validation");
      const sourceSet = await resolveSources(validation);
      if (sourceSet.rootPaths.length === 0) {
        return { status: "skipped", diagnostics: [], failureMessage: "No Python after-state source files were selected." };
      }
      // Pyright selects files from configuration rather than only the import closure.
      // Resolve every visible source so parent projects cannot materialize sources
      // owned by another project that has its own authority run in this request.
      const contexts = await resolveContexts(validation, sourceSet.allPaths);
      const contextByTarget = new Map(contexts.map((context) => [context.target, context]));
      const missing = sourceSet.rootPaths.filter((path) => !contextByTarget.has(path));
      if (missing.length > 0) return missingContextResult(missing);
      const projects = groupProjectContexts(sourceSet.rootPaths, contextByTarget);
      const activeProjectKeys = new Set(projects.map((project) => project.context.projectKey));
      const attempts: ProjectAttempt[] = [];
      for (const project of projects) {
        attempts.push(await attemptProject(validation, project, sourceSet, contextByTarget, activeProjectKeys, options));
      }
      const diagnostics = sortDiagnostics(attempts.flatMap((attempt) => attempt.diagnostics));
      const runs = attempts.flatMap((attempt) => attempt.run === undefined ? [] : [attempt.run]);
      const outcome = aggregateOutcome(attempts.map((attempt) => attempt.outcome));
      return {
        outcome,
        diagnostics,
        pythonCapabilityRuns: runs,
        ...(outcome === "passed" || outcome === "findings" ? {} : {
          failureMessage: attempts.find((attempt) => attempt.outcome === outcome)?.failureMessage ??
            `Python type authority failed with ${outcome}`
        })
      };
    }
  };
}

function projectSourcePaths(args: {
  basePaths: readonly string[];
  availablePaths: readonly string[];
  edges: readonly { fromPath: string; toPath: string }[];
  additionalRoots: readonly string[];
  projectRoot: string;
}): readonly string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of args.edges) {
    const values = outgoing.get(edge.fromPath) ?? [];
    values.push(edge.toPath);
    outgoing.set(edge.fromPath, values);
  }
  const selected = new Set([...args.basePaths, ...args.additionalRoots]);
  const pending = [...selected];
  const initializers = args.availablePaths.filter((path) => /(?:^|\/)__init__\.pyi?$/u.test(path));
  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined) continue;
    for (const dependency of outgoing.get(path) ?? []) {
      if (selected.has(dependency)) continue;
      selected.add(dependency);
      pending.push(dependency);
    }
    for (const initializer of initializersForPath(path, initializers, args.projectRoot)) {
      if (selected.has(initializer)) continue;
      selected.add(initializer);
      pending.push(initializer);
    }
  }
  return [...selected].sort();
}

function initializersForPath(
  path: string,
  initializers: readonly string[],
  projectRoot: string
): readonly string[] {
  const sourceRoot = inferredSourceRoot(path, projectRoot);
  return initializers.filter((initializer) => {
    const directory = initializer.slice(0, initializer.lastIndexOf("/"));
    return directory.length > 0 && directory !== sourceRoot &&
      (sourceRoot === "." || directory.startsWith(`${sourceRoot}/`)) && path.startsWith(`${directory}/`);
  });
}

function inferredSourceRoot(path: string, projectRoot: string): string {
  const src = /^(.*?\bsrc)(?:\/|$)/u.exec(path)?.[1];
  if (src !== undefined) return src;
  return projectRoot;
}

async function attemptProject(
  validation: ValidationCheckContext,
  project: PythonProjectGroup,
  sourceSet: PythonMaterializedSourceSet,
  contextByTarget: ReadonlyMap<string, PythonProjectContext>,
  activeProjectKeys: ReadonlySet<string>,
  options: PythonTypeCheckOptions
): Promise<ProjectAttempt> {
  const selection = selectPythonTypeAuthority(project.context, options.checker);
  const mypySemantics = await selectedMypySemantics(validation, project, selection);
  const pyrightSemantics = await selectedPyrightSemantics(validation, project, selection, options);
  const eligiblePaths = sourceSet.allPaths.filter((path) => {
    const projectKey = contextByTarget.get(path)?.projectKey;
    if (projectKey === project.context.projectKey || projectKey === undefined) return true;
    return selection.authority === "pyright" ? false : !activeProjectKeys.has(projectKey);
  });
  const eligiblePathSet = new Set(eligiblePaths);
  const sourcePaths = selection.authority === "pyright"
    ? pyrightProjectSourcePaths(eligiblePaths, project.context.projectRoot, pyrightSemantics.moduleSearchRoots)
    : projectSourcePaths({
      basePaths: project.targets,
      availablePaths: eligiblePaths,
      edges: sourceSet.allRepoImports.filter((edge) => eligiblePathSet.has(edge.fromPath) && eligiblePathSet.has(edge.toPath)),
      additionalRoots: mypySemantics.pluginPaths.filter((path) => eligiblePathSet.has(path)),
      projectRoot: project.context.projectRoot
    });
  const pyrightIsolationFailures = selection.authority === "pyright"
    ? await pyrightSourceIsolationFailures(sourcePaths, options)
    : [];
  const preparation = await preparePythonTypeCapability({
    fileView: validation.fileView,
    project: project.context,
    targets: project.targets,
    sourcePaths,
    configPaths: selection.authority === "pyright" ? pyrightSemantics.configPaths : selection.configPaths,
    moduleSearchRoots: selection.authority === "pyright" ? pyrightSemantics.moduleSearchRoots : mypySemantics.moduleSearchRoots
  });
  const blocked = blockedProjectAttempt(project, preparation, selection, [
    ...mypySemantics.invalidConfigMessages,
    ...pyrightSemantics.invalidConfigMessages,
    ...pyrightIsolationFailures
  ]);
  if (blocked !== undefined) return blocked;
  if (selection.tool === undefined || selection.authority === undefined) {
    throw new Error("Selected Python type authority omitted canonical tool provenance");
  }
  const shared = {
    preparation,
    checker: selection.tool,
    authoritySource: selection.source ?? "project_config",
    ...(options.env === undefined ? {} : { env: options.env }),
    timeoutMs: options.timeoutMs ?? 30000
  };
  const executed = selection.authority === "pyright"
    ? await runPyrightCapability(shared)
    : await runMypyCapability(shared);
  return { ...executed, outcome: executed.run.status };
}

async function pyrightSourceIsolationFailures(
  paths: readonly string[],
  options: PythonTypeCheckOptions
): Promise<readonly string[]> {
  if (options.nodeWorkspace === undefined) return [];
  const failures: string[] = [];
  for (const path of paths) {
    const resolved = await options.nodeWorkspace.realpath(path);
    if (resolved.unavailable) failures.push(`${path}: Pyright source realpath evidence is unavailable`);
    else if (resolved.symlink || resolved.path !== path) failures.push(`${path}: Symlinked or escaping Pyright source is refused`);
  }
  return failures;
}

function pyrightProjectSourcePaths(
  availablePaths: readonly string[],
  projectRoot: string,
  roots: readonly string[]
): readonly string[] {
  const effectiveRoots = uniqueSorted([projectRoot, ...roots]);
  return availablePaths.filter((path) => effectiveRoots.some((root) =>
    root === "." || path === root || path.startsWith(`${root}/`)
  )).sort();
}

async function selectedMypySemantics(
  validation: ValidationCheckContext,
  project: PythonProjectGroup,
  selection: PythonTypeAuthoritySelection
): Promise<MypyConfigSemantics> {
  if (selection.status !== "selected" || selection.authority !== "mypy") {
    return { pluginPaths: [], moduleSearchRoots: project.context.sourceRoots, invalidConfigMessages: [] };
  }
  return resolveMypyConfigSemantics(validation.fileView, project.context, selection.configPaths);
}

async function selectedPyrightSemantics(
  validation: ValidationCheckContext,
  project: PythonProjectGroup,
  selection: PythonTypeAuthoritySelection,
  options: PythonTypeCheckOptions
): Promise<PyrightConfigSemantics> {
  if (selection.status !== "selected" || selection.authority !== "pyright") {
    return { configPaths: [], moduleSearchRoots: project.context.sourceRoots, invalidConfigMessages: [] };
  }
  return resolvePyrightConfigSemantics(validation.fileView, project.context, selection.configPaths, options.nodeWorkspace);
}

function blockedProjectAttempt(
  project: PythonProjectGroup,
  preparation: PythonTypeCapabilityPreparation,
  selection: PythonTypeAuthoritySelection,
  invalidConfigMessages: readonly string[]
): ProjectAttempt | undefined {
  if (project.context.outcome === "ambiguous") {
    return nonExecutableAttempt(preparation, selection, { status: "invalid_config", message: projectFailure(project, "ambiguous"), code: "PYTHON_TYPES_INVALID_CONFIG" });
  }
  if (selection.status === "invalid_config") {
    return nonExecutableAttempt(preparation, selection, {
      status: "invalid_config",
      message: selection.message ?? projectFailure(project, "invalid_config"),
      code: "PYTHON_TYPES_INVALID_CONFIG"
    });
  }
  if (invalidConfigMessages.length > 0) {
    return nonExecutableAttempt(preparation, selection, {
      status: "invalid_config",
      message: invalidConfigMessages.join("; "),
      code: "PYTHON_TYPES_INVALID_CONFIG"
    });
  }
  if (project.context.outcome === "unsupported") {
    return nonExecutableAttempt(preparation, selection, { status: "unsupported_target", message: projectFailure(project, "unsupported"), code: "PYTHON_TYPES_UNSUPPORTED_TARGET" });
  }
  if (selection.status !== "selected") {
    return nonExecutableAttempt(preparation, selection, {
      status: selection.status,
      message: selection.message ?? projectFailure(project, selection.status),
      code: "PYTHON_TYPES_UNSUPPORTED_TARGET"
    });
  }
  if (selection.tool === undefined || !selection.tool.available) {
    const message = `Selected ${selection.authority ?? "Python type"} authority is unavailable for ${project.context.projectRoot}`;
    return nonExecutableAttempt(preparation, selection, { status: "tool_unavailable", message, code: "PYTHON_TYPES_TOOL_UNAVAILABLE" });
  }
  return undefined;
}

function projectFailure(project: PythonProjectGroup, state: string): string {
  return project.context.reasons[0]?.message ?? `Canonical Python project is ${state} for ${project.context.projectRoot}`;
}

function nonExecutableAttempt(
  preparation: PythonTypeCapabilityPreparation,
  selection: PythonTypeAuthoritySelection,
  failure: {
    status: Extract<PythonValidationCapabilityRunStatus, "invalid_config" | "unsupported_target" | "tool_unavailable">;
    message: string;
    code: string;
  }
): ProjectAttempt {
  const authority = evidenceAuthority(selection);
  const authoritySource = evidenceAuthoritySource(selection);
  const tool = selection.tool === undefined || authority === undefined
    ? undefined
    : portableNonExecutedTool(selection.tool, preparation, authority);
  const run = createPythonTypeCapabilityRun({
    preparation,
    ...(authority === undefined ? {} : { authority }),
    ...(authoritySource === undefined ? {} : { authoritySource }),
    status: failure.status,
    durationMs: 0,
    counts: { diagnosticCount: 1, errorCount: 0, warningCount: 0, noteCount: 1 },
    ...(tool === undefined ? {} : { tool })
  });
  return {
    run,
    outcome: failure.status,
    failureMessage: failure.message,
    diagnostics: [diagnostic({
      category: failure.status === "invalid_config" ? "infrastructure" : "types",
      severity: "info",
      code: failure.code,
      message: failure.message,
      path: preparation.project.target,
      ...(tool === undefined ? {} : { tool: {
        name: tool.name,
        command: tool.argv.join(" "),
        ...(tool.version === undefined ? {} : { version: tool.version }),
        source: tool.source,
        cwd: tool.cwd
      } })
    })]
  };
}

function portableNonExecutedTool(
  checker: PythonProjectToolProvenance,
  preparation: PythonTypeCapabilityPreparation,
  authority: PythonValidationAuthority
): PythonValidationCapabilityToolProvenance {
  return portablePythonValidationTool({ checker, preparation, authority });
}

function evidenceAuthority(selection: PythonTypeAuthoritySelection): PythonValidationAuthority | undefined {
  return selection.authority;
}

function evidenceAuthoritySource(selection: PythonTypeAuthoritySelection): PythonValidationAuthoritySource | undefined {
  return selection.source;
}

function groupProjectContexts(
  rootPaths: readonly string[],
  contextByTarget: ReadonlyMap<string, PythonProjectContext>
): readonly PythonProjectGroup[] {
  const groups = new Map<string, { context: PythonProjectContext; targets: string[] }>();
  for (const path of rootPaths) {
    const context = contextByTarget.get(path);
    if (context === undefined) continue;
    const group = groups.get(context.projectKey) ?? { context, targets: [] };
    if (contextPriority(context) > contextPriority(group.context)) group.context = context;
    group.targets.push(path);
    groups.set(context.projectKey, group);
  }
  return [...groups.values()]
    .map((group) => ({ context: group.context, targets: [...new Set(group.targets)].sort() }))
    .sort((left, right) =>
      left.context.projectRoot.localeCompare(right.context.projectRoot) ||
      left.context.projectKey.localeCompare(right.context.projectKey)
    );
}

function contextPriority(context: PythonProjectContext): number {
  if (context.outcome === "ambiguous" || context.reasons.some((reason) => reason.code === "invalid_config")) return 3;
  if (context.outcome === "unsupported") return 2;
  if (context.outcome === "degraded") return 1;
  return 0;
}

function aggregateOutcome(outcomes: readonly ValidationCheckOutcome[]): ValidationCheckOutcome {
  const priority: readonly ValidationCheckOutcome[] = [
    "invalid_config", "timeout", "tool_failure", "tool_unavailable", "unsupported_target", "findings", "passed"
  ];
  return priority.find((candidate) => outcomes.includes(candidate)) ?? "passed";
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function missingContextResult(missing: readonly string[]): ValidationCheckResult {
  const suffix = missing.length === 0 ? "" : `: ${missing.join(", ")}`;
  const message = `Canonical Python project context resolution returned no context for selected source${suffix}`;
  return {
    outcome: "tool_failure",
    failureMessage: message,
    diagnostics: [{
      category: "infrastructure",
      severity: "error",
      code: "PYTHON_CONTEXT_MISSING",
      message
    }]
  };
}
