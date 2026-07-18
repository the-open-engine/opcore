import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext } from "@the-open-engine/opcore-validation";
import type {
  PythonImportEdge,
  PythonImportSourceFile
} from "./import-analysis.js";

export type PythonMaterializedSourceFile = PythonImportSourceFile;

export interface PythonMaterializedSourceSet {
  rootPaths: readonly string[];
  paths: readonly string[];
  allPaths: readonly string[];
  files: readonly PythonMaterializedSourceFile[];
  sourceFileByPath: ReadonlyMap<string, PythonMaterializedSourceFile>;
  repoImports: readonly PythonImportEdge[];
  allRepoImports: readonly PythonImportEdge[];
}

export type PythonProjectContextResolver = (
  context: ValidationCheckContext,
  targets?: readonly string[]
) => Promise<readonly PythonProjectContext[]>;

export type PythonSourceRootResolver = (
  context: ValidationCheckContext
) => Promise<readonly string[]>;

export type PythonSourceSetResolver = (
  context: ValidationCheckContext
) => Promise<PythonMaterializedSourceSet>;
