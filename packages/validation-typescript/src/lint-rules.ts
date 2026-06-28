import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { simpleTraverse, type TSESTree } from "@typescript-eslint/typescript-estree";
import {
  axiosMethodConfigIndex,
  commentMarkers,
  defaultPorts,
  diagnostic,
  genericErrorPattern,
  hardcodedPortPattern,
  hasMarkerNear,
  isCallExpression,
  isFunctionLike,
  isMemberNamed,
  isNullishExpression,
  isObjectExpression,
  memberPropertyName,
  objectHasBooleanProperty,
  objectHasProperty,
  propertyKeyName,
  textFor,
  type ParsedLintSource
} from "./lint-helpers.js";

const lintDiagnosticMessages = {
  noEmptyCatch: "Empty .catch() handler swallows errors. Handle, propagate, or document the intentional swallow.",
  noDangerousSpawn: "Shell execution through exec() or shell:true is unsafe for generic command execution. Use argument arrays.",
  noDangerousFallbacks: "Fallback on environment/config data can hide missing runtime configuration. Validate explicitly instead.",
  noHardcodedPorts: "Hardcoded runtime port can drift from configuration. Use config or document the exception.",
  noRawNetworkWithoutTimeout: "Outbound fetch/axios call is missing an explicit timeout or cancellation signal.",
  noUnboundedPromiseAllMap: "Promise.all(...map(async ...)) runs unbounded concurrency. Use bounded concurrency or batching.",
  noUnsafeTypeAssertion: "'as unknown as' bypasses TypeScript checking. Fix the type boundary or document the exception.",
  noDynamicImportConcat: "Dynamic import() must use a static string literal so bundlers and runtimes can resolve it predictably.",
  requireErrorContext: "Thrown Error message lacks runtime context. Include identifiers/state or document the exception.",
  noStaticOptionalImport: "Optional dependency is statically imported. Use dynamic import() so absence does not break startup."
} as const;

const childProcessModuleSpecifiers = new Set(["child_process", "node:child_process"]);
const dangerousExecFunctionNames = new Set(["exec", "execSync", "execAsync"]);
const dangerousSpawnFunctionNames = new Set(["spawn", "spawnSync"]);

interface ChildProcessBindings {
  readonly execFunctionNames: ReadonlySet<string>;
  readonly namespaceNames: ReadonlySet<string>;
  readonly spawnFunctionNames: ReadonlySet<string>;
}

export function collectTypeScriptLintDiagnostics(
  source: ParsedLintSource,
  optionalDependencies: ReadonlySet<string>
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const childProcessBindings = collectChildProcessBindings(source.ast);
  simpleTraverse(source.ast, {
    enter: (node) => {
      collectNoEmptyCatch(source, node, diagnostics);
      collectNoDangerousSpawn(source, node, childProcessBindings, diagnostics);
      collectNoDangerousFallbacks(source, node, diagnostics);
      collectNoHardcodedPorts(source, node, diagnostics);
      collectNoRawNetworkWithoutTimeout(source, node, diagnostics);
      collectNoUnboundedPromiseAllMap(source, node, diagnostics);
      collectNoUnsafeTypeAssertion(source, node, diagnostics);
      collectNoDynamicImportConcat(source, node, diagnostics);
      collectRequireErrorContext(source, node, diagnostics);
      collectNoStaticOptionalImport(source, node, optionalDependencies, diagnostics);
    }
  });
  return diagnostics;
}

function collectNoEmptyCatch(source: ParsedLintSource, node: TSESTree.Node, diagnostics: ValidationDiagnostic[]): void {
  if (!isCallExpression(node) || !isMemberNamed(node.callee, "catch")) return;
  const handler = node.arguments[0];
  if (!isFunctionLike(handler) || !isEmptyCatchHandler(handler)) return;
  if (hasMarkerNear(source, node, commentMarkers.catchOk, { includeInside: true })) return;
  if (hasMarkerNear(source, handler, commentMarkers.catchOk, { includeInside: true })) return;
  diagnostics.push(diagnostic(source, "TS_LINT_NO_EMPTY_CATCH", lintDiagnosticMessages.noEmptyCatch));
}

