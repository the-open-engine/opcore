#!/usr/bin/env node
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpcoreAspProviderManifest, createOpcoreAspServerManifest } from "../packages/asp-provider/dist/manifest.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repoRoot, "packages/asp-provider");
const canonicalManifestPath = join(packageRoot, "dist/manifests/asp-server.json");
const provisionalManifestPath = join(packageRoot, "dist/manifests/opcore-asp-provider.provisional.json");
const legacyProviderManifestFile = ["lattice", "asp", "provider.provisional.json"].join("-");
const legacyManifestPaths = [
  join(packageRoot, "dist/manifests", legacyProviderManifestFile)
];

const canonicalManifest = createOpcoreAspServerManifest({ packageRoot });
const provisionalManifest = createOpcoreAspProviderManifest({ packageRoot });
await mkdir(dirname(provisionalManifestPath), { recursive: true });
for (const legacyManifestPath of legacyManifestPaths) {
  await unlink(legacyManifestPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
await writeFile(canonicalManifestPath, `${JSON.stringify(canonicalManifest, null, 2)}\n`);
await writeFile(provisionalManifestPath, `${JSON.stringify(provisionalManifest, null, 2)}\n`);
await chmod(join(packageRoot, "dist/index.js"), 0o755);
process.stdout.write(`wrote ${canonicalManifestPath}\n`);
process.stdout.write(`wrote ${provisionalManifestPath}\n`);
