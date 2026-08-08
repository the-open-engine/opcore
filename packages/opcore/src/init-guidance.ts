import {
  AGENT_FILE_CANDIDATES,
  BEGIN_MARKER,
  END_MARKER
} from "./init-constants.js";
import { trimLeftPreserve, trimRightPreserve } from "./init-data.js";
import { readOptionalRepoFile } from "./init-files.js";
import { assertExistingRepoPath, repoPathExists } from "./init-paths.js";

export function detectAgentFiles(repoRoot: string): string[] {
  const existing = AGENT_FILE_CANDIDATES.filter((path) => repoPathExists(repoRoot, path));
  for (const path of existing) {
    assertExistingRepoPath(repoRoot, path, "Existing agent guidance file", "file");
  }
  return existing.length > 0 ? [...existing] : ["AGENTS.md"];
}

export function upsertOpcoreBlock(existing: string | undefined): string {
  const block = guidanceBlock();
  if (existing === undefined || existing.length === 0) return `${block}\n`;
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
    throw new Error("existing Opcore init guidance markers are unbalanced");
  }
  if (begin !== -1) {
    const replacementEnd = end + END_MARKER.length;
    return (
      `${trimRightPreserve(existing.slice(0, begin))}\n\n${block}\n` +
      trimLeftPreserve(existing.slice(replacementEnd))
    ).replace(/\n{3,}/g, "\n\n");
  }
  return `${trimRightPreserve(existing)}\n\n${block}\n`;
}

export function agentGuidanceWrite(repoRoot: string, path: string): string {
  return upsertOpcoreBlock(readOptionalRepoFile(repoRoot, path));
}

function guidanceBlock(): string {
  return [
    BEGIN_MARKER,
    "## Opcore",
    "",
    "- Run `opcore check --changed` before finalizing edits.",
    "- Preserve existing repo lint/test/CI/pre-commit guardrails.",
    "- Treat unsupported stacks and degraded tools honestly.",
    "- For Python repos, require one configured per-project type authority; treat absent, conflicting, " +
      "unavailable, or deferred authority and missing ruff/pytest as degraded coverage, not a pass.",
    "- Use Opcore validation directly; ASP hosts retain their own decision authority.",
    END_MARKER
  ].join("\n");
}

export function opcoreAgentSkillContent(): string {
  return [
    "---",
    "name: opcore",
    "description: Use when working in a repository that has installed Opcore robustness checks.",
    "---",
    "",
    "# Opcore",
    "",
    "Use Opcore as the repository-local robustness gate for coding-agent edits.",
    "",
    "- Run `opcore status` to inspect activation and coverage before broad work.",
    "- Run `opcore check --changed` before finalizing source edits.",
    "- Treat unsupported stacks and degraded tools honestly; do not report them as clean coverage.",
    "- Preserve existing lint, test, CI, pre-commit, and agent guardrails.",
    "- The installed write gate is a hook guardrail for supported edit tools, not host authority.",
    ""
  ].join("\n");
}
