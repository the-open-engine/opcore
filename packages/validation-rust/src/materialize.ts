import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { runTool } from "./process.js";
import { uniqueSorted } from "./source-files.js";

export interface MaterializedRustWorkspace {
  tempRoot: string;
  root: string;
  cleanup: () => void;
}

const excludedParts = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  ".ace",
  ".ro" + "x-cache",
  ".robustness-engine" + "-cache"
]);

export async function materializeRustWorkspace(
  context: ValidationCheckContext,
  options: { env?: Record<string, string | undefined> } = {}
): Promise<MaterializedRustWorkspace> {
  const tempRoot = mkdtempSync(join(tmpdir(), "lattice-validation-rust-"));
  const root = join(tempRoot, "repo");
  mkdirSync(root, { recursive: true });
  const repoRoot = context.request.repo.repoRoot;
  try {
    if (repoRoot !== undefined && repoRoot.length > 0 && existsSync(repoRoot)) {
      if (context.scope.kind === "tree" && context.scope.treeRef !== undefined) {
        materializeGitTree(repoRoot, root, context.scope.treeRef, options.env);
      } else if (context.scope.kind === "staged") {
        materializeGitIndex(repoRoot, root, options.env);
      } else {
        copyRepo(repoRoot, root);
      }
    }
    await materializeFileViewFiles(root, context, repoRoot !== undefined && existsSync(repoRoot));
    return {
      tempRoot,
      root,
      cleanup: () => rmSync(tempRoot, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function materializeGitIndex(
  repoRoot: string,
  destination: string,
  env: Record<string, string | undefined> | undefined
): void {
  const checkout = runTool("git", ["-C", repoRoot, "checkout-index", "--all", "--force", `--prefix=${destination}/`], { env });
  if (!checkout.ok) throw new Error(checkout.failureMessage ?? "Git staged index checkout unavailable");
}

function materializeGitTree(
  repoRoot: string,
  destination: string,
  treeRef: string,
  env: Record<string, string | undefined> | undefined
): void {
  const archive = runTool("git", ["-C", repoRoot, "archive", "--format=tar", treeRef], { env });
  if (!archive.ok) throw new Error(archive.failureMessage ?? "Git tree archive unavailable");
  const tar = runTool("tar", ["-x", "-C", destination], { env, input: archive.stdout });
  if (!tar.ok) throw new Error(tar.failureMessage ?? "Git tree archive extraction unavailable");
}

function copyRepo(repoRoot: string, destination: string): void {
  cpSync(repoRoot, destination, {
    recursive: true,
    force: true,
    filter: (source) => shouldCopyPath(repoRoot, source)
  });
}

function shouldCopyPath(repoRoot: string, source: string): boolean {
  const normalized = relative(repoRoot, source).replaceAll("\\", "/");
  if (normalized.length === 0) return true;
  return normalized.split("/").every((part) => !excludedParts.has(part));
}

async function materializeFileViewFiles(root: string, context: ValidationCheckContext, repoWasCopied: boolean): Promise<void> {
  const paths = uniqueSorted([
    ...(!repoWasCopied ? context.fileView.scopeFiles : []),
    ...context.fileView.overlays.map((overlay) => overlay.path)
  ]);
  for (const path of paths) {
    const result = await context.fileView.readAfter(path);
    const absolutePath = resolveRepoPath(root, path);
    if (result.status === "deleted" || result.status === "missing") {
      try {
        await unlink(absolutePath);
      } catch {
        // Missing files are already materialized as absent.
      }
      continue;
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, result.content);
  }
}

export function resolveRepoPath(root: string, path: string): string {
  const absolutePath = resolve(root, path);
  const relativePath = relative(root, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.split(sep).includes("..")) {
    throw new Error(`Repo-relative path escapes materialized workspace: ${path}`);
  }
  return absolutePath;
}
