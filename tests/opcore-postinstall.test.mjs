import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const postinstallPath = resolve(repoRoot, "packages/opcore/dist/postinstall.js");
const packageManifestPath = resolve(repoRoot, "packages/opcore/package.json");

test("Opcore postinstall banner is colored, non-fatal, and setup-only", () => {
  const result = spawnSync(process.execPath, [postinstallPath], {
    cwd: repoRoot,
    env: { ...process.env, npm_config_loglevel: "silent" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\u001b\[[0-9;]+m/);
  assert.match(result.stdout, /OPCORE/);
  assert.match(result.stdout, /opcore init\b/);
  assert.match(result.stdout, /opcore init --global\b/);
  assert.doesNotMatch(result.stdout, /publish|auto-fix|security|SAST|\blattice\b|\brox\b|\bcrg\b|\bcix\b/i);
  assert.equal(result.stderr, "");
});

test("Opcore postinstall lifecycle command is non-fatal before build output exists", () => {
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  const cwd = mkdtempSync(resolve(tmpdir(), "opcore-postinstall-"));
  const result = spawnSync(packageManifest.scripts.postinstall, {
    cwd,
    env: { ...process.env, npm_config_loglevel: "silent" },
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
