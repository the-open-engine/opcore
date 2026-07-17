import type {
  PythonProjectBuildSystem,
  PythonProjectContextReason,
  PythonProjectManagerEvidence,
  PythonProjectTarget
} from "@the-open-engine/opcore-contracts";
import { parse as parseToml } from "smol-toml";
import { isRelevantPythonConfig } from "./project-config-files.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";
import { pythonVersionSatisfiesConstraint } from "./version-constraint.js";
import { parsePythonIni, pythonIniHasSection, pythonIniValue, type PythonIniDocument } from "./ini-config.js";
import { mypyConfigSafetyFailures, mypyPathValidationFailures } from "./mypy-config-values.js";

export const pythonToolConfigPrecedence = {
  pyright: ["pyrightconfig.json", "pyproject.toml"],
  ruff: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
  mypy: ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg", "tox.ini"],
  pytest: ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"]
} as const;

export interface PythonStaticProjectConfig {
  contents: ReadonlyMap<string, string>;
  managers: readonly PythonProjectManagerEvidence[];
  target: PythonProjectTarget;
  toolConfigs: Readonly<Record<"mypy" | "pyright" | "ruff" | "pytest", string | undefined>>;
  buildSystem?: PythonProjectBuildSystem;
  reasons: readonly PythonProjectContextReason[];
}

interface PythonToolConfigInputs {
  projectRoot: string;
  direct: readonly string[];
  contents: ReadonlyMap<string, string>;
  tomlDocuments: ReadonlyMap<string, TomlTable>;
  iniDocuments: ReadonlyMap<string, PythonIniDocument>;
}

export async function readPythonStaticProjectConfig(
  workspace: PythonProjectWorkspace,
  projectRoot: string,
  visibleFiles: readonly string[]
): Promise<PythonStaticProjectConfig> {
  const direct = directChildren(projectRoot, visibleFiles);
  const relevant = direct.filter(isRelevantPythonConfig);
  const contents = new Map<string, string>();
  const tomlDocuments = new Map<string, TomlTable>();
  const iniDocuments = new Map<string, PythonIniDocument>();
  const reasons: PythonProjectContextReason[] = [];
  for (const path of relevant) {
    const resolved = await workspace.realpath(path);
    if (resolved.unavailable) {
      reasons.push({ code: "ambiguous_path", path, message: `Python config realpath evidence is unavailable: ${path}` });
      continue;
    }
    if (resolved.symlink || resolved.path !== path) {
      reasons.push({ code: "symlink_refused", path, message: `Symlinked Python config path is ambiguous: ${path}` });
      continue;
    }
    const value = await workspace.read(path);
    if (value === undefined) continue;
    contents.set(path, value);
    if (path.endsWith(".json") || basename(path) === "Pipfile.lock") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (!isTable(parsed)) throw new Error("JSON config root must be an object");
      } catch {
        reasons.push({ code: "invalid_config", path, message: `Python project config is malformed: ${path}` });
      }
    }
    if (isTomlConfig(path)) {
      try {
        tomlDocuments.set(path, parsePythonToml(value));
      } catch {
        reasons.push({ code: "invalid_config", path, message: `Python project config is malformed: ${path}` });
      }
    }
    if (path.endsWith(".ini") || path.endsWith(".cfg")) {
      try {
        iniDocuments.set(path, parsePythonIni(value));
      } catch {
        if (!isDedicatedMypyConfig(path)) {
          reasons.push({
            code: "invalid_config",
            path,
            message: `Python project config is malformed: ${path}`
          });
        }
      }
    }
  }

  const managers = managerEvidence(projectRoot, direct, tomlDocuments);
  if (managers.length > 1) {
    reasons.push({
      code: "conflicting_managers",
      message: `Conflicting Python dependency managers at ${projectRoot}: ${managers.map((entry) => entry.kind).join(", ")}`
    });
  }
  const target = targetEvidence(projectRoot, contents, tomlDocuments, reasons);
  const toolConfigs = selectToolConfigs({ projectRoot, direct, contents, tomlDocuments, iniDocuments }, reasons);
  const pyproject = joinRoot(projectRoot, "pyproject.toml");
  const buildSystem = parseBuildSystem(pyproject, tomlDocuments.get(pyproject));
  return { contents, managers, target, toolConfigs, ...(buildSystem === undefined ? {} : { buildSystem }), reasons };
}

