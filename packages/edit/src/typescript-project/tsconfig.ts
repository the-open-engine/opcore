import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ts } from "ts-morph";
import { discoverRepoFiles } from "./filesystem-discovery.js";
import {
  isPathInside,
  isSafeExistingFileInsideRepo
} from "./path-policy.js";
import type { TypeScriptProjectProfile } from "./types.js";

export interface TypeScriptConfigJson {
  references?: readonly { path?: string }[];
  files?: readonly string[];
  include?: readonly string[];
  compilerOptions?: {
    baseUrl?: unknown;
    paths?: unknown;
  };
}

export class TypeScriptConfigService {
  constructor(private readonly profile: TypeScriptProjectProfile) {}

  preferred(
    repoRoot: string,
    preferredRepoPath: string | undefined,
    explicitPath: string | undefined
  ): string | undefined {
    const explicit = this.resolveExplicit(repoRoot, explicitPath);
    if (explicit !== undefined) return explicit;
    const rootConfig = join(repoRoot, "tsconfig.json");
    if (this.profile.configMode === "root") {
      return isSafeExistingFileInsideRepo(repoRoot, rootConfig)
        ? resolve(rootConfig)
        : undefined;
    }
    const preferredAbsolutePath = preferredRepoPath === undefined
      ? undefined
      : resolve(repoRoot, preferredRepoPath);
    return this.resolveReferenceAware(
      repoRoot,
      rootConfig,
      preferredAbsolutePath,
      new Set()
    );
  }

  collect(repoRoot: string): string[] {
    const discovered = new Set<string>();
    const queue = [
      join(repoRoot, "tsconfig.json"),
      ...this.list(repoRoot)
    ];
    for (let index = 0; index < queue.length; index += 1) {
      const configPath = resolve(queue[index]);
      if (
        discovered.has(configPath) ||
        !isSafeExistingFileInsideRepo(repoRoot, configPath)
      ) {
        continue;
      }
      discovered.add(configPath);
      this.appendReferences(repoRoot, configPath, queue);
    }
    return [...discovered].sort();
  }

  parse(configPath: string): TypeScriptConfigJson {
    const parsed = ts.parseConfigFileTextToJson(
      configPath,
      readFileSync(configPath, "utf8")
    );
    if (parsed.error !== undefined) {
      throw new Error(
        ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")
      );
    }
    return parsed.config as TypeScriptConfigJson;
  }

  private resolveExplicit(
    repoRoot: string,
    configPath: string | undefined
  ): string | undefined {
    if (configPath === undefined) return undefined;
    const absolutePath = resolve(repoRoot, configPath);
    return isSafeExistingFileInsideRepo(repoRoot, absolutePath)
      ? absolutePath
      : undefined;
  }

  private resolveReferenceAware(
    repoRoot: string,
    configPath: string,
    preferredAbsolutePath: string | undefined,
    seen: Set<string>
  ): string | undefined {
    if (!isSafeExistingFileInsideRepo(repoRoot, configPath)) return undefined;
    const normalizedPath = resolve(configPath);
    if (seen.has(normalizedPath)) return undefined;
    seen.add(normalizedPath);
    try {
      const config = this.parse(configPath);
      if (!this.isReferenceOnly(config)) return configPath;
      const candidates = this.referencedPaths(repoRoot, configPath, config);
      const selected = this.selectReference(
        repoRoot,
        candidates,
        preferredAbsolutePath,
        seen
      );
      if (selected !== undefined) return selected;
      if (candidates[0] !== undefined) return candidates[0];
      return configPath;
    } catch {
      return configPath;
    }
  }

  private selectReference(
    repoRoot: string,
    candidates: readonly string[],
    preferredAbsolutePath: string | undefined,
    seen: ReadonlySet<string>
  ): string | undefined {
    if (preferredAbsolutePath === undefined) return undefined;
    return candidates
      .flatMap((candidate) => {
        const resolved = this.resolveReferenceAware(
          repoRoot,
          candidate,
          preferredAbsolutePath,
          new Set(seen)
        );
        return resolved === undefined ? [] : [resolved];
      })
      .filter((candidate, index, values) => values.indexOf(candidate) === index)
      .filter((candidate) =>
        isPathInside(dirname(candidate), preferredAbsolutePath)
      )
      .sort(
        (left, right) =>
          dirname(right).length - dirname(left).length ||
          left.localeCompare(right)
      )[0];
  }

  private isReferenceOnly(config: TypeScriptConfigJson): boolean {
    return (
      Array.isArray(config.references) &&
      config.references.length > 0 &&
      Array.isArray(config.files) &&
      config.files.length === 0 &&
      config.include === undefined
    );
  }

  private appendReferences(
    repoRoot: string,
    configPath: string,
    queue: string[]
  ): void {
    try {
      const config = this.parse(configPath);
      queue.push(...this.referencedPaths(repoRoot, configPath, config));
    } catch {
      // Malformed auxiliary configs do not replace the preferred project config.
    }
  }

  private referencedPaths(
    repoRoot: string,
    configPath: string,
    config: TypeScriptConfigJson
  ): string[] {
    const candidates: string[] = [];
    const references = config.references;
    for (const reference of references === undefined ? [] : references) {
      if (!reference.path) continue;
      const candidate = reference.path.endsWith(".json")
        ? resolve(dirname(configPath), reference.path)
        : resolve(dirname(configPath), reference.path, "tsconfig.json");
      if (isSafeExistingFileInsideRepo(repoRoot, candidate)) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  private list(repoRoot: string): string[] {
    return discoverRepoFiles(
      repoRoot,
      this.profile.excludedDirectories,
      (_path, name) => name === "tsconfig.json"
    );
  }
}
