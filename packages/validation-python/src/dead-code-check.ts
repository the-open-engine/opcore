import type { GraphFactNode, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { GraphFactExportMetadata, ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import {
  graphFactBooleanAttribute,
  graphFactHasExportMetadata,
  graphFactHasIncomingTargetEdge,
  graphFactNodePath,
  graphFactUnsupportedExportLabels,
  graphFactUnsupportedFileExportMetadata
} from "@the-open-engine/opcore-validation";
import { PYTHON_DEAD_CODE_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { deadCodeGraphRequirements } from "./graph-requirements.js";
import { materializePythonSources } from "./source-files.js";

export function createDeadCodeCheck(): ValidationCheckDefinition {
  return {
    id: PYTHON_DEAD_CODE_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    requiresGraph: true,
    graphRequirements: deadCodeGraphRequirements,
    run: async (context) => {
      const sourceSet = await materializePythonSources(context);
      const [symbolFacts, calls, fileNodes] = await Promise.all([
        context.graph.facts({ kind: "symbols" }),
        context.graph.calls(),
        context.graph.fileNodes(sourceSet.rootPaths)
      ]);
      const scopedPaths = new Set(sourceSet.rootPaths);
      const scopedSymbols = symbolFacts.nodes.filter((node) => isScopedSymbol(node, scopedPaths));
      const unsupportedFileExports = fileNodes.flatMap(graphFactUnsupportedFileExportMetadata);
      if (!scopedSymbols.some(graphFactHasExportMetadata) && unsupportedFileExports.length === 0) {
        return {
          diagnostics: [
            {
              category: "graph",
              severity: "info",
              code: "PY_DEAD_CODE_UNSUPPORTED",
              message: "Graph facts do not include Python export metadata required for dead-code validation."
            }
          ]
        };
      }

      const exportedSymbols = scopedSymbols.filter(isExportedSymbol);
      const callCoveredExports = exportedSymbols.filter(hasCallUsageCoverage);
      const unsupportedExports = exportedSymbols.filter((node) => !hasCallUsageCoverage(node));
      if (
        callCoveredExports.length > 0 &&
        context.graphStatus.state === "available" &&
        context.graphStatus.handshake !== undefined &&
        !context.graphStatus.handshake.edgeKinds.includes("CALLS")
      ) {
        return {
          diagnostics: [
            {
              category: "graph",
              severity: "info",
              code: "PY_DEAD_CODE_UNSUPPORTED",
              message: "Graph provider capability handshake does not include CALLS edge coverage required for Python dead-code validation."
            }
          ]
        };
      }

      const incomingCalls = new Set(calls.map((edge) => edge.to));
      const diagnostics: ValidationDiagnostic[] = [];
      if (unsupportedFileExports.length > 0) {
        diagnostics.push(unsupportedFileExportMetadataDiagnostic(unsupportedFileExports));
      }
      if (unsupportedExports.length > 0) {
        diagnostics.push(unsupportedExportUsageDiagnostic(unsupportedExports));
      }
      diagnostics.push(
        ...callCoveredExports
          .filter((node) => !graphFactHasIncomingTargetEdge(node, calls, incomingCalls))
          .map((node): ValidationDiagnostic => ({
            category: "graph",
            severity: "warning",
            path: graphFactNodePath(node),
            code: "PY_DEAD_CODE_UNUSED_EXPORT",
            message: `Exported Python symbol has no incoming CALLS graph evidence: ${node.name ?? node.id}`
          }))
      );
      return { diagnostics };
    }
  };
}

function isExportedSymbol(node: GraphFactNode): boolean {
  if (node.kind === "File" || node.kind === "file" || node.kind === "Module") return false;
  return graphFactBooleanAttribute(node, ["exported", "isExported", "public"]);
}

function hasCallUsageCoverage(node: GraphFactNode): boolean {
  return node.kind === "Function" || node.kind === "Class";
}

function unsupportedExportUsageDiagnostic(nodes: readonly GraphFactNode[]): ValidationDiagnostic {
  const kinds = [...new Set(nodes.map((node) => node.kind))].sort().join(", ");
  return {
    category: "graph",
    severity: "info",
    code: "PY_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include exported Python ${kinds} symbols, but dead-code validation only has CALLS usage coverage for Function/Class exports.`
  };
}

function unsupportedFileExportMetadataDiagnostic(exports: readonly GraphFactExportMetadata[]): ValidationDiagnostic {
  const labels = graphFactUnsupportedExportLabels(exports);
  return {
    category: "graph",
    severity: "info",
    code: "PY_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include unsupported Python export metadata without resolved symbols: ${labels}.`
  };
}

function isScopedSymbol(node: GraphFactNode, scopedPaths: ReadonlySet<string>): boolean {
  const filePath = graphFactNodePath(node);
  return filePath !== undefined && scopedPaths.has(filePath);
}
