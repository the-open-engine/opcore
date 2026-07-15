import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runTool } from "./process.js";
import { hasExactProtocolKeys, isProtocolRecord } from "./protocol-validation.js";

export type PythonToolResolutionSource = "configured" | "virtualenv-env" | "repo-venv" | "node-modules" | "path";

export interface PythonToolResolution {
  tool: string;
  available: boolean;
  command: string;
  args: readonly string[];
  cwd: string;
  source: PythonToolResolutionSource;
  version?: string;
  configFile?: string;
  failureMessage?: string;
}

export interface PythonToolResolverOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  pythonCommand?: string;
  targetPythonVersion?: string;
}

export type PythonInterpreterResolutionOutcome =
  | "resolved"
  | "tool_unavailable"
  | "invalid_config"
  | "timeout"
  | "unsupported_target"
  | "tool_failure";

interface PythonInterpreterResolutionBase {
  tool: "python";
  available: boolean;
  outcome: PythonInterpreterResolutionOutcome;
  command: string;
  args: readonly string[];
  cwd: string;
  source: PythonToolResolutionSource;
  version?: string;
  targetVersion?: string;
  failureMessage?: string;
}

export interface ResolvedPythonInterpreter extends PythonInterpreterResolutionBase {
  available: true;
  outcome: "resolved";
  version: string;
}

export interface UnresolvedPythonInterpreter extends PythonInterpreterResolutionBase {
  available: false;
  outcome: Exclude<PythonInterpreterResolutionOutcome, "resolved">;
  failureMessage: string;
}

export type PythonInterpreterResolution = ResolvedPythonInterpreter | UnresolvedPythonInterpreter;

const pythonVirtualEnvDirs = [".venv", "venv", "env"] as const;

const pythonConfigFileCandidates: Record<string, readonly string[]> = {
  mypy: ["mypy.ini", "setup.cfg", "tox.ini", "pyproject.toml"],
  pyright: ["pyrightconfig.json", "pyproject.toml"],
  ruff: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
  pytest: ["pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml"]
};

interface PythonToolCandidate {
  command: string;
  source: PythonToolResolutionSource;
}

const pythonInterpreterProbeScript = [
  "import json, platform, sys",
  "print(json.dumps({'protocol':'opcore.python.interpreter.v1','executable':sys.executable,'version':platform.python_version()}))"
].join("\n");

export function resolvePythonInterpreter(options: PythonToolResolverOptions): PythonInterpreterResolution {
  const invalidTarget = validateTargetVersion(options.targetPythonVersion);
  if (invalidTarget !== undefined) return interpreterFailure(options, "invalid_config", invalidTarget);

  for (const candidate of pythonInterpreterCandidates(options)) {
    if (candidate.source !== "path" && candidate.source !== "configured" && !existsSync(candidate.command)) continue;
    const resolution = probePythonInterpreter(candidate, options);
    if (resolution.outcome === "resolved") return targetCompatibleResolution(resolution, options.targetPythonVersion);
    if (candidate.source !== "path") return resolution;
    return resolution;
  }
  return interpreterFailure(options, "tool_unavailable", "No Python interpreter is available");
}

function pythonInterpreterCandidates(options: PythonToolResolverOptions): readonly PythonToolCandidate[] {
  if (options.pythonCommand !== undefined) return [{ command: options.pythonCommand, source: "configured" }];
  const candidates: PythonToolCandidate[] = [];
  const virtualEnv = options.env?.VIRTUAL_ENV;
  if (virtualEnv) candidates.push({ command: join(virtualEnv, "bin", "python"), source: "virtualenv-env" });
  for (const dir of pythonVirtualEnvDirs) {
    candidates.push({ command: join(options.repoRoot, dir, "bin", "python"), source: "repo-venv" });
  }
  candidates.push({ command: "python3", source: "path" });
  return candidates;
}

function probePythonInterpreter(
  candidate: PythonToolCandidate,
  options: PythonToolResolverOptions
): PythonInterpreterResolution {
  const args = ["-I", "-B", "-c", pythonInterpreterProbeScript];
  const result = runTool(candidate.command, args, { env: options.env, cwd: options.repoRoot });
  if (!result.ok) {
    const outcome = result.termination === "timeout"
      ? "timeout"
      : result.termination === "spawn_error" && isMissingCommand(result.failureMessage)
        ? "tool_unavailable"
        : "tool_failure";
    return interpreterFailure(options, outcome, result.failureMessage ?? "Python interpreter probe failed", candidate);
  }
  const parsed = parseInterpreterProbe(result.stdout);
  if (parsed === undefined) {
    return interpreterFailure(options, "tool_failure", "Python interpreter probe returned malformed output", candidate);
  }
  return {
    tool: "python",
    available: true,
    outcome: "resolved",
    command: parsed.executable,
    args,
    cwd: options.repoRoot,
    source: candidate.source,
    version: parsed.version,
    ...(options.targetPythonVersion === undefined ? {} : { targetVersion: options.targetPythonVersion })
  };
}

