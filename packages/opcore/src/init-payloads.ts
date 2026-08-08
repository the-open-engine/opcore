import type { OpcoreInitPlanPayload } from "@the-open-engine/opcore-contracts";
import { appliedInitNextActions } from "./init-messages.js";
import { repoPathExists } from "./init-paths.js";
import { undoPathForScope } from "./init-undo-metadata.js";
import { undoAppliedNextAction } from "./init-undo-plan.js";
import type {
  InitScope,
  OpcoreSetupCommand
} from "./init-types.js";

export function appliedInitPayload(
  payload: OpcoreInitPlanPayload,
  root: string,
  scope: InitScope,
  command: OpcoreSetupCommand
): OpcoreInitPlanPayload {
  return {
    ...payload,
    mode: "apply",
    approved: true,
    nextActions: appliedInitNextActions(payload, command),
    undoAvailable: repoPathExists(root, undoPathForScope(scope))
  };
}

export function appliedUndoPayload(
  payload: OpcoreInitPlanPayload,
  root: string,
  scope: InitScope,
  command: OpcoreSetupCommand
): OpcoreInitPlanPayload {
  return {
    ...payload,
    approved: true,
    nextActions: [undoAppliedNextAction(command)],
    undoAvailable: repoPathExists(root, undoPathForScope(scope))
  };
}
