import type { GraphFactEdge, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { PYTHON_RELEVANT_TESTS_CHECK_ID } from "./check-ids.js";
import { pythonCheckAdapter, pythonCheckOwner, supportedPythonValidationScopes } from "./check-constants.js";
import { createRelevantTestsGraphRequirements } from "./graph-requirements.js";
import { toFileNodeId, type PythonSourceRootResolver } from "./source-files.js";

export function createRelevantTestsCheck(resolveRoots: PythonSourceRootResolver): ValidationCheckDefinition {
  return {
    id: PYTHON_RELEVANT_TESTS_CHECK_ID,
    owner: pythonCheckOwner,
    adapter: pythonCheckAdapter,
    defaultSeverity: "info",
    supportedScopes: supportedPythonValidationScopes,
    requiresGraph: true,
    graphRequirements: createRelevantTestsGraphRequirements(resolveRoots),
    run: async (context) => {
      const [rootPaths, testedBy] = await Promise.all([resolveRoots(context), context.graph.testedBy()]);
      const diagnostics = rootPaths.map((path): ValidationDiagnostic => {
        const evidence = testedBy.filter((edge) => edgeReferencesFile(edge, path));
        if (evidence.length > 0) {
          return {
            category: "test",
            severity: "info",
            path,
            code: "PY_RELEVANT_TESTS_FOUND",
            message: `TESTED_BY graph evidence exists for ${path}: ${evidence.map(testEndpoint).sort().join(", ")}`
          };
        }
        return {
          category: "test",
          severity: "info",
          path,
          code: "PY_RELEVANT_TESTS_ABSENT",
          message: `No TESTED_BY graph evidence found for ${path}.`
        };
      });
      return { diagnostics };
    }
  };
}

function edgeReferencesFile(edge: GraphFactEdge, path: string): boolean {
  return endpointReferencesFile(edge.from, path) || endpointReferencesFile(edge.to, path);
}

function testEndpoint(edge: GraphFactEdge): string {
  return endpointFilePath(edge.to) ?? edge.to;
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
