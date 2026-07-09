#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    stagePackage(packageName, packageDir, opcoreNodeModulesDir, { disableLifecycleScripts: true });
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

function stagePackage(packageName, packageDir, opcoreNodeModulesDir, options = {}) {
  const packageRoot = join(opcoreNodeModulesDir, ...packageName.split("/"));
  rmSync(packageRoot, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });

  for (const file of packFiles(packageName, packageDir, options)) {
    const source = join(packageDir, file);
    const destination = join(packageRoot, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { force: true, preserveTimestamps: true });
  }
}

function packFiles(packageName, packageDir, options = {}) {
  const source = options.disableLifecycleScripts ? scriptlessPackageCopy(packageDir) : undefined;
  try {
    const result = spawnSync("npm", ["pack", ".", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: source?.packageDir ?? packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status !== 0) {
      throw new Error(`npm pack --dry-run failed for bundled package ${packageName}:\n${result.stderr || result.stdout}`);
    }
    const parsed = JSON.parse(result.stdout);
    if (parsed?.error) {
      throw new Error(
        `npm pack --dry-run returned an error for bundled package ${packageName}:\n${JSON.stringify(parsed.error, null, 2)}`
      );
    }
    const pack = Array.isArray(parsed) ? parsed[0] : parsed;
    const files = pack?.files?.map((entry) => entry.path) ?? [];
    if (files.length === 0) {
      throw new Error(
        `npm pack --dry-run returned no files for bundled package ${packageName}:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      );
    }
    return files;
  } finally {
    source?.cleanup();
  }
}

function scriptlessPackageCopy(packageDir) {
  const stageRoot = mkdtempSync(join(tmpdir(), "opcore-packlist-"));
  const stagedPackageDir = join(stageRoot, "package");
  try {
    cpSync(packageDir, stagedPackageDir, {
      recursive: true,
      filter(source) {
        const rel = relative(packageDir, source);
        return rel === "" || !rel.split(/[\\/]/).includes("node_modules");
      }
    });
    const manifestPath = join(stagedPackageDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.scripts) {
      delete manifest.scripts;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return {
      packageDir: stagedPackageDir,
      cleanup() {
        rmSync(stageRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === "") {
  stageOpcoreBundle();
}
