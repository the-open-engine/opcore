import type { GraphEdgeKind, GraphFactEdge, GraphFactNode, JsonValue, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { TYPE_SCRIPT_DEAD_CODE_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { deadCodeGraphRequirements } from "./graph-requirements.js";
import { materializeTypeScriptSources } from "./source-files.js";

const callEdgeKinds = ["CALLS"] as const satisfies readonly GraphEdgeKind[];
const fileReachabilityEdgeKinds = ["CONTAINS", "IMPORTS_FROM"] as const satisfies readonly GraphEdgeKind[];
const typeReferenceEdgeKinds = ["INHERITS", "IMPLEMENTS"] as const satisfies readonly GraphEdgeKind[];
const deadCodeEdgeKinds = [...callEdgeKinds, ...fileReachabilityEdgeKinds, ...typeReferenceEdgeKinds] as const satisfies readonly GraphEdgeKind[];

export function createDeadCodeCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: true,
    graphRequirements: deadCodeGraphRequirements,
    run: async (context) => {
      const sourceSet = await materializeTypeScriptSources(context);
      const [symbolFacts, edges, fileNodes] = await Promise.all([
        context.graph.facts({ kind: "symbols" }),
        context.graph.edgesByKind(deadCodeEdgeKinds),
        context.graph.fileNodes(sourceSet.rootPaths)
      ]);
      const calls = edges.filter((edge) => edge.kind === "CALLS");
      const contains = edges.filter((edge) => edge.kind === "CONTAINS");
      const importsFrom = edges.filter((edge) => edge.kind === "IMPORTS_FROM");
      const typeReferences = edges.filter((edge) => isTypeReferenceEdge(edge));
      const scopedPaths = new Set(sourceSet.rootPaths);
      const scopedSymbols = symbolFacts.nodes.filter((node) => isScopedSymbol(node, scopedPaths));
      const unsupportedFileExports = fileNodes.flatMap(unsupportedFileExportMetadata);
      const filePathsWithUnsupportedExportMetadata = new Set(
        fileNodes
          .filter((node) => unsupportedFileExportMetadata(node).length > 0)
          .map(fileNodePath)
          .filter(isDefined)
      );
      const handshakeEdgeKinds = context.graphStatus.state === "available" ? context.graphStatus.handshake?.edgeKinds : undefined;
      const fileReachabilitySupported = supportsAllEdgeKinds(handshakeEdgeKinds, fileReachabilityEdgeKinds);
      const callUsageSupported = supportsAllEdgeKinds(handshakeEdgeKinds, callEdgeKinds);
      const typeReferenceSupported = supportsAnyEdgeKind(handshakeEdgeKinds, typeReferenceEdgeKinds);
      const unusedFiles = fileReachabilitySupported
        ? unusedSourceFiles(fileNodes, scopedPaths, contains, importsFrom, filePathsWithUnsupportedExportMetadata)
        : [];
      if (!scopedSymbols.some(hasExportMetadata) && unsupportedFileExports.length === 0 && unusedFiles.length === 0) {
        return {
          diagnostics: [
            {
              category: "graph",
              severity: "info",
              code: "TS_DEAD_CODE_UNSUPPORTED",
              message: "Graph facts do not include exported symbol metadata required for TypeScript dead-code validation."
            }
          ]
        };
      }

      const exportedSymbols = scopedSymbols.filter(isExportedSymbol);
      const callCoveredExports = exportedSymbols.filter(hasCallUsageCoverage);
      const typeCoveredExports = exportedSymbols.filter(hasTypeUsageCoverage);
      const unsupportedExports = exportedSymbols.filter((node) => !hasCallUsageCoverage(node) && !hasTypeUsageCoverage(node));
      if (
        callCoveredExports.length > 0 &&
        !callUsageSupported
      ) {
        return {
          diagnostics: [
            {
              category: "graph",
              severity: "info",
              code: "TS_DEAD_CODE_UNSUPPORTED",
              message: "Graph provider capability handshake does not include CALLS edge coverage required for TypeScript dead-code validation."
            }
          ]
        };
      }

      const incomingCalls = new Set(calls.map((edge) => edge.to));
      const incomingTypeReferences = new Set(typeReferences.map((edge) => edge.to));
      const diagnostics: ValidationDiagnostic[] = [];
      if (unsupportedFileExports.length > 0) {
        diagnostics.push(unsupportedFileExportMetadataDiagnostic(unsupportedFileExports));
      }
      if (unsupportedExports.length > 0) {
        diagnostics.push(unsupportedExportUsageDiagnostic(unsupportedExports));
      }
      if (!fileReachabilitySupported && fileNodes.length > 0) {
        diagnostics.push(unsupportedFileReachabilityDiagnostic());
      }
      const typeExportsBySupport = partitionTypeExportsByReferenceSupport(
        typeCoveredExports,
        typeReferences,
        incomingTypeReferences,
        importsFrom,
        fileReachabilitySupported,
        typeReferenceSupported
      );
      if (typeExportsBySupport.unsupported.length > 0) {
        diagnostics.push(unsupportedTypeReferenceDiagnostic(typeExportsBySupport.unsupported));
      }
      diagnostics.push(...unusedFiles.map(unusedFileDiagnostic));
      diagnostics.push(
        ...callCoveredExports
          .filter(() => callUsageSupported)
          .filter((node) => !hasIncomingCall(node, calls, incomingCalls))
          .map((node): ValidationDiagnostic => ({
            category: "graph",
            severity: "warning",
            path: symbolFilePath(node),
            code: "TS_DEAD_CODE_UNUSED_EXPORT",
            message: `Exported symbol has no incoming CALLS graph evidence: ${node.name ?? node.id}`
          }))
      );
      diagnostics.push(...typeExportsBySupport.unused.map(unusedTypeExportDiagnostic));
      return { diagnostics };
    }
  };
}