function parseInterpreterProbe(stdout: string): { executable: string; version: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!isProtocolRecord(parsed) || !hasExactProtocolKeys(parsed, ["protocol", "executable", "version"])) return undefined;
  if (parsed.protocol !== "opcore.python.interpreter.v1") return undefined;
  if (typeof parsed.executable !== "string" || !isAbsolute(parsed.executable)) return undefined;
  if (typeof parsed.version !== "string" || parsePythonVersion(parsed.version) === undefined) return undefined;
  return { executable: parsed.executable, version: parsed.version };
}

function targetCompatibleResolution(
  resolution: ResolvedPythonInterpreter,
  targetVersion: string | undefined
): PythonInterpreterResolution {
  if (targetVersion === undefined) return resolution;
  const interpreter = parsePythonVersion(resolution.version);
  const target = parsePythonVersion(targetVersion);
  if (interpreter !== undefined && target !== undefined && interpreter.major === target.major && interpreter.minor === target.minor) {
    return resolution;
  }
  return {
    ...resolution,
    available: false,
    outcome: "unsupported_target",
    failureMessage: `Selected Python ${resolution.version} cannot judge declared target Python ${targetVersion}; major/minor versions must match`
  };
}

function interpreterFailure(
  options: PythonToolResolverOptions,
  outcome: UnresolvedPythonInterpreter["outcome"],
  failureMessage: string,
  candidate: PythonToolCandidate = { command: options.pythonCommand ?? "python3", source: options.pythonCommand === undefined ? "path" : "configured" }
): UnresolvedPythonInterpreter {
  return {
    tool: "python",
    available: false,
    outcome,
    command: candidate.command,
    args: [],
    cwd: options.repoRoot,
    source: candidate.source,
    ...(options.targetPythonVersion === undefined ? {} : { targetVersion: options.targetPythonVersion }),
    failureMessage
  };
}

function validateTargetVersion(targetVersion: string | undefined): string | undefined {
  if (targetVersion === undefined) return undefined;
  return parsePythonVersion(targetVersion) === undefined
    ? `Configured Python target version must be major.minor or major.minor.patch: ${targetVersion}`
    : undefined;
}

function parsePythonVersion(value: string): { major: number; minor: number } | undefined {
  const match = /^(?<major>\d+)\.(?<minor>\d+)(?:\.\d+)?$/u.exec(value.trim());
  if (match?.groups === undefined) return undefined;
  return { major: Number(match.groups.major), minor: Number(match.groups.minor) };
}

function isMissingCommand(message: string | undefined): boolean {
  return message?.includes("ENOENT") === true || message?.includes("not found") === true;
}

export function resolvePythonTool(
  tool: string,
  fallbackCommand: string,
  versionArgs: readonly string[],
  options: PythonToolResolverOptions
): PythonToolResolution {
  const repoRoot = options.repoRoot;
  const binaryName = tool === "python" ? "python" : tool;
  const configFile = findPythonConfigFile(repoRoot, tool);
  const candidates: PythonToolCandidate[] = [];

  const virtualEnv = options.env?.VIRTUAL_ENV;
  if (virtualEnv) {
    candidates.push({ command: join(virtualEnv, "bin", binaryName), source: "virtualenv-env" });
  }
  for (const dir of pythonVirtualEnvDirs) {
    candidates.push({ command: join(repoRoot, dir, "bin", binaryName), source: "repo-venv" });
  }
  candidates.push({ command: join(repoRoot, "node_modules", ".bin", binaryName), source: "node-modules" });
  candidates.push({ command: fallbackCommand, source: "path" });

  for (const candidate of candidates) {
    if (candidate.source !== "path" && !existsSync(candidate.command)) continue;
    const result = runTool(candidate.command, versionArgs, { env: options.env, cwd: repoRoot });
    if (result.ok) {
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
      return {
        tool,
        available: true,
        command: candidate.command,
        args: versionArgs,
        cwd: repoRoot,
        source: candidate.source,
        ...(version.length > 0 ? { version } : {}),
        ...(configFile !== undefined ? { configFile } : {})
      };
    }
  }

  const failureResult = runTool(fallbackCommand, versionArgs, { env: options.env, cwd: repoRoot });
  return {
    tool,
    available: false,
    command: fallbackCommand,
    args: versionArgs,
    cwd: repoRoot,
    source: "path",
    ...(configFile !== undefined ? { configFile } : {}),
    failureMessage: failureResult.failureMessage ?? `${tool} unavailable`
  };
}

export function findPythonConfigFile(repoRoot: string, tool: string): string | undefined {
  const candidates = pythonConfigFileCandidates[tool] ?? ["pyproject.toml"];
  for (const name of candidates) {
    const candidatePath = join(repoRoot, name);
    if (existsSync(candidatePath)) return candidatePath;
  }
  return undefined;
}
