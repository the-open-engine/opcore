#!/usr/bin/env node
import { realpathSync } from "node:fs";
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
  writeOpcoreMetricArtifacts
} from "./reporting.js";

if (isDirectExecution()) {
  process.exitCode = await runOpcoreCli({
    argv: process.argv.slice(2),
    bin: "opcore"
  });
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (typeof entrypoint !== "string") return false;
  const normalized = normalizePath(entrypoint);
  return normalized.endsWith("/.bin/opcore") || normalizePath(safeRealpath(entrypoint)) === currentModulePath();
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function currentModulePath(): string {
  return normalizePath(decodeURIComponent(new URL(import.meta.url).pathname));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
