import { normalizeValidationFileViewPath } from "@the-open-engine/opcore-validation";
import { posix } from "node:path";
import { parsePythonIni } from "./ini-config.js";

export interface MypyConfigValues {
  plugins: readonly string[];
  mypyPaths: readonly string[];
  invalidMypyPaths: readonly string[];
  settings: ReadonlyMap<string, unknown>;
}

export type PythonTomlParser = (content: string) => Record<string, unknown>;

const outputBearingMypyOptions = new Set([
  "cache_dir",
  "cache_map",
  "junit_xml",
  "line_checking_stats",
  "mypyc_annotation_file",
  "timing_stats"
]);

const hostInputMypyOptions = new Set([
  "custom_typing_module",
  "custom_typeshed_dir",
  "python_executable",
  "quickstart_file",
  "shadow_file"
]);

const isolatedMypyPathOptions = new Set(["files", "package_root"]);
const exactStateMypyPathOptions = new Set(["mypy_path", "plugins"]);
const nonPathMypyOptionsWithPathSuffix = new Set(["show_absolute_path"]);

export function readMypyConfigValues(
  configPath: string,
  content: string,
  parseToml: PythonTomlParser
): MypyConfigValues {
  if (configPath.endsWith("pyproject.toml")) return tomlMypyValues(content, parseToml);
  try {
    const document = parsePythonIni(content);
    const settings = document.sections.get("mypy") ?? new Map<string, string>();
    return {
      plugins: splitCommaLines(settings.get("plugins")),
      ...parseMypyPaths(settings.get("mypy_path")),
      settings
    };
  } catch {
    return emptyMypyConfigValues();
  }
}

export function mypyConfigSafetyFailures(
  configPath: string,
  content: string,
  projectRoot: string,
  parseToml: PythonTomlParser
): readonly string[] {
  const values = readMypyConfigValues(configPath, content, parseToml);
  return uniqueSorted([
    ...values.invalidMypyPaths,
    ...mypyConfigIsolationFailures(configPath, projectRoot, values, false)
  ]);
}

export function mypyConfigIsolationFailures(
  configPath: string,
  projectRoot: string,
  config: MypyConfigValues,
  includePluginResolution = true
): readonly string[] {
  const failures: string[] = [];
  for (const [option, value] of config.settings) {
    if (outputBearingMypyOptions.has(option) || option.endsWith("_report")) {
      failures.push(`${option} is output-bearing and cannot run in read-only validation`);
      continue;
    }
    if (hostInputMypyOptions.has(option)) {
      failures.push(`${option} can read or execute host paths outside the exact after-state`);
      continue;
    }
    if (option === "install_types" && configuredBoolean(value)) {
      failures.push("install_types can mutate the selected Python environment");
      continue;
    }
    if (isolatedMypyPathOptions.has(option)) {
      for (const path of stringValues(value)) {
        const failure = isolatedConfigPathFailure(option, path, projectRoot);
        if (failure !== undefined) failures.push(failure);
      }
      continue;
    }
    if (!exactStateMypyPathOptions.has(option) &&
        !nonPathMypyOptionsWithPathSuffix.has(option) &&
        looksPathBearingMypyOption(option)) {
      failures.push(`${option} is an unsupported path-bearing option in exact after-state validation`);
    }
  }
  if (!includePluginResolution) {
    for (const plugin of config.plugins) {
      const value = pluginImportValue(plugin);
      if (!value.endsWith(".py")) continue;
      const failure = isolatedConfigPathFailure("plugins", value, posix.dirname(configPath));
      if (failure !== undefined) failures.push(failure);
    }
  }
  return uniqueSorted(failures);
}

export function mypyPathValidationFailures(value: unknown): readonly string[] {
  return parseMypyPaths(value).invalidMypyPaths;
}

export function isolatedConfigPathFailure(option: string, value: string, root: string): string | undefined {
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value)) {
    return `${option} path is absolute and cannot be isolated`;
  }
  if (value.startsWith("~")) return `${option} path uses unsupported home expansion`;
  if (value.includes("$") || /%[^%]+%/u.test(value)) {
    return `${option} path uses unsupported environment expansion`;
  }
  try {
    normalizeMypySearchRoot(posix.join(root, value.replaceAll("\\", "/")));
  } catch {
    return `${option} path escapes the repository`;
  }
  return undefined;
}

