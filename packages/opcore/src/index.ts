#!/usr/bin/env node
import { runOpcoreCli } from "./router.js";

declare const process: {
  argv: string[];
  exitCode?: number;
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

if (isDirectExecution()) {
  process.exitCode = await runOpcoreCli({
    argv: process.argv.slice(2),
    bin: "opcore"
  });
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (typeof entrypoint !== "string") return false;
  const normalized = entrypoint.replaceAll("\\", "/");
  return import.meta.url === `file://${entrypoint}` || normalized.endsWith("/.bin/opcore");
}
