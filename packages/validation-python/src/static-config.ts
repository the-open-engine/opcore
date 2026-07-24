import type {
  PythonProjectBuildSystem,
  PythonProjectContextReason,
  PythonProjectManagerEvidence,
  PythonProjectTarget
} from "@the-open-engine/opcore-contracts";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { isRelevantPythonConfig } from "./project-config-files.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";
import { parsePyrightConfig, resolveConfiguredPath } from "./pyright-config-values.js";
import { pythonVersionSatisfiesConstraint } from "./version-constraint.js";
import { parsePythonIni, pythonIniHasSection, pythonIniValue, type PythonIniDocument } from "./ini-config.js";
import { mypyConfigSafetyFailures, mypyPathValidationFailures } from "./mypy-config-values.js";
import {
  parsePythonToml,
  tomlStringArrayAt,
  tomlStringAt,
  tomlTableAt,
  tomlValueAt,
  type TomlTable
} from "./toml-config.js";

export const pythonToolConfigPrecedence = {
  pyright: ["pyrightconfig.json", "pyproject.toml"],
  ruff: [".ruff.toml", "ruff.toml", "pyproject.toml"],
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
  selectedRuffConfig?: string;
  scopedRuffSelection: boolean;
}

export interface ReadPythonStaticProjectConfigOptions {
  target?: string;
  toolKinds?: readonly ("mypy" | "pyright" | "ruff" | "pytest")[];
}