function collectNoDangerousSpawn(
  source: ParsedLintSource,
  node: TSESTree.Node,
  childProcessBindings: ChildProcessBindings,
  diagnostics: ValidationDiagnostic[]
): void {
  if (!isCallExpression(node)) return;
  if (hasDangerousShellOption(node, childProcessBindings)) {
    diagnostics.push(diagnostic(source, "TS_LINT_NO_DANGEROUS_SPAWN", lintDiagnosticMessages.noDangerousSpawn));
    return;
  }
  if (isDangerousExecCall(node, childProcessBindings)) {
    diagnostics.push(diagnostic(source, "TS_LINT_NO_DANGEROUS_SPAWN", lintDiagnosticMessages.noDangerousSpawn));
  }
}

function collectNoDangerousFallbacks(source: ParsedLintSource, node: TSESTree.Node, diagnostics: ValidationDiagnostic[]): void {
  if (node.type !== "LogicalExpression") return;
  if (node.operator !== "||" && node.operator !== "??") return;
  if (!isLiteralFallback(node.right) || hasMarkerNear(source, node, commentMarkers.fallbackOk)) return;
  const leftText = textFor(source, node.left);
  if (isProcessEnvAccess(node.left, leftText) || isConfigAccess(leftText) || isEmptyObjectOrArray(node.right)) {
    diagnostics.push(diagnostic(source, "TS_LINT_NO_DANGEROUS_FALLBACKS", lintDiagnosticMessages.noDangerousFallbacks));
  }
}

function collectNoHardcodedPorts(source: ParsedLintSource, node: TSESTree.Node, diagnostics: ValidationDiagnostic[]): void {
  if (hasMarkerNear(source, node, commentMarkers.portOk)) return;
  if (hasHardcodedPort(source, node)) {
    diagnostics.push(diagnostic(source, "TS_LINT_NO_HARDCODED_PORTS", lintDiagnosticMessages.noHardcodedPorts));
  }
}

function collectNoRawNetworkWithoutTimeout(source: ParsedLintSource, node: TSESTree.Node, diagnostics: ValidationDiagnostic[]): void {
  if (!isCallExpression(node)) return;
  if (fetchMissingSignal(node) || axiosMissingTimeout(node)) {
    diagnostics.push(
      diagnostic(source, "TS_LINT_NO_RAW_NETWORK_WITHOUT_TIMEOUT", lintDiagnosticMessages.noRawNetworkWithoutTimeout)
    );
  }
}

function collectNoUnboundedPromiseAllMap(source: ParsedLintSource, node: TSESTree.Node, diagnostics: ValidationDiagnostic[]): void {
  if (!isPromiseAllCall(node)) return;
  const firstArg = node.arguments[0];
  if (!isCallExpression(firstArg) || !isMemberNamed(firstArg.callee, "map")) return;
  const mapper = firstArg.arguments[0];
  if (!isFunctionLike(mapper) || mapper.async !== true) return;
  const sourceNode = firstArg.callee.type === "MemberExpression" ? firstArg.callee.object : undefined;
  if (sourceNode === undefined || isBoundedMapSource(sourceNode)) return;
  if (hasMarkerNear(source, node, commentMarkers.unboundedOk)) return;
  diagnostics.push(
    diagnostic(source, "TS_LINT_NO_UNBOUNDED_PROMISE_ALL_MAP", lintDiagnosticMessages.noUnboundedPromiseAllMap)
  );
}

function collectNoUnsafeTypeAssertion(source: ParsedLintSource, node: TSESTree.Node, diagnostics: ValidationDiagnostic[]): void {
  if (node.type !== "TSAsExpression" || node.typeAnnotation.type !== "TSUnknownKeyword") return;
  const parent = source.parentByNode.get(node);
  if (parent?.type !== "TSAsExpression" || hasMarkerNear(source, parent, commentMarkers.assertOk)) return;
  diagnostics.push(diagnostic(source, "TS_LINT_NO_UNSAFE_TYPE_ASSERTION", lintDiagnosticMessages.noUnsafeTypeAssertion));
}

