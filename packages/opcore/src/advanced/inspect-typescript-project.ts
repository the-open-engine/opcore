import {
  TypeScriptProjectService,
  defaultTypeScriptProjectExcludedDirectories,
  type TypeScriptProjectOptions,
  type TypeScriptProjectScope
} from "@the-open-engine/opcore-edit";
import type { Project } from "ts-morph";

export type InspectLanguageServiceProjectScope = TypeScriptProjectScope;

export interface InspectLanguageServiceOptions extends TypeScriptProjectOptions {}

export const inspectProjectService = new TypeScriptProjectService({
  sourceExtensions: [".ts", ".tsx", ".js", ".jsx"],
  extensionlessImportCandidates: [".ts", ".tsx", ".js", ".jsx", ".d.ts"],
  excludedDirectories: defaultTypeScriptProjectExcludedDirectories,
  allowDirectoryRoots: false,
  configMode: "root",
  discoverAllConfigs: false,
  tolerateMalformedImportConfig: true,
  defaultIncludeDependents: false
});

export function createInspectLanguageServiceProject(
  repoRoot: string,
  preferredRepoPath: string,
  options: InspectLanguageServiceOptions = {}
): Project {
  return inspectProjectService.createProject(repoRoot, preferredRepoPath, options);
}
