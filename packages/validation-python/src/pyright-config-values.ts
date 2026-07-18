import { parse, parseTree, type ParseError } from "jsonc-parser";
import { posix } from "node:path";
import { parsePythonToml, tomlTableAt } from "./toml-config.js";
import { duplicateJsonObjectKey } from "./strict-json.js";

export function isPyrightConfigPath(path: string): boolean {
  return path.endsWith("pyrightconfig.json") || path.endsWith("pyproject.toml");
}

export function parsePyrightConfig(path: string, content: string): Record<string, unknown> | string {
  if (path.endsWith("pyproject.toml")) {
    try {
      const document = parsePythonToml(content);
      const section = tomlTableAt(document, ["tool", "pyright"]);
      return section ?? "pyproject.toml has no [tool.pyright] table";
    } catch {
      return "Pyright TOML configuration is malformed";
    }
  }
  try {
    const errors: ParseError[] = [];
    const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
    if (errors.length > 0 || !isObjectTable(value)) return "Pyright JSONC configuration is malformed";
    const treeErrors: ParseError[] = [];
    const tree = parseTree(content, treeErrors, { allowTrailingComma: true, disallowComments: false });
    if (tree === undefined || treeErrors.length > 0) return "Pyright JSONC configuration is malformed";
    const duplicate = duplicateJsonObjectKey(tree);
    return duplicate === undefined ? value : `Pyright JSONC configuration has duplicate key ${duplicate}`;
  } catch {
    return "Pyright JSONC configuration is malformed or excessively nested";
  }
}

export function resolveConfiguredPath(
  configPath: string,
  configured: string,
  key: string
): { path: string } | string {
  const value = configured.trim().replaceAll("\\", "/");
  if (value.length === 0 || value.includes("\0")) return `Pyright ${key} has an invalid path`;
  if (isAbsolutePath(value)) return `Pyright ${key} must not use an absolute path`;
  if (/[$%{}]/u.test(value) || value.includes("://")) return `Pyright ${key} must not use host environment or URI expansion`;
  if (hasUnsafePathSegment(value)) return `Pyright ${key} must not use parent traversal`;
  const base = posix.dirname(configPath);
  const normalized = posix.normalize(posix.join(base, value));
  if (normalized === "." && key === "extends") {
    return "Pyright extends must name a repo-relative configuration file";
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    return `Pyright ${key} escapes the repository`;
  }
  return { path: normalized };
}

function isObjectTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value) || value.startsWith("//") || value.startsWith("~");
}

function hasUnsafePathSegment(value: string): boolean {
  return value.split("/").includes("..");
}
