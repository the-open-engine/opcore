import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { createValidationCheckRegistry } from "@the-open-engine/opcore-validation";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

const configPath = ".opcore/config";

export interface OpcoreCheckPack {
  id: string;
  version?: string;
  checks: readonly ValidationCheckDefinition[];
}

interface OpcoreRepoConfig {
  checks?: {
    packs?: readonly string[];
  };
}

export function validationChecksForRepo(
  repoRoot: string,
  defaults: readonly ValidationCheckDefinition[]
): readonly ValidationCheckDefinition[] {
  const packs = loadRepoCheckPacks(repoRoot);
  if (packs.length === 0) return defaults;
  const checks = [...defaults, ...packs.flatMap((pack) => pack.checks)];
  createValidationCheckRegistry(checks);
  return checks;
}

export function loadRepoCheckPacks(repoRoot: string): readonly OpcoreCheckPack[] {
  const canonicalRepoRoot = resolve(repoRoot);
  const config = readRepoConfig(canonicalRepoRoot);
  const packSpecifiers = config.checks?.packs ?? [];
  if (packSpecifiers.length === 0) return [];
  const requireFromRepo = createRequire(join(canonicalRepoRoot, "package.json"));
  return packSpecifiers.map((specifier) => loadRepoCheckPack(canonicalRepoRoot, requireFromRepo, specifier));
}

function readRepoConfig(repoRoot: string): OpcoreRepoConfig {
  const absolutePath = join(repoRoot, configPath);
  if (!existsSync(absolutePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Opcore config ${configPath}: ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Invalid Opcore config ${configPath}: expected JSON object`);
  const checks = readChecksConfig(parsed);
  return checks === undefined ? {} : { checks };
}

function readChecksConfig(config: Record<string, unknown>): OpcoreRepoConfig["checks"] {
  if (config.checks === undefined) return undefined;
  if (!isPlainObject(config.checks)) {
    throw new Error(`Invalid Opcore config ${configPath}: checks must be an object`);
  }
  if (config.checks.packs === undefined) return {};
  if (!Array.isArray(config.checks.packs)) {
    throw new Error(`Invalid Opcore config ${configPath}: checks.packs must be an array`);
  }
  return { packs: config.checks.packs.map(readPackSpecifier) };
}

function readPackSpecifier(value: unknown, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid Opcore config ${configPath}: checks.packs[${index}] must be a non-empty string`);
  }
  return value;
}

function loadRepoCheckPack(
  repoRoot: string,
  requireFromRepo: ReturnType<typeof createRequire>,
  specifier: string
): OpcoreCheckPack {
  const resolvedSpecifier = resolvePackSpecifier(repoRoot, specifier);
  let loaded: unknown;
  try {
    loaded = requireFromRepo(resolvedSpecifier);
  } catch (error) {
    throw new Error(`Failed to load Opcore check pack ${specifier}: ${errorMessage(error)}`);
  }
  const pack = normalizeCheckPackExport(loaded);
  createValidationCheckRegistry(pack.checks);
  return pack;
}

function resolvePackSpecifier(repoRoot: string, specifier: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("..")) return resolve(repoRoot, specifier);
  if (isAbsolute(specifier)) return specifier;
  return specifier;
}

function normalizeCheckPackExport(value: unknown): OpcoreCheckPack {
  const candidate = isPlainObject(value) && "default" in value ? value.default : value;
  if (!isPlainObject(candidate)) throw new Error("check pack export must be an object");
  const id = candidate.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("check pack id must be a non-empty string");
  }
  const version = candidate.version;
  if (version !== undefined && typeof version !== "string") {
    throw new Error(`check pack ${id} version must be a string`);
  }
  const checks = candidate.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error(`check pack ${id} checks must be a non-empty array`);
  }
  return version === undefined ? { id, checks } : { id, version, checks };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
