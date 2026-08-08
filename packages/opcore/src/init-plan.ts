import type {
  InitContext,
  ParsedInitArgs,
  PlannedInit
} from "./init-types.js";
import { planGlobalInit } from "./init-plan-global.js";
import { planRepoInit } from "./init-plan-repo.js";

export interface InitPlanInput {
  repoRoot: string;
  requestedPath: string;
  git: boolean;
  homeRoot: string;
  options: ParsedInitArgs;
  context: InitContext;
}

export function planInit(input: InitPlanInput): PlannedInit {
  return input.options.scope === "global" ? planGlobalInit(input) : planRepoInit(input);
}
