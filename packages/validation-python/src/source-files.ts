import type { ValidationCheckContext, ValidationCheckResult, ValidationFileView } from "@the-open-engine/opcore-validation";
import { normalizeValidationFileViewPath } from "@the-open-engine/opcore-validation";

export const pythonSourceExtensions = [".py", ".pyi"] as const;

export interface PythonMaterializedSourceFile {
  path: string;
  content: string;
}

export interface PythonRepoImport {
  fromPath: string;
  specifier: string;
  resolvedPath: string;
}

export interface PythonMaterializedSourceSet {
  rootPaths: readonly string[];
  paths: readonly string[];
  files: readonly PythonMaterializedSourceFile[];
  sourceFileByPath: ReadonlyMap<string, PythonMaterializedSourceFile>;
  repoImports: readonly PythonRepoImport[];
}

interface ParsedPythonImport {
  specifier: string;
  member?: string;
}

const sourceSetCache = new WeakMap<ValidationFileView, Promise<PythonMaterializedSourceSet>>();

export function isPythonSourcePath(path: string): boolean {
  return pythonSourceExtensions.some((extension) => path.endsWith(extension));
}

export function toFileNodeId(path: string): string {
  return `file:${path}`;
}

export function pythonInputSet(context: ValidationCheckContext): readonly string[] {
  return uniqueSorted(
    [...context.fileView.scopeFiles, ...context.fileView.overlays.map((overlay) => overlay.path)]
      .map((path) => normalizeValidationFileViewPath(path))
      .filter(isPythonSourcePath)
  );
}

