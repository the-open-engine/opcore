#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const writeIndex = args.indexOf("--write");
const writePath = writeIndex === -1 ? undefined : args[writeIndex + 1];
const root = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const packages = lock.packages ?? {};

const workspaceLinks = [];
const thirdParty = [];
const bundledRuntime = [];

for (const [lockPath, entry] of Object.entries(packages)) {
  if (!lockPath.startsWith("node_modules/")) continue;
  const name = lockPath.replace("node_modules/", "");
  if (entry.link === true) {
    const manifestPath = join(entry.resolved, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    workspaceLinks.push({
      name,
      version: manifest.version ?? "unknown",
      license: manifest.license ?? "UNKNOWN",
      source: manifestPath
    });
    continue;
  }
  thirdParty.push({
    name,
    version: entry.version ?? "unknown",
    license: entry.license ?? "UNKNOWN",
    source: lockPath
  });
}

for (const [lockPath, entry] of Object.entries(packages)) {
  if (!lockPath.startsWith("packages/")) continue;
  const bundled = entry.bundleDependencies ?? entry.bundledDependencies ?? [];
  for (const name of bundled) {
    const runtimeEntry = packages[`node_modules/${name}`];
    bundledRuntime.push({
      name,
      version: runtimeEntry?.version ?? "workspace-bundled",
      license: runtimeEntry?.license ?? "UNKNOWN",
      source: lockPath
    });
  }
}

workspaceLinks.sort(comparePackage);
thirdParty.sort(comparePackage);
bundledRuntime.sort(comparePackage);

const unresolvedThirdParty = thirdParty.filter((entry) => entry.license === "UNKNOWN");
if (unresolvedThirdParty.length > 0) {
  throw new Error(`Third-party packages missing license metadata: ${unresolvedThirdParty.map(formatPackage).join(", ")}`);
}
const unresolvedBundled = bundledRuntime.filter((entry) => entry.license === "UNKNOWN");
if (unresolvedBundled.length > 0) {
  throw new Error(`Bundled runtime packages missing license metadata: ${unresolvedBundled.map(formatPackage).join(", ")}`);
}

const licenseCounts = new Map();
for (const entry of thirdParty) {
  licenseCounts.set(entry.license, (licenseCounts.get(entry.license) ?? 0) + 1);
}

const lines = [
  "# License Report",
  "",
  "Maintainer license evidence for the Lattice alpha release gate.",
  "",
  `Root package: ${root.name}@${root.version}`,
  `Lockfile version: ${lock.lockfileVersion}`,
  `Third-party packages: ${thirdParty.length}`,
  `Bundled runtime packages: ${bundledRuntime.length}`,
  `Workspace packages: ${workspaceLinks.length}`,
  "",
  "## Third-Party Inventory",
  "",
  "| Package | Version | License | Lockfile Source |",
  "|---------|---------|---------|-----------------|",
  ...thirdParty.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.license} | ${entry.source} |`),
  "",
  "## License Summary",
  "",
  "| License | Package Count |",
  "|---------|---------------|",
  ...[...licenseCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([license, count]) => `| ${license} | ${count} |`),
  "",
  "## Bundled Runtime Dependencies",
  "",
  "| Package | Version | License | Source |",
  "|---------|---------|---------|--------|",
  ...(bundledRuntime.length === 0
    ? ["| none | n/a | n/a | n/a |"]
    : bundledRuntime.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.license} | ${entry.source} |`)),
  "",
  "## Workspace Packages",
  "",
  "| Package | Version | License | Manifest |",
  "|---------|---------|---------|----------|",
  ...workspaceLinks.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.license} | ${entry.source} |`),
  "",
  "No unresolved third-party license entries."
];

const markdown = `${lines.join("\n")}\n`;
if (writePath) writeFileSync(writePath, markdown);
if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        rootPackage: `${root.name}@${root.version}`,
        lockfileVersion: lock.lockfileVersion,
        productionDependencies: thirdParty,
        bundledRuntimeDependencies: bundledRuntime,
        workspacePackages: workspaceLinks,
        productionDependencyCount: thirdParty.length,
        bundledDependencyCount: bundledRuntime.length,
        workspacePackageCount: workspaceLinks.length,
        unresolvedLicenseCount: 0,
        markdown
      },
      null,
      2
    )}\n`
  );
} else {
  process.stdout.write(markdown);
}

function comparePackage(left, right) {
  return left.name.localeCompare(right.name);
}

function formatPackage(entry) {
  return `${entry.name}@${entry.version}`;
}
