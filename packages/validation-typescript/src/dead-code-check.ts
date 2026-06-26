import type { GraphFactEdge, GraphFactNode, JsonValue, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { TYPE_SCRIPT_DEAD_CODE_CHECK_ID } from "./check-ids.js";
import { typeScriptCheckAdapter, typeScriptCheckOwner, supportedTypeScriptValidationScopes } from "./check-constants.js";
import { deadCodeGraphRequirements } from "./graph-requirements.js";
import { materializeTypeScriptSources } from "./source-files.js";

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
      const [symbolFacts, calls, fileNodes] = await Promise.all([
        context.graph.facts({ kind: "symbols" }),
        context.graph.calls(),
        context.graph.fileNodes(sourceSet.rootPaths)
      ]);
      const scopedPaths = new Set(sourceSet.rootPaths);
      const scopedSymbols = symbolFacts.nodes.filter((node) => isScopedSymbol(node, scopedPaths));
      const unsupportedFileExports = fileNodes.flatMap(unsupportedFileExportMetadata);
      if (!scopedSymbols.some(hasExportMetadata) && unsupportedFileExports.length === 0) {
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
              code: "TS_DEAD_CODE_UNSUPPORTED",
              message: "Graph provider capability handshake does not include CALLS edge coverage required for TypeScript dead-code validation."
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
          .filter((node) => !hasIncomingCall(node, calls, incomingCalls))
          .map((node): ValidationDiagnostic => ({
            category: "graph",
            severity: "warning",
            path: symbolFilePath(node),
            code: "TS_DEAD_CODE_UNUSED_EXPORT",
            message: `Exported symbol has no incoming CALLS graph evidence: ${node.name ?? node.id}`
          }))
      );
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

function unsupportedExportUsageDiagnostic(nodes: readonly GraphFactNode[]): ValidationDiagnostic {
  const kinds = [...new Set(nodes.map((node) => node.kind))].sort().join(", ");
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: `Graph facts include exported ${kinds} symbols, but TypeScript dead-code validation only has CALLS usage coverage for Function/Class exports.`
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

function symbolAliases(node: GraphFactNode): ReadonlySet<string> {
  const aliases = new Set([node.id]);
  const stableId = stringAttribute(node, ["symbolId", "stableId", "qualifiedName"]);
  if (stableId !== undefined) aliases.add(stableId);
  return aliases;
}

function symbolFilePath(node: GraphFactNode): string | undefined {
  if (node.path !== undefined) return node.path;
  const path = stringAttribute(node, ["path", "file", "filePath", "sourcePath"]);
  if (path !== undefined) return path;
  const match = /^[^:]+:([^#]+)(?:#.*)?$/.exec(node.id);
  return match?.[1];
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