function managerEvidence(
  projectRoot: string,
  direct: readonly string[],
  tomlDocuments: ReadonlyMap<string, TomlTable>
): readonly PythonProjectManagerEvidence[] {
  const names = new Set(direct.map(basename));
  const pyprojectPath = joinRoot(projectRoot, "pyproject.toml");
  const pyprojectDocument = tomlDocuments.get(pyprojectPath);
  const managers: PythonProjectManagerEvidence[] = [];
  const requirements = direct.filter((path) => /^requirements.*\.txt$/u.test(basename(path)));
  if (requirements.length > 0 || names.has("setup.py")) {
    managers.push({ kind: "pip", configFiles: requirements.length > 0 ? requirements : [joinRoot(projectRoot, "setup.py")], lockFiles: [] });
  }
  if (names.has("uv.lock") || tableAt(pyprojectDocument, ["tool", "uv"]) !== undefined) {
    managers.push({ kind: "uv", configFiles: tableAt(pyprojectDocument, ["tool", "uv"]) === undefined ? [] : [pyprojectPath], lockFiles: names.has("uv.lock") ? [joinRoot(projectRoot, "uv.lock")] : [] });
  }
  if (names.has("poetry.lock") || tableAt(pyprojectDocument, ["tool", "poetry"]) !== undefined) {
    managers.push({ kind: "poetry", configFiles: tableAt(pyprojectDocument, ["tool", "poetry"]) === undefined ? [] : [pyprojectPath], lockFiles: names.has("poetry.lock") ? [joinRoot(projectRoot, "poetry.lock")] : [] });
  }
  if (names.has("pdm.lock") || tableAt(pyprojectDocument, ["tool", "pdm"]) !== undefined) {
    managers.push({ kind: "pdm", configFiles: tableAt(pyprojectDocument, ["tool", "pdm"]) === undefined ? [] : [pyprojectPath], lockFiles: names.has("pdm.lock") ? [joinRoot(projectRoot, "pdm.lock")] : [] });
  }
  if (names.has("Pipfile") || names.has("Pipfile.lock")) {
    managers.push({ kind: "pipenv", configFiles: names.has("Pipfile") ? [joinRoot(projectRoot, "Pipfile")] : [], lockFiles: names.has("Pipfile.lock") ? [joinRoot(projectRoot, "Pipfile.lock")] : [] });
  }
  return managers.sort((left, right) => left.kind.localeCompare(right.kind));
}

function targetEvidence(
  projectRoot: string,
  contents: ReadonlyMap<string, string>,
  tomlDocuments: ReadonlyMap<string, TomlTable>,
  reasons: PythonProjectContextReason[]
): PythonProjectTarget {
  const declarations: { source: string; kind: "requires" | "version" | "platform" | "implementation"; value: string }[] = [];
  for (const [path, content] of contents) {
    const document = tomlDocuments.get(path);
    const requires = stringAt(document, ["project", "requires-python"]) ??
      stringAt(document, ["tool", "poetry", "dependencies", "python"]) ??
      valueForNonTomlConfig(path, content, "requires-python") ??
      valueForNonTomlConfig(path, content, "python_requires");
    if (requires !== undefined) declarations.push({ source: path, kind: "requires", value: requires });
    const version = stringAt(document, ["tool", "pyright", "pythonVersion"]) ??
      stringAt(document, ["requires", "python_version"]) ??
      valueForNonTomlConfig(path, content, "pythonVersion") ?? valueForNonTomlConfig(path, content, "python_version");
    if (version !== undefined) declarations.push({ source: path, kind: "version", value: version });
    const platform = stringAt(document, ["tool", "pyright", "pythonPlatform"]) ??
      valueForNonTomlConfig(path, content, "pythonPlatform") ?? valueForNonTomlConfig(path, content, "platform");
    if (platform !== undefined) declarations.push({ source: path, kind: "platform", value: platform });
    const implementation = stringAt(document, ["tool", "pyright", "pythonImplementation"]) ??
      valueForNonTomlConfig(path, content, "pythonImplementation");
    if (implementation !== undefined) declarations.push({ source: path, kind: "implementation", value: implementation });
  }
  const conflicts: string[] = [];
  for (const kind of ["requires", "version", "platform", "implementation"] as const) {
    const values = [...new Set(declarations.filter((entry) => entry.kind === kind).map((entry) => entry.value))];
    if (values.length > 1) conflicts.push(`${kind}:${values.join("|")}`);
  }
  if (conflicts.length > 0) {
    reasons.push({ code: "conflicting_targets", message: `Conflicting Python targets at ${projectRoot}: ${conflicts.join(", ")}` });
  }
  const requiresPython = declarations.find((entry) => entry.kind === "requires")?.value;
  const version = declarations.find((entry) => entry.kind === "version")?.value;
  const platform = declarations.find((entry) => entry.kind === "platform")?.value;
  const implementation = declarations.find((entry) => entry.kind === "implementation")?.value;
  if (requiresPython !== undefined && version !== undefined && !constraintAllowsVersion(requiresPython, version)) {
    const conflict = `requires-version:${requiresPython}|${version}`;
    conflicts.push(conflict);
    reasons.push({ code: "conflicting_targets", message: `Conflicting Python targets at ${projectRoot}: ${conflict}` });
  }
  return {
    ...(requiresPython === undefined ? {} : { requiresPython }),
    ...(version === undefined ? {} : { version }),
    ...(platform === undefined ? {} : { platform }),
    ...(implementation === undefined ? {} : { implementation }),
    conflicts
  };
}

