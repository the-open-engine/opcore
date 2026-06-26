import type { GraphFactEdge, ValidationDiagnostic } from "@the-open-engine/lattice-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/lattice-validation";
import { TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { relevantTestsGraphRequirements } from "./graph-requirements.js";
import { materializeTypeScriptSources, toFileNodeId } from "./source-files.js";

export function createRelevantTestsCheck(): ValidationCheckDefinition {
  return {
    id: TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
    owner: typeScriptCheckOwner,
    adapter: typeScriptCheckAdapter,
    defaultSeverity: "info",
    supportedScopes: supportedTypeScriptValidationScopes,
    requiresGraph: true,
    graphRequirements: relevantTestsGraphRequirements,
    run: async (context) => {
      const [sourceSet, testedBy] = await Promise.all([materializeTypeScriptSources(context), context.graph.testedBy()]);
      const diagnostics = sourceSet.rootPaths.map((path): ValidationDiagnostic => {
        const evidence = testedBy.filter((edge) => edgeReferencesFile(edge, path));
        if (evidence.length > 0) {
          return {
            category: "test",
            severity: "info",
            path,
            code: "TS_RELEVANT_TESTS_FOUND",
            message: `TESTED_BY graph evidence exists for ${path}: ${evidence.map(testEndpoint).sort().join(", ")}`
          };
        }
        return {
          category: "test",
          severity: "info",
          path,
          code: "TS_RELEVANT_TESTS_ABSENT",
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
  const match = /^[^:]+:([^#]+)(?:#.*)?$/.exec(endpoint);
  return match?.[1];
}
