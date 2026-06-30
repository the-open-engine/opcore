import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("provenance history policy", () => {
  it("allows quoted git ref literals in release smoke scripts", () => {
    const repo = tempPolicyRepo();
    try {
      writeFileSync(
        join(repo, "scripts/smoke-ref.mjs"),
        [
          "run(\"git\", [\"update-ref\", \"refs/heads/main\", commit], { cwd: smokeRepo });",
          "run(\"git\", [\"symbolic-ref\", \"HEAD\", \"refs/heads/main\"], { cwd: smokeRepo });",
          ""
        ].join("\n")
      );
      commitAll(repo);

      const result = run(repo, ["scripts/check-provenance.mjs"]);
      assert.match(result.stdout, /provenance check passed/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects copied git ref listings in history", () => {
    const repo = tempPolicyRepo();
    try {
      writeFileSync(join(repo, "copied-history.txt"), `${"a".repeat(40)} refs/heads/main\n`);
      commitAll(repo);

      const result = run(repo, ["scripts/check-provenance.mjs"], { expectFailure: true });
      assert.match(`${result.stderr}\n${result.stdout}`, /Forbidden Python code-review-graph provenance|refs\/heads\/main/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function tempPolicyRepo() {
  const repo = mkdtempSync(join(tmpdir(), "lattice-provenance-policy-"));
  mkdirSync(join(repo, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "scripts/check-provenance.mjs"), join(repo, "scripts/check-provenance.mjs"));
  const init = spawnSync("git", ["init", "--quiet"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(init.status, 0, init.stderr);
  return repo;
}

function commitAll(repo) {
  const env = gitEnv();
  const lsFiles = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(lsFiles.status, 0, lsFiles.stderr);
  const files = lsFiles.stdout.split("\0").filter(Boolean);
  for (let index = 0; index < files.length; index += 100) {
    const add = spawnSync("git", ["add", "--", ...files.slice(index, index + 100)], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.equal(add.status, 0, add.stderr);
  }
  const commit = spawnSync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: repo,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(commit.status, 0, commit.stderr);
}

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Provenance Fixture",
    GIT_AUTHOR_EMAIL: "provenance@example.invalid",
    GIT_COMMITTER_NAME: "Provenance Fixture",
    GIT_COMMITTER_EMAIL: "provenance@example.invalid"
  };
}

function run(repo, args, options = {}) {
  const command = options.command ?? process.execPath;
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `${command} ${args.join(" ")} should fail`);
    return result;
  }
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}
