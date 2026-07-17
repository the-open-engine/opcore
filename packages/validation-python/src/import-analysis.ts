import { normalizeValidationFileViewPath } from "@the-open-engine/opcore-validation";

export interface PythonImportSourceFile {
  path: string;
  content: string;
}

export interface PythonImportEdge {
  fromPath: string;
  toPath: string;
}

export interface GraphImportEdge {
  from: string;
  to: string;
}

export interface PythonImportAnalyzer {
  analyze(files: readonly PythonImportSourceFile[]): Promise<readonly PythonImportEdge[]>;
}

export function requirePythonImportAnalyzer(analyzer: PythonImportAnalyzer | undefined): PythonImportAnalyzer {
  if (analyzer === undefined || typeof analyzer.analyze !== "function") {
    throw new Error("A canonical Python import analyzer is required for Python import-dependent validation");
  }
  return analyzer;
}

export function validatePythonImportEdges(
  value: unknown,
  sourcePaths: ReadonlySet<string>
): readonly PythonImportEdge[] {
  if (!Array.isArray(value)) throw new Error("Python import analyzer returned malformed edges: expected an array");
  const byKey = new Map<string, PythonImportEdge>();
  for (const [index, candidate] of value.entries()) {
    if (candidate === null || typeof candidate !== "object") {
      throw new Error(`Python import analyzer returned malformed edge at index ${index}`);
    }
    const fromValue = Reflect.get(candidate, "fromPath");
    const toValue = Reflect.get(candidate, "toPath");
    if (typeof fromValue !== "string" || typeof toValue !== "string") {
      throw new Error(`Python import analyzer returned malformed edge endpoints at index ${index}`);
    }
    const fromPath = normalizeValidationFileViewPath(fromValue);
    const toPath = normalizeValidationFileViewPath(toValue);
    if (!sourcePaths.has(fromPath) || !sourcePaths.has(toPath)) {
      throw new Error(`Python import analyzer returned an edge outside the supplied after-state: ${fromPath} -> ${toPath}`);
    }
    byKey.set(`${fromPath}\0${toPath}`, { fromPath, toPath });
  }
  return [...byKey.values()].sort(comparePythonImportEdges);
}

export function pythonImportEdgesFromGraph(
  edges: readonly GraphImportEdge[],
  pythonPaths: ReadonlySet<string>
): readonly PythonImportEdge[] {
  const imports: PythonImportEdge[] = [];
  for (const edge of edges) {
    const fromPath = graphFileEndpointPath(edge.from);
    const toPath = graphFileEndpointPath(edge.to);
    if (fromPath !== undefined && toPath !== undefined && pythonPaths.has(fromPath) && pythonPaths.has(toPath)) {
      imports.push({ fromPath, toPath });
    }
  }
  return imports;
}

function graphFileEndpointPath(endpoint: string): string | undefined {
  if (!endpoint.startsWith("file:")) return undefined;
  return normalizeValidationFileViewPath(endpoint.slice("file:".length));
}

function comparePythonImportEdges(left: PythonImportEdge, right: PythonImportEdge): number {
  return `${left.fromPath}\0${left.toPath}`.localeCompare(`${right.fromPath}\0${right.toPath}`);
}
