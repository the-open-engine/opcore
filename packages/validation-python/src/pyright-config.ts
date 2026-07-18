import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { ValidationFileView } from "@the-open-engine/opcore-validation";
import {
  isPyrightConfigPath,
  parsePyrightConfig,
  resolveConfiguredPath
} from "./pyright-config-values.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";

export interface PyrightConfigSemantics {
  configPaths: readonly string[];
  moduleSearchRoots: readonly string[];
  invalidConfigMessages: readonly string[];
}

interface ConfigDocument {
  path: string;
  value: Record<string, unknown>;
}

interface ConfigClosure {
  fileView: ValidationFileView;
  workspace?: PythonProjectWorkspace;
  visited: Set<string>;
  documents: ConfigDocument[];
  failures: string[];
}

interface RootCollection {
  configPath: string;
  value: Record<string, unknown>;
  roots: Set<string>;
  configuredRoots: Set<string>;
  failures: string[];
}

const pathArrayKeys = ["include", "exclude", "ignore", "extraPaths"] as const;
const pathScalarKeys = ["stubPath", "typeshedPath", "venvPath"] as const;

export async function resolvePyrightConfigSemantics(
  fileView: ValidationFileView,
  project: PythonProjectContext,
  selectedConfigPaths: readonly string[],
  workspace?: PythonProjectWorkspace
): Promise<PyrightConfigSemantics> {
  const selected = selectedConfigPaths.filter(isPyrightConfigPath);
  if (selected.length !== 1) {
    return {
      configPaths: uniqueSorted(selectedConfigPaths),
      moduleSearchRoots: uniqueSorted([...project.sourceRoots, project.projectRoot]),
      invalidConfigMessages: [selected.length === 0
        ? `Pyright authority for ${project.projectRoot} requires pyrightconfig.json or [tool.pyright] in pyproject.toml`
        : `Pyright authority for ${project.projectRoot} resolved multiple project configurations`]
    };
  }

  const documents: ConfigDocument[] = [];
  const failures: string[] = [];
  await readConfigClosure({ fileView, workspace, visited: new Set(), documents, failures }, selected[0], []);
  const roots = new Set<string>([...project.sourceRoots, project.projectRoot]);
  const configuredRoots = new Set<string>();
  for (const document of documents) collectSearchRoots(document, roots, configuredRoots, failures);
  if (workspace !== undefined) {
    await validateConfiguredRoots(workspace, project.projectRoot, configuredRoots, failures);
  }
  return {
    configPaths: uniqueSorted(documents.map((document) => document.path)),
    moduleSearchRoots: uniqueSorted([...roots]),
    invalidConfigMessages: uniqueSorted(failures)
  };
}

async function readConfigClosure(
  closure: ConfigClosure,
  path: string,
  stack: readonly string[]
): Promise<void> {
  if (stack.includes(path)) {
    closure.failures.push(`${path}: Pyright extends cycle: ${[...stack, path].join(" -> ")}`);
    return;
  }
  if (closure.visited.has(path)) return;
  closure.visited.add(path);
  const parsed = await readConfigDocument(closure, path);
  if (parsed === undefined) return;
  closure.documents.push({ path, value: parsed });
  const extendedPath = resolveExtendedConfigPath(path, parsed, closure.failures);
  if (extendedPath === undefined) return;
  await readConfigClosure(closure, extendedPath, [...stack, path]);
}

async function readConfigDocument(
  closure: ConfigClosure,
  path: string
): Promise<Record<string, unknown> | undefined> {
  const state = await closure.fileView.readAfter(path);
  if (state.status !== "found") {
    closure.failures.push(`${path}: Pyright configuration is missing from the exact after-state`);
    return undefined;
  }
  if (closure.workspace !== undefined && !await validateConfigRealpath(closure.workspace, path, closure.failures)) {
    return undefined;
  }
  const parsed = parsePyrightConfig(path, state.content);
  if (typeof parsed === "string") {
    closure.failures.push(`${path}: ${parsed}`);
    return undefined;
  }
  return parsed;
}

async function validateConfigRealpath(
  workspace: PythonProjectWorkspace,
  path: string,
  failures: string[]
): Promise<boolean> {
  const resolved = await workspace.realpath(path);
  if (resolved.unavailable) failures.push(`${path}: Pyright configuration realpath evidence is unavailable`);
  else if (resolved.symlink || resolved.path !== path) {
    failures.push(`${path}: Symlinked or escaping Pyright configuration is refused`);
  }
  return !resolved.unavailable && !resolved.symlink && resolved.path === path;
}

