import type { GraphEdgeKind } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationGraphQueryRequirement } from "@the-open-engine/opcore-validation";
import { toFileNodeId, type PythonSourceRootResolver, type PythonSourceSetResolver } from "./source-files.js";

export function createImportGraphRequirements(resolveSources: PythonSourceSetResolver) {
  return async (context: ValidationCheckContext): Promise<readonly ValidationGraphQueryRequirement[]> =>
    edgeAndScopedFileRequirements(context, ["IMPORTS_FROM"], (await resolveSources(context)).rootPaths);
}

export function createDeadCodeGraphRequirements(resolveRoots: PythonSourceRootResolver) {
  return async (context: ValidationCheckContext): Promise<readonly ValidationGraphQueryRequirement[]> => {
    const rootPaths = await resolveRoots(context);
    return [
      {
        operation: "factQuery",
        selector: {
          kind: "edges",
          edgeKinds: ["CALLS"]
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "nodes",
          nodeKinds: ["File", "file"],
          ids: rootPaths.map(toFileNodeId)
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "symbols"
        }
      }
    ];
  };
}

export function createRelevantTestsGraphRequirements(resolveRoots: PythonSourceRootResolver) {
  return async (context: ValidationCheckContext): Promise<readonly ValidationGraphQueryRequirement[]> =>
    edgeAndScopedFileRequirements(context, ["TESTED_BY"], await resolveRoots(context));
}

async function edgeAndScopedFileRequirements(
  context: ValidationCheckContext,
  edgeKinds: readonly GraphEdgeKind[],
  rootPaths: readonly string[]
): Promise<readonly ValidationGraphQueryRequirement[]> {
  return [
    {
      operation: "factQuery",
      selector: {
        kind: "edges",
        edgeKinds
      }
    },
    {
      operation: "factQuery",
      selector: {
        kind: "nodes",
        nodeKinds: ["File", "file"],
        ids: rootPaths.map(toFileNodeId)
      }
    }
  ];
}
