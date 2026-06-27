import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeCommandAdapter } from "../packages/contracts/dist/index.js";
import { calculateEditChecksum, createEditCommandAdapter } from "../packages/edit/dist/index.js";

describe("lattice edit validation integration", () => {
  it("applies exact edits only after passing validation", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old\n");
      const runner = recordingRunner(passedValidation());

      const routed = await routeEdit(
        ["exact", "--repo", repo, "--path", "src/a.ts", "--expected", "old", "--replacement", "new", "--apply"],
        runner
      );

      assert.equal(routed.status, "ok");
      assert.equal(routed.editResult.applied, true);
      assert.equal(routed.editResult.validation.status, "passed");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "new\n");
      assert.equal(runner.requests.length, 1);
      assert.deepEqual(runner.requests[0].scope, { kind: "files", files: ["src/a.ts"] });
      assert.deepEqual(runner.requests[0].overlays, [
        {
          path: "src/a.ts",
          action: "write",
          content: "new\n",
          checksumBefore: calculateEditChecksum("old\n")
        }
      ]);
    });
  });

  it("validates exact, multi, search-replace, patch, tree, parsed check, and parsed apply before writes", async () => {
    const cases = [
      {
        name: "exact",
        before: "old\n",
        args: (repo) => ["exact", "--repo", repo, "--path", "src/a.ts", "--expected", "old", "--replacement", "new", "--apply"],
        after: "new\n"
      },
      {
        name: "multi",
        before: "alpha beta\n",
        args: (repo) => [
          "multi",
          "--repo",
          repo,
          "--request-json",
          JSON.stringify({ files: [{ path: "src/a.ts", operations: [{ expectedText: "alpha", replacementText: "omega" }] }] }),
          "--apply"
        ],
        after: "omega beta\n"
      },
      {
        name: "search-replace",
        before: "red blue\n",
        args: (repo) => [
          "search-replace",
          "--repo",
          repo,
          "--path",
          "src/a.ts",
          "--expected",
          "red",
          "--replacement",
          "green",
          "--apply"
        ],
        after: "green blue\n"
      },
      {
        name: "patch",
        before: "one\n",
        args: (repo) => [
          "patch",
          "--repo",
          repo,
          "--request-json",
          JSON.stringify({ patch: patchFor("src/a.ts", "one", "two") }),
          "--apply"
        ],
        after: "two\n"
      },
      {
        name: "tree",
        before: "old\n",
        args: (repo) => [
          "tree",
          "--repo",
          repo,
          "--request-json",
          JSON.stringify({ files: [{ path: "src/a.ts", content: "tree\n" }] }),
          "--apply"
        ],
        after: "tree\n"
      },
      {
        name: "parsed apply",
        before: "old\n",
        args: (repo) => ["apply", "--repo", repo, "--request-json", JSON.stringify(requiredReplacePlan(repo, "old\n", "applied\n"))],
        after: "applied\n"
      }
    ];

    for (const testCase of cases) {
      await withTempRepo(async (repo) => {
        writeFileSync(join(repo, "src/a.ts"), testCase.before);
        const runner = recordingRunner(passedValidation());

        const routed = await routeEdit(testCase.args(repo), runner);

        assert.equal(routed.status, "ok", testCase.name);
        assert.equal(runner.requests.length, 1, testCase.name);
        assert.equal(routed.editResult.validation.status, "passed", testCase.name);
        assert.equal(routed.editResult.applied, true, testCase.name);
        assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), testCase.after, testCase.name);
      });
    }

    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old\n");
      const runner = recordingRunner(passedValidation());

      const routed = await routeEdit(["check", "--repo", repo, "--request-json", JSON.stringify(requiredReplacePlan(repo, "old\n", "checked\n"))], runner);

      assert.equal(routed.status, "ok");
      assert.equal(runner.requests.length, 1);
      assert.equal(routed.editResult.validation.status, "passed");
      assert.equal(routed.editResult.applied, false);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");
    });
  });

  it("fails closed for validation failures, unavailable runners, timeouts, provider failures, and bypass attempts", async () => {
    const cases = [
      ["policy_failure", recordingRunner(failedValidation("policy_failure", "policy blocked")), "validation_failed"],
      ["invalid_payload", recordingRunner(failedValidation("invalid_payload", "bad payload")), "validation_failed"],
      ["thrown infrastructure", throwingRunner(new Error("validator crashed")), "validation_failed"],
      ["timeout", hangingRunner(), "validation_failed", { validationTimeoutMs: 5 }],
      ["required missing", recordingRunner(providerValidation(providerStatus("required_missing"))), "provider_required_missing"],
      ["stale", recordingRunner(providerValidation(providerStatus("stale"))), "validation_failed"],
      ["schema mismatch", recordingRunner(providerValidation(providerStatus("schema_mismatch"))), "schema_mismatch"],
      ["daemon unavailable", recordingRunner(providerValidation(providerStatus("daemon_unavailable"))), "validation_failed"],
      ["provider error", recordingRunner(providerValidation(providerStatus("error"))), "validation_failed"],
      ["no runner", undefined, "validation_failed"],
      [
        "validation refused",
        recordingRunner({
          ok: false,
          status: "refused",
          diagnostics: [],
          refusal: { category: "conflict", message: "validation refusal" }
        }),
        "conflict"
      ]
    ];

    for (const [name, runner, category, options] of cases) {
      await withTempRepo(async (repo) => {
        writeFileSync(join(repo, "src/a.ts"), "old\n");

        const routed = await routeEdit(
          ["exact", "--repo", repo, "--path", "src/a.ts", "--expected", "old", "--replacement", "new", "--apply"],
          runner,
          options
        );

        assert.equal(routed.status, "error", name);
        assert.equal(routed.editResult.applied, false, name);
        assert.equal(routed.editResult.refusal.category, category, name);
        assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n", name);
        assert.ok(routed.editResult.validation, name);
      });
    }

    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old\n");
      const runner = recordingRunner(passedValidation());

      const routed = await routeEdit(
        [
          "exact",
          "--repo",
          repo,
          "--request-json",
          JSON.stringify({ path: "src/a.ts", expectedText: "old", replacementText: "new", validation: { required: false } }),
          "--apply"
        ],
        runner
      );

      assert.equal(routed.status, "error");
      assert.equal(routed.editResult.refusal.category, "unsupported_change");
      assert.equal(runner.requests.length, 0);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");
    });
  });

  it("validates check mode without writing and keeps dry-run as non-validating preview", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old\n");
      const runner = recordingRunner(passedValidation());

      const checked = await routeEdit(
        ["exact", "--repo", repo, "--path", "src/a.ts", "--expected", "old", "--replacement", "new", "--check"],
        runner
      );

      assert.equal(checked.status, "ok");
      assert.equal(checked.editResult.applied, false);
      assert.equal(checked.editResult.validation.status, "passed");
      assert.equal(runner.requests.length, 1);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");

      const dryRun = await routeEdit(
        ["exact", "--repo", repo, "--path", "src/a.ts", "--expected", "old", "--replacement", "dry", "--dry-run"],
        throwingRunner(new Error("dry-run must not validate"))
      );

      assert.equal(dryRun.status, "ok");
      assert.equal(dryRun.editResult.applied, false);
      assert.equal(dryRun.editResult.validation, undefined);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");
    });
  });

  it("preserves full validation envelopes in edit results", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old\n");
      const validation = failedValidation("policy_failure", "blocked by policy", {
        diagnostics: [{ category: "policy", message: "no generated code", severity: "error", path: "src/a.ts", code: "no-generated" }],
        graphStatus: availableStatus(repo),
        manifest: {
          schemaVersion: 1,
          checks: ["fake.policy"],
          generatedAt: "2026-06-05T00:00:00.000Z",
          entries: [
            {
              checkId: "fake.policy",
              owner: "validation",
              adapter: "fake",
              defaultSeverity: "error",
              supportedScopes: ["files"],
              requiresGraph: false
            }
          ],
          runs: [{ checkId: "fake.policy", status: "policy_failure", diagnosticCount: 1, failureMessage: "blocked by policy" }],
          skippedChecks: [],
          durationMs: 1
        }
      });

      const routed = await routeEdit(
        ["exact", "--repo", repo, "--path", "src/a.ts", "--expected", "old", "--replacement", "new", "--apply"],
        recordingRunner(validation)
      );

      assert.equal(routed.status, "error");
      assert.deepEqual(routed.editResult.validation, validation);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");
    });
  });
});

