import type {
  PythonProjectContext,
  PythonProjectToolProvenance
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { runTool, type PythonToolRunResult } from "./process.js";
import {
  ruffCommandArgs,
  ruffConfigurationFailure,
  ruffExecutionProvenance,
  type RuffCheckKind
} from "./ruff-execution.js";

export async function proveRuffConfigurationFailure(args: {
  kind: RuffCheckKind;
  tool: PythonProjectToolProvenance;
  project: Pick<PythonProjectContext, "projectRoot" | "repositoryRoot">;
  configPaths: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  target: string;
  timeoutMs: number;
}): Promise<{
  args: readonly string[];
  result: PythonToolRunResult;
  failure?: ValidationCheckResult;
  durationMs: number;
} | undefined> {
  if (args.tool.configFile === undefined || args.timeoutMs <= 0) return undefined;
  const probeArgs = ruffCommandArgs(args.tool, args.project, "check", [
    "--show-settings",
    "--output-format=json",
    "--no-cache",
    "--force-exclude",
    args.target
  ]);
  const startedAt = Date.now();
  const result = await runTool(args.tool.executable, probeArgs, {
    cwd: args.cwd,
    env: args.env,
    timeoutMs: Math.max(1, args.timeoutMs),
    allowedExitCodes: [0]
  });
  const durationMs = Math.max(1, Date.now() - startedAt);
  const rejectedConfig =
    result.termination === "exited" && result.exitCode === 2
      ? rejectedRuffConfigPath(result.stderr, args.configPaths)
      : undefined;
  const message = `Ruff rejected selected after-state configuration ${rejectedConfig ?? args.tool.configFile}`;
  const provenance = ruffExecutionProvenance(args.tool, probeArgs, args.project);
  return {
    args: probeArgs,
    result,
    ...(rejectedConfig !== undefined
      ? { failure: ruffConfigurationFailure(args.kind, args.tool, message, rejectedConfig, provenance) }
      : {}),
    durationMs
  };
}

function rejectedRuffConfigPath(stderr: string, configFiles: readonly string[]): string | undefined {
  const text = stderr.toLowerCase();
  const identifiesRejection =
    /\breject(?:ed|ion)?\b|\bfailed to (?:load|parse|read|resolve)\b|\b(?:parse|parsing) error\b|\binvalid (?:config(?:uration)?|type|value)\b|\bunknown (?:field|option|property|rule|setting|variant)\b|\bexpected\b|\bcircular dependency\b|\bcycle detected\b/u.test(text);
  if (!identifiesRejection) return undefined;
  const normalizedConfigs = [...new Set(configFiles)].map((configFile) => ({
    configFile,
    normalized: configFile.replaceAll("\\", "/").toLowerCase()
  }));
  const exact = normalizedConfigs
    .filter(({ normalized }) => normalized.includes("/"))
    .sort((left, right) => right.normalized.length - left.normalized.length)
    .find(({ normalized }) => text.includes(normalized));
  if (exact !== undefined) return exact.configFile;
  const basenameMatches = normalizedConfigs.filter(({ normalized }) => {
    const name = normalized.split("/").at(-1);
    return name !== undefined && text.includes(name);
  });
  return basenameMatches.length === 1 ? basenameMatches[0].configFile : undefined;
}
