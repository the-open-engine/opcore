import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  collectPackageSourceTextEntries,
  formatLaunchScrubFindings,
  scrubLaunchTextEntries
} from "./lib/launch-claim-scrub.mjs";
import {
  bundledExternalRuntimePackageNames,
  bundledOpcorePackageNames,
  bundledReleasePackageNames,
  publicReleasePackageNames,
  releasePackageDirForName,
  rootWorkspacePackageDirs
} from "./release-package-dirs.mjs";
import { createStagedOpcorePackage } from "./stage-opcore-bundle.mjs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const packlists = JSON.parse(readFileSync("tests/fixtures/package-packlists.json", "utf8"));
const expectedPackageNames = publicReleasePackageNames;
const forbiddenPathPatterns = [
  /(^|\/)(preview|generated|bundle|bundles)\//,
  /(^|\/)(\.ace|\.agents|\.claude|\.codex|\.gemini|\.opencode|\.code-review-graph|\.rox-cache|\.robustness-engine-cache)\//,
  /\.tsbuildinfo$/,
  /(^|\/)src\//
];
const allowedBundledPackageRoots = new Set(bundledOpcorePackageNames.map((packageName) => `node_modules/${packageName}/`));
const externalBundledPackageRoots = new Set(
  bundledExternalRuntimePackageNames.map((packageName) => `node_modules/${packageName}/`)
);

assertSameSet(root.workspaces ?? [], rootWorkspacePackageDirs, "root workspace package dirs");
assertSameSet(Object.keys(packlists), expectedPackageNames, "package packlist fixture names");

const stagedPackages = new Map();
try {
  for (const packageName of expectedPackageNames) {
    const expected = packlists[packageName]?.expectedFiles;
    if (!Array.isArray(expected)) throw new Error(`${packageName} must have expectedFiles in package-packlists.json`);
    const packageSource = packageSourceFor(packageName);
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageSource.packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status !== 0) throw new Error(`npm pack failed for ${packageName}: ${result.stderr || result.stdout}`);

    const parsed = JSON.parse(result.stdout);
    const manifest = JSON.parse(readFileSync(`${packageSource.packageDir}/package.json`, "utf8"));
    const bin = manifest.bin ?? {};
    if (packageName === "opcore") {
      assertSameSet(Object.keys(bin), ["opcore", "opcore-asp-provider"], `${packageName} bins`);
      assertContainsAll(parsed[0]?.bundled ?? [], bundledReleasePackageNames, `${packageName} bundled first-party dependencies`);
      assertSameSet(manifest.bundleDependencies ?? manifest.bundledDependencies ?? [], bundledOpcorePackageNames, `${packageName} manifest bundled dependencies`);
    }
    else if (Object.keys(bin).length > 0) throw new Error(`${packageName} must not expose CLI bins`);
    for (const forbiddenBin of ["lattice", "crg", "cix", "rox"]) {
      if (Object.hasOwn(bin, forbiddenBin)) throw new Error(`${packageName} exposes forbidden old bin ${forbiddenBin}`);
    }
    const files = parsed[0]?.files?.map((entry) => entry.path).sort() ?? [];
    const allowed = [...expected].sort();
    for (const file of files) {
      assertAllowedBundledPath(file, packageName);
      if (!isExternalBundledPath(file)) {
        const forbidden = forbiddenPathPatterns.find((pattern) => pattern.test(file));
        if (forbidden) throw new Error(`${packageName} pack includes forbidden path ${file}`);
      }
    }
    const firstPartyFiles = files.filter((file) => !isExternalBundledPath(file));
    const scrubFindings = scrubLaunchTextEntries(
      collectPackageSourceTextEntries({
        repoRoot: packageSource.repoRoot,
        packageName,
        packageRoot: packageSource.packageRoot,
        files: firstPartyFiles
      })
    );
    if (scrubFindings.length > 0) {
      throw new Error(`${packageName} package marker scrub failed:\n${formatLaunchScrubFindings(scrubFindings).join("\n")}`);
    }
    assertSameSet(files, allowed, `${packageName} pack files`);
  }
} finally {
  for (const staged of stagedPackages.values()) staged.cleanup();
}

console.log(`package dry-run passed for ${expectedPackageNames.length} packages`);

function packageSourceFor(packageName) {
  if (packageName !== "opcore") {
    return {
      repoRoot: process.cwd(),
      packageRoot: releasePackageDirForName(packageName),
      packageDir: releasePackageDirForName(packageName)
    };
  }
  if (!stagedPackages.has(packageName)) stagedPackages.set(packageName, createStagedOpcorePackage(tmpdir()));
  const staged = stagedPackages.get(packageName);
  return { repoRoot: staged.stageRoot, packageRoot: staged.packageRoot, packageDir: staged.packageDir };
}

function assertAllowedBundledPath(file, packageName) {
  if (!file.startsWith("node_modules/")) return;
  if (packageName !== "opcore") throw new Error(`${packageName} pack includes forbidden bundled path ${file}`);
  for (const root of allowedBundledPackageRoots) {
    if (file.startsWith(root)) return;
  }
  throw new Error(`${packageName} pack includes non-allowlisted bundled dependency path ${file}`);
}

function isExternalBundledPath(file) {
  if (!file.startsWith("node_modules/")) return false;
  for (const root of externalBundledPackageRoots) {
    if (file.startsWith(root)) return true;
  }
  return false;
}

function assertSameSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} mismatch\nexpected: ${expectedSorted.join("\n")}\nactual: ${actualSorted.join("\n")}`);
  }
}

function assertContainsAll(actual, expected, label) {
  const actualSet = new Set(actual);
  const missing = expected.filter((entry) => !actualSet.has(entry));
  if (missing.length > 0) {
    throw new Error(`${label} missing entries\nmissing: ${missing.sort().join("\n")}`);
  }
}
