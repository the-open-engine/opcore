import type { GraphFactEdge, GraphFactNode, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import { graphFactNodePath } from "@the-open-engine/opcore-validation";
import type { TypeScriptRelativeImport } from "./source-files.js";

export interface CompilerImportEvidence {
  readonly edges: readonly GraphFactEdge[];
  readonly missingGraphTargets: ReadonlySet<string>;
}

export function compilerImportEvidence(
  compilerImports: readonly TypeScriptRelativeImport[],
  graphImports: readonly GraphFactEdge[],
  nodes: readonly GraphFactNode[]
): CompilerImportEvidence {
  const aliasesByPath = fileAliasesByPath(nodes);
  const edges = compilerImports.map(
    (entry): GraphFactEdge => ({
      kind: "IMPORTS_FROM",
      from: `file:${entry.fromPath}`,
      to: `file:${entry.resolvedPath}`
    })
  );
  const missingGraphTargets = new Set(
    compilerImports
      .filter((entry) => !hasImportEdge(entry.fromPath, entry.resolvedPath, graphImports, aliasesByPath))
      .map((entry) => entry.resolvedPath)
  );
  return { edges, missingGraphTargets };
}

export function missingImportEvidenceDiagnostic(paths: ReadonlySet<string>): ValidationDiagnostic {
  const labels = [...paths].sort().slice(0, 5).join(", ");
  return {
    category: "graph",
    severity: "info",
    code: "TS_DEAD_CODE_UNSUPPORTED",
    message: `Compiler-resolved imports are missing from graph IMPORTS_FROM evidence; dead-export findings are suppressed for affected targets: ${labels}.`
  };
}

export function nodeHasPath(node: GraphFactNode, paths: ReadonlySet<string>): boolean {
  const path = graphFactNodePath(node);
  return path !== undefined && paths.has(path);
}

function hasImportEdge(
  fromPath: string,
  toPath: string,
  edges: readonly GraphFactEdge[],
  aliasesByPath: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  const fromAliases = aliasesByPath.get(fromPath) ?? new Set([fromPath, `file:${fromPath}`]);
  const toAliases = aliasesByPath.get(toPath) ?? new Set([toPath, `file:${toPath}`]);
  return edges.some((edge) => fromAliases.has(edge.from) && toAliases.has(edge.to));
}

function fileAliasesByPath(nodes: readonly GraphFactNode[]): ReadonlyMap<string, ReadonlySet<string>> {
  const aliases = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.kind !== "File" && node.kind !== "file") continue;
    const path = graphFactNodePath(node);
    if (path === undefined) continue;
    const pathAliases = aliases.get(path) ?? new Set<string>([path, `file:${path}`]);
    pathAliases.add(node.id);
    aliases.set(path, pathAliases);
  }
  return aliases;
}
