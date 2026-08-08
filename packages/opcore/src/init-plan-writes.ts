import { opcoreAgentGateHookScriptContent } from "./agent-gate.js";
import {
  ACTIVE_PRE_COMMIT_HOOK_PATH,
  AGENT_GATE_HOOK_PATH,
  AGENT_SKILL_PATHS,
  CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  CONFIG_PATH,
  GITIGNORE_PATH,
  HOOK_PATH,
  OPCORE_IGNORE_LINE
} from "./init-constants.js";
import { createConfig } from "./init-config.js";
import { readJsonObjectIfExists, readOptionalRepoFile } from "./init-files.js";
import { gitignoreIgnoresOpcore } from "./init-gitignore.js";
import { agentGuidanceWrite, opcoreAgentSkillContent } from "./init-guidance.js";
import {
  activePreCommitHookContent,
  failClosedHookContent,
  mergeClaudeSettings,
  mergeCodexHooks
} from "./init-hooks.js";
import type { InitPlanInput } from "./init-plan.js";
import type { PlannedWrite } from "./init-types.js";

export interface RepoWriteInput {
  plan: InitPlanInput;
  agentFiles: readonly string[];
  activePreCommitWritePlanned: boolean;
}

export function createRepoWrites(input: RepoWriteInput): PlannedWrite[] {
  const writes = baseRepoWrites(input);
  if (input.plan.options.writeGateHooks) writes.push(...writeGateWrites(input.plan.repoRoot));
  if (input.plan.options.agentSkill) writes.push(...skillWrites());
  if (input.plan.git) writes.push(...gitWrites(input));
  if (input.plan.options.failClosedHook) {
    writes.push({
      kind: "write", path: HOOK_PATH, targetScope: "repo",
      content: failClosedHookContent(), executable: true
    });
  }
  return writes;
}

function baseRepoWrites(input: RepoWriteInput): PlannedWrite[] {
  const config = createConfig({
    repoRoot: input.plan.repoRoot,
    failClosedHook: input.plan.options.failClosedHook,
    activePreCommitHook: input.activePreCommitWritePlanned,
    writeGateHooks: input.plan.options.writeGateHooks,
    scan: input.plan.context.scan,
    settings: input.plan.context.settings
  });
  return [
    {
      kind: "write", path: CONFIG_PATH, targetScope: "repo",
      content: `${JSON.stringify(config, null, 2)}\n`
    },
    ...input.agentFiles.map((path) => ({
      kind: "write" as const, path, targetScope: "repo" as const,
      content: agentGuidanceWrite(input.plan.repoRoot, path)
    }))
  ];
}

function writeGateWrites(repoRoot: string): PlannedWrite[] {
  return [
    {
      kind: "write", path: AGENT_GATE_HOOK_PATH, targetScope: "repo",
      content: opcoreAgentGateHookScriptContent(), executable: true
    },
    {
      kind: "write", path: CLAUDE_SETTINGS_PATH, targetScope: "repo",
      content: `${JSON.stringify(mergeClaudeSettings(
        readJsonObjectIfExists(repoRoot, CLAUDE_SETTINGS_PATH), "repo"
      ), null, 2)}\n`
    },
    {
      kind: "write", path: CODEX_HOOKS_PATH, targetScope: "repo",
      content: `${JSON.stringify(mergeCodexHooks(
        readJsonObjectIfExists(repoRoot, CODEX_HOOKS_PATH), "repo"
      ), null, 2)}\n`
    }
  ];
}

function skillWrites(): PlannedWrite[] {
  return AGENT_SKILL_PATHS.map((path) => ({
    kind: "write", path, targetScope: "repo", content: opcoreAgentSkillContent()
  }));
}

function gitWrites(input: RepoWriteInput): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  const gitignore = readOptionalRepoFile(input.plan.repoRoot, GITIGNORE_PATH);
  if (!gitignoreIgnoresOpcore(gitignore ?? "")) {
    writes.push({
      kind: "append_managed_line", path: GITIGNORE_PATH,
      targetScope: "repo", line: OPCORE_IGNORE_LINE
    });
  }
  if (input.activePreCommitWritePlanned) {
    writes.push({
      kind: "write", path: ACTIVE_PRE_COMMIT_HOOK_PATH, targetScope: "repo",
      content: activePreCommitHookContent(), executable: true
    });
  }
  return writes;
}
