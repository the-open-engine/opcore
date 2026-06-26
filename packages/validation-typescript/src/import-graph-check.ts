import type { GraphFactEdge, ValidationDiagnostic } from "@the-open-engine/lattice-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/lattice-validation";
import { TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { importGraphRequirements } from "./graph-requirements.js";
import { materializeTypeScriptSources, toFileNodeId } from "./source-files.js";

export function createImportGraphCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: true,
    graphRequirements: importGraphRequirements,
    run: async (context) => {
      const [sourceSet, edges] = await Promise.all([materializeTypeScriptSources(context), context.graph.importsFrom()]);
      const diagnostics = sourceSet.relativeImports
        .filter((relativeImport) => !edges.some((edge) => matchesDirectedFileEdge(edge, relativeImport.fromPath, relativeImport.resolvedPath)))
        .map((relativeImport): ValidationDiagnostic => ({
          category: "graph",
          severity: "warning",
          path: relativeImport.fromPath,
          code: "TS_IMPORT_GRAPH_MISSING_EDGE",
          message: `Missing IMPORTS_FROM graph edge for ${relativeImport.fromPath} -> ${relativeImport.resolvedPath}`
        }));
      return { diagnostics };
    }
  };
}

function matchesDirectedFileEdge(edge: GraphFactEdge, fromPath: string, toPath: string): boolean {
  return endpointAliases(fromPath).has(edge.from) && endpointAliases(toPath).has(edge.to);
}

function endpointAliases(path: string): ReadonlySet<string> {
  return new Set([path, toFileNodeId(path)]);
}
