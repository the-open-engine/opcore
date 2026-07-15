import type {
  PythonProjectContext,
  PythonProjectContextOutcome,
  PythonProjectContextReason,
  PythonProjectToolKind
} from "@the-open-engine/opcore-contracts";
import {
  PYTHON_PROJECT_CONTEXT_SCHEMA_ID,
  validatePythonProjectContext,
  validateRepoRelativePath
} from "@the-open-engine/opcore-contracts";
import { discoverPythonProject } from "./project-discovery.js";
import {
  resolvePythonProjectEnvironment,
  type PythonProjectProcessProbe
} from "./environment-resolution.js";
import {
  normalizePythonProjectFingerprintInput,
  pythonProjectDigest
} from "./project-fingerprint.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";
import { readPythonStaticProjectConfig } from "./static-config.js";

export interface ResolvePythonProjectContextsOptions {
  repoRoot: string;
  targets: readonly string[];
  workspace: PythonProjectWorkspace;
  interpreterArgv?: readonly string[];
  toolArgv?: Partial<Record<PythonProjectToolKind, readonly string[]>>;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: string;
  architecture?: string;
  processProbe?: PythonProjectProcessProbe;
  timeoutMs?: number;
}

export class PythonProjectContextResolutionError extends Error {
  readonly code: "path_refused";

  constructor(message: string) {
    super(message);
    this.name = "PythonProjectContextResolutionError";
    this.code = "path_refused";
  }
}

export async function resolvePythonProjectContexts(
  options: ResolvePythonProjectContextsOptions
): Promise<readonly PythonProjectContext[]> {
  const targets = normalizeTargets(options.targets);
  const visibleFiles = [...new Set(await options.workspace.list())].sort();
  const projectInputs = new Map<string, Promise<ResolvedProjectInputs>>();
  const contexts: PythonProjectContext[] = [];
  for (const target of targets) {
    contexts.push(await resolveTarget(options, target, visibleFiles, projectInputs));
  }
  return contexts;
}

export async function resolvePythonProjectContext(
  options: Omit<ResolvePythonProjectContextsOptions, "targets"> & { target: string }
): Promise<PythonProjectContext> {
  const [context] = await resolvePythonProjectContexts({ ...options, targets: [options.target] });
  if (context === undefined) throw new Error("Python project context target is required");
  return context;
}

async function resolveTarget(
  options: ResolvePythonProjectContextsOptions,
  target: string,
  visibleFiles: readonly string[],
  projectInputs: Map<string, Promise<ResolvedProjectInputs>>
): Promise<PythonProjectContext> {
  const discovery = await discoverPythonProject(options.workspace, target, visibleFiles);
  let inputs: ResolvedProjectInputs;
  if (discovery.reasons.some(isPathRefusalReason)) {
    const config = await readPythonStaticProjectConfig(options.workspace, discovery.projectRoot, visibleFiles);
    inputs = { config, environment: refusedEnvironment() };
  } else {
    let inputPromise = projectInputs.get(discovery.projectRoot);
    if (inputPromise === undefined) {
      inputPromise = resolveProjectInputs(options, discovery.projectRoot, visibleFiles);
      projectInputs.set(discovery.projectRoot, inputPromise);
    }
    inputs = await inputPromise;
  }
  const { config, environment } = inputs;
  const reasons = deduplicateReasons([...discovery.reasons, ...config.reasons, ...environment.reasons]);
  const evidence = mergeEvidence(discovery.evidence, config);
  const projectKey = pythonProjectDigest({ schemaId: PYTHON_PROJECT_CONTEXT_SCHEMA_ID, projectRoot: discovery.projectRoot });
  const targetContent = discovery.reasons.some(isPathRefusalReason)
    ? undefined
    : await options.workspace.read(target);
  const fingerprintInput = {
    schemaId: PYTHON_PROJECT_CONTEXT_SCHEMA_ID,
    target,
    targetContent: targetContent === undefined ? null : pythonProjectDigest(targetContent),
    projectRoot: discovery.projectRoot,
    sourceRoots: discovery.sourceRoots,
    layout: discovery.layout,
    configContents: [...config.contents].map(([path, content]) => [path, pythonProjectDigest(content)]),
    targetRuntime: config.target,
    managers: config.managers,
    ...(config.buildSystem === undefined ? {} : { buildSystem: config.buildSystem }),
    explicit: { interpreterArgv: options.interpreterArgv, toolArgv: options.toolArgv },
    environment: environment.fingerprintInput
  };
  const contextFingerprint = pythonProjectDigest(normalizePythonProjectFingerprintInput(
    fingerprintInput,
    options.repoRoot,
    options.platform ?? process.platform
  ));
  return validatePythonProjectContext({
    schemaId: PYTHON_PROJECT_CONTEXT_SCHEMA_ID,
    schemaVersion: 1,
    target,
    repositoryRoot: options.repoRoot,
    projectRoot: discovery.projectRoot,
    projectBoundary: discovery.projectBoundary,
    sourceRoots: discovery.sourceRoots,
    layout: discovery.layout,
    evidence,
    targetRuntime: config.target,
    managers: config.managers,
    ...(config.buildSystem === undefined ? {} : { buildSystem: config.buildSystem }),
    ...(environment.interpreter === undefined ? {} : { interpreter: environment.interpreter }),
    tools: environment.tools,
    projectKey,
    contextFingerprint,
    outcome: contextOutcome(reasons),
    reasons
  });
}

