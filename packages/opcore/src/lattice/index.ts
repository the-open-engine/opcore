#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { commandRouterManifest } from "./manifest.js";
import { runCli } from "./router.js";
import { isServeTransportArgv, runGraphServeCli } from "@the-open-engine/opcore-graph";

declare const process: {
  argv: string[];
  exitCode?: number;
};

export { commandExitSemantics, commandRouterManifest } from "./manifest.js";
export { routeCommand, runCli } from "./router.js";

if (isDirectExecution()) void runLatticeDirectCli();

async function runLatticeDirectCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const bin = directBin();
  if (bin === "lattice" && argv[0] === "graph" && isServeTransportArgv(argv.slice(1))) {
    process.exitCode = await runGraphServeCli({
      argv: argv.slice(1),
      bin: "lattice"
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
  const normalized = normalizePath(entrypoint);
  return normalized.endsWith("/.bin/lattice") || normalizePath(safeRealpath(entrypoint)) === currentModulePath();
}

function directBin(): "lattice" {
  return "lattice";
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

void commandRouterManifest;
