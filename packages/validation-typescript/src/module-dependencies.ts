import ts from "typescript";
import { scriptKindForPath } from "./script-kind.js";

export type TypeScriptImportKind = "runtime" | "type_only";

export interface TypeScriptModuleDependency {
  specifier: string;
  kind: TypeScriptImportKind;
}

export function moduleDependencies(path: string, content: string): readonly TypeScriptModuleDependency[] {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
  const collected = new Map<string, TypeScriptImportKind>();
  for (const reference of sourceFile.referencedFiles) {
    recordDependency(collected, { specifier: reference.fileName, kind: "type_only" });
  }
  const visit = (node: ts.Node): void => {
    const dependency = dependencyForNode(node);
    if (dependency !== undefined) recordDependency(collected, dependency);
    ts.forEachChild(node, visit);
  };
  sourceFile.forEachChild(visit);
  return [...collected.entries()]
    .map(([specifier, kind]) => ({ specifier, kind }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
}

function recordDependency(
  collected: Map<string, TypeScriptImportKind>,
  dependency: TypeScriptModuleDependency
): void {
  const existing = collected.get(dependency.specifier);
  if (existing === "runtime" || existing === dependency.kind) return;
  collected.set(dependency.specifier, dependency.kind);
}

function dependencyForNode(node: ts.Node): TypeScriptModuleDependency | undefined {
  if (ts.isImportDeclaration(node)) {
    return dependency(node.moduleSpecifier, importDeclarationKind(node));
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
    return dependency(node.moduleSpecifier, exportDeclarationKind(node));
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return dependency(node.moduleReference.expression, node.isTypeOnly ? "type_only" : "runtime");
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return dependency(node.argument.literal, "type_only");
  }
  return callDependency(node);
}

function importDeclarationKind(node: ts.ImportDeclaration): TypeScriptImportKind {
  const clause = node.importClause;
  if (clause?.isTypeOnly === true) return "type_only";
  if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined) return "runtime";
  if (!ts.isNamedImports(clause.namedBindings)) return "runtime";
  const elements = clause.namedBindings.elements;
  return elements.length > 0 && elements.every((element) => element.isTypeOnly) ? "type_only" : "runtime";
}

function exportDeclarationKind(node: ts.ExportDeclaration): TypeScriptImportKind {
  if (node.isTypeOnly) return "type_only";
  if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) return "runtime";
  const elements = node.exportClause.elements;
  return elements.length > 0 && elements.every((element) => element.isTypeOnly) ? "type_only" : "runtime";
}

function callDependency(node: ts.Node): TypeScriptModuleDependency | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const isLoader =
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require");
  return isLoader ? dependency(node.arguments[0], "runtime") : undefined;
}

function dependency(
  expression: ts.Expression | undefined,
  kind: TypeScriptImportKind
): TypeScriptModuleDependency | undefined {
  if (expression === undefined || !ts.isStringLiteralLike(expression)) return undefined;
  return { specifier: expression.text, kind };
}