export function pluginImportValue(configured: string): string {
  const value = configured.trim();
  const colon = value.lastIndexOf(":");
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const driveColon = colon === 1 && /^[A-Za-z]:[\\/]/u.test(value);
  return colon > separator && !driveColon ? value.slice(0, colon).trim() : value;
}

export function normalizeMypySearchRoot(path: string): string {
  const normalized = posix.normalize(path);
  if (normalized === ".") return ".";
  return normalizeValidationFileViewPath(normalized.replace(/^\.\//u, ""));
}

function tomlMypyValues(content: string, parseToml: PythonTomlParser): MypyConfigValues {
  try {
    const document = parseToml(content) as { tool?: { mypy?: Record<string, unknown> } };
    const mypy = document.tool?.mypy ?? {};
    const settings = new Map(Object.entries(mypy).filter(([key]) => key !== "overrides"));
    return {
      plugins: stringValues(mypy.plugins),
      ...parseMypyPaths(mypy.mypy_path),
      settings
    };
  } catch {
    return emptyMypyConfigValues();
  }
}

function emptyMypyConfigValues(): MypyConfigValues {
  return { plugins: [], mypyPaths: [], invalidMypyPaths: [], settings: new Map() };
}

function configuredBoolean(value: unknown): boolean {
  return value === true || typeof value === "string" && value.trim().toLowerCase() === "true";
}

function looksPathBearingMypyOption(option: string): boolean {
  return ["_dir", "_executable", "_file", "_path", "_root"].some((suffix) => option.endsWith(suffix));
}

function stringValues(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string").flatMap(splitCommaLines);
  if (typeof value !== "string") return [];
  return splitCommaLines(value);
}

function splitCommaLines(value: string | undefined): readonly string[] {
  return value?.split(/[,\r\n]+/u).map(cleanConfigValue).filter(Boolean) ?? [];
}

function parseMypyPaths(value: unknown): Pick<MypyConfigValues, "mypyPaths" | "invalidMypyPaths"> {
  if (value === undefined) return { mypyPaths: [], invalidMypyPaths: [] };
  const values = Array.isArray(value) ? value : [value];
  const invalidMypyPaths: string[] = [];
  const mypyPaths: string[] = [];
  for (const candidate of values) {
    if (typeof candidate !== "string") {
      invalidMypyPaths.push("mypy_path must contain only strings");
      continue;
    }
    for (const entry of splitMypyPathString(candidate)) {
      const failure = invalidMypyPath(entry);
      if (failure === undefined) mypyPaths.push(entry);
      else invalidMypyPaths.push(failure);
    }
  }
  return { mypyPaths: uniqueSorted(mypyPaths), invalidMypyPaths: uniqueSorted(invalidMypyPaths) };
}

function splitMypyPathString(value: string): readonly string[] {
  const entries: string[] = [];
  for (const line of value.split(/[,\r\n]+/u)) {
    let start = 0;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== ":") continue;
      const driveColon = index === start + 1 && /[A-Za-z]/u.test(line[start] ?? "") && /[\\/]/u.test(line[index + 1] ?? "");
      if (driveColon) continue;
      entries.push(line.slice(start, index));
      start = index + 1;
    }
    entries.push(line.slice(start));
  }
  return entries.map(cleanConfigValue).filter(Boolean);
}

function invalidMypyPath(value: string): string | undefined {
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value)) {
    return "mypy_path entry is absolute and cannot be isolated";
  }
  if (value.startsWith("~")) return "mypy_path entry uses unsupported home expansion";
  const expanded = value
    .replaceAll("${MYPY_CONFIG_FILE_DIR}", ".")
    .replaceAll("$MYPY_CONFIG_FILE_DIR", ".");
  if (expanded.includes("$") || /%[^%]+%/u.test(expanded)) {
    return "mypy_path entry uses unsupported environment expansion";
  }
  try {
    normalizeMypySearchRoot(expanded);
  } catch {
    return "mypy_path entry escapes the repository";
  }
  return undefined;
}

function cleanConfigValue(value: string): string {
  return value.replace(/\s[#;].*$/u, "").trim();
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
