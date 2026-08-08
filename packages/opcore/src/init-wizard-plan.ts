import type { OpcoreInitAction } from "@the-open-engine/opcore-contracts";
import type {
  InstallWizardFileRow,
  InstallWizardGroup,
  InstallWizardGroupKey,
  InstallWizardPlanView
} from "./install-wizard.js";
import {
  ACTIVE_PRE_COMMIT_HOOK_PATH,
  AGENT_GATE_HOOK_PATH,
  CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  GITIGNORE_PATH
} from "./init-constants.js";
import { isLinkedGitWorktree } from "./init-paths.js";
import type { InitScope } from "./init-types.js";

export function createInstallWizardGroups(
  scope: InitScope,
  git: boolean,
  repoRoot: string,
  actions: readonly OpcoreInitAction[]
): InstallWizardGroup[] {
  const groups: InstallWizardGroup[] = [
    { key: "skill", label: "agent skill", available: true },
    { key: "hooks", label: "write-gate hooks", available: true }
  ];
  if (scope === "global") return groups;
  if (actions.some((action) => action.path === ACTIVE_PRE_COMMIT_HOOK_PATH)) {
    groups.push({ key: "precommit", label: "pre-commit hook", available: true });
    return groups;
  }
  groups.push({
    key: "precommit",
    label: "pre-commit hook",
    available: false,
    unavailableNote: unavailablePreCommitNote(git, repoRoot)
  });
  return groups;
}

function unavailablePreCommitNote(git: boolean, repoRoot: string): string {
  if (!git) return "no git repo";
  return isLinkedGitWorktree(repoRoot) ? "linked worktree — skipped" : "existing hook kept";
}

export function installWizardPlanView(actions: readonly OpcoreInitAction[]): InstallWizardPlanView {
  const baseRows: InstallWizardFileRow[] = [];
  const groupRows: Record<InstallWizardGroupKey, InstallWizardFileRow[]> = {
    skill: [], hooks: [], precommit: []
  };
  for (const action of actions) {
    const row: InstallWizardFileRow = {
      path: action.path,
      mark: actionMark(action),
      outsideOpcore: action.outsideOpcore
    };
    const group = installWizardGroupForPath(action.path);
    if (group) groupRows[group].push(row);
    else baseRows.push(row);
  }
  return {
    baseRows,
    groupRows,
    totalWrites: actions.length,
    outsideWrites: actions.filter((action) => action.outsideOpcore).length
  };
}

function actionMark(action: OpcoreInitAction): InstallWizardFileRow["mark"] {
  if (action.kind === "upsert_block" || action.kind === "wire_harness") return "~";
  return action.path === GITIGNORE_PATH ? "»" : "+";
}

function installWizardGroupForPath(path: string): InstallWizardGroupKey | undefined {
  if (path.endsWith("skills/opcore/SKILL.md")) return "skill";
  if (path.endsWith(AGENT_GATE_HOOK_PATH) ||
      path.endsWith(CLAUDE_SETTINGS_PATH) ||
      path.endsWith(CODEX_HOOKS_PATH)) return "hooks";
  return path.endsWith(ACTIVE_PRE_COMMIT_HOOK_PATH) ? "precommit" : undefined;
}
