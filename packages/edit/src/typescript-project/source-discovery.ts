import { extname, resolve } from "node:path";
import { discoverRepoFiles } from "./filesystem-discovery.js";
import { TypeScriptImportResolver } from "./import-resolution.js";
import {
  isPathInside,
  isSafeExistingDirectoryInsideRepo,
  isSafeExistingFileInsideRepo,
  uniqueSortedValues
} from "./path-policy.js";
import type { TypeScriptProjectProfile } from "./types.js";

export interface SourceClosureRequest {
  repoRoot: string;
  tsconfigPath: string | undefined;
  rootRepoPaths: readonly string[];
  includeDependents: boolean;
}

export class TypeScriptSourceService {
  constructor(private readonly profile: TypeScriptProjectProfile) {}

  isSupported(path: string): boolean {
    return this.profile.sourceExtensions.includes(extname(path).toLowerCase());
  }

  list(repoRoot: string): string[] {
    return discoverRepoFiles(
      repoRoot,
      this.profile.excludedDirectories,
      (path) => this.isSupported(path)
    );
  }

  scoped(request: SourceClosureRequest): string[] {
    return new SourceClosure(this, this.profile, request).collect();
  }

  rootFiles(request: SourceClosureRequest): string[] {
    const files: string[] = [];
    for (const rootRepoPath of request.rootRepoPaths) {
      const absolutePath = resolve(request.repoRoot, rootRepoPath);
      if (
        this.isSupported(absolutePath) &&
        isSafeExistingFileInsideRepo(request.repoRoot, absolutePath)
      ) {
        files.push(resolve(absolutePath));
      } else if (
        this.profile.allowDirectoryRoots &&
        isSafeExistingDirectoryInsideRepo(request.repoRoot, absolutePath)
      ) {
        files.push(
          ...this.list(request.repoRoot)
            .filter((filePath) => isPathInside(absolutePath, filePath))
        );
      }
    }
    return uniqueSortedValues(files);
  }

}

class SourceClosure {
  private readonly resolver: TypeScriptImportResolver;
  private readonly importsByFile = new Map<string, readonly string[]>();
  private readonly selected = new Set<string>();
  private readonly reverseTargets: Set<string>;
  private readonly allSourceFiles: readonly string[];

  constructor(
    private readonly sourceService: TypeScriptSourceService,
    profile: TypeScriptProjectProfile,
    private readonly request: SourceClosureRequest
  ) {
    this.resolver = new TypeScriptImportResolver({
      repoRoot: request.repoRoot,
      tsconfigPath: request.tsconfigPath,
      profile
    });
    const roots = sourceService.rootFiles(request);
    this.reverseTargets = new Set(roots);
    this.allSourceFiles = request.includeDependents
      ? sourceService.list(request.repoRoot)
      : [];
    this.addForwardClosure(roots);
  }

  collect(): string[] {
    if (this.request.includeDependents) this.addDependents();
    return [...this.selected].sort();
  }

  private addDependents(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const filePath of this.allSourceFiles) {
        if (this.selected.has(filePath)) continue;
        const importsSelected = this.imports(filePath)
          .some((target) => this.reverseTargets.has(target));
        if (!importsSelected) continue;
        const sizeBefore = this.selected.size;
        this.addForwardClosure([filePath]);
        this.reverseTargets.add(filePath);
        if (this.selected.size !== sizeBefore) changed = true;
      }
    }
  }

  private addForwardClosure(rootFiles: readonly string[]): void {
    const pending = [...rootFiles].sort();
    for (let index = 0; index < pending.length; index += 1) {
      const filePath = pending[index];
      if (this.selected.has(filePath)) continue;
      this.selected.add(filePath);
      for (const importedPath of this.imports(filePath)) {
        if (!this.selected.has(importedPath) && !pending.includes(importedPath)) {
          pending.push(importedPath);
        }
      }
    }
  }

  private imports(filePath: string): readonly string[] {
    const cached = this.importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const imports = this.resolver.resolve(filePath);
    this.importsByFile.set(filePath, imports);
    return imports;
  }
}
