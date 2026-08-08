import { opcoreAgentGateHookScriptContent } from "./agent-gate.js";
import {
  AGENT_GATE_HOOK_PATH,
  AGENT_SKILL_PATHS,
  CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  GLOBAL_UNDO_PATH
} from "./init-constants.js";
import { createInitActions } from "./init-actions.js";
import { readJsonObjectIfExists } from "./init-files.js";
import { opcoreAgentSkillContent } from "./init-guidance.js";
import { mergeClaudeSettings, mergeCodexHooks } from "./init-hooks.js";
import { initContextPayload, initPayloadOptions } from "./init-context-payload.js";
import { initNextActions, initWarnings } from "./init-messages.js";
import type { InitPlanInput } from "./init-plan.js";
import { repoPathExists } from "./init-paths.js";
import type { PlannedInit, PlannedWrite } from "./init-types.js";

export function planGlobalInit(input: InitPlanInput): PlannedInit {
  const writes = createGlobalWrites(input);
  return {
    writes,
    payload: {
      schemaVersion: 1,
      mode: "plan",
      approved: false,
      repo: { root: input.repoRoot, requestedPath: input.requestedPath },
      options: initPayloadOptions(input.options),
      agentFiles: [],
      actions: createInitActions({
        scope: "global", agentFiles: [], options: input.options,
        gitignoreWritePlanned: false, activePreCommitWritePlanned: false
      }),
      warnings: initWarnings({
        scan: input.context.scan, git: true, failClosedHook: false, scope: "global",
        activePreCommitHook: false, activePreCommitRequested: false, linkedGitWorktree: false
      }),
      nextActions: initNextActions(input.options),
      undoAvailable: repoPathExists(input.homeRoot, GLOBAL_UNDO_PATH),
      ...initContextPayload(input.context)
    }
  };
}

function createGlobalWrites(input: InitPlanInput): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  if (input.options.writeGateHooks) {
    writes.push({
      kind: "write", path: AGENT_GATE_HOOK_PATH, targetScope: "global",
      content: opcoreAgentGateHookScriptContent(), executable: true
    });
  }
  if (input.options.agentSkill) {
    writes.push(...AGENT_SKILL_PATHS.map((path) => ({
      kind: "write" as const, path, targetScope: "global" as const,
      content: opcoreAgentSkillContent()
    })));
  }
  if (input.options.writeGateHooks) writes.push(...globalHarnessWrites(input.homeRoot));
  return writes;
}

function globalHarnessWrites(homeRoot: string): PlannedWrite[] {
  return [
    {
      kind: "write", path: CLAUDE_SETTINGS_PATH, targetScope: "global",
      content: `${JSON.stringify(mergeClaudeSettings(
        readJsonObjectIfExists(homeRoot, CLAUDE_SETTINGS_PATH), "global"
      ), null, 2)}\n`
    },
    {
      kind: "write", path: CODEX_HOOKS_PATH, targetScope: "global",
      content: `${JSON.stringify(mergeCodexHooks(
        readJsonObjectIfExists(homeRoot, CODEX_HOOKS_PATH), "global"
      ), null, 2)}\n`
    }
  ];
}
