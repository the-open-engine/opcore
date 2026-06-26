import type { EditRefusal, RepoIdentity } from "@the-open-engine/opcore-contracts";
import type { ParsedEditCommand } from "./command-parser.js";
import type { EditPlannerResult } from "./planner.js";
import { createSymbolEditPlan } from "./symbol-preview.js";
import { moveSymbolRequest, renameSymbolRequest, signatureSymbolRequest } from "./symbol-requests.js";
import type { EditGraphProviderClient } from "./symbol-graph.js";
import type { EditWorkspace } from "./workspace.js";

export async function planSymbolEditCommand(
  parsed: ParsedEditCommand,
  payload: unknown,
  workspace: EditWorkspace,
  repo: RepoIdentity,
  graphProviderClient: EditGraphProviderClient | undefined
): Promise<EditPlannerResult> {
  if (parsed.command === "rename") {
    const request = renameSymbolRequest(payload);
    if (!request.ok) return request;
    return createSymbolEditPlan(workspace, repo, { ...request.value, repo: request.value.repo ?? repo }, graphProviderClient);
  }
  if (parsed.command === "move") {
    const request = moveSymbolRequest(payload);
    if (!request.ok) return request;
    return createSymbolEditPlan(workspace, repo, { ...request.value, repo: request.value.repo ?? repo }, graphProviderClient);
  }
  if (parsed.command === "signature") {
    const request = signatureSymbolRequest(payload);
    if (!request.ok) return request;
    return createSymbolEditPlan(workspace, repo, { ...request.value, repo: request.value.repo ?? repo }, graphProviderClient);
  }
  return {
    ok: false,
    refusal: {
      category: "unsupported_change",
      message: `Unsupported symbol edit command: ${parsed.command}`
    }
  };
}

export function symbolPayloadRequired(parsed: ParsedEditCommand): { ok: true } | { ok: false; refusal: EditRefusal } {
  if (!["rename", "move", "signature"].includes(parsed.command)) return { ok: true };
  if (parsed.payloadSource === undefined) {
    return {
      ok: false,
      refusal: {
        category: "unsupported_change",
        message: `lattice edit ${parsed.command} requires a JSON request payload`
      }
    };
  }
  return { ok: true };
}
