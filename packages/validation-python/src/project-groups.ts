import type { PythonProjectContext } from "@the-open-engine/opcore-contracts";

export interface PythonProjectGroup {
  context: PythonProjectContext;
  targets: readonly string[];
}

export function groupPythonProjectContexts(
  contexts: readonly PythonProjectContext[]
): readonly PythonProjectGroup[] {
  const groups = new Map<string, { context: PythonProjectContext; targets: string[] }>();
  for (const context of contexts) {
    const groupKey = `${context.projectKey}\0${context.tools
      .map((tool) => `${tool.tool}:${tool.configFile ?? ""}`)
      .sort()
      .join(",")}`;
    const group = groups.get(groupKey) ?? { context, targets: [] };
    group.targets.push(context.target);
    groups.set(groupKey, group);
  }
  return [...groups.values()]
    .map((group) => ({ context: group.context, targets: [...new Set(group.targets)].sort() }))
    .sort((left, right) => left.context.projectRoot.localeCompare(right.context.projectRoot));
}
