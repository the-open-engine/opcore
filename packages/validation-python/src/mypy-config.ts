import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { ValidationFileView } from "@the-open-engine/opcore-validation";
import { posix } from "node:path";
import {
  isolatedConfigPathFailure,
  mypyConfigIsolationFailures,
  normalizeMypySearchRoot,
  pluginImportValue,
  readMypyConfigValues,
  type MypyConfigValues
} from "./mypy-config-values.js";
import { parsePythonToml } from "./toml-config.js";

export interface MypyConfigSemantics {
  pluginPaths: readonly string[];
  moduleSearchRoots: readonly string[];
  invalidConfigMessages: readonly string[];
}

export async function resolveMypyConfigSemantics(
  fileView: ValidationFileView,
  project: PythonProjectContext,
  configPaths: readonly string[]
): Promise<MypyConfigSemantics> {
  const values: { configPath: string; values: MypyConfigValues }[] = [];
  for (const configPath of configPaths) {
    const state = await fileView.readAfter(configPath);
    if (state.status === "found") {
      values.push({ configPath, values: readMypyConfigValues(configPath, state.content, parsePythonToml) });
    }
  }
  const configuredRoots = values.flatMap(({ configPath, values: config }) =>
    config.mypyPaths.flatMap((value) => resolveMypyPath(value, configPath, project.projectRoot))
  );
  const invalidConfigMessages = values.flatMap(({ configPath, values: config }) =>
    [
      ...config.invalidMypyPaths,
      ...mypyConfigIsolationFailures(configPath, project.projectRoot, config)
    ].map((message) => `${configPath}: ${message}`)
  );
  const moduleSearchRoots = uniqueSorted([...project.sourceRoots, project.projectRoot, ...configuredRoots]);
  const visible = new Set(await fileView.listVisibleFiles());
  const pluginPaths: string[] = [];
  for (const { configPath, values: config } of values) {
    for (const plugin of config.plugins) {
      const resolved = resolvePluginModule(plugin, configPath, moduleSearchRoots, visible);
      if (resolved.failure === undefined) pluginPaths.push(...resolved.paths);
      else invalidConfigMessages.push(`${configPath}: ${resolved.failure}`);
    }
  }
  return {
    pluginPaths: uniqueSorted(pluginPaths),
    moduleSearchRoots,
    invalidConfigMessages: uniqueSorted(invalidConfigMessages)
  };
}

function resolveMypyPath(value: string, configPath: string, projectRoot: string): readonly string[] {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) return [];
  const configRoot = posix.dirname(configPath);
  const expanded = value
    .replaceAll("${MYPY_CONFIG_FILE_DIR}", configRoot)
    .replaceAll("$MYPY_CONFIG_FILE_DIR", configRoot);
  const candidate = expanded !== value ? expanded : joinRoot(projectRoot, expanded);
  try {
    return [normalizeMypySearchRoot(candidate)];
  } catch {
    return [];
  }
}

function resolvePluginModule(
  configured: string,
  configPath: string,
  roots: readonly string[],
  visible: ReadonlySet<string>
): { paths: readonly string[]; failure?: string } {
  const value = pluginImportValue(configured);
  if (value.length === 0) return { paths: [], failure: "plugins contains an empty plugin reference" };
  if (value.endsWith(".py")) {
    const failure = isolatedConfigPathFailure("plugins", value, posix.dirname(configPath));
    if (failure !== undefined) return { paths: [], failure };
    const path = normalizeMypySearchRoot(posix.join(posix.dirname(configPath), value.replaceAll("\\", "/")));
    return visible.has(path)
      ? { paths: [path] }
      : { paths: [], failure: "plugins path is absent from the exact after-state" };
  }
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(value)) {
    return { paths: [], failure: "plugins entry is not an isolated module or .py path" };
  }
  const modulePath = value.replaceAll(".", "/");
  const candidates = roots.flatMap((root) => [joinRoot(root, `${modulePath}.py`), joinRoot(root, `${modulePath}/__init__.py`)]);
  const paths = uniqueSorted(candidates.filter((path) => visible.has(path)));
  if (paths.length === 0) return { paths: [], failure: "plugins module is absent from the exact after-state" };
  if (paths.length > 1) return { paths: [], failure: "plugins module resolves ambiguously in the exact after-state" };
  return { paths };
}

function joinRoot(root: string, path: string): string {
  return normalizeMypySearchRoot(root === "." ? path : posix.join(root, path));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
