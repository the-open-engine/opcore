import { spawnSync } from "node:child_process";

export type GitHistoryResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      message: string;
    };

export function latestCommitIso(repoRoot: string, path: string): GitHistoryResult<string | undefined> {
  const result = git(repoRoot, ["log", "-1", "--format=%cI", "--", path]);
  if (!result.ok) return result;
  const value = result.stdout.trim();
  return { ok: true, value: value.length === 0 ? undefined : value };
}

export function assertGitHistoryAvailable(repoRoot: string): GitHistoryResult<true> {
  const result = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!result.ok) return result;
  if (result.stdout.trim() !== "true") {
    return { ok: false, message: "Git history is unavailable: not inside a Git worktree" };
  }
  return { ok: true, value: true };
}

function git(
  repoRoot: string,
  args: readonly string[]
): { ok: true; stdout: string } | { ok: false; message: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) return { ok: true, stdout: result.stdout };
  return {
    ok: false,
    message: `Git history is unavailable: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown git failure"}`
  };
}
