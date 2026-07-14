import type { OpcoreRepoStatePayload } from "@the-open-engine/opcore-contracts";

export interface OpcoreStatusDisplayOptions {
  includeAspLine: boolean;
}

export function formatOpcoreStatus(
  repoState: OpcoreRepoStatePayload,
  options: OpcoreStatusDisplayOptions
): string {
  const lines = [
    "opcore status",
    `Repo: ${repoState.repo.root} (${formatGitState(repoState.repo.git)})`,
    formatCoverageLine(repoState.coverage),
    `Graph: ${repoState.graph.state}; ${repoState.graph.action}`,
    formatValidationLine(repoState.validation),
    `Activation: ${repoState.activation.level}; ${repoState.activation.summary}`,
    "Next:",
    ...repoState.nextActions.slice(0, 2).map((action) => `  ${action}`)
  ];
  if (options.includeAspLine) lines.splice(5, 0, formatAspStatusLine(repoState.activation.asp));
  return lines.join("\n");
}

function formatCoverageLine(coverage: OpcoreRepoStatePayload["coverage"]): string {
  const unsupported = coverage.unsupported.stacks.length === 0
    ? "none"
    : coverage.unsupported.stacks.map((stack) => `${stack.language} ${stack.count}`).join(", ");
  return `Coverage: files=${coverage.totalFiles} graph=${coverage.graph.supportedFiles} validation=${coverage.validation.supportedFiles} retained=${coverage.validation.retainedFiles} unsupported=${unsupported}`;
}

function formatValidationLine(validation: OpcoreRepoStatePayload["validation"]): string {
  const adapters = validation.adapters.length === 0
    ? "none"
    : validation.adapters.map((adapter) => `${adapter.adapter}:${adapter.status}`).join(", ");
  const degradedTools = validation.degradedToolchains.length === 0
    ? "none"
    : validation.degradedToolchains.map((tool) => tool.tool).join(", ");
  return `Validation: checks=${validation.checkCount} adapters=${adapters} degradedTools=${degradedTools}`;
}

function formatGitState(git: OpcoreRepoStatePayload["repo"]["git"]): string {
  if (!git.available) return "non-Git repo";
  return `git ${git.branch ?? "unknown"} changed=${git.changed ?? 0} staged=${git.staged ?? 0} unstaged=${git.unstaged ?? 0} untracked=${git.untracked ?? 0}`;
}

function formatAspStatusLine(asp: OpcoreRepoStatePayload["activation"]["asp"]): string {
  return `ASP: ${asp.state}${asp.paths.length > 0 ? ` (${asp.paths.join(", ")})` : ""}`;
}