function hasIncomingCall(node: GraphFactNode, calls: readonly GraphFactEdge[], incomingCalls: ReadonlySet<string>): boolean {
  if (incomingCalls.has(node.id)) return true;
  const aliases = symbolAliases(node);
  return calls.some((edge) => aliases.has(edge.to));
}

function isExportedSymbol(node: GraphFactNode): boolean {
  if (node.kind === "File" || node.kind === "file") return false;
  return booleanAttribute(node, ["exported", "isExported", "export", "public"]);
}

function hasCallUsageCoverage(node: GraphFactNode): boolean {
  return node.kind === "Function" || node.kind === "Class";
}

function hasTypeUsageCoverage(node: GraphFactNode): boolean {
  return node.kind === "Type" || node.kind === "TypeAlias" || node.kind === "Interface";
}

function unsupportedExportUsageDiagnostic(nodes: readonly GraphFactNode[]): ValidationDiagnostic {
  const kinds = [...new Set(nodes.map((node) => node.kind))].sort().join(", ");
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include exported ${kinds} symbols, but TypeScript dead-code validation only has CALLS usage coverage for Function/Class exports.`
  };
}

function unsupportedFileReachabilityDiagnostic(): ValidationDiagnostic {
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: "Graph provider capability handshake does not include CONTAINS and IMPORTS_FROM coverage required for TypeScript unused-file validation."
  };
}

function unsupportedTypeReferenceDiagnostic(nodes: readonly GraphFactNode[]): ValidationDiagnostic {
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include exported Type symbols in referenced files without symbol-level type reference evidence: ${symbolLabels(nodes)}.`
  };
}