function parseBuildSystem(path: string, document: TomlTable | undefined): PythonStaticProjectConfig["buildSystem"] {
  const section = tableAt(document, ["build-system"]);
  if (section === undefined) return undefined;
  const backend = stringAt(section, ["build-backend"]);
  const requires = stringArrayAt(section, ["requires"]).sort();
  return { configFile: path, ...(backend === undefined ? {} : { backend }), requires };
}

function selectToolConfigs(
  input: PythonToolConfigInputs,
  reasons: PythonProjectContextReason[]
): PythonStaticProjectConfig["toolConfigs"] {
  const tools = ["mypy", "pyright", "ruff", "pytest"] as const;
  const selected: Partial<Record<(typeof tools)[number], string>> = {};
  addMissingMypySectionFailures(input, reasons);
  addInvalidMypyPythonVersionFailures(input, reasons);
  addInvalidMypyPathFailures(input, reasons);
  addUnsafeMypyConfigFailures(input, reasons);
  for (const tool of tools) {
    const selectedPath = configuredToolPaths(input, tool)[0];
    if (selectedPath !== undefined) selected[tool] = selectedPath;
  }
  return selected as PythonStaticProjectConfig["toolConfigs"];
}

function addUnsafeMypyConfigFailures(
  input: PythonToolConfigInputs,
  reasons: PythonProjectContextReason[]
): void {
  const path = configuredToolPaths(input, "mypy")[0];
  const content = path === undefined ? undefined : input.contents.get(path);
  if (path === undefined || content === undefined) return;
  for (const message of mypyConfigSafetyFailures(path, content, input.projectRoot, parsePythonToml)) {
    if (message.startsWith("mypy_path ")) continue;
    reasons.push({ code: "invalid_config", path, tool: "mypy", message: `Invalid mypy configuration: ${message}` });
  }
}

function addInvalidMypyPathFailures(
  input: PythonToolConfigInputs,
  reasons: PythonProjectContextReason[]
): void {
  const path = configuredToolPaths(input, "mypy")[0];
  if (path === undefined) return;
  const value = path.endsWith("pyproject.toml")
    ? valueAt(input.tomlDocuments.get(path), ["tool", "mypy", "mypy_path"])
    : pythonIniValue(input.iniDocuments.get(path), "mypy", "mypy_path");
  for (const message of mypyPathValidationFailures(value)) {
    reasons.push({ code: "invalid_config", path, tool: "mypy", message: `Invalid mypy configuration: ${message}` });
  }
}

function addInvalidMypyPythonVersionFailures(
  input: PythonToolConfigInputs,
  reasons: PythonProjectContextReason[]
): void {
  const path = configuredToolPaths(input, "mypy")[0];
  if (path === undefined) return;
  const value = path.endsWith("pyproject.toml")
    ? valueAt(input.tomlDocuments.get(path), ["tool", "mypy", "python_version"])
    : pythonIniValue(input.iniDocuments.get(path), "mypy", "python_version");
  if (value === undefined || typeof value === "string" && /^\d+\.\d+$/u.test(value.trim())) return;
  reasons.push({
    code: "invalid_config",
    path,
    tool: "mypy",
    message: `Mypy configuration has an invalid python_version: ${path}`
  });
}

