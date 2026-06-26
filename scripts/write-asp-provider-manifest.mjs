#!/usr/bin/env node
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpcoreAspProviderManifest } from "../packages/asp-provider/dist/manifest.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repoRoot, "packages/asp-provider");
const manifestPath = join(packageRoot, "dist/manifests/opcore-asp-provider.provisional.json");
const legacyProviderManifestFile = ["lattice", "asp", "provider.provisional.json"].join("-");
const legacyManifestPaths = [
  join(packageRoot, "dist/manifests", legacyProviderManifestFile)
];

const manifest = createOpcoreAspProviderManifest({ packageRoot });
await mkdir(dirname(manifestPath), { recursive: true });
for (const legacyManifestPath of legacyManifestPaths) {
  await unlink(legacyManifestPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await chmod(join(packageRoot, "dist/index.js"), 0o755);
process.stdout.write(`wrote ${manifestPath}\n`);