interface ResolvedProjectInputs {
  config: Awaited<ReturnType<typeof readPythonStaticProjectConfig>>;
  environment: Awaited<ReturnType<typeof resolvePythonProjectEnvironment>>;
}

async function resolveProjectInputs(
  options: ResolvePythonProjectContextsOptions,
  projectRoot: string,
  visibleFiles: readonly string[]
): Promise<ResolvedProjectInputs> {
  const config = await readPythonStaticProjectConfig(options.workspace, projectRoot, visibleFiles);
  const environment = config.reasons.some(isPathRefusalReason)
    ? refusedEnvironment()
    : await resolvePythonProjectEnvironment({
    repoRoot: options.repoRoot,
    projectRoot,
    workspace: options.workspace,
    target: config.target,
    managers: config.managers,
    toolConfigs: config.toolConfigs,
    ...(config.buildSystem === undefined ? {} : { buildSystem: config.buildSystem }),
    ...(options.interpreterArgv === undefined ? {} : { interpreterArgv: options.interpreterArgv }),
    ...(options.toolArgv === undefined ? {} : { toolArgv: options.toolArgv }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
    ...(options.processProbe === undefined ? {} : { processProbe: options.processProbe }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  return { config, environment };
}

function refusedEnvironment(): Awaited<ReturnType<typeof resolvePythonProjectEnvironment>> {
  return { tools: [], reasons: [], fingerprintInput: { refused: true } };
}

function isPathRefusalReason(reason: PythonProjectContextReason): boolean {
  return reason.code === "symlink_refused" || reason.code === "path_refused" || reason.code === "ambiguous_path";
}

function normalizeTargets(targets: readonly string[]): readonly string[] {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("Python project context targets must be a non-empty array");
  return [...new Set(targets.map((target) => {
    try {
      const normalized = validateRepoRelativePath(target.replaceAll("\\", "/"));
      if (!/\.pyi?$/u.test(normalized)) throw new Error(`Python project context target must be .py or .pyi: ${normalized}`);
      return normalized;
    } catch (error) {
      throw new PythonProjectContextResolutionError(error instanceof Error ? error.message : String(error));
    }
  }))].sort();
}

function contextOutcome(reasons: readonly PythonProjectContextReason[]): PythonProjectContextOutcome {
  if (reasons.length === 0) return "resolved";
  if (reasons.some((reason) => ["conflicting_managers", "conflicting_targets", "symlink_refused", "path_refused", "ambiguous_path"].includes(reason.code))) {
    return "ambiguous";
  }
  if (reasons.some((reason) => ["interpreter_unavailable", "incompatible_interpreter", "unsupported_target", "unsupported_platform"].includes(reason.code))) {
    return "unsupported";
  }
  return "degraded";
}

function deduplicateReasons(reasons: readonly PythonProjectContextReason[]): readonly PythonProjectContextReason[] {
  const byKey = new Map<string, PythonProjectContextReason>();
  for (const reason of reasons) byKey.set(`${reason.code}\0${reason.path ?? ""}\0${reason.tool ?? ""}\0${reason.message}`, reason);
  return [...byKey.values()].sort((left, right) =>
    `${left.code}\0${left.path ?? ""}\0${left.tool ?? ""}`.localeCompare(`${right.code}\0${right.path ?? ""}\0${right.tool ?? ""}`)
  );
}

function mergeEvidence(
  discovered: PythonProjectContext["evidence"],
  config: Awaited<ReturnType<typeof readPythonStaticProjectConfig>>
): PythonProjectContext["evidence"] {
  const entries = [...discovered];
  for (const path of config.contents.keys()) {
    const lock = /(?:\.lock|Pipfile\.lock)$/u.test(path);
    const requirements = /requirements.*\.txt$/u.test(path);
    const build = path.endsWith("pyproject.toml") && config.buildSystem?.configFile === path;
    entries.push({ path, role: lock ? "lock" : requirements ? "requirements" : build ? "build" : "config" });
  }
  const byKey = new Map(entries.map((entry) => [`${entry.path}\0${entry.role}`, entry]));
  return [...byKey.values()].sort((left, right) => `${left.path}\0${left.role}`.localeCompare(`${right.path}\0${right.role}`));
}
