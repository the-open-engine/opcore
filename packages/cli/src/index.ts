#!/usr/bin/env node
import { commandRouterManifest } from "./manifest.js";
import { runCli } from "./router.js";
import { isServeTransportArgv, runGraphServeCli } from "@the-open-engine/lattice-graph";

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
  const normalized = entrypoint.replaceAll("\\", "/");
  return import.meta.url === `file://${entrypoint}` || normalized.endsWith("/.bin/lattice");
}

function directBin(): "lattice" {
  return "lattice";
}

void commandRouterManifest;
