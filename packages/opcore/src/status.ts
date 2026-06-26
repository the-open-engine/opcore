import type {
  CommandRouterResult,
  GraphProviderStatus,
  OpcoreRepoStatePayload,
  ParsedCommandArgv,
  ValidationAdapterRuntimeStatus
} from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult } from "@the-open-engine/opcore-contracts";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { createDefaultValidationStatusPayload } from "./validation-composition.js";

declare const process: {
  cwd(): string;
};

const helpArgs = new Set(["--help", "-h", "help"]);
const skippedPathSegments = new Set([
  ".git",
  "node_modules",
  ".pnpm",
  "vendor",
  "dist",
  "target",
  ".ace",
  ".asp",
  ".lattice",
  ".opcore",
  ".rox-cache",
  ".robustness-engine-cache",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".eggs",
  "build",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "site-packages"
]);
const skippedPathSegmentSuffixes = [".egg-info", ".dist-info"];

type SourcePolicyState = "supported" | "extraction_pending" | "retained" | "unsupported";

interface SourcePolicy {
  language: string;
  graphSupported: boolean;
  validationSupported: boolean;
  retained: boolean;
  state: SourcePolicyState;
}

function supportedPolicy(language: string, graphSupported: boolean, validationSupported: boolean): SourcePolicy {
  return { language, graphSupported, validationSupported, retained: false, state: "supported" };
}

function retainedPolicy(language: string): SourcePolicy {
  return { language, graphSupported: false, validationSupported: false, retained: true, state: "retained" };
}

function extractionPendingPolicy(language: string): SourcePolicy {
  return { language, graphSupported: false, validationSupported: false, retained: false, state: "extraction_pending" };
}

function unsupportedPolicy(language: string): SourcePolicy {
  return { language, graphSupported: false, validationSupported: false, retained: false, state: "unsupported" };
}

// Keep this status policy in lockstep with crates/graph-core/src/extraction/language.rs.
const sourcePolicies = new Map<string, SourcePolicy>([
  [".ts", supportedPolicy("TypeScript", true, true)],
  [".tsx", supportedPolicy("TypeScript", true, true)],
  [".js", supportedPolicy("JavaScript", true, true)],
  [".jsx", supportedPolicy("JavaScript", true, true)],
  [".mts", supportedPolicy("TypeScript", false, true)],
  [".cts", supportedPolicy("TypeScript", false, true)],
  [".rs", supportedPolicy("Rust", false, true)],
  [".inc", supportedPolicy("Rust", false, true)],
  ["Cargo.toml", supportedPolicy("Rust", false, true)],
  ["Cargo.lock", retainedPolicy("Rust")],
  [".py", extractionPendingPolicy("Python")],
  [".pyi", extractionPendingPolicy("Python")],
  [".mjs", unsupportedPolicy("JavaScript")],
  [".cjs", unsupportedPolicy("JavaScript")],
  [".vue", unsupportedPolicy("Vue")],
  [".svelte", unsupportedPolicy("Svelte")],
  [".go", unsupportedPolicy("Go")],
  [".java", unsupportedPolicy("Java")],
  [".rb", unsupportedPolicy("Ruby")],
  [".php", unsupportedPolicy("PHP")],
  [".swift", unsupportedPolicy("Swift")],
  [".kt", unsupportedPolicy("Kotlin")],
  [".kts", unsupportedPolicy("Kotlin")],
  [".scala", unsupportedPolicy("Scala")],
  [".lua", unsupportedPolicy("Lua")],
  [".cs", unsupportedPolicy("C#")],
  [".c", unsupportedPolicy("C")],
  [".cc", unsupportedPolicy("C++")],
  [".cpp", unsupportedPolicy("C++")],
  [".h", unsupportedPolicy("C/C++ Header")],
  [".hpp", unsupportedPolicy("C++ Header")]
]);

export interface RepoResolution {
  requestedPath: string;
  root: string;
  git: boolean;
}

interface GitState {
  available: boolean;
  branch?: string;
  changed?: number;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  conflicted?: number;
  clean?: boolean;
}