function resolveExtendedConfigPath(
  path: string,
  parsed: Record<string, unknown>,
  failures: string[]
): string | undefined {
  const extend = parsed.extends;
  if (extend === undefined) return;
  if (typeof extend !== "string" || extend.trim().length === 0) {
    failures.push(`${path}: Pyright extends must be a non-empty repo-relative path`);
    return;
  }
  const resolved = resolveConfiguredPath(path, extend, "extends");
  if (typeof resolved === "string") {
    failures.push(`${path}: ${resolved}`);
    return;
  }
  return resolved.path;
}

function collectSearchRoots(
  document: ConfigDocument,
  roots: Set<string>,
  configuredRoots: Set<string>,
  failures: string[]
): void {
  const collection = { configPath: document.path, value: document.value, roots, configuredRoots, failures };
  collectPathArrayRoots(collection);
  collectPathScalarRoots(collection);
  validateVenvName(collection);
  collectExecutionEnvironmentRoots(collection);
}

function collectPathArrayRoots(collection: RootCollection): void {
  for (const key of pathArrayKeys) {
    const value = collection.value[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      collection.failures.push(`${collection.configPath}: Pyright ${key} must be an array`);
      continue;
    }
    for (const path of value) {
      if (key === "extraPaths") addSearchRoot(collection, key, path);
      else validateConfiguredPattern(collection, key, path);
    }
  }
}

function collectPathScalarRoots(collection: RootCollection): void {
  for (const key of pathScalarKeys) {
    const value = collection.value[key];
    if (value !== undefined) addSearchRoot(collection, key, value);
  }
}

function validateVenvName(collection: RootCollection): void {
  const venv = collection.value.venv;
  if (venv !== undefined && (typeof venv !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u.test(venv))) {
    collection.failures.push(`${collection.configPath}: Pyright venv must be a safe environment name`);
  }
}

function collectExecutionEnvironmentRoots(collection: RootCollection): void {
  const environments = collection.value.executionEnvironments;
  if (environments === undefined) return;
  if (!Array.isArray(environments)) {
    collection.failures.push(`${collection.configPath}: Pyright executionEnvironments must be an array`);
    return;
  }
  for (const [index, value] of environments.entries()) {
    if (!isObjectTable(value)) {
      collection.failures.push(`${collection.configPath}: Pyright executionEnvironments[${index}] must be an object`);
      continue;
    }
    addSearchRoot(collection, `executionEnvironments[${index}].root`, value.root);
    if (value.extraPaths !== undefined) {
      if (!Array.isArray(value.extraPaths)) {
        collection.failures.push(`${collection.configPath}: Pyright executionEnvironments[${index}].extraPaths must be an array`);
      } else {
        for (const path of value.extraPaths) {
          addSearchRoot(collection, `executionEnvironments[${index}].extraPaths`, path);
        }
      }
    }
  }
}

function addSearchRoot(collection: RootCollection, key: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    collection.failures.push(`${collection.configPath}: Pyright ${key} must contain non-empty paths`);
    return;
  }
  const resolved = resolveConfiguredPath(collection.configPath, value, key);
  if (typeof resolved === "string") {
    collection.failures.push(`${collection.configPath}: ${resolved}`);
    return;
  }
  collection.roots.add(resolved.path);
  collection.configuredRoots.add(resolved.path);
}

function validateConfiguredPattern(collection: RootCollection, key: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    collection.failures.push(`${collection.configPath}: Pyright ${key} must contain non-empty paths`);
    return;
  }
  const resolved = resolveConfiguredPath(collection.configPath, value, key);
  if (typeof resolved === "string") collection.failures.push(`${collection.configPath}: ${resolved}`);
}

async function validateConfiguredRoots(
  workspace: PythonProjectWorkspace,
  projectRoot: string,
  configuredRoots: ReadonlySet<string>,
  failures: string[]
): Promise<void> {
  for (const path of [...configuredRoots].sort()) {
    // The canonical project root is already confined by project discovery.
    // Host workspace APIs expose file identities, not directory realpath entries.
    if (path === projectRoot) continue;
    const resolved = await workspace.realpath(path);
    // Configured roots are recreated from individually validated source files in
    // the isolated workspace. ASP hosts need not expose directory identities.
    if (!resolved.unavailable && (resolved.symlink || resolved.path !== path)) {
      failures.push(`${path}: Symlinked or escaping Pyright configured path is refused`);
    }
  }
}

function isObjectTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