function collectNoDynamicImportConcat(source: ParsedLintSource, node: TSESTree.Node, diagnostics: ValidationDiagnostic[]): void {
  if (node.type !== "ImportExpression") return;
  if (node.source.type === "Literal" && typeof node.source.value === "string") return;
  diagnostics.push(diagnostic(source, "TS_LINT_NO_DYNAMIC_IMPORT_CONCAT", lintDiagnosticMessages.noDynamicImportConcat));
}

function collectRequireErrorContext(source: ParsedLintSource, node: TSESTree.Node, diagnostics: ValidationDiagnostic[]): void {
  if (node.type !== "ThrowStatement" || hasMarkerNear(source, node, commentMarkers.errorOk)) return;
  if (!isNewErrorExpression(node.argument)) return;
  const message = staticStringValue(node.argument.arguments[0]);
  if (message === undefined) return;
  const trimmed = message.trim();
  if (trimmed.length < 20 || genericErrorPattern.test(trimmed)) {
    diagnostics.push(diagnostic(source, "TS_LINT_REQUIRE_ERROR_CONTEXT", lintDiagnosticMessages.requireErrorContext));
  }
}

function collectNoStaticOptionalImport(
  source: ParsedLintSource,
  node: TSESTree.Node,
  optionalDependencies: ReadonlySet<string>,
  diagnostics: ValidationDiagnostic[]
): void {
  if (optionalDependencies.size === 0 || node.type !== "ImportDeclaration" || node.importKind === "type") return;
  const specifier = typeof node.source.value === "string" ? node.source.value : undefined;
  if (specifier === undefined) return;
  for (const dependency of optionalDependencies) {
    if (specifier === dependency || specifier.startsWith(`${dependency}/`)) {
      diagnostics.push(diagnostic(source, "TS_LINT_NO_STATIC_OPTIONAL_IMPORT", lintDiagnosticMessages.noStaticOptionalImport));
      return;
    }
  }
}

function isEmptyCatchHandler(node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression): boolean {
  if (node.body.type !== "BlockStatement") return isNullishExpression(node.body);
  const statements = node.body.body;
  if (statements.length === 0) return true;
  const firstStatement = statements[0];
  return statements.length === 1 && firstStatement?.type === "ReturnStatement" && isNullishExpression(firstStatement.argument);
}

function hasDangerousShellOption(node: TSESTree.CallExpression, childProcessBindings: ChildProcessBindings): boolean {
  if (
    !isChildProcessExecutionCallee(
      node.callee,
      dangerousSpawnFunctionNames,
      childProcessBindings.spawnFunctionNames,
      childProcessBindings
    )
  ) {
    return false;
  }
  const options = node.arguments[2];
  return isObjectExpression(options) && objectHasBooleanProperty(options, "shell", true);
}

function isDangerousExecCall(node: TSESTree.CallExpression, childProcessBindings: ChildProcessBindings): boolean {
  return isChildProcessExecutionCallee(
    node.callee,
    dangerousExecFunctionNames,
    childProcessBindings.execFunctionNames,
    childProcessBindings
  );
}

function isChildProcessExecutionCallee(
  callee: TSESTree.Node,
  functionNames: ReadonlySet<string>,
  boundFunctionNames: ReadonlySet<string>,
  childProcessBindings: ChildProcessBindings
): boolean {
  if (callee.type === "Identifier") {
    return boundFunctionNames.has(callee.name);
  }
  if (callee.type !== "MemberExpression" || !functionNames.has(memberPropertyName(callee) ?? "")) return false;
  return isChildProcessNamespaceExpression(callee.object, childProcessBindings);
}

function isChildProcessNamespaceExpression(node: TSESTree.Node, childProcessBindings: ChildProcessBindings): boolean {
  if (node.type === "Identifier") return childProcessBindings.namespaceNames.has(node.name);
  return isChildProcessRequireCall(node);
}

function collectChildProcessBindings(program: TSESTree.Program): ChildProcessBindings {
  const namespaceNames = new Set<string>();
  const execFunctionNames = new Set<string>();
  const spawnFunctionNames = new Set<string>();
  for (const statement of program.body) {
    collectChildProcessImportBindings(statement, namespaceNames, execFunctionNames, spawnFunctionNames);
    collectChildProcessVariableBindings(statement, namespaceNames, execFunctionNames, spawnFunctionNames);
  }
  return { execFunctionNames, namespaceNames, spawnFunctionNames };
}

