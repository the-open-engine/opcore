import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { descriptorArtifactPath, opcoreManagedToolDescriptor } from "../packages/opcore/dist/advanced/descriptor.js";
import { validateManagedToolDescriptor } from "../packages/contracts/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repoRoot, "packages", "opcore", descriptorArtifactPath);
const outputDir = dirname(outputPath);
const cliManifest = JSON.parse(readFileSync(resolve(repoRoot, "packages", "opcore", "package.json"), "utf8"));
const descriptor = validateManagedToolDescriptor({
  ...opcoreManagedToolDescriptor,
  aggregateIdentity: {
    ...opcoreManagedToolDescriptor.aggregateIdentity,
    version: cliManifest.version
  },
  packageIdentity: {
    ...opcoreManagedToolDescriptor.packageIdentity,
    version: cliManifest.version
  }
});

mkdirSync(outputDir, { recursive: true });
for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
  const entryPath = resolve(outputDir, entry.name);
  if (entry.isFile() && entry.name.endsWith(".managed-tool.json") && entryPath !== outputPath) {
    rmSync(entryPath, { force: true });
  }
}
rmSync(resolve(repoRoot, "packages", "opcore", "dist", "lattice"), { recursive: true, force: true });
writeFileSync(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`);
chmodSync(resolve(repoRoot, "packages", "opcore", "dist", "index.js"), 0o755);