interface FileCensus {
  files: readonly string[];
  git: GitState;
  traversalFailures: readonly CensusTraversalFailure[];
}

interface CensusTraversalFailure {
  path: string;
  message: string;
}

export function routeOpcoreStatus(argv: readonly string[], parsed: ParsedCommandArgv): CommandRouterResult {
  const rest = parsed.args.slice(1);
  if (rest.some((arg) => helpArgs.has(arg))) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "status", "help"],
      owner: "runtime",
      status: "ok",
      json: parsed.json,
      message: opcoreStatusHelpMessage()
    });
  }
  const parsedStatus = parseOpcoreRepoArgs(rest, "opcore status");
  if (!parsedStatus.ok) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "status"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: parsedStatus.message
    });
  }
  const resolution = resolveRepo(parsedStatus.repo, "opcore status");
  if (!resolution.ok) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "status"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: resolution.message
    });
  }

  const repoState = createRepoState(resolution.resolution);
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", "status"],
    owner: "runtime",
    status: "ok",
    json: parsed.json,
    message: formatOpcoreStatus(repoState),
    repoState
  });
}

export function parseOpcoreRepoArgs(args: readonly string[], command: string): { ok: true; repo: string } | { ok: false; message: string } {
  let repo = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (helpArgs.has(arg)) return { ok: false, message: opcoreStatusHelpMessage() };
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, message: `${command}: --repo requires a path` };
      repo = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) return { ok: false, message: `${command}: --repo requires a path` };
      repo = value;
      continue;
    }
    return { ok: false, message: `${command}: unsupported argument ${arg}` };
  }
  return { ok: true, repo };
}

export function resolveRepo(repoArg: string, command: string): { ok: true; resolution: RepoResolution } | { ok: false; message: string } {
  const requestedPath = resolve(repoArg);
  const requestedDirectory = readDirectoryMetadata(requestedPath, command);
  if (!requestedDirectory.ok) {
    return { ok: false, message: requestedDirectory.message };
  }
  if (!requestedDirectory.stat.isDirectory()) {
    return { ok: false, message: `${command}: invalid repo ${requestedPath} is not a directory` };
  }
  const gitRoot = runGit(requestedPath, ["rev-parse", "--show-toplevel"]);
  if (gitRoot.status === 0 && gitRoot.stdout.trim().length > 0) {
    const rootPath = gitRoot.stdout.trim();
    const rootDirectory = readDirectoryMetadata(rootPath, command);
    if (!rootDirectory.ok) {
      return { ok: false, message: rootDirectory.message };
    }
    if (!rootDirectory.stat.isDirectory()) {
      return { ok: false, message: `${command}: invalid repo ${rootPath} is not a directory` };
    }
    return {
      ok: true,
      resolution: {
        requestedPath: requestedDirectory.realpath,
        root: rootDirectory.realpath,
        git: true
      }
    };
  }
  return {
    ok: true,
    resolution: {
      requestedPath: requestedDirectory.realpath,
      root: requestedDirectory.realpath,
      git: false
    }
  };
}

function readDirectoryMetadata(
  path: string,
  command: string
): { ok: true; stat: ReturnType<typeof statSync>; realpath: string } | { ok: false; message: string } {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    return { ok: false, message: invalidRepoMessage(path, error, "does not exist", command) };
  }
  if (stat.isDirectory()) {
    try {
      readdirSync(path, { withFileTypes: true });
    } catch (error) {
      return { ok: false, message: `${command}: invalid repo ${path} is unreadable: ${errorMessage(error)}` };
    }
  }
  try {
    return { ok: true, stat, realpath: realpathSync(path) };
  } catch (error) {
    return { ok: false, message: `${command}: invalid repo ${path} cannot be resolved: ${errorMessage(error)}` };
  }
}

