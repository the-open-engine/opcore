import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import type {
  GraphFactEdge,
  GraphNodeKind,
  InspectFailureCategory,
  InspectImplementationEntry,
  InspectImplementationKind,
  InspectReferenceEntry,
  InspectReferenceTarget,
  InspectSignatureEntry,
  InspectSignatureKind,
  InspectSignatureParameter,
  InspectSignatureTypeParameter,
  InspectSymbolSummary,
  InspectSymbolTarget
} from "@the-open-engine/opcore-contracts";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type ParameterDeclaration,
  type SourceFile,
  type Symbol as MorphSymbol,
  type TypeParameterDeclaration
} from "ts-morph";

export interface InspectReferenceRequest {
  path: string;
  symbolName: string;
  line?: number;
  column?: number;
  allowGraphless?: boolean;
  graphTargetOnly?: boolean;
  graphNodeIds: readonly string[];
  graphCandidates?: readonly InspectGraphCandidate[];
  graphKind?: GraphNodeKind;
  graphSymbolName?: string;
  limit?: number;
}

export interface InspectImplementationRequest {
  target: InspectSymbolTarget;
  allowGraphless?: boolean;
  graphCandidates: readonly InspectGraphCandidate[];
  graphEdges: readonly GraphFactEdge[];
  limit?: number;
}

export interface InspectGraphCandidate {
  id: string;
  kind: GraphNodeKind;
  path?: string;
  name?: string;
}

export type InspectReferenceResolution =
  | {
      ok: true;
      target: InspectReferenceTarget;
      references: readonly InspectReferenceEntry[];
    }
  | {
      ok: false;
      category: InspectFailureCategory;
      message: string;
      target?: InspectReferenceTarget;
      candidates?: readonly InspectReferenceTarget[];
    };

export type InspectSignatureRequest = InspectReferenceRequest;

export type InspectSignatureResolution =
  | {
      ok: true;
      target: InspectReferenceTarget;
      signatures: readonly InspectSignatureEntry[];
    }
  | {
      ok: false;
      category: InspectFailureCategory;
      message: string;
      target?: InspectReferenceTarget;
      candidates?: readonly InspectReferenceTarget[];
    };

export type InspectImplementationResolution =
  | {
      ok: true;
      target: InspectSymbolTarget;
      implementations: readonly InspectImplementationEntry[];
    }
  | {
      ok: false;
      category: InspectFailureCategory;
      message: string;
      target?: InspectSymbolTarget;
      candidates?: readonly InspectSymbolTarget[];
    };

export type InspectLanguageServiceProjectScope = "import_closure" | "whole_repo";

export interface InspectLanguageServiceOptions {
  project?: Project;
  projectScope?: InspectLanguageServiceProjectScope;
  projectTsconfigPath?: string;
  includeDependents?: boolean;
  snapshotProject?: (project: Project) => unknown;
  revertProject?: (project: Project, snapshot: unknown) => void;
}

const inspectProjectScopes = new WeakMap<Project, InspectLanguageServiceProjectScope>();

const sourceFileExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const implementationSourceFileExtensions = new Set([".ts", ".tsx"]);
const excludedDirectories = new Set([
  ".ace",
  ".agents",
  ".claude",
  ".codex",
  ".gemini",
  ".git",
  ".lattice",
  ".opencode",
  ".pnpm",
  ".robustness-engine-cache",
  ".rox-cache",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);

type ReferenceEntry = {
  getNode(): Node;
  getSourceFile(): SourceFile;
  getTextSpan(): { getStart(): number; getEnd(): number };
  isDefinition(): boolean;
};

type ReferenceSymbol = {
  getReferences(): readonly ReferenceEntry[];
};

type ReferenceFindableNode = Node & {
  findReferences(): readonly ReferenceSymbol[];
};

export function isSupportedInspectSourcePath(path: string): boolean {
  return sourceFileExtensions.has(extname(path).toLowerCase());
}

export function isSupportedInspectImplementationSourcePath(path: string): boolean {
  return implementationSourceFileExtensions.has(extname(path).toLowerCase());
}

export function resolveInspectSignatures(
  repoRoot: string,
  request: InspectSignatureRequest,
  options: InspectLanguageServiceOptions = {}
): InspectSignatureResolution {
  const normalizedRepoRoot = canonicalRepoRoot(repoRoot);
  const baseTarget = targetFromRequest(request);
  if (!isSupportedInspectSourcePath(request.path)) {
    return {
      ok: false,
      category: "unsupported_language",
      message: `Unsupported inspect signature target language: ${request.path}`,
      target: baseTarget
    };
  }
  const absoluteTargetPath = resolve(normalizedRepoRoot, request.path);
  if (!isSafeExistingFileInsideRepo(normalizedRepoRoot, absoluteTargetPath)) {
    return {
      ok: false,
      category: "target_not_found",
      message: `Inspect signature target file not found: ${request.path}`,
      target: baseTarget
    };
  }

  try {
    for (const context of createProjectContexts(normalizedRepoRoot, request.path, options)) {
      const resolution = withProjectSnapshot(context, () => resolveInspectSignatureInProject(normalizedRepoRoot, context, absoluteTargetPath, request, baseTarget));
      return resolution;
    }
    return {
      ok: false,
      category: "language_service_error",
      message: "No TypeScript project context was available for inspect signature",
      target: baseTarget
    };
  } catch (error) {
    return {
      ok: false,
      category: "language_service_error",
      message: `TypeScript language service failed for inspect signature: ${errorMessage(error)}`,
      target: baseTarget
    };
  }
}

function resolveInspectSignatureInProject(
  repoRoot: string,
  context: ProjectContext,
  absoluteTargetPath: string,
  request: InspectSignatureRequest,
  baseTarget: InspectReferenceTarget
): InspectSignatureResolution {
  const sourceFile = context.project.getSourceFile(absoluteTargetPath) ?? context.project.addSourceFileAtPath(absoluteTargetPath);
  const target = findSignatureTarget(repoRoot, sourceFile, request);
  if (!target.ok) return target;
  const declaration = symbolDeclaration(target.node.getSymbol()) ?? target.node;
  const graphBinding = bindSignatureDeclarationToGraph(repoRoot, declaration, request);
  if (!graphBinding.ok) return missingGraphSignatureResolution(request, baseTarget, target.candidates);
  const boundRequest: InspectSignatureRequest = {
    ...request,
    graphNodeIds: [graphBinding.candidate.id],
    graphKind: graphBinding.candidate.kind,
    graphSymbolName: graphBinding.candidate.name
  };
  const signatures = collectSignatureEntries(repoRoot, declaration, boundRequest);
  if (signatures.length === 0) return missingSignatureDeclarationResolution(request, baseTarget, target.candidates);
  return {
    ok: true,
    target: { ...baseTarget, nodeId: graphBinding.candidate.id },
    signatures
  };
}

function missingGraphSignatureResolution(
  request: InspectSignatureRequest,
  baseTarget: InspectReferenceTarget,
  candidates: readonly InspectReferenceTarget[]
): InspectSignatureResolution {
  return {
    ok: false,
    category: "target_not_found",
    message: `Symbol "${request.symbolName}" in ${request.path}${request.line ? ` at line ${request.line}` : ""} is not backed by graph facts`,
    target: baseTarget,
    candidates
  };
}

function missingSignatureDeclarationResolution(
  request: InspectSignatureRequest,
  baseTarget: InspectReferenceTarget,
  candidates: readonly InspectReferenceTarget[]
): InspectSignatureResolution {
  return {
    ok: false,
    category: "target_not_found",
    message: `No inspect signature declarations found for "${request.symbolName}" in ${request.path}`,
    target: baseTarget,
    candidates
  };
}

export function resolveInspectReferences(
  repoRoot: string,
  request: InspectReferenceRequest,
  options: InspectLanguageServiceOptions = {}
): InspectReferenceResolution {
  const normalizedRepoRoot = canonicalRepoRoot(repoRoot);
  const baseTarget = targetFromRequest(request);
  if (!isSupportedInspectSourcePath(request.path)) {
    return {
      ok: false,
      category: "unsupported_language",
      message: `Unsupported inspect references target language: ${request.path}`,
      target: baseTarget
    };
  }
  const absoluteTargetPath = resolve(normalizedRepoRoot, request.path);
  if (!isSafeExistingFileInsideRepo(normalizedRepoRoot, absoluteTargetPath)) {
    return {
      ok: false,
      category: "target_not_found",
      message: `Inspect references target file not found: ${request.path}`,
      target: baseTarget
    };
  }

  try {
    const projectScope = options.projectScope ?? "import_closure";
    const includeDependents = projectScope === "whole_repo" ? options.includeDependents === true : true;
    for (const context of createProjectContexts(normalizedRepoRoot, request.path, {
      ...options,
      includeDependents,
      projectScope
    })) {
      const resolution = withProjectSnapshot(context, () => {
        const sourceFile = context.project.getSourceFile(absoluteTargetPath) ?? context.project.addSourceFileAtPath(absoluteTargetPath);
        const target = findReferenceTarget(normalizedRepoRoot, sourceFile, request);
        if (!target.ok) return target;
        const graphBinding = bindReferenceTargetToGraph(normalizedRepoRoot, target.node, request);
        if (!graphBinding.ok) {
          return {
            ok: false,
            category: "target_not_found",
            message: `Symbol "${request.symbolName}" in ${request.path}${request.line ? ` at line ${request.line}` : ""} is not backed by graph facts`,
            target: baseTarget,
            candidates: target.candidates
          } satisfies InspectReferenceResolution;
        }
        const boundRequest: InspectReferenceRequest = {
          ...request,
          graphNodeIds: [graphBinding.candidate.id],
          graphKind: graphBinding.candidate.kind,
          graphSymbolName: graphBinding.candidate.name
        };
        const references = collectReferenceEntries(normalizedRepoRoot, target.node, boundRequest);
        return {
          ok: true,
          target: {
            ...baseTarget,
            nodeId: graphBinding.candidate.id
          },
          references: applyLimit(references, request.limit)
        } satisfies InspectReferenceResolution;
      });
      return resolution;
    }
    return {
      ok: false,
      category: "language_service_error",
      message: "No TypeScript project context was available for inspect references",
      target: baseTarget
    };
  } catch (error) {
    return {
      ok: false,
      category: "language_service_error",
      message: `TypeScript language service failed for inspect references: ${errorMessage(error)}`,
      target: baseTarget
    };
  }
}

export function resolveInspectImplementations(
  repoRoot: string,
  request: InspectImplementationRequest,
  options: InspectLanguageServiceOptions = {}
): InspectImplementationResolution {
  const normalizedRepoRoot = canonicalRepoRoot(repoRoot);
  const preflight = preflightImplementationTarget(normalizedRepoRoot, request);
  if (!preflight.ok) return preflight;

  try {
    const projectScope: InspectLanguageServiceProjectScope = request.allowGraphless ? "whole_repo" : (options.projectScope ?? "import_closure");
    for (const context of createProjectContexts(normalizedRepoRoot, preflight.path, { ...options, projectScope })) {
      const resolution = withProjectSnapshot(context, () => {
        const targetResolution = resolveImplementationTargetInProject(context.project, normalizedRepoRoot, request, preflight.candidate);
        if (!targetResolution.ok) return targetResolution;
        const targetCandidate = targetResolution.candidate;
        const languageServiceNodes = implementationLocationNodesByGraphId(context.project, normalizedRepoRoot, targetResolution.node);
        if (request.allowGraphless) {
          return {
            ok: true,
            target: targetResolution.target,
            implementations: collectGraphlessImplementationEntries({
              project: context.project,
              repoRoot: normalizedRepoRoot,
              targetCandidate,
              targetSummary: targetResolution.targetSummary,
              limit: request.limit
            })
          } satisfies InspectImplementationResolution;
        }
        const relationships = collectImplementationRelationships(targetCandidate, request.graphCandidates, request.graphEdges);
        const entries: InspectImplementationEntry[] = [];
        for (const relationship of relationships) {
          const candidate = request.graphCandidates.find((entry) => entry.id === relationship.candidateId);
          if (!candidate || !candidate.path || !candidate.name) continue;
          if (!isSupportedInspectImplementationSourcePath(candidate.path)) continue;
          const implementationNode =
            languageServiceNodes.get(candidate.id) ?? declarationNameNodeForGraphCandidate(context.project, normalizedRepoRoot, candidate);
          if (!implementationNode) continue;
          entries.push(implementationEntry(normalizedRepoRoot, implementationNode, candidate, targetResolution.targetSummary, relationship));
        }
        return {
          ok: true,
          target: targetResolution.target,
          implementations: applyImplementationLimit(entries.sort(compareImplementationEntries), request.limit)
        } satisfies InspectImplementationResolution;
      });
      return resolution;
    }
    return {
      ok: false,
      category: "language_service_error",
      message: "No TypeScript project context was available for inspect implementations",
      target: request.target
    };
  } catch (error) {
    return {
      ok: false,
      category: "language_service_error",
      message: `TypeScript language service failed for inspect implementations: ${errorMessage(error)}`,
      target: request.target
    };
  }
}

function preflightImplementationTarget(
  repoRoot: string,
  request: InspectImplementationRequest
):
  | { ok: true; path: string; candidate?: InspectGraphCandidate }
  | { ok: false; category: InspectFailureCategory; message: string; target: InspectSymbolTarget } {
  if (request.target.kind === "node") {
    const candidate = request.graphCandidates.find((entry) => entry.id === request.target.nodeId);
    if (!candidate || !candidate.path || !candidate.name) {
      return {
        ok: false,
        category: "target_not_found",
        message: `Inspect implementations target node not found in graph facts: ${request.target.nodeId ?? ""}`,
        target: request.target
      };
    }
    if (!isSupportedInspectImplementationSourcePath(candidate.path)) {
      return {
        ok: false,
        category: "unsupported_language",
        message: `Unsupported inspect implementations target language: ${candidate.path}`,
        target: request.target
      };
    }
    const absoluteTargetPath = resolve(repoRoot, candidate.path);
    if (!isSafeExistingFileInsideRepo(repoRoot, absoluteTargetPath)) {
      return {
        ok: false,
        category: "target_not_found",
        message: `Inspect implementations target file not found: ${candidate.path}`,
        target: request.target
      };
    }
    return { ok: true, path: candidate.path, candidate };
  }

  if (!request.target.path || !request.target.symbolName) {
    return {
      ok: false,
      category: "malformed_target",
      message: "opcore inspect implementations requires <file> <symbol>",
      target: request.target
    };
  }
  if (!isSupportedInspectImplementationSourcePath(request.target.path)) {
    return {
      ok: false,
      category: "unsupported_language",
      message: `Unsupported inspect implementations target language: ${request.target.path}`,
      target: request.target
    };
  }
  const absoluteTargetPath = resolve(repoRoot, request.target.path);
  if (!isSafeExistingFileInsideRepo(repoRoot, absoluteTargetPath)) {
    return {
      ok: false,
      category: "target_not_found",
      message: `Inspect implementations target file not found: ${request.target.path}`,
      target: request.target
    };
  }
  return { ok: true, path: request.target.path };
}

function resolveImplementationTargetInProject(
  project: Project,
  repoRoot: string,
  request: InspectImplementationRequest,
  nodeCandidate: InspectGraphCandidate | undefined
):
  | { ok: true; node: Node; candidate: InspectGraphCandidate; target: InspectSymbolTarget; targetSummary: InspectSymbolSummary }
  | { ok: false; category: InspectFailureCategory; message: string; target: InspectSymbolTarget; candidates?: readonly InspectSymbolTarget[] } {
  if (request.target.kind === "node") {
    if (!nodeCandidate) {
      return {
        ok: false,
        category: "target_not_found",
        message: `Inspect implementations target node not found in graph facts: ${request.target.nodeId ?? ""}`,
        target: request.target
      };
    }
    const node = declarationNameNodeForGraphCandidate(project, repoRoot, nodeCandidate);
    if (!node) {
      return {
        ok: false,
        category: "target_not_found",
        message: `Inspect implementations target node has no source declaration: ${nodeCandidate.id}`,
        target: request.target
      };
    }
    return { ok: true, node, candidate: nodeCandidate, target: request.target, targetSummary: inspectSymbolSummary(nodeCandidate) };
  }

  const path = request.target.path;
  const symbolName = request.target.symbolName;
  if (!path || !symbolName) {
    return {
      ok: false,
      category: "malformed_target",
      message: "opcore inspect implementations requires <file> <symbol>",
      target: request.target
    };
  }
  const absoluteTargetPath = resolve(repoRoot, path);
  const sourceFile = project.getSourceFile(absoluteTargetPath) ?? project.addSourceFileAtPath(absoluteTargetPath);
  const referenceRequest: InspectReferenceRequest = {
    path,
    symbolName,
    ...(request.target.line !== undefined ? { line: request.target.line } : {}),
    ...(request.target.column !== undefined ? { column: request.target.column } : {}),
    ...(request.allowGraphless ? { allowGraphless: true } : {}),
    graphNodeIds: request.graphCandidates.map((candidate) => candidate.id),
    graphCandidates: request.graphCandidates,
    limit: request.limit
  };
  const target = findReferenceTarget(repoRoot, sourceFile, referenceRequest);
  if (!target.ok) return target;
  const graphBinding = bindReferenceTargetToGraph(repoRoot, target.node, referenceRequest);
  if (!graphBinding.ok) {
    return {
      ok: false,
      category: "target_not_found",
      message: `Symbol "${symbolName}" in ${path}${request.target.line ? ` at line ${request.target.line}` : ""} is not backed by graph facts`,
      target: request.target,
      candidates: target.candidates
    };
  }
  return {
    ok: true,
    node: target.node,
    candidate: graphBinding.candidate,
    targetSummary: {
      ...inspectSymbolSummary(graphBinding.candidate),
      name: symbolName
    },
    target: {
      ...request.target,
      nodeId: graphBinding.candidate.id
    }
  };
}

interface ImplementationRelationship {
  candidateId: string;
  kind: InspectImplementationKind;
  graphNodeIds: readonly string[];
}

function collectImplementationRelationships(
  target: InspectGraphCandidate,
  candidates: readonly InspectGraphCandidate[],
  graphEdges: readonly GraphFactEdge[]
): readonly ImplementationRelationship[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const heritageEdges = graphEdges
    .filter((edge) => (edge.kind === "IMPLEMENTS" || edge.kind === "INHERITS") && candidateById.has(edge.from) && candidateById.has(edge.to))
    .sort(compareGraphEdges);
  const relationships = new Map<string, ImplementationRelationship>();
  for (const candidate of candidates) {
    if (candidate.id === target.id) continue;
    if (target.kind === "Class" && candidate.kind === "Class") {
      const path = findGraphPath(candidate.id, target.id, heritageEdges, new Set(["INHERITS"]));
      if (path) setImplementationRelationship(relationships, { candidateId: candidate.id, kind: "extends", graphNodeIds: path.nodeIds });
      continue;
    }
    if (target.kind !== "Type") continue;
    if (candidate.kind === "Type") {
      const path = findGraphPath(candidate.id, target.id, heritageEdges, new Set(["INHERITS"]));
      if (path) setImplementationRelationship(relationships, { candidateId: candidate.id, kind: "interface_extends", graphNodeIds: path.nodeIds });
      continue;
    }
    if (candidate.kind !== "Class") continue;
    const directImplements = heritageEdges.find((edge) => edge.kind === "IMPLEMENTS" && edge.from === candidate.id && edge.to === target.id);
    if (directImplements) {
      setImplementationRelationship(relationships, {
        candidateId: candidate.id,
        kind: "implements",
        graphNodeIds: [candidate.id, target.id]
      });
      continue;
    }
    const path = findGraphPath(candidate.id, target.id, heritageEdges, new Set(["IMPLEMENTS", "INHERITS"]));
    if (path && path.edgeKinds.includes("IMPLEMENTS")) {
      setImplementationRelationship(relationships, {
        candidateId: candidate.id,
        kind: "inherited_implements",
        graphNodeIds: path.nodeIds
      });
    }
  }
  return [...relationships.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

interface GraphlessImplementationContext {
  project: Project;
  repoRoot: string;
  targetCandidate: InspectGraphCandidate;
  targetSummary: InspectSymbolSummary;
  limit: number | undefined;
}

interface GraphlessHeritageContext {
  project: Project;
  repoRoot: string;
  targetId: string;
}

function collectGraphlessImplementationEntries(context: GraphlessImplementationContext): readonly InspectImplementationEntry[] {
  const entries = new Map<string, InspectImplementationEntry>();
  for (const declaration of graphlessImplementationDeclarations(context)) {
    const entry = graphlessImplementationEntry(context, declaration);
    if (entry) {
      entries.set(`${entry.symbol.id}:${entry.kind}`, entry);
    }
  }
  return applyImplementationLimit([...entries.values()].sort(compareImplementationEntries), context.limit);
}

function graphlessImplementationDeclarations(context: GraphlessImplementationContext): readonly Node[] {
  return context.project.getSourceFiles().flatMap((sourceFile) => {
    const absolutePath = resolve(sourceFile.getFilePath());
    const repoPath = normalizeModulePath(relative(context.repoRoot, absolutePath));
    if (!isSupportedInspectImplementationSourcePath(repoPath) || !isSafeExistingFileInsideRepo(context.repoRoot, absolutePath)) return [];
    return sourceFile.getDescendants().filter((node) => Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node));
  });
}

function graphlessImplementationEntry(context: GraphlessImplementationContext, declaration: Node): InspectImplementationEntry | undefined {
  const candidate = inferGraphCandidate(context.repoRoot, declaration);
  if (!candidate || !candidate.path || !candidate.name || candidate.id === context.targetCandidate.id) return undefined;
  if (!isSupportedInspectImplementationSourcePath(candidate.path)) return undefined;
  const kind = graphlessImplementationKind(context, declaration);
  if (!kind) return undefined;
  return implementationEntry(context.repoRoot, declaration, candidate, context.targetSummary, {
    candidateId: candidate.id,
    kind,
    graphNodeIds: [candidate.id, context.targetCandidate.id]
  });
}

function graphlessImplementationKind(
  context: GraphlessImplementationContext,
  implementationNode: Node,
): InspectImplementationKind | undefined {
  const declaration = implementationOwningDeclaration(implementationNode);
  const heritageContext = {
    project: context.project,
    repoRoot: context.repoRoot,
    targetId: context.targetCandidate.id
  };
  if (Node.isClassDeclaration(declaration)) {
    if (context.targetCandidate.kind === "Class" && classExtendsTarget(heritageContext, declaration, new Set())) {
      return "extends";
    }
    if (context.targetCandidate.kind === "Type") {
      if (classDirectlyImplementsTarget(context.project, context.repoRoot, declaration, context.targetCandidate.id)) return "implements";
      if (classImplementsTarget(heritageContext, declaration, new Set())) return "inherited_implements";
    }
  }
  if (context.targetCandidate.kind === "Type" && Node.isInterfaceDeclaration(declaration)) {
    if (interfaceExtendsTarget(heritageContext, declaration, new Set())) return "interface_extends";
  }
  return undefined;
}

function implementationOwningDeclaration(node: Node): Node {
  const nameNode = implementationNameNode(node);
  const parent = nameNode.getParent();
  if (parent && (Node.isClassDeclaration(parent) || Node.isInterfaceDeclaration(parent))) return parent;
  return nameNode;
}

function classDirectlyImplementsTarget(project: Project, repoRoot: string, declaration: ClassDeclaration, targetId: string): boolean {
  return declaration.getImplements().some((implementedType) => inferGraphNodeIds(repoRoot, implementedType).includes(targetId));
}

function classImplementsTarget(context: GraphlessHeritageContext, declaration: Node, visited: Set<string>): boolean {
  if (!Node.isClassDeclaration(declaration)) return false;
  if (!markVisited(context.repoRoot, declaration, visited)) return false;
  if (classImplementsInterfaceTarget(context, declaration, visited)) return true;
  return inheritedClassImplementsTarget(context, declaration, visited);
}

function classImplementsInterfaceTarget(context: GraphlessHeritageContext, declaration: ClassDeclaration, visited: Set<string>): boolean {
  return declaration.getImplements().some((implementedType) =>
    inferGraphNodeIds(context.repoRoot, implementedType).some((implementedId) => {
      if (implementedId === context.targetId) return true;
      const implementedDeclaration = declarationForGraphId(context.project, context.repoRoot, implementedId);
      return Node.isInterfaceDeclaration(implementedDeclaration) && interfaceExtendsTarget(context, implementedDeclaration, visited);
    })
  );
}

function inheritedClassImplementsTarget(context: GraphlessHeritageContext, declaration: ClassDeclaration, visited: Set<string>): boolean {
  const baseType = declaration.getExtends();
  if (!baseType) return false;
  return inferGraphNodeIds(context.repoRoot, baseType).some((baseId) => {
    const baseDeclaration = declarationForGraphId(context.project, context.repoRoot, baseId);
    return Node.isClassDeclaration(baseDeclaration) && classImplementsTarget(context, baseDeclaration, visited);
  });
}

function classExtendsTarget(context: GraphlessHeritageContext, declaration: Node, visited: Set<string>): boolean {
  if (!Node.isClassDeclaration(declaration)) return false;
  if (!markVisited(context.repoRoot, declaration, visited)) return false;
  const baseType = declaration.getExtends();
  if (!baseType) return false;
  const baseIds = inferGraphNodeIds(context.repoRoot, baseType);
  if (baseIds.includes(context.targetId)) return true;
  return baseIds.some((baseId) => {
    const baseDeclaration = declarationForGraphId(context.project, context.repoRoot, baseId);
    return Node.isClassDeclaration(baseDeclaration) && classExtendsTarget(context, baseDeclaration, visited);
  });
}

function interfaceExtendsTarget(context: GraphlessHeritageContext, declaration: InterfaceDeclaration, visited: Set<string>): boolean {
  if (!markVisited(context.repoRoot, declaration, visited)) return false;
  return declaration.getExtends().some((extendedType) =>
    inferGraphNodeIds(context.repoRoot, extendedType).some((extendedId) => {
      if (extendedId === context.targetId) return true;
      const extendedDeclaration = declarationForGraphId(context.project, context.repoRoot, extendedId);
      return Node.isInterfaceDeclaration(extendedDeclaration) && interfaceExtendsTarget(context, extendedDeclaration, visited);
    })
  );
}

function markVisited(repoRoot: string, declaration: Node, visited: Set<string>): boolean {
  const candidate = inferGraphCandidate(repoRoot, declaration);
  if (candidate) {
    if (visited.has(candidate.id)) return false;
    visited.add(candidate.id);
  }
  return true;
}

function setImplementationRelationship(
  relationships: Map<string, ImplementationRelationship>,
  relationship: ImplementationRelationship
): void {
  const current = relationships.get(relationship.candidateId);
  if (!current || implementationKindPriority(relationship.kind) > implementationKindPriority(current.kind)) {
    relationships.set(relationship.candidateId, relationship);
  }
}

function implementationKindPriority(kind: InspectImplementationKind): number {
  if (kind === "implements") return 4;
  if (kind === "extends") return 3;
  if (kind === "interface_extends") return 3;
  return 2;
}

function findGraphPath(
  sourceId: string,
  targetId: string,
  edges: readonly GraphFactEdge[],
  allowedKinds: ReadonlySet<string>
): { nodeIds: readonly string[]; edgeKinds: readonly string[] } | undefined {
  const queue: { id: string; nodeIds: string[]; edgeKinds: string[] }[] = [{ id: sourceId, nodeIds: [sourceId], edgeKinds: [] }];
  const visited = new Set([sourceId]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const edge of edges) {
      if (edge.from !== current.id || !allowedKinds.has(edge.kind)) continue;
      if (visited.has(edge.to)) continue;
      const nodeIds = [...current.nodeIds, edge.to];
      const edgeKinds = [...current.edgeKinds, edge.kind];
      if (edge.to === targetId) return { nodeIds, edgeKinds };
      visited.add(edge.to);
      queue.push({ id: edge.to, nodeIds, edgeKinds });
    }
  }
  return undefined;
}

function implementationLocationNodesByGraphId(project: Project, repoRoot: string, target: Node): Map<string, Node> {
  const nodes = new Map<string, Node>();
  for (const location of project.getLanguageService().getImplementations(target)) {
    const node = location.getNode();
    const graphNodeId = inferGraphNodeIds(repoRoot, node)[0];
    if (graphNodeId && !nodes.has(graphNodeId)) nodes.set(graphNodeId, node);
  }
  return nodes;
}

function implementationEntry(
  repoRoot: string,
  node: Node,
  candidate: InspectGraphCandidate,
  target: InspectSymbolSummary,
  relationship: ImplementationRelationship
): InspectImplementationEntry {
  const nameNode = implementationNameNode(node);
  const sourceFile = nameNode.getSourceFile();
  const absolutePath = resolve(sourceFile.getFilePath());
  const repoPath = normalizeModulePath(relative(repoRoot, absolutePath));
  const startOffset = nameNode.getStart();
  const endOffset = nameNode.getEnd();
  const start = sourceFile.getLineAndColumnAtPos(startOffset);
  const end = sourceFile.getLineAndColumnAtPos(endOffset);
  return {
    file: repoPath,
    line: start.line,
    column: start.column,
    text: nameNode.getText(),
    span: {
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      startOffset,
      endOffset
    },
    kind: relationship.kind,
    symbol: inspectSymbolSummary(candidate),
    target,
    isDeclaration: true,
    evidence: {
      graphNodeIds: uniqueGraphNodeIds(relationship.graphNodeIds),
      resolver: "language_service"
    }
  };
}

function implementationNameNode(node: Node): Node {
  if (Node.isIdentifier(node)) return node;
  if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node) || Node.isFunctionDeclaration(node)) {
    return node.getNameNode() ?? node;
  }
  if (Node.isVariableDeclaration(node)) return node.getNameNode();
  const parent = node.getParent();
  if (parent && (Node.isClassDeclaration(parent) || Node.isInterfaceDeclaration(parent) || Node.isTypeAliasDeclaration(parent) || Node.isFunctionDeclaration(parent))) {
    return parent.getNameNode() ?? node;
  }
  if (parent && Node.isVariableDeclaration(parent)) return parent.getNameNode();
  return node;
}