async function routeEdit(args, validationRunner, options = {}) {
  return routeCommandAdapter({
    bin: "lattice",
    argv: [...args, "--json"],
    groupName: "edit",
    adapter: createEditCommandAdapter({ validationRunner, ...options })
  });
}

function recordingRunner(result) {
  const requests = [];
  return {
    requests,
    async runValidation(request) {
      requests.push(request);
      return typeof result === "function" ? result(request) : result;
    }
  };
}

function throwingRunner(error) {
  return {
    requests: [],
    async runValidation() {
      throw error;
    }
  };
}

function hangingRunner() {
  return {
    requests: [],
    runValidation() {
      return new Promise(() => {});
    }
  };
}

function passedValidation(overrides = {}) {
  return {
    ok: true,
    status: "passed",
    diagnostics: [],
    ...overrides
  };
}

function failedValidation(status, message, overrides = {}) {
  return {
    ok: false,
    status,
    diagnostics: [],
    failure: {
      category: status,
      message
    },
    ...overrides
  };
}

function providerValidation(graphStatus) {
  return failedValidation("provider_failure", graphStatus.failure.message, { graphStatus });
}

function providerStatus(state) {
  const base = {
    state,
    mode: "required",
    provider: "lattice-graph",
    schemaVersion: 1,
    failure: {
      category: "provider_error",
      message: `${state} provider failure`
    }
  };
  if (state === "required_missing") {
    base.failure.category = "provider_missing";
  } else if (state === "stale") {
    base.failure.category = "stale_snapshot";
    base.repo = { repoId: "lattice" };
    base.freshness = { generatedAt: "2026-06-05T00:00:00.000Z", ageMs: 10, stale: true };
  } else if (state === "schema_mismatch") {
    base.failure.category = "schema_mismatch";
    base.expectedSchemaVersion = 1;
    base.actualSchemaVersion = 2;
  } else if (state === "daemon_unavailable") {
    base.failure.category = "daemon_unavailable";
  }
  return base;
}

function availableStatus(repo) {
  return {
    state: "available",
    mode: "required",
    provider: "lattice-graph",
    schemaVersion: 1,
    repo: { repoRoot: repo },
    freshness: {
      generatedAt: "2026-06-05T00:00:00.000Z",
      ageMs: 0,
      stale: false
    },
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function requiredReplacePlan(repo, before, after) {
  return {
    planId: "manual-required",
    repo: { repoRoot: repo },
    changes: [
      {
        kind: "replace",
        path: "src/a.ts",
        content: after,
        checksumBefore: calculateEditChecksum(before)
      }
    ],
    atomic: { strategy: "all_or_nothing", planHash: "sha256:manual" },
    validation: {
      required: true,
      request: {
        repo: { repoRoot: repo },
        scope: { kind: "files", files: ["src/a.ts"] },
        graph: { mode: "required", provider: "lattice-graph" },
        overlays: []
      }
    }
  };
}

function patchFor(path, before, after) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}

async function withTempRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), "lattice-edit-validation-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    await run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
