import type {
  OpcoreInitPlanPayload,
  OpcoreInitScanSummary
} from "@the-open-engine/opcore-contracts";
import {
  FAIL_CLOSED_HOOK_ACTIVATION_COMMAND
} from "./init-constants.js";
import type {
  InitScope,
  OpcoreSetupCommand,
  ParsedInitArgs
} from "./init-types.js";

export interface InitWarningInput {
  scan: OpcoreInitScanSummary;
  git: boolean;
  failClosedHook: boolean;
  scope: InitScope;
  activePreCommitHook: boolean;
  activePreCommitRequested: boolean;
  linkedGitWorktree: boolean;
}

export function initWarnings(input: InitWarningInput): string[] {
  const warnings: string[] = [];
  if (input.scan.unsupportedStacks.length > 0) {
    const stacks = input.scan.unsupportedStacks.map((stack) => `${stack.language} (${stack.count})`);
    warnings.push(`Unsupported stacks: ${stacks.join(", ")}`);
  }
  if (input.scan.degradedRustTools.length > 0) {
    const tools = input.scan.degradedRustTools.map((tool) => tool.tool);
    warnings.push(`Degraded validation tools: ${tools.join(", ")}`);
  }
  if (!input.git) warnings.push("No Git repository detected; .opcore/ ignore entry not written.");
  warnings.push("Do not weaken existing lint, test, CI, pre-commit, or agent guardrails.");
  warnings.push(scopeWarning(input.scope));
  warnings.push(hookWarning(input));
  return warnings;
}

function scopeWarning(scope: InitScope): string {
  return scope === "global"
    ? "Global write-gate hooks apply across repos; undo removes only Opcore-recorded global hook entries."
    : "Repo write-gate hooks are additive; Codex project hooks may require trust review before they run.";
}

function hookWarning(input: InitWarningInput): string {
  if (input.failClosedHook) {
    return `Fail-closed hook script is opt-in. Manual install required: ${FAIL_CLOSED_HOOK_ACTIVATION_COMMAND}`;
  }
  if (input.activePreCommitHook && input.git) {
    return "Git pre-commit hook will run opcore check --changed when no existing .git/hooks/pre-commit is present.";
  }
  if (input.linkedGitWorktree) {
    return "Linked Git worktree detected; Opcore will not install .git/hooks/pre-commit from this checkout.";
  }
  if (input.activePreCommitRequested) {
    return "Existing .git/hooks/pre-commit detected; Opcore will not overwrite it.";
  }
  return "Fail-closed hooks are opt-in and are not created unless --fail-closed-hook is approved.";
}

export function initNextActions(options: ParsedInitArgs): string[] {
  const approveFlag = options.command === "install" ? "--yes" : "--approve";
  const scopedCommand = options.scope === "global"
    ? `opcore ${options.command} --global ${approveFlag}`
    : `opcore ${options.command} ${approveFlag}`;
  const actions = options.dryRun
    ? [`Run ${scopedCommand} to apply this plan.`]
    : [`Review this plan, then run ${scopedCommand} to write setup.`];
  actions.push(options.scope === "repo"
    ? "Claude Code and Codex write-gate hooks are installed by Opcore setup; " +
      "review Codex project hook trust with /hooks if Codex asks."
    : "Global Claude Code and Codex write-gate hooks are installed by Opcore setup; " +
      "review Codex hook trust with /hooks if Codex asks.");
  if (options.failClosedHook) actions.push(failClosedHookManualInstallAction());
  return actions;
}

export function appliedInitNextActions(
  payload: OpcoreInitPlanPayload,
  command: OpcoreSetupCommand
): string[] {
  const undoCommand = command === "install"
    ? payload.options.scope === "global" ? "opcore uninstall --global --yes" : "opcore uninstall --yes"
    : payload.options.scope === "global"
      ? "opcore init --global --undo --approve"
      : "opcore init --undo --approve";
  const actions = [`Run ${undoCommand} to restore or remove recorded setup files.`];
  actions.push(payload.options.scope === "repo"
    ? "Claude Code write calls are blocked on non-ok receipts. " +
      "Codex uses a PreToolUse guardrail and may require hook trust review."
    : "Global Claude Code write calls are blocked on non-ok receipts. " +
      "Codex uses a PreToolUse guardrail and may require hook trust review.");
  if (payload.options.failClosedHook) actions.push(failClosedHookManualInstallAction());
  return actions;
}

function failClosedHookManualInstallAction(): string {
  return `Manual install required before the fail-closed hook is active: ${FAIL_CLOSED_HOOK_ACTIVATION_COMMAND}`;
}