function declarationNameNodeForGraphCandidate(project: Project, repoRoot: string, candidate: InspectGraphCandidate): Node | undefined {
  if (!candidate.path) return undefined;
  const absolutePath = resolve(repoRoot, candidate.path);
  if (!isSafeExistingFileInsideRepo(repoRoot, absolutePath)) return undefined;
  const sourceFile = project.getSourceFile(absolutePath) ?? project.addSourceFileAtPath(absolutePath);
  for (const declaration of sourceFile.getDescendants()) {
    const fact = graphDeclarationFact(repoRoot, declaration);
    if (fact?.id === candidate.id) return implementationNameNode(declaration);
  }
  return undefined;
}

function inspectSymbolSummary(candidate: InspectGraphCandidate): InspectSymbolSummary {
  return {
    id: candidate.id,
    name: candidate.name ?? candidate.id,
    kind: candidate.kind
  };
}

function uniqueGraphNodeIds(nodeIds: readonly string[]): readonly string[] {
  return [...new Set(nodeIds)];
}

function applyImplementationLimit(entries: readonly InspectImplementationEntry[], limit: number | undefined): readonly InspectImplementationEntry[] {
  return limit === undefined ? entries : entries.slice(0, limit);
}

function compareImplementationEntries(left: InspectImplementationEntry, right: InspectImplementationEntry): number {
  return left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.symbol.name.localeCompare(right.symbol.name);
}

