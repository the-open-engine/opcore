import type { ValidationCheckDefinition, ValidationCheckContext, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { RUST_IMPORT_GRAPH_CHECK_ID } from "./check-ids.js";
import { rustCheckAdapter, rustCheckOwner, supportedRustValidationScopes } from "./check-constants.js";
import type { CargoMetadataPackage, CargoWorkspaceMetadata } from "./cargo-metadata.js";
import { loadCargoMetadata, resolveCargoPackageScope } from "./cargo-metadata.js";
import { diagnostic, metadataFailureResult, sortDiagnostics } from "./diagnostics.js";
import { materializeRustWorkspace } from "./materialize.js";
import { isRustSourcePath, rustInputSet, skippedRustInputResult, uniqueSorted } from "./source-files.js";

export interface RustImportGraphCheckOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

interface RustSource {
  path: string;
  content: string;
}

export interface ModuleEdge {
  from: string;
  to: string;
  name: string;
  moduleFileStem?: string;
}

export interface RustModuleGraphAnalysisOptions {
  unresolvedModules?: boolean;
  unresolvedUses?: boolean;
  cycles?: boolean;
  orphanDiagnosticCode?: string;
  orphanMessage?: (path: string) => string;
}

export interface RustModuleGraphAnalysis {
  diagnostics: readonly ValidationDiagnostic[];
  edges: readonly ModuleEdge[];
  reachableSources: ReadonlySet<string>;
}

interface RustModuleIndex {
  sources: ReadonlyMap<string, RustSource>;
  parentsByChild: ReadonlyMap<string, string>;
  childrenByParent: ReadonlyMap<string, ReadonlyMap<string, string>>;
  namespaces: ReadonlyMap<string, RustNamespace>;
}

interface RustModuleGraphBuildState {
  reachableSources: Map<string, RustSource>;
  inputSources: Map<string, RustSource>;
  namespaces: Map<string, RustNamespace>;
  edges: ModuleEdge[];
  diagnostics: ValidationDiagnostic[];
  visited: Set<string>;
}

interface RustModuleGraphBuildConfig {
  unresolvedModules: boolean;
  unresolvedUses: boolean;
  checkCycles: boolean;
  orphanDiagnosticCode: string;
  orphanMessage?: (path: string) => string;
}

interface RustNamespace {
  path: string;
  content: string;
  sourcePath?: string;
  moduleFileStem: string;
  pathAttributeBaseDir: string;
  parentPath?: string;
  parent?: RustNamespace;
}

interface RustUseStatement {
  namespace: RustNamespace;
  spec: string;
  cfgConditional: boolean;
}

interface RustModuleDeclaration {
  name: string;
  body?: string;
  pathAttribute?: string;
  cfgConditional: boolean;
}

interface ParsedRustModuleDeclaration {
  declaration: RustModuleDeclaration;
  nextIndex: number;
  bodyOpen?: number;
  bodyClose?: number;
}

interface ParsedRustInlineModuleDeclaration extends ParsedRustModuleDeclaration {
  declaration: RustModuleDeclaration & { body: string };
  bodyOpen: number;
  bodyClose: number;
}

export function createImportGraphCheck(options: RustImportGraphCheckOptions = {}): ValidationCheckDefinition {
  return {
    id: RUST_IMPORT_GRAPH_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    requiresGraph: false,
    run: async (context) => {
      const skipped = skippedRustInputResult(context);
      if (skipped !== undefined) return skipped;
      const materialized = await materializeRustWorkspace(context, { env: options.env });
      try {
        const metadata = loadCargoMetadata(materialized.root, options);
        if (!metadata.ok) return metadataFailureResult(metadata);
        const packageScope = resolveCargoPackageScope(metadata.metadata, context.scope);
        if (!packageScope.ok) return metadataFailureResult(packageScope);
        return await runImportGraph(context, metadata.metadata, packageScope.member);
      } finally {
        materialized.cleanup();
      }
    }
  };
}

async function runImportGraph(
  context: ValidationCheckContext,
  metadata: CargoWorkspaceMetadata,
  member: CargoMetadataPackage | undefined
): Promise<ValidationCheckResult> {
  const analysis = await analyzeRustModuleGraph(context, metadata, member);
  return { diagnostics: analysis.diagnostics };
}

export async function analyzeRustModuleGraph(
  context: ValidationCheckContext,
  metadata: CargoWorkspaceMetadata,
  member: CargoMetadataPackage | undefined,
  options: RustModuleGraphAnalysisOptions = {}
): Promise<RustModuleGraphAnalysis> {
  const rootPaths = cargoTargetRootPaths(metadata, member);
  if (rootPaths.length === 0) {
    return { diagnostics: [], edges: [], reachableSources: new Set() };
  }
  const state = createModuleGraphBuildState();
  const config = moduleGraphBuildConfig(options);
  await visitReachableRoots(context, rootPaths, state, config.unresolvedModules);
  await indexInputSources(context, rustInputSet(context).ownedPaths.filter(isRustSourcePath), state);
  if (config.unresolvedUses) state.diagnostics.push(...(await unresolvedUseDiagnosticsForState(context, state)));
  state.diagnostics.push(...orphanDiagnosticsForState(state, rootPaths, config));
  if (config.checkCycles) state.diagnostics.push(...cycleDiagnostics(state.edges));
  return moduleGraphAnalysisResult(state);
}

function createModuleGraphBuildState(): RustModuleGraphBuildState {
  return {
    reachableSources: new Map(),
    inputSources: new Map(),
    namespaces: new Map(),
    edges: [],
    diagnostics: [],
    visited: new Set()
  };
}

function moduleGraphBuildConfig(options: RustModuleGraphAnalysisOptions): RustModuleGraphBuildConfig {
  return {
    unresolvedModules: options.unresolvedModules ?? true,
    unresolvedUses: options.unresolvedUses ?? true,
    checkCycles: options.cycles ?? true,
    orphanDiagnosticCode: options.orphanDiagnosticCode ?? "RUST_IMPORT_ORPHAN_SOURCE",
    orphanMessage: options.orphanMessage
  };
}

async function visitReachableRoots(
  context: ValidationCheckContext,
  rootPaths: readonly string[],
  state: RustModuleGraphBuildState,
  unresolvedModules: boolean
): Promise<void> {
  for (const rootPath of rootPaths) await visitReachableSource(context, rootPath, state, unresolvedModules);
}

async function visitReachableSource(
  context: ValidationCheckContext,
  path: string,
  state: RustModuleGraphBuildState,
  unresolvedModules: boolean,
  parentPath?: string,
  moduleFileStem?: string
): Promise<void> {
  if (state.visited.has(path)) return;
  state.visited.add(path);
  const source = await readAfterRustSource(context, path);
  if (source === undefined) return;
  state.reachableSources.set(path, source);
  const namespace = sourceNamespace(source, parentPath, moduleFileStem);
  indexNamespace(state, namespace);
  const moduleAnalysis = await moduleEdges(context, namespace, { unresolvedModules });
  state.edges.push(...moduleAnalysis.edges);
  state.diagnostics.push(...moduleAnalysis.diagnostics);
  for (const inlineNamespace of moduleAnalysis.namespaces) indexNamespace(state, inlineNamespace);
  for (const edge of moduleAnalysis.edges) {
    await visitReachableSource(context, edge.to, state, unresolvedModules, edge.from, edge.moduleFileStem);
  }
}

function indexNamespace(state: RustModuleGraphBuildState, namespace: RustNamespace): void {
  state.namespaces.set(namespace.path, namespace);
}

async function indexInputSources(
  context: ValidationCheckContext,
  inputSourcePaths: readonly string[],
  state: RustModuleGraphBuildState
): Promise<void> {
  for (const path of inputSourcePaths) await indexInputSource(context, path, state);
}

async function indexInputSource(
  context: ValidationCheckContext,
  path: string,
  state: RustModuleGraphBuildState
): Promise<void> {
  const source = await readAfterRustSource(context, path);
  if (source === undefined) return;
  state.inputSources.set(path, source);
  if (state.namespaces.has(path)) return;
  const namespace = sourceNamespace(source);
  indexNamespace(state, namespace);
  for (const inlineNamespace of inlineNamespaces(namespace)) indexNamespace(state, inlineNamespace);
}

async function unresolvedUseDiagnosticsForState(
  context: ValidationCheckContext,
  state: RustModuleGraphBuildState
): Promise<readonly ValidationDiagnostic[]> {
  const moduleIndex = moduleIndexFromState(state);
  const diagnostics: ValidationDiagnostic[] = [];
  const useChecked = new Set<string>();
  for (const source of [...state.reachableSources.values(), ...state.inputSources.values()]) {
    if (useChecked.has(source.path)) continue;
    useChecked.add(source.path);
    const namespace = state.namespaces.get(source.path) ?? sourceNamespace(source);
    diagnostics.push(...(await unresolvedUseDiagnostics(context, namespace, moduleIndex)));
  }
  return diagnostics;
}

function moduleIndexFromState(state: RustModuleGraphBuildState): RustModuleIndex {
  return {
    sources: new Map([...state.reachableSources, ...state.inputSources]),
    parentsByChild: parentsByChild(state.edges),
    childrenByParent: childrenByParent(state.edges),
    namespaces: state.namespaces
  };
}

function orphanDiagnosticsForState(
  state: RustModuleGraphBuildState,
  rootPaths: readonly string[],
  config: RustModuleGraphBuildConfig
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const roots = new Set(rootPaths);
  for (const source of state.inputSources.values()) {
    if (roots.has(source.path) || state.reachableSources.has(source.path)) continue;
    diagnostics.push(orphanDiagnostic(source, config));
  }
  return diagnostics;
}

function orphanDiagnostic(source: RustSource, config: RustModuleGraphBuildConfig): ValidationDiagnostic {
  return diagnostic({
    category: "graph",
    path: source.path,
    code: config.orphanDiagnosticCode,
    message: config.orphanMessage?.(source.path) ?? `Rust source file is not reachable from a module root: ${source.path}`
  });
}

function cycleDiagnostics(edges: readonly ModuleEdge[]): readonly ValidationDiagnostic[] {
  return findCycles(edges).map((cycle) =>
    diagnostic({
      category: "graph",
      path: cycle[0],
      code: "RUST_IMPORT_MODULE_CYCLE",
      message: `Rust module cycle detected: ${cycle.join(" -> ")}`
    })
  );
}

function moduleGraphAnalysisResult(state: RustModuleGraphBuildState): RustModuleGraphAnalysis {
  return {
    diagnostics: sortDiagnostics(state.diagnostics),
    edges: state.edges,
    reachableSources: new Set(state.reachableSources.keys())
  };
}

async function readAfterRustSource(context: ValidationCheckContext, path: string): Promise<RustSource | undefined> {
  const result = await context.fileView.readAfter(path);
  if (result.status !== "found") return undefined;
  return {
    path,
    content: result.content
  };
}

async function moduleEdges(
  context: ValidationCheckContext,
  namespace: RustNamespace,
  options: { unresolvedModules: boolean }
): Promise<{ edges: readonly ModuleEdge[]; diagnostics: readonly ValidationDiagnostic[]; namespaces: readonly RustNamespace[] }> {
  const edges: ModuleEdge[] = [];
  const diagnostics: ValidationDiagnostic[] = [];
  const namespaces: RustNamespace[] = [];
  const visitNamespace = async (current: RustNamespace): Promise<void> => {
    for (const declaration of topLevelModuleDeclarations(current.content)) {
      if (declaration.body !== undefined) {
        const childNamespace = inlineNamespace(current, declaration);
        namespaces.push(childNamespace);
        await visitNamespace(childNamespace);
        continue;
      }
      const candidates = modulePathCandidates(current, declaration);
      const target = await firstExistingAfterPath(context, candidates);
      if (target !== undefined) {
        edges.push({
          from: current.path,
          to: target,
          name: declaration.name,
          moduleFileStem: declaration.pathAttribute === undefined ? undefined : pathAttributeModuleFileStem(target)
        });
      } else if (options.unresolvedModules && !declaration.cfgConditional) {
        diagnostics.push(
          diagnostic({
            category: "graph",
            path: current.sourcePath ?? namespace.sourcePath ?? namespace.path,
            code: "RUST_IMPORT_UNRESOLVED_MODULE",
            message: `Rust module declaration has no file: mod ${declaration.name}; expected ${candidates.join(" or ")}`
          })
        );
      }
    }
  };
  await visitNamespace(namespace);
  return { edges, diagnostics, namespaces };
}

function inlineNamespaces(namespace: RustNamespace): readonly RustNamespace[] {
  const discovered: RustNamespace[] = [];
  const visitNamespace = (current: RustNamespace): void => {
    for (const declaration of topLevelModuleDeclarations(current.content)) {
      if (declaration.body === undefined) continue;
      const childNamespace = inlineNamespace(current, declaration);
      discovered.push(childNamespace);
      visitNamespace(childNamespace);
    }
  };
  visitNamespace(namespace);
  return discovered;
}

async function firstExistingAfterPath(
  context: ValidationCheckContext,
  candidates: readonly string[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if ((await context.fileView.readAfter(candidate)).status === "found") return candidate;
  }
  return undefined;
}

function cargoTargetRootPaths(metadata: CargoWorkspaceMetadata, member: CargoMetadataPackage | undefined): readonly string[] {
  const members = member === undefined ? metadata.members : [member];
  return uniqueSorted(members.flatMap((member) => member.targets.map((target) => target.srcPath)).filter(isRustSourcePath));
}

function modulePathCandidates(namespace: RustNamespace, declaration: RustModuleDeclaration): readonly string[] {
  if (declaration.pathAttribute !== undefined) {
    const candidate = normalizeModulePath(namespace.pathAttributeBaseDir, declaration.pathAttribute);
    return candidate === undefined ? [] : [candidate];
  }
  const prefix =
    namespace.moduleFileStem.length === 0 ? declaration.name : `${namespace.moduleFileStem}/${declaration.name}`;
  return [`${prefix}.rs`, `${prefix}/mod.rs`];
}

function normalizeModulePath(baseStem: string, relativePath: string): string | undefined {
  const combined = relativePath.startsWith("/")
    ? relativePath.slice(1)
    : [baseStem, relativePath].filter((part) => part.length > 0).join("/");
  const parts: string[] = [];
  for (const part of combined.replaceAll("\\", "/").split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

function pathAttributeModuleFileStem(path: string): string {
  return sourceDirectory(path);
}

function sourceDirectory(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function isRootRustModule(path: string): boolean {
  return path.endsWith("/lib.rs") || path.endsWith("/main.rs") || path.endsWith("/mod.rs") || path === "lib.rs" || path === "main.rs";
}

function sourceModuleFileStem(path: string): string {
  const dir = sourceDirectory(path);
  return path.endsWith("/mod.rs") || isRootRustModule(path) ? dir : path.slice(0, -".rs".length);
}

function sourceNamespace(source: RustSource, parentPath?: string, moduleFileStem?: string): RustNamespace {
  const sourceDir = sourceDirectory(source.path);
  return {
    path: source.path,
    content: source.content,
    sourcePath: source.path,
    moduleFileStem: moduleFileStem ?? sourceModuleFileStem(source.path),
    pathAttributeBaseDir: sourceDir,
    parentPath
  };
}

function inlineNamespace(parent: RustNamespace, declaration: RustModuleDeclaration): RustNamespace {
  const defaultBase =
    parent.moduleFileStem.length === 0 ? declaration.name : `${parent.moduleFileStem}/${declaration.name}`;
  const explicitBase =
    declaration.pathAttribute === undefined ? undefined : normalizeModulePath(parent.pathAttributeBaseDir, declaration.pathAttribute);
  const base = explicitBase ?? defaultBase;
  return {
    path: `${parent.path}::${declaration.name}`,
    content: declaration.body ?? "",
    moduleFileStem: base,
    pathAttributeBaseDir: base,
    parentPath: parent.path,
    parent
  };
}

function topLevelModuleDeclarations(content: string): readonly RustModuleDeclaration[] {
  const declarations: RustModuleDeclaration[] = [];
  scanTopLevelRustItems(content, {
    onModule: (declaration) => declarations.push(declaration)
  });
  return declarations;
}

function useStatements(namespace: RustNamespace): readonly RustUseStatement[] {
  const statements: RustUseStatement[] = [];
  const visitNamespace = (current: RustNamespace): void => {
    const inlineSpans = topLevelInlineModuleSpans(current.content);
    const excludedRanges = [...inlineSpans.map(inlineModuleBodyRange), ...macroTokenTreeRanges(current.content)];
    statements.push(...useStatementsOutsideRanges(current, excludedRanges));
    for (const span of inlineSpans) visitNamespace(inlineNamespace(current, span.declaration));
  };
  visitNamespace(namespace);
  return statements;
}

function topLevelUseSpecs(content: string): readonly string[] {
  const specs: string[] = [];
  scanTopLevelRustItems(content, {
    onUse: (statement) => {
      if (!statement.cfgConditional) specs.push(statement.spec);
    }
  });
  return specs;
}

function scanTopLevelRustItems(
  content: string,
  handlers: {
    onModule?: (declaration: RustModuleDeclaration) => void;
    onUse?: (statement: Omit<RustUseStatement, "namespace">) => void;
    onParsedModule?: (parsed: ParsedRustModuleDeclaration) => void;
  }
): void {
  const macroRanges = sortedRanges(macroTokenTreeRanges(content));
  let macroRangeIndex = 0;
  let depth = 0;
  let index = 0;
  while (index < content.length) {
    while (macroRangeIndex < macroRanges.length && macroRanges[macroRangeIndex].end <= index) macroRangeIndex += 1;
    const macroRange = macroRanges[macroRangeIndex];
    if (macroRange !== undefined && index >= macroRange.start && index < macroRange.end) {
      index = macroRange.end;
      continue;
    }
    const skipped = skipRustNonCode(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = content[index];
    if (depth === 0 && isKeywordAt(content, index, "mod")) {
      const parsed = parseModuleDeclaration(content, index);
      if (parsed !== undefined) {
        handlers.onModule?.(parsed.declaration);
        handlers.onParsedModule?.(parsed);
        index = parsed.nextIndex;
        continue;
      }
    }
    if (depth === 0 && isKeywordAt(content, index, "use")) {
      const parsed = parseUseStatement(content, index);
      if (parsed !== undefined) {
        handlers.onUse?.(parsed.statement);
        index = parsed.nextIndex;
        continue;
      }
    }
    if (char === "{") depth += 1;
    if (char === "}") depth = Math.max(0, depth - 1);
    index += 1;
  }
}

function parseModuleDeclaration(
  content: string,
  keywordIndex: number
): ParsedRustModuleDeclaration | undefined {
  let index = skipRustTrivia(content, keywordIndex + "mod".length);
  const name = parseIdentifierAt(content, index);
  if (name === undefined) return undefined;
  const attributes = moduleAttributePrefix(content, keywordIndex);
  const pathAttribute = pathAttributeValue(attributes);
  const cfgConditional = hasCfgAttribute(attributes);
  index = skipRustTrivia(content, index + name.length);
  if (content[index] === ";") {
    return { declaration: { name, body: undefined, pathAttribute, cfgConditional }, nextIndex: index + 1 };
  }
  if (content[index] !== "{") return undefined;
  const bodyOpen = index;
  const close = matchingRustBrace(content, index);
  if (close === undefined) return undefined;
  return {
    declaration: { name, body: content.slice(index + 1, close), pathAttribute, cfgConditional },
    nextIndex: close + 1,
    bodyOpen,
    bodyClose: close
  };
}

function topLevelInlineModuleSpans(content: string): readonly ParsedRustInlineModuleDeclaration[] {
  const spans: ParsedRustInlineModuleDeclaration[] = [];
  scanTopLevelRustItems(content, {
    onParsedModule: (parsed) => {
      if (isParsedInlineModule(parsed)) spans.push(parsed);
    }
  });
  return spans;
}

function isParsedInlineModule(parsed: ParsedRustModuleDeclaration): parsed is ParsedRustInlineModuleDeclaration {
  return parsed.declaration.body !== undefined && parsed.bodyOpen !== undefined && parsed.bodyClose !== undefined;
}

function inlineModuleBodyRange(span: ParsedRustInlineModuleDeclaration): { start: number; end: number } {
  return { start: span.bodyOpen, end: span.bodyClose + 1 };
}

function macroTokenTreeRanges(content: string): readonly { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let index = 0;
  while (index < content.length) {
    const skipped = skipRustNonCode(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const macroName = content[index] === "!" ? macroIdentifierBeforeBang(content, index) : undefined;
    if (macroName === undefined) {
      index += 1;
      continue;
    }
    const open = macroName === "macro_rules" ? macroRulesBodyOpen(content, index) : skipRustTrivia(content, index + 1);
    const close = matchingRustDelimiter(content, open);
    if (close === undefined) {
      index += 1;
      continue;
    }
    ranges.push({ start: open, end: close + 1 });
    index = close + 1;
  }
  return ranges;
}

function macroIdentifierBeforeBang(content: string, bangIndex: number): string | undefined {
  let index = bangIndex - 1;
  while (index >= 0 && /\s/.test(content[index])) index -= 1;
  if (index < 0 || !isIdentifierContinue(content[index])) return undefined;
  const end = index + 1;
  while (index >= 0 && isIdentifierContinue(content[index])) index -= 1;
  return content.slice(index + 1, end);
}

function macroRulesBodyOpen(content: string, bangIndex: number): number {
  const nameStart = skipRustTrivia(content, bangIndex + 1);
  const name = parseIdentifierAt(content, nameStart);
  return skipRustTrivia(content, nameStart + (name?.length ?? 0));
}

function matchingRustDelimiter(content: string, openIndex: number): number | undefined {
  const closing = rustDelimiterClose(content[openIndex]);
  if (closing === undefined) return undefined;
  const stack: string[] = [closing];
  let index = openIndex + 1;
  while (index < content.length) {
    const skipped = skipRustNonCode(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const openClose = rustDelimiterClose(content[index]);
    if (openClose !== undefined) {
      stack.push(openClose);
      index += 1;
      continue;
    }
    const expectedClose = stack[stack.length - 1];
    if (content[index] === expectedClose) {
      stack.pop();
      if (stack.length === 0) return index;
    }
    index += 1;
  }
  return undefined;
}

function rustDelimiterClose(open: string): string | undefined {
  if (open === "{") return "}";
  if (open === "(") return ")";
  if (open === "[") return "]";
  return undefined;
}

function useStatementsOutsideRanges(
  namespace: RustNamespace,
  excludedRanges: readonly { start: number; end: number }[]
): readonly RustUseStatement[] {
  const statements: RustUseStatement[] = [];
  const ranges = sortedRanges(excludedRanges);
  let rangeIndex = 0;
  let index = 0;
  while (index < namespace.content.length) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= index) rangeIndex += 1;
    const currentRange = ranges[rangeIndex];
    if (currentRange !== undefined && index >= currentRange.start && index < currentRange.end) {
      index = currentRange.end;
      continue;
    }
    const skipped = skipRustNonCode(namespace.content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (isKeywordAt(namespace.content, index, "use")) {
      const parsed = parseUseStatement(namespace.content, index);
      if (parsed !== undefined) {
        statements.push({ namespace, ...parsed.statement });
        index = parsed.nextIndex;
        continue;
      }
    }
    index += 1;
  }
  return statements;
}

function sortedRanges(ranges: readonly { start: number; end: number }[]): readonly { start: number; end: number }[] {
  return [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
}

function moduleAttributePrefix(content: string, keywordIndex: number): string {
  const keywordLineStart = content.lastIndexOf("\n", keywordIndex - 1) + 1;
  let start = keywordLineStart;
  let currentLineStart = keywordLineStart;
  while (currentLineStart > 0) {
    const previousLineEnd = currentLineStart - 1;
    const previousLineStart = previousLineEnd <= 0 ? 0 : content.lastIndexOf("\n", previousLineEnd - 1) + 1;
    const previousLine = content.slice(previousLineStart, previousLineEnd).trim();
    if (previousLine.length === 0 || previousLine.startsWith("//") || previousLine.startsWith("#[")) {
      start = previousLineStart;
      currentLineStart = previousLineStart;
      continue;
    }
    break;
  }
  return content.slice(start, keywordIndex);
}

function pathAttributeValue(attributes: string): string | undefined {
  const normal = /#\s*\[\s*path\s*=\s*"((?:\\.|[^"\\])*)"\s*\]/.exec(attributes);
  if (normal !== null) return decodeRustStringFragment(normal[1]);
  const raw = /#\s*\[\s*path\s*=\s*r(#+)?"([\s\S]*?)"\1\s*\]/.exec(attributes);
  return raw?.[2];
}

function decodeRustStringFragment(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

function hasCfgAttribute(attributes: string): boolean {
  return /#\s*\[\s*cfg\s*\(/.test(attributes) || cfgAttrAppliesCfgAttribute(attributes);
}

function cfgAttrAppliesCfgAttribute(attributes: string): boolean {
  const pattern = /#\s*\[\s*cfg_attr\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(attributes)) !== null) {
    const openIndex = pattern.lastIndex - 1;
    const closeIndex = matchingRustParen(attributes, openIndex);
    if (closeIndex === undefined) {
      pattern.lastIndex = openIndex + 1;
      continue;
    }
    const [, ...appliedAttributes] = splitTopLevelAttributeArgs(attributes.slice(openIndex + 1, closeIndex));
    if (appliedAttributes.some((attribute) => /^\s*cfg\s*\(/.test(attribute))) return true;
    pattern.lastIndex = closeIndex + 1;
  }
  return false;
}

function splitTopLevelAttributeArgs(value: string): readonly string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < value.length) {
    const skipped = skipRustNonCode(value, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = value[index];
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  entries.push(value.slice(start));
  return entries;
}

function parseUseStatement(
  content: string,
  keywordIndex: number
): { statement: Omit<RustUseStatement, "namespace">; nextIndex: number } | undefined {
  const attributes = moduleAttributePrefix(content, keywordIndex);
  const cfgConditional = hasCfgAttribute(attributes);
  const start = skipRustTrivia(content, keywordIndex + "use".length);
  let index = start;
  let braceDepth = 0;
  while (index < content.length) {
    const skipped = skipRustNonCode(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = content[index];
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (char === ";" && braceDepth === 0) {
      return { statement: { spec: content.slice(start, index), cfgConditional }, nextIndex: index + 1 };
    }
    index += 1;
  }
  return undefined;
}

function matchingRustBrace(content: string, openIndex: number): number | undefined {
  let depth = 0;
  let index = openIndex;
  while (index < content.length) {
    const skipped = skipRustNonCode(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = content[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return undefined;
}

function matchingRustParen(content: string, openIndex: number): number | undefined {
  let depth = 0;
  let index = openIndex;
  while (index < content.length) {
    const skipped = skipRustNonCode(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = content[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return undefined;
}

function skipRustTrivia(content: string, index: number): number {
  let current = index;
  while (current < content.length) {
    const skippedWhitespace = skipWhitespace(content, current);
    const skippedComment = skipRustComment(content, skippedWhitespace);
    if (skippedComment === skippedWhitespace) return skippedWhitespace;
    current = skippedComment;
  }
  return current;
}

function skipWhitespace(content: string, index: number): number {
  let current = index;
  while (current < content.length && /\s/.test(content[current])) current += 1;
  return current;
}

function skipRustNonCode(content: string, index: number): number {
  const comment = skipRustComment(content, index);
  if (comment !== index) return comment;
  return skipRustStringOrChar(content, index);
}

function skipRustComment(content: string, index: number): number {
  if (content.startsWith("//", index)) {
    const newline = content.indexOf("\n", index + 2);
    return newline === -1 ? content.length : newline + 1;
  }
  if (!content.startsWith("/*", index)) return index;
  let depth = 1;
  let current = index + 2;
  while (current < content.length) {
    if (content.startsWith("/*", current)) {
      depth += 1;
      current += 2;
      continue;
    }
    if (content.startsWith("*/", current)) {
      depth -= 1;
      current += 2;
      if (depth === 0) return current;
      continue;
    }
    current += 1;
  }
  return content.length;
}

function skipRustStringOrChar(content: string, index: number): number {
  const rawString = rawStringEnd(content, index);
  if (rawString !== undefined) return rawString;
  const quote = content[index];
  if (quote !== '"' && quote !== "'") return index;
  if (quote === "'" && isLifetimeStart(content, index)) return index;
  let current = index + 1;
  while (current < content.length) {
    if (content[current] === "\\") {
      current += 2;
      continue;
    }
    if (content[current] === quote) return current + 1;
    current += 1;
  }
  return content.length;
}

function rawStringEnd(content: string, index: number): number | undefined {
  if (content[index] !== "r") return undefined;
  let hashes = 0;
  let current = index + 1;
  while (content[current] === "#") {
    hashes += 1;
    current += 1;
  }
  if (content[current] !== '"') return undefined;
  const terminator = `"${"#".repeat(hashes)}`;
  const end = content.indexOf(terminator, current + 1);
  return end === -1 ? content.length : end + terminator.length;
}

function isLifetimeStart(content: string, index: number): boolean {
  return isIdentifierStart(content[index + 1] ?? "") && content[index + 2] !== "'";
}

function parseIdentifierAt(content: string, index: number): string | undefined {
  const first = content[index];
  if (!isIdentifierStart(first)) return undefined;
  let end = index + 1;
  while (end < content.length && isIdentifierContinue(content[end])) end += 1;
  return content.slice(index, end);
}

function isKeywordAt(content: string, index: number, keyword: string): boolean {
  if (!content.startsWith(keyword, index)) return false;
  return !isIdentifierContinue(content[index - 1] ?? "") && !isIdentifierContinue(content[index + keyword.length] ?? "");
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierContinue(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

async function unresolvedUseDiagnostics(
  context: ValidationCheckContext,
  namespace: RustNamespace,
  moduleIndex: RustModuleIndex
): Promise<readonly ValidationDiagnostic[]> {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const statement of useStatements(namespace)) {
    if (statement.cfgConditional) continue;
    for (const usePath of usePaths(statement.spec)) {
      if (await usePathExists(context, statement.namespace, moduleIndex, usePath)) continue;
      diagnostics.push(
        diagnostic({
          category: "graph",
          path: statement.namespace.sourcePath ?? namespace.sourcePath ?? namespace.path,
          code: "RUST_IMPORT_UNRESOLVED_USE",
          message: `Rust use path cannot be resolved: ${usePath.join("::")}`
        })
      );
    }
  }
  return diagnostics;
}

function usePaths(spec: string): readonly (readonly string[])[] {
  return expandUseSpec(spec, []).filter(isQualifiedUsePath);
}

function expandUseSpec(spec: string, prefix: readonly string[]): readonly (readonly string[])[] {
  const trimmed = spec.trim();
  if (trimmed.length === 0 || trimmed === "*") return [];
  const group = braceGroup(trimmed);
  if (group !== undefined) {
    const groupPrefix = pathSegments(trimmed.slice(0, group.open).trim().replace(/::$/, ""));
    const nextPrefix = appendUsePath(prefix, groupPrefix);
    return splitTopLevelCommas(trimmed.slice(group.open + 1, group.close)).flatMap((entry) => expandUseSpec(entry, nextPrefix));
  }
  const segments = pathSegments(trimmed);
  if (segments.length === 0) return [];
  return [appendUsePath(prefix, segments)];
}

function appendUsePath(prefix: readonly string[], segments: readonly string[]): readonly string[] {
  if (segments[0] === "self" && prefix.length > 0) return [...prefix, ...segments.slice(1)];
  return [...prefix, ...segments];
}

function braceGroup(value: string): { open: number; close: number } | undefined {
  const open = value.indexOf("{");
  if (open === -1) return undefined;
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    const char = value[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return { open, close: index };
    }
  }
  return undefined;
}

function splitTopLevelCommas(value: string): readonly string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

function pathSegments(path: string): string[] {
  return path
    .replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/, "")
    .split("::")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => /^[A-Za-z_][A-Za-z0-9_]*/.exec(segment)?.[0])
    .filter((segment): segment is string => segment !== undefined);
}

function isQualifiedUsePath(path: readonly string[]): boolean {
  return ["crate", "self", "super"].includes(path[0] ?? "") && path.length > 1;
}

async function usePathExists(
  context: ValidationCheckContext,
  namespace: RustNamespace,
  moduleIndex: RustModuleIndex,
  usePath: readonly string[],
  seenReExportedVariants = new Set<string>()
): Promise<boolean> {
  const [qualifier, ...segments] = usePath;
  const roots =
    qualifier === "crate"
      ? [{ namespace: await crateRootNamespace(context, moduleIndex, namespace), segments }]
      : qualifier === "self"
        ? [{ namespace, segments }]
        : await superNamespaces(context, namespace, moduleIndex, segments);
  for (const root of roots) {
    if (await namespacePathExists(context, moduleIndex, root.namespace, root.segments, seenReExportedVariants)) return true;
  }
  return false;
}

async function crateRootNamespace(
  context: ValidationCheckContext,
  moduleIndex: RustModuleIndex,
  namespace: RustNamespace
): Promise<RustNamespace> {
  let current = namespace;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current.path)) return current;
    seen.add(current.path);
    const parent = await parentNamespace(context, moduleIndex, current);
    if (parent === undefined || seen.has(parent.path)) return current;
    current = parent;
  }
}

async function superNamespaces(
  context: ValidationCheckContext,
  namespace: RustNamespace,
  moduleIndex: RustModuleIndex,
  segments: readonly string[]
): Promise<readonly { namespace: RustNamespace; segments: readonly string[] }[]> {
  let depth = 1;
  let restIndex = 0;
  while (segments[restIndex] === "super") {
    depth += 1;
    restIndex += 1;
  }
  let ancestor: RustNamespace | undefined = namespace;
  for (let index = 0; index < depth; index += 1) {
    ancestor = ancestor === undefined ? undefined : await parentNamespace(context, moduleIndex, ancestor);
  }
  return ancestor === undefined ? [] : [{ namespace: ancestor, segments: segments.slice(restIndex) }];
}

async function namespacePathExists(
  context: ValidationCheckContext,
  moduleIndex: RustModuleIndex,
  namespace: RustNamespace,
  segments: readonly string[],
  seenReExportedVariants = new Set<string>()
): Promise<boolean> {
  if (segments.length === 0) return true;
  if (sourceNamespaceContainsPath(namespace, segments)) return true;
  if (segments.length === 2 && (await reExportedEnumVariantExists(context, moduleIndex, namespace, segments, seenReExportedVariants))) {
    return true;
  }
  const [segment, ...rest] = segments;
  const child = await resolveChildNamespace(context, moduleIndex, namespace, segment);
  if (rest.length === 0) {
    return child !== undefined || sourceNamespaceContains(namespace, segment);
  }
  if (child === undefined) return false;
  return namespacePathExists(context, moduleIndex, child, rest, seenReExportedVariants);
}

async function reExportedEnumVariantExists(
  context: ValidationCheckContext,
  moduleIndex: RustModuleIndex,
  namespace: RustNamespace,
  segments: readonly string[],
  seenReExportedVariants: Set<string>
): Promise<boolean> {
  const [enumName, variantName] = segments;
  if (enumName === undefined || variantName === undefined) return false;
  const seenKey = `${namespace.path}\0${enumName}\0${variantName}`;
  if (seenReExportedVariants.has(seenKey)) return false;
  seenReExportedVariants.add(seenKey);
  for (const binding of importedBindingsForName(namespace, enumName)) {
    const reboundPath = [...binding.path, variantName];
    const exists = isQualifiedUsePath(reboundPath)
      ? await usePathExists(context, namespace, moduleIndex, reboundPath, seenReExportedVariants)
      : await namespacePathExists(context, moduleIndex, namespace, reboundPath, seenReExportedVariants);
    if (exists) return true;
  }
  return false;
}

async function parentNamespace(
  context: ValidationCheckContext,
  moduleIndex: RustModuleIndex,
  namespace: RustNamespace
): Promise<RustNamespace | undefined> {
  if (namespace.parent !== undefined) return namespace.parent;
  const parentPath = namespace.parentPath ?? (namespace.sourcePath === undefined ? undefined : moduleIndex.parentsByChild.get(namespace.sourcePath));
  if (parentPath === undefined) return undefined;
  const indexed = moduleIndex.namespaces.get(parentPath);
  if (indexed !== undefined) return indexed;
  const source = moduleIndex.sources.get(parentPath) ?? (await readAfterRustSource(context, parentPath));
  return source === undefined ? undefined : sourceNamespace(source);
}

async function resolveChildNamespace(
  context: ValidationCheckContext,
  moduleIndex: RustModuleIndex,
  namespace: RustNamespace,
  segment: string
): Promise<RustNamespace | undefined> {
  const inline = inlineModule(namespace, segment);
  if (inline !== undefined) return inline;

  const childPath = moduleIndex.childrenByParent.get(namespace.path)?.get(segment);
  if (childPath === undefined) return undefined;
  const childSource = moduleIndex.sources.get(childPath) ?? (await readAfterRustSource(context, childPath));
  return childSource === undefined ? undefined : (moduleIndex.namespaces.get(childPath) ?? sourceNamespace(childSource, namespace.path));
}

function sourceNamespaceContains(
  namespace: RustNamespace,
  segment: string
): boolean {
  return inlineModule(namespace, segment) !== undefined || hasDeclaredItem(namespace.content, segment) || hasImportedBinding(namespace, segment);
}

function sourceNamespaceContainsPath(namespace: RustNamespace, segments: readonly string[]): boolean {
  if (segments.length === 1) return sourceNamespaceContains(namespace, segments[0]);
  if (segments.length === 2) return hasDeclaredEnumVariant(namespace.content, segments[0], segments[1]);
  return false;
}

function inlineModule(namespace: RustNamespace, moduleName: string): RustNamespace | undefined {
  const declaration = topLevelModuleDeclarations(namespace.content).find(
    (declaration) => declaration.name === moduleName && declaration.body !== undefined
  );
  return declaration?.body === undefined ? undefined : inlineNamespace(namespace, declaration);
}

function hasDeclaredItem(content: string, itemName: string): boolean {
  const name = escapeRegExp(itemName);
  const itemPattern = new RegExp(
    [
      `(?:^|\\n)\\s*`,
      `(?:#\\[[^\\n]*\\]\\s*)*`,
      `(?:pub(?:\\([^)]*\\))?\\s+)?`,
      `(?:(?:async|unsafe|const)\\s+)*`,
      `(?:extern\\s+"[^"]+"\\s+)?`,
      `(?:const|static|struct|enum|trait|type|fn|union)\\s+${name}\\b`
    ].join(""),
    "g"
  );
  const macroPattern = new RegExp(`(?:^|\\n)\\s*(?:#\\[[^\\n]*\\]\\s*)*macro_rules!\\s+${name}\\b`, "g");
  return (
    [...content.matchAll(itemPattern), ...content.matchAll(macroPattern)].some((match) =>
      isTopLevelAt(content, match.index ?? 0)
    )
  );
}

function hasDeclaredEnumVariant(content: string, enumName: string, variantName: string): boolean {
  let index = 0;
  while (index < content.length) {
    const skipped = skipRustNonCode(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (!isKeywordAt(content, index, "enum") || !isTopLevelAt(content, index)) {
      index += 1;
      continue;
    }
    const parsedName = parseIdentifierAt(content, skipRustTrivia(content, index + "enum".length));
    if (parsedName !== enumName) {
      index += "enum".length;
      continue;
    }
    const body = enumBody(content, index + "enum".length + parsedName.length);
    if (body !== undefined && enumBodyHasVariant(body, variantName)) return true;
    index += "enum".length;
  }
  return false;
}

function enumBody(content: string, searchStart: number): string | undefined {
  const open = content.indexOf("{", searchStart);
  if (open === -1) return undefined;
  const close = matchingRustBrace(content, open);
  return close === undefined ? undefined : content.slice(open + 1, close);
}

function enumBodyHasVariant(body: string, variantName: string): boolean {
  let depth = 0;
  let index = 0;
  let expectVariant = true;
  while (index < body.length) {
    const skipped = skipRustAttribute(body, skipRustNonCode(body, index));
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = body[index];
    if (depth === 0 && expectVariant) {
      const name = parseIdentifierAt(body, index);
      if (name === variantName) return true;
      if (name !== undefined) expectVariant = false;
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) expectVariant = true;
    index += 1;
  }
  return false;
}

function skipRustAttribute(content: string, index: number): number {
  if (!content.startsWith("#[", index)) return index;
  const close = content.indexOf("]", index + 2);
  return close === -1 ? content.length : close + 1;
}

function isTopLevelAt(content: string, targetIndex: number): boolean {
  let depth = 0;
  let index = 0;
  while (index < targetIndex) {
    const skipped = skipRustNonCode(content, index);
    if (skipped !== index) {
      index = Math.min(skipped, targetIndex);
      continue;
    }
    const char = content[index];
    if (char === "{") depth += 1;
    if (char === "}") depth = Math.max(0, depth - 1);
    index += 1;
  }
  return depth === 0;
}

function hasImportedBinding(namespace: RustNamespace, itemName: string): boolean {
  return importedBindingsForName(namespace, itemName).length > 0;
}

function importedBindingsForName(namespace: RustNamespace, itemName: string): readonly ImportedBinding[] {
  return topLevelUseSpecs(namespace.content).flatMap((spec) =>
    importedBindings(spec.trim(), []).filter(
    (binding) => binding.name === itemName && !isSelfReferentialImport(binding.path, binding.aliased, itemName)
    )
  );
}

interface ImportedBinding {
  name: string;
  path: readonly string[];
  aliased: boolean;
}

function importedBindings(spec: string, prefix: readonly string[]): readonly ImportedBinding[] {
  const trimmed = spec.trim();
  if (trimmed.length === 0 || trimmed === "*") return [];
  const group = braceGroup(trimmed);
  if (group !== undefined) {
    const groupPrefix = pathSegments(trimmed.slice(0, group.open).trim().replace(/::$/, ""));
    const nextPrefix = appendUsePath(prefix, groupPrefix);
    return splitTopLevelCommas(trimmed.slice(group.open + 1, group.close)).flatMap((entry) => importedBindings(entry, nextPrefix));
  }
  if (/(?:^|::)\s*\*\s*$/.test(trimmed)) return [];
  const alias = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(trimmed);
  const path = appendUsePath(prefix, pathSegments(trimmed));
  const name = alias?.[1] ?? path.at(-1);
  return name === undefined ? [] : [{ name, path, aliased: alias !== null }];
}

function isSelfReferentialImport(path: readonly string[], aliased: boolean, itemName: string): boolean {
  return !aliased && ["crate", "self", "super"].includes(path[0] ?? "") && path[1] === itemName;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parentsByChild(edges: readonly ModuleEdge[]): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const edge of edges) {
    if (!parents.has(edge.to)) parents.set(edge.to, edge.from);
  }
  return parents;
}

function childrenByParent(edges: readonly ModuleEdge[]): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const children = new Map<string, Map<string, string>>();
  for (const edge of edges) {
    const parentChildren = children.get(edge.from) ?? new Map<string, string>();
    parentChildren.set(edge.name, edge.to);
    children.set(edge.from, parentChildren);
  }
  return children;
}

function findCycles(edges: readonly ModuleEdge[]): readonly (readonly string[])[] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = graph.get(edge.from) ?? [];
    targets.push(edge.to);
    graph.set(edge.from, targets);
  }
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string) => {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      if (index !== -1) cycles.push([...stack.slice(index), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) visit(target);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return cycles;
}
