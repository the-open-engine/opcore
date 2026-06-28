import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Project, SourceFile } from "ts-morph";
import type { CommandTimingProcessState } from "@the-open-engine/opcore-contracts";
import { isSupportedSymbolSourcePath } from "@the-open-engine/opcore-edit";
import {
  createInspectLanguageServiceProject,
  type InspectLanguageServiceProjectScope
} from "../inspect-language-service.js";

export type WarmProjectScope = InspectLanguageServiceProjectScope;

export interface WarmProjectCheckout {
  project: Project;
  preferredPath: string;
  processState: CommandTimingProcessState;
  scope: WarmProjectScope;
  snapshotProject: (project: Project) => WarmProjectSnapshot;
  revertProject: (project: Project, snapshot: unknown) => void;
}

export interface WarmProjectRegistry {
  checkout(request: WarmProjectCheckoutRequest): WarmProjectCheckout;
  withProject<T>(request: WarmProjectCheckoutRequest, action: (checkout: WarmProjectCheckout) => T): T;
  snapshotProject(project: Project): WarmProjectSnapshot;
  revertProject(project: Project, snapshot: WarmProjectSnapshot): void;
  poison(reason: unknown): void;
  state(): WarmProjectRegistryState;
}

export interface WarmProjectCheckoutRequest {
  preferredPath: string;
  scope?: WarmProjectScope;
}

export interface WarmProjectRegistryOptions {
  repoRoot: string;
}

export interface WarmProjectRegistryState {
  repoRoot: string;
  processState: CommandTimingProcessState;
  poisoned: boolean;
  epoch: string;
  scope?: WarmProjectScope;
  preferredPath?: string;
  sourceFileCount: number;
}

export type WarmProjectSnapshot = {
  files: readonly {
    filePath: string;
    text: string;
  }[];
};

interface WarmProjectSlot {
  project: Project;
  epoch: string;
  scope: WarmProjectScope;
  preferredPath: string;
  sourceFileFingerprint: string;
}

export function createWarmProjectRegistry(options: WarmProjectRegistryOptions): WarmProjectRegistry {
  return new DefaultWarmProjectRegistry(options);
}

class DefaultWarmProjectRegistry implements WarmProjectRegistry {
  private readonly repoRoot: string;
  private slot: WarmProjectSlot | undefined;
  private poisoned = false;

  constructor(options: WarmProjectRegistryOptions) {
    this.repoRoot = realpathIfPossible(resolve(options.repoRoot));
  }

  checkout(request: WarmProjectCheckoutRequest): WarmProjectCheckout {
    const scope = request.scope ?? "import_closure";
    const epoch = currentGitEpoch(this.repoRoot);
    const needsRebuild = shouldRebuildProject(this.slot, {
      epoch,
      poisoned: this.poisoned,
      preferredPath: request.preferredPath,
      scope,
      sourceFileFingerprint: currentSourceFileFingerprint(this.repoRoot, scope)
    });
    const processState: CommandTimingProcessState = needsRebuild ? "cold" : "warm";
    if (needsRebuild) {
      this.slot = this.createSlot(request.preferredPath, scope, epoch);
      this.poisoned = false;
    } else {
      refreshExistingSlot(this.slot, this.repoRoot);
    }
    const slot = this.slot;
    if (slot === undefined) throw new Error("Warm project checkout failed to create a project");
    return {
      project: slot.project,
      preferredPath: request.preferredPath,
      processState,
      scope,
      snapshotProject: (project) => this.snapshotProject(project),
      revertProject: (project, snapshot) => this.revertProject(project, snapshot as WarmProjectSnapshot)
    };
  }

  private createSlot(preferredPath: string, scope: WarmProjectScope, epoch: string): WarmProjectSlot {
    const project = createInspectLanguageServiceProject(this.repoRoot, preferredPath, { projectScope: scope });
    addWarmEditSourceFiles(project, this.repoRoot, scope);
    return {
      project,
      epoch,
      scope,
      preferredPath,
      sourceFileFingerprint: currentSourceFileFingerprint(this.repoRoot, scope)
    };
  }

  withProject<T>(request: WarmProjectCheckoutRequest, action: (checkout: WarmProjectCheckout) => T): T {
    const checkout = this.checkout(request);
    const snapshot = this.snapshotProject(checkout.project);
    try {
      return action(checkout);
    } catch (error) {
      this.poison(error);
      throw error;
    } finally {
      this.revertProject(checkout.project, snapshot);
    }
  }

  snapshotProject(project: Project): WarmProjectSnapshot {
    return {
      files: project.getSourceFiles().map((sourceFile) => ({
        filePath: resolve(sourceFile.getFilePath()),
        text: sourceFile.getFullText()
      }))
    };
  }

