import type { CommandRouterResult } from "@the-open-engine/opcore-contracts";
import { applyUndo } from "./init-apply.js";
import { formatSetupPlan } from "./init-format.js";
import { appliedUndoPayload } from "./init-payloads.js";
import { scopeRoot } from "./init-prompts.js";
import { createInitRouterResult } from "./init-result.js";
import { elapsedMs, nowMs, withContext } from "./init-timing.js";
import type { SetupSession } from "./init-types.js";
import { planUndo } from "./init-undo-plan.js";

export function routeOpcoreInitUndo(session: SetupSession): CommandRouterResult {
  const planStartedAt = nowMs();
  const undo = planUndo({
    repoRoot: session.repoRoot,
    requestedPath: session.requestedPath,
    homeRoot: session.homeRoot,
    options: session.options,
    context: session.context
  });
  session.timing.planMs = elapsedMs(planStartedAt);
  const approved = session.options.approved && !session.options.dryRun;
  const root = scopeRoot(session.repoRoot, session.homeRoot, session.options.scope);
  if (approved) {
    const applyStartedAt = nowMs();
    applyUndo(root, session.options.scope);
    session.timing.applyMs = elapsedMs(applyStartedAt);
  }
  const payload = withContext(
    approved
      ? appliedUndoPayload(undo, root, session.options.scope, session.command)
      : undo,
    session.context,
    session.timing
  );
  return createInitRouterResult({
    argv: session.argv,
    json: session.json,
    status: "ok",
    message: formatSetupPlan(payload, approved, session.command),
    canonicalCommand: ["opcore", session.command],
    opcoreInit: payload
  });
}
