import { spawnSync } from "node:child_process";

export interface GitState {
  available: boolean;
  branch?: string;
  changed?: number;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  conflicted?: number;
  clean?: boolean;
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface GitStatusCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export function runGit(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function parseGitStatus(stdout: string): GitState {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const statusLines = lines.filter((line) => !line.startsWith("## "));
  const counts = countGitStatuses(statusLines);
  const branch = parseBranch(branchLine);
  return {
    available: true,
    ...(branch ? { branch } : {}),
    changed: statusLines.length,
    ...counts,
    clean: statusLines.length === 0
  };
}

export function gitFailureMessage(result: GitResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail : `exit ${result.status ?? "unknown"}`;
}

function countGitStatuses(lines: readonly string[]): GitStatusCounts {
  const counts: GitStatusCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  for (const line of lines) countGitStatus(line, counts);
  return counts;
}

function countGitStatus(line: string, counts: GitStatusCounts): void {
  const x = line[0] ?? " ";
  const y = line[1] ?? " ";
  const code = `${x}${y}`;
  if (code === "??") {
    counts.untracked += 1;
    return;
  }
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) counts.conflicted += 1;
  if (x !== " " && x !== "?") counts.staged += 1;
  if (y !== " " && y !== "?") counts.unstaged += 1;
}

function parseBranch(branchLine: string | undefined): string | undefined {
  return branchLine?.slice(3).split("...")[0]?.split(" ")[0]?.trim() || undefined;
}
