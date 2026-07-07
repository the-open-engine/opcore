#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundledExternalRuntimePackageNames,
  bundledReleasePackageNames,
  releasePackageDirForName
} from "./release-package-dirs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const opcorePackageDir = join(repoRoot, releasePackageDirForName("opcore"));

export function stageOpcoreBundle(options = {}) {
  const targetOpcorePackageDir = options.opcorePackageDir ?? opcorePackageDir;
  const opcoreNodeModulesDir = join(targetOpcorePackageDir, "node_modules");
  rmSync(opcoreNodeModulesDir, { recursive: true, force: true });

  for (const packageName of bundledReleasePackageNames) {
    const packageDir = join(repoRoot, releasePackageDirForName(packageName));
    stagePackage(packageName, packageDir, opcoreNodeModulesDir);
  }

  for (const packageName of bundledExternalRuntimePackageNames) {
    const packageDir = join(repoRoot, "node_modules", ...packageName.split("/"));
    stagePackage(packageName, packageDir, opcoreNodeModulesDir);
  }
}

export function clearOpcoreBundle(options = {}) {
  const targetOpcorePackageDir = options.opcorePackageDir ?? opcorePackageDir;
  rmSync(join(targetOpcorePackageDir, "node_modules"), { recursive: true, force: true });
}

export function createStagedOpcorePackage(parentDir) {
  const stageRoot = mkdtempSync(join(parentDir, "opcore-stage-"));
  const stagedPackageDir = join(stageRoot, "opcore");
  try {
    cpSync(opcorePackageDir, stagedPackageDir, {
      recursive: true,
      filter(source) {
        const rel = relative(opcorePackageDir, source);
        return rel === "" || !rel.split(/[\\/]/).includes("node_modules");
      }
    });
    stageOpcoreBundle({ opcorePackageDir: stagedPackageDir });
    return {
      stageRoot,
      packageDir: stagedPackageDir,
      packageRoot: "opcore",
      cleanup() {
        rmSync(stageRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function stagePackage(packageName, packageDir, opcoreNodeModulesDir) {
  const packageRoot = join(opcoreNodeModulesDir, ...packageName.split("/"));
  rmSync(packageRoot, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });

  for (const file of packFiles(packageName, packageDir)) {
    const source = join(packageDir, file);
    const destination = join(packageRoot, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { force: true, preserveTimestamps: true });
  }
}

function packFiles(packageName, packageDir) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed for bundled package ${packageName}:\n${result.stderr || result.stdout}`);
  }
  const pack = JSON.parse(result.stdout)[0];
  const files = pack?.files?.map((entry) => entry.path) ?? [];
  if (files.length === 0) throw new Error(`npm pack --dry-run returned no files for bundled package ${packageName}`);
  return files;
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === "") {
  stageOpcoreBundle();
}