export async function readPythonStaticProjectConfig(
  workspace: PythonProjectWorkspace,
  projectRoot: string,
  visibleFiles: readonly string[],
  options: ReadPythonStaticProjectConfigOptions = {}
): Promise<PythonStaticProjectConfig> {
  const direct = directChildren(projectRoot, visibleFiles);
  const selectedRuffConfig = options.target === undefined || options.toolKinds !== undefined && !options.toolKinds.includes("ruff")
    ? undefined
    : await selectClosestTargetRuffConfig(workspace, options.target, visibleFiles);
  const relevant = [...new Set([
    ...direct.filter((path) =>
      isRelevantPythonConfig(path) &&
      (!isDedicatedRuffConfig(path) || path === selectedRuffConfig)
    ),
    ...(selectedRuffConfig === undefined ? [] : [selectedRuffConfig])
  ])].sort();
  const contents = new Map<string, string>();
  const jsonDocuments = new Map<string, TomlTable>();
  const tomlDocuments = new Map<string, TomlTable>();
  const iniDocuments = new Map<string, PythonIniDocument>();
  const reasons: PythonProjectContextReason[] = [];
  for (const path of relevant) {
    const resolved = await workspace.realpath(path);
    if (resolved.unavailable) {
      reasons.push({
        code: "ambiguous_path",
        path,
        ...configReasonTool(path),
        message: `Python config realpath evidence is unavailable: ${path}`
      });
      continue;
    }
    if (resolved.symlink || resolved.path !== path) {
      reasons.push({
        code: "symlink_refused",
        path,
        ...configReasonTool(path),
        message: `Symlinked Python config path is ambiguous: ${path}`
      });
      continue;
    }
    const value = await workspace.read(path);
    if (value === undefined) continue;
    contents.set(path, value);
    if (path.endsWith(".json") || basename(path) === "Pipfile.lock") {
      try {
        const errors: ParseError[] = [];
        const parsed = basename(path) === "pyrightconfig.json"
          ? parseJsonc(value, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
          : JSON.parse(value) as unknown;
        if (errors.length > 0) throw new Error("JSONC parse failure");
        if (!isTable(parsed)) throw new Error("JSON config root must be an object");
        jsonDocuments.set(path, parsed);
      } catch {
        reasons.push({
          code: "invalid_config",
          path,
          ...configReasonTool(path),
          message: `Python project config is malformed: ${path}`
        });
      }
    }
    if (isTomlConfig(path)) {
      try {
        tomlDocuments.set(path, parsePythonToml(value));
      } catch {
        reasons.push({
          code: "invalid_config",
          path,
          ...configReasonTool(path),
          message: `Python project config is malformed: ${path}`
        });
        for (const tool of declaredPyprojectTools(path, value)) {
          if (tool === "ruff" && path !== selectedRuffConfig) continue;
          reasons.push({
            code: "invalid_config",
            path,
            tool,
            message: `Python project config is malformed: ${path}`
          });
        }
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
            ...configReasonTool(path),
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
  const toolConfigs = selectToolConfigs({
    projectRoot,
    direct,
    contents,
    tomlDocuments,
    iniDocuments,
    ...(selectedRuffConfig === undefined ? {} : { selectedRuffConfig }),
    scopedRuffSelection: options.target !== undefined
  }, reasons);
  const pyrightTarget = toolConfigs.pyright === undefined
    ? undefined
    : await readSelectedPyrightTarget(workspace, toolConfigs.pyright, contents, reasons);
  const target = targetEvidence(projectRoot, contents, tomlDocuments, pyrightTarget, toolConfigs.pyright, reasons);
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
  if (names.has("uv.lock") || tomlTableAt(pyprojectDocument, ["tool", "uv"]) !== undefined) {
    managers.push({ kind: "uv", configFiles: tomlTableAt(pyprojectDocument, ["tool", "uv"]) === undefined ? [] : [pyprojectPath], lockFiles: names.has("uv.lock") ? [joinRoot(projectRoot, "uv.lock")] : [] });
  }
  if (names.has("poetry.lock") || tomlTableAt(pyprojectDocument, ["tool", "poetry"]) !== undefined) {
    managers.push({ kind: "poetry", configFiles: tomlTableAt(pyprojectDocument, ["tool", "poetry"]) === undefined ? [] : [pyprojectPath], lockFiles: names.has("poetry.lock") ? [joinRoot(projectRoot, "poetry.lock")] : [] });
  }
  if (names.has("pdm.lock") || tomlTableAt(pyprojectDocument, ["tool", "pdm"]) !== undefined) {
    managers.push({ kind: "pdm", configFiles: tomlTableAt(pyprojectDocument, ["tool", "pdm"]) === undefined ? [] : [pyprojectPath], lockFiles: names.has("pdm.lock") ? [joinRoot(projectRoot, "pdm.lock")] : [] });
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
  pyrightTarget: TomlTable | undefined,
  selectedPyrightConfig: string | undefined,
  reasons: PythonProjectContextReason[]
): PythonProjectTarget {
  const declarations: { source: string; kind: "requires" | "version" | "platform" | "implementation"; value: string }[] = [];
  for (const [path, content] of contents) {
    const document = tomlDocuments.get(path);
    const requires = tomlStringAt(document, ["project", "requires-python"]) ??
      tomlStringAt(document, ["tool", "poetry", "dependencies", "python"]) ??
      valueForNonTomlConfig(path, content, "requires-python") ??
      valueForNonTomlConfig(path, content, "python_requires");
    if (requires !== undefined) declarations.push({ source: path, kind: "requires", value: requires });
    const version = tomlStringAt(document, ["requires", "python_version"]) ??
      valueForNonTomlConfig(path, content, "python_version");
    if (version !== undefined) declarations.push({ source: path, kind: "version", value: version });
    const platform = valueForNonTomlConfig(path, content, "platform");
    if (platform !== undefined) declarations.push({ source: path, kind: "platform", value: platform });
  }
  for (const [kind, key] of [
    ["version", "pythonVersion"],
    ["platform", "pythonPlatform"],
    ["implementation", "pythonImplementation"]
  ] as const) {
    const value = tomlStringAt(pyrightTarget, [key]);
    if (value !== undefined && selectedPyrightConfig !== undefined) {
      declarations.push({ source: selectedPyrightConfig, kind, value });
    }
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

async function readSelectedPyrightTarget(
  workspace: PythonProjectWorkspace,
  selectedConfig: string,
  contents: Map<string, string>,
  reasons: PythonProjectContextReason[]
): Promise<TomlTable | undefined> {
  const documents: { path: string; value: TomlTable }[] = [];
  await readSelectedPyrightConfigClosure(workspace, selectedConfig, contents, documents, reasons, new Set(), []);
  if (documents.length === 0) return undefined;
  const inherited: TomlTable = {};
  for (const document of [...documents].reverse()) {
    for (const key of ["pythonVersion", "pythonPlatform", "pythonImplementation"] as const) {
      const value = document.value[key];
      if (typeof value === "string" && value.trim().length > 0) inherited[key] = value.trim();
    }
  }
  return Object.keys(inherited).length === 0 ? undefined : inherited;
}

async function readSelectedPyrightConfigClosure(
  workspace: PythonProjectWorkspace,
  path: string,
  contents: Map<string, string>,
  documents: { path: string; value: TomlTable }[],
  reasons: PythonProjectContextReason[],
  visited: Set<string>,
  stack: readonly string[]
): Promise<void> {
  if (stack.includes(path)) {
    reasons.push({
      code: "invalid_config",
      path,
      tool: "pyright",
      message: `Invalid Pyright configuration: ${path} has an extends cycle: ${[...stack, path].join(" -> ")}`
    });
    return;
  }
  if (visited.has(path)) return;
  visited.add(path);
  const resolved = await workspace.realpath(path);
  if (resolved.unavailable) {
    reasons.push({ code: "ambiguous_path", path, message: `Python config realpath evidence is unavailable: ${path}` });
    return;
  }
  if (resolved.symlink || resolved.path !== path) {
    reasons.push({ code: "symlink_refused", path, message: `Symlinked Python config path is ambiguous: ${path}` });
    return;
  }
  const content = contents.get(path) ?? await workspace.read(path);
  if (content === undefined) {
    reasons.push({
      code: "invalid_config",
      path,
      tool: "pyright",
      message: `Invalid Pyright configuration: ${path} is missing from the selected project`
    });
    return;
  }
  contents.set(path, content);
  const parsed = parsePyrightConfig(path, content);
  if (typeof parsed === "string") {
    reasons.push({ code: "invalid_config", path, tool: "pyright", message: `Invalid Pyright configuration: ${parsed}` });
    return;
  }
  documents.push({ path, value: parsed });
  if (typeof parsed.extends !== "string" || parsed.extends.trim().length === 0) {
    if (parsed.extends !== undefined) {
      reasons.push({
        code: "invalid_config",
        path,
        tool: "pyright",
        message: "Invalid Pyright configuration: Pyright extends must be a non-empty repo-relative path"
      });
    }
    return;
  }
  const extended = resolveConfiguredPath(path, parsed.extends, "extends");
  if (typeof extended === "string") {
    reasons.push({ code: "invalid_config", path, tool: "pyright", message: `Invalid Pyright configuration: ${extended}` });
    return;
  }
  await readSelectedPyrightConfigClosure(
    workspace,
    extended.path,
    contents,
    documents,
    reasons,
    visited,
    [...stack, path]
  );
}

function parseBuildSystem(path: string, document: TomlTable | undefined): PythonStaticProjectConfig["buildSystem"] {
  const section = tomlTableAt(document, ["build-system"]);
  if (section === undefined) return undefined;
  const backend = tomlStringAt(section, ["build-backend"]);
  const requires = tomlStringArrayAt(section, ["requires"]).sort();
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
    ? tomlValueAt(input.tomlDocuments.get(path), ["tool", "mypy", "mypy_path"])
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
    ? tomlValueAt(input.tomlDocuments.get(path), ["tool", "mypy", "python_version"])
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
  if (tool === "ruff" && input.scopedRuffSelection) {
    return input.selectedRuffConfig === undefined ? [] : [input.selectedRuffConfig];
  }
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
      const document = input.tomlDocuments.get(path);
      return document === undefined
        ? declaresTomlTable(input.contents.get(path), section)
        : tomlTableAt(document, section.split(".")) !== undefined;
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

function configReasonTool(path: string): Pick<PythonProjectContextReason, "tool"> | Record<never, never> {
  const name = basename(path);
  if (name === "ruff.toml" || name === ".ruff.toml") return { tool: "ruff" };
  if (name === "pyrightconfig.json") return { tool: "pyright" };
  if (name === "mypy.ini" || name === ".mypy.ini") return { tool: "mypy" };
  if (name === "pytest.ini") return { tool: "pytest" };
  return {};
}

function declaredPyprojectTools(
  path: string,
  content: string
): readonly ("mypy" | "pyright" | "ruff" | "pytest")[] {
  if (basename(path) !== "pyproject.toml") return [];
  return ([
    ["mypy", "tool.mypy"],
    ["pyright", "tool.pyright"],
    ["ruff", "tool.ruff"],
    ["pytest", "tool.pytest.ini_options"]
  ] as const)
    .filter(([, section]) => declaresTomlTable(content, section))
    .map(([tool]) => tool);
}

function declaresTomlTable(content: string | undefined, section: string): boolean {
  if (content === undefined) return false;
  const expected = section.split(".");
  let currentTable: readonly string[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;
    const table = parseTomlTableHeader(line);
    if (table !== undefined) {
      currentTable = table;
      if (startsWithTomlPath(currentTable, expected)) return true;
      continue;
    }
    const assignment = splitTomlAssignment(line);
    if (assignment === undefined) continue;
    const key = parseTomlDottedKey(assignment.key);
    if (key === undefined) continue;
    const path = [...currentTable, ...key];
    if (startsWithTomlPath(path, expected)) return true;
    if (
      expected.length === 2 &&
      path.length === 1 &&
      path[0] === expected[0] &&
      inlineTomlTableDeclaresKey(assignment.value, expected[1])
    ) {
      return true;
    }
  }
  return false;
}

async function selectClosestTargetRuffConfig(
  workspace: PythonProjectWorkspace,
  target: string,
  visibleFiles: readonly string[]
): Promise<string | undefined> {
  const visible = new Set(visibleFiles);
  for (const directory of ancestorDirectories(dirname(target))) {
    for (const name of pythonToolConfigPrecedence.ruff) {
      const path = joinRoot(directory, name);
      if (!visible.has(path)) continue;
      if (name !== "pyproject.toml") return path;
      const resolved = await workspace.realpath(path);
      if (resolved.unavailable || resolved.symlink || resolved.path !== path) continue;
      const content = await workspace.read(path);
      if (content === undefined) continue;
      try {
        if (tomlTableAt(parsePythonToml(content), ["tool", "ruff"]) !== undefined) return path;
      } catch {
        if (declaresTomlTable(content, "tool.ruff")) return path;
      }
    }
  }
  return undefined;
}

function ancestorDirectories(start: string): readonly string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (current === ".") break;
    current = dirname(current);
  }
  return directories;
}

function isDedicatedRuffConfig(path: string): boolean {
  const name = basename(path);
  return name === "ruff.toml" || name === ".ruff.toml";
}

function stripTomlComment(line: string): string {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

function parseTomlTableHeader(line: string): readonly string[] | undefined {
  if (!line.startsWith("[") || line.startsWith("[[")) return undefined;
  const closing = findTomlToken(line, "]", 1);
  if (closing < 0 || line.slice(closing + 1).trim().length > 0) return undefined;
  return parseTomlDottedKey(line.slice(1, closing));
}

function splitTomlAssignment(line: string): { key: string; value: string } | undefined {
  const equals = findTomlToken(line, "=", 0);
  if (equals < 0) return undefined;
  return { key: line.slice(0, equals), value: line.slice(equals + 1).trim() };
}

function findTomlToken(value: string, token: string, start: number): number {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === token) return index;
  }
  return -1;
}

function parseTomlDottedKey(value: string): readonly string[] | undefined {
  const segments: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) return undefined;
    const quote = value[index] === "\"" || value[index] === "'" ? value[index] : undefined;
    let segment = "";
    if (quote !== undefined) {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const character = value[index];
        if (character === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (quote === "\"" && character === "\\" && index + 1 < value.length) {
          segment += value[index + 1];
          index += 2;
          continue;
        }
        segment += character;
        index += 1;
      }
      if (!closed) return undefined;
    } else {
      const start = index;
      while (index < value.length && /[A-Za-z0-9_-]/u.test(value[index])) index += 1;
      segment = value.slice(start, index);
    }
    if (segment.length === 0) return undefined;
    segments.push(segment);
    while (/\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) return segments;
    if (value[index] !== ".") return undefined;
    index += 1;
  }
  return undefined;
}

function inlineTomlTableDeclaresKey(value: string, expected: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return false;
  let index = 1;
  while (index < trimmed.length) {
    while (/[\s,]/u.test(trimmed[index] ?? "")) index += 1;
    if (trimmed[index] === "}" || index >= trimmed.length) return false;
    const equals = findTomlToken(trimmed, "=", index);
    if (equals < 0) return false;
    const key = parseTomlDottedKey(trimmed.slice(index, equals).trim());
    if (key?.length === 1 && key[0] === expected) return true;
    index = skipTomlValue(trimmed, equals + 1);
  }
  return false;
}

function skipTomlValue(value: string, start: number): number {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "\"") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth -= 1;
    else if (character === "{") curlyDepth += 1;
    else if (character === "}") {
      if (curlyDepth === 0 && squareDepth === 0) return index;
      curlyDepth -= 1;
    } else if (character === "," && squareDepth === 0 && curlyDepth === 0) return index + 1;
  }
  return value.length;
}

function startsWithTomlPath(path: readonly string[], expected: readonly string[]): boolean {
  return expected.every((segment, index) => path[index] === segment);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index) || ".";
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

function isTable(value: unknown): value is TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function joinRoot(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