  revertProject(project: Project, snapshot: WarmProjectSnapshot): void {
    const textByPath = new Map(snapshot.files.map((entry) => [resolve(entry.filePath), entry.text]));
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = resolve(sourceFile.getFilePath());
      const text = textByPath.get(filePath);
      if (text === undefined) {
        project.removeSourceFile(sourceFile);
        continue;
      }
      if (sourceFile.getFullText() !== text) sourceFile.replaceWithText(text);
    }
    for (const entry of snapshot.files) {
      const filePath = resolve(entry.filePath);
      if (project.getSourceFile(filePath) !== undefined) continue;
      if (!existsSync(filePath)) continue;
      const sourceFile = project.addSourceFileAtPath(filePath);
      if (sourceFile.getFullText() !== entry.text) sourceFile.replaceWithText(entry.text);
    }
  }

  poison(_reason: unknown): void {
    this.poisoned = true;
  }

  state(): WarmProjectRegistryState {
    return {
      repoRoot: this.repoRoot,
      processState: this.slot === undefined || this.poisoned ? "cold" : "warm",
      poisoned: this.poisoned,
      epoch: this.slot?.epoch ?? currentGitEpoch(this.repoRoot),
      ...(this.slot ? { scope: this.slot.scope, preferredPath: this.slot.preferredPath } : {}),
      sourceFileCount: this.slot?.project.getSourceFiles().length ?? 0
    };
  }
}

function shouldRebuildProject(
  slot: WarmProjectSlot | undefined,
  request: { epoch: string; poisoned: boolean; preferredPath: string; scope: WarmProjectScope; sourceFileFingerprint: string }
): boolean {
  if (request.poisoned || slot === undefined) return true;
  if (slot.epoch !== request.epoch || slot.scope !== request.scope) return true;
  if (slot.sourceFileFingerprint !== request.sourceFileFingerprint) return true;
  return request.scope !== "whole_repo" && slot.preferredPath !== request.preferredPath;
}

function refreshExistingSlot(slot: WarmProjectSlot | undefined, repoRoot: string): void {
  if (slot === undefined) throw new Error("Warm project reuse failed because no project slot exists");
  refreshProjectFromFileSystem(slot.project, repoRoot);
}

function refreshProjectFromFileSystem(project: Project, repoRoot: string): void {
  for (const sourceFile of project.getSourceFiles()) {
    if (!isInside(repoRoot, sourceFile.getFilePath())) continue;
    refreshSourceFile(sourceFile);
  }
}

function refreshSourceFile(sourceFile: SourceFile): void {
  const refresh = (sourceFile as SourceFile & { refreshFromFileSystemSync?: () => unknown }).refreshFromFileSystemSync;
  if (typeof refresh === "function") refresh.call(sourceFile);
}

function currentSourceFileFingerprint(repoRoot: string, scope: WarmProjectScope): string {
  if (scope !== "whole_repo") return "scoped";
  return listWarmSourceFiles(repoRoot).join("\n");
}

function addWarmEditSourceFiles(project: Project, repoRoot: string, scope: WarmProjectScope): void {
  if (scope !== "whole_repo") return;
  for (const filePath of listWarmSourceFiles(repoRoot)) {
    if (project.getSourceFile(filePath) === undefined) project.addSourceFileAtPath(filePath);
  }
}

function listWarmSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  visit(repoRoot);
  return files.sort();

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(path);
      } else if (entry.isFile() && isSupportedSymbolSourcePath(path) && isInside(repoRoot, path)) {
        files.push(resolve(path));
      }
    }
  }
}

const excludedDirectories = new Set([
  ".ace",
  ".agents",
  ".claude",
  ".codex",
  ".gemini",
  ".git",
  ".lattice",
  ".opencode",
  ".pnpm",
  ".robustness-engine-cache",
  ".rox-cache",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);

function currentGitEpoch(repoRoot: string): string {
  const gitDir = resolveGitDir(repoRoot);
  if (gitDir === undefined) return "nogit";
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const refPath = join(gitDir, head.slice("ref: ".length).trim());
    const refValue = existsSync(refPath) ? readFileSync(refPath, "utf8").trim() : "missing";
    return `${head}:${refValue}`;
  } catch {
    return "git-unreadable";
  }
}

function resolveGitDir(repoRoot: string): string | undefined {
  const gitPath = join(repoRoot, ".git");
  if (!existsSync(gitPath)) return undefined;
  try {
    const content = readFileSync(gitPath, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/u.exec(content);
    if (match?.[1]) return resolve(repoRoot, match[1]);
  } catch {
    return gitPath;
  }
  return gitPath;
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !/^[A-Za-z]:/.test(relativePath));
}
