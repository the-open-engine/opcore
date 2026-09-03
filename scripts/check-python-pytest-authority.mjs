#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStagedOpcorePackage } from "./stage-opcore-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const opcoreBin = join(repoRoot, "packages/opcore/dist/index.js");
const fixtureRoot = join(repoRoot, "packages/fixtures/validation-python/pytest-authority");
const tempRoot = mkdtempSync(join(tmpdir(), "opcore-pytest-authority-"));

try {
  const venvRoot = join(tempRoot, "venv");
  run("python3", ["-m", "venv", venvRoot], { cwd: repoRoot });
  const venvPython = join(venvRoot, "bin/python");
  const venvBin = join(venvRoot, "bin");
  run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "pytest==8.4.1"], { cwd: repoRoot });
  const pytestVersion = run(venvPython, ["-m", "pytest", "--version"], { cwd: repoRoot }).stdout.trim();
  const env = {
    ...process.env,
    VIRTUAL_ENV: venvRoot,
    PATH: `${venvBin}:${process.env.PATH ?? ""}`
  };

  const baseTempRoots = currentPytestTempRoots();
  const scenarios = [
    runFixtureScenario("pass", env),
    runFixtureScenario("fail", env, { expectedExitCodes: [1] }),
    runFixtureScenario("collection-fail", env, { expectedExitCodes: [1] }),
    runFixtureScenario("timeout", env, { expectedExitCodes: [1] }),
    runFixtureScenario("manifest", env),
    runFixtureScenario("workspace-isolation", env)
  ];
  const packedInstall = runPackedInstallScenario(env);
  installAmbientPlugin(venvPython);
  scenarios.push(runFixtureScenario("pass", env, { label: "ambient-plugin-isolation" }));
  assertNoPytestTempLeaks(baseTempRoots);

  console.log(JSON.stringify({
    pytestVersion,
    scenarios,
    packedInstall
  }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function runFixtureScenario(name, env, options = {}) {
  const label = options.label ?? name;
  const repo = materializeFixture(name, label);
  const beforeDigest = repoDigest(repo);
  const beforeTempRoots = currentPytestTempRoots();
  run("node", [opcoreBin, "graph", "build", "--repo", repo, "--json"], { cwd: repoRoot, env });
  const result = run(
    "node",
    [opcoreBin, "check", "files", "src/app.py", "--repo", repo, "--checks", "python.pytest", "--json"],
    { cwd: repoRoot, env, allowedExitCodes: options.expectedExitCodes ?? [0] }
  );
  const parsed = JSON.parse(result.stdout);
  const capabilityRun = parsed.validationResult?.pythonCapabilityRuns?.[0];
  assert.equal(capabilityRun?.capability, "pytest", label);
  assert.equal(capabilityRun?.cleanup?.ok, true, label);
  assert.equal(capabilityRun?.cleanup?.attempted, true, label);
  assert.equal(repoDigest(repo), beforeDigest, `${label} mutated source repo`);
  assertNoNewPytestTempRoots(beforeTempRoots, label);
  verifyScenario(label, parsed.validationResult, capabilityRun);
  return summarize(label, parsed.validationResult, capabilityRun);
}

function runPackedInstallScenario(env) {
  const repo = materializeFixture("pass", "packed-install");
  const beforeDigest = repoDigest(repo);
  run("node", [opcoreBin, "graph", "build", "--repo", repo, "--json"], { cwd: repoRoot, env });

  const packDestination = join(tempRoot, "packed-install-artifacts");
  mkdirSync(packDestination, { recursive: true });
  const staged = createStagedOpcorePackage(tempRoot);
  try {
    const pack = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDestination], {
      cwd: staged.packageDir
    }).stdout)[0];
    const consumer = join(tempRoot, "packed-consumer");
    mkdirSync(consumer, { recursive: true });
    run("npm", ["init", "-y"], { cwd: consumer });
    run("npm", ["install", "--silent", join(packDestination, pack.filename)], { cwd: consumer });
    const installedBin = join(consumer, "node_modules", ".bin", "opcore");
    const beforeTempRoots = currentPytestTempRoots();
    const result = run(
      installedBin,
      ["check", "files", "src/app.py", "--repo", repo, "--checks", "python.pytest", "--json"],
      { cwd: consumer, env }
    );
    const parsed = JSON.parse(result.stdout);
    const capabilityRun = parsed.validationResult?.pythonCapabilityRuns?.[0];
    assert.equal(parsed.validationResult?.status, "passed");
    assert.equal(capabilityRun?.outcome, "passed");
    assert.equal(repoDigest(repo), beforeDigest, "packed install mutated source repo");
    assertNoNewPytestTempRoots(beforeTempRoots, "packed-install");
    return {
      status: parsed.validationResult.status,
      outcome: capabilityRun.outcome,
      selectionMode: capabilityRun.selectionMode,
      cleanup: capabilityRun.cleanup,
      tarball: pack.filename
    };
  } finally {
    staged.cleanup();
  }
}

