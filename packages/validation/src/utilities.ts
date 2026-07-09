import type { GraphFactEdge, GraphFactNode, JsonValue } from "@the-open-engine/opcore-contracts";

export interface RepoPathGlobOptions {
  matchDescendants?: boolean;
  optionalGlobstarSlash?: boolean;
}

export interface JoinRepoRelativePathsOptions {
  emptyPath?: "" | ".";
}

export type GraphFactExportMetadata = { [key: string]: JsonValue };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function countPhysicalLines(content: string): number {
  if (content.length === 0) return 0;
  const withoutFinalNewline = normalizeLineEndings(content).replace(/\n$/u, "");
  if (withoutFinalNewline.length === 0) return 0;
  return withoutFinalNewline.split("\n").length;
}

export function splitPhysicalLines(content: string): readonly string[] {
  return normalizeLineEndings(content).split("\n");
}

export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function uniqueSortedStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function graphFactStringAttribute(node: GraphFactNode, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = node.attributes?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function graphFactSymbolAliases(node: GraphFactNode): readonly string[] {
  const aliases = [node.id];
  const stableId = graphFactStringAttribute(node, ["symbolId", "stableId", "qualifiedName"]);
  if (stableId !== undefined) aliases.push(stableId);
  return uniqueSortedStrings(aliases);
}

export function graphFactSymbolAliasSet(node: GraphFactNode): ReadonlySet<string> {
  return new Set(graphFactSymbolAliases(node));
}

export function graphFactBooleanAttribute(node: GraphFactNode, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = node.attributes?.[key];
    if (value === true || value === "true") return true;
  }
  return false;
}

export function graphFactHasIncomingTargetEdge(
  node: GraphFactNode,
  edges: readonly GraphFactEdge[],
  incomingTargets?: ReadonlySet<string>
): boolean {
  if (incomingTargets?.has(node.id) === true) return true;
  const aliases = graphFactSymbolAliasSet(node);
  return edges.some((edge) => aliases.has(edge.to));
}

export function graphFactNodePath(node: GraphFactNode): string | undefined {
  return node.path ?? graphFactStringAttribute(node, ["path", "file", "filePath", "sourcePath"]) ?? graphFactPathFromEndpoint(node.id);
}

export function graphFactPathFromEndpoint(endpoint: string): string | undefined {
  const fileMatch = /^file:(.+)$/u.exec(endpoint);
  if (fileMatch !== null) return fileMatch[1];
  const qualifiedMatch = /^[^:]+:([^#]+)(?:#.*)?$/u.exec(endpoint);
  return qualifiedMatch?.[1];
}

export function graphFactHasExportMetadata(node: GraphFactNode): boolean {
  return typeof node.attributes?.exported === "boolean";
}

export function graphFactUnsupportedFileExportMetadata(node: GraphFactNode): readonly GraphFactExportMetadata[] {
  const exports = node.attributes?.exports;
  if (!Array.isArray(exports)) return [];
  return exports.filter(isUnsupportedFileExportMetadata);
}

export function graphFactUnsupportedExportLabels(exports: readonly GraphFactExportMetadata[], limit = 5): string {
  return exports
    .map((entry) => stringMetadata(entry, "exported") ?? stringMetadata(entry, "local") ?? stringMetadata(entry, "kind") ?? "unknown")
    .slice(0, limit)
    .join(", ");
}

function isUnsupportedFileExportMetadata(value: JsonValue): value is GraphFactExportMetadata {
  return isJsonObject(value) && value.supportedSymbol === false;
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMetadata(metadata: GraphFactExportMetadata, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function joinRepoRelativePaths(
  paths: readonly string[],
  options: JoinRepoRelativePathsOptions = {}
): string | undefined {
  const joined: string[] = [];
  for (const path of paths) {
    if (path.startsWith("/")) return undefined;
    for (const part of path.split("/")) {
      if (part.length === 0 || part === ".") continue;
      if (part === "..") {
        if (joined.length === 0) return undefined;
        joined.pop();
      } else {
        joined.push(part);
      }
    }
  }
  return joined.length === 0 ? (options.emptyPath ?? ".") : joined.join("/");
}

export function normalizeRepoRelativePath(path: string, options: JoinRepoRelativePathsOptions = {}): string | undefined {
  if (path.length === 0 || path.includes("\0")) return undefined;
  return joinRepoRelativePaths([path.replaceAll("\\", "/")], options);
}

export function repoPathHasGlobSyntax(pattern: string, characterClasses = false): boolean {
  return pattern.includes("*") || pattern.includes("?") || (characterClasses && pattern.includes("["));
}

export function repoPathGlobToRegex(pattern: string, options: RepoPathGlobOptions = {}): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const token = repoPathGlobToken(pattern, index, options);
    source += token.source;
    index += token.consumed - 1;
  }
  const suffix = options.matchDescendants === true ? "(?:/.*)?$" : "$";
  return new RegExp(`${source}${suffix}`);
}

function repoPathGlobToken(pattern: string, index: number, options: RepoPathGlobOptions): { source: string; consumed: number } {
  const char = pattern[index];
  const next = pattern[index + 1];
  const afterNext = pattern[index + 2];
  if (char === "*" && next === "*" && afterNext === "/" && options.optionalGlobstarSlash === true) {
    return { source: "(?:.*/)?", consumed: 3 };
  }
  if (char === "*" && next === "*") return { source: ".*", consumed: 2 };
  if (char === "*") return { source: "[^/]*", consumed: 1 };
  if (char === "?") return { source: "[^/]", consumed: 1 };
  return { source: escapeRegex(char ?? ""), consumed: 1 };
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