export function createRepoState(resolution: RepoResolution): OpcoreRepoStatePayload {
  const validationStatus = createDefaultValidationStatusPayload({
    repoRoot: resolution.root,
    graphMode: "optional"
  });
  const census = readRepoCensus(resolution);
  const coverage = computeCoverage(census.files);
  const graphStatus = validationStatus.graph.status;
  const validation = validationSummary(validationStatus);
  const asp = discoverAspEnrollment(resolution.root);
  const warnings = statusWarnings({ coverage, validation, graphStatus, traversalFailures: census.traversalFailures });
  const blockers = statusBlockers(graphStatus, census.traversalFailures);
  const nextActions = nextCommands(resolution.root, graphStatus, census.traversalFailures);
  const ready = graphStatus.state === "available" && validation.ready && blockers.length === 0;
  const level: OpcoreRepoStatePayload["activation"]["level"] = ready ? "ready" : blockers.length > 0 ? "blocked" : "degraded";

  return {
    schemaVersion: 1,
    repo: {
      root: resolution.root,
      requestedPath: resolution.requestedPath,
      git: census.git
    },
    coverage,
    graph: {
      state: graphStatus.state,
      mode: graphStatus.mode,
      provider: graphStatus.provider,
      action: graphAction(graphStatus),
      ...(graphStatus.message ? { message: graphStatus.message } : {}),
      status: graphStatus
    },
    validation,
    activation: {
      ready,
      level,
      summary: activationSummary(level, graphStatus, coverage.unsupported.totalFiles, census.traversalFailures),
      asp
    },
    warnings,
    blockers,
    nextActions
  };
}

function readRepoCensus(resolution: RepoResolution): FileCensus {
  if (resolution.git) {
    const traversalFailures: CensusTraversalFailure[] = [];
    const statusResult = runGit(resolution.root, ["status", "--porcelain=v1", "--branch"]);
    const status = statusResult.status === 0
      ? parseGitStatus(statusResult.stdout)
      : { available: true };
    if (statusResult.status !== 0) {
      traversalFailures.push({
        path: ".",
        message: `git status failed: ${gitFailureMessage(statusResult)}`
      });
    }
    const filesResult = runGit(resolution.root, ["ls-files", "-co", "--exclude-standard"]);
    if (filesResult.status !== 0) {
      traversalFailures.push({
        path: ".",
        message: `git file census failed: ${gitFailureMessage(filesResult)}`
      });
    }
    const files = filesResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !hasSkippedSegment(line))
      .filter((file) => fileExistsForCensus(resolution.root, file, traversalFailures));
    return { files, git: status, traversalFailures: uniqueTraversalFailures(traversalFailures) };
  }
  const census = readFilesRecursive(resolution.root);
  return {
    files: census.files,
    git: {
      available: false
    },
    traversalFailures: uniqueTraversalFailures(census.traversalFailures)
  };
}

function parseGitStatus(stdout: string): GitState {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const statusLines = lines.filter((line) => !line.startsWith("## "));
  let branch: string | undefined;
  if (branchLine) {
    branch = branchLine.slice(3).split("...")[0]?.split(" ")[0]?.trim() || undefined;
  }
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const line of statusLines) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const code = `${x}${y}`;
    if (code === "??") {
      untracked += 1;
      continue;
    }
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) conflicted += 1;
    if (x !== " " && x !== "?") staged += 1;
    if (y !== " " && y !== "?") unstaged += 1;
  }
  return {
    available: true,
    ...(branch ? { branch } : {}),
    changed: statusLines.length,
    staged,
    unstaged,
    untracked,
    conflicted,
    clean: statusLines.length === 0
  };
}

