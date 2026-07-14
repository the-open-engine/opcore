import type { GraphEdgeKind, GraphFactEdge, GraphFactNode, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { GraphFactExportMetadata } from "@the-open-engine/opcore-validation";
import {
  graphFactBooleanAttribute,
  graphFactHasIncomingTargetEdge,
  graphFactNodePath,
  graphFactSymbolAliasSet,
  graphFactUnsupportedExportLabels
} from "@the-open-engine/opcore-validation";

const typeReferenceEdgeKinds = ["INHERITS", "IMPLEMENTS"] as const satisfies readonly GraphEdgeKind[];

export interface UnusedSourceFileEvidence {
  readonly fileNodes: readonly GraphFactNode[];
  readonly scopedPaths: ReadonlySet<string>;
  readonly contains: readonly GraphFactEdge[];
  readonly importsFrom: readonly GraphFactEdge[];
  readonly filePathsWithUnsupportedExportMetadata: ReadonlySet<string>;
  readonly reachableFileAliases: ReadonlySet<string>;
}

export interface TypeExportReferenceEvidence {
  readonly nodes: readonly GraphFactNode[];
  readonly typeReferences: readonly GraphFactEdge[];
  readonly incomingTypeReferences: ReadonlySet<string>;
  readonly importsFrom: readonly GraphFactEdge[];
  readonly fileReachabilitySupported: boolean;
  readonly typeReferenceSupported: boolean;
}

export interface PartitionedTypeExports {
  readonly unused: readonly GraphFactNode[];
  readonly unsupported: readonly GraphFactNode[];
}

export function isExportedSymbol(node: GraphFactNode): boolean {
  if (node.kind === "File" || node.kind === "file") return false;
  return graphFactBooleanAttribute(node, ["exported", "isExported", "export", "public"]);
}

export function hasCallUsageCoverage(node: GraphFactNode): boolean {
  return node.kind === "Function" || node.kind === "Class";
}

export function hasTypeUsageCoverage(node: GraphFactNode): boolean {
  return node.kind === "Type" || node.kind === "TypeAlias" || node.kind === "Interface";
}

export function unsupportedExportUsageDiagnostic(nodes: readonly GraphFactNode[]): ValidationDiagnostic {
  const kinds = [...new Set(nodes.map((node) => node.kind))].sort().join(", ");
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include exported ${kinds} symbols, but TypeScript dead-code validation only has CALLS usage coverage for Function/Class exports.`
  };
}

export function unsupportedFileReachabilityDiagnostic(): ValidationDiagnostic {
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: "Graph provider capability handshake does not include CONTAINS and IMPORTS_FROM coverage required for TypeScript unused-file validation."
  };
}

export function unsupportedTypeReferenceDiagnostic(nodes: readonly GraphFactNode[]): ValidationDiagnostic {
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include exported Type symbols in referenced files without symbol-level type reference evidence: ${symbolLabels(nodes)}.`
  };
}

