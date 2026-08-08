import {
  ACTIVE_PRE_COMMIT_HOOK_PATH,
  GITIGNORE_PATH,
  UNDO_PATH
} from "./init-constants.js";
import { createInitActions } from "./init-actions.js";
import { detectAgentFiles } from "./init-guidance.js";
import { initContextPayload, initPayloadOptions } from "./init-context-payload.js";
import { initNextActions, initWarnings } from "./init-messages.js";
import type { InitPlanInput } from "./init-plan.js";
import { createRepoWrites } from "./init-plan-writes.js";
import { isLinkedGitWorktree, repoPathExists } from "./init-paths.js";
import type { PlannedInit } from "./init-types.js";

export function planRepoInit(input: InitPlanInput): PlannedInit {
  const agentFiles = detectAgentFiles(input.repoRoot);
  const linkedGitWorktree = input.git && isLinkedGitWorktree(input.repoRoot);
  const activePreCommitWritePlanned =
    input.options.activePreCommitHook &&
    input.git &&
    !linkedGitWorktree &&
    !repoPathExists(input.repoRoot, ACTIVE_PRE_COMMIT_HOOK_PATH);
  const writes = createRepoWrites({ plan: input, agentFiles, activePreCommitWritePlanned });
  const gitignoreWritePlanned = writes.some((write) => write.path === GITIGNORE_PATH);
  return {
    writes,
    payload: {
      schemaVersion: 1,
      mode: "plan",
      approved: false,
      repo: { root: input.repoRoot, requestedPath: input.requestedPath },
      options: initPayloadOptions(input.options),
      agentFiles,
      actions: createInitActions({
        scope: "repo", agentFiles, options: input.options,
        gitignoreWritePlanned, activePreCommitWritePlanned
      }),
      warnings: initWarnings({
        scan: input.context.scan,
        git: input.git,
        failClosedHook: input.options.failClosedHook,
        scope: "repo",
        activePreCommitHook: activePreCommitWritePlanned,
        activePreCommitRequested: input.options.activePreCommitHook && input.git,
        linkedGitWorktree
      }),
      nextActions: initNextActions(input.options),
      undoAvailable: repoPathExists(input.repoRoot, UNDO_PATH),
      ...initContextPayload(input.context)
    }
  };
}
