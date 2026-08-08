import {
  FAIL_CLOSED_HOOK_ACTIVATION_COMMAND
} from "./init-constants.js";
import { isPlainObject } from "./init-data.js";
import type { InitScope } from "./init-types.js";

export function failClosedHookContent(): string {
  return [
    "#!/usr/bin/env sh",
    "# Manual install required.",
    "# This script is not active until installed.",
    `# Activation command: ${FAIL_CLOSED_HOOK_ACTIVATION_COMMAND}`,
    "set -eu",
    "opcore check --changed",
    ""
  ].join("\n");
}

export function activePreCommitHookContent(): string {
  return [
    "#!/usr/bin/env sh",
    "# Installed by opcore install. Remove with opcore uninstall.",
    "set -eu",
    "opcore check --changed",
    ""
  ].join("\n");
}

export function mergeClaudeSettings(existing: Record<string, unknown>, scope: InitScope): Record<string, unknown> {
  return mergePreToolUseHook(existing, {
    matcher: "Edit|MultiEdit|Write",
    command: agentGateCommand("claude", scope),
    statusMessage: "Running Opcore write gate"
  });
}

export function mergeCodexHooks(existing: Record<string, unknown>, scope: InitScope): Record<string, unknown> {
  return mergePreToolUseHook(existing, {
    matcher: "apply_patch|Edit|Write",
    command: agentGateCommand("codex", scope),
    statusMessage: "Running Opcore write gate"
  });
}

function mergePreToolUseHook(
  existing: Record<string, unknown>,
  hook: { matcher: string; command: string; statusMessage: string }
): Record<string, unknown> {
  const hooks = isPlainObject(existing.hooks) ? existing.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const groupIndex = preToolUse.findIndex((entry) => isPlainObject(entry) && entry.matcher === hook.matcher);
  const hookEntry = {
    type: "command", command: hook.command, timeout: 30, statusMessage: hook.statusMessage
  };
  if (groupIndex >= 0) {
    const group = preToolUse[groupIndex];
    if (isPlainObject(group)) {
      const groupHooks = Array.isArray(group.hooks) ? [...group.hooks] : [];
      const alreadyPresent = groupHooks.some(
        (entry) => isPlainObject(entry) &&
          typeof entry.command === "string" &&
          entry.command.includes("opcore-agent-gate.mjs")
      );
      preToolUse[groupIndex] = {
        ...group,
        hooks: alreadyPresent ? groupHooks : [...groupHooks, hookEntry]
      };
    }
  } else {
    preToolUse.push({ matcher: hook.matcher, hooks: [hookEntry] });
  }
  return { ...existing, hooks: { ...hooks, PreToolUse: preToolUse } };
}

function agentGateCommand(harness: "claude" | "codex", scope: InitScope): string {
  const hook = scope === "global"
    ? "$HOME/.opcore/hooks/opcore-agent-gate.mjs"
    : '"$(git rev-parse --show-toplevel)/.opcore/hooks/opcore-agent-gate.mjs"';
  const repo = scope === "global" ? "" : ' --repo "$(git rev-parse --show-toplevel)"';
  return `node ${hook} --harness ${harness}${repo}`;
}
