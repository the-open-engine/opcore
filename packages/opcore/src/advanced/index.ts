#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { commandRouterManifest } from "./manifest.js";
import { runCli } from "./router.js";
import { isServeTransportArgv, runGraphServeCli } from "@the-open-engine/opcore-graph";

declare const process: {
  argv: string[];
  exitCode?: number;
  platform: string;
};

export { commandExitSemantics, commandRouterManifest } from "./manifest.js";
export { routeCommand, runCli } from "./router.js";

if (isDirectExecution()) void runLatticeDirectCli();

async function runLatticeDirectCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const bin = directBin();
  if (bin === "opcore" && argv[0] === "graph" && isServeTransportArgv(argv.slice(1))) {
    process.exitCode = await runGraphServeCli({
      argv: argv.slice(1),
      bin: "opcore"
    });
    return;
  }
  process.exitCode = await runCli({
    argv,
    bin
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

function directBin(): "opcore" {
  return "opcore";
}

void commandRouterManifest;