function addMissingMypySectionFailures(
  input: PythonToolConfigInputs,
  reasons: PythonProjectContextReason[]
): void {
  const path = configuredToolPaths(input, "mypy")[0];
  if (path === undefined || !isDedicatedMypyConfig(path)) return;
  const document = input.iniDocuments.get(path);
  if (document !== undefined && pythonIniHasSection(document, "mypy")) return;
  reasons.push({
    code: "invalid_config",
    path,
    tool: "mypy",
    message: document === undefined
      ? `Python project config is malformed: ${path}`
      : `Dedicated mypy config has no [mypy] section: ${path}`
  });
}

function configuredToolPaths(
  input: PythonToolConfigInputs,
  tool: "mypy" | "pyright" | "ruff" | "pytest",
): readonly string[] {
  const candidates = pythonToolConfigPrecedence[tool];
  const names = new Set(input.direct.map(basename));
  const section = {
    mypy: "tool.mypy",
    pyright: "tool.pyright",
    ruff: "tool.ruff",
    pytest: "tool.pytest.ini_options"
  }[tool];
  return candidates.filter((candidate) => {
    if (!names.has(candidate)) return false;
    const path = joinRoot(input.projectRoot, candidate);
    if (candidate === "pyproject.toml") {
      return tableAt(input.tomlDocuments.get(path), section.split(".")) !== undefined;
    }
    if (tool === "mypy") {
      return isDedicatedMypyConfig(path) || pythonIniHasSection(input.iniDocuments.get(path), "mypy");
    }
    if (tool === "pytest" && (candidate === "setup.cfg" || candidate === "tox.ini" || candidate === "pytest.ini")) {
      return pythonIniHasSection(input.iniDocuments.get(path), "pytest") || pythonIniHasSection(input.iniDocuments.get(path), "tool:pytest");
    }
    return true;
  }).map((name) => joinRoot(input.projectRoot, name));
}

function isDedicatedMypyConfig(path: string): boolean {
  const name = basename(path);
  return name === "mypy.ini" || name === ".mypy.ini";
}

function isTomlConfig(path: string): boolean {
  return path.endsWith(".toml") || ["Pipfile", "poetry.lock", "pdm.lock", "uv.lock"].includes(basename(path));
}

function directChildren(root: string, files: readonly string[]): readonly string[] {
  const prefix = root === "." ? "" : `${root}/`;
  return files.filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
}

function valueForKey(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^\\s*["']?${escaped}["']?\\s*(?:=|:)\\s*(?:"([^"]+)"|'([^']+)'|([^#;\\r\\n]+))`,
    "mu"
  ).exec(content);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
}

function constraintAllowsVersion(constraint: string, version: string): boolean {
  return pythonVersionSatisfiesConstraint(version, constraint);
}

function valueForNonTomlConfig(path: string, content: string, key: string): string | undefined {
  if (path.endsWith(".toml") || basename(path) === "Pipfile") return undefined;
  if (path.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content) as unknown;
      return isTable(parsed) && typeof parsed[key] === "string" ? parsed[key].trim() : undefined;
    } catch {
      return undefined;
    }
  }
  if (basename(path) === "setup.cfg" && key === "python_requires") {
    return valueForIniOption(content, "options", key);
  }
  return valueForKey(content, key);
}

function valueForIniOption(content: string, expectedSection: string, key: string): string | undefined {
  try {
    const value = pythonIniValue(parsePythonIni(content), expectedSection, key);
    if (value === undefined) return undefined;
    const match = /^(?:"([^"]*)"|'([^']*)'|([^#;]*))/u.exec(value);
    return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  } catch {
    return undefined;
  }
}

export type TomlTable = Record<string, unknown>;

export function parsePythonToml(content: string): TomlTable {
  const parsed = parseToml(content);
  if (!isTable(parsed)) throw new Error("TOML config root must be a table");
  return parsed;
}

function isTable(value: unknown): value is TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isTable(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function tableAt(value: unknown, path: readonly string[]): TomlTable | undefined {
  const selected = valueAt(value, path);
  return isTable(selected) ? selected : undefined;
}

function stringAt(value: unknown, path: readonly string[]): string | undefined {
  const selected = valueAt(value, path);
  return typeof selected === "string" && selected.trim().length > 0 ? selected.trim() : undefined;
}

function stringArrayAt(value: unknown, path: readonly string[]): string[] {
  const selected = valueAt(value, path);
  if (!Array.isArray(selected)) return [];
  return selected.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function joinRoot(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
