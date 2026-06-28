import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAspWarmLifecycle } from "../packages/opcore/dist/advanced/asp-warm/asp-warm-lifecycle.js";

describe("ASP warm lifecycle", () => {
  it("keeps singleton and idle-timeout state under .lattice/asp", () => {
    const repo = mkdtempSync(join(tmpdir(), "opcore-asp-warm-lifecycle-"));
    let now = 1000;
    const livePids = new Set([111]);
    try {
      const first = createAspWarmLifecycle({
        repoRoot: repo,
        pid: 111,
        now: () => now,
        isProcessAlive: (pid) => livePids.has(pid)
      });
      const acquired = first.acquire({ idleTimeoutMs: 500 });
      assert.equal(acquired.ok, true);
      assert.equal(existsSync(join(repo, ".lattice/asp/session.json")), true);

      const blocked = createAspWarmLifecycle({
        repoRoot: repo,
        pid: 222,
        now: () => now,
        isProcessAlive: (pid) => livePids.has(pid)
      }).acquire({ idleTimeoutMs: 500 });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.reason, "singleton_active");

      assert.equal(first.shouldShutdownForIdle(), false);
      now += 501;
      assert.equal(first.shouldShutdownForIdle(), true);

      first.touch("inspect/references");
      assert.equal(first.shouldShutdownForIdle(), false);
      first.shutdown("test-complete");

      const state = JSON.parse(readFileSync(join(repo, ".lattice/asp/session.json"), "utf8"));
      assert.equal(state.state, "shutdown");
      assert.equal(state.reason, "test-complete");
      assert.equal(state.pid, 111);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("replaces a stale singleton lock when the recorded pid is no longer alive", () => {
    const repo = mkdtempSync(join(tmpdir(), "opcore-asp-warm-lifecycle-stale-"));
    let now = 2000;
    try {
      const stale = createAspWarmLifecycle({
        repoRoot: repo,
        pid: 333,
        now: () => now,
        isProcessAlive: () => true
      });
      assert.equal(stale.acquire({ idleTimeoutMs: 1000 }).ok, true);

      now += 10;
      const replacement = createAspWarmLifecycle({
        repoRoot: repo,
        pid: 444,
        now: () => now,
        isProcessAlive: (pid) => pid !== 333
      });
      const acquired = replacement.acquire({ idleTimeoutMs: 1000 });

      assert.equal(acquired.ok, true);
      const state = JSON.parse(readFileSync(join(repo, ".lattice/asp/session.json"), "utf8"));
      assert.equal(state.pid, 444);
      assert.equal(state.state, "running");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
