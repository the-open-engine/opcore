import type {
  PythonInterpreterProvenance,
  PythonProjectBuildSystem,
  PythonProjectContextReason,
  PythonProjectExecutableSource,
  PythonProjectManagerEvidence,
  PythonProjectTarget,
  PythonProjectToolKind,
  PythonProjectToolProvenance
} from "@the-open-engine/opcore-contracts";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { runTool, type PythonToolRunOptions, type PythonToolRunResult } from "./process.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";
import { isSupportedPythonVersionConstraint, pythonVersionSatisfiesConstraint } from "./version-constraint.js";

export interface PythonProjectProcessProbe {
  run(command: string, args: readonly string[], options: PythonToolRunOptions): PythonToolRunResult;
  resolveExecutable?(command: string, options: { env: Readonly<Record<string, string | undefined>>; platform: string }): string | undefined;
}

export interface PythonProjectEnvironmentOptions {
  repoRoot: string;
  projectRoot: string;
  workspace: PythonProjectWorkspace;
  platform?: string;
  architecture?: string;
  env?: Readonly<Record<string, string | undefined>>;
  interpreterArgv?: readonly string[];
  toolArgv?: Partial<Record<PythonProjectToolKind, readonly string[]>>;
  target: PythonProjectTarget;
  managers: readonly PythonProjectManagerEvidence[];
  toolConfigs: Readonly<Record<"mypy" | "pyright" | "ruff" | "pytest", string | undefined>>;
  buildSystem?: PythonProjectBuildSystem;
  processProbe?: PythonProjectProcessProbe;
  timeoutMs?: number;
}

export interface PythonProjectEnvironmentResolution {
  interpreter?: PythonInterpreterProvenance;
  tools: readonly PythonProjectToolProvenance[];
  reasons: readonly PythonProjectContextReason[];
  fingerprintInput: unknown;
}

interface ExecutableCandidate {
  argv: readonly string[];
  source: PythonProjectExecutableSource;
}

interface ManagerExecutableCandidates {
  interpreters: readonly ExecutableCandidate[];
  tools: Readonly<Partial<Record<PythonProjectToolKind, readonly ExecutableCandidate[]>>>;
}

const interpreterProbeScript = [
  "import json, platform, sys, sysconfig",
  "print(json.dumps({'protocol':'opcore.python.project-context.interpreter.v1','executable':sys.executable,'version':platform.python_version(),'implementation':platform.python_implementation(),'platform':sys.platform,'architecture':platform.machine(),'abi':getattr(sys.implementation,'cache_tag',None),'soabi':sysconfig.get_config_var('SOABI')}))"
].join("\n");

const buildProbeScript = [
  "import importlib.metadata, importlib.util, json",
  "available = importlib.util.find_spec('build') is not None",
  "version = None",
  "if available:",
  "    try:",
  "        version = importlib.metadata.version('build')",
  "    except importlib.metadata.PackageNotFoundError:",
  "        pass",
  "print(json.dumps({'protocol':'opcore.python.project-context.build.v1','available':available,'version':version}))"
].join("\n");

export async function resolvePythonProjectEnvironment(
  options: PythonProjectEnvironmentOptions
): Promise<PythonProjectEnvironmentResolution> {
  const env = effectiveProcessEnvironment(options.env);
  const effectiveOptions = { ...options, env };
  const platform = options.platform ?? process.platform;
  if (!["linux", "darwin", "win32"].includes(platform)) {
    return {
      tools: [],
      reasons: [{ code: "unsupported_platform", message: `Unsupported Python project platform: ${platform}` }],
      fingerprintInput: {
        platform,
        architecture: options.architecture,
        environment: sanitizedFingerprintEnvironment(env, options.projectRoot),
        explicit: { interpreterArgv: options.interpreterArgv, toolArgv: options.toolArgv }
      }
    };
  }
  const processProbe = options.processProbe ?? { run: runTool, resolveExecutable: resolvePathExecutable };
  const reasons: PythonProjectContextReason[] = [];
  const managerCandidates = await resolveManagerExecutableCandidates(effectiveOptions, reasons);
  const interpreter = await resolveInterpreter(effectiveOptions, processProbe, env, managerCandidates, reasons);
  const tools = await resolveTools(effectiveOptions, processProbe, env, interpreter, managerCandidates, reasons);
  return {
    ...(interpreter === undefined ? {} : { interpreter }),
    tools,
    reasons,
    fingerprintInput: {
      platform: options.platform ?? process.platform,
      architecture: options.architecture,
      environment: sanitizedFingerprintEnvironment(env, options.projectRoot),
      explicit: { interpreterArgv: options.interpreterArgv, toolArgv: options.toolArgv },
      interpreter,
      tools,
      failures: reasons.map((reason) => ({ code: reason.code, tool: reason.tool }))
    }
  };
}

