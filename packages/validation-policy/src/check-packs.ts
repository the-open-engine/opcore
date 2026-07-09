import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { createValidationCheckRegistry, errorMessage, isPlainObject } from "@the-open-engine/opcore-validation";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { readOpcoreRepoConfig } from "./config.js";
import { configPath, type OpcoreCheckPack, type OpcoreRepoConfig } from "./types.js";

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

export function loadRepoCheckPacks(
  repoRoot: string,
  config: OpcoreRepoConfig = readOpcoreRepoConfig(resolve(repoRoot))
): readonly OpcoreCheckPack[] {
  const canonicalRepoRoot = resolve(repoRoot);
  const packSpecifiers = config.validation.checks.packs;
  if (packSpecifiers.length === 0) return [];
  const requireFromRepo = createRequire(join(canonicalRepoRoot, "package.json"));
  return packSpecifiers.map((specifier) => loadRepoCheckPack(canonicalRepoRoot, requireFromRepo, specifier));
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
  const id = readCheckPackId(candidate.id);
  const version = readCheckPackVersion(candidate.version, id);
  const checks = readCheckPackChecks(candidate.checks, id);
  return version === undefined ? { id, checks } : { id, version, checks };
}

function readCheckPackId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("check pack id must be a non-empty string");
  return value;
}

function readCheckPackVersion(value: unknown, id: string): string | undefined {
  if (value !== undefined && typeof value !== "string") throw new Error(`check pack ${id} version must be a string`);
  return value;
}

function readCheckPackChecks(value: unknown, id: string): readonly ValidationCheckDefinition[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`check pack ${id} checks must be a non-empty array`);
  return value;
}