function verifyScenario(label, validationResult, capabilityRun) {
  switch (label) {
    case "pass":
    case "ambient-plugin-isolation":
    case "workspace-isolation":
      assert.equal(validationResult?.status, "passed", label);
      assert.equal(capabilityRun?.outcome, "passed", label);
      assert.equal(capabilityRun?.counts?.passedCount > 0, true, label);
      if (label === "workspace-isolation") {
        assert.equal(capabilityRun?.collection?.stage, "collection");
        assert.equal(capabilityRun?.execution?.stage, "execution");
      }
      break;
    case "fail":
      assert.equal(validationResult?.status, "policy_failure", label);
      assert.equal(capabilityRun?.outcome, "findings", label);
      assert.equal((capabilityRun?.counts?.failedCount ?? 0) + (capabilityRun?.counts?.errorCount ?? 0) > 0, true, label);
      break;
    case "collection-fail":
      assert.equal(validationResult?.status, "policy_failure", label);
      assert.equal(capabilityRun?.collection?.termination, "exited", label);
      assert.equal(capabilityRun?.outcome !== "passed", true, label);
      assert.equal(Object.hasOwn(capabilityRun, "execution"), false, label);
      break;
    case "timeout":
      assert.equal(validationResult?.status, "policy_failure", label);
      assert.equal(capabilityRun?.outcome, "timeout", label);
      assert.equal(capabilityRun?.execution?.termination, "timeout", label);
      break;
    case "manifest":
      assert.equal(validationResult?.status, "passed", label);
      assert.equal(capabilityRun?.outcome, "passed", label);
      assert.equal(capabilityRun?.selectionMode, "manifest", label);
      assert.equal((capabilityRun?.counts?.passedCount ?? 0) > 100, true, label);
      break;
    default:
      throw new Error(`Unknown scenario: ${label}`);
  }
}

function summarize(label, validationResult, capabilityRun) {
  return {
    name: label,
    status: validationResult.status,
    outcome: capabilityRun.outcome,
    activation: capabilityRun.activation,
    selectionMode: capabilityRun.selectionMode,
    counts: capabilityRun.counts,
    cleanup: capabilityRun.cleanup,
    collection: capabilityRun.collection,
    execution: capabilityRun.execution
  };
}

function installAmbientPlugin(venvPython) {
  const sitePackages = run(venvPython, ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], { cwd: repoRoot }).stdout.trim();
  const distInfo = join(sitePackages, "opcore_bad_pytest_plugin-0.0.0.dist-info");
  mkdirSync(distInfo, { recursive: true });
  writeFileSync(join(sitePackages, "opcore_bad_pytest_plugin.py"), "raise RuntimeError('ambient pytest plugin loaded')\n");
  writeFileSync(join(distInfo, "METADATA"), [
    "Metadata-Version: 2.1",
    "Name: opcore-bad-pytest-plugin",
    "Version: 0.0.0",
    ""
  ].join("\n"));
  writeFileSync(join(distInfo, "entry_points.txt"), [
    "[pytest11]",
    "opcore_bad_plugin = opcore_bad_pytest_plugin",
    ""
  ].join("\n"));
}

function materializeFixture(name, destinationName = name) {
  const source = join(fixtureRoot, name);
  const repo = join(tempRoot, destinationName);
  cpSync(source, repo, { recursive: true });
  for (const path of walkFiles(repo)) {
    if (!path.endsWith(".fixture")) continue;
    renameSync(path, path.slice(0, -".fixture".length));
  }
  const localBin = join(repo, ".venv", "bin");
  mkdirSync(localBin, { recursive: true });
  for (const tool of ["python", "python3", "pytest"]) {
    const wrapperPath = join(localBin, tool);
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${join(tempRoot, "venv", "bin", tool)}" "$@"\n`);
    chmodSync(wrapperPath, 0o755);
  }
  return repo;
}

function currentPytestTempRoots() {
  return new Set(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("opcore-python-pytest-"))
      .map((entry) => join(tmpdir(), entry.name))
  );
}

function assertNoNewPytestTempRoots(before, label) {
  const after = currentPytestTempRoots();
  const leaked = [...after].filter((path) => !before.has(path));
  assert.deepEqual(leaked, [], `${label} leaked pytest temp roots`);
}

function assertNoPytestTempLeaks(before) {
  const after = currentPytestTempRoots();
  const leaked = [...after].filter((path) => !before.has(path));
  assert.deepEqual(leaked, [], "pytest authority proof leaked temp roots");
}

function repoDigest(root) {
  const hash = createHash("sha256");
  for (const path of walkFiles(root)) {
    hash.update(path.slice(root.length + 1));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function walkFiles(root) {
  const entries = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if ([".git", ".opcore", ".pytest_cache", "__pycache__"].includes(dirent.name)) continue;
    const path = join(root, dirent.name);
    if (dirent.isDirectory()) entries.push(...walkFiles(path));
    else if (dirent.isFile()) entries.push(path);
  }
  return entries.sort();
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.status ?? -1)) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}