async function resolveInterpreter(
  options: PythonProjectEnvironmentOptions,
  processProbe: PythonProjectProcessProbe,
  env: Record<string, string | undefined>,
  managerCandidates: ManagerExecutableCandidates,
  reasons: PythonProjectContextReason[]
): Promise<PythonInterpreterProvenance | undefined> {
  const candidates = interpreterCandidates(options, managerCandidates, reasons);
  if (options.interpreterArgv !== undefined && candidates.length === 0) return undefined;
  let pathFailure: PythonProjectContextReason | undefined;
  for (const candidate of candidates) {
    if (!(await candidateAvailable(options.workspace, candidate.argv[0]))) continue;
    const command = candidate.argv[0];
    const prefix = candidate.argv.slice(1);
    const args = [...prefix, "-I", "-B", "-c", interpreterProbeScript];
    const result = processProbe.run(command, args, {
      cwd: projectCwd(options), env, timeoutMs: options.timeoutMs ?? 10000
    });
    if (!result.ok) {
      const failure = probeFailureReason(result, "python");
      if (candidate.source !== "path") {
        reasons.push(failure);
        return undefined;
      }
      pathFailure = failure;
      continue;
    }
    const metadata = parseInterpreterMetadata(result.stdout);
    if (metadata === undefined) {
      const failure = {
        code: "malformed_probe_output" as const,
        tool: "python",
        message: "Python interpreter probe returned malformed metadata"
      };
      if (candidate.source !== "path") {
        reasons.push(failure);
        return undefined;
      }
      pathFailure = failure;
      continue;
    }
    const runnable = runnableInterpreterArgv(candidate, metadata.executable, processProbe, env, options.platform ?? process.platform);
    const provenance: PythonInterpreterProvenance = {
      executable: runnable[0],
      argv: runnable,
      cwd: projectCwd(options),
      source: candidate.source,
      version: metadata.version,
      implementation: metadata.implementation,
      platform: metadata.platform,
      architecture: metadata.architecture,
      abi: metadata.abi,
      soabi: metadata.soabi
    };
    const unsupported = unsupportedTargetConstraint(options.target);
    if (unsupported !== undefined) {
      reasons.push({ code: "unsupported_target", tool: "python", message: unsupported });
      return provenance;
    }
    const incompatibility = targetIncompatibility(provenance, options.target);
    if (incompatibility !== undefined) {
      reasons.push({ code: "incompatible_interpreter", tool: "python", message: incompatibility });
      return provenance;
    }
    return provenance;
  }
  if (pathFailure !== undefined) reasons.push(pathFailure);
  reasons.push({ code: "interpreter_unavailable", tool: "python", message: `No Python interpreter is available for ${options.projectRoot}` });
  return undefined;
}

function unsupportedTargetConstraint(target: PythonProjectTarget): string | undefined {
  for (const constraint of [target.requiresPython, target.version]) {
    if (constraint === undefined) continue;
    if (!isSupportedPythonVersionConstraint(constraint)) {
      return `Unsupported Python target constraint: ${constraint}`;
    }
  }
  return undefined;
}

