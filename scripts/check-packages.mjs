import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  collectPackageSourceTextEntries,
  formatLaunchScrubFindings,
  scrubLaunchTextEntries
} from "./lib/launch-claim-scrub.mjs";
import { rootWorkspacePackageDirs } from "./release-package-dirs.mjs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const packlists = JSON.parse(readFileSync("tests/fixtures/package-packlists.json", "utf8"));
const expectedPackageNames = [
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore",
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  "@the-open-engine/opcore-asp-provider",
  "@the-open-engine/opcore-fixtures"
];
const packageDirsByName = new Map([
  ["@the-open-engine/opcore-contracts", "packages/contracts"],
  ["@the-open-engine/opcore", "packages/opcore"],
  ["@the-open-engine/opcore-graph", "packages/graph"],
  ["@the-open-engine/opcore-graph-core-darwin-arm64", "packages/opcore-graph-core-darwin-arm64"],
  ["@the-open-engine/opcore-graph-core-darwin-x64", "packages/opcore-graph-core-darwin-x64"],
  ["@the-open-engine/opcore-graph-core-linux-x64", "packages/opcore-graph-core-linux-x64"],
  ["@the-open-engine/opcore-edit", "packages/edit"],
  ["@the-open-engine/opcore-validation", "packages/validation"],
  ["@the-open-engine/opcore-validation-python", "packages/validation-python"],
  ["@the-open-engine/opcore-validation-rust", "packages/validation-rust"],
  ["@the-open-engine/opcore-validation-typescript", "packages/validation-typescript"],
  ["@the-open-engine/opcore-asp-provider", "packages/asp-provider"],
  ["@the-open-engine/opcore-fixtures", "packages/fixtures"]
]);
const nativePackageNames = new Set([
  "@the-open-engine/opcore-graph-core-darwin-arm64",
  "@the-open-engine/opcore-graph-core-darwin-x64",
  "@the-open-engine/opcore-graph-core-linux-x64"
]);
const forbiddenPathPatterns = [
  /(^|\/)node_modules\//,
  /(^|\/)(preview|generated|bundle|bundles)\//,
  /(^|\/)(\.ace|\.agents|\.claude|\.codex|\.gemini|\.opencode|\.code-review-graph|\.rox-cache|\.robustness-engine-cache)\//,
  /\.tsbuildinfo$/,
  /^src\//
];

assertSameSet(root.workspaces ?? [], rootWorkspacePackageDirs, "root workspace package dirs");
assertSameSet(Object.keys(packlists), expectedPackageNames, "package packlist fixture names");

for (const packageName of expectedPackageNames) {
  const expected = packlists[packageName]?.expectedFiles;
  if (!Array.isArray(expected)) throw new Error(`${packageName} must have expectedFiles in package-packlists.json`);
  const packageDir = packageDirsByName.get(packageName);
  if (nativePackageNames.has(packageName) && process.env.LATTICE_REQUIRE_ALL_NATIVE_PACKAGES !== "1") {
    const missing = expected.filter((file) => !existsSync(`${packageDir}/${file}`));
    if (missing.length > 0) continue;
  }
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(`npm pack failed for ${packageName}: ${result.stderr || result.stdout}`);

  const parsed = JSON.parse(result.stdout);
  const manifest = JSON.parse(readFileSync(`${packageDir}/package.json`, "utf8"));
  const bin = manifest.bin ?? {};
  if (packageName === "@the-open-engine/opcore") assertSameSet(Object.keys(bin), ["opcore"], `${packageName} bins`);
  else if (packageName === "@the-open-engine/opcore-asp-provider") {
    assertSameSet(Object.keys(bin), ["opcore-asp-provider"], `${packageName} bins`);
  }
  else if (Object.keys(bin).length > 0) throw new Error(`${packageName} must not expose CLI bins`);
  for (const forbiddenBin of ["lattice", "crg", "cix", "rox"]) {
    if (Object.hasOwn(bin, forbiddenBin)) throw new Error(`${packageName} exposes forbidden old bin ${forbiddenBin}`);
  }
  const files = parsed[0]?.files?.map((entry) => entry.path).sort() ?? [];
  const allowed = [...expected].sort();
  for (const file of files) {
    const forbidden = forbiddenPathPatterns.find((pattern) => pattern.test(file));
    if (forbidden) throw new Error(`${packageName} pack includes forbidden path ${file}`);
  }
  const scrubFindings = scrubLaunchTextEntries(
    collectPackageSourceTextEntries({ repoRoot: process.cwd(), packageName, packageRoot: packageDir, files })
  );
  if (scrubFindings.length > 0) {
    throw new Error(`${packageName} package marker scrub failed:\n${formatLaunchScrubFindings(scrubFindings).join("\n")}`);
  }
  assertSameSet(files, allowed, `${packageName} pack files`);
}

console.log(`package dry-run passed for ${expectedPackageNames.length} packages`);

function assertSameSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} mismatch\nexpected: ${expectedSorted.join("\n")}\nactual: ${actualSorted.join("\n")}`);
  }
}
