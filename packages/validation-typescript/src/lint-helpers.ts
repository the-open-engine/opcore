import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { parse, simpleTraverse, type TSESTree } from "@typescript-eslint/typescript-estree";
import type { TypeScriptMaterializedSourceFile } from "./source-files.js";

export interface ParsedLintSource {
  ast: TSESTree.Program;
  comments: readonly SourceComment[];
  parentByNode: WeakMap<TSESTree.Node, TSESTree.Node | undefined>;
  path: string;
  text: string;
}

export interface SourceComment {
  value: string;
  loc?: {
    start: { line: number };
    end: { line: number };
  };
  range?: readonly [number, number];
}

export type LintRuleCode =
  | "TS_LINT_NO_EMPTY_CATCH"
  | "TS_LINT_NO_DANGEROUS_SPAWN"
  | "TS_LINT_NO_DANGEROUS_FALLBACKS"
  | "TS_LINT_NO_HARDCODED_PORTS"
  | "TS_LINT_NO_RAW_NETWORK_WITHOUT_TIMEOUT"
  | "TS_LINT_NO_UNBOUNDED_PROMISE_ALL_MAP"
  | "TS_LINT_NO_UNSAFE_TYPE_ASSERTION"
  | "TS_LINT_NO_DYNAMIC_IMPORT_CONCAT"
  | "TS_LINT_REQUIRE_ERROR_CONTEXT"
  | "TS_LINT_NO_STATIC_OPTIONAL_IMPORT";

export const commentMarkers = {
  catchOk: /catch-ok\s*:/i,
  fallbackOk: /fallback-ok\s*:/i,
  portOk: /port-ok\s*:/i,
  unboundedOk: /unbounded-ok\s*:/i,
  assertOk: /assert-ok\s*:/i,
  errorOk: /error-ok\s*:/i
} as const;

export const defaultPorts: readonly number[] = [3000, 3001, 5173, 5432, 5433, 6379, 8080, 8443];
export const genericErrorPattern = /^(failed|invalid|not found|missing|error|unauthorized|forbidden)\b/i;
export const axiosMethodConfigIndex = new Map([
  ["get", 1],
  ["delete", 1],
  ["head", 1],
  ["options", 1],
  ["post", 2],
  ["put", 2],
  ["patch", 2],
  ["request", 0]
]);

export function parseLintSource(file: TypeScriptMaterializedSourceFile): ParsedLintSource | Error {
  try {
    const ast = parse(file.content, {
      comment: true,
      ecmaVersion: "latest",
      jsx: file.path.endsWith(".tsx") || file.path.endsWith(".jsx"),
      loc: true,
      range: true,
      sourceType: "module"
    }) as TSESTree.Program & { comments?: readonly SourceComment[] };
    const parentByNode = new WeakMap<TSESTree.Node, TSESTree.Node | undefined>();
    simpleTraverse(ast, {
      enter: (node, parent) => parentByNode.set(node, parent)
    });
    return {
      ast,
      comments: ast.comments ?? [],
      parentByNode,
      path: file.path,
      text: file.content
    };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function diagnostic(source: ParsedLintSource, code: LintRuleCode, message: string): ValidationDiagnostic {
  return {
    category: "lint",
    severity: "error",
    path: source.path,
    code,
    message
  };
}

export function isCallExpression(node: TSESTree.Node | undefined): node is TSESTree.CallExpression {
  return node?.type === "CallExpression";
}

export function isObjectExpression(node: TSESTree.Node | undefined): node is TSESTree.ObjectExpression {
  return node?.type === "ObjectExpression";
}

export function isFunctionLike(
  node: TSESTree.Node | undefined
): node is TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

export function isMemberNamed(node: TSESTree.Node, propertyName: string): node is TSESTree.MemberExpression {
  return node.type === "MemberExpression" && memberPropertyName(node) === propertyName;
}

export function memberPropertyName(node: TSESTree.Node): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  if (node.property.type === "Identifier") return node.property.name;
  if (node.property.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return undefined;
}

export function calleePropertyOrIdentifierName(node: TSESTree.Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  return memberPropertyName(node);
}

export function objectHasProperty(node: TSESTree.ObjectExpression, name: string): boolean {
  return node.properties.some((property) => property.type === "Property" && propertyKeyName(property) === name);
}

export function objectHasBooleanProperty(node: TSESTree.ObjectExpression, name: string, expected: boolean): boolean {
  return node.properties.some(
    (property) =>
      property.type === "Property" &&
      propertyKeyName(property) === name &&
      property.value.type === "Literal" &&
      property.value.value === expected
  );
}

export function propertyKeyName(property: TSESTree.Property): string | undefined {
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value;
  return undefined;
}

export function isNullishExpression(node: TSESTree.Node | null | undefined): boolean {
  if (node === null || node === undefined) return true;
  if (node.type === "Literal") return node.value === null;
  if (node.type === "Identifier") return node.name === "undefined";
  if (node.type === "UnaryExpression") return node.operator === "void";
  return false;
}

export function hardcodedPortPattern(): RegExp {
  return new RegExp(`:(?:${defaultPorts.join("|")})(?:\\b|/|$)`);
}

export function hasMarkerNear(
  source: ParsedLintSource,
  node: TSESTree.Node,
  pattern: RegExp,
  options: { includeInside?: boolean } = {}
): boolean {
  const parent = source.parentByNode.get(node);
  const nodes = [node, parent, parentOf(source, parent)].filter((candidate): candidate is TSESTree.Node => candidate !== undefined);
  return source.comments.some((comment) => pattern.test(comment.value) && nodes.some((candidate) => commentApplies(comment, candidate, options)));
}

export function textFor(source: ParsedLintSource, node: TSESTree.Node): string {
  if (node.range === undefined) return node.type;
  return source.text.slice(node.range[0], node.range[1]);
}

function parentOf(source: ParsedLintSource, node: TSESTree.Node | undefined): TSESTree.Node | undefined {
  return node === undefined ? undefined : source.parentByNode.get(node);
}

function commentApplies(comment: SourceComment, node: TSESTree.Node, options: { includeInside?: boolean }): boolean {
  const nodeLine = node.loc.start.line;
  if (comment.loc !== undefined) {
    if (comment.loc.end.line === nodeLine - 1 || comment.loc.start.line === nodeLine) return true;
  }
  if (options.includeInside === true && comment.range !== undefined && node.range !== undefined) {
    return comment.range[0] >= node.range[0] && comment.range[1] <= node.range[1];
  }
  return false;
}