async function resolveTools(
  options: PythonProjectEnvironmentOptions,
  processProbe: PythonProjectProcessProbe,
  env: Record<string, string | undefined>,
  interpreter: PythonInterpreterProvenance | undefined,
  managerCandidates: ManagerExecutableCandidates,
  reasons: PythonProjectContextReason[]
): Promise<readonly PythonProjectToolProvenance[]> {
  const toolKinds: PythonProjectToolKind[] = ["mypy", "pyright", "ruff", "pytest"];
  const tools: PythonProjectToolProvenance[] = [];
  for (const tool of toolKinds) {
    const configFile = tool === "mypy" || tool === "pyright" || tool === "ruff" || tool === "pytest"
      ? options.toolConfigs[tool]
      : undefined;
    const candidates = toolCandidates(tool, options, managerCandidates, reasons);
    if (options.toolArgv?.[tool] !== undefined && candidates.length === 0) {
      const override = options.toolArgv[tool];
      if (override === undefined) throw new Error(`Python ${tool} argv override is required`);
      tools.push({
        tool,
        available: false,
        executable: override[0],
        argv: [...override],
        cwd: projectCwd(options),
        source: "explicit_override",
        ...(configFile === undefined ? {} : { configFile })
      });
      continue;
    }
    let resolvedTool: PythonProjectToolProvenance | undefined;
    let failure: PythonProjectContextReason | undefined;
    for (const candidate of candidates) {
      if (!(await candidateAvailable(options.workspace, candidate.argv[0]))) continue;
      const command = candidate.argv[0];
      const prefix = candidate.argv.slice(1);
      const result = processProbe.run(command, [...prefix, "--version"], {
        cwd: projectCwd(options), env, timeoutMs: options.timeoutMs ?? 10000
      });
      if (!result.ok) {
        failure = probeFailureReason(result, tool);
        if (candidate.source !== "path") break;
        continue;
      }
      const version = firstVersion(result.stdout, result.stderr);
      if (version === undefined) {
        failure = {
          code: "malformed_probe_output",
          tool,
          message: `${tool} version probe returned malformed metadata`
        };
        if (candidate.source !== "path") break;
        continue;
      }
      const executable = candidate.source === "path"
        ? processProbe.resolveExecutable?.(command, { env, platform: options.platform ?? process.platform }) ?? command
        : command;
      resolvedTool = {
        tool,
        available: true,
        executable,
        argv: [executable, ...prefix],
        cwd: projectCwd(options),
        source: candidate.source,
        version,
        ...(configFile === undefined ? {} : { configFile })
      };
      break;
    }
    if (resolvedTool !== undefined) {
      tools.push(resolvedTool);
      continue;
    }
    const fallback = candidates[0] ?? { argv: [tool], source: "path" as const };
    tools.push({
      tool,
      available: false,
      executable: fallback.argv[0],
      argv: fallback.argv,
      cwd: projectCwd(options),
      source: fallback.source,
      ...(configFile === undefined ? {} : { configFile })
    });
    reasons.push(failure ?? { code: "tool_unavailable", tool, message: `${tool} is unavailable for ${options.projectRoot}` });
  }
  if (options.buildSystem !== undefined) {
    tools.push(resolveBuildTool(options, processProbe, env, interpreter, reasons));
  }
  return tools.sort((left, right) => left.tool.localeCompare(right.tool));
}

function runnableInterpreterArgv(
  candidate: ExecutableCandidate,
  probedExecutable: string,
  processProbe: PythonProjectProcessProbe,
  env: Readonly<Record<string, string | undefined>>,
  platform: string
): readonly string[] {
  const [command, ...args] = candidate.argv;
  if (args.length === 0) return [probedExecutable];
  const launcher = processProbe.resolveExecutable?.(command, { env, platform }) ??
    (isAbsolute(command) || /^[A-Za-z]:[\\/]/u.test(command) ? command : undefined);
  return launcher === undefined ? [probedExecutable] : [launcher, ...args];
}

function resolveBuildTool(
  options: PythonProjectEnvironmentOptions,
  processProbe: PythonProjectProcessProbe,
  env: Record<string, string | undefined>,
  interpreter: PythonInterpreterProvenance | undefined,
  reasons: PythonProjectContextReason[]
): PythonProjectToolProvenance {
  const buildSystem = options.buildSystem;
  if (buildSystem === undefined) throw new Error("Python build tool resolution requires build-system metadata");
  const fallbackExecutable = interpreter?.executable ?? "python";
  const fallbackArgv = interpreter === undefined ? [fallbackExecutable, "-m", "build"] : [...interpreter.argv, "-m", "build"];
  if (interpreter === undefined) {
    reasons.push({ code: "tool_unavailable", tool: "build", message: `build is unavailable without an interpreter for ${options.projectRoot}` });
    return {
      tool: "build",
      available: false,
      executable: fallbackExecutable,
      argv: fallbackArgv,
      cwd: projectCwd(options),
      source: "path",
      configFile: buildSystem.configFile
    };
  }
  const result = processProbe.run(interpreter.executable, [...interpreter.argv.slice(1), "-I", "-B", "-c", buildProbeScript], {
    cwd: interpreter.cwd,
    env,
    timeoutMs: options.timeoutMs ?? 10000
  });
  if (!result.ok) {
    reasons.push(probeFailureReason(result, "build"));
    return {
      tool: "build",
      available: false,
      executable: interpreter.executable,
      argv: [...interpreter.argv, "-m", "build"],
      cwd: interpreter.cwd,
      source: interpreter.source,
      configFile: buildSystem.configFile
    };
  }
  const metadata = parseBuildMetadata(result.stdout);
  if (metadata === undefined) {
    reasons.push({ code: "malformed_probe_output", tool: "build", message: "Python build probe returned malformed metadata" });
  } else if (!metadata.available) {
    reasons.push({ code: "tool_unavailable", tool: "build", message: `build is unavailable for ${options.projectRoot}` });
  }
  return {
    tool: "build",
    available: metadata?.available === true,
    executable: interpreter.executable,
    argv: [...interpreter.argv, "-m", "build"],
    cwd: interpreter.cwd,
    source: interpreter.source,
    ...(metadata?.version === undefined ? {} : { version: metadata.version }),
    configFile: buildSystem.configFile
  };
}

