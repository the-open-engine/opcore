import type { GraphEdgeKind, GraphFactNode, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import {
  graphFactHasExportMetadata,
  graphFactHasIncomingTargetEdge,
  graphFactNodePath,
  graphFactUnsupportedFileExportMetadata
} from "@the-open-engine/opcore-validation";
import {
  hasCallUsageCoverage,
  hasReachableSymbol,
  hasTypeUsageCoverage,
  isExportedSymbol,
  isScopedSymbol,
  isTypeReferenceEdge,
  partitionTypeExportsByReferenceSupport,
  supportsAllEdgeKinds,
  supportsAnyEdgeKind,
  unsupportedExportUsageDiagnostic,
  unsupportedFileExportMetadataDiagnostic,
  unsupportedFileReachabilityDiagnostic,
  unsupportedTypeReferenceDiagnostic,
  unusedFileDiagnostic,
  unusedSourceFiles,
  unusedTypeExportDiagnostic
} from "./dead-code-analysis.js";
import { deadCodeEntrypointReachability, type TypeScriptDeadCodeOptions } from "./dead-code-entrypoints.js";
import {
  compilerImportEvidence,
  missingImportEvidenceDiagnostic,
  nodeHasPath
} from "./dead-code-import-evidence.js";
import { discoverTypeScriptDeadCodeRoots } from "./dead-code-roots.js";
import { materializeTypeScriptSources } from "./source-files.js";

const callEdgeKinds = ["CALLS"] as const satisfies readonly GraphEdgeKind[];
const fileReachabilityEdgeKinds = ["CONTAINS", "IMPORTS_FROM"] as const satisfies readonly GraphEdgeKind[];
const typeReferenceEdgeKinds = ["INHERITS", "IMPLEMENTS"] as const satisfies readonly GraphEdgeKind[];
export const deadCodeEdgeKinds = [
  ...callEdgeKinds,
  ...fileReachabilityEdgeKinds,
  ...typeReferenceEdgeKinds
] as const satisfies readonly GraphEdgeKind[];

export async function runTypeScriptDeadCodeCheck(
  context: ValidationCheckContext,
  options: TypeScriptDeadCodeOptions
): Promise<ValidationCheckResult> {
  const state = await loadDeadCodeState(context, options);
  return unsupportedCoverageResult(state) ?? { diagnostics: deadCodeDiagnostics(state) };
}

async function loadDeadCodeState(context: ValidationCheckContext, options: TypeScriptDeadCodeOptions) {
  const sourceSet = await materializeTypeScriptSources(context);
  const [symbolFacts, edges, fileNodes] = await Promise.all([
    context.graph.facts({ kind: "symbols" }),
    context.graph.edgesByKind(deadCodeEdgeKinds),
    context.graph.fileNodes(sourceSet.rootPaths)
  ]);
  const calls = edges.filter((edge) => edge.kind === "CALLS");
  const contains = edges.filter((edge) => edge.kind === "CONTAINS");
  const graphImports = edges.filter((edge) => edge.kind === "IMPORTS_FROM");
  const typeReferences = edges.filter(isTypeReferenceEdge);
  const scopedPaths = new Set(sourceSet.rootPaths);
  const scopedSymbols = symbolFacts.nodes.filter((node) => isScopedSymbol(node, scopedPaths));
  const allNodes = [...symbolFacts.nodes, ...fileNodes];
  const compilerImports = compilerImportEvidence(sourceSet.relativeImports, graphImports, allNodes);
  const importsFrom = [...graphImports, ...compilerImports.edges];
  const effectiveEdges = [...edges, ...compilerImports.edges];
  const automaticRoots = await discoverTypeScriptDeadCodeRoots(context, options, sourceSet, allNodes);
  const reachability = deadCodeEntrypointReachability(options, allNodes, effectiveEdges, automaticRoots);
  const unsupportedFileExports = fileNodes.flatMap(graphFactUnsupportedFileExportMetadata);
  const unsupportedFilePaths = new Set(
    fileNodes
      .filter((node) => graphFactUnsupportedFileExportMetadata(node).length > 0)
      .map(graphFactNodePath)
      .filter(isDefined)
  );
  const handshakeEdgeKinds = context.graphStatus.state === "available" ? context.graphStatus.handshake?.edgeKinds : undefined;
  const fileReachabilitySupported = supportsAllEdgeKinds(handshakeEdgeKinds, fileReachabilityEdgeKinds);
  const callUsageSupported = supportsAllEdgeKinds(handshakeEdgeKinds, callEdgeKinds);
  const typeReferenceSupported = supportsAnyEdgeKind(handshakeEdgeKinds, typeReferenceEdgeKinds);
  const unusedFiles = fileReachabilitySupported
    ? unusedSourceFiles({
        fileNodes,
        scopedPaths,
        contains,
        importsFrom,
        filePathsWithUnsupportedExportMetadata: unsupportedFilePaths,
        reachableFileAliases: reachability.reachableFileAliases
      })
    : [];
  return {
    calls,
    fileNodes,
    importsFrom,
    scopedSymbols,
    typeReferences,
    reachability,
    unsupportedFileExports,
    missingGraphImportTargets: compilerImports.missingGraphTargets,
    fileReachabilitySupported,
    callUsageSupported,
    typeReferenceSupported,
    unusedFiles
  };
}

type DeadCodeState = Awaited<ReturnType<typeof loadDeadCodeState>>;

function unsupportedCoverageResult(state: DeadCodeState): ValidationCheckResult | undefined {
  const lacksExportEvidence =
    !state.scopedSymbols.some(graphFactHasExportMetadata) &&
    state.unsupportedFileExports.length === 0 &&
    state.unusedFiles.length === 0;
  if (lacksExportEvidence) return unsupportedResult("Graph facts do not include exported symbol metadata required for TypeScript dead-code validation.");
  const uncoveredCallable = state.scopedSymbols
    .filter(isExportedSymbol)
    .filter(hasCallUsageCoverage)
    .some(
      (node) =>
        !hasReachableSymbol(node, state.reachability.reachableSymbolAliases) &&
        !nodeHasPath(node, state.missingGraphImportTargets)
    );
  if (uncoveredCallable && !state.callUsageSupported) {
    return unsupportedResult("Graph provider capability handshake does not include CALLS edge coverage required for TypeScript dead-code validation.");
  }
  return undefined;
}

function deadCodeDiagnostics(state: DeadCodeState): readonly ValidationDiagnostic[] {
  const exportedSymbols = state.scopedSymbols.filter(isExportedSymbol);
  const callCoveredExports = exportedSymbols.filter(hasCallUsageCoverage);
  const typeCoveredExports = exportedSymbols.filter(hasTypeUsageCoverage);
  const unsupportedExports = exportedSymbols.filter(
    (node) =>
      !hasCallUsageCoverage(node) &&
      !hasTypeUsageCoverage(node) &&
      !hasReachableSymbol(node, state.reachability.reachableSymbolAliases)
  );
  const typeExports = partitionTypeExportsByReferenceSupport({
    nodes: typeCoveredExports.filter((node) => !nodeHasPath(node, state.missingGraphImportTargets)),
    typeReferences: state.typeReferences,
    incomingTypeReferences: new Set(state.typeReferences.map((edge) => edge.to)),
    importsFrom: state.importsFrom,
    fileReachabilitySupported: state.fileReachabilitySupported,
    typeReferenceSupported: state.typeReferenceSupported
  });
  const diagnostics: ValidationDiagnostic[] = [];
  if (state.unsupportedFileExports.length > 0) diagnostics.push(unsupportedFileExportMetadataDiagnostic(state.unsupportedFileExports));
  if (unsupportedExports.length > 0) diagnostics.push(unsupportedExportUsageDiagnostic(unsupportedExports));
  if (state.missingGraphImportTargets.size > 0) diagnostics.push(missingImportEvidenceDiagnostic(state.missingGraphImportTargets));
  if (!state.fileReachabilitySupported && state.fileNodes.length > 0) diagnostics.push(unsupportedFileReachabilityDiagnostic());
  if (typeExports.unsupported.length > 0) diagnostics.push(unsupportedTypeReferenceDiagnostic(typeExports.unsupported));
  diagnostics.push(...state.unusedFiles.map(unusedFileDiagnostic));
  diagnostics.push(...unusedCallableDiagnostics(callCoveredExports, state));
  diagnostics.push(
    ...typeExports.unused
      .filter((node) => !hasReachableSymbol(node, state.reachability.reachableSymbolAliases))
      .map(unusedTypeExportDiagnostic)
  );
  return diagnostics;
}

function unusedCallableDiagnostics(
  nodes: readonly GraphFactNode[],
  state: DeadCodeState
): readonly ValidationDiagnostic[] {
  const incomingCalls = new Set(state.calls.map((edge) => edge.to));
  return nodes
    .filter(() => state.callUsageSupported)
    .filter((node) => !hasReachableSymbol(node, state.reachability.reachableSymbolAliases))
    .filter((node) => !nodeHasPath(node, state.missingGraphImportTargets))
    .filter((node) => !graphFactHasIncomingTargetEdge(node, state.calls, incomingCalls))
    .map((node) => ({
      category: "graph",
      severity: "warning",
      path: graphFactNodePath(node),
      code: "TS_DEAD_CODE_UNUSED_EXPORT",
      message: `Exported symbol has no incoming CALLS graph evidence: ${node.name ?? node.id}`
    }));
}

function unsupportedResult(message: string): ValidationCheckResult {
  return { diagnostics: [{ category: "graph", severity: "info", code: "TS_DEAD_CODE_UNSUPPORTED", message }] };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