function compareGraphEdges(left: GraphFactEdge, right: GraphFactEdge): number {
  return left.from.localeCompare(right.from) || left.kind.localeCompare(right.kind) || left.to.localeCompare(right.to);
}

function findSignatureTarget(
  repoRoot: string,
  sourceFile: SourceFile,
  request: InspectSignatureRequest
):
  | { ok: true; node: Node; candidates: readonly InspectReferenceTarget[] }
  | { ok: false; category: InspectFailureCategory; message: string; target: InspectReferenceTarget; candidates?: readonly InspectReferenceTarget[] } {
  return findSymbolTarget(repoRoot, sourceFile, request, "signature");
}

function findReferenceTarget(
  repoRoot: string,
  sourceFile: SourceFile,
  request: InspectReferenceRequest
):
  | { ok: true; node: Node; candidates: readonly InspectReferenceTarget[] }
  | { ok: false; category: InspectFailureCategory; message: string; target: InspectReferenceTarget; candidates?: readonly InspectReferenceTarget[] } {
  return findSymbolTarget(repoRoot, sourceFile, request, "references");
}

function findSymbolTarget(
  repoRoot: string,
  sourceFile: SourceFile,
  request: InspectReferenceRequest,
  route: "references" | "signature"
):
  | { ok: true; node: Node; candidates: readonly InspectReferenceTarget[] }
  | { ok: false; category: InspectFailureCategory; message: string; target: InspectReferenceTarget; candidates?: readonly InspectReferenceTarget[] } {
  const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).filter((identifier) => {
    if (identifier.getText() !== request.symbolName) return false;
    const position = sourceFile.getLineAndColumnAtPos(identifier.getStart());
    if (request.line !== undefined && position.line !== request.line) return false;
    if (request.column !== undefined && !(position.column <= request.column && request.column <= position.column + request.symbolName.length - 1)) {
      return false;
    }
    return true;
  });
  if (identifiers.length === 0) {
    return {
      ok: false,
      category: "target_not_found",
      message: `Symbol "${request.symbolName}" not found for inspect ${route} in ${request.path}${request.line ? ` at line ${request.line}` : ""}`,
      target: targetFromRequest(request)
    };
  }

  const targetIdentifiers = request.graphTargetOnly
    ? identifiers.filter((identifier) => bindReferenceTargetToGraph(repoRoot, identifier, request).ok)
    : identifiers;
  if (targetIdentifiers.length === 0) {
    return {
      ok: false,
      category: "target_not_found",
      message: `Symbol "${request.symbolName}" not found for inspect ${route} in graph target ${request.graphNodeIds.join(", ")}`,
      target: targetFromRequest(request)
    };
  }

  const bySymbol = new Map<string, Node>();
  for (const identifier of targetIdentifiers) bySymbol.set(symbolIdentity(identifier), identifier);
  if (bySymbol.size > 1) {
    return {
      ok: false,
      category: "target_ambiguous",
      message: `Ambiguous inspect ${route} symbol target "${request.symbolName}" in ${request.path}`,
      target: targetFromRequest(request),
      candidates: [...bySymbol.values()].map((node) => candidateTarget(repoRoot, node, request))
    };
  }
  const node = [...bySymbol.values()][0];
  return { ok: true, node, candidates: [candidateTarget(repoRoot, node, request)] };
}