function parseBuildMetadata(stdout: string): { available: boolean; version?: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.protocol !== "opcore.python.project-context.build.v1" || typeof record.available !== "boolean") return undefined;
  if (record.version !== null && record.version !== undefined && (typeof record.version !== "string" || record.version.length === 0)) {
    return undefined;
  }
  if (record.available && typeof record.version !== "string") return undefined;
  if (typeof record.version === "string" && !isExactToolVersion(record.version)) return undefined;
  return { available: record.available, ...(typeof record.version === "string" ? { version: record.version } : {}) };
}

function resolvePathExecutable(
  command: string,
  options: { env: Readonly<Record<string, string | undefined>>; platform: string }
): string | undefined {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return existsSync(command) ? command : undefined;
  const path = options.env.PATH;
  if (path === undefined) return undefined;
  const extensions = options.platform === "win32"
    ? (options.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, options.platform === "win32" ? `${command}${extension}` : command);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function interpreterCandidates(
  options: PythonProjectEnvironmentOptions,
  managerCandidates: ManagerExecutableCandidates,
  reasons: PythonProjectContextReason[]
): readonly ExecutableCandidate[] {
  if (options.interpreterArgv !== undefined) {
    const override = validateOverride(options.interpreterArgv, "interpreter", reasons);
    return override === undefined ? [] : [override];
  }
  const candidates: ExecutableCandidate[] = [];
  const active = options.env?.VIRTUAL_ENV;
  if (active !== undefined && activeEnvironmentCompatible(active, options)) {
    candidates.push(...environmentInterpreterExecutables(active, options.platform).map((executable) => ({
      argv: [executable],
      source: "active_environment" as const
    })));
  }
  for (const directory of [".venv", "venv", "env"]) {
    candidates.push(...projectEnvironmentInterpreterExecutables(options, directory).map((executable) => ({
      argv: [executable],
      source: "project_local_environment" as const
    })));
  }
  candidates.push(...managerCandidates.interpreters);
  candidates.push({ argv: [options.platform === "win32" ? "python" : "python3"], source: "path" });
  if (options.platform !== "win32") candidates.push({ argv: ["python"], source: "path" });
  return candidates;
}

function toolCandidates(
  tool: PythonProjectToolKind,
  options: PythonProjectEnvironmentOptions,
  managerCandidates: ManagerExecutableCandidates,
  reasons: PythonProjectContextReason[]
): readonly ExecutableCandidate[] {
  const override = options.toolArgv?.[tool];
  if (override !== undefined) {
    const candidate = validateOverride(override, tool, reasons);
    return candidate === undefined ? [] : [candidate];
  }
  const candidates: ExecutableCandidate[] = [];
  const active = options.env?.VIRTUAL_ENV;
  if (active !== undefined && activeEnvironmentCompatible(active, options)) {
    candidates.push({ argv: [environmentExecutable(active, tool, options.platform)], source: "active_environment" });
  }
  for (const directory of [".venv", "venv", "env"]) {
    candidates.push({ argv: [projectEnvironmentExecutable(options, directory, tool)], source: "project_local_environment" });
  }
  if (tool === "pyright") {
    candidates.push({ argv: [absoluteProjectPath(options, "node_modules/.bin/pyright")], source: "project_local_environment" });
  }
  candidates.push(...managerCandidates.tools[tool] ?? []);
  candidates.push({ argv: [tool], source: "path" });
  return candidates;
}

async function resolveManagerExecutableCandidates(
  options: PythonProjectEnvironmentOptions,
  reasons: PythonProjectContextReason[]
): Promise<ManagerExecutableCandidates> {
  const uv = options.env?.UV_PROJECT_ENVIRONMENT;
  if (uv !== undefined && activeEnvironmentCompatible(uv, options)) {
    return environmentCandidates(uv, options.platform);
  }
  if (options.managers.some((manager) => manager.kind === "pdm")) {
    const pdmPath = options.projectRoot === "." ? ".pdm-python" : `${options.projectRoot}/.pdm-python`;
    if (!(await options.workspace.exists(pdmPath))) return emptyManagerCandidates();
    const resolved = await options.workspace.realpath(pdmPath);
    if (resolved.unavailable) {
      reasons.push({
        code: "ambiguous_path",
        path: pdmPath,
        message: `PDM interpreter evidence realpath is unavailable: ${pdmPath}`
      });
      return emptyManagerCandidates();
    }
    if (resolved.symlink || resolved.path !== pdmPath) {
      reasons.push({
        code: "symlink_refused",
        path: pdmPath,
        message: `Symlinked PDM interpreter evidence is ambiguous: ${pdmPath}`
      });
      return emptyManagerCandidates();
    }
    const content = (await options.workspace.read(pdmPath))?.trim();
    if (content !== undefined && content.length > 0 && !content.includes("\0")) {
      return interpreterPathCandidates(content, options.platform);
    }
  }
  return emptyManagerCandidates();
}

function environmentCandidates(environment: string, platform: string | undefined): ManagerExecutableCandidates {
  return {
    interpreters: environmentInterpreterExecutables(environment, platform).map((executable) => ({
      argv: [executable],
      source: "manager_environment" as const
    })),
    tools: managerToolKinds().reduce<Partial<Record<PythonProjectToolKind, readonly ExecutableCandidate[]>>>((tools, tool) => {
      tools[tool] = [{ argv: [environmentExecutable(environment, tool, platform)], source: "manager_environment" }];
      return tools;
    }, {})
  };
}

function interpreterPathCandidates(interpreter: string, platform: string | undefined): ManagerExecutableCandidates {
  return {
    interpreters: [{ argv: [interpreter], source: "manager_environment" }],
    tools: managerToolKinds().reduce<Partial<Record<PythonProjectToolKind, readonly ExecutableCandidate[]>>>((tools, tool) => {
      tools[tool] = [{ argv: [toolBesideInterpreter(interpreter, tool, platform)], source: "manager_environment" }];
      return tools;
    }, {})
  };
}

function emptyManagerCandidates(): ManagerExecutableCandidates {
  return { interpreters: [], tools: {} };
}

function managerToolKinds(): readonly Exclude<PythonProjectToolKind, "build">[] {
  return ["mypy", "pyright", "ruff", "pytest"];
}

function toolBesideInterpreter(interpreter: string, tool: string, platform: string | undefined): string {
  const normalized = interpreter.replaceAll("\\", "/");
  const directory = normalized.slice(0, normalized.lastIndexOf("/"));
  if (platform === "win32") {
    const scriptsDirectory = directory.toLowerCase().endsWith("/scripts") ? directory : `${directory}/Scripts`;
    return `${scriptsDirectory}/${tool}.exe`.replaceAll("/", "\\");
  }
  return `${directory}/${tool}`;
}

function parseInterpreterMetadata(stdout: string): {
  executable: string; version: string; implementation: string; platform: string; architecture: string; abi: string; soabi: string;
} | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.protocol !== "opcore.python.project-context.interpreter.v1") return undefined;
  for (const key of ["executable", "version", "implementation", "platform", "architecture"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) return undefined;
  }
  if (!isAbsolute(record.executable as string) && !/^[A-Za-z]:[\\/]/u.test(record.executable as string)) return undefined;
  if (!isExactPythonInterpreterVersion(record.version as string)) return undefined;
  for (const key of ["abi", "soabi"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) return undefined;
  }
  return {
    executable: record.executable as string,
    version: record.version as string,
    implementation: record.implementation as string,
    platform: record.platform as string,
    architecture: record.architecture as string,
    abi: record.abi as string,
    soabi: record.soabi as string
  };
}

