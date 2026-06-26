import type { ValidationCheckContext } from "@the-open-engine/lattice-validation";
import ts from "typescript";
import { readOptionalRepoFile } from "./source-files.js";

export interface ResolvedTypeScriptCompilerOptions {
  options: ts.CompilerOptions;
  diagnostics: readonly ts.Diagnostic[];
}

const optionsCache = new WeakMap<object, Promise<ResolvedTypeScriptCompilerOptions>>();

const deterministicCompilerOptions = {
  allowJs: true,
  checkJs: true,
  esModuleInterop: true,
  forceConsistentCasingInFileNames: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022
} as const satisfies ts.CompilerOptions;

export async function resolveTypeScriptCompilerOptions(
  context: ValidationCheckContext
): Promise<ResolvedTypeScriptCompilerOptions> {
  const cached = optionsCache.get(context.fileView);
  if (cached !== undefined) return cached;
  const promise = resolveTypeScriptCompilerOptionsUncached(context);
  optionsCache.set(context.fileView, promise);
  return promise;
}

async function resolveTypeScriptCompilerOptionsUncached(
  context: ValidationCheckContext
): Promise<ResolvedTypeScriptCompilerOptions> {
  const diagnostics: ts.Diagnostic[] = [];
  const configOptions: ts.CompilerOptions[] = [];
  for (const configPath of configPaths(context)) {
    const content = await readOptionalRepoFile(context, configPath);
    if (content === undefined) continue;
    const parsed = ts.parseConfigFileTextToJson(configPath, content);
    if (parsed.error !== undefined) {
      diagnostics.push(parsed.error);
      continue;
    }
    const converted = ts.convertCompilerOptionsFromJson(parsed.config?.compilerOptions ?? {}, configBasePath(configPath), configPath);
    diagnostics.push(...converted.errors);
    configOptions.push(converted.options);
  }
  return {
    options: {
      ...deterministicCompilerOptions,
      ...Object.assign({}, ...configOptions),
      ...deterministicCompilerOptions
    },
    diagnostics
  };
}

function configPaths(context: ValidationCheckContext): readonly string[] {
  const paths = ["tsconfig.json"];
  if (context.scope.kind === "package" && context.scope.packageRoot !== undefined) {
    paths.push(`${context.scope.packageRoot}/tsconfig.json`);
  }
  return [...new Set(paths)];
}

function configBasePath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.length === 0 ? "." : parts.join("/");
}
