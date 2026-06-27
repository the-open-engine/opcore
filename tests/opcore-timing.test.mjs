import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const opcoreBin = resolve(repoRoot, "packages/opcore/dist/index.js");

describe("opcore router timing", () => {
  it("emits timing for scan, status, check, and measure while keeping status and measure read-only", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-timing-"));
    try {
      initGitFixture(temp);
      writeFixtureFile(temp, "src/index.ts", "export const value = 1;\n");

      const scan = parseJson(runOpcore(["--repo", temp, "--json"], temp, 0).stdout);
      assertCommandTiming(scan);
      assert.equal(existsSync(join(temp, ".opcore", "telemetry.jsonl")), true);

      const statusBefore = collectRepoPaths(temp);
      const status = parseJson(runOpcore(["status", "--repo", temp, "--json"], temp, 0).stdout);
      assertCommandTiming(status);
      assert.deepEqual(collectRepoPaths(temp), statusBefore);

      const check = parseJson(
        runOpcore(["check", "--changed", "--checks", "typescript.syntax", "--json"], temp, 0).stdout
      );
      assertCommandTiming(check);

      const historyBefore = readFileSync(join(temp, ".opcore", "history.jsonl"), "utf8");
      const reportBefore = readFileSync(join(temp, ".opcore", "report.json"), "utf8");
      const telemetryBefore = readFileSync(join(temp, ".opcore", "telemetry.jsonl"), "utf8");
      const measureBefore = collectRepoPaths(temp);
      const measure = parseJson(runOpcore(["measure", "--repo", temp, "--json"], temp, 0).stdout);
      assertCommandTiming(measure);
      assert.equal(readFileSync(join(temp, ".opcore", "history.jsonl"), "utf8"), historyBefore);
      assert.equal(readFileSync(join(temp, ".opcore", "report.json"), "utf8"), reportBefore);
      assert.equal(readFileSync(join(temp, ".opcore", "telemetry.jsonl"), "utf8"), telemetryBefore);
      assert.deepEqual(collectRepoPaths(temp), measureBefore);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("emits init and try timing and approved Git init excludes Opcore artifacts", () => {
    const initRepo = mkdtempSync(join(tmpdir(), "opcore-timing-init-"));
    const tryCwd = mkdtempSync(join(tmpdir(), "opcore-timing-try-"));
    const cleanupRoots = [];
    try {
      initGitFixture(initRepo);
      const init = parseJson(runOpcore(["init", "--repo", initRepo, "--approve", "--json"], initRepo, 0).stdout);
      assertCommandTiming(init);
      assert.equal(existsSync(join(initRepo, ".opcore", "telemetry.jsonl")), false);
      const gitignore = readFileSync(join(initRepo, ".gitignore"), "utf8");
      assert.equal(gitignore.split(/\r?\n/).filter((line) => line === ".opcore/").length, 1);
      run("git", ["check-ignore", ".opcore/telemetry.jsonl"], initRepo, 0);

      const opcoreTry = parseJson(runOpcore(["try", "--json"], tryCwd, 0).stdout);
      cleanupRoots.push(opcoreTry.opcoreTry.sampleRoot);
      assertCommandTiming(opcoreTry);
      assert.equal(opcoreTry.opcoreTry.published, false);
    } finally {
      for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
      rmSync(initRepo, { recursive: true, force: true });
      rmSync(tryCwd, { recursive: true, force: true });
    }
  });
});

function initGitFixture(repo) {
  run("git", ["init"], repo, 0);
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commit = run("git", ["commit-tree", emptyTree, "-m", "fixture"], repo, 0, {
    ...process.env,
    GIT_AUTHOR_NAME: "Opcore Test",
    GIT_AUTHOR_EMAIL: "opcore@example.invalid",
    GIT_COMMITTER_NAME: "Opcore Test",
    GIT_COMMITTER_EMAIL: "opcore@example.invalid"
  }).stdout.trim();
  run("git", ["branch", "-f", "main", commit], repo, 0);
  run("git", ["checkout", "-q", "main"], repo, 0);
}

function runOpcore(args, cwd, expectedStatus) {
  return run(process.execPath, [opcoreBin, ...args], cwd, expectedStatus);
}

function run(command, args, cwd, expectedStatus, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, npm_lifecycle_event: undefined },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, expectedStatus, [
    `Command: ${command} ${args.join(" ")}`,
    `cwd: ${cwd}`,
    `status: ${result.status}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`
  ].join("\n"));
  return result;
}

function writeFixtureFile(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function collectRepoPaths(root) {
  const paths = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      paths.push(path);
      if (entry.isDirectory()) stack.push(absolute);
    }
  }
  return paths.sort();
}

function assertCommandTiming(result) {
  assert.equal(typeof result.timing?.durationMs, "number");
  assert.equal(result.timing.durationMs >= 0, true);
  assert.equal(Array.isArray(result.timing.phases), true);
  assert.equal(["cold", "warm"].includes(result.timing.processState), true);
}
