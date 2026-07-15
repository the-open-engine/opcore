import type {
  PythonProjectBuildSystem,
  PythonProjectContextReason,
  PythonProjectManagerEvidence,
  PythonProjectTarget
} from "@the-open-engine/opcore-contracts";
import { parse as parseToml } from "smol-toml";
import type { PythonProjectWorkspace } from "./project-workspace.js";
import { pythonVersionSatisfiesConstraint } from "./version-constraint.js";

export const pythonBoundaryFileNames = [
  "pyproject.toml", "Pipfile", "Pipfile.lock", "poetry.lock", "pdm.lock", "uv.lock", "setup.cfg", "setup.py"
] as const;

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

export async function readPythonStaticProjectConfig(
  workspace: PythonProjectWorkspace,
  projectRoot: string,
  visibleFiles: readonly string[]
): Promise<PythonStaticProjectConfig> {
  const direct = directChildren(projectRoot, visibleFiles);
  const relevant = direct.filter(isRelevantPythonConfig);
  const contents = new Map<string, string>();
  const tomlDocuments = new Map<string, TomlTable>();
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
        const parsed = parseToml(value);
        if (isTable(parsed)) tomlDocuments.set(path, parsed);
      } catch {
        reasons.push({ code: "invalid_config", path, message: `Python project config is malformed: ${path}` });
      }
    }
    if (path.endsWith(".ini") || path.endsWith(".cfg")) {
      try {
        validateIni(value);
      } catch {
        reasons.push({ code: "invalid_config", path, message: `Python project config is malformed: ${path}` });
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
  const toolConfigs = {
    mypy: selectConfig(projectRoot, direct, tomlDocuments, "mypy", pythonToolConfigPrecedence.mypy),
    pyright: selectConfig(projectRoot, direct, tomlDocuments, "pyright", pythonToolConfigPrecedence.pyright),
    ruff: selectConfig(projectRoot, direct, tomlDocuments, "ruff", pythonToolConfigPrecedence.ruff),
    pytest: selectConfig(projectRoot, direct, tomlDocuments, "pytest", pythonToolConfigPrecedence.pytest)
  };
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
      valueForNonTomlConfig(path, content, "requires-python");
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

function selectConfig(
  projectRoot: string,
  direct: readonly string[],
  tomlDocuments: ReadonlyMap<string, TomlTable>,
  tool: "mypy" | "pyright" | "ruff" | "pytest",
  candidates: readonly string[]
): string | undefined {
  const names = new Set(direct.map(basename));
  const section = {
    mypy: "tool.mypy",
    pyright: "tool.pyright",
    ruff: "tool.ruff",
    pytest: "tool.pytest.ini_options"
  }[tool];
  const name = candidates.find((candidate) => {
    if (!names.has(candidate)) return false;
    if (candidate !== "pyproject.toml") return true;
    return tableAt(tomlDocuments.get(joinRoot(projectRoot, candidate)), section.split(".")) !== undefined;
  });
  return name === undefined ? undefined : joinRoot(projectRoot, name);
}

function isRelevantPythonConfig(path: string): boolean {
  const name = basename(path);
  return pythonBoundaryFileNames.includes(name as (typeof pythonBoundaryFileNames)[number]) ||
    /^requirements.*\.txt$/u.test(name) ||
    ["pyrightconfig.json", "ruff.toml", ".ruff.toml", "mypy.ini", ".mypy.ini", "pytest.ini", "tox.ini"].includes(name);
}

function isTomlConfig(path: string): boolean {
  return path.endsWith(".toml") || ["Pipfile", "poetry.lock", "pdm.lock", "uv.lock"].includes(basename(path));
}

function validateIni(content: string): void {
  const sections = new Set<string>();
  const options = new Set<string>();
  let section: string | undefined;
  let continuationAllowed = false;
  for (const [index, rawLine] of content.replace(/^\uFEFF/u, "").split(/\r?\n/u).entries()) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (/^\s/u.test(rawLine)) {
      if (!continuationAllowed) throw new Error(`Unexpected INI continuation at line ${index + 1}`);
      continue;
    }
    const sectionMatch = /^\[([^\[\]]+)\](?:\s*[#;].*)?$/u.exec(trimmed);
    if (sectionMatch !== null) {
      section = sectionMatch[1].trim().toLowerCase();
      if (section.length === 0 || sections.has(section)) throw new Error(`Invalid INI section at line ${index + 1}`);
      sections.add(section);
      continuationAllowed = false;
      continue;
    }
    if (section === undefined) throw new Error(`INI option precedes a section at line ${index + 1}`);
    const delimiterIndex = firstIniDelimiter(rawLine);
    if (delimiterIndex <= 0 || rawLine.slice(0, delimiterIndex).trim().length === 0) {
      throw new Error(`Invalid INI option at line ${index + 1}`);
    }
    const option = `${section}\0${rawLine.slice(0, delimiterIndex).trim().toLowerCase()}`;
    if (options.has(option)) throw new Error(`Duplicate INI option at line ${index + 1}`);
    options.add(option);
    continuationAllowed = true;
  }
  if (sections.size === 0) throw new Error("INI config has no sections");
}

function firstIniDelimiter(line: string): number {
  const equals = line.indexOf("=");
  const colon = line.indexOf(":");
  if (equals < 0) return colon;
  if (colon < 0) return equals;
  return Math.min(equals, colon);
}

function directChildren(root: string, files: readonly string[]): readonly string[] {
  const prefix = root === "." ? "" : `${root}/`;
  return files.filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
}

function valueForKey(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*["']?${escaped}["']?\\s*(?:=|:)\\s*["']([^"']+)["']`, "mu").exec(content);
  return match?.[1]?.trim();
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
  return valueForKey(content, key);
}

type TomlTable = Record<string, unknown>;

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