export async function readPythonAfterSources(context: ValidationCheckContext): Promise<readonly PythonMaterializedSourceFile[]> {
  const files: PythonMaterializedSourceFile[] = [];
  for (const path of pythonInputSet(context)) {
    const result = await context.fileView.readAfter(path);
    if (result.status === "found") files.push({ path, content: result.content });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function skippedPythonInputResult(context: ValidationCheckContext): ValidationCheckResult | undefined {
  if (pythonInputSet(context).length > 0) return undefined;
  return {
    status: "skipped",
    diagnostics: [],
    failureMessage: "No Python-owned files were selected."
  };
}

export async function materializePythonSources(context: ValidationCheckContext): Promise<PythonMaterializedSourceSet> {
  const cached = sourceSetCache.get(context.fileView);
  if (cached !== undefined) return cached;
  const promise = materializePythonSourcesUncached(context);
  sourceSetCache.set(context.fileView, promise);
  return promise;
}

async function materializePythonSourcesUncached(context: ValidationCheckContext): Promise<PythonMaterializedSourceSet> {
  const initialPaths = pythonInputSet(context);
  const rootPaths: string[] = [];
  const pending = [...initialPaths];
  const visited = new Set<string>();
  const sourceFileByPath = new Map<string, PythonMaterializedSourceFile>();
  const repoImports: PythonRepoImport[] = [];

  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);

    const result = await context.fileView.readAfter(path);
    if (result.status !== "found") continue;
    const sourceFile = { path, content: result.content };
    sourceFileByPath.set(path, sourceFile);
    if (initialPaths.includes(path)) rootPaths.push(path);

    for (const parsedImport of parsePythonImports(result.content)) {
      const resolvedPath = await resolvePythonImport(context, path, parsedImport);
      if (resolvedPath === undefined) continue;
      repoImports.push({ fromPath: path, specifier: parsedImport.specifier, resolvedPath });
      if (!visited.has(resolvedPath) && !sourceFileByPath.has(resolvedPath)) pending.push(resolvedPath);
    }
  }

  const files = [...sourceFileByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  return {
    rootPaths: uniqueSorted(rootPaths),
    paths: files.map((file) => file.path),
    files,
    sourceFileByPath,
    repoImports: uniqueRepoImports(repoImports)
  };
}

function parsePythonImports(content: string): readonly ParsedPythonImport[] {
  const imports: ParsedPythonImport[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripInlineComment(rawLine).trim();
    if (line.length === 0) continue;
    const importMatch = /^import\s+(.+)$/u.exec(line);
    if (importMatch !== null) {
      for (const entry of importMatch[1].split(",")) {
        const specifier = entry.trim().split(/\s+as\s+/u)[0]?.trim();
        if (isImportableModuleSpecifier(specifier)) imports.push({ specifier });
      }
      continue;
    }
    const fromMatch = /^from\s+([.\w]+)\s+import\s+(.+)$/u.exec(line);
    if (fromMatch === null) continue;
    const moduleSpecifier = fromMatch[1];
    const importedNames = fromMatch[2].split(",").map((entry) => entry.trim().split(/\s+as\s+/u)[0]?.trim() ?? "");
    if (/^\.+$/u.test(moduleSpecifier)) {
      for (const name of importedNames) {
        if (/^[A-Za-z_]\w*$/u.test(name)) imports.push({ specifier: `${moduleSpecifier}${name}` });
      }
    } else if (isImportableModuleSpecifier(moduleSpecifier)) {
      imports.push({ specifier: moduleSpecifier });
      for (const name of importedNames) {
        if (/^[A-Za-z_]\w*$/u.test(name)) imports.push({ specifier: `${moduleSpecifier}.${name}`, member: name });
      }
    }
  }
  return imports;
}

async function resolvePythonImport(
  context: ValidationCheckContext,
  fromPath: string,
  parsedImport: ParsedPythonImport
): Promise<string | undefined> {
  const moduleBase = moduleBasePath(fromPath, parsedImport.specifier);
  if (moduleBase === undefined) return undefined;
  return resolveModulePath(context, moduleBase);
}

async function resolveModulePath(context: ValidationCheckContext, moduleBase: string): Promise<string | undefined> {
  for (const candidate of moduleCandidates(moduleBase)) {
    let normalized: string;
    try {
      normalized = normalizeValidationFileViewPath(candidate);
    } catch {
      continue;
    }
    if (!isPythonSourcePath(normalized)) continue;
    if (await context.fileView.exists(normalized)) return normalized;
  }
  return undefined;
}

function moduleBasePath(fromPath: string, specifier: string): string | undefined {
  const leadingDots = /^\.*/u.exec(specifier)?.[0].length ?? 0;
  const moduleSpecifier = specifier.slice(leadingDots);
  const moduleParts = moduleSpecifier.length === 0 ? [] : moduleSpecifier.split(".");
  if (leadingDots === 0) return moduleParts.join("/");

  const baseParts = fromPath.split("/");
  baseParts.pop();
  for (let index = 1; index < leadingDots; index += 1) {
    if (baseParts.length === 0) return undefined;
    baseParts.pop();
  }
  return [...baseParts, ...moduleParts].filter((part) => part.length > 0).join("/");
}

function moduleCandidates(moduleBase: string): readonly string[] {
  if (moduleBase.length === 0) return [];
  return [`${moduleBase}.py`, `${moduleBase}.pyi`, `${moduleBase}/__init__.py`, `${moduleBase}/__init__.pyi`];
}

function stripInlineComment(line: string): string {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== undefined && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === undefined) quote = char;
      else if (quote === char) quote = undefined;
      continue;
    }
    if (quote === undefined && char === "#") return line.slice(0, index);
  }
  return line;
}

function isImportableModuleSpecifier(value: string | undefined): value is string {
  return value !== undefined && /^\.?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(value);
}

function uniqueRepoImports(imports: readonly PythonRepoImport[]): readonly PythonRepoImport[] {
  const byKey = new Map<string, PythonRepoImport>();
  for (const repoImport of imports) {
    byKey.set(`${repoImport.fromPath}\0${repoImport.specifier}\0${repoImport.resolvedPath}`, repoImport);
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.fromPath}\0${left.resolvedPath}\0${left.specifier}`.localeCompare(
      `${right.fromPath}\0${right.resolvedPath}\0${right.specifier}`
    )
  );
}

export function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
