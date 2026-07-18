import type {
  PythonProjectContextReason,
  PythonProjectFileEvidence,
  PythonProjectLayoutEvidence
} from "@the-open-engine/opcore-contracts";
import { pythonBoundaryFileNames } from "./project-config-files.js";
import type { PythonProjectWorkspace } from "./project-workspace.js";

export interface PythonProjectDiscovery {
  projectRoot: string;
  projectBoundary: string;
  sourceRoots: readonly string[];
  layout: PythonProjectLayoutEvidence;
  evidence: readonly PythonProjectFileEvidence[];
  reasons: readonly PythonProjectContextReason[];
}

export async function discoverPythonProject(
  workspace: PythonProjectWorkspace,
  target: string,
  visibleFiles: readonly string[]
): Promise<PythonProjectDiscovery> {
  const ancestors = ancestorDirectories(dirname(target));
  let projectRoot = ".";
  let boundaryFiles: string[] = [];
  for (const directory of ancestors) {
    const direct = directChildren(directory, visibleFiles);
    const markers = direct.filter(isBoundaryMarker);
    if (markers.length === 0) continue;
    projectRoot = directory;
    boundaryFiles = markers;
    break;
  }

  const reasons: PythonProjectContextReason[] = [];
  if (boundaryFiles.length === 0) {
    reasons.push({ code: "missing_config", message: `No Python project boundary/config marker owns ${target}` });
  }
  for (const path of [target, ...boundaryFiles]) {
    const resolved = await workspace.realpath(path);
    if (resolved.unavailable) {
      reasons.push({ code: "ambiguous_path", path, message: `Python project path realpath evidence is unavailable: ${path}` });
    } else if (resolved.symlink || resolved.path !== path) {
      reasons.push({ code: "symlink_refused", path, message: `Symlinked Python project path is ambiguous: ${path}` });
    }
  }
  const layout = await layoutEvidence(workspace, projectRoot, target);
  const evidence: PythonProjectFileEvidence[] = [
    ...boundaryFiles.map((path) => ({ path, role: "boundary" as const })),
    ...layout.paths.filter((path) => path !== ".").map((path) => ({ path, role: "layout" as const }))
  ].sort(compareEvidence);
  return { projectRoot, projectBoundary: projectRoot, sourceRoots: sourceRoots(projectRoot, target), layout, evidence, reasons };
}

async function layoutEvidence(
  workspace: PythonProjectWorkspace,
  projectRoot: string,
  target: string
): Promise<PythonProjectLayoutEvidence> {
  const roots = sourceRoots(projectRoot, target);
  const kinds = new Set<"flat" | "src" | "namespace" | "stub" | "package">();
  if (roots.some((root) => basename(root) === "src")) kinds.add("src");
  else kinds.add("flat");
  if (target.endsWith(".pyi")) kinds.add("stub");
  const sourceRoot = roots.find((root) => target === root || target.startsWith(`${root}/`)) ?? projectRoot;
  const packageDirs = packageDirectoriesWithin(sourceRoot, dirname(target));
  let packageMarker = false;
  for (const directory of packageDirs) {
    if (await workspace.exists(`${directory}/__init__.py`) || await workspace.exists(`${directory}/__init__.pyi`)) {
      packageMarker = true;
      break;
    }
  }
  if (packageMarker) kinds.add("package");
  else if (packageDirs.length > 0) kinds.add("namespace");
  return { kinds: [...kinds].sort(), paths: roots };
}

function packageDirectoriesWithin(sourceRoot: string, targetDirectory: string): readonly string[] {
  if (targetDirectory === sourceRoot) return [];
  const prefix = sourceRoot === "." ? "" : `${sourceRoot}/`;
  if (!targetDirectory.startsWith(prefix)) return [];
  const relative = targetDirectory.slice(prefix.length);
  if (relative.length === 0) return [];
  const parts = relative.split("/").filter(Boolean);
  const directories: string[] = [];
  for (let length = parts.length; length > 0; length -= 1) {
    const child = parts.slice(0, length).join("/");
    directories.push(sourceRoot === "." ? child : `${sourceRoot}/${child}`);
  }
  return directories;
}

function sourceRoots(projectRoot: string, target: string): readonly string[] {
  const src = projectRoot === "." ? "src" : `${projectRoot}/src`;
  if (target.startsWith(`${src}/`)) return [src];
  return [projectRoot];
}

function isBoundaryMarker(path: string): boolean {
  const name = basename(path);
  return pythonBoundaryFileNames.includes(name as (typeof pythonBoundaryFileNames)[number]) || /^requirements.*\.txt$/u.test(name);
}

function directChildren(root: string, files: readonly string[]): readonly string[] {
  const prefix = root === "." ? "" : `${root}/`;
  return files.filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
}

function ancestorDirectories(start: string): readonly string[] {
  if (start === ".") return ["."];
  const parts = start.split("/").filter(Boolean);
  const values: string[] = [];
  for (let length = parts.length; length > 0; length -= 1) values.push(parts.slice(0, length).join("/"));
  values.push(".");
  return values;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function compareEvidence(left: PythonProjectFileEvidence, right: PythonProjectFileEvidence): number {
  return `${left.path}\0${left.role}`.localeCompare(`${right.path}\0${right.role}`);
}
