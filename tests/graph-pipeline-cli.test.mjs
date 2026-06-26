import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const latticeBin = join(repoRoot, "packages/opcore/dist/lattice/index.js");
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");
const robustnessFixtureRoot = resolve(repoRoot, "packages/fixtures/graph-robustness/watch-roots");

describe("graph pipeline CLI", () => {
  it("builds, updates, reports status, and uses canonical lattice routing", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = run(latticeBin, ["graph", "build", "--repo", fixtureRoot, "--json"]);
      const repeatBuild = run(latticeBin, ["graph", "build", "--repo", fixtureRoot, "--json"]);
      assert.equal(build.providerStatus.state, "available");
      assert.deepEqual(build.providerStatus.handshake.nodeKinds, [
        "repo",
        "package",
        "file",
        "symbol",
        "test",
        "File",
        "Class",
        "Function",
        "Variable",
        "Type",
        "Test",
        "Module",
        "Struct",
        "Enum",
        "Trait",
        "Impl",
        "Method",
        "TypeAlias",
        "Const",
        "Static",
        "Macro"
      ]);
      assert.equal(repeatBuild.providerStatus.state, "available");
      assert.equal(build.graphPipeline.summary.operation, "build");
      assert.ok(existsSync(join(fixtureRoot, ".lattice/graph/graph.db")));

      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(left, right) { return left + right + 3; }\n");
      unlinkSync(join(fixtureRoot, "src/legacy-widget.jsx"));
      const update = run(latticeBin, ["graph", "update", "--repo", fixtureRoot, "--base", "HEAD", "--json"]);
      const repeatUpdate = run(latticeBin, ["graph", "update", "--repo", fixtureRoot, "--base", "HEAD", "--json"]);
      assert.deepEqual(update.graphPipeline.summary.changedFiles, ["src/math.js"]);
      assert.deepEqual(update.graphPipeline.summary.deletedFiles, ["src/legacy-widget.jsx"]);
      assert.equal(update.graphPipeline.summary.fullRebuildRequired, false);
      assert.equal(repeatUpdate.canonicalCommand[2], "update");

      const status = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"]);
      const repeatStatus = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"]);
      assert.equal(status.providerStatus.state, "available");
      assert.equal(repeatStatus.providerStatus.state, "available");
    });
  });

  it("runs watch once and writes daemon lifecycle artifacts", () => {
    withFixtureCopy((fixtureRoot) => {
      const watch = run(latticeBin, ["graph", "watch", "--repo", fixtureRoot, "--once", "--poll-interval-ms", "50", "--json"]);
      assert.equal(watch.providerStatus.state, "available");
      assert.equal(watch.graphPipeline.summary.operation, "watch");
      assert.equal(watch.graphPipeline.lifecycle.idleTimeoutMs, 1800000);
      for (const artifact of ["pid", "state.json", "daemon.log"]) {
        assert.ok(existsSync(join(fixtureRoot, ".lattice/graph/daemon", artifact)), artifact);
      }
      const lifecycle = JSON.parse(readFileSync(join(fixtureRoot, ".lattice/graph/daemon/state.json"), "utf8"));
      assert.equal(lifecycle.state, "stopped");
      assert.equal(lifecycle.idleTimeoutMs, 1800000);
    });
  });

  it("stops detached watch after the configured idle timeout", { timeout: 10000 }, () => {
    withFixtureCopy((fixtureRoot) => {
      const watch = run(latticeBin, [
        "graph",
        "watch",
        "--repo",
        fixtureRoot,
        "--poll-interval-ms",
        "50",
        "--idle-timeout-ms",
        "500",
        "--json"
      ]);
      const pid = watch.graphPipeline.lifecycle.pid;
      assert.equal(watch.providerStatus.state, "available");
      assert.equal(watch.graphPipeline.lifecycle.idleTimeoutMs, 500);
      assert.equal(isProcessAlive(pid), true);

      assert.equal(waitForProcessExit(pid, 5000), true);
      const lifecycle = JSON.parse(readFileSync(join(fixtureRoot, ".lattice/graph/daemon/state.json"), "utf8"));
      assert.equal(lifecycle.state, "stopped");
      assert.equal(lifecycle.idleTimeoutMs, 500);
      assert.match(lifecycle.message, /idle timeout/);
    });
  });

  it("uses env idle timeout when the flag is absent", { timeout: 10000 }, () => {
    withFixtureCopy((fixtureRoot) => {
      const watch = run(latticeBin, ["graph", "watch", "--repo", fixtureRoot, "--poll-interval-ms", "50", "--json"], 0, {
        env: {
          LATTICE_GRAPH_WATCH_IDLE_TIMEOUT_MS: "500"
        }
      });
      const pid = watch.graphPipeline.lifecycle.pid;
      assert.equal(watch.providerStatus.state, "available");
      assert.equal(watch.graphPipeline.lifecycle.idleTimeoutMs, 500);

      assert.equal(waitForProcessExit(pid, 5000), true);
      const lifecycle = JSON.parse(readFileSync(join(fixtureRoot, ".lattice/graph/daemon/state.json"), "utf8"));
      assert.equal(lifecycle.state, "stopped");
      assert.equal(lifecycle.idleTimeoutMs, 500);
      assert.match(lifecycle.message, /idle timeout/);
    });
  });

  it("keeps detached watch alive when idle timeout is disabled", { timeout: 10000 }, () => {
    withFixtureCopy((fixtureRoot) => {
      const watch = run(latticeBin, [
        "graph",
        "watch",
        "--repo",
        fixtureRoot,
        "--poll-interval-ms",
        "50",
        "--idle-timeout-ms",
        "0",
        "--json"
      ]);
      const pid = watch.graphPipeline.lifecycle.pid;
      try {
        assert.equal(watch.providerStatus.state, "available");
        assert.equal(watch.graphPipeline.lifecycle.idleTimeoutMs, 0);
        sleep(900);
        assert.equal(isProcessAlive(pid), true);
      } finally {
        stopProcess(pid);
      }
    });
  });

  it("preserves stale scoped status while a watcher is alive after a watch root disappears", { timeout: 10000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-active-watch-missing-root-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/a.ts"), "export const a = 1;\n");

      const watch = run(latticeBin, [
        "graph",
        "watch",
        "--repo",
        temp,
        "--paths",
        "src",
        "--poll-interval-ms",
        "100",
        "--idle-timeout-ms",
        "0",
        "--json"
      ]);
      const pid = watch.graphPipeline.lifecycle.pid;
      try {
        rmSync(join(temp, "src"), { recursive: true, force: true });
        sleep(350);
        assert.equal(isProcessAlive(pid), true);

        const status = run(latticeBin, ["graph", "status", "--repo", temp, "--paths", "src", "--json"]);
        assert.equal(status.providerStatus.state, "stale");
        assert.equal(status.providerStatus.failure.category, "stale_snapshot");
        assert.match(status.providerStatus.freshness.reason, /watch root src is missing/);

        const lifecycle = JSON.parse(readFileSync(join(temp, ".lattice/graph/daemon/state.json"), "utf8"));
        assert.equal(lifecycle.state, "available");
        assert.equal(lifecycle.idleTimeoutMs, 0);
        assert.match(lifecycle.message, /watch root src is missing/);
      } finally {
        stopProcess(pid);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("fails non-once watch startup when initial extraction fails", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-watch-startup-fail-"));
    try {
      writeFileSync(join(temp, "bad.ts"), "export const broken = ;\n");

      const watch = run(latticeBin, ["graph", "watch", "--repo", temp, "--poll-interval-ms", "50", "--json"], 1);
      assert.equal(watch.status, "error");
      assert.equal(watch.providerStatus.state, "error");
      assert.equal(watch.graphPipeline, undefined);
      assert.match(watch.providerStatus.failure.message, /parse|extraction|expected/i);
      const lifecycle = JSON.parse(readFileSync(join(temp, ".lattice/graph/daemon/state.json"), "utf8"));
      assert.equal(lifecycle.state, "error");
      assert.match(lifecycle.message, /parse|extraction|expected/i);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies .gitignore negations during build and watch discovery", () => {
    withNegatedGitignoreRepo((fixtureRoot) => {
      const build = run(latticeBin, ["graph", "build", "--repo", fixtureRoot, "--json"]);
      assert.equal(build.providerStatus.state, "available");
      assert.equal(build.graphPipeline.summary.discoveredFiles, 1);
      assert.deepEqual(build.graphPipeline.summary.changedFiles, ["keep.ts"]);
    });

    withNegatedGitignoreRepo((fixtureRoot) => {
      const watch = run(latticeBin, ["graph", "watch", "--repo", fixtureRoot, "--once", "--poll-interval-ms", "50", "--json"]);
      assert.equal(watch.providerStatus.state, "available");
      assert.equal(watch.graphPipeline.summary.discoveredFiles, 1);
      assert.deepEqual(watch.graphPipeline.summary.changedFiles, ["keep.ts"]);
    });
  });

  it("applies built-in generated, private, and dependency exclusions without ignore files", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-builtins-no-ignore-"));
    try {
      for (const [directory, file] of [
        ["src", "app.ts"],
        ["node_modules/pkg", "index.ts"],
        [".ace/runtime", "generated.ts"],
        [".lattice/graph", "generated.ts"],
        [".rox-cache", "generated.ts"],
        [".robustness-engine-cache", "generated.ts"],
        [".pnpm/pkg", "index.ts"],
        ["vendor/pkg", "generated.ts"],
        ["dist", "generated.ts"],
        ["target", "generated.ts"]
      ]) {
        mkdirSync(join(temp, directory), { recursive: true });
        writeFileSync(join(temp, directory, file), "export const value = true;\n");
      }

      const build = run(latticeBin, ["graph", "build", "--repo", temp, "--json"]);
      assert.equal(build.providerStatus.state, "available");
      assert.equal(build.graphPipeline.summary.discoveredFiles, 1);
      assert.deepEqual(build.graphPipeline.summary.changedFiles, ["src/app.ts"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects stale non-once watch lifecycle state from a dead daemon", () => {
    withFixtureCopy((fixtureRoot) => {
      const daemonDir = join(fixtureRoot, ".lattice/graph/daemon");
      const pidPath = join(daemonDir, "pid");
      const statePath = join(daemonDir, "state.json");
      const logPath = join(daemonDir, "daemon.log");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(pidPath, "999999\n");
      writeFileSync(
        statePath,
        `${JSON.stringify({
          state: "available",
          pid: 999999,
          startedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
          pidPath,
          statePath,
          logPath,
          pollIntervalMs: 50,
          idleTimeoutMs: 1800000,
          message: "stale lifecycle"
        })}\n`
      );
      writeFileSync(logPath, "stale\n");
      chmodSync(pidPath, 0o444);
      chmodSync(statePath, 0o444);
      chmodSync(logPath, 0o444);
      chmodSync(daemonDir, 0o555);
      try {
        const watch = run(latticeBin, ["graph", "watch", "--repo", fixtureRoot, "--poll-interval-ms", "50", "--json"], 1);
        assert.equal(watch.providerStatus.state, "daemon_unavailable");
        assert.match(watch.providerStatus.failure.message, /did not publish state|exited before publishing available state/);
      } finally {
        chmodSync(daemonDir, 0o755);
        for (const path of [pidPath, statePath, logPath]) {
          if (existsSync(path)) chmodSync(path, 0o644);
        }
      }
    });
  });

  it("reports stale active lifecycle status as daemon unavailable", () => {
    withFixtureCopy((fixtureRoot) => {
      const daemonDir = join(fixtureRoot, ".lattice/graph/daemon");
      const pidPath = join(daemonDir, "pid");
      const statePath = join(daemonDir, "state.json");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(
        statePath,
        `${JSON.stringify({
          state: "warming",
          pid: 999999,
          startedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
          pidPath,
          statePath,
          logPath: join(daemonDir, "daemon.log"),
          pollIntervalMs: 50,
          idleTimeoutMs: 1800000,
          watchPaths: [],
          message: "stale lifecycle"
        })}\n`
      );

      const missingPid = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"], 1);
      assert.equal(missingPid.providerStatus.state, "daemon_unavailable");
      assert.match(missingPid.providerStatus.failure.message, /pid file .* is unreadable/);

      writeFileSync(pidPath, "999999\n");
      const canonical = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"], 1);
      const repeated = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"], 1);

      for (const result of [canonical, repeated]) {
        assert.equal(result.status, "error");
        assert.equal(result.exitCode, 1);
        assert.equal(result.providerStatus.state, "daemon_unavailable");
        assert.equal(result.providerStatus.failure.category, "daemon_unavailable");
        assert.match(result.providerStatus.failure.message, /pid 999999 is not running/);
      }
      assert.deepEqual(repeated.canonicalCommand, canonical.canonicalCommand);
      assert.equal(repeated.bin, "lattice");
    });
  });

  it("reports dead available lifecycle status as daemon unavailable", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = run(latticeBin, ["graph", "build", "--repo", fixtureRoot, "--json"]);
      assert.equal(build.providerStatus.state, "available");

      const daemonDir = join(fixtureRoot, ".lattice/graph/daemon");
      const pidPath = join(daemonDir, "pid");
      const statePath = join(daemonDir, "state.json");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(pidPath, "999999\n");
      writeFileSync(
        statePath,
        `${JSON.stringify({
          state: "available",
          pid: 999999,
          startedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
          pidPath,
          statePath,
          logPath: join(daemonDir, "daemon.log"),
          pollIntervalMs: 50,
          idleTimeoutMs: 1800000,
          watchPaths: [],
          message: "stale lifecycle"
        })}\n`
      );

      const canonical = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"], 1);
      const repeated = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"], 1);

      for (const result of [canonical, repeated]) {
        assert.equal(result.status, "error");
        assert.equal(result.exitCode, 1);
        assert.equal(result.providerStatus.state, "daemon_unavailable");
        assert.equal(result.providerStatus.failure.category, "daemon_unavailable");
        assert.match(result.providerStatus.failure.message, /pid 999999 is not running/);
      }
      assert.deepEqual(repeated.canonicalCommand, canonical.canonicalCommand);
      assert.equal(repeated.bin, "lattice");
    });
  });

  it("reports corrupt lifecycle status as daemon unavailable", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = run(latticeBin, ["graph", "build", "--repo", fixtureRoot, "--json"]);
      assert.equal(build.providerStatus.state, "available");

      const daemonDir = join(fixtureRoot, ".lattice/graph/daemon");
      const pidPath = join(daemonDir, "pid");
      const statePath = join(daemonDir, "state.json");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(pidPath, "999999\n");
      writeFileSync(statePath, "{not json\n");

      const canonical = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"], 1);
      const repeated = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"], 1);

      for (const result of [canonical, repeated]) {
        assert.equal(result.status, "error");
        assert.equal(result.exitCode, 1);
        assert.equal(result.providerStatus.state, "daemon_unavailable");
        assert.equal(result.providerStatus.failure.category, "daemon_unavailable");
        assert.match(result.providerStatus.failure.message, /state file .* is invalid/);
      }
      assert.deepEqual(repeated.canonicalCommand, canonical.canonicalCommand);
      assert.equal(repeated.bin, "lattice");
    });
  });

  it("reports corrupt lifecycle state during watch startup", () => {
    withFixtureCopy((fixtureRoot) => {
      const daemonDir = join(fixtureRoot, ".lattice/graph/daemon");
      const pidPath = join(daemonDir, "pid");
      const statePath = join(daemonDir, "state.json");
      const logPath = join(daemonDir, "daemon.log");
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(pidPath, "999999\n");
      writeFileSync(statePath, "{not json\n");
      writeFileSync(logPath, "stale\n");
      chmodSync(pidPath, 0o444);
      chmodSync(statePath, 0o444);
      chmodSync(logPath, 0o444);
      chmodSync(daemonDir, 0o555);
      try {
        const watch = run(latticeBin, ["graph", "watch", "--repo", fixtureRoot, "--poll-interval-ms", "50", "--json"], 1);
        assert.equal(watch.providerStatus.state, "daemon_unavailable");
        assert.match(watch.providerStatus.failure.message, /state file .* is invalid/);
      } finally {
        chmodSync(daemonDir, 0o755);
        for (const path of [pidPath, statePath, logPath]) {
          if (existsSync(path)) chmodSync(path, 0o644);
        }
      }
    });
  });

  it("keeps path-scoped build and status freshness scoped to requested paths", () => {
    withFixtureCopy((fixtureRoot) => {
      const build = run(latticeBin, ["graph", "build", "--repo", fixtureRoot, "--paths", "src/math.js", "--json"]);
      assert.equal(build.providerStatus.state, "available");
      assert.equal(build.graphPipeline.summary.discoveredFiles, 1);
      assert.deepEqual(build.graphPipeline.summary.watchPaths, ["src/math.js"]);

      const scopedStatus = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--paths", "src/math.js", "--json"]);
      assert.equal(scopedStatus.providerStatus.state, "available");

      const fullStatus = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--json"]);
      assert.equal(fullStatus.providerStatus.state, "stale");
      assert.match(fullStatus.providerStatus.freshness.reason, /source file .* is new/);
    });
  });

  it("normalizes explicit watch roots, records WAL status evidence, and rejects unsafe paths", () => {
    withRobustnessFixtureCopy((fixtureRoot) => {
      const watch = run(latticeBin, [
        "graph",
        "watch",
        "--repo",
        fixtureRoot,
        "--paths",
        "./src/,shared\\util.ts",
        "--once",
        "--max-wal-bytes",
        "1",
        "--json"
      ]);
      assert.equal(watch.providerStatus.state, "available");
      assert.deepEqual(watch.graphPipeline.summary.watchPaths, ["src", "shared/util.ts"]);
      assert.equal(watch.graphPipeline.summary.walCheckpoint.budgetBytes, 1);
      assert.equal(watch.graphPipeline.summary.walCheckpoint.checkpointed, true);
      assert.ok(watch.graphPipeline.summary.walCheckpoint.bytesBefore > 1);
      assert.equal(watch.providerStatus.walCheckpoint.checkpointed, true);

      const status = run(latticeBin, ["graph", "status", "--repo", fixtureRoot, "--paths", "src", "--json"]);
      assert.equal(status.providerStatus.state, "available");
      assert.equal(status.providerStatus.walCheckpoint.budgetBytes, 1);
    });

    for (const badPath of ["/tmp/src", "C:\\tmp\\src", "..", "../src", "src/../other", "."]) {
      const result = run(latticeBin, ["graph", "watch", "--repo", repoRoot, "--paths", badPath, "--once", "--json"], 1);
      assert.ok(["schema_mismatch", "daemon_unavailable", "error"].includes(result.providerStatus.state));
      assert.match(result.providerStatus.failure.message, /repo-relative|escape|watch path|repository/);
    }
  });

  it("collapses duplicate watch-path separators for scoped build, status, and env defaults", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-watch-canonical-paths-"));
    try {
      mkdirSync(join(temp, "src/nested"), { recursive: true });
      writeFileSync(join(temp, "src/nested/app.ts"), "export const app = 1;\n");

      const build = run(latticeBin, ["graph", "build", "--repo", temp, "--paths", "src//nested", "--json"]);
      assert.equal(build.providerStatus.state, "available");
      assert.equal(build.graphPipeline.summary.discoveredFiles, 1);
      assert.deepEqual(build.graphPipeline.summary.changedFiles, ["src/nested/app.ts"]);
      assert.deepEqual(build.graphPipeline.summary.watchPaths, ["src/nested"]);

      const canonicalStatus = run(latticeBin, ["graph", "status", "--repo", temp, "--paths", "src/nested", "--json"]);
      assert.equal(canonicalStatus.providerStatus.state, "available");
      const duplicateStatus = run(latticeBin, ["graph", "status", "--repo", temp, "--paths", "src//nested", "--json"]);
      assert.equal(duplicateStatus.providerStatus.state, "available");

      rmSync(join(temp, ".lattice"), { recursive: true, force: true });
      const envWatch = run(latticeBin, ["graph", "watch", "--repo", temp, "--once", "--json"], 0, {
        env: { LATTICE_GRAPH_WATCH_PATHS: "./src//nested/" }
      });
      assert.equal(envWatch.providerStatus.state, "available");
      assert.deepEqual(envWatch.graphPipeline.summary.changedFiles, ["src/nested/app.ts"]);
      assert.deepEqual(envWatch.graphPipeline.summary.watchPaths, ["src/nested"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("scopes watch from LATTICE_GRAPH_WATCH_PATHS only and ignores CRG_WATCH_PATHS", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-watch-env-paths-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/a.ts"), "export const a = 1;\n");
      writeFileSync(join(temp, "src/b.ts"), "export const b = 2;\n");

      const latticeScoped = run(latticeBin, ["graph", "watch", "--repo", temp, "--once", "--json"], 0, {
        env: { LATTICE_GRAPH_WATCH_PATHS: "./src/a.ts" }
      });
      assert.equal(latticeScoped.providerStatus.state, "available");
      assert.deepEqual(latticeScoped.graphPipeline.summary.watchPaths, ["src/a.ts"]);
      assert.deepEqual(latticeScoped.graphPipeline.summary.changedFiles, ["src/a.ts"]);

      rmSync(join(temp, ".lattice"), { recursive: true, force: true });
      const crgIgnored = run(latticeBin, ["graph", "watch", "--repo", temp, "--once", "--json"], 0, {
        env: { CRG_WATCH_PATHS: "src/a.ts" }
      });
      assert.equal(crgIgnored.providerStatus.state, "available");
      assert.deepEqual(crgIgnored.graphPipeline.summary.watchPaths ?? [], []);
      assert.deepEqual(crgIgnored.graphPipeline.summary.changedFiles, ["src/a.ts", "src/b.ts"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("treats existing empty watch scopes as fresh and missing watch roots as stale", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-watch-missing-root-"));
    try {
      mkdirSync(join(temp, "empty"), { recursive: true });
      const build = run(latticeBin, ["graph", "build", "--repo", temp, "--paths", "empty", "--json"]);
      assert.equal(build.providerStatus.state, "available");
      assert.equal(build.graphPipeline.summary.discoveredFiles, 0);

      const freshEmpty = run(latticeBin, ["graph", "status", "--repo", temp, "--paths", "empty", "--json"]);
      assert.equal(freshEmpty.providerStatus.state, "available");

      rmSync(join(temp, "empty"), { recursive: true, force: true });
      const staleMissing = run(latticeBin, ["graph", "status", "--repo", temp, "--paths", "empty", "--json"]);
      const repeated = run(latticeBin, ["graph", "status", "--repo", temp, "--paths", "empty", "--json"]);
      assert.equal(staleMissing.providerStatus.state, "stale");
      assert.match(staleMissing.providerStatus.freshness.reason, /watch root empty is missing/);
      assert.deepEqual(repeated.providerStatus.freshness, staleMissing.providerStatus.freshness);
      assert.equal(existsSync(join(temp, "empty")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns stale watch status when the requested startup watch root is missing", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-watch-startup-missing-root-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/a.ts"), "export const a = 1;\n");

      const watch = run(latticeBin, ["graph", "watch", "--repo", temp, "--paths", "missing", "--once", "--json"], 1);

      assert.equal(watch.status, "error");
      assert.equal(watch.exitCode, 1);
      assert.equal(watch.providerStatus.state, "stale");
      assert.equal(watch.providerStatus.freshness.stale, true);
      assert.match(watch.providerStatus.freshness.reason, /watch root missing is missing/);
      assert.deepEqual(watch.graphPipeline.summary.watchPaths, ["missing"]);
      assert.equal(watch.graphPipeline.summary.discoveredFiles, 0);
      assert.equal(watch.graphPipeline.status.state, "stale");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("ignores watch path environment during unscoped build and status", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-graph-env-scope-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/a.ts"), "export const a = 1;\n");
      writeFileSync(join(temp, "src/b.ts"), "export const b = 2;\n");
      const env = {
        LATTICE_GRAPH_WATCH_PATHS: "src/a.ts",
        CRG_WATCH_PATHS: "src/a.ts"
      };

      const build = run(latticeBin, ["graph", "build", "--repo", temp, "--json"], 0, { env });
      assert.equal(build.providerStatus.state, "available");
      assert.equal(build.graphPipeline.summary.discoveredFiles, 2);
      assert.deepEqual(build.graphPipeline.summary.changedFiles, ["src/a.ts", "src/b.ts"]);

      writeFileSync(join(temp, "src/b.ts"), "export const b = 3;\n");
      const status = run(latticeBin, ["graph", "status", "--repo", temp, "--json"], 0, { env });
      assert.equal(status.providerStatus.state, "stale");
      assert.match(status.providerStatus.freshness.reason, /src\/b\.ts.*hash changed/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns nonzero graph pipeline failures without fabricated summaries", () => {
    const missingRepo = join(tmpdir(), `does-not-exist-lattice-${process.pid}-${Date.now()}`);
    const canonical = run(latticeBin, ["graph", "build", "--repo", missingRepo, "--json"], 1);
    const repeated = run(latticeBin, ["graph", "build", "--repo", missingRepo, "--json"], 1);

    for (const result of [canonical, repeated]) {
      assert.equal(result.status, "error");
      assert.equal(result.exitCode, 1);
      assert.equal(result.providerStatus.state, "error");
      assert.equal(result.graphPipeline, undefined);
      assert.match(result.message, /failed to canonicalize repo root|not a directory/i);
    }
    assert.deepEqual(repeated.canonicalCommand, canonical.canonicalCommand);
    assert.equal(repeated.providerStatus.state, canonical.providerStatus.state);
    assert.equal(repeated.bin, "lattice");
  });

  it("reports missing graph stores without mutating fresh repos", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-graph-status-readonly-"));
    const repo = join(temp, "repo");
    try {
      mkdirSync(repo);
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");

      const canonical = run(latticeBin, ["graph", "status", "--repo", repo, "--json"]);
      const repeated = run(latticeBin, ["graph", "status", "--repo", repo, "--json"]);

      assert.equal(canonical.status, "ok");
      assert.equal(repeated.status, "ok");
      assert.equal(canonical.providerStatus.state, "stale");
      assert.equal(repeated.providerStatus.state, "stale");
      assert.equal(existsSync(join(repo, ".lattice")), false);
      assert.equal(existsSync(join(repo, ".lattice/graph/graph.db")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("defaults graph status to the current working repo without mutating it", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-graph-status-cwd-"));
    try {
      writeFileSync(join(temp, "a.ts"), "export const a = 1;\n");

      const canonical = run(latticeBin, ["graph", "status", "--json"], 0, { cwd: temp });
      const repeated = run(latticeBin, ["graph", "status", "--json"], 0, { cwd: temp });

      assert.equal(canonical.providerStatus.state, "stale");
      assert.equal(repeated.providerStatus.state, "stale");
      assert.equal(canonical.providerStatus.repo.repoRoot, repeated.providerStatus.repo.repoRoot);
      assert.equal(canonical.providerStatus.repo.repoRoot.endsWith(temp), true);
      assert.equal(existsSync(join(temp, ".lattice")), false);
      assert.equal(existsSync(join(temp, ".lattice/graph/graph.db")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns typed JSON errors for malformed graph options", () => {
    for (const args of [
      ["build", "--repo"],
      ["build", "--repo="],
      ["watch", "--poll-interval-ms=0"],
      ["watch", "--idle-timeout-ms=foo"],
      ["watch", "--idle-timeout-ms=-1"],
      ["watch", "--bogus-graph-flag"]
    ]) {
      const canonical = run(latticeBin, ["graph", ...args, "--json"], 1);

      assert.equal(canonical.status, "error");
      assert.equal(canonical.exitCode, 1);
      assert.equal(canonical.providerStatus.provider, "lattice-graph");
      assert.equal(canonical.providerStatus.state, "error");
      assert.equal(canonical.providerStatus.failure.category, "unknown");
      assert.match(
        canonical.providerStatus.failure.message,
        /--repo requires a value|--poll-interval-ms must be a positive number|--idle-timeout-ms must be a non-negative number|unsupported graph option: --bogus-graph-flag/
      );
      assert.equal(canonical.graphPipeline, undefined);
    }
  });
});

function run(script, args, expectedStatus = 0, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, parsed.exitCode);
  assert.equal(result.status, expectedStatus);
  return parsed;
}

function withFixtureCopy(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-graph-pipeline-"));
  const fixtureRoot = join(temp, "wave1");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function withRobustnessFixtureCopy(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "lattice-graph-robustness-"));
  const fixtureRoot = join(temp, "watch-roots");
  try {
    cpSync(robustnessFixtureRoot, fixtureRoot, { recursive: true, filter: skipGeneratedStore });
    createRuntimeIgnoredFiles(fixtureRoot);
    runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function createRuntimeIgnoredFiles(fixtureRoot) {
  for (const [directory, file] of [
    ["ignored", "drop.ts"],
    ["node_modules/pkg", "index.ts"],
    [".ace/runtime", "generated.ts"],
    [".lattice/graph", "generated.ts"],
    [".rox-cache", "generated.ts"],
    [".robustness-engine-cache", "generated.ts"],
    ["dist", "generated.ts"]
  ]) {
    mkdirSync(join(fixtureRoot, directory), { recursive: true });
    writeFileSync(join(fixtureRoot, directory, file), "export const ignored = true;\n");
  }
}

function withNegatedGitignoreRepo(runFixture) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "lattice-ignore-negation-"));
  try {
    writeFileSync(join(fixtureRoot, ".gitignore"), "*.ts\n!keep.ts\n");
    writeFileSync(join(fixtureRoot, "keep.ts"), "export const keep = 1;\n");
    writeFileSync(join(fixtureRoot, "drop.ts"), "export const drop = 1;\n");
    runFixture(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    sleep(50);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function stopProcess(pid) {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  waitForProcessExit(pid, 2000);
}

function skipGeneratedStore(source) {
  const normalized = source.replaceAll("\\", "/");
  return !normalized.endsWith("/.lattice") && !normalized.includes("/.lattice/");
}