function unsupportedFileExportMetadataDiagnostic(exports: readonly FileExportMetadata[]): ValidationDiagnostic {
  const labels = exports
    .map((entry) => stringMetadata(entry, "exported") ?? stringMetadata(entry, "local") ?? stringMetadata(entry, "kind") ?? "unknown")
    .slice(0, 5)
    .join(", ");
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include unsupported TypeScript export metadata without resolved symbols: ${labels}.`
  };
}

function hasExportMetadata(node: GraphFactNode): boolean {
  return typeof node.attributes?.exported === "boolean";
}

function unusedSourceFiles(
  fileNodes: readonly GraphFactNode[],
  scopedPaths: ReadonlySet<string>,
  contains: readonly GraphFactEdge[],
  importsFrom: readonly GraphFactEdge[],
  filePathsWithUnsupportedExportMetadata: ReadonlySet<string>
): readonly GraphFactNode[] {
  return fileNodes
    .filter((node) => {
      const path = fileNodePath(node);
      if (path === undefined || !scopedPaths.has(path)) return false;
      if (filePathsWithUnsupportedExportMetadata.has(path)) return false;
      if (!hasFileContainsEdge(path, node, contains)) return false;
      if (hasIncomingFileImport(path, node, importsFrom)) return false;
      return true;
    })
    .sort((left, right) => (fileNodePath(left) ?? left.id).localeCompare(fileNodePath(right) ?? right.id));
}

function unusedFileDiagnostic(node: GraphFactNode): ValidationDiagnostic {
  const path = fileNodePath(node) ?? node.path ?? node.id;
  return {
    category: "graph",
    severity: "warning",
    path,
    code: "TS_DEAD_CODE_UNUSED_FILE",
    message: `Source file has no incoming IMPORTS_FROM graph evidence: ${path}`
  };
}

interface PartitionedTypeExports {
  unused: readonly GraphFactNode[];
  unsupported: readonly GraphFactNode[];
}

function partitionTypeExportsByReferenceSupport(
  nodes: readonly GraphFactNode[],
  typeReferences: readonly GraphFactEdge[],
  incomingTypeReferences: ReadonlySet<string>,
  importsFrom: readonly GraphFactEdge[],
  fileReachabilitySupported: boolean,
  typeReferenceSupported: boolean
): PartitionedTypeExports {
  const unused: GraphFactNode[] = [];
  const unsupported: GraphFactNode[] = [];
  for (const node of nodes) {
    if (hasIncomingTypeReference(node, typeReferences, incomingTypeReferences)) continue;
    const path = symbolFilePath(node);
    if (path !== undefined && fileReachabilitySupported && !hasIncomingFileImport(path, undefined, importsFrom)) {
      unused.push(node);
      continue;
    }
    if (!typeReferenceSupported || path !== undefined) unsupported.push(node);
  }
  return {
    unused: unused.sort(compareSymbols),
    unsupported: unsupported.sort(compareSymbols)
  };
}

function unusedTypeExportDiagnostic(node: GraphFactNode): ValidationDiagnostic {
  return {
    category: "graph",
    severity: "warning",
    path: symbolFilePath(node),
    code: "TS_DEAD_CODE_UNUSED_EXPORT",
    message: `Exported type has no incoming graph reference evidence: ${node.name ?? node.id}`
  };
}

type FileExportMetadata = { [key: string]: JsonValue };

function unsupportedFileExportMetadata(node: GraphFactNode): readonly FileExportMetadata[] {
  const exports = node.attributes?.exports;
  if (!Array.isArray(exports)) return [];
  return exports.filter(isUnsupportedFileExportMetadata);
}

function isUnsupportedFileExportMetadata(value: JsonValue): value is FileExportMetadata {
  if (!isJsonObject(value)) return false;
  return value.supportedSymbol === false;
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMetadata(metadata: FileExportMetadata, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isScopedSymbol(node: GraphFactNode, scopedPaths: ReadonlySet<string>): boolean {
  const filePath = symbolFilePath(node);
  return filePath !== undefined && scopedPaths.has(filePath);
}

function fileNodePath(node: GraphFactNode): string | undefined {
  return node.path ?? stringAttribute(node, ["path", "file", "filePath", "sourcePath"]);
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

function symbolAliases(node: GraphFactNode): ReadonlySet<string> {
  const aliases = new Set([node.id]);
  const stableId = stringAttribute(node, ["symbolId", "stableId", "qualifiedName"]);
  if (stableId !== undefined) aliases.add(stableId);
  return aliases;
}

function hasIncomingTypeReference(
  node: GraphFactNode,
  typeReferences: readonly GraphFactEdge[],
  incomingTypeReferences: ReadonlySet<string>
): boolean {
  if (incomingTypeReferences.has(node.id)) return true;
  const aliases = symbolAliases(node);
  return typeReferences.some((edge) => aliases.has(edge.to));
}

function isTypeReferenceEdge(edge: GraphFactEdge): boolean {
  return (typeReferenceEdgeKinds as readonly string[]).includes(edge.kind);
}

function symbolFilePath(node: GraphFactNode): string | undefined {
  if (node.path !== undefined) return node.path;
  const path = stringAttribute(node, ["path", "file", "filePath", "sourcePath"]);
  if (path !== undefined) return path;
  const match = /^[^:]+:([^#]+)(?:#.*)?$/.exec(node.id);
  return match?.[1];
}

function supportsAllEdgeKinds(handshakeEdgeKinds: readonly string[] | undefined, edgeKinds: readonly GraphEdgeKind[]): boolean {
  if (handshakeEdgeKinds === undefined) return true;
  return edgeKinds.every((edgeKind) => handshakeEdgeKinds.includes(edgeKind));
}

function supportsAnyEdgeKind(handshakeEdgeKinds: readonly string[] | undefined, edgeKinds: readonly GraphEdgeKind[]): boolean {
  if (handshakeEdgeKinds === undefined) return true;
  return edgeKinds.some((edgeKind) => handshakeEdgeKinds.includes(edgeKind));
}

function symbolLabels(nodes: readonly GraphFactNode[]): string {
  return nodes
    .map((node) => node.name ?? node.id)
    .slice(0, 5)
    .join(", ");
}

function compareSymbols(left: GraphFactNode, right: GraphFactNode): number {
  return `${symbolFilePath(left) ?? ""}\0${left.name ?? left.id}`.localeCompare(`${symbolFilePath(right) ?? ""}\0${right.name ?? right.id}`);
}

function booleanAttribute(node: GraphFactNode, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = node.attributes?.[key];
    if (value === true || value === "true") return true;
  }
  return false;
}

function stringAttribute(node: GraphFactNode, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = node.attributes?.[key];
    if (isStringValue(value)) return value;
  }
  return undefined;
}

function isStringValue(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