function collectChildProcessImportBindings(
  statement: TSESTree.Node,
  namespaceNames: Set<string>,
  execFunctionNames: Set<string>,
  spawnFunctionNames: Set<string>
): void {
  if (statement.type !== "ImportDeclaration" || !isChildProcessModuleSpecifier(statement.source)) return;
  for (const specifier of statement.specifiers) {
    collectChildProcessImportSpecifier(specifier, namespaceNames, execFunctionNames, spawnFunctionNames);
  }
}

function collectChildProcessImportSpecifier(
  specifier: TSESTree.ImportClause,
  namespaceNames: Set<string>,
  execFunctionNames: Set<string>,
  spawnFunctionNames: Set<string>
): void {
  if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") {
    namespaceNames.add(specifier.local.name);
    return;
  }
  const importedName = importSpecifierName(specifier);
  if (importedName !== undefined) {
    collectChildProcessFunctionBinding(importedName, specifier.local.name, execFunctionNames, spawnFunctionNames);
  }
}

function collectChildProcessVariableBindings(
  statement: TSESTree.Node,
  namespaceNames: Set<string>,
  execFunctionNames: Set<string>,
  spawnFunctionNames: Set<string>
): void {
  if (statement.type !== "VariableDeclaration") return;
  for (const declaration of statement.declarations) {
    if (isChildProcessRequireCall(declaration.init)) {
      collectChildProcessRequireBinding(declaration.id, namespaceNames, execFunctionNames, spawnFunctionNames);
    }
  }
}

function collectChildProcessRequireBinding(
  binding: TSESTree.Node,
  namespaceNames: Set<string>,
  execFunctionNames: Set<string>,
  spawnFunctionNames: Set<string>
): void {
  if (binding.type === "Identifier") {
    namespaceNames.add(binding.name);
    return;
  }
  if (binding.type !== "ObjectPattern") return;
  for (const property of binding.properties) {
    if (property.type !== "Property") continue;
    const importedName = propertyKeyName(property);
    if (importedName === undefined) continue;
    const value = property.value;
    if (value.type === "Identifier") {
      collectChildProcessFunctionBinding(importedName, value.name, execFunctionNames, spawnFunctionNames);
    } else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      collectChildProcessFunctionBinding(importedName, value.left.name, execFunctionNames, spawnFunctionNames);
    }
  }
}

function collectChildProcessFunctionBinding(
  importedName: string,
  localName: string,
  execFunctionNames: Set<string>,
  spawnFunctionNames: Set<string>
): void {
  if (dangerousExecFunctionNames.has(importedName)) {
    execFunctionNames.add(localName);
  } else if (dangerousSpawnFunctionNames.has(importedName)) {
    spawnFunctionNames.add(localName);
  }
}

function isChildProcessRequireCall(node: TSESTree.Node | null | undefined): node is TSESTree.CallExpression {
  if (node === null || !isCallExpression(node) || node.callee.type !== "Identifier" || node.callee.name !== "require") return false;
  return isChildProcessModuleSpecifier(node.arguments[0]);
}

function isChildProcessModuleSpecifier(node: TSESTree.Node | null | undefined): boolean {
  return node?.type === "Literal" && typeof node.value === "string" && childProcessModuleSpecifiers.has(node.value);
}

function isChildProcessExecutionFunctionName(name: string): boolean {
  return dangerousExecFunctionNames.has(name) || dangerousSpawnFunctionNames.has(name);
}

function importSpecifierName(specifier: TSESTree.ImportSpecifier): string | undefined {
  if (specifier.imported.type === "Identifier") return specifier.imported.name;
  return specifier.imported.type === "Literal" && typeof specifier.imported.value === "string" ? specifier.imported.value : undefined;
}

function isLiteralFallback(node: TSESTree.Node): boolean {
  return node.type === "Literal" || node.type === "ObjectExpression" || node.type === "ArrayExpression" || node.type === "TemplateLiteral";
}

