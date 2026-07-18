import { errorMessage, isPlainObject } from "@the-open-engine/opcore-validation";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configPath, validationAdapters, type OpcoreClonePolicy, type OpcoreDocsPolicy, type OpcoreFileLengthThresholds, type OpcoreLayerRule, type OpcoreMetricThresholds, type OpcorePathPolicy, type OpcoreRepoChecksConfig, type OpcoreRepoConfig, type OpcoreRepoValidationConfig, type OpcoreRustCommandGate, type OpcoreRustPolicy, type OpcoreTypeScriptPolicy, type OpcoreValidationAdapterName } from "./types.js";
export function readOpcoreRepoConfig(repoRoot: string): OpcoreRepoConfig {
  const parsed = readConfigObject(resolve(repoRoot));
  return parsed === undefined ? defaultRepoConfig() : { validation: readValidationConfig(parsed.validation) };
}

export function parseOpcoreRepoConfig(content: string | undefined): OpcoreRepoConfig {
  if (content === undefined) return defaultRepoConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid Opcore config ${configPath}: ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Invalid Opcore config ${configPath}: expected JSON object`);
  return { validation: readValidationConfig(parsed.validation) };
}

export function defaultRepoConfig(): OpcoreRepoConfig {
  return { validation: { checks: defaultChecksConfig() } };
}

export function defaultChecksConfig(overrides: Partial<OpcoreRepoChecksConfig> = {}): OpcoreRepoChecksConfig {
  return {
    packs: overrides.packs ?? [],
    disabled: overrides.disabled ?? [],
    defaults: overrides.defaults ?? [],
    ...(overrides.typescript !== undefined ? { typescript: overrides.typescript } : {}),
    ...(overrides.rust !== undefined ? { rust: overrides.rust } : {}),
    ...(overrides.docs !== undefined ? { docs: overrides.docs } : {}),
    ...(overrides.clone !== undefined ? { clone: overrides.clone } : {})
  };
}

function readConfigObject(repoRoot: string): Record<string, unknown> | undefined {
  const absolutePath = join(repoRoot, configPath);
  if (!existsSync(absolutePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Opcore config ${configPath}: ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Invalid Opcore config ${configPath}: expected JSON object`);
  return parsed;
}

function readValidationConfig(value: unknown): OpcoreRepoValidationConfig {
  if (value === undefined) {
    return { checks: defaultChecksConfig() };
  }
  if (!isPlainObject(value)) throw invalid("validation must be an object");
  const adapters = value.adapters === undefined ? undefined : readAdapters(value.adapters, "validation.adapters");
  const timeoutMs = value.timeoutMs === undefined ? undefined : readPositiveInteger(value.timeoutMs, "validation.timeoutMs");
  const pathPolicy = value.pathPolicy === undefined ? undefined : readPathPolicy(value.pathPolicy, "validation.pathPolicy");
  const checks = readChecksConfig(value.checks);
  return {
    ...(adapters !== undefined ? { adapters } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(pathPolicy !== undefined ? { pathPolicy } : {}),
    checks
  };
}

function readChecksConfig(value: unknown): OpcoreRepoChecksConfig {
  if (value === undefined) return defaultChecksConfig();
  if (!isPlainObject(value)) throw invalid("validation.checks must be an object");
  const packs = readOptionalStringArray(value.packs, "validation.checks.packs");
  const disabled = readOptionalStringArray(value.disabled, "validation.checks.disabled");
  const defaults = readOptionalStringArray(value.defaults, "validation.checks.defaults");
  return defaultChecksConfig({
    packs: uniqueStrings(packs),
    disabled: uniqueStrings(disabled),
    defaults: uniqueStrings(defaults),
    typescript: value.typescript === undefined ? undefined : readTypeScriptPolicy(value.typescript, "validation.checks.typescript"),
    rust: value.rust === undefined ? undefined : readRustPolicy(value.rust, "validation.checks.rust"),
    docs: value.docs === undefined ? undefined : readDocsPolicy(value.docs, "validation.checks.docs"),
    clone: value.clone === undefined ? undefined : readClonePolicy(value.clone, "validation.checks.clone")
  });
}

function readTypeScriptPolicy(value: unknown, path: string): OpcoreTypeScriptPolicy {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  const fileLength = value.fileLength === undefined ? undefined : readFileLength(value.fileLength, `${path}.fileLength`);
  const functionMetrics =
    value.functionMetrics === undefined ? undefined : readMetricThresholds(value.functionMetrics, `${path}.functionMetrics`);
  return {
    ...(fileLength === undefined ? {} : { fileLength }),
    ...(functionMetrics === undefined ? {} : { functionMetrics }),
    ...(value.lint !== undefined ? { lint: readTypeScriptLintPolicy(value.lint, `${path}.lint`) } : {}),
    ...(value.importGraph !== undefined ? { importGraph: readTypeScriptImportGraphPolicy(value.importGraph, `${path}.importGraph`) } : {}),
    ...(value.deadCode !== undefined ? { deadCode: readTypeScriptDeadCodePolicy(value.deadCode, `${path}.deadCode`) } : {})
  };
}

function readTypeScriptLintPolicy(value: unknown, path: string): NonNullable<OpcoreTypeScriptPolicy["lint"]> {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    ...(value.repoPlugin !== undefined ? { repoPlugin: readNonEmptyString(value.repoPlugin, `${path}.repoPlugin`) } : {}),
    ...(value.cacheDependencyGlobs !== undefined
      ? { cacheDependencyGlobs: readStringArray(value.cacheDependencyGlobs, `${path}.cacheDependencyGlobs`) }
      : {})
  };
}

