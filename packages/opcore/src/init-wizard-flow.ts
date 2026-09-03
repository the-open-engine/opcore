import type {
  CommandRouterResult,
  OpcoreInitPlanPayload
} from "@the-open-engine/opcore-contracts";
import type { InstallWizardChoices } from "./install-wizard.js";
import { applyInit } from "./init-apply.js";
import { appliedInitPayload } from "./init-payloads.js";
import { planInit, type InitPlanInput } from "./init-plan.js";
import { scopeRoot } from "./init-prompts.js";
import { createInitRouterResult } from "./init-result.js";
import { elapsedMs, nowMs, withContext } from "./init-timing.js";
import type {
  PlannedInit,
  WizardSession
} from "./init-types.js";
import {
  createInstallWizardGroups,
  installWizardPlanView
} from "./init-wizard-plan.js";
import { repoDisplayLabel } from "./init-wizard-render.js";

export async function runInstallWizardFlow(session: WizardSession): Promise<CommandRouterResult> {
  await session.wizard.coverage(session.context.scan);
  if (!await chooseScope(session)) return declinedInstallWizardResult(session);
  const planFor = createInstallPlanCache(session);
  const probe = planFor({ agentSkill: true, writeGateHooks: true, activePreCommitHook: true });
  session.context.interaction = { tty: true, promptState: "requested" };
  const promptStartedAt = nowMs();
  const outcome = await session.wizard.planApproval({
    groups: createInstallWizardGroups(
      session.options.scope, session.git, session.repoRoot, probe.payload.actions
    ),
    initial: {
      agentSkill: session.options.agentSkill,
      writeGateHooks: session.options.writeGateHooks,
      activePreCommitHook: session.options.activePreCommitHook
    },
    planView: (choices) => installWizardPlanView(planFor(choices).payload.actions)
  });
  session.timing.promptMs += elapsedMs(promptStartedAt);
  session.options = { ...session.options, ...outcome.choices };
  if (!outcome.confirmed) return declinedInstallWizardResult(session);
  return applyWizardPlan(session);
}

async function chooseScope(session: WizardSession): Promise<boolean> {
  if (!session.git || session.options.scopeExplicit || session.options.repoExplicit) return true;
  const startedAt = nowMs();
  const scope = await session.wizard.selectScope(repoDisplayLabel(session.repoRoot, session.homeRoot));
  session.timing.promptMs += elapsedMs(startedAt);
  if (scope === null) return false;
  session.options = { ...session.options, scope, scopeExplicit: true };
  return true;
}

async function applyWizardPlan(session: WizardSession): Promise<CommandRouterResult> {
  session.context.interaction = { tty: true, promptState: "approved" };
  const planStartedAt = nowMs();
  const planned = planInit(toPlanInput(session));
  session.timing.planMs += elapsedMs(planStartedAt);
  const root = scopeRoot(session.repoRoot, session.homeRoot, session.options.scope);
  const applyStartedAt = nowMs();
  applyInit(root, session.options.scope, planned.writes);
  session.timing.applyMs = elapsedMs(applyStartedAt);
  await session.wizard.applyCascade(
    planned.payload.actions.map((action) => action.path),
    session.timing.applyMs
  );
  const undo = session.options.scope === "global"
    ? "opcore uninstall --global --yes"
    : "opcore uninstall";
  session.wizard.doneCard(planned.payload.actions.length, session.options.scope, undo);
  const payload = withContext(
    appliedInitPayload(planned.payload, root, session.options.scope, session.command),
    session.context,
    session.timing
  );
  return createInitRouterResult({
    argv: session.argv, json: false, status: "ok",
    message: `opcore ${session.command} applied`,
    canonicalCommand: ["opcore", session.command], opcoreInit: payload
  });
}

function declinedInstallWizardResult(session: WizardSession): CommandRouterResult {
  session.wizard.cancelled();
  session.context.interaction = { tty: true, promptState: "declined" };
  const startedAt = nowMs();
  const planned = planInit(toPlanInput(session));
  session.timing.planMs += elapsedMs(startedAt);
  const payload: OpcoreInitPlanPayload = {
    ...withContext(planned.payload, session.context, session.timing),
    nextActions: [`No files written. Rerun opcore ${session.command} when ready.`]
  };
  return createInitRouterResult({
    argv: session.argv, json: false, status: "ok",
    message: `opcore ${session.command} declined`,
    canonicalCommand: ["opcore", session.command], opcoreInit: payload
  });
}

function createInstallPlanCache(session: WizardSession): (choices: InstallWizardChoices) => PlannedInit {
  const cache = new Map<string, PlannedInit>();
  return (choices) => {
    const key = `${choices.agentSkill}|${choices.writeGateHooks}|${choices.activePreCommitHook}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const planned = planInit(toPlanInput(session, { ...session.options, ...choices }));
    cache.set(key, planned);
    return planned;
  };
}

function toPlanInput(
  session: WizardSession,
  options = session.options
): InitPlanInput {
  return {
    repoRoot: session.repoRoot, requestedPath: session.requestedPath,
    git: session.git, homeRoot: session.homeRoot, options, context: session.context
  };
}
