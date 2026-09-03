import type { OpcoreInitAction } from "@the-open-engine/opcore-contracts";
import {
  AGENT_GATE_HOOK_PATH,
  CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH
} from "./init-constants.js";
import { actionPath, createSkillActions } from "./init-action-helpers.js";
import type { ParsedInitArgs } from "./init-types.js";

export function createGlobalInitActions(options: ParsedInitArgs): OpcoreInitAction[] {
  return [
    ...globalHookAction(options.writeGateHooks),
    ...createSkillActions("global", options.agentSkill),
    ...globalHarnessActions(options.writeGateHooks)
  ];
}

function globalHookAction(enabled: boolean): OpcoreInitAction[] {
  return enabled ? [{
    kind: "create_hook",
    path: actionPath("global", AGENT_GATE_HOOK_PATH),
    targetScope: "global",
    summary: "Install the global Opcore write-gate adapter script.",
    requiresApproval: false,
    outsideOpcore: false
  }] : [];
}

function globalHarnessActions(enabled: boolean): OpcoreInitAction[] {
  if (!enabled) return [];
  return [
    {
      kind: "wire_harness",
      path: actionPath("global", CLAUDE_SETTINGS_PATH),
      targetScope: "global",
      summary: "Merge the Opcore Claude Code PreToolUse write gate.",
      requiresApproval: true,
      outsideOpcore: true
    },
    {
      kind: "wire_harness",
      path: actionPath("global", CODEX_HOOKS_PATH),
      targetScope: "global",
      summary: "Merge the Opcore Codex PreToolUse write gate guardrail.",
      requiresApproval: true,
      outsideOpcore: true
    }
  ];
}