function collectSignatureEntries(repoRoot: string, declaration: Node, request: InspectSignatureRequest): InspectSignatureEntry[] {
  const entries: InspectSignatureEntry[] = [];
  const declarations = signatureDeclarationsForTarget(declaration);
  const overloadCount = declarations.filter((entry) => isFunctionLikeSignatureDeclaration(entry.declaration) && entry.overload).length;
  for (const entry of declarations) {
    const graphBinding = bindSignatureDeclarationToGraph(repoRoot, entry.declaration, request);
    if (!graphBinding.ok) continue;
    entries.push(signatureEntryForDeclaration(repoRoot, entry.declaration, {
      request,
      graphCandidate: graphBinding.candidate,
      overloadIndex: entry.overload ? entry.overloadIndex : undefined,
      includeOverloadIndex: overloadCount > 0
    }));
  }
  return entries.sort(compareSignatureEntries);
}

function signatureDeclarationsForTarget(declaration: Node): { declaration: Node; overload: boolean; overloadIndex?: number }[] {
  const resolved = symbolDeclaration(declaration.getSymbol()) ?? declaration;
  if (Node.isClassDeclaration(resolved)) {
    return [
      { declaration: resolved, overload: false },
      ...resolved.getConstructors().map((constructorDeclaration) => ({ declaration: constructorDeclaration, overload: false })),
      ...resolved.getMethods().map((methodDeclaration) => ({ declaration: methodDeclaration, overload: false }))
    ];
  }
  if (Node.isInterfaceDeclaration(resolved)) {
    return [
      { declaration: resolved, overload: false },
      ...resolved.getMembers().filter(Node.isMethodSignature).map((methodDeclaration) => ({ declaration: methodDeclaration, overload: false }))
    ];
  }
  if (Node.isFunctionDeclaration(resolved)) {
    const functionDeclarations = functionLikeSymbolDeclarations(resolved).filter(Node.isFunctionDeclaration);
    const overloads = functionDeclarations.filter((entry) => !entry.getBody());
    const selected = overloads.length > 0 ? overloads : functionDeclarations.filter((entry) => entry.getBody() || functionDeclarations.length === 1);
    return selected.map((entry, index) => ({
      declaration: entry,
      overload: overloads.length > 0,
      overloadIndex: overloads.length > 0 ? index : undefined
    }));
  }
  if (Node.isMethodDeclaration(resolved) || Node.isMethodSignature(resolved)) {
    const declarations = functionLikeSymbolDeclarations(resolved).filter((entry) => Node.isMethodDeclaration(entry) || Node.isMethodSignature(entry));
    const overloads = declarations.filter((entry) => Node.isMethodSignature(entry) || (Node.isMethodDeclaration(entry) && !entry.getBody()));
    const selected = overloads.length > 0 ? overloads : declarations;
    return selected.map((entry, index) => ({
      declaration: entry,
      overload: overloads.length > 0,
      overloadIndex: overloads.length > 0 ? index : undefined
    }));
  }
  if (Node.isConstructorDeclaration(resolved) || Node.isTypeAliasDeclaration(resolved) || Node.isVariableDeclaration(resolved)) {
    return [{ declaration: resolved, overload: false }];
  }
  return [];
}

function functionLikeSymbolDeclarations(declaration: Node): Node[] {
  const symbol = declaration.getSymbol();
  const resolved = symbol?.getAliasedSymbol() ?? symbol;
  return resolved?.getDeclarations() ?? [declaration];
}

function signatureEntryForDeclaration(
  repoRoot: string,
  declaration: Node,
  options: {
    request: InspectSignatureRequest;
    graphCandidate: InspectGraphCandidate;
    overloadIndex?: number;
    includeOverloadIndex: boolean;
  }
): InspectSignatureEntry {
  const sourceFile = declaration.getSourceFile();
  const repoPath = normalizeModulePath(relative(repoRoot, resolve(sourceFile.getFilePath())));
  const startOffset = declaration.getStart();
  const endOffset = declaration.getEnd();
  const start = sourceFile.getLineAndColumnAtPos(startOffset);
  const end = sourceFile.getLineAndColumnAtPos(endOffset);
  const kind = signatureKind(declaration);
  const parameters = signatureParameters(declaration);
  const typeParameters = signatureTypeParameters(declaration);
  const returnType = signatureReturnType(declaration);
  const signature = signatureText(declaration, {
    kind,
    parameters,
    typeParameters,
    returnType
  });
  return {
    file: repoPath,
    line: start.line,
    column: start.column,
    text: signature,
    signature,
    kind,
    parameters,
    typeParameters,
    exported: isExportedSignatureDeclaration(declaration),
    async: isAsyncSignatureDeclaration(declaration),
    ...(returnType ? { returnType } : {}),
    span: {
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      startOffset,
      endOffset
    },
    symbol: {
      id: options.graphCandidate.id,
      name: signatureSymbolName(declaration, options.request),
      kind: options.graphCandidate.kind
    },
    ...(options.includeOverloadIndex && options.overloadIndex !== undefined ? { overloadIndex: options.overloadIndex } : {}),
    evidence: {
      graphNodeIds: [options.graphCandidate.id],
      resolver: "language_service"
    }
  };
}

function signatureKind(declaration: Node): InspectSignatureKind {
  if (Node.isMethodDeclaration(declaration) || Node.isMethodSignature(declaration)) return "method";
  if (Node.isConstructorDeclaration(declaration)) return "constructor";
  if (Node.isInterfaceDeclaration(declaration)) return "interface";
  if (Node.isTypeAliasDeclaration(declaration)) return "type_alias";
  if (Node.isClassDeclaration(declaration)) return "class";
  if (Node.isVariableDeclaration(declaration)) return "variable_function";
  return "function";
}

function signatureParameters(declaration: Node): readonly InspectSignatureParameter[] {
  const parameters = getParameterDeclarations(declaration);
  return parameters.map((parameter) => {
    const initializer = parameter.getInitializer();
    return {
      name: parameter.getName(),
      type: parameter.getTypeNode()?.getText() ?? parameter.getType().getText(parameter),
      optional: parameter.isOptional() || initializer !== undefined,
      ...(parameter.isRestParameter() ? { rest: true } : {}),
      ...(initializer ? { defaultValue: initializer.getText() } : {})
    };
  });
}

function signatureTypeParameters(declaration: Node): readonly InspectSignatureTypeParameter[] {
  return getTypeParameterDeclarations(declaration).map((typeParameter) => ({
    name: typeParameter.getName(),
    ...(typeParameter.getConstraint() ? { constraint: typeParameter.getConstraint()?.getText() } : {}),
    ...(typeParameter.getDefault() ? { default: typeParameter.getDefault()?.getText() } : {})
  }));
}

function signatureReturnType(declaration: Node): string | undefined {
  if (Node.isConstructorDeclaration(declaration) || Node.isClassDeclaration(declaration) || Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration)) {
    return undefined;
  }
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer.getReturnTypeNode()?.getText() ?? initializer.getReturnType().getText(initializer);
    }
    return undefined;
  }
  if (hasReturnType(declaration)) return declaration.getReturnTypeNode()?.getText() ?? declaration.getReturnType().getText(declaration);
  return undefined;
}

