import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { descriptorArtifactPath, latticeManagedToolDescriptor } from "../packages/cli/dist/descriptor.js";
import { validateManagedToolDescriptor } from "../packages/contracts/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repoRoot, "packages", "cli", descriptorArtifactPath);
const cliManifest = JSON.parse(readFileSync(resolve(repoRoot, "packages", "cli", "package.json"), "utf8"));
const descriptor = validateManagedToolDescriptor({
  ...latticeManagedToolDescriptor,
  aggregateIdentity: {
    ...latticeManagedToolDescriptor.aggregateIdentity,
    version: cliManifest.version
  },
  packageIdentity: {
    ...latticeManagedToolDescriptor.packageIdentity,
    version: cliManifest.version
  }
});

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`);
