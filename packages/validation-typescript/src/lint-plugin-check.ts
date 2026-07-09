import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { errorMessage, isPlainObject } from "@the-open-engine/opcore-validation";
import { simpleTraverse, type TSESTree } from "@typescript-eslint/typescript-estree";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TYPE_SCRIPT_LINT_PLUGIN_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { canonicalPath, lintPluginCacheKey } from "./lint-plugin-cache.js";
import { parseLintSource, type ParsedLintSource } from "./lint-helpers.js";
import { materializeTypeScriptSources, type TypeScriptMaterializedSourceFile } from "./source-files.js";

export interface TypeScriptLintPluginOptions {
  repoRoot: string;
  repoPlugin: string;
  cacheDependencyGlobs?: readonly string[];
}

export interface TypeScriptLintPluginRuleContext {
  file: TypeScriptMaterializedSourceFile;
  source: ParsedLintSource;
  report: (diagnostic: TypeScriptLintPluginReport) => void;
  traverse: (visitor: (node: TSESTree.Node, parent: TSESTree.Node | undefined) => void) => void;
}

export interface TypeScriptLintPluginReport {
  message: string;
  code?: string;
  severity?: ValidationDiagnostic["severity"];
  path?: string;
  node?: TSESTree.Node;
}

export type TypeScriptLintPluginRuleRun = (
  context: TypeScriptLintPluginRuleContext
) => void | readonly TypeScriptLintPluginReport[] | Promise<void | readonly TypeScriptLintPluginReport[]>;

export interface TypeScriptLintPluginRule {
  id: string;
  run: TypeScriptLintPluginRuleRun;
}

type TypeScriptLintPluginRuleExport =
  {
    id?: string;
    run?: TypeScriptLintPluginRuleRun;
  };

interface CachedLintPlugin {
  key: string;
  rules: readonly TypeScriptLintPluginRule[];
}

class LintPluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LintPluginConfigError";
  }
}

const pluginCache = new Map<string, CachedLintPlugin>();

export function createLintPluginCheck(options: TypeScriptLintPluginOptions): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_LINT_PLUGIN_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: false,
    run: async (context) => {
      let rules: readonly TypeScriptLintPluginRule[];
      try {
        rules = loadLintPlugin(options);
      } catch (error) {
        if (error instanceof LintPluginConfigError) {
          return {
            diagnostics: [],
            status: "unsupported_request",
            failureMessage: error.message
          };
        }
        throw error;
      }

      const sourceSet = await materializeTypeScriptSources(context);
      const diagnostics: ValidationDiagnostic[] = [];
      for (const file of sourceSet.files) {
        diagnostics.push(...(await lintTypeScriptSourceWithPlugin(context, file, rules)));
      }
      return { diagnostics };
    }
  };
}

async function lintTypeScriptSourceWithPlugin(
  _context: ValidationCheckContext,
  file: TypeScriptMaterializedSourceFile,
  rules: readonly TypeScriptLintPluginRule[]
): Promise<readonly ValidationDiagnostic[]> {
  const parsed = parseLintSource(file);
  if (parsed instanceof Error) {
    return [
      {
        category: "lint",
        severity: "error",
        path: file.path,
        code: "TS_LINT_PLUGIN_PARSE_FAILED",
        message: `TypeScript lint plugin parse failed for ${file.path}: ${parsed.message}`
      }
    ];
  }

  const diagnostics: ValidationDiagnostic[] = [];
  for (const rule of rules) {
    const reports: TypeScriptLintPluginReport[] = [];
    const context: TypeScriptLintPluginRuleContext = {
      file,
      source: parsed,
      report: (report) => reports.push(report),
      traverse: (visitor) => {
        simpleTraverse(parsed.ast, {
          enter: (node, parent) => visitor(node, parent)
        });
      }
    };
    const returned = await rule.run(context);
    if (returned !== undefined) reports.push(...returned);
    diagnostics.push(...reports.map((report) => pluginDiagnostic(file.path, rule.id, report)));
  }
  return diagnostics;
}

