import { parse as parseToml } from "smol-toml";

export type TomlTable = Record<string, unknown>;

export function parsePythonToml(content: string): TomlTable {
  const parsed = parseToml(content);
  if (!isTomlTable(parsed)) throw new Error("TOML config root must be a table");
  return parsed;
}

export function tomlValueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isTomlTable(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function tomlTableAt(value: unknown, path: readonly string[]): TomlTable | undefined {
  const selected = tomlValueAt(value, path);
  return isTomlTable(selected) ? selected : undefined;
}

export function tomlStringAt(value: unknown, path: readonly string[]): string | undefined {
  const selected = tomlValueAt(value, path);
  return typeof selected === "string" && selected.trim().length > 0 ? selected.trim() : undefined;
}

export function tomlStringArrayAt(value: unknown, path: readonly string[]): string[] {
  const selected = tomlValueAt(value, path);
  if (!Array.isArray(selected)) return [];
  return selected.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function isTomlTable(value: unknown): value is TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
