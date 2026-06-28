import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import ts from "typescript";
import { TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID } from "./check-ids.js";
import {
  defaultTypeScriptFunctionMetricThresholds,
  typeScriptCheckAdapter,
  typeScriptCheckOwner,
  supportedTypeScriptValidationScopes
} from "./check-constants.js";
import { materializeTypeScriptSources } from "./source-files.js";

export interface TypeScriptFunctionMetricThresholds {
  maxFunctionLines: number;
  maxComplexity: number;
  maxParams: number;
}

interface TypeScriptFunctionMetric {
  name: string;
  path: string;
  lines: number;
  complexity: number;
  params: number;
}

type FunctionMetricNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

const branchSyntaxKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression
]);

const branchOperatorKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken
]);

export function createFunctionMetricsCheck(
  options: {
    thresholds?: TypeScriptFunctionMetricThresholds;
  } = {}
): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: false,
    run: async (context) => {
      const thresholds = options.thresholds ?? defaultTypeScriptFunctionMetricThresholds;
      const sourceSet = await materializeTypeScriptSources(context);
      const diagnostics: ValidationDiagnostic[] = [];
      for (const path of sourceSet.rootPaths) {
        const source = sourceSet.sourceFileByPath.get(path);
        if (source === undefined) continue;
        const sourceFile = ts.createSourceFile(path, source.content, ts.ScriptTarget.Latest, true, scriptKind(path));
        for (const metric of collectFunctionMetrics(sourceFile, path)) {
          diagnostics.push(...metricDiagnostics(metric, thresholds));
        }
      }
      return { diagnostics: sortDiagnostics(diagnostics) };
    }
  };
}

function collectFunctionMetrics(sourceFile: ts.SourceFile, path: string): readonly TypeScriptFunctionMetric[] {
  const metrics: TypeScriptFunctionMetric[] = [];

  function visit(node: ts.Node): void {
    if (isFunctionMetricNode(node) && hasFunctionBody(node)) {
      metrics.push(functionMetric(sourceFile, path, node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return metrics;
}

function functionMetric(sourceFile: ts.SourceFile, path: string, node: FunctionMetricNode): TypeScriptFunctionMetric {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const startLine = sourceFile.getLineAndCharacterOfPosition(start).line;
  const endLine = sourceFile.getLineAndCharacterOfPosition(end).line;
  return {
    name: functionName(node, sourceFile),
    path,
    lines: endLine - startLine + 1,
    complexity: cyclomaticComplexity(node),
    params: node.parameters.length
  };
}

function metricDiagnostics(
  metric: TypeScriptFunctionMetric,
  thresholds: TypeScriptFunctionMetricThresholds
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  if (metric.complexity > thresholds.maxComplexity) {
    diagnostics.push({
      category: "policy",
      severity: "warning",
      path: metric.path,
      code: "TS_FUNCTION_COMPLEXITY",
      message: `TypeScript function ${metric.name} has cyclomatic complexity ${metric.complexity}; max is ${thresholds.maxComplexity}.`
    });
  }
  if (metric.lines > thresholds.maxFunctionLines) {
    diagnostics.push({
      category: "policy",
      severity: "warning",
      path: metric.path,
      code: "TS_FUNCTION_LINES",
      message: `TypeScript function ${metric.name} has ${metric.lines} lines; max is ${thresholds.maxFunctionLines}.`
    });
  }
  if (metric.params > thresholds.maxParams) {
    diagnostics.push({
      category: "policy",
      severity: "warning",
      path: metric.path,
      code: "TS_FUNCTION_PARAMS",
      message: `TypeScript function ${metric.name} has ${metric.params} parameters; max is ${thresholds.maxParams}.`
    });
  }
  return diagnostics;
}

function cyclomaticComplexity(node: FunctionMetricNode): number {
  let complexity = 1;
  const body = node.body;
  if (body === undefined) return complexity;

  function visit(current: ts.Node): void {
    if (current !== body && isFunctionMetricNode(current)) return;
    if (isBranchNode(current)) complexity += 1;
    ts.forEachChild(current, visit);
  }

  visit(body);
  return complexity;
}

function isBranchNode(node: ts.Node): boolean {
  if (branchSyntaxKinds.has(node.kind)) return true;
  return ts.isBinaryExpression(node) && branchOperatorKinds.has(node.operatorToken.kind);
}

function isFunctionMetricNode(node: ts.Node): node is FunctionMetricNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function hasFunctionBody(node: FunctionMetricNode): boolean {
  return node.body !== undefined;
}

function functionName(node: FunctionMetricNode, sourceFile: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if ("name" in node && node.name !== undefined) return node.name.getText(sourceFile);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return bindingName(parent.name, sourceFile);
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText(sourceFile);
  if (ts.isBinaryExpression(parent)) return parent.left.getText(sourceFile);
  return "<anonymous>";
}

function bindingName(name: ts.BindingName, sourceFile: ts.SourceFile): string {
  return ts.isIdentifier(name) ? name.text : name.getText(sourceFile);
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    [
      (left.path ?? "").localeCompare(right.path ?? ""),
      (left.code ?? "").localeCompare(right.code ?? ""),
      left.message.localeCompare(right.message)
    ].find((comparison) => comparison !== 0) ?? 0
  );
}