function readFilesRecursive(root: string): { files: string[]; traversalFailures: CensusTraversalFailure[] } {
  const files: string[] = [];
  const traversalFailures: CensusTraversalFailure[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      traversalFailures.push(traversalFailure(root, current, error));
      continue;
    }
    for (const entry of entries) {
      if (isSkippedPathSegment(entry.name)) continue;
      const absolute = join(current, entry.name);
      const relative = absolute.slice(root.length + 1).split(sep).join("/");
      if (hasSkippedSegment(relative)) continue;
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  return { files: files.sort(), traversalFailures };
}

function computeCoverage(files: readonly string[]): OpcoreRepoStatePayload["coverage"] {
  const graphCounts = new Map<string, number>();
  const validationCounts = new Map<string, number>();
  const unsupportedCounts = new Map<string, { language: string; count: number; examples: string[] }>();
  const languageCounts = new Map<string, { files: number; graphSupported: boolean; validationSupported: boolean }>();
  let graphSupportedFiles = 0;
  let validationSupportedFiles = 0;
  let retainedFiles = 0;

  for (const file of files) {
    const kind = fileKind(file);
    const policy = sourcePolicyForFile(file);
    const language = policy?.language;
    const graphSupported = policy?.graphSupported ?? false;
    const validationSupported = policy?.validationSupported ?? false;
    const retained = policy?.retained ?? false;

    if (graphSupported) {
      graphSupportedFiles += 1;
      increment(graphCounts, kind);
    }
    if (validationSupported) {
      validationSupportedFiles += 1;
      increment(validationCounts, kind);
    }
    if (retained) retainedFiles += 1;
    if (policy && !graphSupported && !validationSupported && !retained) {
      const current = unsupportedCounts.get(kind) ?? { language: policy.language, count: 0, examples: [] };
      current.count += 1;
      if (current.examples.length < 3) current.examples.push(file);
      unsupportedCounts.set(kind, current);
    }
    if (language) {
      const current = languageCounts.get(language) ?? {
        files: 0,
        graphSupported,
        validationSupported: validationSupported || retained
      };
      current.files += 1;
      current.graphSupported = current.graphSupported || graphSupported;
      current.validationSupported = current.validationSupported || validationSupported || retained;
      languageCounts.set(language, current);
    }
  }

  return {
    totalFiles: files.length,
    languages: [...languageCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, value]) => ({ language, ...value })),
    graph: {
      supportedFiles: graphSupportedFiles,
      extensions: countEntries(graphCounts)
    },
    validation: {
      supportedFiles: validationSupportedFiles,
      retainedFiles,
      extensions: countEntries(validationCounts)
    },
    unsupported: {
      totalFiles: [...unsupportedCounts.values()].reduce((sum, entry) => sum + entry.count, 0),
      stacks: [...unsupportedCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([extension, value]) => ({ extension, ...value }))
    }
  };
}

function validationSummary(validationStatus: ReturnType<typeof createDefaultValidationStatusPayload>): OpcoreRepoStatePayload["validation"] {
  const adapters = validationStatus.adapterRegistry.adapters ?? [];
  return {
    ready: validationStatus.ready,
    checkCount: validationStatus.adapterRegistry.checkIds.length,
    adapters: adapters.map((adapter) => ({
      adapter: adapter.adapter,
      status: adapter.status,
      checkCount: adapter.checkIds.length,
      degradedChecks: (adapter.degradedChecks ?? []).map((check) => check.checkId),
      missingTools: (adapter.toolchain ?? []).filter((tool) => !tool.available).map((tool) => tool.tool)
    })),
    degradedToolchains: adapters.flatMap((adapter) => degradedToolchains(adapter))
  };
}

function degradedToolchains(adapter: ValidationAdapterRuntimeStatus): OpcoreRepoStatePayload["validation"]["degradedToolchains"] {
  return (adapter.toolchain ?? [])
    .filter((tool) => !tool.available)
    .map((tool) => ({
      adapter: adapter.adapter,
      tool: tool.tool,
      ...(tool.failureMessage ? { failureMessage: tool.failureMessage } : {})
    }));
}

function discoverAspEnrollment(repoRoot: string): OpcoreRepoStatePayload["activation"]["asp"] {
  const candidates = [".asp/asp.json", ".asp/local.json", "asp-server.json"];
  const paths = candidates.filter((path) => existsSync(join(repoRoot, path)));
  return {
    state: paths.length > 0 ? "enrolled" : "not_enrolled",
    paths
  };
}