export function unsupportedFileExportMetadataDiagnostic(
  exports: readonly GraphFactExportMetadata[]
): ValidationDiagnostic {
  const labels = graphFactUnsupportedExportLabels(exports);
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include unsupported TypeScript export metadata without resolved symbols: ${labels}.`
  };
}

export function unusedSourceFiles(evidence: UnusedSourceFileEvidence): readonly GraphFactNode[] {
  return evidence.fileNodes
    .filter((node) => isUnusedSourceFile(node, evidence))
    .sort((left, right) => (graphFactNodePath(left) ?? left.id).localeCompare(graphFactNodePath(right) ?? right.id));
}

function isUnusedSourceFile(node: GraphFactNode, evidence: UnusedSourceFileEvidence): boolean {
  const path = graphFactNodePath(node);
  if (path === undefined || !evidence.scopedPaths.has(path)) return false;
  if (hasReachableFile(path, node, evidence.reachableFileAliases)) return false;
  if (evidence.filePathsWithUnsupportedExportMetadata.has(path)) return false;
  if (!hasFileContainsEdge(path, node, evidence.contains)) return false;
  return !hasIncomingFileImport(path, node, evidence.importsFrom);
}

export function unusedFileDiagnostic(node: GraphFactNode): ValidationDiagnostic {
  const path = graphFactNodePath(node) ?? node.path ?? node.id;
  return {
    category: "graph",
    severity: "warning",
    path,
    code: "TS_DEAD_CODE_UNUSED_FILE",
    message: `Source file has no incoming IMPORTS_FROM graph evidence: ${path}`
  };
}

export function partitionTypeExportsByReferenceSupport(
  evidence: TypeExportReferenceEvidence
): PartitionedTypeExports {
  const unused: GraphFactNode[] = [];
  const unsupported: GraphFactNode[] = [];
  for (const node of evidence.nodes) {
    if (hasIncomingTypeReference(node, evidence.typeReferences, evidence.incomingTypeReferences)) continue;
    const path = graphFactNodePath(node);
    if (path !== undefined && evidence.fileReachabilitySupported && !hasIncomingFileImport(path, undefined, evidence.importsFrom)) {
      unused.push(node);
      continue;
    }
    if (!evidence.typeReferenceSupported || path !== undefined) unsupported.push(node);
  }
  return { unused: unused.sort(compareSymbols), unsupported: unsupported.sort(compareSymbols) };
}

export function unusedTypeExportDiagnostic(node: GraphFactNode): ValidationDiagnostic {
  return {
    category: "graph",
    severity: "warning",
    path: graphFactNodePath(node),
    code: "TS_DEAD_CODE_UNUSED_EXPORT",
    message: `Exported type has no incoming graph reference evidence: ${node.name ?? node.id}`
  };
}

export function isScopedSymbol(node: GraphFactNode, scopedPaths: ReadonlySet<string>): boolean {
  const filePath = graphFactNodePath(node);
  return filePath !== undefined && scopedPaths.has(filePath);
}

export function hasReachableSymbol(node: GraphFactNode, reachableSymbolAliases: ReadonlySet<string>): boolean {
  for (const alias of graphFactSymbolAliasSet(node)) {
    if (reachableSymbolAliases.has(alias)) return true;
  }
  return false;
}

export function isTypeReferenceEdge(edge: GraphFactEdge): boolean {
  return (typeReferenceEdgeKinds as readonly string[]).includes(edge.kind);
}

export function supportsAllEdgeKinds(
  handshakeEdgeKinds: readonly string[] | undefined,
  edgeKinds: readonly GraphEdgeKind[]
): boolean {
  if (handshakeEdgeKinds === undefined) return true;
  return edgeKinds.every((edgeKind) => handshakeEdgeKinds.includes(edgeKind));
}

export function supportsAnyEdgeKind(
  handshakeEdgeKinds: readonly string[] | undefined,
  edgeKinds: readonly GraphEdgeKind[]
): boolean {
  if (handshakeEdgeKinds === undefined) return true;
  return edgeKinds.some((edgeKind) => handshakeEdgeKinds.includes(edgeKind));
}

function hasFileContainsEdge(path: string, node: GraphFactNode, contains: readonly GraphFactEdge[]): boolean {
  const aliases = fileAliases(path, node);
  return contains.some((edge) => aliases.has(edge.from));
}

function hasIncomingFileImport(path: string, node: GraphFactNode | undefined, importsFrom: readonly GraphFactEdge[]): boolean {
  const aliases = fileAliases(path, node);
  return importsFrom.some((edge) => aliases.has(edge.to));
}

function fileAliases(path: string, node: GraphFactNode | undefined): ReadonlySet<string> {
  const aliases = new Set([path, `file:${path}`]);
  if (node !== undefined) aliases.add(node.id);
  return aliases;
}

function hasReachableFile(path: string, node: GraphFactNode, reachableFileAliases: ReadonlySet<string>): boolean {
  for (const alias of fileAliases(path, node)) {
    if (reachableFileAliases.has(alias)) return true;
  }
  return false;
}

function hasIncomingTypeReference(
  node: GraphFactNode,
  typeReferences: readonly GraphFactEdge[],
  incomingTypeReferences: ReadonlySet<string>
): boolean {
  return graphFactHasIncomingTargetEdge(node, typeReferences, incomingTypeReferences);
}

function symbolLabels(nodes: readonly GraphFactNode[]): string {
  return nodes.map((node) => node.name ?? node.id).slice(0, 5).join(", ");
}

function compareSymbols(left: GraphFactNode, right: GraphFactNode): number {
  const leftLabel = `${graphFactNodePath(left) ?? ""}\0${left.name ?? left.id}`;
  const rightLabel = `${graphFactNodePath(right) ?? ""}\0${right.name ?? right.id}`;
  return leftLabel.localeCompare(rightLabel);
}