function targetIncompatibility(interpreter: PythonInterpreterProvenance, target: PythonProjectTarget): string | undefined {
  if (target.implementation !== undefined && interpreter.implementation !== undefined &&
      target.implementation.toLowerCase() !== interpreter.implementation.toLowerCase()) {
    return `Selected ${interpreter.implementation} does not satisfy target implementation ${target.implementation}`;
  }
  if (target.platform !== undefined && interpreter.platform !== undefined && !platformMatches(interpreter.platform, target.platform)) {
    return `Selected platform ${interpreter.platform} does not satisfy target platform ${target.platform}`;
  }
  if (target.requiresPython !== undefined && interpreter.version !== undefined &&
      !pythonVersionSatisfiesConstraint(interpreter.version, target.requiresPython)) {
    return `Selected Python ${interpreter.version} does not satisfy ${target.requiresPython}`;
  }
  if (target.version !== undefined && interpreter.version !== undefined &&
      !pythonVersionMatchesTarget(interpreter.version, target.version)) {
    return `Selected Python ${interpreter.version} does not satisfy ${target.version}`;
  }
  return undefined;
}

function pythonVersionMatchesTarget(version: string, target: string): boolean {
  const normalized = target.trim();
  const constraint = /^\d+\.\d+$/u.test(normalized) ? `==${normalized}.*` : normalized;
  return pythonVersionSatisfiesConstraint(version, constraint);
}

function isExactPythonInterpreterVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?(?:\+[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)?$/u.test(value);
}

function isExactToolVersion(value: string): boolean {
  return /^\d+(?:\.\d+)+(?:[-+._A-Za-z0-9]*)?$/u.test(value);
}

function platformMatches(actual: string, expected: string): boolean {
  const normalized = expected.toLowerCase();
  return actual.toLowerCase() === normalized || (normalized === "linux" && actual.startsWith("linux")) ||
    (normalized === "windows" && actual === "win32") || (normalized === "darwin" && actual === "darwin");
}

function probeFailureReason(result: PythonToolRunResult, tool: string): PythonProjectContextReason {
  if (result.termination === "timeout") return { code: "probe_timeout", tool, message: `${tool} probe timed out` };
  if (result.termination === "signal") return { code: "probe_signal", tool, message: `${tool} probe terminated with signal ${result.signal}` };
  if (result.termination === "spawn_error") {
    return missingCommand(result.failureMessage)
      ? { code: "tool_unavailable", tool, message: `${tool} is unavailable` }
      : { code: "probe_spawn_failure", tool, message: `${tool} probe could not spawn` };
  }
  return { code: "probe_exit_failure", tool, message: `${tool} probe exited with code ${result.exitCode}` };
}

function firstVersion(stdout: string, stderr: string): string | undefined {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
  const version = line === undefined ? undefined : /\b\d+(?:\.\d+)+(?:[-+._A-Za-z0-9]*)?/u.exec(line)?.[0];
  return version;
}

function validateOverride(
  argv: readonly string[],
  label: "interpreter" | PythonProjectToolKind,
  reasons: PythonProjectContextReason[]
): ExecutableCandidate | undefined {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`Python ${label} argv override must be a non-empty string array`);
  }
  if (!safeOverrideArgv(argv, label)) {
    reasons.push({
      code: "invalid_config",
      tool: label === "interpreter" ? "python" : label,
      message: `Unsafe Python ${label} argv override was refused without execution`
    });
    return undefined;
  }
  return { argv: [...argv], source: "explicit_override" };
}

function activeEnvironmentCompatible(environment: string, options: PythonProjectEnvironmentOptions): boolean {
  const caseFold = (value: string): string => options.platform === "win32" ? value.toLowerCase() : value;
  const envPath = caseFold(normalizePath(environment));
  const root = caseFold(normalizePath(projectCwd(options)));
  if (!envPath.startsWith(`${root}/`)) return false;
  const relativeEnvironment = envPath.slice(root.length + 1);
  return relativeEnvironment.length > 0 && !relativeEnvironment.includes("/");
}

function safeOverrideArgv(argv: readonly string[], label: "interpreter" | PythonProjectToolKind): boolean {
  const executable = executableBasename(argv[0]);
  const prefix = argv.slice(1);
  if (label === "interpreter") {
    if (!/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/u.test(executable)) return false;
    return safePythonOptionPrefix(prefix);
  }
  if (label === "build" || executable !== label && executable !== `${label}.exe`) return false;
  return safeToolOptionPrefix(label, prefix);
}

