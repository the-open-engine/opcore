import type { OpcoreInitAction } from "@the-open-engine/opcore-contracts";
import { AGENT_SKILL_PATHS } from "./init-constants.js";
import type { InitScope } from "./init-types.js";

export function actionPath(scope: InitScope, path: string): string {
  return scope === "global" ? `~/${path}` : path;
}

export function createSkillActions(scope: InitScope, enabled: boolean): OpcoreInitAction[] {
  if (!enabled) return [];
  return AGENT_SKILL_PATHS.map((path) => ({
    kind: "write",
    path: actionPath(scope, path),
    targetScope: scope,
    summary: "Install the Opcore agent skill.",
    requiresApproval: true,
    outsideOpcore: true
  }));
}