function isProcessEnvAccess(node: TSESTree.Node, sourceText: string): boolean {
  if (
    node.type === "MemberExpression" &&
    node.object.type === "MemberExpression" &&
    node.object.object.type === "Identifier" &&
    node.object.object.name === "process" &&
    memberPropertyName(node.object) === "env"
  ) {
    return true;
  }
  return /process\.env\.[A-Z_]+/.test(sourceText) || /process\.env\[['"][A-Z_]+['"]\]/.test(sourceText);
}

function isConfigAccess(sourceText: string): boolean {
  return /\b(?:config|settings|options|opts|params)(?:\?|\.)?\.[A-Za-z_]/.test(sourceText);
}

function isEmptyObjectOrArray(node: TSESTree.Node): boolean {
  return (
    (node.type === "ObjectExpression" && node.properties.length === 0) ||
    (node.type === "ArrayExpression" && node.elements.length === 0)
  );
}

function hasHardcodedPort(source: ParsedLintSource, node: TSESTree.Node): boolean {
  if (node.type === "Literal" && typeof node.value === "string") return hardcodedPortPattern().test(node.value);
  if (node.type === "TemplateLiteral") return hardcodedPortPattern().test(node.quasis.map((quasi) => quasi.value.raw).join(""));
  return isForbiddenPortLiteral(source, node);
}

function isForbiddenPortLiteral(source: ParsedLintSource, node: TSESTree.Node): boolean {
  if (node.type !== "Literal" || typeof node.value !== "number" || !defaultPorts.includes(node.value)) return false;
  const parent = source.parentByNode.get(node);
  return isPortProperty(parent) || isListenPortArgument(source, node);
}

function isPortProperty(node: TSESTree.Node | undefined): boolean {
  if (node?.type !== "Property" || node.computed) return false;
  if (node.key.type === "Identifier") return node.key.name === "port";
  return node.key.type === "Literal" && node.key.value === "port";
}

function isListenPortArgument(source: ParsedLintSource, node: TSESTree.Node): boolean {
  const parent = source.parentByNode.get(node);
  if (!isCallExpression(parent) || parent.arguments[0] !== node) return false;
  return isMemberNamed(parent.callee, "listen");
}

function fetchMissingSignal(node: TSESTree.CallExpression): boolean {
  if (!isFetchCall(node)) return false;
  const init = node.arguments[1];
  return !isObjectExpression(init) || !objectHasProperty(init, "signal");
}

function axiosMissingTimeout(node: TSESTree.CallExpression): boolean {
  if (!isAxiosCall(node)) return false;
  const method = memberPropertyName(node.callee);
  if (method === "create") return axiosCreateMissingTimeout(node);
  const configIndex = method === undefined ? undefined : axiosMethodConfigIndex.get(method);
  if (configIndex === undefined) return false;
  const config = node.arguments[configIndex];
  return !isObjectExpression(config) || !objectHasProperty(config, "timeout");
}

function axiosCreateMissingTimeout(node: TSESTree.CallExpression): boolean {
  const config = node.arguments[0];
  return !isObjectExpression(config) || !objectHasProperty(config, "timeout");
}

function isFetchCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === "Identifier" && node.callee.name === "fetch") return true;
  return (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "globalThis" &&
    memberPropertyName(node.callee) === "fetch"
  );
}

function isAxiosCall(node: TSESTree.CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "axios" &&
    memberPropertyName(node.callee) !== undefined
  );
}

function isPromiseAllCall(node: TSESTree.Node): node is TSESTree.CallExpression {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Promise" &&
    memberPropertyName(node.callee) === "all"
  );
}

function isBoundedMapSource(node: TSESTree.Node): boolean {
  if (node.type === "ArrayExpression") return true;
  return isCallExpression(node) && isMemberNamed(node.callee, "slice");
}

function isNewErrorExpression(node: TSESTree.Node | null): node is TSESTree.NewExpression {
  return node?.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Error";
}

function staticStringValue(node: TSESTree.CallExpressionArgument | undefined): string | undefined {
  if (node === undefined || node.type === "SpreadElement") return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return undefined;
}
