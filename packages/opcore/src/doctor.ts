import type { CommandRouterResult, OpcoreDoctorPayload, ParsedCommandArgv } from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult } from "@the-open-engine/opcore-contracts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readOpcoreRuntimeInfo } from "./runtime-info.js";
import { resolveRepo, validationPolicySummary } from "./status.js";
import { createDefaultValidationStatusPayload } from "./validation-composition.js";

declare const process: {
  cwd(): string;
};

const helpArgs = new Set(["--help", "-h", "help"]);
const generatedStateIgnores = [
  ".opcore/",
  ".rox-cache/",
  ".robustness-engine-cache/"
];

export function routeOpcoreDoctor(argv: readonly string[], parsed: ParsedCommandArgv): CommandRouterResult {
  const rest = parsed.args.slice(1);
  if (rest.some((arg) => helpArgs.has(arg))) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "doctor", "help"],
      owner: "runtime",
      status: "ok",
      json: parsed.json,
      message: opcoreDoctorHelpMessage()
    });
  }
  const parsedDoctor = parseDoctorArgs(rest);
  if (!parsedDoctor.ok) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "doctor"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: parsedDoctor.message
    });
  }
  const resolution = resolveRepo(parsedDoctor.repo, "opcore doctor");
  if (!resolution.ok) {
    return createCommandRouterResult({
      bin: "opcore",
      argv,
      canonicalCommand: ["opcore", "doctor"],
      owner: "runtime",
      status: "error",
      json: parsed.json,
      message: resolution.message
    });
  }

  const validationStatus = createDefaultValidationStatusPayload({
    repoRoot: resolution.resolution.root,
    graphMode: "optional"
  });
  const runtimeInfo = readOpcoreRuntimeInfo();
  const policy = validationPolicySummary(resolution.resolution.root, validationStatus.adapterRegistry.checkIds);
  const opcoreDoctor: OpcoreDoctorPayload = {
    schemaVersion: 1,
    runtime: runtimeInfo,
    repo: {
      root: resolution.resolution.root,
      requestedPath: resolution.resolution.requestedPath
    },
    config: readConfigState(resolution.resolution.root),
    checks: {
      count: validationStatus.adapterRegistry.checkIds.length,
      ids: validationStatus.adapterRegistry.checkIds
    },
    policy,
    graph: validationStatus.graph.status,
    generatedState: {
      ignored: generatedStateIgnores,
      guidance: "Keep generated Opcore state out of Git; .opcore/ contains local reports, history, telemetry, config, and undo metadata."
    },
    nextActions: doctorNextActions(validationStatus.graph.status.state)
  };

  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", "doctor"],
    owner: "runtime",
    status: "ok",
    json: parsed.json,
    message: formatOpcoreDoctor(opcoreDoctor),
    validationStatus,
    runtimeInfo,
    opcoreDoctor
  });
}

function parseDoctorArgs(args: readonly string[]): { ok: true; repo: string } | { ok: false; message: string } {
  let repo = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, message: "opcore doctor: --repo requires a path" };
      repo = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) return { ok: false, message: "opcore doctor: --repo requires a path" };
      repo = value;
      continue;
    }
    return { ok: false, message: `opcore doctor: unsupported argument ${arg}` };
  }
  return { ok: true, repo };
}

function readConfigState(repoRoot: string): OpcoreDoctorPayload["config"] {
  const configPath = join(repoRoot, ".opcore", "config");
  if (!existsSync(configPath)) return { path: ".opcore/config", state: "missing", message: "No .opcore/config file found." };
  try {
    readFileSync(configPath, "utf8");
    return { path: ".opcore/config", state: "found" };
  } catch (error) {
    return { path: ".opcore/config", state: "unreadable", message: errorMessage(error) };
  }
}

function doctorNextActions(graphState: OpcoreDoctorPayload["graph"]["state"]): string[] {
  if (graphState === "available") return ["Run opcore check --changed --json."];
  return ["Run opcore graph build --repo . --json to refresh graph evidence.", "Run opcore check --changed --json."];
}

function formatOpcoreDoctor(payload: OpcoreDoctorPayload): string {
  return [
    "opcore doctor",
    `Version: ${payload.runtime.packageName} ${payload.runtime.version}`,
    `Artifact: ${payload.runtime.artifactSource}`,
    `Config: ${payload.config.state} (${payload.config.path})`,
    `Checks: ${payload.checks.count}`,
    `Policy: ${payload.policy.state}`,
    `Graph: ${payload.graph.state}`,
    `Generated state: ${payload.generatedState.ignored.join(", ")}`,
    "Next:",
    ...payload.nextActions.map((action) => `  ${action}`)
  ].join("\n");
}

function opcoreDoctorHelpMessage(): string {
  return [
    "Usage: opcore doctor [--repo <path>] [--json]",
    "Flags:",
    "  --repo <path>  Repository root to inspect.",
    "  --json         Emit structured JSON with runtimeInfo and opcoreDoctor.",
    "Defaults:",
    "  --repo defaults to the current working directory.",
    "Examples:",
    "  opcore doctor --repo . --json",
    "Exit codes: 0 diagnostics produced, 1 invalid repo or diagnostics error, 64 unsupported."
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
