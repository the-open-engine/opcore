import type { ValidationCheckContext, ValidationGraphQueryRequirement } from "@the-open-engine/lattice-validation";
import type { GraphEdgeKind } from "@the-open-engine/lattice-contracts";
import { materializeTypeScriptSources, toFileNodeId } from "./source-files.js";

export async function importGraphRequirements(
  context: ValidationCheckContext
): Promise<readonly ValidationGraphQueryRequirement[]> {
  return edgeAndScopedFileRequirements(context, ["IMPORTS_FROM"]);
}

export async function deadCodeGraphRequirements(
  context: ValidationCheckContext
): Promise<readonly ValidationGraphQueryRequirement[]> {
  const sourceSet = await materializeTypeScriptSources(context);
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
        ids: sourceSet.rootPaths.map(toFileNodeId)
      }
    },
    {
      operation: "factQuery",
      selector: {
        kind: "symbols"
      }
    }
  ];
}

export async function relevantTestsGraphRequirements(
  context: ValidationCheckContext
): Promise<readonly ValidationGraphQueryRequirement[]> {
  return edgeAndScopedFileRequirements(context, ["TESTED_BY"]);
}

async function edgeAndScopedFileRequirements(
  context: ValidationCheckContext,
  edgeKinds: readonly GraphEdgeKind[]
): Promise<readonly ValidationGraphQueryRequirement[]> {
  const sourceSet = await materializeTypeScriptSources(context);
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
        ids: sourceSet.rootPaths.map(toFileNodeId)
      }
    }
  ];
}
