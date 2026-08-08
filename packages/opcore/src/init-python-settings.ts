import type {
  OpcoreInitPythonEnvironment,
  OpcoreRepoStatePayload
} from "@the-open-engine/opcore-contracts";
import { relative } from "node:path";

const managerKinds = {
  pip: "requirements",
  uv: "uv",
  poetry: "poetry",
  pdm: "pyproject",
  pipenv: "pipfile"
} as const;
type PythonContexts = NonNullable<OpcoreRepoStatePayload["validation"]["pythonProjectContexts"]>;

export function pythonEnvironmentFromContexts(contexts: PythonContexts): OpcoreInitPythonEnvironment {
  const managers = new Map<string, OpcoreInitPythonEnvironment["dependencyManagers"][number]>();
  const environments = new Map<string, OpcoreInitPythonEnvironment["virtualEnvironments"][number]>();
  for (const context of contexts) {
    collectManagers(context, managers);
    const path = pythonEnvironmentPath(context);
    if (path) environments.set(path, { kind: "venv", path });
  }
  const projectRoots = uniqueSorted(contexts.map((context) => context.projectRoot));
  const outcomes = uniqueSorted(contexts.map((context) => context.outcome));
  const evidence = uniqueSorted(contexts.flatMap((context) => context.evidence.map((entry) => entry.path)));
  return {
    dependencyManagers: [...managers.values()].sort((left, right) => left.path.localeCompare(right.path)),
    virtualEnvironments: [...environments.values()].sort((left, right) => left.path.localeCompare(right.path)),
    notes: contexts.length === 0 ? [] : contextNotes(projectRoots, evidence, outcomes),
    contexts
  };
}

function collectManagers(
  context: PythonContexts[number],
  managers: Map<string, OpcoreInitPythonEnvironment["dependencyManagers"][number]>
): void {
  for (const manager of context.managers) {
    const path = manager.lockFiles[0] ?? manager.configFiles[0];
    if (!path) continue;
    const value = { kind: managerKinds[manager.kind], path };
    managers.set(`${value.kind}\0${value.path}`, value);
  }
}

function pythonEnvironmentPath(context: PythonContexts[number]): string | undefined {
  if (context.interpreter?.source !== "project_local_environment") return undefined;
  const executable = context.interpreter.executable.replaceAll("\\", "/");
  const suffix = executable.match(/\/(?:bin\/python[^/]*|Scripts\/python\.exe|python\.exe)$/u)?.[0];
  if (!suffix) return undefined;
  const path = relative(context.repositoryRoot, executable.slice(0, -suffix.length)).replaceAll("\\", "/");
  return path.length > 0 && !path.startsWith("..") ? path : undefined;
}

function contextNotes(projectRoots: string[], evidence: string[], outcomes: string[]): string[] {
  return [
    `Canonical Python project contexts: ${projectRoots.join(", ") || "."}.`,
    `Canonical Python project evidence: ${evidence.join(", ")}.`,
    `Python context outcomes: ${outcomes.join(", ")}.`
  ];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function hasPythonEnvironmentSignals(environment: OpcoreInitPythonEnvironment): boolean {
  return (environment.contexts?.length ?? 0) > 0;
}