function signatureText(
  declaration: Node,
  options: {
    kind: InspectSignatureKind;
    parameters: readonly InspectSignatureParameter[];
    typeParameters: readonly InspectSignatureTypeParameter[];
    returnType?: string;
  }
): string {
  if (Node.isClassDeclaration(declaration) || Node.isInterfaceDeclaration(declaration)) {
    return declaration.getText().split("{")[0].trim().replace(/\s+/g, " ");
  }
  if (Node.isTypeAliasDeclaration(declaration)) return declaration.getText().replace(/\s+/g, " ").trim();
  const name = signatureDeclarationName(declaration);
  const typeParameters = options.typeParameters.length > 0 ? `<${options.typeParameters.map(typeParameterText).join(", ")}>` : "";
  const parameters = `(${options.parameters.map(parameterText).join(", ")})`;
  if (options.kind === "constructor") return `constructor${parameters}`;
  const prefix = options.kind !== "method" && isAsyncSignatureDeclaration(declaration) ? "async " : "";
  const returnType = options.returnType ? `: ${options.returnType}` : "";
  return `${prefix}${name}${typeParameters}${parameters}${returnType}`;
}

function typeParameterText(typeParameter: InspectSignatureTypeParameter): string {
  return `${typeParameter.name}${typeParameter.constraint ? ` extends ${typeParameter.constraint}` : ""}${typeParameter.default ? ` = ${typeParameter.default}` : ""}`;
}

function parameterText(parameter: InspectSignatureParameter): string {
  return `${parameter.rest ? "..." : ""}${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type}${parameter.defaultValue ? ` = ${parameter.defaultValue}` : ""}`;
}

function signatureDeclarationName(declaration: Node): string {
  if (Node.isConstructorDeclaration(declaration)) return "constructor";
  if (Node.isVariableDeclaration(declaration)) return declaration.getName();
  if (hasNameDeclaration(declaration)) return declaration.getName() ?? "<anonymous>";
  return "<anonymous>";
}

function signatureSymbolName(declaration: Node, request: InspectSignatureRequest): string {
  if (Node.isConstructorDeclaration(declaration)) {
    const classDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    return classDeclaration?.getName() ?? request.graphSymbolName ?? request.symbolName;
  }
  if (Node.isMethodDeclaration(declaration) || Node.isMethodSignature(declaration)) return declaration.getName();
  return request.graphSymbolName ?? signatureDeclarationName(declaration);
}

function getParameterDeclarations(declaration: Node): readonly ParameterDeclaration[] {
  if (hasParameters(declaration)) return declaration.getParameters();
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (initializer && hasParameters(initializer)) return initializer.getParameters();
  }
  return [];
}

function getTypeParameterDeclarations(declaration: Node): readonly TypeParameterDeclaration[] {
  if (hasTypeParameters(declaration)) return declaration.getTypeParameters();
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (initializer && hasTypeParameters(initializer)) return initializer.getTypeParameters();
  }
  return [];
}

function isExportedSignatureDeclaration(declaration: Node): boolean {
  const owner = Node.isVariableDeclaration(declaration) ? declaration.getVariableStatement() : declaration;
  if (owner && hasIsExported(owner)) return owner.isExported();
  const classDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  if (classDeclaration) return classDeclaration.isExported();
  const interfaceDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.InterfaceDeclaration);
  if (interfaceDeclaration) return interfaceDeclaration.isExported();
  return false;
}

function isAsyncSignatureDeclaration(declaration: Node): boolean {
  if (hasIsAsync(declaration)) return declaration.isAsync();
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (initializer && hasIsAsync(initializer)) return initializer.isAsync();
  }
  return false;
}

function hasParameters(node: Node): node is Node & { getParameters(): ParameterDeclaration[] } {
  return "getParameters" in node && typeof (node as { getParameters?: unknown }).getParameters === "function";
}

function hasTypeParameters(node: Node): node is Node & { getTypeParameters(): TypeParameterDeclaration[] } {
  return "getTypeParameters" in node && typeof (node as { getTypeParameters?: unknown }).getTypeParameters === "function";
}

function hasReturnType(node: Node): node is Node & { getReturnTypeNode(): Node | undefined; getReturnType(): { getText(node?: Node): string } } {
  return "getReturnType" in node && typeof (node as { getReturnType?: unknown }).getReturnType === "function";
}

function hasNameDeclaration(node: Node): node is Node & { getName(): string | undefined } {
  return "getName" in node && typeof (node as { getName?: unknown }).getName === "function";
}

function hasIsExported(node: Node): node is Node & { isExported(): boolean } {
  return "isExported" in node && typeof (node as { isExported?: unknown }).isExported === "function";
}

function hasIsAsync(node: Node): node is Node & { isAsync(): boolean } {
  return "isAsync" in node && typeof (node as { isAsync?: unknown }).isAsync === "function";
}

function isFunctionLikeSignatureDeclaration(declaration: Node): boolean {
  return Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration) || Node.isMethodSignature(declaration);
}

function collectReferenceEntries(repoRoot: string, target: Node, request: InspectReferenceRequest): InspectReferenceEntry[] {
  const entries = new Map<string, InspectReferenceEntry>();
  for (const referencedSymbol of (target as ReferenceFindableNode).findReferences()) {
    for (const reference of referencedSymbol.getReferences()) {
      const node = reference.getNode();
      const sourceFile = reference.getSourceFile();
      const absolutePath = resolve(sourceFile.getFilePath());
      if (!isInside(repoRoot, absolutePath) || !isSupportedInspectSourcePath(absolutePath)) continue;
      const repoPath = normalizeModulePath(relative(repoRoot, absolutePath));
      if (!isSafeExistingFileInsideRepo(repoRoot, absolutePath)) continue;
      const span = reference.getTextSpan();
      const startOffset = span.getStart();
      const endOffset = span.getEnd();
      const start = sourceFile.getLineAndColumnAtPos(startOffset);
      const end = sourceFile.getLineAndColumnAtPos(endOffset);
      const isDefinition = reference.isDefinition() === true;
      const entry: InspectReferenceEntry = {
        file: repoPath,
        line: start.line,
        column: start.column,
        text: node.getText(),
        span: {
          startLine: start.line,
          startColumn: start.column,
          endLine: end.line,
          endColumn: end.column,
          startOffset,
          endOffset
        },
        symbol: {
          id: request.graphNodeIds[0] ?? inspectSymbolId(request),
          name: request.graphSymbolName ?? request.symbolName,
          ...(request.graphKind ? { kind: request.graphKind } : {})
        },
        isDefinition,
        isDeclaration: isDefinition,
        evidence: {
          graphNodeIds: request.graphNodeIds,
          resolver: "language_service"
        }
      };
      entries.set(`${entry.file}:${startOffset}:${endOffset}:${entry.isDefinition}`, entry);
    }
  }
  return [...entries.values()].sort(compareReferenceEntries);
}

function applyLimit(entries: readonly InspectReferenceEntry[], limit: number | undefined): readonly InspectReferenceEntry[] {
  return limit === undefined ? entries : entries.slice(0, limit);
}

type ProjectContext = {
  project: Project;
  tsconfigPath?: string;
  snapshotProject?: (project: Project) => unknown;
  revertProject?: (project: Project, snapshot: unknown) => void;
};

export function createInspectLanguageServiceProject(
  repoRoot: string,
  preferredRepoPath: string,
  options: InspectLanguageServiceOptions = {}
): Project {
  const preferredTsconfigPath = resolveInspectTsconfigPath(repoRoot, options.projectTsconfigPath) ?? tsconfigForInspectRoot(repoRoot);
  return createProjectForTsconfig(repoRoot, preferredTsconfigPath, preferredRepoPath, {
    includeDependents: options.includeDependents === true,
    scope: options.projectScope ?? "import_closure"
  });
}

function createProjectContexts(repoRoot: string, preferredRepoPath: string, options: InspectLanguageServiceOptions = {}): ProjectContext[] {
  const projectScope = options.projectScope ?? "import_closure";
  const preferredTsconfigPath = resolveInspectTsconfigPath(repoRoot, options.projectTsconfigPath) ?? tsconfigForInspectRoot(repoRoot);
  if (options.project !== undefined && canUseInjectedProject(options.project, projectScope)) {
    if (projectScope === "import_closure") {
      addScopedSourceFilesToProject(repoRoot, preferredTsconfigPath, options.project, [preferredRepoPath], {
        includeDependents: options.includeDependents === true
      });
    }
    return [
      {
        project: options.project,
        ...(options.projectTsconfigPath ? { tsconfigPath: options.projectTsconfigPath } : {}),
        ...(options.snapshotProject ? { snapshotProject: options.snapshotProject } : {}),
        ...(options.revertProject ? { revertProject: options.revertProject } : {})
      }
    ];
  }
  return [
    {
      project: createProjectForTsconfig(repoRoot, preferredTsconfigPath, preferredRepoPath, {
        includeDependents: options.includeDependents === true,
        scope: projectScope
      }),
      ...(preferredTsconfigPath ? { tsconfigPath: preferredTsconfigPath } : {})
    }
  ];
}

