import { existsSync } from "node:fs";
import { join } from "node:path";
import { runTool } from "./process.js";

export type PythonToolResolutionSource = "virtualenv-env" | "repo-venv" | "node-modules" | "path";

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
}

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
