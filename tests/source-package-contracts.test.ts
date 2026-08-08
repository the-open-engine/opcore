import { commandRouterManifest } from "@the-open-engine/opcore-contracts";
import { createEditCommandAdapter } from "@the-open-engine/opcore-edit";
import { createEphemeralGraphSnapshot } from "@the-open-engine/opcore-graph";
import { createDocsValidationChecks } from "@the-open-engine/opcore-validation-docs";
import { createTypeScriptValidationChecks } from "@the-open-engine/opcore-validation-typescript";
import { routeOpcoreCommand } from "opcore";

assertRuntimeExport("commandRouterManifest", commandRouterManifest, "object");
assertRuntimeExport("createEditCommandAdapter", createEditCommandAdapter, "function");
assertRuntimeExport("createEphemeralGraphSnapshot", createEphemeralGraphSnapshot, "function");
assertRuntimeExport("createDocsValidationChecks", createDocsValidationChecks, "function");
assertRuntimeExport("createTypeScriptValidationChecks", createTypeScriptValidationChecks, "function");
assertRuntimeExport("routeOpcoreCommand", routeOpcoreCommand, "function");

function assertRuntimeExport(name: string, value: unknown, expectedType: "function" | "object"): void {
  if (typeof value !== expectedType) {
    throw new Error(`${name} must be a runtime ${expectedType} export`);
  }
}
