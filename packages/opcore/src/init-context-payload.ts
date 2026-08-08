import type { OpcoreInitPlanPayload } from "@the-open-engine/opcore-contracts";
import type { InitContext, ParsedInitArgs } from "./init-types.js";

type InitContextPayload = Pick<
  OpcoreInitPlanPayload,
  "scan" | "settings" | "interaction" | "timings"
>;

export function initContextPayload(context: InitContext): InitContextPayload {
  return {
    scan: context.scan,
    settings: context.settings,
    interaction: context.interaction,
    timings: context.timings
  };
}

export function initPayloadOptions(
  options: ParsedInitArgs
): OpcoreInitPlanPayload["options"] {
  return {
    scope: options.scope,
    failClosedHook: options.failClosedHook,
    dryRun: options.dryRun
  };
}
