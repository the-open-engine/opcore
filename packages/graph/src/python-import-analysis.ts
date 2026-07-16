import type { GraphFactEdge, GraphFactQueryResult, GraphPipelineResult, RepoIdentity } from "@the-open-engine/opcore-contracts";
import { validateRepoRelativePath } from "@the-open-engine/opcore-contracts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface PythonImportAnalysisFile {
  path: string;
  content: string;
}

export interface PythonImportAnalysisEdge {
  fromPath: string;
  toPath: string;
}

export interface PythonImportAnalysisGraph {
  build(repo: RepoIdentity): GraphPipelineResult;
  query(repo: RepoIdentity): GraphFactQueryResult;
}

export async function analyzePythonImportsWithGraph(
  files: readonly PythonImportAnalysisFile[],
  graph: PythonImportAnalysisGraph
): Promise<readonly PythonImportAnalysisEdge[]> {
  const normalizedFiles = normalizeSuppliedFiles(files);
  const tempRoot = mkdtempSync(join(tmpdir(), "opcore-python-import-analysis-"));
  const repoRoot = join(tempRoot, "repo");
  try {
    mkdirSync(repoRoot, { recursive: true });
    for (const file of normalizedFiles) writeSuppliedFile(repoRoot, file);
    const repo = { repoRoot };
    const build = graph.build(repo);
    if (build.status.state !== "available") throw graphAnalysisFailure("build", build.status);
    const query = graph.query(repo);
    if (query.status.state !== "available" || !("edges" in query)) throw graphAnalysisFailure("query", query.status);
    return importEdges(query.edges, new Set(normalizedFiles.map((file) => file.path)));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function normalizeSuppliedFiles(files: readonly PythonImportAnalysisFile[]): readonly PythonImportAnalysisFile[] {
  if (!Array.isArray(files)) throw new Error("Python import analysis files must be an array");
  const byPath = new Map<string, PythonImportAnalysisFile>();
  for (const [index, candidate] of files.entries()) {
    if (candidate === null || typeof candidate !== "object") {
      throw new Error(`Python import analysis file at index ${index} is malformed`);
    }
    if (typeof candidate.path !== "string" || typeof candidate.content !== "string") {
      throw new Error(`Python import analysis file at index ${index} requires string path and content`);
    }
    const path = validateRepoRelativePath(candidate.path);
    if (!isPythonSourcePath(path)) throw new Error(`Python import analysis accepts only .py/.pyi files: ${path}`);
    if (byPath.has(path)) throw new Error(`Python import analysis received duplicate path: ${path}`);
    byPath.set(path, { path, content: candidate.content });
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function writeSuppliedFile(repoRoot: string, file: PythonImportAnalysisFile): void {
  const absolutePath = resolveRepoPath(repoRoot, file.path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, file.content);
}

function resolveRepoPath(repoRoot: string, path: string): string {
  return resolve(repoRoot, validateRepoRelativePath(path));
}

function importEdges(
  edges: readonly GraphFactEdge[],
  suppliedPaths: ReadonlySet<string>
): readonly PythonImportAnalysisEdge[] {
  const byKey = new Map<string, PythonImportAnalysisEdge>();
  for (const edge of edges) {
    if (edge.kind !== "IMPORTS_FROM") continue;
    const fromPath = fileEndpointPath(edge.from);
    const toPath = fileEndpointPath(edge.to);
    if (!suppliedPaths.has(fromPath) || !suppliedPaths.has(toPath)) {
      throw new Error(`Graph-core Python import analysis returned an edge outside supplied files: ${fromPath} -> ${toPath}`);
    }
    byKey.set(`${fromPath}\0${toPath}`, { fromPath, toPath });
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.fromPath}\0${left.toPath}`.localeCompare(`${right.fromPath}\0${right.toPath}`)
  );
}

function fileEndpointPath(endpoint: string): string {
  if (!endpoint.startsWith("file:")) throw new Error(`Graph-core Python import analysis returned a non-file endpoint: ${endpoint}`);
  return validateRepoRelativePath(endpoint.slice("file:".length));
}

function graphAnalysisFailure(operation: "build" | "query", status: { state: string; message?: string }): Error {
  return new Error(`Graph-core Python import analysis ${operation} failed (${status.state}): ${status.message ?? "no failure message"}`);
}

function isPythonSourcePath(path: string): boolean {
  return path.endsWith(".py") || path.endsWith(".pyi");
}