function readTypeScriptImportGraphPolicy(value: unknown, path: string): NonNullable<OpcoreTypeScriptPolicy["importGraph"]> {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    ...(value.ignoreTypeOnlyImports !== undefined
      ? { ignoreTypeOnlyImports: readBoolean(value.ignoreTypeOnlyImports, `${path}.ignoreTypeOnlyImports`) }
      : {}),
    ...(value.layerRules !== undefined ? { layerRules: readLayerRules(value.layerRules, `${path}.layerRules`) } : {})
  };
}

function readTypeScriptDeadCodePolicy(value: unknown, path: string): NonNullable<OpcoreTypeScriptPolicy["deadCode"]> {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    ...(value.entrypoints !== undefined ? { entrypoints: readStringArray(value.entrypoints, `${path}.entrypoints`) } : {})
  };
}

function readRustPolicy(value: unknown, path: string): OpcoreRustPolicy {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  const fileLength = value.fileLength === undefined ? undefined : readFileLength(value.fileLength, `${path}.fileLength`);
  const functionMetrics =
    value.functionMetrics === undefined ? undefined : readMetricThresholds(value.functionMetrics, `${path}.functionMetrics`);
  return {
    ...(fileLength === undefined ? {} : { fileLength }),
    ...(functionMetrics === undefined ? {} : { functionMetrics }),
    ...(value.commandGates !== undefined ? { commandGates: readCommandGates(value.commandGates, `${path}.commandGates`) } : {})
  };
}

function readDocsPolicy(value: unknown, path: string): OpcoreDocsPolicy {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    ...(value.enabled !== undefined ? { enabled: readBooleanRecord(value.enabled, `${path}.enabled`) } : {}),
    ...(value.policy !== undefined ? { policy: readUnknownPolicyObject(value.policy, `${path}.policy`) } : {}),
    ...(value.history !== undefined ? { history: readDocsHistory(value.history, `${path}.history`) } : {}),
    ...(value.hubCoverage !== undefined ? { hubCoverage: readDocsHubCoverage(value.hubCoverage, `${path}.hubCoverage`) } : {}),
    ...(value.subtreeCoverage !== undefined ? { subtreeCoverage: readDocsSubtreeCoverage(value.subtreeCoverage, `${path}.subtreeCoverage`) } : {})
  };
}

function readClonePolicy(value: unknown, path: string): OpcoreClonePolicy {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    ...(value.windowSize !== undefined ? { windowSize: readPositiveInteger(value.windowSize, `${path}.windowSize`) } : {}),
    ...(value.minLines !== undefined ? { minLines: readPositiveInteger(value.minLines, `${path}.minLines`) } : {}),
    ...(value.minTokens !== undefined ? { minTokens: readPositiveInteger(value.minTokens, `${path}.minTokens`) } : {}),
    ...(value.threshold !== undefined ? { threshold: readPositiveInteger(value.threshold, `${path}.threshold`) } : {}),
    ...(value.partitions !== undefined ? { partitions: readPartitions(value.partitions, `${path}.partitions`) } : {}),
    ...(value.exclude !== undefined ? { exclude: readStringArray(value.exclude, `${path}.exclude`) } : {}),
    ...(value.modes !== undefined ? { modes: readStringArray(value.modes, `${path}.modes`) } : {})
  };
}

function readPathPolicy(value: unknown, path: string): OpcorePathPolicy {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    ...(value.include !== undefined ? { include: readStringArray(value.include, `${path}.include`) } : {}),
    ...(value.exclude !== undefined ? { exclude: readStringArray(value.exclude, `${path}.exclude`) } : {})
  };
}

function readAdapters(value: unknown, path: string): readonly OpcoreValidationAdapterName[] {
  return readStringArray(value, path).map((adapter, index) => {
    if (!validationAdapters.includes(adapter as OpcoreValidationAdapterName)) {
      throw invalid(`${path}[${index}] must be one of ${validationAdapters.join(", ")}`);
    }
    return adapter as OpcoreValidationAdapterName;
  });
}

