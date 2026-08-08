import type {
  CommandRouterResult,
  OpcoreInitPlanPayload
} from "@the-open-engine/opcore-contracts";
import { applyInit } from "./init-apply.js";
import {
  formatInteractiveOutcome,
  formatSetupPlan
} from "./init-format.js";
import { appliedInitPayload } from "./init-payloads.js";
import { planInit } from "./init-plan.js";
import {
  approvalPromptSuffix,
  isApprovedAnswer,
  parseScopeAnswer,
  scopeRoot,
  shouldPromptForApproval,
  shouldPromptForScope
} from "./init-prompts.js";
import { createInitRouterResult } from "./init-result.js";
import { elapsedMs, nowMs, withContext } from "./init-timing.js";
import type {
  PlannedInit,
  SetupSession
} from "./init-types.js";

interface ApprovalOutcome {
  approved: boolean;
  prompted: boolean;
  payload: OpcoreInitPlanPayload;
}

export async function routeOpcoreInitPlanOrApply(
  session: SetupSession
): Promise<CommandRouterResult> {
  await promptForScope(session);
  const planStartedAt = nowMs();
  const planned = planInit({
    repoRoot: session.repoRoot, requestedPath: session.requestedPath,
    git: session.git, homeRoot: session.homeRoot,
    options: session.options, context: session.context
  });
  session.timing.planMs = elapsedMs(planStartedAt);
  const outcome = await promptForApproval(session, planned);
  const root = scopeRoot(session.repoRoot, session.homeRoot, session.options.scope);
  if (outcome.approved) {
    const applyStartedAt = nowMs();
    applyInit(root, session.options.scope, planned.writes);
    session.timing.applyMs = elapsedMs(applyStartedAt);
  }
  let payload = outcome.approved
    ? appliedInitPayload(outcome.payload, root, session.options.scope, session.command)
    : outcome.payload;
  payload = withContext(payload, session.context, session.timing);
  return createInitRouterResult({
    argv: session.argv, json: session.json, status: "ok",
    message: outcome.prompted
      ? formatInteractiveOutcome(payload, session.command)
      : formatSetupPlan(payload, outcome.approved, session.command),
    canonicalCommand: ["opcore", session.command], opcoreInit: payload
  });
}

async function promptForScope(session: SetupSession): Promise<void> {
  if (!shouldPromptForScope(session.json, session.options, session.git, session.runtime)) return;
  const startedAt = nowMs();
  const answer = await session.runtime.readLine(
    "Install the Opcore write gate for THIS repo, or GLOBALLY for all repos? [repo/global] "
  );
  session.timing.promptMs += elapsedMs(startedAt);
  session.options = {
    ...session.options, scope: parseScopeAnswer(answer), scopeExplicit: true
  };
}

async function promptForApproval(
  session: SetupSession,
  planned: PlannedInit
): Promise<ApprovalOutcome> {
  let payload = withContext(planned.payload, session.context, session.timing);
  let approved = session.options.approved && !session.options.dryRun;
  if (!shouldPromptForApproval(session.json, session.options, session.runtime)) {
    return { approved, prompted: false, payload };
  }
  session.context.interaction = { tty: true, promptState: "requested" };
  payload = withContext(payload, session.context, session.timing);
  const startedAt = nowMs();
  const answer = await session.runtime.readLine(
    `${formatSetupPlan(payload, false, session.command)}\n` +
    `Apply setup? ${approvalPromptSuffix(session.command)} `
  );
  session.timing.promptMs += elapsedMs(startedAt);
  approved = isApprovedAnswer(answer, session.command);
  session.context.interaction = {
    tty: true, promptState: approved ? "approved" : "declined"
  };
  if (!approved) {
    payload = {
      ...payload,
      nextActions: [`No files written. Rerun opcore ${session.command} when ready.`]
    };
  }
  return { approved, prompted: true, payload };
}
