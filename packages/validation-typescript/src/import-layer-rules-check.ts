import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import ts from "typescript";
import { TYPE_SCRIPT_IMPORT_LAYER_RULES_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { scriptKindForPath, sortValidationDiagnostics } from "./diagnostics.js";
import { materializeTypeScriptSources } from "./source-files.js";

export interface TypeScriptImportLayerRule {
  name: string;
  comment?: string;
  from: string;
  to: string;
  fromNot?: readonly string[];
}

export interface TypeScriptImportLayerRulesOptions {
  ignoreTypeOnlyImports?: boolean;
  layerRules?: readonly TypeScriptImportLayerRule[];
}

export function createImportLayerRulesCheck(options: TypeScriptImportLayerRulesOptions = {}): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_IMPORT_LAYER_RULES_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: false,
    run: async (context) => {
      const rules = options.layerRules ?? [];
      if (rules.length === 0) return { diagnostics: [] };
      const sourceSet = await materializeTypeScriptSources(context);
      const typeOnly = typeOnlyImportSpecifiers(sourceSet.files);
      const diagnostics: ValidationDiagnostic[] = [];
      for (const relativeImport of sourceSet.relativeImports) {
        if (options.ignoreTypeOnlyImports === true && typeOnly.get(relativeImport.fromPath)?.has(relativeImport.specifier)) continue;
        for (const rule of rules) {
          if (!layerRuleMatches(rule, relativeImport.fromPath, relativeImport.resolvedPath)) continue;
          diagnostics.push({
            category: "policy",
            severity: "error",
            path: relativeImport.fromPath,
            code: "TS_IMPORT_LAYER_RULE",
            message: `TypeScript import layer rule ${rule.name} forbids ${relativeImport.fromPath} importing ${relativeImport.resolvedPath}.`
          });
        }
      }
      return { diagnostics: sortValidationDiagnostics(diagnostics) };
    }
  };
}

function typeOnlyImportSpecifiers(
  files: readonly { path: string; content: string }[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const byPath = new Map<string, Set<string>>();
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKindForPath(file.path));
    const specifiers = new Set<string>();
    sourceFile.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(node) && node.isTypeOnly === true && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    });
    if (specifiers.size > 0) byPath.set(file.path, specifiers);
  }
  return byPath;
}

function layerRuleMatches(rule: TypeScriptImportLayerRule, fromPath: string, toPath: string): boolean {
  if (!patternMatches(rule.from, fromPath)) return false;
  if (rule.fromNot?.some((pattern) => patternMatches(pattern, fromPath)) === true) return false;
  return patternMatches(rule.to, toPath);
}

function patternMatches(pattern: string, path: string): boolean {
  const regex = wildcardRegex(pattern);
  return regex.test(path) || regex.test(`/${path}`);
}

function wildcardRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("%").map(escapeRegex).join(".*")}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