function canUseInjectedProject(project: Project, requiredScope: InspectLanguageServiceProjectScope): boolean {
  return requiredScope !== "whole_repo" || inspectProjectScopes.get(project) === "whole_repo";
}

function withProjectSnapshot<T>(context: ProjectContext, run: () => T): T {
  if (context.snapshotProject === undefined || context.revertProject === undefined) return run();
  const snapshot = context.snapshotProject(context.project);
  try {
    return run();
  } finally {
    context.revertProject(context.project, snapshot);
  }
}

function createProjectForTsconfig(
  repoRoot: string,
  tsconfigPath: string | undefined,
  preferredRepoPath: string,
  options: {
    includeDependents: boolean;
    scope: InspectLanguageServiceProjectScope;
  }
): Project {
  const projectOptions = {
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false
    }
  };
  const project = new Project(projectOptions);
  const sourceFiles = options.scope === "whole_repo"
    ? listSourceFiles(repoRoot)
    : scopedSourceFiles(repoRoot, tsconfigPath, [preferredRepoPath], { includeDependents: options.includeDependents });
  for (const filePath of sourceFiles) {
    if (project.getSourceFile(filePath)) continue;
    project.addSourceFileAtPath(filePath);
  }
  inspectProjectScopes.set(project, options.scope);
  return project;
}

function addScopedSourceFilesToProject(
  repoRoot: string,
  tsconfigPath: string | undefined,
  project: Project,
  rootRepoPaths: readonly string[],
  options: { includeDependents: boolean }
): void {
  for (const filePath of scopedSourceFiles(repoRoot, tsconfigPath, rootRepoPaths, options)) {
    if (project.getSourceFile(filePath) === undefined) project.addSourceFileAtPath(filePath);
  }
}

interface ImportResolutionOptions {
  baseUrl: string;
  hasBaseUrl: boolean;
  paths: Readonly<Record<string, readonly string[]>>;
}

type TsconfigJson = {
  compilerOptions?: {
    baseUrl?: unknown;
    paths?: unknown;
  };
};

const extensionlessCandidates = [".ts", ".tsx", ".js", ".jsx", ".d.ts"] as const;

function scopedSourceFiles(
  repoRoot: string,
  tsconfigPath: string | undefined,
  rootRepoPaths: readonly string[],
  options: { includeDependents: boolean }
): string[] {
  const importOptions = importResolutionOptions(repoRoot, tsconfigPath);
  const importTargetsByFile = new Map<string, readonly string[]>();
  const allSourceFiles = options.includeDependents ? listSourceFiles(repoRoot) : [];
  const roots = rootSourceFiles(repoRoot, rootRepoPaths);
  const reverseTargets = new Set(roots);
  const selected = new Set<string>();
  addForwardClosure(roots, selected);

  if (options.includeDependents) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const filePath of allSourceFiles) {
        if (selected.has(filePath)) continue;
        const importsReverseTarget = importTargets(filePath).some((importedPath) => reverseTargets.has(importedPath));
        if (!importsReverseTarget) continue;
        const beforeSize = selected.size;
        addForwardClosure([filePath], selected);
        reverseTargets.add(filePath);
        if (selected.size !== beforeSize) changed = true;
      }
    }
  }

  return [...selected].sort();

  function addForwardClosure(rootFiles: readonly string[], selectedFiles: Set<string>): void {
    const pending = [...rootFiles].sort();
    for (let index = 0; index < pending.length; index += 1) {
      const filePath = pending[index];
      if (selectedFiles.has(filePath)) continue;
      selectedFiles.add(filePath);
      for (const importedPath of importTargets(filePath)) {
        if (!selectedFiles.has(importedPath) && !pending.includes(importedPath)) pending.push(importedPath);
      }
    }
  }

  function importTargets(filePath: string): readonly string[] {
    const cached = importTargetsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const resolvedTargets = moduleImportSpecifiers(readFileSync(filePath, "utf8"))
      .flatMap((specifier) => {
        const resolvedImport = resolveImportSpecifier(repoRoot, filePath, specifier, importOptions);
        return resolvedImport === undefined ? [] : [resolvedImport];
      })
      .sort();
    importTargetsByFile.set(filePath, resolvedTargets);
    return resolvedTargets;
  }
}

function rootSourceFiles(repoRoot: string, rootRepoPaths: readonly string[]): string[] {
  return uniqueSorted(
    rootRepoPaths
      .map((path) => resolve(repoRoot, path))
      .filter((path) => isSupportedInspectSourcePath(path) && isSafeExistingFileInsideRepo(repoRoot, path))
  );
}

function moduleImportSpecifiers(text: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gu)) {
    if (match[1]) specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/<reference\s+path=["']([^"']+)["']/gu)) {
    if (match[1]) specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu)) {
    if (match[1]) specifiers.add(match[1]);
  }
  return [...specifiers].filter(isRepoResolvableSpecifier).sort();
}

function resolveImportSpecifier(
  repoRoot: string,
  fromPath: string,
  specifier: string,
  options: ImportResolutionOptions
): string | undefined {
  if (isRelativeSpecifier(specifier)) return resolveModulePathFromBase(repoRoot, resolve(dirname(fromPath), specifier));
  for (const [pattern, targets] of sortedPathMappings(options.paths)) {
    const wildcard = matchPathPattern(pattern, specifier);
    if (wildcard === undefined) continue;
    for (const target of targets) {
      const resolved = resolveModulePathFromBase(repoRoot, resolve(options.baseUrl, applyPathMappingTarget(target, wildcard)));
      if (resolved !== undefined) return resolved;
    }
  }
  return options.hasBaseUrl ? resolveModulePathFromBase(repoRoot, resolve(options.baseUrl, specifier)) : undefined;
}

function resolveModulePathFromBase(repoRoot: string, basePath: string): string | undefined {
  for (const candidate of modulePathCandidates(basePath)) {
    if (isSupportedInspectSourcePath(candidate) && isSafeExistingFileInsideRepo(repoRoot, candidate)) return resolve(candidate);
  }
  return undefined;
}

function modulePathCandidates(basePath: string): readonly string[] {
  const extension = sourceExtension(basePath);
  if (extension === ".js" || extension === ".jsx") {
    const candidates = extension === ".jsx"
      ? [replaceExtension(basePath, ".tsx"), replaceExtension(basePath, ".ts")]
      : [replaceExtension(basePath, ".ts"), replaceExtension(basePath, ".tsx")];
    return unique([...candidates, replaceExtension(basePath, ".d.ts"), basePath, replaceExtension(basePath, extension === ".js" ? ".jsx" : ".js")]);
  }
  if (extension !== undefined) return [basePath];
  return unique([
    ...extensionlessCandidates.map((candidateExtension) => `${basePath}${candidateExtension}`),
    ...extensionlessCandidates.map((candidateExtension) => join(basePath, `index${candidateExtension}`))
  ]);
}

function importResolutionOptions(repoRoot: string, tsconfigPath: string | undefined): ImportResolutionOptions {
  const configDirectory = tsconfigPath === undefined ? repoRoot : dirname(tsconfigPath);
  const config = tsconfigPath === undefined ? undefined : parseTsconfigForImports(tsconfigPath);
  const compilerOptions = config?.compilerOptions;
  const baseUrl = typeof compilerOptions?.baseUrl === "string" && compilerOptions.baseUrl.length > 0
    ? resolve(configDirectory, compilerOptions.baseUrl)
    : configDirectory;
  return {
    baseUrl,
    hasBaseUrl: typeof compilerOptions?.baseUrl === "string" && compilerOptions.baseUrl.length > 0,
    paths: normalizePathMappings(compilerOptions?.paths)
  };
}

function parseTsconfigForImports(tsconfigPath: string): TsconfigJson | undefined {
  try {
    const parsed = ts.parseConfigFileTextToJson(tsconfigPath, readFileSync(tsconfigPath, "utf8"));
    return parsed.error === undefined ? parsed.config as TsconfigJson : undefined;
  } catch {
    return undefined;
  }
}

function normalizePathMappings(paths: unknown): Readonly<Record<string, readonly string[]>> {
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) return {};
  const normalized: Record<string, readonly string[]> = {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (Array.isArray(targets)) normalized[pattern] = targets.filter((target): target is string => typeof target === "string");
  }
  return normalized;
}

function sortedPathMappings(paths: Readonly<Record<string, readonly string[]>>): readonly [string, readonly string[]][] {
  return Object.entries(paths)
    .filter((entry): entry is [string, readonly string[]] => entry[1].length > 0)
    .sort((left, right) => pathPatternRank(right[0]) - pathPatternRank(left[0]));
}