function readFileLength(value: unknown, path: string): OpcoreFileLengthThresholds {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return { maxFileLines: readPositiveInteger(value.maxFileLines, `${path}.maxFileLines`) };
}

function readMetricThresholds(value: unknown, path: string): OpcoreMetricThresholds {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    maxFunctionLines: readPositiveInteger(value.maxFunctionLines, `${path}.maxFunctionLines`),
    maxComplexity: readPositiveInteger(value.maxComplexity, `${path}.maxComplexity`),
    maxParams: readPositiveInteger(value.maxParams, `${path}.maxParams`)
  };
}

function readLayerRules(value: unknown, path: string): readonly OpcoreLayerRule[] {
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`);
  return value.map((entry, index) => readLayerRule(entry, `${path}[${index}]`));
}

function readLayerRule(value: unknown, path: string): OpcoreLayerRule {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    name: readNonEmptyString(value.name, `${path}.name`),
    ...(value.comment !== undefined ? { comment: readNonEmptyString(value.comment, `${path}.comment`) } : {}),
    from: readNonEmptyString(value.from, `${path}.from`),
    to: readNonEmptyString(value.to, `${path}.to`),
    ...(value.fromNot !== undefined ? { fromNot: readStringArray(value.fromNot, `${path}.fromNot`) } : {})
  };
}

function readCommandGates(value: unknown, path: string): readonly OpcoreRustCommandGate[] {
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`);
  return value.map((entry, index) => readCommandGate(entry, `${path}[${index}]`));
}

function readCommandGate(value: unknown, path: string): OpcoreRustCommandGate {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    id: readNonEmptyString(value.id, `${path}.id`),
    command: readNonEmptyString(value.command, `${path}.command`),
    ...(value.args !== undefined ? { args: readStringArray(value.args, `${path}.args`) } : {}),
    ...(value.cwd !== undefined ? { cwd: readNonEmptyString(value.cwd, `${path}.cwd`) } : {}),
    ...(value.timeoutMs !== undefined ? { timeoutMs: readPositiveInteger(value.timeoutMs, `${path}.timeoutMs`) } : {})
  };
}

function readDocsHistory(value: unknown, path: string): NonNullable<OpcoreDocsPolicy["history"]> {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return value.maxStaleDays === undefined ? {} : { maxStaleDays: readPositiveInteger(value.maxStaleDays, `${path}.maxStaleDays`) };
}

function readDocsHubCoverage(value: unknown, path: string): NonNullable<OpcoreDocsPolicy["hubCoverage"]> {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return {
    ...(value.minFanIn !== undefined ? { minFanIn: readPositiveInteger(value.minFanIn, `${path}.minFanIn`) } : {}),
    ...(value.minFanOut !== undefined ? { minFanOut: readPositiveInteger(value.minFanOut, `${path}.minFanOut`) } : {}),
    ...(value.requireExplicitMention !== undefined ? { requireExplicitMention: readBoolean(value.requireExplicitMention, `${path}.requireExplicitMention`) } : {})
  };
}

function readDocsSubtreeCoverage(value: unknown, path: string): NonNullable<OpcoreDocsPolicy["subtreeCoverage"]> {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return value.minLoc === undefined ? {} : { minLoc: readPositiveInteger(value.minLoc, `${path}.minLoc`) };
}

function readUnknownPolicyObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  validateUnknownPolicyValue(value, path);
  return value;
}

function validateUnknownPolicyValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateUnknownPolicyValue(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" || value === null) return;
    throw invalid(`${path} contains unsupported value`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number") readPositiveInteger(entry, `${path}.${key}`);
    else validateUnknownPolicyValue(entry, `${path}.${key}`);
  }
}

function readPartitions(value: unknown, path: string): readonly (readonly string[])[] {
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`);
  return value.map((partition, index) => readStringArray(partition, `${path}[${index}]`));
}

function readBooleanRecord(value: unknown, path: string): Record<string, boolean> {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, readBoolean(entry, `${path}.${key}`)]));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function readOptionalStringArray(value: unknown, path: string): readonly string[] {
  return value === undefined ? [] : readStringArray(value, path);
}

function readStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`);
  return value.map((entry, index) => readNonEmptyString(entry, `${path}[${index}]`));
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalid(`${path} must be a non-empty string`);
  return value;
}

function readPositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw invalid(`${path} must be a positive integer`);
  return value as number;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${path} must be a boolean`);
  return value;
}

function invalid(message: string): Error {
  return new Error(`Invalid Opcore config ${configPath}: ${message}`);
}