function executableBasename(command: string): string {
  const normalized = command.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function safePythonOptionPrefix(args: readonly string[]): boolean {
  const switches = new Set(["-B", "-E", "-I", "-O", "-OO", "-P", "-S", "-s", "-u", "-v", "-q", "-b", "-bb", "-d", "-x"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (switches.has(argument)) continue;
    if (argument === "-X" && args[index + 1] === "dev") {
      index += 1;
      continue;
    }
    if (argument === "-Xdev") continue;
    return false;
  }
  return true;
}

function safeToolOptionPrefix(tool: Exclude<PythonProjectToolKind, "build">, args: readonly string[]): boolean {
  const valuedOptions: Readonly<Record<Exclude<PythonProjectToolKind, "build">, readonly string[]>> = {
    mypy: ["--config", "--config-file"],
    pyright: ["--project", "-p"],
    ruff: ["--config"],
    pytest: ["--config-file", "-c"]
  };
  const options = valuedOptions[tool];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const exact = options.find((option) => argument === option);
    if (exact !== undefined) {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-")) return false;
      index += 1;
      continue;
    }
    if (options.some((option) => argument.startsWith(`${option}=`) && argument.length > option.length + 1)) continue;
    return false;
  }
  return true;
}

function environmentExecutable(environment: string, tool: string, platform: string | undefined): string {
  const suffix = platform === "win32" ? `Scripts/${tool}.exe` : `bin/${tool}`;
  return joinAbsolute(environment, suffix, platform);
}

function environmentInterpreterExecutables(environment: string, platform: string | undefined): readonly string[] {
  if (platform === "win32") {
    return [
      joinAbsolute(environment, "Scripts/python.exe", platform),
      joinAbsolute(environment, "python.exe", platform)
    ];
  }
  return [joinAbsolute(environment, "bin/python", platform), joinAbsolute(environment, "bin/python3", platform)];
}

function projectEnvironmentInterpreterExecutables(
  options: PythonProjectEnvironmentOptions,
  directory: string
): readonly string[] {
  const project = options.projectRoot === "." ? "" : `${options.projectRoot}/`;
  const environment = joinAbsolute(options.repoRoot, `${project}${directory}`, options.platform);
  return environmentInterpreterExecutables(environment, options.platform);
}

function projectEnvironmentExecutable(options: PythonProjectEnvironmentOptions, directory: string, tool: string): string {
  const suffix = options.platform === "win32" ? `${directory}/Scripts/${tool}.exe` : `${directory}/bin/${tool}`;
  return absoluteProjectPath(options, suffix);
}

function absoluteProjectPath(options: PythonProjectEnvironmentOptions, suffix: string): string {
  const project = options.projectRoot === "." ? "" : `${options.projectRoot}/`;
  return joinAbsolute(options.repoRoot, `${project}${suffix}`, options.platform);
}

function projectCwd(options: PythonProjectEnvironmentOptions): string {
  return options.projectRoot === "." ? options.repoRoot : joinAbsolute(options.repoRoot, options.projectRoot, options.platform);
}

function joinAbsolute(root: string, suffix: string, platform: string | undefined): string {
  if (platform === "win32") return `${root.replace(/[\\/]+$/u, "")}\\${suffix.replaceAll("/", "\\")}`;
  return resolve(root, suffix);
}

async function candidateAvailable(workspace: PythonProjectWorkspace, command: string): Promise<boolean> {
  return workspace.executableExists(command);
}

function effectiveProcessEnvironment(env: Readonly<Record<string, string | undefined>> | undefined): Record<string, string | undefined> {
  if (env === undefined) return { ...process.env };
  return { ...env };
}

function sanitizedFingerprintEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
  projectRoot: string
): Record<string, string | boolean> {
  const selected: Record<string, string | boolean> = {};
  for (const key of ["VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "PDM_VENV_IN_PROJECT", "POETRY_ACTIVE", "PIPENV_ACTIVE"] as const) {
    const value = env?.[key];
    if (value === undefined) continue;
    selected[key] = key.endsWith("ACTIVE") || key === "PDM_VENV_IN_PROJECT" ? value === "1" || value === "true" : normalizePath(value);
  }
  selected.projectRoot = projectRoot;
  selected.pathProvided = env?.PATH !== undefined;
  return selected;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/u, "");
}

function missingCommand(message: string | undefined): boolean {
  return message?.includes("ENOENT") === true || message?.toLowerCase().includes("not found") === true;
}
