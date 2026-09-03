import type { OpcoreInitAction } from "@the-open-engine/opcore-contracts";
import {
  ACTIVE_PRE_COMMIT_HOOK_PATH,
  AGENT_GATE_HOOK_PATH,
  CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  CONFIG_PATH,
  FAIL_CLOSED_HOOK_ACTIVATION_COMMAND,
  GITIGNORE_PATH,
  HOOK_PATH
} from "./init-constants.js";
import { createSkillActions } from "./init-action-helpers.js";
import type { ParsedInitArgs } from "./init-types.js";

export interface RepoActionInput {
  agentFiles: readonly string[];
  options: ParsedInitArgs;
  gitignoreWritePlanned: boolean;
  activePreCommitWritePlanned: boolean;
}

export function createRepoInitActions(input: RepoActionInput): OpcoreInitAction[] {
  const actions = [
    configAction(),
    ...guidanceActions(input.agentFiles),
    ...createSkillActions("repo", input.options.agentSkill),
    ...writeGateActions(input.options.writeGateHooks)
  ];
  if (input.gitignoreWritePlanned) actions.push(gitignoreAction());
  if (input.activePreCommitWritePlanned) actions.push(preCommitAction());
  if (input.options.failClosedHook) actions.push(failClosedAction());
  return actions;
}

function configAction(): OpcoreInitAction {
  return {
    kind: "write", path: CONFIG_PATH, targetScope: "repo",
    summary: "Write additive Opcore init config.", requiresApproval: false, outsideOpcore: false
  };
}

function guidanceActions(agentFiles: readonly string[]): OpcoreInitAction[] {
  return agentFiles.map((path) => ({
    kind: "upsert_block", path, targetScope: "repo",
    summary: "Add or update delimited Opcore agent guidance.",
    requiresApproval: true, outsideOpcore: true
  }));
}

function writeGateActions(enabled: boolean): OpcoreInitAction[] {
  if (!enabled) return [];
  return [
    {
      kind: "create_hook", path: AGENT_GATE_HOOK_PATH, targetScope: "repo",
      summary: "Install the repo-local Opcore write-gate adapter script.",
      requiresApproval: false, outsideOpcore: false
    },
    {
      kind: "wire_harness", path: CLAUDE_SETTINGS_PATH, targetScope: "repo",
      summary: "Merge the Opcore Claude Code PreToolUse write gate.",
      requiresApproval: true, outsideOpcore: true
    },
    {
      kind: "wire_harness", path: CODEX_HOOKS_PATH, targetScope: "repo",
      summary: "Merge the Opcore Codex PreToolUse write gate guardrail.",
      requiresApproval: true, outsideOpcore: true
    }
  ];
}

function gitignoreAction(): OpcoreInitAction {
  return {
    kind: "write", path: GITIGNORE_PATH, targetScope: "repo",
    summary: "Append managed .opcore/ gitignore entry.", requiresApproval: true, outsideOpcore: true
  };
}

function preCommitAction(): OpcoreInitAction {
  return {
    kind: "create_hook", path: ACTIVE_PRE_COMMIT_HOOK_PATH, targetScope: "repo",
    summary: "Install active Git pre-commit hook that runs `opcore check --changed`.",
    requiresApproval: true, outsideOpcore: true
  };
}

function failClosedAction(): OpcoreInitAction {
  return {
    kind: "create_hook", path: HOOK_PATH, targetScope: "repo",
    summary: `Manual install required: create fail-closed pre-commit hook script; ` +
      `activate with \`${FAIL_CLOSED_HOOK_ACTIVATION_COMMAND}\`.`,
    requiresApproval: false, outsideOpcore: false
  };
}