function pathPatternRank(pattern: string): number {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) return pattern.length * 2 + 1;
  return pattern.length - 1;
}

function matchPathPattern(pattern: string, specifier: string): string | undefined {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyPathMappingTarget(target: string, wildcard: string): string {
  return target.includes("*") ? target.replaceAll("*", wildcard) : target;
}

function tsconfigForInspectRoot(repoRoot: string): string | undefined {
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  return isSafeExistingFileInsideRepo(repoRoot, tsconfigPath) ? resolve(tsconfigPath) : undefined;
}

function resolveInspectTsconfigPath(repoRoot: string, tsconfigPath: string | undefined): string | undefined {
  if (tsconfigPath === undefined) return undefined;
  const absolutePath = resolve(repoRoot, tsconfigPath);
  return isSafeExistingFileInsideRepo(repoRoot, absolutePath) ? absolutePath : undefined;
}

function listSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  visit(repoRoot);
  return files.sort();

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(path);
      } else if (entry.isFile() && isSupportedInspectSourcePath(path) && isSafeExistingFileInsideRepo(repoRoot, path)) {
        files.push(resolve(path));
      }
    }
  }
}

function symbolIdentity(node: Node): string {
  const declaration = symbolDeclaration(node.getSymbol()) ?? node;
  return `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}:${declaration.getKindName()}`;
}

function symbolDeclaration(symbol: MorphSymbol | undefined): Node | undefined {
  const resolved = symbol?.getAliasedSymbol() ?? symbol;
  return resolved?.getValueDeclaration() ?? resolved?.getDeclarations()[0];
}

function candidateTarget(repoRoot: string, node: Node, request: InspectReferenceRequest): InspectReferenceTarget {
  const position = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
  const graphBinding = bindReferenceTargetToGraph(repoRoot, node, request);
  return {
    kind: "file_symbol",
    path: request.path,
    symbolName: request.symbolName,
    line: position.line,
    column: position.column,
    ...(graphBinding.ok ? { nodeId: graphBinding.candidate.id } : {})
  };
}

function bindReferenceTargetToGraph(
  repoRoot: string,
  node: Node,
  request: InspectReferenceRequest
): { ok: true; candidate: InspectGraphCandidate } | { ok: false; inferredNodeIds: readonly string[] } {
  return bindSignatureDeclarationToGraph(repoRoot, node, request);
}

function bindSignatureDeclarationToGraph(
  repoRoot: string,
  node: Node,
  request: InspectReferenceRequest
): { ok: true; candidate: InspectGraphCandidate } | { ok: false; inferredNodeIds: readonly string[] } {
  const candidates = graphCandidatesFromRequest(request);
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const inferredNodeIds = inferGraphNodeIds(repoRoot, node);
  for (const id of inferredNodeIds) {
    const candidate = candidateById.get(id);
    if (candidate) return { ok: true, candidate };
  }
  if (request.allowGraphless) {
    const inferredCandidate = inferGraphCandidate(repoRoot, node);
    if (inferredCandidate) return { ok: true, candidate: inferredCandidate };
  }
  return { ok: false, inferredNodeIds };
}

function graphCandidatesFromRequest(request: InspectReferenceRequest): readonly InspectGraphCandidate[] {
  if (request.graphCandidates && request.graphCandidates.length > 0) return request.graphCandidates;
  return request.graphNodeIds.map((id) => ({
    id,
    kind: request.graphKind ?? "symbol"
  }));
}

function inferGraphNodeIds(repoRoot: string, node: Node): readonly string[] {
  const candidate = inferGraphCandidate(repoRoot, node);
  return candidate ? [candidate.id] : [];
}

function inferGraphCandidate(repoRoot: string, node: Node): InspectGraphCandidate | undefined {
  const declaration = symbolDeclaration(node.getSymbol()) ?? symbolDeclaration(node.getType().getSymbol()) ?? node;
  return graphDeclarationFact(repoRoot, declaration);
}

function graphDeclarationFact(
  repoRoot: string,
  declaration: Node
): InspectGraphCandidate | undefined {
  const graphShape = graphDeclarationShape(declaration);
  if (!graphShape) return undefined;
  const path = graphDeclarationPath(repoRoot, declaration);
  if (!path) return undefined;
  return {
    id: `${graphShape.prefix}:${path}#${graphShape.name}`,
    kind: graphShape.kind,
    path,
    name: graphShape.name
  };
}

function graphDeclarationShape(
  declaration: Node
): { prefix: "class" | "function" | "type"; kind: GraphNodeKind; name: string } | undefined {
  if (Node.isConstructorDeclaration(declaration) || Node.isMethodDeclaration(declaration) || Node.isMethodSignature(declaration)) {
    const classDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    if (classDeclaration) return namedGraphShape("class", "Class", classDeclaration.getName());
    const interfaceDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.InterfaceDeclaration);
    if (interfaceDeclaration) return namedGraphShape("type", "Type", interfaceDeclaration.getName());
  }
  if (Node.isClassDeclaration(declaration)) return namedGraphShape("class", "Class", declaration.getName());
  if (Node.isFunctionDeclaration(declaration)) return namedGraphShape("function", "Function", declaration.getName());
  if (Node.isInterfaceDeclaration(declaration)) return namedGraphShape("type", "Type", declaration.getName());
  if (Node.isTypeAliasDeclaration(declaration)) return namedGraphShape("type", "Type", declaration.getName());
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) return undefined;
    return namedGraphShape("function", "Function", declaration.getName());
  }
  return undefined;
}

function namedGraphShape(
  prefix: "class" | "function" | "type",
  kind: GraphNodeKind,
  name: string | undefined
): { prefix: "class" | "function" | "type"; kind: GraphNodeKind; name: string } | undefined {
  return name ? { prefix, kind, name } : undefined;
}

function graphDeclarationPath(repoRoot: string, declaration: Node): string | undefined {
  const absolutePath = resolve(declaration.getSourceFile().getFilePath());
  if (!isInside(repoRoot, absolutePath)) return undefined;
  return normalizeModulePath(relative(repoRoot, absolutePath));
}

function targetFromRequest(request: InspectReferenceRequest): InspectReferenceTarget {
  return {
    kind: "file_symbol",
    path: request.path,
    symbolName: request.symbolName,
    ...(request.line !== undefined ? { line: request.line } : {}),
    ...(request.column !== undefined ? { column: request.column } : {})
  };
}

function inspectSymbolId(request: InspectReferenceRequest): string {
  return `symbol:${request.path}#${request.symbolName}`;
}

function declarationForGraphId(project: Project, repoRoot: string, graphId: string): Node | undefined {
  const path = graphPathFromNodeId(graphId);
  if (!path) return undefined;
  const absolutePath = resolve(repoRoot, path);
  if (!isSafeExistingFileInsideRepo(repoRoot, absolutePath)) return undefined;
  const sourceFile = project.getSourceFile(absolutePath) ?? project.addSourceFileAtPath(absolutePath);
  for (const declaration of sourceFile.getDescendants()) {
    if (graphDeclarationFact(repoRoot, declaration)?.id === graphId) return declaration;
  }
  return undefined;
}

function graphPathFromNodeId(nodeId: string): string | undefined {
  const afterKind = nodeId.split(":").slice(1).join(":");
  const path = afterKind.split("#")[0];
  return path || undefined;
}

function compareReferenceEntries(left: InspectReferenceEntry, right: InspectReferenceEntry): number {
  return left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || Number(right.isDefinition) - Number(left.isDefinition);
}

function compareSignatureEntries(left: InspectSignatureEntry, right: InspectSignatureEntry): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    (left.overloadIndex ?? -1) - (right.overloadIndex ?? -1) ||
    left.signature.localeCompare(right.signature)
  );
}

function isSafeExistingFileInsideRepo(repoRoot: string, absolutePath: string): boolean {
  if (!isInside(repoRoot, absolutePath) || !existsSync(absolutePath)) return false;
  try {
    return isInside(repoRoot, realpathSync(absolutePath)) && statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !/^[A-Za-z]:/.test(relativePath));
}

function normalizeModulePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isRepoResolvableSpecifier(specifier: string): boolean {
  return specifier.length > 0 && !specifier.startsWith("/") && !specifier.includes("://");
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function sourceExtension(path: string): string | undefined {
  if (path.endsWith(".d.ts")) return ".d.ts";
  const match = /\.[^./]+$/u.exec(path);
  return match?.[0];
}

function replaceExtension(path: string, extension: string): string {
  if (path.endsWith(".d.ts")) return `${path.slice(0, -".d.ts".length)}${extension}`;
  return path.replace(/\.[^./]+$/u, extension);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalRepoRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return resolve(repoRoot);
  }
}
