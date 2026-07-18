import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeCommand } from "../packages/opcore/dist/advanced/index.js";
import { calculateEditChecksum, createEditCommandAdapter } from "../packages/edit/dist/index.js";

describe("opcore edit CLI", () => {
  it("plans exact edits by default without writing", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "const value = oldName;\n");

      const routed = await routeCommand([
        "edit",
        "exact",
        "--repo",
        repo,
        "--path",
        "src/a.ts",
        "--expected",
        "oldName",
        "--replacement",
        "newName",
        "--json"
      ], "opcore");

      assert.equal(routed.status, "ok");
      assert.equal(routed.editPlan.changes[0].content, "const value = newName;\n");
      assert.equal(routed.editResult.afterState["src/a.ts"], "const value = newName;\n");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "const value = oldName;\n");
    });
  });

  it("fails closed for generated validation-required apply", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old\n");

      const routed = await routeCommand([
        "edit",
        "exact",
        "--repo",
        repo,
        "--path",
        "src/a.ts",
        "--expected",
        "old",
        "--replacement",
        "new",
        "--apply",
        "--json"
      ], "opcore");

      assert.equal(routed.status, "error");
      assert.equal(routed.exitCode, 1);
      assert.equal(routed.editResult.refusal.category, "validation_failed");
      assert.equal(routed.editResult.validation.status, "policy_failure");
      assert.equal(routed.editResult.validation.graphStatus.state, "available");
      assert.equal(routed.editResult.applied, false);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");
    });
  });

  it("rejects explicit optional-validation apply plans as validation bypasses", async () => {
    await withTempRepo(async (repo) => {
      const before = "old\n";
      writeFileSync(join(repo, "src/a.ts"), before);
      const plan = {
        planId: "manual-optional",
        repo: { repoRoot: repo },
        changes: [
          {
            kind: "replace",
            path: "src/a.ts",
            content: "new\n",
            checksumBefore: calculateEditChecksum(before)
          }
        ],
        atomic: { strategy: "all_or_nothing", planHash: "sha256:manual" },
        validation: {
          required: false,
          request: {
            repo: { repoRoot: repo },
            scope: { kind: "files", files: ["src/a.ts"] },
            graph: { mode: "required", provider: "opcore-graph" },
            overlays: []
          }
        }
      };

      const routed = await routeCommand(["edit", "apply", "--repo", repo, "--request-json", JSON.stringify(plan), "--json"], "opcore");

      assert.equal(routed.status, "error");
      assert.equal(routed.editResult.refusal.category, "unsupported_change");
      assert.equal(routed.editResult.applied, false);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), before);
    });
  });

  it("rejects apply when command repo conflicts with plan repo", async () => {
    await withTempRepo(async (repoA) => {
      await withTempRepo(async (repoB) => {
        const before = "old\n";
        writeFileSync(join(repoA, "src/a.ts"), before);
        writeFileSync(join(repoB, "src/a.ts"), before);
        const plan = optionalReplacePlan(repoA, before, "new\n");

        const routed = await routeCommand(["edit", "apply", "--repo", repoB, "--request-json", JSON.stringify(plan), "--json"], "opcore");

        assert.equal(routed.status, "error");
        assert.equal(routed.exitCode, 1);
        assert.equal(routed.editResult.ok, false);
        assert.equal(routed.editResult.refusal.category, "ambiguous_repo_identity");
        assert.equal(readFileSync(join(repoA, "src/a.ts"), "utf8"), before);
        assert.equal(readFileSync(join(repoB, "src/a.ts"), "utf8"), before);
      });
    });
  });

  it("rejects planning when command repo conflicts with request repo", async () => {
    await withTempRepo(async (repoA) => {
      await withTempRepo(async (repoB) => {
        const before = "old\n";
        writeFileSync(join(repoA, "src/a.ts"), before);
        writeFileSync(join(repoB, "src/a.ts"), before);

        const routed = await routeCommand([
          "edit",
          "exact",
          "--repo",
          repoB,
          "--request-json",
          JSON.stringify({
            repo: { repoRoot: repoA },
            path: "src/a.ts",
            expectedText: "old",
            replacementText: "new"
          }),
          "--json"
        ], "opcore");

        assert.equal(routed.status, "error");
        assert.equal(routed.exitCode, 1);
        assert.equal(routed.editResult.refusal.category, "ambiguous_repo_identity");
        assert.equal(readFileSync(join(repoA, "src/a.ts"), "utf8"), before);
        assert.equal(readFileSync(join(repoB, "src/a.ts"), "utf8"), before);
      });
    });
  });

  it("previews apply command when dry-run is requested", async () => {
    for (const flag of ["--dry-run"]) {
      await withTempRepo(async (repo) => {
        const before = "old\n";
        writeFileSync(join(repo, "src/a.ts"), before);
        const plan = optionalReplacePlan(repo, before, "new\n");

        const routed = await routeCommand(["edit", "apply", "--repo", repo, "--request-json", JSON.stringify(plan), flag, "--json"], "opcore");

        assert.equal(routed.status, "ok", flag);
        assert.equal(routed.editResult.applied, false, flag);
        assert.equal(routed.editResult.afterState["src/a.ts"], "new\n", flag);
        assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), before, flag);
      });
    }
  });

  it("merges duplicate multi files and validates chained operations", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "alpha beta gamma");
      const request = {
        files: [
          {
            path: "src/a.ts",
            operations: [{ expectedText: "alpha", replacementText: "one" }]
          },
          {
            path: "src/a.ts",
            operations: [{ expectedText: "one beta", replacementText: "two" }]
          }
        ]
      };

      const routed = await routeCommand(["edit", "multi", "--repo", repo, "--request-json", JSON.stringify(request), "--json"], "opcore");

      assert.equal(routed.status, "ok");
      assert.equal(routed.editPlan.changes[0].content, "two gamma");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "alpha beta gamma");
    });
  });

  it("supports search-replace literal, regex, backrefs, case-insensitive, multiline, filters, dry-run, and no-op", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "Name: ALPHA\nName: beta\nkeep\n");
      writeFileSync(join(repo, "src/b.ts"), "skip ALPHA\n");
      const request = {
        files: ["src/a.ts", "src/b.ts"],
        fileContains: "Name:",
        operations: [
          { search: "name: (alpha)", replace: "id:$1", regex: true, caseInsensitive: true, replaceAll: false },
          { search: "^Name: beta$", replace: "id:BETA", regex: true, multiline: true, replaceAll: false }
        ]
      };

      const routed = await routeCommand([
        "edit",
        "search-replace",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify(request),
        "--dry-run",
        "--json"
      ], "opcore");

      assert.equal(routed.status, "ok");
      assert.equal(routed.editResult.matchCount, 2);
      assert.deepEqual(routed.editPlan.changes.map((change) => change.path), ["src/a.ts"]);
      assert.equal(routed.editPlan.changes[0].content, "id:ALPHA\nid:BETA\nkeep\n");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "Name: ALPHA\nName: beta\nkeep\n");

      const snakeCaseFilter = await routeCommand([
        "edit",
        "search-replace",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({
          files: ["src/a.ts", "src/b.ts"],
          file_contains: "Name:",
          operations: [{ search: "ALPHA", replace: "OMEGA", replace_all: true }]
        }),
        "--json"
      ], "opcore");
      assert.equal(snakeCaseFilter.status, "ok");
      assert.equal(snakeCaseFilter.editResult.matchCount, 1);
      assert.deepEqual(snakeCaseFilter.editPlan.changes.map((change) => change.path), ["src/a.ts"]);

      const noMatch = await routeCommand([
        "edit",
        "search-replace",
        "--repo",
        repo,
        "--path",
        "src/a.ts",
        "--expected",
        "missing",
        "--replacement",
        "ignored",
        "--json"
      ], "opcore");
      assert.equal(noMatch.status, "ok");
      assert.equal(noMatch.editPlan.changes.length, 0);
      assert.equal(noMatch.editResult.applied, false);
      assert.equal(noMatch.editResult.matchCount, 0);
    });
  });

  it("rejects duplicate search-replace matches unless replaceAll is true", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "one one\n");

      const duplicate = await routeCommand([
        "edit",
        "search-replace",
        "--repo",
        repo,
        "--path",
        "src/a.ts",
        "--expected",
        "one",
        "--replacement",
        "two",
        "--json"
      ], "opcore");

      assert.equal(duplicate.status, "error");
      assert.equal(duplicate.exitCode, 1);
      assert.equal(duplicate.editResult.refusal.category, "unsafe_edit");
      assert.equal(duplicate.editResult.matchCount, 2);
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "one one\n");

      const replaceAll = await routeCommand([
        "edit",
        "search-replace",
        "--repo",
        repo,
        "--path",
        "src/a.ts",
        "--expected",
        "one",
        "--replacement",
        "two",
        "--replace-all",
        "--json"
      ], "opcore");

      assert.equal(replaceAll.status, "ok");
      assert.equal(replaceAll.editResult.matchCount, 2);
      assert.equal(replaceAll.editPlan.changes[0].content, "two two\n");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "one one\n");
    });
  });

  it("rejects unsupported exact flags instead of ignoring them", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old old\n");

      for (const flag of ["--regex", "--replace-all"]) {
        const routed = await routeCommand([
          "edit",
          "exact",
          "--repo",
          repo,
          "--path",
          "src/a.ts",
          "--expected",
          "old",
          "--replacement",
          "new",
          flag,
          "--json"
        ], "opcore");

        assert.equal(routed.status, "error", flag);
        assert.equal(routed.exitCode, 1, flag);
        assert.equal(routed.editResult.refusal.category, "unsupported_change", flag);
      }
    });
  });

  it("keeps literal search-replace replacement tokens literal", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old\n");

      const routed = await routeCommand([
        "edit",
        "search-replace",
        "--repo",
        repo,
        "--path",
        "src/a.ts",
        "--expected",
        "old",
        "--replacement",
        "x$&y",
        "--replace-all",
        "--json"
      ], "opcore");

      assert.equal(routed.status, "ok");
      assert.equal(routed.editPlan.changes[0].content, "x$&y\n");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "old\n");
    });
  });

  it("accepts stdin JSON payloads through package-owned parsing", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "old\n");
      const adapter = createEditCommandAdapter({
        readStdin: async () => JSON.stringify({ path: "src/a.ts", expectedText: "old", replacementText: "new" })
      });

      const routed = await adapter({
        schemaVersion: 1,
        bin: "opcore",
        argv: ["edit", "exact", "--repo", repo, "--stdin", "--json"],
        args: ["exact", "--repo", repo, "--stdin"],
        json: true,
        group: {
          name: "edit",
          owner: "edit",
          canonicalCommand: ["opcore", "edit"],
          commands: ["exact"],
          summary: "test"
        },
        canonicalCommand: ["opcore", "edit", "exact", "--repo", repo, "--stdin"]
      });

      assert.equal(routed.status, "ok");
      assert.equal(routed.editPlan.changes[0].content, "new\n");
    });
  });

  it("returns typed refusals for malformed inputs and unsupported routes", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, "src/a.ts"), "one\n");

      const cases = [
        ["edit", "exact", "--repo", repo, "--path", "../a.ts", "--expected", "one", "--replacement", "two", "--json"],
        ["edit", "exact", "--repo", repo, "--path", "src/a.ts", "--expected", "one", "--replacement", "two", "--checksum-before", "sha256:stale", "--json"],
        ["edit", "search-replace", "--repo", repo, "--request-json", "{\"files\":[\"src/a.ts\"],\"operations\":[{\"search\":\"(\",\"replace\":\"x\",\"regex\":true}]}", "--json"],
        ["edit", "search-replace", "--repo", repo, "--request-json", "{\"files\":[\"src/a.ts\"],\"operations\":[{\"search\":\"one\"}]}", "--json"],
        ["edit", "search-replace", "--repo", repo, "--request-json", "{\"files\":[\"src/a.ts\"],\"operations\":[{\"search\":\"one\",\"replace\":\"two\",\"regex\":\"true\"}]}", "--json"],
        ["edit", "search-replace", "--repo", repo, "--request-json", "{\"files\":[\"src/a.ts\"],\"file_contains\":false,\"operations\":[{\"search\":\"one\",\"replace\":\"two\"}]}", "--json"],
        ["edit", "multi", "--repo", repo, "--request-json", "{\"files\":[{\"path\":\"src/a.ts\",\"operations\":[{\"expectedText\":\"one\"}]}]}", "--json"],
        ["edit", "exact", "--repo", repo, "--path", "src/a.ts", "--expected", "one", "--json"],
        ["edit", "exact", "--repo", repo, "--request-json", "{", "--json"]
      ];

      for (const args of cases) {
        const routed = await routeCommand(args, "opcore");
        assert.equal(routed.status, "error", args.join(" "));
        assert.equal(routed.editResult.ok, false, args.join(" "));
        assert.equal(typeof routed.editResult.refusal.category, "string", args.join(" "));
      }

      const patch = await routeCommand([
        "edit",
        "patch",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ patch: patchFor("src/a.ts", "one", "two") }),
        "--dry-run",
        "--json"
      ], "opcore");
      assert.equal(patch.status, "ok");
      assert.equal(patch.editPlan.changes[0].content, "two\n");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "one\n");

      const tree = await routeCommand([
        "edit",
        "tree",
        "--repo",
        repo,
        "--request-json",
        JSON.stringify({ files: [{ path: "src/a.ts", content: "three\n" }] }),
        "--dry-run",
        "--json"
      ], "opcore");
      assert.equal(tree.status, "ok");
      assert.equal(tree.editPlan.changes[0].content, "three\n");
      assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "one\n");

      for (const command of ["rename", "move", "signature"]) {
        const routed = await routeCommand(["edit", command, "--json"], "opcore");
        assert.equal(routed.status, "error");
        assert.equal(routed.editResult.refusal.category, "unsupported_change");
      }

      assert.equal((await routeCommand(["edit", "multi-edit", "--json"], "opcore")).status, "unsupported");
    });
  });
});

function optionalReplacePlan(repo, before, after) {
  return {
    planId: "manual-optional",
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
      required: false,
      request: {
        repo: { repoRoot: repo },
        scope: { kind: "files", files: ["src/a.ts"] },
        graph: { mode: "required", provider: "opcore-graph" },
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
  const repo = mkdtempSync(join(tmpdir(), "lattice-edit-cli-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    await run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
