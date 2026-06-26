import {
  chmod,
  chown,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RepoRelativeChange } from "@the-open-engine/opcore-contracts";

export interface EditFileStat {
  mode: number;
  uid: number;
  gid: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface EditFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options?: { mode?: number } | "utf8"): Promise<void>;
  stat(path: string): Promise<EditFileStat>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
}

export interface EditFailureHooks {
  beforeStage?(change: RepoRelativeChange, index: number): void | Promise<void>;
  afterStage?(change: RepoRelativeChange, index: number, tempPath: string): void | Promise<void>;
  beforeCommit?(change: RepoRelativeChange, index: number): void | Promise<void>;
  afterCommit?(change: RepoRelativeChange, index: number): void | Promise<void>;
  beforeRollback?(path: string): void | Promise<void>;
  afterRollback?(path: string): void | Promise<void>;
}

export interface CreateNodeEditWorkspaceOptions {
  repoRoot: string;
  fileSystem?: EditFileSystem;
  failureHooks?: EditFailureHooks;
}

export interface EditWorkspace {
  readonly repoRoot: string;
  readonly fileSystem: EditFileSystem;
  readonly failureHooks?: EditFailureHooks;
  resolveRepoPath(path: string): string;
  nearestExistingAncestor(path: string): Promise<string>;
  createTempPath(directory: string): string;
}

const nodeFileSystem: EditFileSystem = {
  readFile,
  writeFile,
  stat,
  realpath,
  mkdir,
  rename,
  rm,
  chmod,
  chown
};

let tempCounter = 0;

export async function createNodeEditWorkspace(options: CreateNodeEditWorkspaceOptions): Promise<EditWorkspace> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const repoRoot = await fileSystem.realpath(resolve(options.repoRoot));
  void tmpdir();

  return {
    repoRoot,
    fileSystem,
    failureHooks: options.failureHooks,
    resolveRepoPath(path: string): string {
      return resolve(repoRoot, path);
    },
    async nearestExistingAncestor(path: string): Promise<string> {
      let current = dirname(resolve(repoRoot, path));
      for (;;) {
        try {
          const currentStat = await fileSystem.stat(current);
          if (!currentStat.isDirectory()) {
            throw new Error(`Nearest existing ancestor is not a directory: ${current}`);
          }
          return current;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        const parent = dirname(current);
        if (parent === current) {
          throw new Error(`No existing ancestor found under ${repoRoot} for ${path}`);
        }
        current = parent;
      }
    },
    createTempPath(directory: string): string {
      tempCounter += 1;
      return join(directory, `.lattice-edit-${Date.now()}-${tempCounter}.tmp`);
    }
  };
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
