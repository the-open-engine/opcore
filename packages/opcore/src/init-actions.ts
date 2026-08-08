import type { OpcoreInitAction } from "@the-open-engine/opcore-contracts";
import { createGlobalInitActions } from "./init-actions-global.js";
import { createRepoInitActions } from "./init-actions-repo.js";
import type { InitScope, ParsedInitArgs } from "./init-types.js";

export interface InitActionInput {
  scope: InitScope;
  agentFiles: readonly string[];
  options: ParsedInitArgs;
  gitignoreWritePlanned: boolean;
  activePreCommitWritePlanned: boolean;
}

export function createInitActions(input: InitActionInput): OpcoreInitAction[] {
  if (input.scope === "global") return createGlobalInitActions(input.options);
  return createRepoInitActions(input);
}
