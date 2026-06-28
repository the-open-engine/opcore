#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isServeTransportArgv, runGraphServeCli } from "@the-open-engine/opcore-graph";
import { runOpcoreCli } from "./router.js";
import { createGraphServeTelemetry } from "./serve-telemetry.js";

declare const process: {
  argv: string[];
  exitCode?: number;
  platform: string;
};

export { routeOpcoreCommand, runOpcoreCli } from "./router.js";
export { AGENT_FILE_CANDIDATES, routeOpcoreInit } from "./init.js";
export { routeOpcoreScan } from "./scan.js";
export { routeOpcoreStatus } from "./status.js";
export { routeOpcoreTry } from "./try.js";
export {
  createOpcoreMeasureDelta,
  createOpcoreMetricReport,
  formatOpcoreMeasureHuman,
  formatOpcoreReportHuman,
  readCommandLatencyTelemetry,
  readOpcoreLatencyBudgets,
  readOpcoreMetricHistory,
  readOpcoreMetricReport,
  writeCommandLatencyTelemetry,
  writeOpcoreMetricArtifacts
} from "./reporting.js";
export {
  attachCommandTiming,
  collectTimingPhases,
  createCommandLatencyRecord,
  timeCommand
} from "./timing.js";

if (isDirectExecution()) process.exitCode = await runDirectOpcoreCli();

async function runDirectOpcoreCli(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "graph" && isServeTransportArgv(argv.slice(1))) {
    return runGraphServeCli({
      argv: argv.slice(1),
      bin: "opcore",
      telemetry: createGraphServeTelemetry()
    });
  }
  return runOpcoreCli({
    argv,
    bin: "opcore"
  });
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (typeof entrypoint !== "string") return false;
  if (normalizePath(entrypoint).endsWith("/.bin/opcore")) return true;
  try {
    return normalizePath(realpathSync(entrypoint)) === normalizePath(realpathSync(currentModulePath()));
  } catch {
    return import.meta.url === `file://${entrypoint}`;
  }
}

function currentModulePath(): string {
  const pathname = decodeURIComponent(new URL(import.meta.url).pathname);
  if (process.platform === "win32") return pathname.replace(/^\/([A-Za-z]:)/u, "$1").replaceAll("/", "\\");
  return pathname;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