function statusWarnings(options: {
  coverage: OpcoreRepoStatePayload["coverage"];
  validation: OpcoreRepoStatePayload["validation"];
  graphStatus: GraphProviderStatus;
  traversalFailures: readonly CensusTraversalFailure[];
}): string[] {
  const warnings: string[] = [];
  if (options.traversalFailures.length > 0) {
    warnings.push(`Unreadable repo paths: ${formatTraversalFailurePaths(options.traversalFailures)}; coverage may be incomplete.`);
  }
  if (options.coverage.unsupported.totalFiles > 0) {
    warnings.push(
      `Unsupported stacks: ${options.coverage.unsupported.stacks.map((stack) => `${stack.language} (${stack.count})`).join(", ")}`
    );
  }
  if (options.validation.degradedToolchains.length > 0) {
    warnings.push(`Degraded Rust tools: ${options.validation.degradedToolchains.map((tool) => tool.tool).join(", ")}`);
  }
  if (options.graphStatus.state === "skipped" || options.graphStatus.state === "stale" || options.graphStatus.state === "schema_mismatch") {
    warnings.push(`Graph is ${options.graphStatus.state}; graph-backed scan/check work needs ${graphAction(options.graphStatus)}`);
  }
  return warnings;
}

function statusBlockers(graphStatus: GraphProviderStatus, traversalFailures: readonly CensusTraversalFailure[]): string[] {
  const blockers: string[] = [];
  if (traversalFailures.length > 0) {
    blockers.push(`Unreadable repo paths prevent complete coverage census: ${formatTraversalFailurePaths(traversalFailures)}`);
  }
  if (graphStatus.state === "error" || graphStatus.state === "daemon_unavailable") {
    blockers.push(graphStatus.message ?? graphStatus.failure.message);
  }
  if (graphStatus.state === "schema_mismatch") {
    blockers.push("Graph metadata schema mismatch requires rebuild.");
  }
  return blockers;
}

function nextCommands(repoRoot: string, graphStatus: GraphProviderStatus, traversalFailures: readonly CensusTraversalFailure[]): string[] {
  if (traversalFailures.length > 0) {
    return [
      `Fix permissions for unreadable repo paths: ${formatTraversalFailurePaths(traversalFailures)}`,
      `opcore status --repo ${repoRoot} --json`
    ];
  }
  if (graphStatus.state === "available") {
    return [`opcore check --changed --repo ${repoRoot} --json`, `opcore --repo ${repoRoot} --json`];
  }
  return [`opcore --repo ${repoRoot} --json`, `opcore status --repo ${repoRoot} --json`];
}

function graphAction(status: GraphProviderStatus): string {
  if (status.state === "available") return "Graph is ready.";
  if (status.state === "warming") return "Wait for graph warmup.";
  if (status.state === "stale") return "refresh graph evidence before graph-backed checks.";
  if (status.state === "schema_mismatch") return "refresh graph metadata.";
  if (status.state === "skipped" || status.state === "required_missing") return "graph evidence is unavailable.";
  return status.message ?? status.failure.message;
}

function activationSummary(
  level: OpcoreRepoStatePayload["activation"]["level"],
  graphStatus: GraphProviderStatus,
  unsupportedFiles: number,
  traversalFailures: readonly CensusTraversalFailure[]
): string {
  if (level === "ready") return unsupportedFiles > 0 ? "Repo is ready with unsupported stacks reported." : "Repo is ready.";
  if (traversalFailures.length > 0) return "Repo activation is blocked: unreadable repo paths prevent complete coverage census.";
  if (level === "blocked") return `Repo activation is blocked: ${graphAction(graphStatus)}`;
  return `Repo activation is degraded: ${graphAction(graphStatus)}`;
}

