import { resolve } from "node:path";
import { Project } from "ts-morph";
import { TypeScriptSourceService } from "./source-discovery.js";
import { TypeScriptConfigService } from "./tsconfig.js";
import type {
  TypeScriptProjectContext,
  TypeScriptProjectOptions,
  TypeScriptProjectProfile,
  TypeScriptProjectScope
} from "./types.js";

const projectScopes = new WeakMap<Project, TypeScriptProjectScope>();

export class TypeScriptProjectService {
  private readonly configService: TypeScriptConfigService;
  private readonly sourceService: TypeScriptSourceService;

  constructor(private readonly profile: TypeScriptProjectProfile) {
    this.configService = new TypeScriptConfigService(profile);
    this.sourceService = new TypeScriptSourceService(profile);
  }

  isSupportedSourcePath(path: string): boolean {
    return this.sourceService.isSupported(path);
  }

  listSourceFiles(repoRoot: string): string[] {
    return this.sourceService.list(repoRoot);
  }

  createProject(
    repoRoot: string,
    preferredRepoPath: string | undefined,
    options: TypeScriptProjectOptions = {}
  ): Project {
    return this.createContext(repoRoot, preferredRepoPath, options).project;
  }

  createContexts(
    repoRoot: string,
    preferredRepoPath: string | undefined,
    options: TypeScriptProjectOptions = {}
  ): TypeScriptProjectContext[] {
    if (options.project !== undefined) {
      return [this.createContext(repoRoot, preferredRepoPath, options)];
    }
    const preferredConfig = this.preferredConfig(
      repoRoot,
      preferredRepoPath,
      options
    );
    const configPaths = this.contextConfigPaths(preferredConfig, repoRoot);
    if (configPaths.length === 0) {
      return [
        this.buildContext(repoRoot, preferredRepoPath, undefined, options)
      ];
    }
    return configPaths.map((configPath) =>
      this.buildContext(repoRoot, preferredRepoPath, configPath, options)
    );
  }

  withSnapshot<T>(context: TypeScriptProjectContext, run: () => T): T {
    if (
      context.snapshotProject === undefined ||
      context.revertProject === undefined
    ) {
      return run();
    }
    const snapshot = context.snapshotProject(context.project);
    try {
      return run();
    } finally {
      context.revertProject(context.project, snapshot);
    }
  }

  private createContext(
    repoRoot: string,
    preferredRepoPath: string | undefined,
    options: TypeScriptProjectOptions
  ): TypeScriptProjectContext {
    const scope = projectScope(options);
    const configPath = this.preferredConfig(
      repoRoot,
      preferredRepoPath,
      options
    );
    if (
      options.project !== undefined &&
      this.canUseInjectedProject(options.project, scope)
    ) {
      this.expandInjectedProject(
        repoRoot,
        preferredRepoPath,
        configPath,
        options
      );
      return {
        project: options.project,
        ...(configPath ? { tsconfigPath: configPath } : {}),
        ...(options.snapshotProject
          ? { snapshotProject: options.snapshotProject }
          : {}),
        ...(options.revertProject
          ? { revertProject: options.revertProject }
          : {})
      };
    }
    return this.buildContext(
      repoRoot,
      preferredRepoPath,
      configPath,
      options
    );
  }

  private buildContext(
    repoRoot: string,
    preferredRepoPath: string | undefined,
    configPath: string | undefined,
    options: TypeScriptProjectOptions
  ): TypeScriptProjectContext {
    const scope = projectScope(options);
    const project = new Project({
      tsConfigFilePath: configPath,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: { allowJs: true, checkJs: false }
    });
    const sourceFiles =
      scope === "whole_repo" || preferredRepoPath === undefined
        ? this.sourceService.list(repoRoot)
        : this.sourceService.scoped({
            repoRoot,
            tsconfigPath: configPath,
            rootRepoPaths: [preferredRepoPath],
            includeDependents:
              options.includeDependents ??
              this.profile.defaultIncludeDependents
          });
    addSourceFiles(project, sourceFiles);
    projectScopes.set(project, scope);
    return {
      project,
      ...(configPath ? { tsconfigPath: configPath } : {})
    };
  }

  private expandInjectedProject(
    repoRoot: string,
    preferredRepoPath: string | undefined,
    configPath: string | undefined,
    options: TypeScriptProjectOptions
  ): void {
    if (
      projectScope(options) !== "import_closure" ||
      preferredRepoPath === undefined ||
      options.project === undefined
    ) {
      return;
    }
    const sourceFiles = this.sourceService.scoped({
      repoRoot,
      tsconfigPath: configPath,
      rootRepoPaths: [preferredRepoPath],
      includeDependents:
        options.includeDependents ?? this.profile.defaultIncludeDependents
    });
    addSourceFiles(options.project, sourceFiles);
  }

  private preferredConfig(
    repoRoot: string,
    preferredRepoPath: string | undefined,
    options: TypeScriptProjectOptions
  ): string | undefined {
    return this.configService.preferred(
      repoRoot,
      preferredRepoPath,
      options.projectTsconfigPath
    );
  }

  private contextConfigPaths(
    preferredConfig: string | undefined,
    repoRoot: string
  ): string[] {
    if (!this.profile.discoverAllConfigs) {
      return preferredConfig === undefined ? [] : [preferredConfig];
    }
    const ordered: string[] = [];
    if (preferredConfig !== undefined) ordered.push(resolve(preferredConfig));
    for (const configPath of this.configService.collect(repoRoot)) {
      if (!ordered.includes(configPath)) ordered.push(configPath);
    }
    return ordered;
  }

  private canUseInjectedProject(
    project: Project,
    requiredScope: TypeScriptProjectScope
  ): boolean {
    return (
      requiredScope !== "whole_repo" ||
      projectScopes.get(project) === "whole_repo"
    );
  }
}

function addSourceFiles(project: Project, filePaths: readonly string[]): void {
  for (const filePath of filePaths) {
    if (project.getSourceFile(filePath) === undefined) {
      project.addSourceFileAtPath(filePath);
    }
  }
}

function projectScope(options: TypeScriptProjectOptions): TypeScriptProjectScope {
  return options.projectScope === undefined
    ? "import_closure"
    : options.projectScope;
}
