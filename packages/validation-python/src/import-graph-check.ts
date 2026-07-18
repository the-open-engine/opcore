import type { GraphFactEdge, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_IMPORT_GRAPH_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { createImportGraphRequirements } from "./graph-requirements.js";
import { toFileNodeId, type PythonSourceSetResolver } from "./source-files.js";

export function createImportGraphCheck(resolveSources: PythonSourceSetResolver): ValidationCheckDefinition {
  return {
    id: PYTHON_IMPORT_GRAPH_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "warning",
    supportedScopes: supportedPythonValidationScopes,
    requiresGraph: true,
    graphRequirements: createImportGraphRequirements(resolveSources),
    run: async (context) => {
      const [sourceSet, edges] = await Promise.all([resolveSources(context), context.graph.importsFrom()]);
      const diagnostics = sourceSet.repoImports
        .filter((repoImport) => !edges.some((edge) => matchesDirectedFileEdge(edge, repoImport.fromPath, repoImport.toPath)))
        .map((repoImport): ValidationDiagnostic => ({
          category: "graph",
          severity: "warning",
          path: repoImport.fromPath,
          code: "PY_IMPORT_GRAPH_MISSING_EDGE",
          message: `Missing IMPORTS_FROM graph edge for ${repoImport.fromPath} -> ${repoImport.toPath}`
        }));
      return { diagnostics };
    }
  };
}

function matchesDirectedFileEdge(edge: GraphFactEdge, fromPath: string, toPath: string): boolean {
  return endpointReferencesFile(edge.from, fromPath) && endpointReferencesFile(edge.to, toPath);
}

function endpointAliases(path: string): ReadonlySet<string> {
  return new Set([path, toFileNodeId(path)]);
}

function endpointReferencesFile(endpoint: string, path: string): boolean {
  const aliases = endpointAliases(path);
  if (aliases.has(endpoint)) return true;
  const endpointPath = endpointFilePath(endpoint);
  return endpointPath !== undefined && aliases.has(endpointPath);
}

function endpointFilePath(endpoint: string): string | undefined {
  const match = /^[^:]+:([^#]+)(?:#.*)?$/u.exec(endpoint);
  return match?.[1];
}
