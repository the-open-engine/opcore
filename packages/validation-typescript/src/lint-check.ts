import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { TYPE_SCRIPT_LINT_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { parseLintSource } from "./lint-helpers.js";
import { collectTypeScriptLintDiagnostics } from "./lint-rules.js";
import { materializeTypeScriptSources, readOptionalRepoFile, type TypeScriptMaterializedSourceFile } from "./source-files.js";

export function createLintCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_LINT_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedTypeScriptValidationScopes,
    defaultScopes: [],
    requiresGraph: false,
    run: async (context) => {
      const sourceSet = await materializeTypeScriptSources(context);
      const diagnostics: ValidationDiagnostic[] = [];
      for (const file of sourceSet.files) {
        diagnostics.push(...(await lintTypeScriptSource(context, file)));
      }
      return { diagnostics };
    }
  };
}

async function lintTypeScriptSource(
  context: ValidationCheckContext,
  file: TypeScriptMaterializedSourceFile
): Promise<readonly ValidationDiagnostic[]> {
  const parsed = parseLintSource(file);
  if (parsed instanceof Error) {
    return [
      {
        category: "syntax",
        severity: "error",
        path: file.path,
        code: "TS_LINT_PARSE_FAILED",
        message: `TypeScript lint parse failed for ${file.path}: ${parsed.message}`
      }
    ];
  }
  return collectTypeScriptLintDiagnostics(parsed, await optionalDependenciesForFile(context, file.path));
}

async function optionalDependenciesForFile(context: ValidationCheckContext, filePath: string): Promise<ReadonlySet<string>> {
  const dependencies = new Set<string>();
  for (const packageJsonPath of packageJsonCandidatePaths(filePath)) {
    const content = await readOptionalRepoFile(context, packageJsonPath);
    if (content === undefined) continue;
    for (const dependency of optionalDependencyNames(content)) dependencies.add(dependency);
  }
  return dependencies;
}

function packageJsonCandidatePaths(filePath: string): readonly string[] {
  const directoryParts = filePath.split("/").slice(0, -1);
  const candidates = ["package.json"];
  for (let index = 0; index < directoryParts.length; index += 1) {
    candidates.push(`${directoryParts.slice(0, index + 1).join("/")}/package.json`);
  }
  return candidates;
}

function optionalDependencyNames(content: string): readonly string[] {
  try {
    const parsed = JSON.parse(content) as { optionalDependencies?: unknown };
    if (!parsed.optionalDependencies || typeof parsed.optionalDependencies !== "object" || Array.isArray(parsed.optionalDependencies)) {
      return [];
    }
    return Object.keys(parsed.optionalDependencies).filter((name) => name.length > 0).sort();
  } catch {
    return [];
  }
}
