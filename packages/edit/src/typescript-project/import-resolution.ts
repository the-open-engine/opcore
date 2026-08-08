import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  isSafeExistingFileInsideRepo,
  replaceImportExtension,
  sourceExtension,
  uniqueValues
} from "./path-policy.js";
import { TypeScriptConfigService } from "./tsconfig.js";
import type { TypeScriptProjectProfile } from "./types.js";

interface ImportResolverRequest {
  repoRoot: string;
  tsconfigPath: string | undefined;
  profile: TypeScriptProjectProfile;
}

interface ImportResolutionOptions {
  baseUrl: string;
  hasBaseUrl: boolean;
  paths: Readonly<Record<string, readonly string[]>>;
}

export class TypeScriptImportResolver {
  private readonly options: ImportResolutionOptions;
  private readonly configService: TypeScriptConfigService;

  constructor(private readonly request: ImportResolverRequest) {
    this.configService = new TypeScriptConfigService(request.profile);
    this.options = this.readOptions();
  }

  resolve(filePath: string): readonly string[] {
    return this.moduleSpecifiers(readFileSync(filePath, "utf8"))
      .flatMap((specifier) => {
        const resolved = this.resolveSpecifier(filePath, specifier);
        return resolved === undefined ? [] : [resolved];
      })
      .sort();
  }

  private moduleSpecifiers(text: string): readonly string[] {
    const specifiers = new Set<string>();
    const staticPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gu;
    const referencePattern = /<reference\s+path=["']([^"']+)["']/gu;
    const dynamicPattern = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu;
    this.collectMatches(specifiers, text, staticPattern);
    this.collectMatches(specifiers, text, referencePattern);
    this.collectMatches(specifiers, text, dynamicPattern);
    return [...specifiers].filter((specifier) =>
      this.isRepoResolvable(specifier)
    ).sort();
  }

  private collectMatches(
    specifiers: Set<string>,
    text: string,
    pattern: RegExp
  ): void {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }

  private resolveSpecifier(
    fromPath: string,
    specifier: string
  ): string | undefined {
    if (this.isRelative(specifier)) {
      return this.resolveModulePath(
        resolve(dirname(fromPath), specifier)
      );
    }
    const mapped = this.resolveMapped(specifier);
    if (mapped !== undefined) return mapped;
    return this.options.hasBaseUrl
      ? this.resolveModulePath(resolve(this.options.baseUrl, specifier))
      : undefined;
  }

  private resolveMapped(specifier: string): string | undefined {
    for (const [pattern, targets] of this.sortedPathMappings()) {
      const wildcard = this.matchPathPattern(pattern, specifier);
      if (wildcard === undefined) continue;
      for (const target of targets) {
        const candidate = resolve(
          this.options.baseUrl,
          this.applyPathMappingTarget(target, wildcard)
        );
        const resolved = this.resolveModulePath(candidate);
        if (resolved !== undefined) return resolved;
      }
    }
    return undefined;
  }

  private resolveModulePath(basePath: string): string | undefined {
    for (const candidate of this.modulePathCandidates(basePath)) {
      if (
        this.request.profile.sourceExtensions.includes(
          sourceExtension(candidate) ?? ""
        ) &&
        isSafeExistingFileInsideRepo(this.request.repoRoot, candidate)
      ) {
        return resolve(candidate);
      }
    }
    return undefined;
  }

  private modulePathCandidates(basePath: string): readonly string[] {
    const extension = sourceExtension(basePath);
    if (extension === ".js" || extension === ".jsx") {
      return this.javascriptImportCandidates(basePath, extension);
    }
    if (extension !== undefined) return [basePath];
    return uniqueValues([
      ...this.request.profile.extensionlessImportCandidates.map(
        (candidate) => `${basePath}${candidate}`
      ),
      ...this.request.profile.extensionlessImportCandidates.map(
        (candidate) => join(basePath, `index${candidate}`)
      )
    ]);
  }

  private javascriptImportCandidates(
    basePath: string,
    extension: ".js" | ".jsx"
  ): readonly string[] {
    const typeScriptCandidates = extension === ".jsx"
      ? [replaceImportExtension(basePath, ".tsx"), replaceImportExtension(basePath, ".ts")]
      : [replaceImportExtension(basePath, ".ts"), replaceImportExtension(basePath, ".tsx")];
    return uniqueValues([
      ...typeScriptCandidates,
      replaceImportExtension(basePath, ".d.ts"),
      basePath,
      replaceImportExtension(basePath, extension === ".js" ? ".jsx" : ".js")
    ]);
  }

  private readOptions(): ImportResolutionOptions {
    const configDirectory = this.request.tsconfigPath === undefined
      ? this.request.repoRoot
      : dirname(this.request.tsconfigPath);
    const config = this.readConfig();
    const compilerOptions = config?.compilerOptions;
    const configuredBaseUrl = compilerOptions?.baseUrl;
    const hasBaseUrl =
      typeof configuredBaseUrl === "string" && configuredBaseUrl.length > 0;
    return {
      baseUrl: hasBaseUrl
        ? resolve(configDirectory, configuredBaseUrl)
        : configDirectory,
      hasBaseUrl,
      paths: this.normalizePathMappings(compilerOptions?.paths)
    };
  }

  private readConfig() {
    if (this.request.tsconfigPath === undefined) return undefined;
    try {
      return this.configService.parse(this.request.tsconfigPath);
    } catch (error) {
      if (!this.request.profile.tolerateMalformedImportConfig) throw error;
      return undefined;
    }
  }

  private normalizePathMappings(
    paths: unknown
  ): Readonly<Record<string, readonly string[]>> {
    if (paths === null || typeof paths !== "object" || Array.isArray(paths)) {
      return {};
    }
    const normalized: Record<string, readonly string[]> = {};
    for (const [pattern, targets] of Object.entries(paths)) {
      if (Array.isArray(targets)) {
        normalized[pattern] = targets.filter(
          (target): target is string => typeof target === "string"
        );
      }
    }
    return normalized;
  }

  private sortedPathMappings(): readonly [string, readonly string[]][] {
    return Object.entries(this.options.paths)
      .filter(
        (entry): entry is [string, readonly string[]] => entry[1].length > 0
      )
      .sort(
        (left, right) =>
          this.pathPatternRank(right[0]) - this.pathPatternRank(left[0])
      );
  }

  private pathPatternRank(pattern: string): number {
    const starIndex = pattern.indexOf("*");
    return starIndex === -1 ? pattern.length * 2 + 1 : pattern.length - 1;
  }

  private matchPathPattern(
    pattern: string,
    specifier: string
  ): string | undefined {
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) return pattern === specifier ? "" : undefined;
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
      return undefined;
    }
    return specifier.slice(prefix.length, specifier.length - suffix.length);
  }

  private applyPathMappingTarget(target: string, wildcard: string): string {
    return target.includes("*") ? target.replaceAll("*", wildcard) : target;
  }

  private isRepoResolvable(specifier: string): boolean {
    return (
      specifier.length > 0 &&
      !specifier.startsWith("/") &&
      !specifier.includes("://")
    );
  }

  private isRelative(specifier: string): boolean {
    return specifier.startsWith("./") || specifier.startsWith("../");
  }
}