export function formatOpcoreStatus(repoState: OpcoreRepoStatePayload): string {
  const unsupported = repoState.coverage.unsupported.stacks.length === 0
    ? "none"
    : repoState.coverage.unsupported.stacks.map((stack) => `${stack.language} ${stack.count}`).join(", ");
  const adapters = repoState.validation.adapters.length === 0
    ? "none"
    : repoState.validation.adapters.map((adapter) => `${adapter.adapter}:${adapter.status}`).join(", ");
  const rustTools = repoState.validation.degradedToolchains.length === 0
    ? "none"
    : repoState.validation.degradedToolchains.map((tool) => tool.tool).join(", ");
  const git = repoState.repo.git.available
    ? `git ${repoState.repo.git.branch ?? "unknown"} changed=${repoState.repo.git.changed ?? 0} staged=${repoState.repo.git.staged ?? 0} unstaged=${repoState.repo.git.unstaged ?? 0} untracked=${repoState.repo.git.untracked ?? 0}`
    : "non-Git repo";
  return [
    "opcore status",
    `Repo: ${repoState.repo.root} (${git})`,
    `Coverage: files=${repoState.coverage.totalFiles} graph=${repoState.coverage.graph.supportedFiles} validation=${repoState.coverage.validation.supportedFiles} retained=${repoState.coverage.validation.retainedFiles} unsupported=${unsupported}`,
    `Graph: ${repoState.graph.state}; ${repoState.graph.action}`,
    `Validation: checks=${repoState.validation.checkCount} adapters=${adapters} degradedRustTools=${rustTools}`,
    `ASP: ${repoState.activation.asp.state}${repoState.activation.asp.paths.length > 0 ? ` (${repoState.activation.asp.paths.join(", ")})` : ""}`,
    `Activation: ${repoState.activation.level}; ${repoState.activation.summary}`,
    "Next:",
    ...repoState.nextActions.slice(0, 2).map((action) => `  ${action}`)
  ].join("\n");
}

function opcoreStatusHelpMessage(): string {
  return "opcore status [--repo <path>] [--json]";
}

function runGit(cwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function fileExistsForCensus(root: string, file: string, traversalFailures: CensusTraversalFailure[]): boolean {
  try {
    return statSync(join(root, file)).isFile();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      traversalFailures.push({
        path: file,
        message: errorMessage(error)
      });
    }
    return false;
  }
}

function traversalFailure(root: string, absolutePath: string, error: unknown): CensusTraversalFailure {
  const relativePath = absolutePath === root ? "." : absolutePath.slice(root.length + 1).split(sep).join("/");
  return {
    path: relativePath,
    message: errorMessage(error)
  };
}

function uniqueTraversalFailures(failures: readonly CensusTraversalFailure[]): CensusTraversalFailure[] {
  const seen = new Set<string>();
  const unique: CensusTraversalFailure[] = [];
  for (const failure of failures) {
    const key = `${failure.path}\0${failure.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(failure);
  }
  return unique;
}

function formatTraversalFailurePaths(failures: readonly CensusTraversalFailure[]): string {
  const paths = [...new Set(failures.map((failure) => failure.path))].sort();
  const visible = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${visible}, +${paths.length - 5} more` : visible;
}

function gitFailureMessage(result: { status: number | null; stdout: string; stderr: string }): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail : `exit ${result.status ?? "unknown"}`;
}

function hasSkippedSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => isSkippedPathSegment(segment));
}

function isSkippedPathSegment(segment: string): boolean {
  return skippedPathSegments.has(segment) || skippedPathSegmentSuffixes.some((suffix) => segment.endsWith(suffix));
}

function fileKind(file: string): string {
  const name = basename(file);
  if (name === "Cargo.toml" || name === "Cargo.lock") return name;
  return extname(name);
}

function sourcePolicyForFile(file: string): SourcePolicy | undefined {
  return sourcePolicies.get(fileKind(file));
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function countEntries(map: Map<string, number>): { extension: string; count: number }[] {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([extension, count]) => ({ extension, count }));
}

function invalidRepoMessage(path: string, error: unknown, notFoundFallback: string, command: string): string {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return `${command}: invalid repo ${path} ${notFoundFallback}`;
  }
  return `${command}: invalid repo ${path}: ${errorMessage(error)}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : String(error);
}
