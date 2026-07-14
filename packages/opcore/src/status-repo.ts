import { readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { errorCode, errorMessage } from "./status-errors.js";
import { runGit } from "./status-git.js";

export interface RepoResolution {
  requestedPath: string;
  root: string;
  git: boolean;
}

export function resolveRepo(
  repoArg: string,
  command: string
): { ok: true; resolution: RepoResolution } | { ok: false; message: string } {
  const requestedPath = resolve(repoArg);
  const requestedDirectory = readDirectoryMetadata(requestedPath, command);
  if (!requestedDirectory.ok) return { ok: false, message: requestedDirectory.message };
  if (!requestedDirectory.stat.isDirectory()) {
    return { ok: false, message: `${command}: invalid repo ${requestedPath} is not a directory` };
  }
  const gitRoot = runGit(requestedPath, ["rev-parse", "--show-toplevel"]);
  if (gitRoot.status !== 0 || gitRoot.stdout.trim().length === 0) {
    return {
      ok: true,
      resolution: {
        requestedPath: requestedDirectory.realpath,
        root: requestedDirectory.realpath,
        git: false
      }
    };
  }
  return resolveGitRepo(requestedDirectory.realpath, gitRoot.stdout.trim(), command);
}

function resolveGitRepo(
  requestedPath: string,
  rootPath: string,
  command: string
): { ok: true; resolution: RepoResolution } | { ok: false; message: string } {
  const rootDirectory = readDirectoryMetadata(rootPath, command);
  if (!rootDirectory.ok) return { ok: false, message: rootDirectory.message };
  if (!rootDirectory.stat.isDirectory()) {
    return { ok: false, message: `${command}: invalid repo ${rootPath} is not a directory` };
  }
  return {
    ok: true,
    resolution: {
      requestedPath,
      root: rootDirectory.realpath,
      git: true
    }
  };
}

function readDirectoryMetadata(
  path: string,
  command: string
): { ok: true; stat: ReturnType<typeof statSync>; realpath: string } | { ok: false; message: string } {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    return { ok: false, message: invalidRepoMessage(path, error, "does not exist", command) };
  }
  if (stat.isDirectory()) {
    try {
      readdirSync(path, { withFileTypes: true });
    } catch (error) {
      return { ok: false, message: `${command}: invalid repo ${path} is unreadable: ${errorMessage(error)}` };
    }
  }
  try {
    return { ok: true, stat, realpath: realpathSync(path) };
  } catch (error) {
    return { ok: false, message: `${command}: invalid repo ${path} cannot be resolved: ${errorMessage(error)}` };
  }
}

function invalidRepoMessage(path: string, error: unknown, notFoundFallback: string, command: string): string {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return `${command}: invalid repo ${path} ${notFoundFallback}`;
  return `${command}: invalid repo ${path}: ${errorMessage(error)}`;
}