function loadLintPlugin(options: TypeScriptLintPluginOptions): readonly TypeScriptLintPluginRule[] {
  const repoRoot = canonicalPath(resolve(options.repoRoot));
  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  const pluginPath = resolvePluginPath(repoRoot, requireFromRepo, options.repoPlugin);
  const key = lintPluginCacheKey(repoRoot, pluginPath, options.cacheDependencyGlobs ?? []);
  const cached = pluginCache.get(pluginPath);
  if (cached?.key === key) return cached.rules;
  delete requireFromRepo.cache[pluginPath];
  const loaded = requireFromRepo(pluginPath);
  const rules = normalizePluginRules(loaded);
  pluginCache.set(pluginPath, { key, rules });
  return rules;
}

function resolvePluginPath(repoRoot: string, requireFromRepo: ReturnType<typeof createRequire>, specifier: string): string {
  if (isAbsolute(specifier)) throw new LintPluginConfigError("TypeScript lint repoPlugin must be repo-relative, not absolute");
  if (!specifier.startsWith("./")) {
    throw new LintPluginConfigError("TypeScript lint repoPlugin must start with ./ and stay inside the repo");
  }
  if (specifier.split(/[\\/]+/).includes("..")) {
    throw new LintPluginConfigError("TypeScript lint repoPlugin must not contain parent traversal");
  }
  const candidate = resolve(repoRoot, specifier);
  assertInsideRepo(repoRoot, candidate, "TypeScript lint repoPlugin");
  let resolved: string;
  try {
    resolved = canonicalPath(requireFromRepo.resolve(candidate));
  } catch (error) {
    throw new LintPluginConfigError(`Failed to resolve TypeScript lint repoPlugin ${specifier}: ${errorMessage(error)}`);
  }
  assertInsideRepo(repoRoot, resolved, "TypeScript lint repoPlugin");
  return resolved;
}

function normalizePluginRules(loaded: unknown): readonly TypeScriptLintPluginRule[] {
  const candidate = isPlainObject(loaded) && "default" in loaded ? loaded.default : loaded;
  if (!isPlainObject(candidate)) throw new LintPluginConfigError("TypeScript lint plugin export must be an object");
  const rules = candidate.rules;
  if (Array.isArray(rules)) return rules.map((rule, index) => normalizeRule(rule, String(index)));
  if (isPlainObject(rules)) return Object.entries(rules).map(([id, rule]) => normalizeRule(rule, id));
  throw new LintPluginConfigError("TypeScript lint plugin export must include rules");
}

function normalizeRule(rule: unknown, fallbackId: string): TypeScriptLintPluginRule {
  if (typeof rule === "function") {
    return { id: fallbackId, run: rule as TypeScriptLintPluginRuleRun };
  }
  if (!isPlainObject(rule)) throw new LintPluginConfigError(`TypeScript lint plugin rule ${fallbackId} must be an object or function`);
  const exportedRule = rule as TypeScriptLintPluginRuleExport;
  const id = typeof exportedRule.id === "string" && exportedRule.id.trim().length > 0 ? exportedRule.id.trim() : fallbackId;
  if (typeof exportedRule.run !== "function") {
    throw new LintPluginConfigError(`TypeScript lint plugin rule ${id} must export run()`);
  }
  return { id, run: exportedRule.run };
}

function pluginDiagnostic(path: string, ruleId: string, report: TypeScriptLintPluginReport): ValidationDiagnostic {
  return {
    category: "lint",
    severity: report.severity ?? "error",
    path: report.path ?? path,
    code: report.code ?? `TS_LINT_PLUGIN_${diagnosticCodeSuffix(ruleId)}`,
    message: report.message
  };
}

function assertInsideRepo(repoRoot: string, path: string, label: string): void {
  const relativePath = relative(repoRoot, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return;
  throw new LintPluginConfigError(`${label} must stay inside the repo`);
}

function diagnosticCodeSuffix(ruleId: string): string {
  const suffix = ruleId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return suffix.length > 0 ? suffix : "RULE";
}
